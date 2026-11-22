# 05. Agent-facing surface: operations, CLI, MCP

Line numbers refer to gbrain 36bd05806a.

Reference: TypeScript gbrain v0.60.733.0 at `garrytan/gbrain` (commit 36bd05806a), read only. Eval repo at `garrytan/gbrain-evals` (commit 9ecc5b20).

**Method.** The reference checkout has no `node_modules`, so `src/core/operations.ts` cannot be imported. The 204-entry manifest was instead read from a copy of the handler-free `src/core/operation-manifest.generated.ts` in /tmp and parsed with bun. The CLI command table was imported directly (its imports are type-only). Engine calls were mapped with a regex over `src/core/ops/*.ts` and `src/core/verbs.ts`: direct `engine.X(` calls inside each op's literal body. Helper-delegated calls are not followed, so some ops show no direct engine call. Items marked (inferred) were not confirmed by running code.

## 1. Headline numbers (verified)

| Item | Value | Where |
|---|---|---|
| Operations | 204 | `operation-manifest.generated.ts` |
| Scope split: read / write / admin / agent / sources_admin | 92 / 60 / 48 / 2 / 2 | `scope` field |
| Mutating / idempotent | 90 / 169 | |
| `localOnly` / `cliOnly` / `verb` | 25 / 18 / 7 | |
| Ops with `cliHints` / with a CLI name (`cliHints.name`) | 121 / 115 | |
| Named params across all ops | 930 | |
| Area groups | 30 (29 named, plus 5 ops with no area) | `operation-load.ts:30` OP_AREAS |
| Output redaction | 112 `no_stored_text`, 53 `retrieval`, 39 object form (exempt or `localVerbatim`) | `ops/contract.ts:820` |
| CLI command records | 132 (46 pre-connect, 12 pre-connect-own-engine, 74 post-connect) | `src/cli/command-table.ts:148` |
| CLI records with thin-client refuse / route-then-refuse | 43 / 7 | `command-table.ts:483` |
| CLI records with a `--json` document contract | 15 (plus `bench` and `eval export/replay/gate` as NDJSON) | `json` field |
| Error registry entries | about 790 | `src/core/error-registry.ts` |
| Memory verbs / protocol_version | 7 / 1 | `src/core/verbs.ts:35,41` |
| Verb conformance fixture cases | 24 | `test/fixtures/memory-verbs/cases.json` |
| Allowed OAuth scopes | 10 | `src/core/scope.ts:27` |

## 2. The operation contract

- Each op is a plain object of type `Operation` (`src/core/ops/contract.ts:826`) with `name`, `description`, `params` (a `ParamDef` map), `callShape`, `handler(ctx, params)`, `outputRedaction`, and optional `mutating`, `idempotent`, `scope`, `requiredScopes`, `localOnly`, `cliOnly: {argv}`, `publishGateKey`, `verb`, `area`, `agentCallable`, `annotations`, `cliHints`, `writeInference`.
- `src/core/operations.ts:146` builds the canonical `operations` array by spreading per-domain arrays from `src/core/ops/*.ts` in a fixed order. The order is contractual because `docs/TOOL_CATALOG.md` is generated from it. `finalizeOperation` runs over the array at `:245`.
- `operation-manifest.generated.ts` is the same list minus handlers, emitted by `scripts/build-operation-manifest.ts`. The CLI and stdio MCP read it so they never load the handler graph. `test/operation-manifest.test.ts` pins freshness and equality with the live registry.
- Output redaction is applied at registration. `retrieval` ops get the canonical secret scanner over the whole response. `no_stored_text` ops return no page, chunk, fact, take or transcript text. `{exempt}` ops return stored text on purpose and must give a reason.

## 3. Inventory by area (all 204)

Legend after each name: scope `r` read, `w` write, `a` admin, `g` agent, `s` sources_admin. Flags: `L` localOnly, `C` cliOnly, `V` verb. Area names are not a contract (`contract.ts:892`, `operation-load.ts:22`), so a Rust port may regroup them.

