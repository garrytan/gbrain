# 09. Trust, auth and access control

Line numbers refer to gbrain 36bd05806a.

Map of how TypeScript gbrain (v0.60.733.0, commit 36bd05806a, `garrytan/gbrain`) decides who may read or write what, and which of those decisions Postgres enforces today. Paths are relative to the gbrain repo unless noted. Read-only research.

Legend: **[V]** verified by reading the cited code. **[I]** inferred or only partly traced.

## 1. Trust boundary: `OperationContext.remote`

- **[V]** `remote: boolean` is required on `OperationContext` (`src/core/ops/contract.ts:477-502`). True for MCP and agent callers, false for the local CLI.
- **[V]** Trusted callers set `remote: false`: CLI main (`src/cli/main.ts:1456`), the warm CLI socket (`src/core/cli-socket/execute.ts:67`), sweep (`src/core/sweep.ts:922`), oversized backfill (`src/core/oversized-backfill.ts:136`).
- **[V]** Untrusted callers set `remote: true`: stdio MCP (`src/mcp/server.ts:423`, `:496`), HTTP transport (`src/mcp/http-transport.ts:568`), enforced-member mode (`src/cli/enforced-member.ts:321`).
- **[V]** Fail-closed is by convention, not by type. Trusted-only sites test `ctx.remote === false`; untrust-unless-explicit sites test `ctx.remote !== false` (`src/core/verbs.ts:288`, `:304`, `:384`; `src/core/ops/files.ts:85`). `CLAUDE.md:55-57` says "Don't default it falsy."
- **[V]** Transport is separate from trust. Stdio is `remote: true` even with no auth (`contract.ts:511-519`).

## 2. Source isolation

- **[V]** `sourceScopeOpts(ctx)` (`src/core/ops/context.ts:646-668`) is the one precedence ladder: `ctx.auth.allowedSources` (non-empty federated grant) > `ctx.sourceId` > nothing.
- **[V]** An empty `allowedSources: []` does not widen. `__all__` spans every source only when `ctx.remote === false` (`context.ts:660-666`). For remote callers the literal matches nothing. A remote caller with no grant gets `permission_denied` (`context.ts:662-664`).
- **[V]** `assertSourceInCallerScope` (`context.ts:681`) confines a named `source_id` to the same ladder for untrusted callers and answers `not_found` for out-of-scope ids. `assertSourceInCallerWriteScope` (`:712`) is stricter, for destructive ops.
- **[V]** `CLAUDE.md:58-68` requires every read op to route through `sourceScopeOpts`. `scripts/check-getpage-scoped-write.mjs` guards the read-then-write pattern. This is a script check, not a DB constraint.
- **[V]** `parseLegacyTokenScope` (`src/core/legacy-token-scope.ts`) maps a stored grant to `{sourceId, allowedSources}`. An empty array becomes the `NO_SOURCES` sentinel. Missing or malformed values fall back to `'default'`. It never widens.
- **[V]** Search adds a second filter, `buildVisibilityClause` (`src/core/search/sql-ranking.ts:176`). The RLS scope binding (section 5.1) is opt-in and documented as "defense-in-depth layer 2"; the app filter is layer 1 and mandatory (`src/core/postgres-engine.ts:~335-340`).

## 3. Credentials

### 3.1 Legacy bearer tokens (`access_tokens`)

- **[V]** `src/schema.sql:735-748`: `id UUID`, `name`, `token_hash TEXT UNIQUE`, `scopes TEXT[]`, `created_at`, `last_used_at`, `revoked_at`; partial index on `token_hash WHERE revoked_at IS NULL`. Later migrations add `member_id` and `may_act_for` (v282, `src/core/schema-migrations/v282-member-read-access.ts:29-30`), the unified grant columns and a `permissions` JSONB mirror (`src/core/token-mint.ts:1-20`), `attest_sources` (v293, per `docs/architecture/key-files/access.md`) and `reads_unscoped` (read in `src/core/access/token-binding.ts`).
- **[V]** `generateToken(prefix)` = prefix + 32 random bytes hex (`src/core/utils.ts:22-24`). `hashToken` = plain SHA-256 hex, no salt or pepper (`utils.ts:15-17`). Plaintext is shown once (`SECURITY.md:430-435`).
- **[V]** `Authorization: Bearer` is required on every request except `/health` (`src/mcp/http-transport.ts:292`).
- **[V]** Revoke sets `revoked_at`. Rotation is mint first, then revoke the old token by id (`src/core/token-mint.ts:14-17`).
- **[V]** Grant moves in `src/core/grants/legacy-token.ts` take row locks (`FOR UPDATE` at `:233-234`, `:338`) and `FOR UPDATE SKIP LOCKED` in the backfill (`:380`, `:402-405`).

