# GBrain Multi-Agent Hardening PRD

> **Status:** Draft PRD for human approval. No implementation is authorized until the approval gate at the end is checked off.

**Goal:** Make the remote GBrain MCP/Postgres surface safe for simultaneous Hermes, Claude, Codex, and narrow worker agents by adding per-agent tokens, scope enforcement, real operation logging, safer migrations, and a non-trapdoor RLS posture.

**Builder repo/worktree:** Implement from `/Users/rudlord/gbrain/.worktrees/t_4573b52e` on branch `prd/gbrain-multi-agent-hardening-2026-05-06`. Do not implement from `/Users/rudlord/gbrain` because that checkout currently has unrelated local edits (`src/cli.ts`).

**Evidence baseline:** Current GBrain repo at `e5a9f01`; Phase 3B handoff says wiki DB was cleaned after snapshots with 11 keeper pages migrated, 57 noise pages deleted, 122 chunks deleted, orphan chunks = 0. Current schema has `access_tokens(name, token_hash, scopes, created_at, last_used_at, revoked_at)`, `mcp_request_log(token_name, operation, latency_ms, status, created_at)`, zero scope enforcement in `src/mcp/server.ts`, token creation that does not set scopes in `src/commands/auth.ts`, and RLS enabled with no policies when the current role has BYPASSRLS in `src/schema.sql`.

---

## 1. Problem

GBrain is now a shared memory substrate for multiple agents, not a single-user toy CLI. The current remote MCP auth model is too soft:

- Tokens exist, but creation does not assign scopes.
- MCP stdio server dispatches every operation without scope checks.
- Request logging schema exists, but the visible server path does not write real operation logs.
- `last_used_at` is a write hotspot if updated on every MCP call.
- RLS is in the worst possible shape for future maintainers: enabled without policies under a bypass role, which can look safe while being a zero-policy trapdoor for non-bypass roles.
- Log tables will grow indefinitely without partitioning.
- Hermes, Claude, and Codex MCP clients have different transport/config expectations; the hardening must not break stdio local usage.

This PRD intentionally does not implement. It defines the exact build spec and gates the work behind human approval.

## 2. Non-goals

- No OAuth, browser login, Supabase Auth UI, or multi-user web app.
- No row-level per-page tenancy in Phase 4A.
- No semantic authorization such as “agent can only read finance pages.” Scopes are table/action coarse-grained.
- No replacement of the contract-first operation model in `src/core/operations.ts`.
- No breaking PGLite local default. PGLite remains local-only and does not need `access_tokens`, `mcp_request_log`, pg_partman, or RLS.

## 3. Required deliverables

Implementation must produce:

1. Token model and CLI support.
2. Scope definitions and enforcement at operation dispatch.
3. Real operation-name logging with latency, status, and auth outcome.
4. Migration plan/code for indexes and monthly partitions.
5. Hot-row cooling for `access_tokens.last_used_at`.
6. RLS posture changed to either disabled or policy-backed. Phase 4A chooses disabled for GBrain-owned tables unless human explicitly asks for policies.
7. Compatibility smoke checks for Hermes MCP, Claude MCP, and Codex MCP.
8. Rollback SQL and app rollback steps.
9. Tests that prove denied operations fail closed.

## 4. Token model

### 4.1 Data model

Keep `access_tokens.token_hash` as SHA-256 of the bearer token. Never store cleartext tokens.

Add/normalize columns through a new migration, not by editing old migrations:

- `scopes TEXT[] NOT NULL DEFAULT '{}'`
- `description TEXT NOT NULL DEFAULT ''`
- `created_by TEXT NOT NULL DEFAULT 'operator'`
- `last_used_at TIMESTAMPTZ`
- `last_used_operation TEXT`
- `last_used_client TEXT`
- `revoked_at TIMESTAMPTZ`

Indexes:

- `idx_access_tokens_hash_active` on `(token_hash)` where `revoked_at IS NULL`.
- `idx_access_tokens_name_active` on `(name)` where `revoked_at IS NULL`.
- Do not make `name` globally unique; allow a revoked historical token with the same name. Enforce active-name uniqueness with partial unique index if Postgres path supports it: `CREATE UNIQUE INDEX IF NOT EXISTS idx_access_tokens_name_active_unique ON access_tokens(name) WHERE revoked_at IS NULL;`.