| Area (count) | Operations |
|---|---|
| pages (31) | get_page:r, put_page:w, delete_page:w, list_pages:r, restore_page:w, purge_deleted_pages:a+LC, capture:w, fetch:r, find_pages:r, edit_page:w, append_page:w, put_pages:w, begin_page_upload:w, upload_page_part:w, get_page_upload:w, commit_page_upload:w, abort_page_upload:w, get_write_request:w, list_write_requests:w, list_write_conflicts:r, cancel_write_request:w, get_versions:r, revert_version:w, promote_guest_note:w, put_raw_data:w, get_raw_data:r, resolve_slugs:r, get_chunks:r, whois:r, list_page_purges:a+C, unpurge_page:a+C |
| jobs (20) | submit_job:a, get_job:a, wait_job:a, list_jobs:a, cancel_job:a, retry_job:a, get_job_progress:a, pause_job:a, resume_job:a, replay_job:a, send_job_message:a, submit_agent:g, get_agent_job:g, get_job_stats:a, watch_job:a, watch_write_request:w, watch_cron:a, accept_wakeshift_terms:w, list_watches:w, unwatch:w |
| skills (15) | list_skills:r, get_skill:r, list_brain_skillpack:r, get_skill_asset:r, put_skill:w, delete_skill:w, set_skill_policy:a, get_skill_policy:a, get_skill_retention:a+LC, prune_skill_revisions:a+LC, retain_skill_revision:a+LC, import_skill_proposal:a+LC, join_brain:r, sync_brain_skills:r, leave_brain:r |
| admin (13) | get_stats:a, get_health:a, run_doctor:a, get_brain_health:r, quarantine_list:a, get_write_attribution:a, get_status_snapshot:a, get_usage:a, code_traversal_cache_clear:a+L, migrate_embeddings:a+LC, run_onboard:a, run_skillopt:a, mute_notice:w |
| takes (11) | takes_list:r, takes_search:r, think:r, takes_scorecard:r, takes_calibration:r, takes_add:w, takes_update:w, takes_resolve:w, takes_supersede:w, takes_remove:w+L, takes_rebuild:w+L |
| search (10) | search:r, query:r, assemble_evidence:r, search_stats:a, search_modes:r, search_tune:a, cache_stats:a, search_exact:r, rate_answer:w, search_by_image:r |
| links (9) | add_link:w, remove_link:w, get_links:r, get_backlinks:r, list_link_sources:r, traverse_graph:r, wanted_pages:r, find_orphans:r, rank_entities:r |
| schema (9) | get_active_schema_pack:r, list_schema_packs:r, schema_stats:r, schema_lint:r, schema_graph:r, schema_explain_type:r, schema_review_orphans:r, schema_apply_mutations:a, reload_schema_pack:a |
| insights (8) | get_calibration_profile:r, get_recent_salience:r, find_anomalies:r, get_recent_transcripts:r+LC, volunteer_context:r, find_contradictions:r, find_experts:r, find_trajectory:r |
| memory-verbs (7) | remember:w+V, entity:r+V, synthesize:r+V, forget:w+V, recall:r+V, context_pack:r+V, delta:r+V |
| memory (6) | confirm_memory:w, extract_facts:w, forget_fact:w, memory_recall:r, memory_write:w, memory_propose:w |
| chronicle (6) | chronicle_day:r, chronicle_on_this_day:r, chronicle_since:r, chronicle_last_seen:r, volunteer_chronicle:r, chronicle_backfill:a+L |
| entities (6) | extract_entities:w, extraction_pending:r, extraction_review:w+LC, entity_identity_link:w+L, entity_identity_unlink:w+L, entity_identity_list:r |
| code (6) | code_callers:r, code_callees:r, code_def:r, code_refs:r, code_blast:r, code_flow:r |
| files (5) | file_list:a+L, file_upload:a+L, file_url:a+L, file_register:a+LC, file_verify:a+LC |
| (no area, 5) | storage_register:w+LC, storage_update:w+LC, sources_inspect:r+LC, connectors_status:r+LC, connector_sync:w+LC |
| sources (5) | sources_add:s, sources_list:r, sources_remove:s, sources_status:r, sources_resolve_path:r |
| questions (5) | questions_pin:w, questions_list:r, questions_status:r, questions_refresh:w, questions_unpin:w |
| ontology (4) | ontology_get:r, ontology_propose:w, ontology_dimensions:r, ontology_conflicts:r |
| loops (4) | open_loops:r, loops_close:w, loops_mute:w, loops_unmute:w |
| tags (3) | add_tag:w, remove_tag:w, get_tags:r |
| storage (3) | storage_find:r, storage_get:r, storage_list:r |
| memory-settings (3) | get_memory_settings:r, set_memory_writeback:a, memory_conversation_mode:w |
| timeline (2) | add_timeline_entry:w, get_timeline:r |
| identity (2) | get_brain_identity:r, whoami:r |
| ingest (2) | log_ingest:w, get_ingest_log:r |
| single entries | advisor:r (advisor), sync_brain:a+L (sync), request_tools:r (discovery), purge_fact:a+C (facts) |