### 3.2 OAuth 2.1 (`oauth_clients`, `oauth_tokens`, `oauth_codes`)

- **[V]** `oauth_clients` (`src/schema.sql:765-810`): `client_secret_hash`, `scope`, `source_id REFERENCES sources(id) ON DELETE RESTRICT`, `federated_read TEXT[]`, `member_id`, `may_act_for`, `token_ttl`, `deleted_at`, `source_grant CHECK (source_grant IN ('none'))`, `takes_holders`, `surface`, `allowed_operations`, `bound_*`, `budget_usd_per_day`.
- **[V]** `oauth_tokens` (`:838-848`): PK `token_hash`, `client_id ... ON DELETE CASCADE`, `scopes`, `expires_at BIGINT`, `resource`. `oauth_codes` (`:851-862`): PK `code_hash`, `code_challenge`, `code_challenge_method DEFAULT 'S256'`, `redirect_uri`, `expires_at BIGINT NOT NULL`.
- **[V]** `oauth_grant_audit` (`:813-823`) gets one row per grant revision with `before_grant` and `after_grant` JSONB. The code inserts; I did not check for an append-only guard.
- **[V]** `verifyAccessToken` (`src/core/oauth-provider.ts:679`) joins `oauth_clients` in one query. It refuses revoked or missing clients (`:814`), and refuses a NULL or past `expires_at` (`:822-823`, fail-closed). It re-intersects issued scopes with the client's current scope on every request (`:816`), so a rescope applies at once.
- **[V]** Client secrets are compared with `safeHexEqual(secret, hashToken(presented))` (`oauth-provider.ts:1017`, `src/core/timing-safe.ts`). The provider validates S256 PKCE before it consumes a code (`:573`, `:641-649`). Expired rows are swept (`:1035-1045`).
- **[V]** `/authorize` never mints a code by itself. It records a pending request, which expires after 10 minutes, does not survive restart, and is capped server-wide and at 10 per client. Only the owner's approval in the admin dashboard mints a code (`SECURITY.md:394-415`). Admin routes are `requireAdmin`-gated (`src/commands/serve-http-access.ts:19-67`).

### 3.3 Scopes

- **[V]** `Scope` union (`src/core/scope.ts:25`): `read`, `write`, `admin`, `sources_admin`, `users_admin`, `agent`, `skill_editor`, `skill_publisher`, `skills_member_self`, `memory_confirm`.
- **[V]** Implications (`scope.ts:163-168`): `admin` implies `sources_admin`, `users_admin`, `write`, `read`. `write` implies `read`. The rest imply only themselves. `agent` is never implied by `admin`.
- **[V]** DCR ceilings: self-registration may hold `read write` (`DCR_REGISTRABLE_SCOPES`, `scope.ts:65`). DCR `client_credentials` is capped at `read` (`:72`). `memory_confirm` is local-CLI-only (`:82`). `agent` needs an operator grant with delegation bindings (`dcrScopeViolation`, `:98-100`). DCR is off by default (`SECURITY.md:258-265`).

## 4. Per-page and per-member access

### 4.1 Model

- **[V]** Model C (`docs/tutorials/company-brain.md:114-160`): one source; tokens and OAuth clients bind to a member; pages name readers in frontmatter, e.g. `readable_by: [alice-example, group:team-a]`. Folder and page rules live in `gbrain access rule` (preview, then `--yes`) and in `.gbrain/access.yml` on git-backed sources.
- **[V]** Tables from v282, v283, v286, v299, v309: `access_members` (id regex `^[a-z0-9][a-z0-9._-]{0,63}$`, `disabled_at`, `tombstoned_at`), `access_groups`, `access_group_members` (cascade), `access_rules`, `access_policy_state`, `access_policy_revisions`, `access_pending_coverage`, `access_policy_migrations`, `access_member_links`, `access_member_sources`. `pages` gains `page_readers TEXT[]`.
- **[V]** Member ids are never reused. `removeMember` tombstones and `addMember` refuses a tombstoned id (`src/core/access/members.ts:9`). A credential bound to a disabled or tombstoned member is refused at verify.
- **[V]** Requester scope (`src/core/access/requester-scope.ts`): on a brain with two or more enabled members, an unbound remote read is refused with `requester_scope_required`. Connections that predate multi-person serving get a 14-day grace. Reads are deny-by-default unless listed.
- **[V]** Audience members (`kind: audience`, `members.ts:18`) get owner-like reads of their own derived pages. Only the trusted local operator sets the kind.