### 4.2 Initial token roster

Create these named tokens after approval, not in the migration itself:

| Token name | Intended holder | Scopes | Notes |
|---|---|---|---|
| `hermes-operator` | Main Hermes CLI/gateway | `pages:read`, `pages:write`, `chunks:read`, `chunks:write`, `log:write`, `admin` | Full operator token. Keep local to Rudy-controlled Hermes. |
| `claude-builder` | Claude Code/Desktop builder | `pages:read`, `pages:write`, `chunks:read`, `chunks:write`, `log:write` | Can edit brain content but cannot run admin tools. |
| `codex-builder` | Codex CLI builder | `pages:read`, `pages:write`, `chunks:read`, `chunks:write`, `log:write` | Same as Claude builder for implementation parity. |
| `researcher-readonly` | Retrieval/research workers | `pages:read`, `chunks:read`, `log:write` | Can search/read and log usage; cannot mutate brain pages. |
| `ingest-worker` | Dedicated ingestion/sync jobs | `pages:read`, `pages:write`, `chunks:read`, `chunks:write`, `log:write` | No admin. Use for sync/import pipelines. |
| `auditor-admin` | Short-lived maintenance/audit token | `pages:read`, `chunks:read`, `log:write`, `admin` | Not for daily agents. Rotate/revoke after audit windows. |

CLI acceptance:

- `gbrain auth create <name> --scope pages:read --scope chunks:read ...`
- `gbrain auth list` prints scopes and last-used metadata.
- `gbrain auth revoke <name>` only revokes active tokens with that name.
- Creating a token without scopes must fail unless `--admin-all` or explicit `--scope` flags are passed.

## 5. Scope matrix

Scopes are exact strings. Unknown scopes fail validation at token creation and are ignored nowhere.

| Scope | Allows | Does not allow |
|---|---|---|
| `pages:read` | Read page metadata/content, tags, links, backlinks, timeline, versions, raw data sidecars. | Reading chunk text directly, stats/health if classified admin, any mutation. |
| `pages:write` | Create/update/delete pages, tags, links, timeline entries, raw data, file metadata attached to pages. | Chunk re-embedding writes unless paired with `chunks:write`; admin migrations. |
| `chunks:read` | Search/query, direct chunk retrieval, chunk-derived hybrid result detail. | Page mutation or re-embedding. |
| `chunks:write` | Sync/import operations that create/update/delete `content_chunks` and embeddings. | Token management, schema migration, config writes. |
| `log:write` | Insert into `mcp_request_log`; update cooled `last_used_at`. | Reading arbitrary logs unless also admin. |
| `admin` | Stats/health/version inspection, config mutation if exposed later, token admin, migration/doctor operations. | Bypassing explicit revocation; an admin token is still denied if revoked. |

Scope dependency rules:

- `pages:write` implies the operation may also read the target page, but does not imply `chunks:write`.
- `chunks:write` does not imply `pages:write`; if an operation writes pages and chunks, require both.
- `admin` does not automatically imply every read/write scope for MCP content operations. Keep it explicit except for admin-only tools.

## 6. Tool-to-scope authorization map

Authorization must be derived from `operations` metadata, not hardcoded twice. Add `requiredScopes: string[]` to `Operation` in `src/core/operations.ts`, then have CLI/MCP generated tools use it.