Local-only ops (25): purge_deleted_pages, get_skill_retention, prune_skill_revisions, retain_skill_revision, import_skill_proposal, sync_brain, file_list, file_upload, file_url, file_register, file_verify, storage_register, storage_update, takes_remove, takes_rebuild, sources_inspect, get_recent_transcripts, connectors_status, connector_sync, chronicle_backfill, extraction_review, entity_identity_link, entity_identity_unlink, code_traversal_cache_clear, migrate_embeddings.

CLI-only ops (18) have `cliOnly.argv`, for example `purge_deleted_pages` maps to `gbrain pages purge-deleted --dry-run --json`. Over MCP they return `trusted_local_only` (`cliOnlyRefusal`, `src/core/ops/callable.ts`).

## 4. The roughly 30 most-used operations

The repo has no usage histogram; the `derive-starter-ops.ts` script needs production `mcp_request_log` data. The ranking below is therefore inferred from the starter tier, which the code calls the daily-driver set (`src/mcp/surface.ts:93`). The starter set has 41 names by hand tally. The MEMORY_VERBS doc says 40. Dropping the skill-catalog and brain-membership ops leaves the 32 below.

| Op | Scope | Engine path (direct calls, else delegate) |
|---|---|---|
| remember | w | `verbs.ts:229` `submitRememberMutation` then `persistence/memory-mutations.ts` then `persistence/journal.ts:289` `admitWrite` (inferred from the chain) |
| entity | r | `verbs.ts:256`; name lookup helpers, no direct engine calls |
| synthesize | r | `verbs.ts:348`; LLM call, cost block; no direct engine calls |
| forget | w | `verbs.ts:484` then `submitForgetMutation` (`:381`); rewrites each page that carries the claim |
| recall | r | `ops/facts.ts:298`: `listFactsSince`, `listFactsByEntity`, `listFactsBySession`, `listSupersessions`, `countUnconsolidatedFacts`; search arm reuses the search pipeline |
| context_pack | r | `ops/facts.ts:714`; world-only facts unless trusted local |
| delta | r | `ops/facts.ts:955` |
| query | r | `ops/search.ts:881`: `getConfig`, `searchVector` (hybrid) |
| search | r | `ops/search.ts:696`: `getConfig`, `searchKeyword` |
| get_page | r | `ops/pages.ts:98`: `readPageSnapshot`, `transaction`, `getPage`, `getTimeline` |
| list_pages | r | `ops/pages.ts:515`: `listPages` |
| get_backlinks | r | `ops/links.ts:445` (helper) |
| traverse_graph | r | `ops/links.ts:567`: `traverseGraph`, `traversePathsDetailed` |
| list_link_sources | r | `ops/links.ts:473`: `listLinkSources` |
| resolve_slugs | r | `ops/chunks.ts:21`: `resolveSlugs` |
| get_ingest_log | r | `ops/ingest-log.ts:60`: `getIngestLog` |
| put_page | w | `ops/pages.ts:345`: `readPageSnapshot`, `transaction`, plus the persistence write journal (inferred from imports) |
| add_timeline_entry | w | `ops/timeline.ts:45` (helper) |
| get_recent_salience | r | `ops/salience.ts:25`: `getRecentSalience` |
| find_anomalies | r | `ops/salience.ts:69`: `findAnomalies` |
| whoami | r | `ops/sources.ts:35`; reports identity per transport |
| request_tools | r | `ops/request-tools.ts:159`: `executeRaw` (two calls); the only discovery meta-op, agent-callable |
| capture | w | `ops/pages.ts:704` (hidden alias of a page write; starter list) |
| edit_page | w | `ops/page-edit.ts:11` then `persistence/page-edit.ts`, `persistence/page-mutations.ts` |
| submit_agent | g | `ops/jobs.ts:364`: `getConfig`; Minions queue |
| get_agent_job | g | `ops/jobs.ts:539` |
| cancel_job | a | `ops/jobs.ts:750` |
| get_write_request | w | `ops/persistence.ts:229` |
| list_write_requests | w | `ops/persistence.ts:258` |
| cancel_write_request | w | `ops/persistence.ts:325` |
| mute_notice | w | `ops/notices.ts:15` |
| memory_conversation_mode | w | `ops/memory-settings.ts:204` |