### 4.2 Enforcement is app SQL, not RLS

- **[V]** `readersAllowedSql` (`src/core/search/private-visibility.ts:171-178`) builds the predicate from `page_readers`, or from `gbrain_access_readers(frontmatter)` for snapshots. `folderRulesAllowedSql` (`:133`) covers folder rules. Identities are inlined as quoted literals after `validIdentity` (`src/core/access/principals.ts:64-66`), which accepts only `ACCESS_ID_RE` (`principals.ts:14`).
- **[V]** `withCallerAccess` and `withoutCallerAccess` (`private-visibility.ts:392`, `:436`) carry the current caller's access in an `AsyncLocalStorage` store (`:23`, `:384`).
- **[V]** A remote read of a page under a folder rule needs the member on every covering rule and on the page's own `readable_by`. Grants, hatches and `--as` do not relax it (`company-brain.md:147`).
- **[V]** `visibility: private` pages are hidden from untrusted callers by `excludePrivate` in `buildVisibilityClause` (`sql-ranking.ts:176-188`).

### 4.3 Malformed input fails closed (DB-side today)

- **[V]** `gbrain_access_norm_readers` (`v282-member-read-access.ts:48-57`) lowercases, trims and accepts `member:<id>` and `group:<id>`. It never drops an invalid entry: if any entry fails to normalize, or nothing remains, the whole list becomes `['!nobody']` (`bool_and(n IS NOT NULL)` at `:50`; the same early return in `src/core/access/principals.ts:44`; mixed valid and invalid case in `test/access-principals.test.ts:86`). Dropping invalid entries instead would widen access.
- **[V]** `gbrain_access_readers(fm)` (`:59-70`) returns NULL when `readable_by` is absent, and `['!nobody']` for a non-string, non-array value, an array longer than 256, or an array with non-string elements.
- **[V]** `pages_access_derive_readers` (`:115-116`) is a BEFORE INSERT OR UPDATE OF frontmatter, page_readers trigger.
- **[V]** `pages_access_mark_restricted` and `access_members_mark_restricted` set `config.access.restrictions_present = '1'` (`:97-106`, `:118-122`). This global flag gates the fast path. The v282 backfill sets it when any restricted page or member exists.

## 5. Database-enforced controls

### 5.1 RLS: enabled, no policies shipped

- **[V]** `src/schema.sql:1828-1831` says enabling RLS with no policies means the anon key reads nothing; BYPASSRLS roles are unaffected. A grep for `CREATE POLICY` finds none in `src/schema.sql` or any migration.
- **[V]** The DO block (`schema.sql:1832-1870`) enables RLS on 35 named tables covering content, graph and credential data. It is conditional on the role's privileges (`:1838-1841`). In total the file has 32 `ENABLE ROW LEVEL SECURITY` statements.
- **[V]** `docs/guides/rls-and-you.md` describes the v35 `auto_rls_on_create_table` event trigger and a v275 backfill (event-trigger SQL at `src/core/persistence/graduation-target.ts:298`).
- **[V]** `GBRAIN_RLS_SCOPE_BINDING=1` runs source-scoped reads inside `set_config('app.scopes', csv, true)` (`src/core/postgres-engine.ts:320-345`). The policy that would use it is an operator recipe (`docs/ENGINES.md:294-365`), not created by gbrain.
- **[V]** PGLite has no RLS binding and no statement timeout (`src/core/postgres-engine/search-settings.ts` header).
- **[V]** `test/guest-notes-scoped-role.test.ts` pins the failure mode: a role that neither owns nor bypasses RLS reads a table as empty. The guard must refuse, not treat empty as "no guest source".

### 5.2 GUC write gate

The app sets these with `set_config(..., true)` inside a transaction (`src/core/persistence/context.ts:65-68`). Triggers read them with `current_setting`.