| Operation | Required scopes | Rationale |
|---|---|---|
| `get_page` | `pages:read` | Page body read. |
| `list_pages` | `pages:read` | Page metadata read. |
| `get_tags` | `pages:read` | Page metadata read. |
| `get_links` | `pages:read` | Graph metadata read. |
| `get_backlinks` | `pages:read` | Graph metadata read. |
| `traverse_graph` | `pages:read` | Graph metadata read. |
| `get_timeline` | `pages:read` | Page timeline read. |
| `get_versions` | `pages:read` | Page history read. |
| `get_raw_data` | `pages:read` | Sidecar read. |
| `resolve_slugs` | `pages:read` | Slug lookup. |
| `search` | `pages:read`, `chunks:read` | Keyword result may expose chunk/page content. |
| `query` | `pages:read`, `chunks:read` | Hybrid retrieval exposes chunks and pages. |
| `get_chunks` | `chunks:read` | Direct chunk text read. |
| `put_page` | `pages:write`, `chunks:write` | Import updates page and chunks. |
| `delete_page` | `pages:write`, `chunks:write` | Cascades chunks. |
| `add_tag` | `pages:write` | Metadata mutation. |
| `remove_tag` | `pages:write` | Metadata mutation. |
| `add_link` | `pages:write` | Graph mutation. |
| `remove_link` | `pages:write` | Graph mutation. |
| `add_timeline_entry` | `pages:write` | Timeline mutation. |
| `revert_version` | `pages:write`, `chunks:write` | Rewrites page body; may affect chunks. |
| `sync_brain` | `pages:write`, `chunks:write` | Bulk import/sync. |
| `put_raw_data` | `pages:write` | Sidecar mutation. |
| `log_ingest` | `pages:write`, `log:write` | Records ingestion and page refs. |
| `get_ingest_log` | `admin` | Operational log read. |
| `get_stats` | `admin` | Brain-level operational metadata. |
| `get_health` | `admin` | Brain-level operational metadata. |
| `file_list` | `pages:read` | Attachment metadata read. |
| `file_upload` | `pages:write` | Attachment metadata/storage mutation. |
| `file_url` | `pages:read` | Attachment retrieval. |

Deny behavior:

- Missing/invalid bearer token: HTTP/MCP error with `unauthorized`, no handler execution.
- Valid token missing scope: `forbidden`, no handler execution.
- Stdio local MCP without remote auth: see compatibility plan; local trusted stdio may bypass token enforcement only when no remote HTTP wrapper is used. If the code has only stdio, add enforcement in the remote wrapper, not local-only stdio.

## 7. Operation-name logging taxonomy

Current `mcp_request_log.operation` must store real operation names, not generic `call_tool` or endpoint names.

### 7.1 Required fields

Extend `mcp_request_log` through migration:

- `token_name TEXT`
- `operation TEXT NOT NULL`
- `client_name TEXT NOT NULL DEFAULT ''`
- `transport TEXT NOT NULL DEFAULT 'mcp'` (`stdio`, `http`, `hermes-mcp`, `claude-mcp`, `codex-mcp` when detectable)
- `status TEXT NOT NULL` enum-by-convention: `success`, `error`, `unauthorized`, `forbidden`, `validation_error`, `dry_run`
- `latency_ms INTEGER`
- `error_code TEXT NOT NULL DEFAULT ''`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`

### 7.2 Taxonomy

Use the exact `Operation.name` values:

`get_page`, `put_page`, `delete_page`, `list_pages`, `search`, `query`, `add_tag`, `remove_tag`, `get_tags`, `add_link`, `remove_link`, `get_links`, `get_backlinks`, `traverse_graph`, `add_timeline_entry`, `get_timeline`, `get_stats`, `get_health`, `get_versions`, `revert_version`, `sync_brain`, `put_raw_data`, `get_raw_data`, `resolve_slugs`, `get_chunks`, `log_ingest`, `get_ingest_log`, `file_list`, `file_upload`, `file_url`.

Auth/admin operation names:

`auth.create_token`, `auth.list_tokens`, `auth.revoke_token`, `auth.test_token`, `schema.migrate`, `schema.rollback`, `doctor.run`.

Logging rules:

- Log one row for every remote MCP tool call, including denied calls.
- For denied calls, `token_name` may be null for unknown token; `operation` must be requested operation if parseable, else `unknown`.
- Do not log parameters, token hashes, bearer tokens, page content, raw payloads, or file paths beyond operation names.
- Latency is wall-clock handler latency excluding client network time.

## 8. Hot-row cooling for `last_used_at`

Default approach: in-process LRU throttle.

Implementation requirement:

- Maintain an in-memory map keyed by token id or token hash: `{lastFlushAt, lastOperation, clientName}`.
- On each authenticated call, allow request logging, but only flush `access_tokens.last_used_at` at most once per minute per token.
- Flush should update `last_used_at`, `last_used_operation`, `last_used_client`.
- On process shutdown there is no strict flush requirement; `mcp_request_log` is the detailed audit trail.
- Do not introduce pgmq for this unless code shape proves multiple long-lived HTTP workers make in-process cooling misleading. Current PRD default is LRU once/minute/token.

Acceptance tests:

- 10 calls within one minute from same token produce 10 `mcp_request_log` rows and at most 1 `access_tokens` update.
- Calls after 61 seconds update `last_used_at` again.

## 9. Index and pg_partman monthly partition plan

### 9.1 Immediate indexes

Add idempotent indexes:

- `mcp_request_log(created_at DESC)`
- `mcp_request_log(operation, created_at DESC)`
- `mcp_request_log(token_name, created_at DESC)`
- `mcp_request_log(status, created_at DESC)`
- Active token indexes from section 4.

### 9.2 Monthly partitions

Use pg_partman only for Postgres/Supabase engine. PGLite is excluded.

Plan:

1. Add migration that checks for `pg_partman` availability: `SELECT 1 FROM pg_extension WHERE extname = 'pg_partman'`.
2. If absent, leave `mcp_request_log` unpartitioned but keep indexes and emit a clear warning in doctor output.
3. If present and `mcp_request_log` is not already partitioned:
   - Create `mcp_request_log_new` partitioned by range on `created_at` with same columns.
   - Copy existing rows in batches ordered by id.
   - Swap table names in a transaction: `mcp_request_log` -> `mcp_request_log_legacy`, `mcp_request_log_new` -> `mcp_request_log`.
   - Recreate indexes on the partitioned parent.
   - Register monthly partitioning with pg_partman, premake 3 months, retain at least 12 months unless human says otherwise.
4. Keep `mcp_request_log_legacy` for one release. Drop only after explicit approval.

Required caution: Do not run this migration blindly against production-sized logs without a preflight count and disk estimate.

## 10. RLS posture

Phase 4A decision: disable RLS on GBrain-owned tables unless and until real policies are written. Reason: the app uses server-side bearer tokens and Postgres service credentials; zero-policy RLS under BYPASSRLS is misleading and can break non-bypass maintenance while not protecting the app path.

Implementation:

- Remove the current “enable RLS if current role has BYPASSRLS” block from new installs.
- Add a migration that runs:
  - `ALTER TABLE pages DISABLE ROW LEVEL SECURITY;`
  - `ALTER TABLE content_chunks DISABLE ROW LEVEL SECURITY;`
  - `ALTER TABLE links DISABLE ROW LEVEL SECURITY;`
  - `ALTER TABLE tags DISABLE ROW LEVEL SECURITY;`
  - `ALTER TABLE raw_data DISABLE ROW LEVEL SECURITY;`
  - `ALTER TABLE timeline_entries DISABLE ROW LEVEL SECURITY;`
  - `ALTER TABLE page_versions DISABLE ROW LEVEL SECURITY;`
  - `ALTER TABLE ingest_log DISABLE ROW LEVEL SECURITY;`
  - `ALTER TABLE config DISABLE ROW LEVEL SECURITY;`
  - `ALTER TABLE files DISABLE ROW LEVEL SECURITY;`
- Do not enable RLS on `access_tokens` or `mcp_request_log` without policies.

If human overrides and wants RLS, implementation must write explicit policies before enabling. Minimum policies would be service-role-only for all tables and no anon access. Do not leave a zero-policy trapdoor.

## 11. Compatibility plan: Hermes / Claude / Codex MCP

### 11.1 Local stdio MCP

- Existing `src/mcp/server.ts` stdio should keep working for local trusted clients.
- If local stdio has no bearer-token transport, scope enforcement belongs in the remote HTTP/SSE wrapper. Do not force Claude Desktop stdio users to paste bearer tokens unless that client is connecting to remote HTTP.
- Tool schemas may include descriptions but must not expose token scopes in a way that encourages clients to guess capabilities.

### 11.2 Hermes

Smoke requirement:

- Hermes MCP tool list can discover all GBrain tools.
- Hermes token `hermes-operator` can call `get_page`, `query`, `put_page` dry-run or test page, `get_health`.
- Read-only token from Hermes is denied on `put_page`.

### 11.3 Claude

Smoke requirement:

- Claude MCP config can use local stdio or remote wrapper without schema changes.
- Claude builder token can call `get_page`, `query`, `put_page` on a disposable test slug.
- Claude builder token is denied on `get_health` and token admin.

### 11.4 Codex

Smoke requirement:

- Codex MCP client can list/call tools with same operation names.
- Codex builder token can read/write disposable test page.
- Codex builder token is denied on admin operations.

### 11.5 Common compatibility constraints

- Use standard MCP error shape; do not return a success JSON containing an error for auth failures.
- Keep operation names stable.
- Keep input schemas unchanged except optional `dry_run` where already supported.
- Add tests around `validateParams` before authorization bypass cannot happen. The safest order is: parse operation -> authenticate -> authorize -> validate params -> execute -> log.

## 12. Implementation tasks

1. Add `requiredScopes` metadata to `Operation` and every operation definition.
2. Add auth/scope helper module with valid scope enum, token lookup, scope validation, and LRU `last_used_at` cooling.
3. Update token CLI to create/list/revoke/test scoped tokens.
4. Add operation logging helper that records real operation names and statuses without payloads.
5. Integrate auth/authorization/logging into the remote MCP path. If the repo lacks an HTTP remote wrapper, add one behind an explicit command without disturbing stdio.
6. Add schema migration for token metadata, active indexes, log fields, RLS disabling, and optional pg_partman partition setup.
7. Regenerate `src/core/schema-embedded.ts` with `bun run build:schema` after editing `src/schema.sql`.
8. Add unit tests for scope map, token CLI validation, logging taxonomy, and hot-row cooling.
9. Add smoke docs or scripts for Hermes/Claude/Codex MCP.
10. Run `bun test`; run e2e only if `DATABASE_URL` is configured.

## 13. Testable acceptance criteria

- A token with only `pages:read,chunks:read,log:write` can call `get_page`, `list_pages`, `search`, `query`, `get_chunks`.
- That same token is denied on `put_page`, `delete_page`, `sync_brain`, `file_upload`, `get_health`, `get_ingest_log`.
- A builder token can write pages/chunks but is denied admin.
- An operator token with explicit `admin` plus content scopes can call admin and content tools.
- Denied calls do not execute handlers.
- Every remote call writes one `mcp_request_log` row with the real operation name and status.
- `last_used_at` updates at most once per token per minute under repeated calls.
- New installs do not enable zero-policy RLS.
- Existing installs have GBrain-owned RLS disabled or explicit policies; no zero-policy enabled table remains.
- pg_partman migration is idempotent and safely skips when extension is absent.
- Hermes, Claude, and Codex smoke checks pass with their intended token scopes.

## 14. Rollback plan

Application rollback:

1. Revert code to previous release/commit.
2. Keep new columns; old code ignores them.
3. If auth enforcement breaks remote clients, temporarily run trusted local stdio MCP only and revoke remote tokens.

Database rollback:

- Revoke all newly created Phase 4A tokens:
  `UPDATE access_tokens SET revoked_at = now() WHERE name IN (...initial roster...) AND revoked_at IS NULL;`
- Disable new remote wrapper route or remove its secret from deployment.
- If partition migration ran, keep `mcp_request_log_legacy`; switch back by renaming only during a maintenance window.
- Do not drop log/token columns during emergency rollback; schema contraction is a later cleanup.
- If RLS disabling must be reverted, only re-enable after explicit policies are present. Do not restore the old zero-policy block.

## 15. Risks and mitigations

- Risk: scope map drifts from operations. Mitigation: `requiredScopes` lives on each `Operation`; test every exported operation has non-empty scope metadata.
- Risk: auth logging leaks content. Mitigation: log only operation/status/timing/client, never params.
- Risk: partition migration locks logs. Mitigation: preflight counts, batch copy, maintenance window, keep legacy table.
- Risk: stdio local clients break. Mitigation: remote auth wrapper only; local stdio remains trusted unless explicitly configured otherwise.
- Risk: `admin` becomes god scope. Mitigation: do not let `admin` imply content read/write; require explicit content scopes.

## 16. Human approval gate

Implementation is blocked until a human approves this PRD.

Approval checklist:

- [ ] Token roster accepted.
- [ ] Scope matrix accepted.
- [ ] RLS decision accepted: disable unused RLS for Phase 4A.
- [ ] pg_partman partition approach accepted.
- [ ] Builder path accepted: `/Users/rudlord/gbrain/.worktrees/t_4573b52e`.
- [ ] No implementation before approval.

Approved by: _pending_
Approved at: _pending_