## 5. The seven memory verbs (MEMORY_VERBS v1)

Source of truth: `docs/protocol/MEMORY_VERBS_v1.md` (1,311 lines), `src/core/verbs.ts`. The first four (`remember`, `entity`, `synthesize`, `forget`) are in `verbs.ts` and spread first into the operations array (`operations.ts:146`). `recall`, `context_pack` and `delta` are in `ops/facts.ts`.

| Verb | Class | Params (* required) | Notes |
|---|---|---|---|
| recall | read | query, question (2,000 char cap), entity, budget_tokens, budget_policy (facts_first or query_first), source_id, source_ids, since, session_id, include_expired, supersessions, limit (per arm), grep, include_pending, return_unit, return_window, min_trust, max_chars | Facts arm plus search arm; `question` ranks facts by cosine plus term share; estimated tokens `ceil(len/4)` |
| remember | write | fact, provenance (required, else `provenance_required`), ttl, entity, kind, visibility, valid_from, request_id, items (up to 20), content_origin, expected_revision, force, share, replaces | Returns a write receipt; `write_pending` maps to exit 10 |
| entity | read | name or names (1 to 50), source_id, prefer_source_id, variants | Never errors on a miss (`found: false`); CI-gated p99 under 100 ms on 20K pages |
| synthesize | read | question*, since, until | LLM call; `unavailable` error when no LLM is configured; quote check adds `QUOTE_NOT_IN_EVIDENCE` |
| forget | write | id* (opaque fact_id string), reason, request_id, semantic_review | Idempotent (`expired: false` on repeat); `claim_linked` refusal when an unlinked fact shares a claim; facts expire, never delete |
| context_pack | read | entities, budget_tokens, since, session_id, include_private, min_trust, include_quarantined, counterparty, intent, source_id, entity_refs, prefer_source_id | Zero LLM; fan-out capped at 8 entities; world-only for remote callers |
| delta | read | since, since_slug, cursor, entities, budget_tokens, session_id, include_private, min_trust, beliefs | O(changes); session cursors expire after 7 idle days |

Every verb response carries `protocol_version: 1` (`verbs.ts:230` and the others). `RESPONSE_SCHEMAS` (`verbs.ts:604`) and `ERROR_SCHEMA` (`verbs.ts:1105`) are the machine-readable shapes. Error envelope: `{error, code, message, suggestion, detail?, protocol_version}`. Frozen codes: `invalid_params`, `provenance_required`, `not_found`, `scope_denied`, `unavailable`, `budget_unsatisfiable` (reserved, never returned), `internal`. Versioning rule: names and semantics are frozen; new optional params and fields are additive; a breaking change means a new document.

Read verbs redact credential-shaped text for remote callers (`ctx.remote !== false`). Remote callers see only `visibility = world` facts, except a caller bound to the brain owner, which also reads private facts (`worldOnlyFacts`, `src/core/search/private-visibility.ts`); source grants and member access still apply to both. The trusted local CLI sees stored text.

## 6. Surface modes

| Mode | Membership | Source |
|---|---|---|
| `verbs` | exactly ops with `verb === true` (7) | `surface.ts:242-247` |
| `starter` | `STARTER_OPS` (41 by tally) | `surface.ts:93` |
| `full` | all 204; default for bare `serve` | `surface.ts` header |