| GUC | Set by | Read by | Effect |
|---|---|---|---|
| `gbrain.write_sources` (JSON array) | `persistence/context.ts:68`; `belief/purge-mirror.ts:159`; `v191-alias-source-cascade.ts:34` | `gbrain_require_managed_writer` (`schema.sql:2556`, `:2598`); trust stamp (`trust/propagation.ts:29`); `gbrain_guard_skill_publication` (`:3038-3050`) | Writes outside the list are refused |
| `gbrain.git_protocol` = '1' | `persistence/context.ts:68` | `schema.sql:2607` | Git-canonical sources refuse undeclared writers |
| `gbrain.topology_change` = 'on' | `backup/snapshot.ts:283`; `persistence/topology-recovery.ts:176` | `schema.sql:2564` | Source topology changes only inside administration |
| `gbrain.write_trust_tier`, `gbrain.write_origin` | `persistence/context.ts` | tier stamp (`trust/schema.ts:187`) | Writer trust; nests as min(outer, inner) |
| `gbrain.write_principal_kind/id`, `gbrain.write_request` | `persistence/context.ts:65-68` | stamp function and attribution triggers | Attribution |
| `gbrain.materializing_revision` | `page-body/rechunk.ts:166-181` | `schema.sql:1921` | Allows knowledge_revision change during rechunk |
| `gbrain.persistence_protocol`, `gbrain.writer_quiesced` | persistence code | `schema.sql:2953`, `:3022` | Protocol floor, quiescence |

- **[V]** `gbrain_require_managed_writer()` (`src/schema.sql:2522-2600`) is attached as `managed_writer_guard BEFORE INSERT OR UPDATE OR DELETE` to pages, tags, slug_aliases, page_aliases, facts, takes, timeline_entries, sources, page_segment_texts and page_body_manifest (a DO loop near `:2620-2640`). It refuses rows whose source, or on UPDATE the old source, is not in `write_sources`. It refuses an unreadable parent (`:2584-2593`). Errors are `P0001` with `writer_coordinator_required:` and constraint names such as `managed_writer_guard:allowlist`, `:topology`, `:checkpoint`, `:unreadable_state`, plus `git_canonical_fence:mutation`.
- **[V]** Tier stamp (`src/core/trust/schema.ts:187-236`, triggers at `:309-312`). On INSERT it sets `trust_tier = COALESCE(writer, 'unknown')` and `write_origin`. On UPDATE it refuses a raise without owner confirmation and resets to OLD. A writer may not declare a tier above `operator_curated` (`OWNER_TIER_FLOOR`, `src/core/trust/tier.ts:40`) without promotion. Order (`tier.ts:19-21`): `user_confirmed` > `operator_curated` > `tool_observed` > `agent_written` > `unknown` > `external_untrusted`.
- **[V]** Guest sources (`trust/schema.ts`, `guestGuard`, ~lines 150-186): a guest page is capped at the source ceiling, only listed writers may change it, it is written only as a guest note, and a guest source holds no facts, takes or timeline entries.

### 5.3 Other DB-side invariants

- **[V]** Purge tombstones (`src/core/facts/purge-schema.ts:157-186`): `pages_refuse_purged`, `facts_refuse_purged`, `takes_refuse_purged` refuse content whose hash or fact was purged for that source (`purged_content:`).
- **[V]** `oauth_clients.source_id ON DELETE RESTRICT` is physical, so a soft-deleted client still blocks a source delete. `src/core/destructive-guard.ts` counts those referents (per `docs/architecture/key-files/security.md`).
- **[V]** CHECKs: `access_members.id` regex (`v282:26`), `oauth_clients.source_grant IN ('none')` (`schema.sql:800`), `fact_withdrawals.visibility IN ('private','world')` (`~830-836`), `persistence_topology_changes.intent_bytes >= 0` (`src/core/persistence/topology-schema.ts:15`).
- **[V]** Derived access state is kept by triggers: `pages_access_stamp_folder_rules` (v283, `:125`), `access_rules_mark_restricted` and `access_pending_coverage_mark_restricted` (v283, `:161-165`), `access_members_refresh_serves` and `config_serves_refresh` (v309, `:64-70`).
- **[I]** Persistence protocol triggers (`schema.sql:2957-3060`) and the minion queue trigger (`:1789`) belong to other maps. They are DB-enforced, so they are listed for completeness.

## 6. Grants

- **[V]** Grant revisions (`oauth_clients.grant_profile`, `grant_revision`, `grant_repair_reasons`, `schema.sql:794-796`) and `oauth_grant_audit` (`:813-823`). Rescope is the trusted-operator path (`oauth-provider.ts:1233`, `src/core/grants/rescope.ts`).
- **[V]** `assertScopeSourceGrant` is called from `src/core/grants/legacy-token.ts`, `src/core/grants/service.ts` and `src/core/token-mint.ts`. `key-files/access.md` names the inner writers `insertClientGrant`, `persistGrant`, `writeTokenGrant`, `insertUnifiedToken`; I did not open those bodies.

## 7. `file_upload` confinement

- **[V]** `src/core/ops/files.ts:58-86`: `scope: 'admin'`, `localOnly: true`. The path resolves against `hookSessionCwd()` and goes through `validateUploadPath` (`src/core/ops/context.ts:149-189`), which is stricter for untrusted callers (`strict = ctx.remote !== false`).
- **[V]** `localOnly` is documented in `src/mcp/dispatch.ts:629-634` as hiding or refusing such ops over a network transport. [I] I did not trace dispatch to confirm the refusal end to end.
- An open question about upload path confinement is tracked separately.

## 8. Prompt-injection defenses

- **[V]** Query expansion (`src/core/search/expansion.ts`). `sanitizeQueryForPrompt` (`:23-36`) caps at 500 chars, strips fenced code and HTML-like tags, and removes leading role words (`ignore`, `system`, `assistant`). `sanitizeExpansionOutput` (`:40-54`) strips control chars, caps at 500, dedupes, and keeps at most 2 alternatives. Expansion runs only for queries of 3+ words (`MIN_WORDS`, `:12`).
- **[V]** The query-side sanitizer is a lightweight text strip scoped to query expansion.
- **[V]** The stored-text defense is `src/core/write-gate.ts` (deterministic, model-free). Trust tier routes it. `external_untrusted` instruction-like text is flagged, quarantined, rejected or allowed per `write_gate.external_mode`, and a detector error quarantines. `agent_written` and `unknown` flag or allow, and a detector error allows. The gate never runs on `user_confirmed`, `operator_curated` or `tool_observed`. Patterns: `src/core/write-gate-patterns.ts`.
- **[I]** The gate is application code. The DB stores tier and receipts, not the detector, so the Rust write path must call the gate itself.

## 9. Egress and consent

### 9.1 What text leaves the process

- **[V]** Model calls go through `src/core/ai/gateway.ts`: `embed` (`:1859`, `:2066`, `:2215`), `expand` (`:2698`), `chat` (`:3906`). Provider keys are redacted from error text (`redactKeys`, `gateway.ts:155`, `src/core/ai/key-redact.ts`). Request bodies are sent as built by each caller.
- **[V]** `secret-scan.ts` redaction runs at specific sites: fact embedding (`src/core/embed-facts.ts:9`), proactive brief (`context/proactive-brief.ts:26`), retrieval reflex (`context/retrieval-reflex.ts:41`), transcript render (`transcripts/render.ts:50`).
- An open question about which page text may reach the embedding provider is tracked separately. The Rust embedder design depends on its answer.
- **[V]** Expansion sends the sanitized query (`expansion.ts:64-70`).
- **[V]** Egress budget (`src/core/egress-budget.ts:19-31`) caps each MCP frame: 4 MiB stdio, 1 MiB HTTP, configurable in [256 KiB, 9 MiB]. It protects the client, not the model provider. Trusted CLI calls have no cap.

### 9.2 Consent gate

- **[V]** `requireConsent` (`src/core/consent.ts:208`) runs only in trusted local CLI handlers. A `host_admin` action is never authorizable from MCP. Preapprovals live in `~/.gbrain/config.json`, not in the DB.
- **[V]** The header says it plainly: "an agent can always pass `--yes`. This gate forces a stop and supplies relay text; it cannot prove a human agreed." The enforced rails are the spend cap and the plan-hash binding.
- **[V]** Caps: `DEFAULT_PAID_CAP_USD = 5`, `DERIVED_CAP_MULTIPLIER = 1.5`, `DERIVED_CAP_FLOOR_USD = 0.25` (`consent.ts:84-87`).

## 10. Credential vault (`src/core/creds/`, 1,118 lines)