Resolution for stdio: `GBRAIN_SURFACE` env, then `--surface` flag, then config `mcp_surface`, then `full` (`surface.ts:209-230`). `serve --http` ignores `GBRAIN_SURFACE` (`src/commands/serve.ts:294-305`). On HTTP the surface is a ceiling: each request resolves `min(ceiling, client row ?? default)`, recomputed per request (MEMORY_VERBS doc). Enforcement is fail-closed through one predicate, `isCallable` (`src/core/ops/callable.ts:25`), used by both tools/list and dispatch. A hidden op returns `unknown_tool`, so a guessed name does not leak.

## 7. OperationContext and the trust boundary

Key fields (`src/core/ops/contract.ts:477-826`):

| Field | Meaning |
|---|---|
| `remote` | Required boolean (`:502`). Fail closed: only strict `false` is trusted. CLI sets `false` (`src/cli/main.ts:1456`); stdio and HTTP set `true` |
| `transport` | `'stdio'` or `'http'`. Locality axis only; `localOnly` ops run on stdio and are denied on HTTP. Trust must not key off it |
| `auth` | `AuthInfo`: `clientId`, `scopes`, `allowedSources`, `sourceId`, `boundTools`, `member`, `attest`, `readsUnscoped` |
| `sourceId` | Required string; defaults to `'default'` |
| `localFederatedSourceIds` | Federated read set; set only by trusted builders (CLI non-explicit tier, stdio without `GBRAIN_SOURCE`, legacy HTTP bearer with no grant) |
| `explicitReadBinding` | Stdio `GBRAIN_SOURCE` or `.gbrain-source` pin; admits an explicit `source_id` only |
| `surfaceCeiling`, `stdioSurface`, `isCallable` | Surface state for `request_tools` and `whoami` |
| `takesHoldersAllowList` | Per-token holder filter on takes; default `['world']` for MCP tokens without a row |
| `brainId`, `admissionOrigin`, `sessionId`, `writeWaitMs`, `deferEmbeds` | Routing, attribution, write wait; `deferEmbeds` is server-side only |

`sourceScopeOpts` (`src/core/ops/context.ts:646-669`) is the one read-scope ladder: (1) non-empty `auth.allowedSources` gives `{sourceIds}`; (2) `sourceId === '__all__'` gives `{}` only for `remote === false`; (3) a scalar `sourceId` gives `{sourceId}`; (4) remote with a grant and no source throws `permission_denied`; (5) otherwise `{}`. Sentinels: `ALL_SOURCES = '__all__'` and `NO_SOURCES = '__none__'` (`src/core/source-id.ts:45,54`). The comment says not to simplify the `__all__` branch.

Scope hierarchy (`src/core/scope.ts:162-173`): `admin` implies `write`, `read`, `sources_admin`, `users_admin`; `write` implies `read`; `agent`, `skill_editor`, `skill_publisher`, `skills_member_self`, `memory_confirm` stand alone. `operationScopesAllowed` (`:195`) also honours `agentCallable` for `request_tools`. Local CLI bypasses OAuth scope checks (`contract.ts:859`).

Dispatch (`src/mcp/dispatch.ts:1007`, `dispatchToolCall`): normalise optional params, strip the room declaration, then for remote calls resolve the attested actor and audience, run the requester-scope gate (GST-363), resolve access, call `dispatchResolvedCall`, then shape the result and enforce the frame cap. `unknownToolEnvelope` is at `:639`, `errorResult` at `:883`.

## 8. The write path

Writes do not go straight to the engine. They are admitted as write-request rows by `admitWrite` (`src/core/persistence/journal.ts:289`), with states `queued`, `running`, `recovering`, `committed`, `conflict`, `failed`, `cancelled` (`persistence/types.ts:2-4`; `model.ts:7` adds `deferred` for `RequestState`). A receipt carries `request_id`, and the caller polls with `get_write_request`. Idempotency comes from `request_id` plus `expected_revision`. The journal's SQL includes `persistence_counters`, `SELECT ... FOR UPDATE` (`LOCK_COUNTERS_SQL`), `unnest($1::text[]) WITH ORDINALITY` and `ON CONFLICT` (`journal.ts:241-243`). The Rust port must reproduce these semantics, not the SQL.

## 9. CLI