- **[V]** Custody (`vault.ts:9-16`): secrets live only in the vault or in env at connect time, never in the config DB or `sources.config`. Sources store a credential id. `list()` returns `redactEntry` output only (`vault.ts:110-131`).
- **[V]** Interface (`vault.ts:87-103`): `get`, `put`, `list`, `delete`, `getClient`, `putClient`, `deleteClient`. Kinds: `oauth2`, `bearer`, `api_key`.
- **[V]** `FileVaultBackend` (`vault.ts:214`): `~/.gbrain/credentials.json`, mode 0600 (pre-created before the atomic write). An unreadable file is refused, never overwritten. `openVault()` at `:302`.
- **[V]** `EngineVaultBackend` (DB-backed, for hosted) exists only as a described interface; no implementation is in this repo.
- **[V]** `src/schema.sql` has no credential table (grep `credential`, `secret`, `vault`).
- **[V]** Encrypted bundle export (`creds/export.ts:23-30`): scrypt N=2^15, r=8, p=1; base64 salt and IV.

## 11. SECURITY.md posture

- **[V]** Remote MCP (`SECURITY.md:256-330`): DCR off by default; pre-register trusted clients with least-privilege grants; DCR ceilings and owner approval (`:367-415`); loopback bind, CORS, rate limits, proxy trust, body cap, audit log (`:440-616`).
- **[V]** SECURITY.md does not mention the write gate, trust tiers or prompt injection (grep). Those are documented only in code headers (`src/core/write-gate.ts`, `src/core/trust/tier.ts`).

## 12. Invariants the database enforces today (must move to Rust)

These have no home in an embedded store: no RLS, no triggers, no policies. Each row says where the Rust check goes and how to test it.

| # | Invariant | Enforced today by | Rust home | Test |
|---|---|---|---|---|
| I1 | Write only to sources in the caller's allowlist; old and new source both checked on UPDATE | `gbrain_require_managed_writer`, `schema.sql:2522-2600` | One write coordinator with `WriteScope { sources }`; check before every mutation | Foreign-source write: `writer_coordinator_required`. Cross-source move: refused. |
| I2 | Source topology (incarnation, local_path, archived) changes only in administration | source branch, `schema.sql:2556-2570` | Topology capability type | Change `local_path` without capability: refused. Snapshot path still works. |
| I3 | Git-canonical sources refuse writers without the protocol | `schema.sql:2607-2615`, `:2647-2670` | Protocol version on writer identity | Old-protocol writer to git source: refused. |
| I4 | Tier from writer; no raise above `operator_curated` without promotion; origin stamped | `gbrain_stamp_trust_tier`, `trust/schema.ts:187-236` | Typed `TrustTier`; promotion is explicit | Matrix over (writer tier, old tier, promo, backfill). |
| I5 | Guest ceiling, writer list, guest-note-only writes, no facts/takes/timeline in guest source | `trust/schema.ts` `guestGuard` | Guest policy before insert | Port `test/guest-notes-scoped-role.test.ts`. |
| I6 | `readable_by` normalizes; malformed means `!nobody`; `page_readers` derived on every write | v282 functions and trigger | Normalize in writer; store derived column | Fuzz: non-string, >256 entries, uppercase, prefixes, empty, and a list mixing valid and invalid entries (must read as `!nobody`, never as the valid subset). |
| I7 | `restrictions_present` set whenever a restriction exists | v282 mark-restricted triggers | Derive, or set in the same transaction | Restricted page read as unbound caller: filtered. |
| I8 | Folder rule ids and serves recomputed on slug, source or member change | v283 stamp trigger; v309 serves triggers | Recompute in the same transaction | Move page into rule prefix; disable member; assert coverage and serves. |
| I9 | Purged content never re-saved | `facts/purge-schema.ts:157-186` | Tombstone check in write path; index `(source_id, content_hash)` | Purge then `put` same content: `purged_content`. |
| I10 | Source delete refused while any OAuth client (incl. soft-deleted) references it | `ON DELETE RESTRICT` | Referent check inside delete transaction | Soft-delete client, `sources remove`: refused, names client. |
| I11 | Client delete cascades tokens and codes; source purge cascades withdrawals; group delete cascades members | FK `ON DELETE CASCADE` | Cascades in one Rust transaction | Delete client; no tokens or codes remain. |
| I12 | Identifiers and enums valid (member id, `source_grant`, visibility) | CHECK constraints | Validated newtypes | Property test over invalid strings. |
| I13 | Token and code hashes unique; lookup by hash, revoked excluded | UNIQUE, PK, partial index | Store hash only | Mint two tokens; revoked token refused. |
| I14 | Non-BYPASSRLS roles read nothing from protected tables | RLS enable, no policy | Not needed; replace with per-op authz tests | Each read op with unbound or revoked credential returns no rows. |
| I15 | Opt-in per-source read filter for an SQL role | `GBRAIN_RLS_SCOPE_BINDING` plus operator policy | Drop; `sourceScopeOpts`-equivalent is the only layer | Same per-op tests as I14. |