- Entry: `src/cli.ts` answers `--help`, `--version` and the hook lanes without loading the dispatcher, then loads `src/cli/main.ts` (2,880 lines, `runCli`).
- Command table: `CLI_COMMANDS` at `src/cli/command-table.ts:148`, 132 records. `CLI_ONLY` (`:459`) is every record name. `THIN_CLIENT_REFUSED_COMMANDS` (`:483`) has 47 entries. Phase tells the dispatcher whether to connect the engine first.
- Ops reach the CLI through `cliHints.name` (115 ops; 121 ops carry a `cliHints` object) via `src/cli/op-manifest.ts`. Hidden ops are excluded from the CLI map.
- `makeContext` (`src/cli/main.ts:1360`) builds the trusted local context: `remote: false`, `admissionOrigin: 'interactive'`.
- JSON contract: a command with `json: 'document'` writes exactly one document to stdout; everything else goes to stderr (`src/cli/json-guard.ts`). Records with `jsonSubcommands` (eval) use NDJSON. A non-zero exit without a document gets a fallback `{error: "command_failed", code, message, suggestion, exit_code, contract_version: 1}`. A signal writes `error: "interrupted"`.
- Errors: `writeCliError` (`src/cli/cli-error.ts:53`) and `renderCliError` (`src/core/agent-output.ts:868`). Human form is `Error [code]: message`, then `Fix:`, then `Why:`.

Exit codes (`src/core/exit-codes.ts:18-112`, plus registry entries):

| Exit | Meaning | Constant / source |
|---|---|---|
| 0 | ok | `OK_EXIT_CODE` |
| 1 | failed; class and `retryable` in JSON | `FAILED_EXIT_CODE` |
| 2 | usage or invalid input (`invalid_params`, `unknown_flag`) | `USAGE_EXIT_CODE` |
| 3 | `confirmation_required`; nothing ran | `CONFIRMATION_REQUIRED_EXIT_CODE` |
| 10 | write accepted, still pending (`write_pending`) | `PENDING_WRITE_EXIT_CODE` |
| 11 | resumable budget stop | `BUDGET_STOP_EXIT_CODE` |
| 12 | no results (opt-in via `GBRAIN_FAIL_ON_EMPTY=1`) | `NO_RESULTS_EXIT_CODE` |
| 13 | harness wired, verify pending | `HARNESS_PENDING_VERIFY_EXIT_CODE` |
| 14 | harness cleanup pending | `HARNESS_CLEANUP_PENDING_EXIT_CODE` |
| 15 | no edition in force for `as_of` | `VALID_TIME_NOT_IN_FORCE_EXIT_CODE` |
| 16 | host upgrade required | `HOST_UPGRADE_REQUIRED_EXIT_CODE` |
| 17 / 18 | doctor alert: act / unknown | `DOCTOR_ALERT_ACT_EXIT_CODE`, `DOCTOR_ALERT_UNKNOWN_EXIT_CODE` |
| 69 | serve exited unhealthy (opt-in) | `SERVE_UNHEALTHY_EXIT_CODE` |
| 75 | migration lock held | `MIGRATIONS_RUNNING_EXIT_CODE` |
| 124 | deadline elapsed | `TIMEOUT_EXIT_CODE` |
| 130 | interrupted (SIGINT) | `INTERRUPTED_EXIT_CODE` |

Registry codes default to exit 1 unless an entry sets `exit`. Of the 45 `consent`-class entries, 12 set exit 3 explicitly; the rest exit 1 unless they set another value, so exit 3 is not a class-wide rule. The contract's legacy exception: `mcp expose` and `google` still exit 2 for confirmation.

Error envelope (`docs/protocol/AGENT_OPERATOR_v1.md:598-620`): `error` (frozen legacy value), `code` (canonical), optional `reason`, `message`, `suggestion`, `why`, `fix` (argv, command, mcp call, consent, actor, next, verify), `docs`, `docs_cmd`, `class` (`caller`, `consent`, `retryable`, `unavailable`, `server`, `host_only`), `retryable`, `notices`, `contract_version: 1`. `fix.next` is one of `run`, `ask_user`, `tell_user_to_run`, `wait`, `report`, decided by the table at `AGENT_OPERATOR_v1.md:713`.

## 10. MCP server and transports

- stdio: `startMcpServer` (`src/mcp/server.ts:339`) uses the MCP SDK's `ListTools` and `CallTool` handlers (`:443`, `:460`). Requests come in with `remote: true`, `transport: 'stdio'` (`:496-500`). Message cap is 64 MiB (`src/mcp/stdio-lifecycle.ts:26`). `request_tools` can widen the session surface.
- Result shape: `ToolResult` (`src/mcp/dispatch.ts:163`) is `{content: [{type:'text', text}], isError?, _meta?, structuredContent?}`. Notices ride extra text blocks with a fixed prefix and `_meta.gbrain_notices`.
- HTTP: `startHttpTransport` (`src/mcp/http-transport.ts:212`). Routes: `/health` (`:366`), `/mcp` (`:356` onward). Legacy bearer tokens are matched by SHA-256 hex digest (`:76-78`). Body cap is 1 MiB (`:69`, override `GBRAIN_HTTP_MAX_BODY_BYTES`). The OAuth path uses the SDK's 4 MiB limit.
- Rate limits (`src/mcp/rate-limit.ts:148-155`): per-IP 30 per minute, per-token 60 per minute, LRU of 10,000 keys. Each is overridable by env.
- OAuth 2.1 (`src/commands/serve-http-oauth.ts`, `src/core/oauth-provider.ts`): the SDK's `mcpAuthRouter` provides `/authorize`, `/token`, `/register`, `/revoke` (`:184`). Custom handlers add `client_credentials` before the router, `/.well-known/oauth-authorization-server` (`:190`), `/.well-known/oauth-protected-resource` (`:216`) and `/.well-known/gbrain` (`:223`). PKCE S256 is validated by the provider (`oauth-provider.ts:573`). Client auth methods are `client_secret_post`, `client_secret_basic`, `none`. Default access-token TTL is 3,600 s and refresh TTL 30 days (`oauth-provider.ts:232-235`). Hard cap `TOKEN_TTL_MAX_SECONDS = 7,776,000` (`src/core/grants/model.ts:20`). DCR TTL clamps to at least 300 s (`oauth-provider.ts:285`). `client_credentials` via DCR is refused unless the operator allows it (`:382`).
- Serve flags: `--http`, `--port` (`src/commands/serve.ts:368`), `--token-ttl` (`:371`), `--surface`, `--advertise`, `--access read-only` (stdio only), `--stdio-member`.

## 11. Contract guards and conformance oracles

| Asset | What it pins | Reusable by Rust? |
|---|---|---|
| `test/operation-manifest.test.ts` | manifest freshness, equality with live registry, handler-free startup | Yes as data: export the manifest as JSON and diff it |
| `test/operations-*.test.ts` (allow-list, trust-boundary, source-isolation matrix, coverage ledger, descriptions) | authorization and isolation per op | Yes, as black-box cases over the wire |
| `test/mcp-tool-list-snapshot.test.ts`, `test/mcp-surface.test.ts` | tools/list per surface | Yes: byte or set compare |
| `test/memory-verbs-conformance.test.ts` (896 lines) with `test/fixtures/memory-verbs/cases.json` (24 cases) | verb shape, enums, budget arithmetic, idempotent forget, private facts absent for remote | Yes, best oracle: run over HTTP with `gbrain protocol conformance --target` (`src/commands/protocol.ts:60`) |
| `test/fixtures/agent-contract/v1/*.json` and `test/agent-contract-goldens.test.ts` | frozen wire envelopes; `next` is recomputed, never stored | Yes: the goldens are plain JSON |
| `test/fixtures/goldens/cli/*.json`, `test/fixtures/cli-contract/help-baseline.json`, `test/cli-command-table.test.ts` | command table, help text, dispatch order | Partly; help text is useful, dispatch order is TS-specific |
| `scripts/check-agent-contract.ts` (559 lines) with `scripts/agent-contract-baselines/*.tsv` (12 files, 129 rows) | 16 source rules; baselines are shrink-only; zero-baseline rules include `unregistered-code`, `code-naming`, `generic-suggestion`, `defaulted-suggestion` | No: it is a TypeScript AST scanner. Port the rule list and the registry-code check |
| `test/fixtures/guards/check-agent-contract.ts` | fixture tree for the scanner (`GBRAIN_GUARD_ROOT` seam) | Only as a pattern |
| `src/core/error-registry.ts` to `docs/guides/error-codes.md` (generated) | one row per code with class, exit, legacy value | Yes: generate a Rust table from the same source |
| `eval/runner/mcp-contract.ts` (gbrain-evals, BrainBench cat 12) | trusted vs untrusted inputs across operations | No: imports `gbrain/operations` in-process over PGLite (`:20-23`). Needs an over-the-wire rewrite |