## Rust engine implications

**Preserve exactly**

- Trust semantics. Trusted-only checks test "is trusted"; untrust-unless-explicit checks test "is not trusted". Use an enum with no default, so a missing caller is a compile error.
- The `sourceScopeOpts` ladder, the `__all__` rule (trusted only), and "empty array is not all" (`context.ts:653-656`).
- `readable_by` normalization and the `!nobody` fail-closed value, with the exact regex of `ACCESS_ID_RE`.
- Scope names and implications (`scope.ts:25`, `:163-168`). `admin` does not imply `agent`.
- DCR ceilings (`read write`; machine `read`; `memory_confirm` local-only).
- Token format: prefix plus 32 random bytes hex, SHA-256 at rest, revoke by id.
- Tier order, and no tier raise above `operator_curated` without promotion.
- The `writer_coordinator_required` error family. Clients match on it.
- Upload path confinement for remote callers (see section 7 for status).
- Consent defaults: $5 cap, 1.5x derived multiplier, $0.25 floor.

**Can simplify**

- Drop RLS, `app.scopes`, the auto-RLS event trigger, the v275 backfill and the `RLS_EXEMPT` escape hatch. PGLite never had them, so the app layer was always authoritative.
- Drop `EngineVaultBackend` until hosted needs it.
- Make `restrictions_present` a computed or transactionally maintained value.
- Bind identities as parameters instead of inlining literals in `readersAllowedSql`.
- Replace the regex prompt sanitizer with a length cap and control-character strip, and rely on the write gate for stored text.

**Postgres features each piece uses today**

| Piece | Postgres feature |
|---|---|
| Write allowlist | Transaction-local GUC via `set_config(..., true)`; BEFORE triggers |
| Trust stamping | BEFORE INSERT/UPDATE plpgsql triggers; jsonb |
| Readers | Trigger-maintained `page_readers text[]`; IMMUTABLE SQL functions; jsonb `?` |
| Access state | AFTER triggers; `ON CONFLICT`; FK RESTRICT and CASCADE; partial index |
| Read isolation | RLS, BYPASSRLS, `row_security_active()` |
| Tokens | `UUID`, `TEXT[]`, `BIGINT` epoch; `FOR UPDATE SKIP LOCKED`; partial index on `revoked_at IS NULL` |
| Audit | `BIGSERIAL`; JSONB before and after |

**Risks**

1. A missed trigger is a silent loss of enforcement. I1, I4 and I7 hold only if the Rust write path applies them. Build one write chokepoint and test that nothing else mutates the store.
2. `restrictions_present` is a global fast-path flag. The Rust engine must maintain it exactly. Test I7 first.
3. RLS was never a real second layer for default configs. Per-op authz tests (I14) must replace it.
4. Unsalted SHA-256 is fine for 256-bit random tokens and wrong for user-chosen secrets. Keep tokens random.
5. Embedding egress: decide explicitly which pages are embedded and by which provider (see 9.1).
6. Stored-text defense is the write gate. Port the gate patterns with their tests.
7. The consent gate is advisory (`--yes` always works). Do not treat it as an authorization boundary.

## Open questions

1. Embedding egress policy (see 9.1): tracked separately.
2. Is `GBRAIN_RLS_SCOPE_BINDING` used in any production brain? If yes, the port must match its observable behavior.
3. Do any of the 32 RLS-enabled tables get read by a role other than the owner? If none, the RLS list can go.
4. Is `engine-sql/` the only path reading `access_tokens` and `oauth_*`? A full grep is needed for the Rust read surface.
5. Should `EngineVaultBackend` live in this repo or stay with the hosted product?
6. Keep `sanitizeQueryForPrompt`, or drop it in favor of a length cap? Measure what the expansion model does with stripped input.
7. How much of `requester-scope.ts` (14-day grace, stored timestamps) is needed in phase 1? A fresh Rust brain has no legacy connections.
8. Which "working directory" does a Rust stdio server use for `file_upload` confinement? Match `hookSessionCwd()` semantics or define a new root.