## Rust engine implications

**Must preserve exactly (wire contract)**
- Operation names, scope, `localOnly`, `cliOnly`, `verb`, `mutating`, `idempotent`, param names, types and enums. These form the MCP tool schema and are read by agents.
- The seven verb names, `protocol_version: 1`, the response field names, and the frozen legacy error values alongside canonical `code`.
- Exit codes 0, 1, 2, 3, 10, 11, 12, 13, 14, 15, 16, 17, 18, 69, 75, 124, 130, and the envelope with `contract_version: 1`.
- Fail-closed trust: `remote` is required; only strict `false` is trusted. Source ladder in `sourceScopeOpts`, including the `__all__` and `__none__` sentinels.
- Scope implication table, PKCE S256, SHA-256 token storage, and the `request_id`/`expected_revision` idempotency rules.
- The surface membership sets: `verbs` = the seven verbs; `starter` = the 41-name set. Monotonicity verbs ⊆ starter ⊆ full is pinned by tests.

**Can simplify**
- The 132-record CLI table is mostly routing. A Rust `clap`-style command tree with one generated op-to-command map covers it.
- The lazy module loading, stdout interposer (`cli-force-exit.ts`) and Bun fast paths exist only for Bun's module graph. Rust writes stdout synchronously.
- The express and SDK middleware order (`test/fixtures/goldens/serve-http/routes.json`) is TS-specific. Keep the routes, not the ordering.
- The registry can become one generated static table.

**Postgres features this surface depends on (engine-side, but reached from ops)**
- Write journal: row locks (`FOR UPDATE`), `unnest ... WITH ORDINALITY`, `ON CONFLICT`, counter tables. Needs an embedded transactional store with single-writer or row-lock semantics.
- Config as rows: `mcp_surface`, `mcp.strict_params`, `mcp.publish_*` are read from the engine config table with file fallback. Rust needs the same DB-over-file precedence.
- Access tokens, OAuth clients and codes, and `mcp_request_log` are SQL tables. The legacy bearer path also runs raw SQL through `executeRaw` (in `request_tools` and wakeshift).
- Facts and pages are source-scoped by `source_id` on every read; the ladder must be enforced in the storage layer's query builder, not only in ops.

**Risks**
- 930 params spread over 204 ops; most validation lives in per-op code plus `validate-params.ts` (322 lines). A Rust port that validates less will drift from the tools/list schema.
- Description strings in the manifest are read by agents and drive behaviour. Treat them as data and copy them verbatim.
- The write path has multi-step receipts, `write_pending`, and `--accept-pending`. Getting exit 10 and the receipt right matters more than the internal journal design.
- `gbrain-evals` imports the TS library directly. Anything that breaks that import breaks the eval harness until it is rewritten over the wire.

## Open questions

1. Which ops are truly most used? The repo has no histogram. Who can supply production `mcp_request_log` counts so the starter set is re-derived?
2. Starter tier size: the code tallies 41 names; the MEMORY_VERBS doc says 40. Which is the contract, and is the discrepancy intended?
3. Should the Rust engine serve the full 204-op surface in v1, or only `verbs` plus `starter` with `full` later?
4. Is the OAuth 2.1 server (DCR, PKCE, `/revoke`) required for v1, or is stdio plus legacy bearer enough for the first release?
5. Which `cliOnly` commands (`purge_fact`, `file_verify`, `migrate_embeddings`, skill retention) must exist in v1 given they are owner-only?
6. Per-op engine mapping is partial because helper-delegated calls were not followed. A second pass needs the TypeScript compiler, which is not installed in the reference checkout. Who installs it in a scratch copy?
7. Does the Rust port keep write-request receipts and the `deferred` state, or can it admit writes synchronously in v1?
8. Exit codes 2 versus 3 for `mcp expose` and `google` are documented as legacy. Should the Rust engine copy the legacy behaviour or the v1 table?
