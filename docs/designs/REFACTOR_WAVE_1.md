# GBrain Refactor Wave 1

Reviewed with gstack /autoplan (CEO, DX and Eng phases; each with an independent Claude reviewer and a Codex outside voice) and approved by the owner on 2026-09-30 with all 12 storage domains in scope.

Branch: `refactor/wave-1`. ONE integrated PR, one PATCH version bump, one CHANGELOG entry (owner's standing rule for
fix waves and multi-part cleanups). Baseline: master @ f8d1e3936 (v0.60.11.0); measurements taken at 608a174 (v0.60.10.0).

### Problem (measured; corrected by CEO review)

GBrain is 451,218 lines of TypeScript across 1,473 files in `src/`. Literal copy-paste is low (jscpd 0.55%). The problem
is **parallel implementations**, **three copies of schema text**, and **god functions**:

| Hotspot | Measured size | Churn | Why it farms bugs |
|---|---|---|---|
| `pglite-engine.ts` + `postgres-engine.ts` | 6,184 + 5,590 lines; 180 shared class members whose bodies total ~4,700 lines per engine | 188 / 196 commits; **165 edited both** | Every storage feature is written twice with different drivers (PGLite `db.query($n)` vs Postgres tagged `sql\`\``, 231 tagged sites). Per-domain files (`facts`, `takes`, `salience`, `code-edges`, `cjk-search`) were split *per engine*, keeping the duplication. The forward-reference bootstrap exists twice (604 + 655 lines). 28 parity/drift test files exist to catch the drift. |
| Schema text | `schema.sql` (Postgres, 75 tables), `pglite-schema.ts` (composed bootstrap 71 tables incl. 9 imported TS fragments), and `schema.sql` also inlines copies of 20 fragment tables | 62 commits edited schema.sql + pglite-schema.ts | Three hand-synced copies of the same DDL. End-state columns/indexes are already gated by `test/e2e/schema-drift.test.ts`; the text copies are not. Real table deltas are intentional (Postgres-only `file_migration_ledger`) or migration-timing (`slug_aliases`, `page_aliases`, `code_edges_chunk`, `code_edges_symbol`, `dream_verdicts`). |
| `migrate.ts` | 7,307 lines; `MIGRATIONS` = 170 entries (v2-v175, gaps 17-19 and 100) at lines 196-6780; 29 `handler` closures, 24 `sqlFor`, 15 `transaction`, 99 `idempotent`, 1 `verify` | 121 | Every schema PR edits the same array; runner buried under data; 9 slice-window source-text tests pin locality (`TODOS.md:1976`). |
| `doctor.ts buildChecks()` | 662-4105 (3,444 lines, 235 `checks.push`) | 197 (top churn file) | Peel into `doctor/checks/` (32 modules) is half done (`TODOS.md:1962`, `:4445`). |
| `sync.ts performSyncInner()` | 1349-4054 (2,706 lines, 46 closure `let`s); `performFullSync` 436; `runSyncInner` 1,001 | 99 | Deletes/renames/imports, checkpointing, timeouts, stall handling share mutable closure state; earlier decomposition blocked by positional source-text tests (`TODOS.md:1956`). |
| `serve-http.ts runServeHttp()` | 858-3108 (2,251 lines, 44 routes; inner `/mcp` POST handler 415) | 69 | OAuth, admin API, MCP, metrics and SPA serving as closures; `requireAdmin` attached per route. |
| `jobs.ts` | `runJobs` 1,554; `registerBuiltinHandlers` 1,063 (24 handlers) | 90 | Dispatch and worker handlers in one command file. |
| `cli.ts` | `handleCliOnly` 1,515 (62-case switch); `main` 415 | 188 | Every command edits the same switch. |
| `hybrid.ts` | `hybridSearch` 1,244; `hybridSearchCached` 437 | 64 | Retrieval pipeline in one function. |
| `autopilot.ts runAutopilot()` | 1,111 | 56 | Subcommands in one function. |

Repo-wide there are 77 functions over 300 lines. The existing `scripts/check-module-size.sh` ratchet caps **file** size
only, so a 3,444-line function inside a file under its ceiling is invisible. At least 133 test files read these sources
as text (cli.ts alone 79); every earlier peel stalled on them.

### Goal and success criteria

Behavior-preserving structural refactor: no CLI/MCP contract, schema, or retrieval-quality change.

- (a) Each migrated storage domain's SQL exists once in `src/core/engine-sql/`. Enforced by an engine-sql ratchet over
  ALL engine methods: a committed baseline TSV lists the domains migrated and the SQL-bearing engine methods that remain;
  a new SQL-bearing engine method fails; rows only shrink. The guard matches SQL structure (not bare keywords) and honors
  a `// engine-sql-ok: <reason>` marker like the existing `engine-dynamic-import-ok`.
- (b) One-time acceptance check for this PR: no function over 300 lines in any file touched by this PR ("touched" =
  changed non-import lines vs `merge-base origin/master`). The permanent rule is only the W5 baseline ratchet, so later
  one-line fixes in a baselined file never force a decomposition.
- (c) Every touched `module-size-limits.tsv` ceiling drops.
- (d) Full CI gate (`bun run ci:ubicloud`) green with zero deleted or loosened test assertions.
- (e) Outcome baseline: before starting, classify fix commits from the last 6 months that touched engine parity/drift,
  sync hangs/partials, doctor, and serve-http auth, by cause. Record it in the PR. Re-measure at +3 months.
- (f) Performance budgets set before implementation and checked after: import/write throughput, `searchVector`,
  `searchKeyword`, `_upsertChunksOnce`, `getPage`, hybrid search latency (warm and cold cache), SQL round trips per op,
  provider call counts, and `gbrain --version` cold start (<= +20 ms). Measured on PGLite, direct Postgres, and PgBouncer.

### Workstreams (all in ONE PR, in this commit order)

**W0. Gates first (on master code, before any move).**
- Goldens captured on master: migrations full-record golden (A11), catalog-level schema snapshot for both engines (E4),
  deterministic hybrid output (A13), `doctor` check registry (ordered names + categories, independent of which fire)
  plus `doctor --json` on both engines and one degraded config, serve-http route table with per-route ordered middleware
  (A16), CLI goldens (A16b), perf baselines (f).
- E5 executor binding-matrix contract test (arrays text/int/real, JSONB object/array, bigint, Date, null, boolean, vector
  literal) green on both engines before any W1 conversion.
- Test re-point policy (A10): generalize `test/helpers/doctor-source.ts` into per-surface source loaders; containment
  guards may read the concatenated surface; positional guards must name the single file that now holds the code. No
  assertion removed or loosened; every edited test listed in the PR with before/after assertion.

**W5. Ratchet so it cannot regrow (lands early, conflict-free).**
- `scripts/check-function-size.ts` (TypeScript compiler API, pattern of `check-engine-dynamic-import.ts`): counts
  function declarations, methods, accessors, arrow functions and function expressions (object-literal and
  class-property forms). Baseline TSV seeded with all 77 current >300-line functions at current length; no new function
  over 300 lines; rows keyed by path + qualified name path (not line numbers), with baseline identity transfer for
  verified move-only commits; a baseline raise requires a justification column carrying an issue/TODO id, and the guard
  prints raises in its summary. Actionable failure text
  names the extraction pattern. Row in `guards-manifest.tsv`, bad/good fixtures, wired into `run-verify-parallel.sh`.
- Trim the notes column of every `module-size-limits.tsv` row we touch to one line (some are thousands of characters of
  duplicated text).

**W3. Split the migrations array.**
- Each migration moves to `src/core/schema-migrations/v<NNN>-<name>.ts`. The static-import registry
  `src/core/schema-migrations/registry.generated.ts` is generated deterministically from the directory by a build script and committed, with a
  freshness guard (pattern: `check-tool-catalog-fresh.sh`). Static imports only (`check-engine-dynamic-import`,
  `bun build --compile`). Version allocation rule documented: a migration file's version must be unique; the generator
  fails on duplicates, so two concurrent branches that pick the same number fail loudly at rebase.
- `migrate.ts` keeps only the runner (~700 lines) and keeps re-exporting `MIGRATIONS`, `LATEST_VERSION`, `Migration`;
  runner sort order unchanged. Directory is `src/core/schema-migrations/` (not `migrations/`, which collides with
  `src/commands/migrations/` and `skills/migrations/`); each registry's header points at the other.
- `bun run new:migration <name>` scaffolds the next version, a typed template and regenerates the registry;
  `build:schema-migrations` regenerates ("regenerate, never hand-merge"); generated registry marked in `.gitattributes`; filename/version cross-check.
- Collision recovery documented in three cases: unapplied branch migration (renumber + regenerate); already applied to a
  disposable dev DB (rebuild and replay); already applied to retained data (explicit reconciliation, never just a counter
  edit, per the renumbering incident documented at `migrate.ts:7106`). Duplicate diagnostic names both files.
- Registry test against the W0 golden: version set equals master (gaps preserved), and for all 170 entries identical
  `name`, `sql`, `sqlFor.{postgres,pglite}`, `transaction`, `idempotent`, `verify` presence, and handler source-text hash.
  Apply-from-empty and apply-from-an-older-version on both engines produce the E4 catalog snapshot.
- Snapshot inputs (A6): `computeSnapshotSchemaHash` (`pglite-engine.ts:334-366`) hashes every
  `src/core/schema-migrations/*.ts` (sorted) and the generated schema; `.github/workflows/e2e.yml` cache keys (lines 71, 186)
  updated identically; a unit test fails if any migrations file or generated schema is missing from the hash inputs.
- Drop the `region-exempt` MIGRATIONS policy from `check-module-size.sh`.

**W2. One copy of schema text (no schema change).**
- Canonical-source graph written down: `src/schema.sql` stays canonical for non-fragment tables; the TS fragment modules
  are canonical for the 20 fragment tables; everything else is generated by one command (`bun run build:schema`).
  Generated regions carry `BEGIN/END GENERATED from <path>` banners; the freshness guard names the file that should have
  been edited. Worked examples: add a column/index, add a table, and when forward-reference bootstrap changes apply.
- W2a: generate the PGLite bootstrap from that graph in `scripts/build-schema.sh`. The generated bootstrap must
  reproduce the current fresh-install end state exactly (E4 catalog snapshot on master == branch for PGLite; PGLite ==
  Postgres except the existing allowlist). Intentional engine differences are expressed as explicit capability rules in
  the generator, not as a blind subtraction transform. Freshness guard modeled on `check-tool-catalog-fresh.sh`.
- T1 (accepted): also generate `schema.sql`'s 20 inline fragment tables from the TS fragment modules, so schema DDL
  text has exactly one copy.
- Table-set reconciliation between engines is NOT part of this PR (it would be a real schema change for existing PGLite
  brains). The plan documents which tables each engine gets from bootstrap vs migrations.
- Remove the stale `pglite-schema.ts` DRIFT WARNING with the hand-maintained file; closes `TODOS.md:1868`.

**W1. One SQL implementation per storage domain (behavior-touching; highest value, highest risk).**
- Executor (A1): build the engine-sql executor beside `src/core/sql-query.ts`, reusing `executeRawJsonb`; the existing
  scalar `SqlValue` contract is preserved and any added array/JSONB parameter types are defined explicitly. Driver errors
  pass through unchanged (class, `.code`, message) for 23505, 57014 and deadlock-shaped errors on all three backends.
  Documented contract: parameter encoding (arrays, jsonb, vector, bigint, Date, null), transaction ownership, nested
  rollback/savepoints, cancellation, retry ownership, scoped connections.
- RLS (A3, narrowed by EO4 in Engineering contracts: preserve master's per-method scoping): scoped reads accept only a
  branded `ScopedRead` obtainable from `withScopedReadTransaction`
  (identity on PGLite). The brand key is self-describing (e.g. `__obtainViaWithScopedReadTransaction`)
  with TSDoc naming the factory; `unscopedExecutor(reason)` is the sanctioned escape hatch for doctor/maintenance/admin
  reads and a guard bans `as ScopedExecutor` casts. Typecheck rejects unscoped use (`@ts-expect-error` fixture); e2e with `rlsScopeBindingEnabled` asserts
  `current_setting('app.scopes')` inside store reads.
- Driver parity (A4): the Postgres adapter routes through `runUnsafe`, forwards `signal` exactly where the engine does
  today, keeps `checkoutGauge` labels, and passes `{prepare}` from `db.resolvePrepare(url)` so direct Postgres keeps
  prepared statements and PgBouncer keeps its mode. PGLite keeps checkpoint admission and `PgliteStatementCache`.
- Row normalizer (A5): declared per-column kinds (jsonb, bigint, date, vector, text[]); no value-type guessing;
  per-kind contract test on both engines.
- Source scope (A5b): store functions receive an already-resolved source scope and never resolve it.
- Dynamic SQL (A2b): only identifiers/ordering from constant allowlists may be concatenated into store SQL; every value is
  positional; scanner guard over `src/core/engine-sql/` with bad/good fixtures.
- Scope (UC1, owner decision 2026-09-30: all 12 domains in this PR): **W1-core** = executor + contract tests + the 5
  already per-engine-split domains (`facts`, `takes`, `salience`, `code-edges`, `cjk-search`) + E1 single
  forward-reference bootstrap, landed first. **W1-extended** = the remaining 7 domains (`pages`, `links`, `tags`,
  `timeline`, `sources`, `files`, `chunks`), started only after the W1-core gates are green (see Engineering contracts).
  A per-method inventory (identical / identical-after-normalization / identical SQL with different driver
  post-processing / dialect-specific) is produced first for every domain; dialect-specific methods stay in the engines
  and are listed in the PR.
- One commit per domain, each followed by the full e2e parity run (Postgres direct, PgBouncer, PGLite) and the perf
  check (f). Existing 28 parity tests pass unchanged. Engine line targets are an outcome of the inventory, not a mandate.

**W4. Decompose the god functions (move-only commit, then behavior commit, per function).**
Priority order and cut line: sync, doctor, serve-http, cli are in; jobs, hybrid, autopilot are cut to wave 2 first if the
landing window slips.
- `sync.ts`: `SyncRun` state object replaces the 46 closure `let`s; phases (`preflight`, `deletes`, `renames`, `imports`,
  `finalize`) in `src/commands/sync/` take narrow typed inputs and return explicit outputs; mutable fields accessed only as
  `run.<field>` (no destructuring of mutable fields; source guard over `src/commands/sync/`); controlled-order tests for
  phase-await vs watchdog and phase-await vs timeout in both orders. `performFullSync` and `runSyncInner` (to
  `sync/args.ts`) also decomposed. Re-point `test/sync.test.ts` #132 and `test/redos-hardening.test.ts` per A10.
- `doctor.ts`: finish the peel into `src/commands/doctor/checks/*` grouped by `src/core/doctor-categories.ts`;
  `buildChecks` becomes an ordered `{name, run}` registry runner; `doctor-categories.ts` stays the single category
  authority and a registry test fails (FAIL/Why/Fix/See) when an entry is uncategorized. W0 goldens byte-identical.
- `serve-http.ts`: flat modules following the real existing convention `serve-http-<area>.ts` exporting
  `mount<Area>(app, requireAdmin, ...)` (extend the existing `serve-http-oauth.ts` and `serve-http-metrics.ts`; add
  `serve-http-admin-api.ts`, `serve-http-mcp.ts`, `serve-http-spa.ts`); the 415-line `/mcp` POST handler decomposed. E9: extend the existing `test/serve-http-admin-route-guard.test.ts` (keeps its existing
  6-entry allowlist unchanged; adds `/metrics` and `/admin/events` to the must-carry-`requireAdmin` scan set, never to the
  allowlist) to scan every `serve-http-*.ts` module, reporting module file:line;
  mutation test (dropping `requireAdmin` on one route in a moved module fails); anti-vacuity floor >= master count.
  Authenticated request-outcome tests for OAuth preflight/CORS order (`serve-http.ts:618`).
- `cli.ts`: one record per command `{name, load: () => import(...), selfHelp, thinClientRefused, skipStartupHooks,
  aliases}` replaces the 62-case switch AND derives the hand-synced `CLI_ONLY`, `CLI_ONLY_SELF_HELP`,
  `THIN_CLIENT_REFUSED_COMMANDS`, `STARTUP_HOOK_SKIP_COMMANDS` sets and alias table (the documented `pages` drift bug
  class). `load` stays a lazy dynamic import (cold-start budget). W0 golden: each derived set equals master's. `main`
  decomposed; thin-client refusal, help, and exit codes identical to A16b goldens. `scripts/generate-flag-registry.ts`
  re-targeted to read the table and the new command dirs; `cli-flag-registry.generated.ts`, `docs/TOOL_CATALOG.md` and
  the admin build byte-identical to master; synthetic new command verifies accepted flag, rejected unknown flag, and
  engine-free help.
- `jobs.ts` (cut-line): subcommand table; 24 handlers to one module each under `src/core/minions/handlers/`, same
  registration order; `registerBuiltinHandlers` stays exported from `src/commands/jobs.ts` for the supervisor.
- `hybrid.ts` (cut-line): named stages following `runPostFusionStages()`, including `hybridSearchCached`; A13 golden exact.
- `autopilot.ts` (cut-line): subcommand dispatch table.
- T3 (phase-named sync errors, `TODOS.md:5338`) deferred to the first follow-up so goldens stay byte-identical.

**W6. Landing and integration.**
- Landing window: triage or merge high-value open PRs that touch target files first (51 do today), announce the window,
  then freeze target paths from final review to merge.
- Continuous integration into the collector with a named owner for porting intervening upstream fixes into moved code;
  temporary forwarding exports where useful (CLAUDE.md "peeled facades keep their surface").
- E2 moved-symbol map (old `path:function` -> new `path:function`, generated from the AST) plus a short porting guide in
  the PR body and a pinned comment, for open-PR authors.
- E3 `scripts/verify-move-only.ts` + unit test proves each move-only commit preserves normalized tokens; results in PR.
- Rebase right before merge, re-run goldens and the full gate on the final candidate, and account explicitly for upstream
  behavior changes that landed during development.
- Land right after a release; rollback is `git revert` of the squash + PATCH release.

**W7. Contributor DX (from DX review; same PR).**
- CONTRIBUTING.md "Where does my change go?" table for the six change kinds (storage method, schema migration, doctor
  check, CLI-only command, HTTP route, sync phase): files to edit, registry, the one regenerate command, the smallest test,
  the pre-merge gate. Replaces "Add the case to `src/cli.ts`". Ops added to `core/ops/` keep their automatic CLI/MCP path.
- Placement decision table: `engine-sql/` (database domain SQL) vs `storage/` (blob storage) vs `persistence/`;
  `schema-migrations/` vs `commands/migrations/`; `commands/sync/` phases vs reusable `core/sync-*`; when to use
  `sql-query.ts` vs the engine-sql executor. One complete worked read/write example for engine-sql.
- Every new or re-pointed guard prints `FAIL: <file:line> <what>` / `Why:` / `Fix: <exact edit or command>` /
  `See: docs/TESTING.md#<anchor>`, fits in the verifier's last-30-lines output, has a TESTING.md subsection, a
  `guards-manifest.tsv` row, and bad/good fixtures. Each guard < 15 s; `bun run verify` grows < 20%.
- Path-consumer inventory in W0, before the first move: every script, workflow, test helper and doc that names a split file
  (35+, incl. `check-jsonb-pattern.sh`, `check-engine-dynamic-import.sh`, `select-e2e.ts` escape hatch,
  `e2e-test-map.ts`, `generate-flag-registry.ts` `facadeExpansion`) is re-pointed to the new dirs with a bad fixture
  inside each new dir; `select-e2e` maps `engine-sql/` to both engines' tests and keeps all-tests for schema-migrations.
- Snapshot consistency (lands with W3, not W7): one unit test discovers every `pglite-snapshot-*` cache-key occurrence
  dynamically (13 today: 5 in `e2e.yml`, 8 in `test.yml`), requires identical dependency-hash inputs while preserving the
  distinct default/legacy profile namespaces and artifact paths, covers every `computeSnapshotSchemaHash` input, and that the inputs cover the transitive imports of
  `schema-migrations/registry.generated.ts` and the generated schema; failure names the missing file and both places to add it.
- Public API: W0 export-surface golden (sorted runtime export names for every `package.json` exports subpath touched,
  plus `PGLiteEngine`/`PostgresEngine` prototype method names, plus a .d.ts snapshot) and an external consumer fixture
  importing through package names, typechecked against the candidate. Downstream users need zero import edits, zero new
  config, zero special commands. Every symbol exported by a façade or a `package.json` exports subpath stays importable from its old module
  (CLAUDE.md façade rule, unconditional). Internal per-engine peel modules merged into `engine-sql/` (their exports took
  engine-shaped deps no caller outside the engines used) are removed rather than stubbed; `docs/architecture/wave-1-moves.json`
  maps each removed symbol to its engine-sql replacement. `ScopedExecutor` and adapter types stay internal.
- Always-loaded docs rewritten in the same PR: CLAUDE.md (engine parity, migrations, `region-exempt`, peeled facades
  list), CONTRIBUTING (tree, "Adding a new engine"), `docs/ENGINES.md`, `docs/guides/rls-and-you.md`,
  `docs/architecture/infra-layer.md`, `KEY_FILES.md` + `key-files/*`; rg-sweep for retired phrases returns nothing;
  `build:llms`. Ceiling-raise rationale trimmed from TSV notes moves to `key-files/*` with a pointer.
- Porting kit committed (not just a PR comment): `docs/architecture/wave-1-moves.json` + markdown map (old symbol -> one
  or more destinations, facade vs implementation), one recipe per conflict kind (engine fix, migration, doctor check, CLI
  flag, sync closure), generated-file conflict commands, a copy-paste agent prompt, the named integration owner, freeze
  start/end, a hotfix lane (fix lands on master, owner ports within hours and reruns goldens), and who can lift the freeze.
  Linked from CONTRIBUTING, CLAUDE.md and KEY_FILES. Squash commit body carries the move summary; move-only commits carry
  `Move-Only: yes`.
- A10 loader reads carry `test-reads-source-ok[structural]` markers; `test-reads-source-smell` counts only decrease.
- Pre-merge timed dry-run: a fresh agent session with only CONTRIBUTING.md lands one change of each kind on a scratch
  branch; timings and wrong turns recorded in the PR; target <= 30 min each; wrong turns fixed in docs/guard text.
- Rollback: forward-fix is the primary path; follow-ups on moved paths are held for a 72-hour revert-clean window.
- +3-month re-measure adds: share of storage PRs editing both engine files, conflicts on target paths per merged PR,
  remaining baseline rows, median rebase-to-merge time.

**Engineering contracts (Eng review; binding on every workstream).**
- Executor lifetime (EO1): the engine-sql executor is resolved through a getter over `this.sql` / `this.db` on every call,
  never stored, because `transaction()` works by `Object.create(this)` with a swapped connection. Per-domain
  write-then-throw rollback test on both engines, plus `transactionDirect` under dual pool; a mutation that caches the
  executor must fail.
- Driver options (EO2, EO6, EO9): statements converted from tagged templates call `runUnsafe(conn, sql, params,
  { signal?, prepare: true, simple: false })` (the per-call flag is combined with the connection setting, so direct
  Postgres stays prepared and PgBouncer stays unprepared); statements that already used `unsafe`/`executeRaw` on master
  keep their existing preparation behavior; `executeRaw`/`executeRawDirect` public contract unchanged. Adapter bypasses
  `checkoutGauge` like tagged calls do today. Tests read `pg_prepared_statements` (non-empty on direct PG, none on
  PgBouncer), reject a zero-param multi-statement string, and pin a gauge snapshot golden.
- Result envelope (EO18): internal `{ rows, affectedRows }`; domain code never reads driver-specific `.count` /
  `.affectedRows`; tests for empty updates, conflict-skipped inserts and mixed batches.
- SQL text parity (EO8): W0 captures the SQL text of every Postgres method converted in W1; converted methods emit identical
  text modulo `$N` renumbering. New composition uses a minimal `sqlFragment` helper (text + values, automatic renumbering,
  no identifiers); literal `$<digit>` in composed strings is banned; existing vetted fragment builders that inline values
  (e.g. `sql-ranking.ts:405`) are allowlisted by name with reasons (EO17). Lists bind as `= ANY($n::type[])`, never expanded
  `IN ($1,...)`, so prepared-statement caches stay bounded.
- Dialect capabilities: the per-method inventory covers W1-core too, with a fourth class "identical SQL, different driver
  post-processing". Explicit capabilities for PGLite's <30,000 bind-parameter batching, `vector` vs `halfvec` cast probing,
  and Postgres transaction-scoped advisory locks, each gated by boundary-size and concurrent-write tests.
- RLS scope (EO4, supersedes the stricter A3 wording): W0 golden inventories each Postgres read method's scoping (23 scoped
  sites today); engine-sql read functions accept `ScopedRead` or `LegacyUnscopedRead` exactly matching master, so no
  new transactions or pool holds (#1794 class). Isolation tested with a non-owner `NOBYPASSRLS` role (pattern of
  `test/e2e/shared-skills-rls.test.ts`): cross-source denial, concurrent-request isolation, nested rollback restoration,
  connection reuse. Brand-key mentions outside the factory module and `as unknown as` near executor types are banned;
  `unscopedExecutor`/`LegacyUnscopedRead` imports restricted to doctor, maintenance, admin, migrations and engine-sql;
  no `core/ops/*` (MCP-facing) import. Widening scope is a TODO.
- Schema acceptance (EO3, EO12): E4 captures columns, defaults, indexes, constraints incl. CHECK text, triggers, functions
  (signature + body hash), views, policies, grants and RLS flags. Checked on all three init paths (fresh engine init,
  `db.initSchema()` bootstrap without the migration chain, upgrade replay) before and after migration replay, on a
  populated brain built by master (pinned PGLite data dir fixture), with repeat init a no-op, and at default dims, a
  high-dims config crossing the halfvec/index-policy branch, and a non-default FTS language. The generator emits the PGLite
  *template* (`pglite-schema.generated.ts`, placeholders and runtime policy hooks intact, `getPGLiteSchema(dims, model)`
  unchanged), executes TS fragment modules under Bun, runs the full chain (fragments -> schema.sql regions ->
  `schema-embedded.generated.ts` -> PGLite template) in fixed order, and the freshness guard regenerates the whole chain
  into a temp dir and diffs every output. Unknown constructs exit non-zero. Gates precede W2 and E1.
- Migrations (EO10, EO19): shared handler helpers and the module-level notice-suppression state move first to
  `schema-migrations/helpers.ts`; the `Migration` type to `schema-migrations/types.ts`; nothing under `schema-migrations/`
  imports `migrate.ts` (layering guard) to avoid ESM TDZ cycles; compiled-binary smoke runs apply-from-empty. Generated
  registry is `registry.generated.ts`. The golden hashes normalized AST source text of handler and `verify` bodies and
  referenced helpers (never `Function.toString()`, which coverage instrumentation changes). Replay from several
  checkpoints (v2, a pre-handler-heavy version, pre-forward-reference-bootstrap, LATEST-1) on both engines. CI rejects any
  migration added since merge-base whose version is not greater than the max on `origin/master` (out-of-order landing
  would be skipped forever). Tests for fresh-install notice suppression, upgrade notices, verify failure/retry.
- Snapshot hash (EO7): inputs are computed from the static import closure of the PGLite schema, migration registry,
  engine-sql bootstrap and `migrate.ts`, not a hand list; the test names the missing file.
- CLI lifecycle (EO5, EO13): records carry `phase` (pre/post engine connect) and `thinClient` (`none`, `refuse`,
  `route-then-refuse`); subcommand-aware routing, degraded-server recovery and teardown/drain (which excludes `serve`)
  stay an explicit ordered pipeline; every `load` is `() => import('<literal>')`; the alias-collision check runs over the
  derived table; master's known membership inconsistencies are preserved and listed. Tests record connect, remote-route,
  drain and disconnect calls for representative paths incl. failures and help, and engine-free commands (`status`,
  `db-repair`) with an unreachable DB match master's exit code and first line.
- serve-http (TE1): master route golden by AST; a move-only `buildServeHttpApp` extraction enables a runtime golden of the
  full ordered router stack including global `app.use` (CORS/preflight, body parsers, SPA fallback exclusions). `mount<Area>
  (app, ctx)` takes one shared context (session map, rate limiters, token caches); a limiter exhausted via one module is
  enforced on another. Gate the move with owner vs OAuth admin denial, session revocation / sign-out-everywhere, PKCE and
  refresh flows, wrong-audience rejection, `/mcp` dispatch receiving `remote: true` + `authInfo` + source scope, HTTP
  shutdown and IPC cleanup.
- Sync: one owner for checkpoint and cleanup state; controlled failures/interleavings for checkpoint writes (incl. watchdog
  during checkpoint write), worker completion, SIGTERM cleanup, bookmark advancement and full-sync fallback; assert durable
  state after restart, not just returned status.
- Doctor (EO11, TE4): entries `run(ctx) -> Check[] | STOP` with explicit `DoctorContext` and `emits[]`; ordered execution
  groups keep `--fix`-before-check, `--fast` and null-engine early stops; mode-matrix tests assert output and which probes
  or mutations ran.
- Tests (A10 refinement): classify each re-pointed source-text test by the invariant it protects; add cross-file mutation
  fixtures (e.g. wrapping the imports phase call in a transaction must fail `test/sync.test.ts`'s nested-transaction guard)
  plus bounded PGLite execution tests. `schema-bootstrap-coverage.test.ts` re-pointed to `engine-sql/bootstrap.ts` (EO22).
  Coverage-gate exemptions transfer with moved code (net shrink). Each W0 golden has a named normalizer, proven by
  capturing it twice on master and diffing to empty.
- Backends: `ci:ubicloud` does not run parity tests on PgBouncer today; add explicit backend parameterization (or matrix
  jobs) for E5 and migrated-domain tests with executed-test counts asserted per backend (PGLite, direct PG, PgBouncer),
  and set pooler prepare mode explicitly (Ubicloud pooler ports are not the 6543 auto-detect port). E5 runs on master via
  `executeRaw` first (EO20).
- Performance (EO14): numeric budgets and corpus/concurrency sizes fixed before implementation; add PGLite connect +
  initSchema cold start (snapshot on/off) and a non-compiled engine-connect cold start (<= +20 ms); a MAX_SEARCH_LIMIT
  `searchVector` case; normalizer compiled once per statement; name each warmed cache and assert the hard-disabled
  semantic result cache stays disabled; record provider and SQL round-trip counts next to latency.
- Scope of (b) and W5 (EO15): `src/**/*.ts` excluding `*.generated.ts`; test callbacks are not in scope.
- `executeRawJsonb` first param widened to `Pick<BrainEngine,'executeRaw'>` and reused (EO16); single definition.
- Move proofs (EO19, TE5): shared token normalizer with wrapper and rename-map modes; `Mechanical-Rename: yes` trailer for
  SyncRun-style rewrites.
- W1-extended starts only after the executor, E5, rollback, RLS inventory, prepare/protocol and SQL-text gates are green
  on W1-core.

**Docs.** Update `docs/architecture/KEY_FILES.md` and `key-files/*` (engines, doctor, sync, hybrid, minions, tooling),
ASCII diagram of store -> executor -> dialect adapter, fix `doctor-categories.ts` path references, `build:llms` after
doc edits. Generic placeholders only in public artifacts.

### Verification

`bun run verify`; `bun run ci:ubicloud` full gate (unit + E2E on Postgres, PGLite, PgBouncer); W0 goldens byte-identical
on the final rebased candidate; perf budgets (f) met; compiled-binary guards (`check-compile-autoload.sh`,
`check-pglite-embedded.sh`, `check-cli-executable.sh`) green; zero deleted or loosened assertions.

### NOT in scope

- D1: the ~60 other >300-line functions outside touched files (`runCycle` 1,227, `applyHarness` 1,167,
  `runPhaseSynthesizeInner` 1,043, `runImport` 956, `importFromContent` 910, `makeSubagentHandler` 884, `runConfig` 834).
  W5 freezes them; wave 2.
- D2: `src/core/` directory regroup; `ai/gateway.ts` provider adapters; cycle/extract/embed/import-file/init.
- Engine table-set reconciliation (a real schema change).
- Rejected: cyclomatic-complexity guard; a feature flag toggling store vs legacy SQL; an ORM/query builder; renumbering
  migrations to close version gaps.


<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|-----------|-----------|----------|
| 1 | CEO | Mode SELECTIVE EXPANSION | Mechanical | override | autoplan rule | HOLD/REDUCTION |
| 2 | CEO | Correct plan facts (71 vs 75 tables, 170 migrations, 51 open PRs, 77 long fns) | Mechanical | P1 | verified by AST/runtime import | original figures |
| 3 | CEO | Add W0 goldens + E5 contract test before any move | Mechanical | P1 | all three voices: SQL-text parity is not behavior parity | move-first |
| 4 | CEO | RLS-branded ScopedExecutor (A3) | Mechanical | P1 | silent RLS loss is a critical gap | untyped executor |
| 5 | CEO | Honor resolvePrepare / runUnsafe / signal / gauge (A4) | Mechanical | P1 | unsafe() defaults prepare:false; perf regression | generic unsafe |
| 6 | CEO | W2 = text generation with identical end state; cut table reconciliation | Mechanical | P1/P5 | both outside voices: reconciliation is a schema change | reconcile tables |
| 7 | CEO | T1 include schema.sql fragment generation | Taste | P1 | otherwise two copies remain | defer |
| 8 | CEO | T2 flat serve-http route files | Taste | P5 | existing convention | new dir |
| 9 | CEO | T3 defer phase-named sync errors | Taste | P5 | keep goldens byte-identical | include |
| 10 | CEO | Migrations golden covers handlers/sqlFor/flags (A11) | Mechanical | P1 | all voices | SQL hash only |
| 11 | CEO | Snapshot hash + CI cache keys cover new files (A6) | Mechanical | P1 | stale-snapshot green CI | none |
| 12 | CEO | Generated registry + collision failure for W3 | Mechanical | P4/P1 | Codex: allocation unresolved | hand list |
| 13 | CEO | Function-size guard with 77-row baseline + justification column | Mechanical | P1 | Codex: ceilings get raised silently | size-only |
| 14 | CEO | Metric (a) restated + SQL-in-engine guard (A12) | Mechanical | P1 | Claude voice: delegation stubs keep 2-file tax measurable | stub-only |
| 15 | CEO | Test re-point policy via shared loaders (A10) | Mechanical | P1 | prior peels stalled on 133 source-text tests | ad hoc |
| 16 | CEO | Outcome baseline (e) + perf budgets (f) | Mechanical | P1 | both voices | proxy metric only |
| 17 | CEO | Landing window, E2 map, porting guide, rebase-before-merge (W6) | Mechanical | P1/P6 | 51 open PRs | move-only only |
| 18 | CEO | E1 single forward-reference bootstrap | Mechanical | P2 | same parity class, in radius | leave duplicated |
| 19 | CEO | E3 move-only verifier; E9 admin-auth invariant | Mechanical | P2 | cheap, security | none |
| 20 | CEO | W1 breadth | User Challenge -> owner chose all 12 domains (2026-09-30) | owner | core first, extended after core gates are green | inventory-gated extended |
| 21 | CEO | Keep W4 with priority order + cut line | Taste | P1/P2 | Codex: defer unrelated cleanups; Claude/primary: keep | defer all W4 |
| 22 | CEO | Defer D1 (other 60 long fns), D2 (core regroup, gateway) | Mechanical | P3 | outside radius | include |
| 23 | CEO | Reject complexity guard, feature flag, ORM, migration renumber | Mechanical | P5 | YAGNI / breaks history | include |
| 24 | DX | Rename dirs: engine-sql/, schema-migrations/ | Taste | P5 | collisions with storage/, commands/migrations/ | store/, migrations/ |
| 25 | DX | serve-http-<area>.ts + mount<Area> (real convention) | Mechanical | P5 | CEO T2 names did not match repo | -routes.ts names |
| 26 | DX | CLI record table derives all membership sets; lazy load | Mechanical | P1/P4 | documented pages drift bug; cold start | name->handler only |
| 27 | DX | Re-target generate-flag-registry; zero-diff generated outputs | Mechanical | P1 | both voices: generator parses the switch | unspecified |
| 28 | DX | new:migration scaffold + collision recovery (3 cases) | Taste | P5/P1 | 1 step -> 3 steps otherwise | manual |
| 29 | DX | FAIL/Why/Fix/See contract for every guard | Mechanical | P1 | only W5 had failure text | per-guard ad hoc |
| 30 | DX | (b) one-time acceptance; W5 ratchet is the only permanent rule | Mechanical | P5 | avoids tax on unrelated fixes | permanent touched-file rule |
| 31 | DX | Engine-sql ratchet over all methods + marker | Taste | P1 | new methods cannot add duplicate SQL | migrated-only guard |
| 32 | DX | Export-surface golden + consumer fixture; facades unconditional | Mechanical | P1 | CLAUDE.md facade rule | "where useful" |
| 33 | DX | unscopedExecutor(reason) + cast ban | Mechanical | P5 | legit unscoped reads exist | casts |
| 34 | DX | Path-consumer inventory; guards cover new dirs | Mechanical | P1 | 35+ scripts hardcode moved paths | none |
| 35 | DX | 11 cache keys consistency test | Mechanical | P1 | plan named 2 of 11 | 2 keys |
| 36 | DX | Extend existing admin-route guard (7-entry allowlist) | Mechanical | P4 | E9 already exists | new guard |
| 37 | DX | Always-loaded docs + committed porting kit + hotfix lane | Mechanical | P1 | agents follow CLAUDE.md literally | KEY_FILES only |
| 38 | DX | Timed pre-merge dry-run, target <= 30 min | Taste | P1 | measure, not estimate | none |
| 39 | DX | Forward-fix primary rollback; 72h revert-clean window | Mechanical | P6 | revert breaks after follow-ups | revert only |
| 40 | Eng | Executor via per-call getter; rollback test (EO1) | Mechanical | P1 | tx = Object.create(this); silent commit outside tx | cached executor |
| 41 | Eng | prepare:true + simple:false for converted statements | Taste | P5 | Claude vs Codex reconciled | per-call resolvePrepare |
| 42 | Eng | {rows, affectedRows} envelope | Mechanical | P1 | Codex: count metadata lost | rows only |
| 43 | Eng | Preserve master RLS scoping per method (TE3) | Taste | P5 | behavior-preserving; #1794 pool holds | scope all reads |
| 44 | Eng | NOBYPASSRLS isolation tests | Mechanical | P1 | superuser proves nothing | current_setting check |
| 45 | Eng | E4 covers policies/grants/RLS, 3 init paths, upgrade replay, 3 configs | Mechanical | P1 | fresh-install parity insufficient | fresh only |
| 46 | Eng | Generator emits PGLite template; full chain freshness | Mechanical | P5 | runtime policy hooks | static text |
| 47 | Eng | schema-migrations never imports migrate.ts; helpers leaf | Mechanical | P1 | ESM TDZ cycle | direct import |
| 48 | Eng | AST-hash handlers, not toString | Mechanical | P1 | coverage instrumentation | toString |
| 49 | Eng | Monotonic migration version CI check | Mechanical | P1 | out-of-order skip forever | duplicate-only check |
| 50 | Eng | Fix E9 wording (must-guard, not allowlist) | Mechanical | P1 | would exempt guarded routes | as written |
| 51 | Eng | CLI phase/thinClient + lifecycle recording tests | Mechanical | P1 | DB-down commands would connect | flat record |
| 52 | Eng | serve-http shared ctx + auth-context outcome tests | Mechanical | P1 | prior refactor dropped auth context | route snapshot only |
| 53 | Eng | Sync checkpoint durability + restart tests | Mechanical | P1 | finalization races | phase-order tests only |
| 54 | Eng | Explicit PgBouncer backend matrix in CI | Mechanical | P1 | ci:ubicloud does not run parity on PgBouncer | assume covered |
| 55 | Eng | 13 cache keys, two profiles, dynamic discovery | Mechanical | P1 | forcing identical restores wrong artifact | 11 identical |
| 56 | Eng | sqlFragment for new composition; vetted builders allowlisted (TE6) | Taste | P5 | renumbering bugs vs existing builders | hand $n / constant-only |
| 57 | Eng | (b) and W5 scoped to src/ (EO15) | Mechanical | P3 | test callbacks 400-700 lines | all touched files |
| 58 | Eng | Invariant-based test re-points + cross-file mutation fixtures | Mechanical | P1 | position re-point can hide regressions | containment/positional only |
| 59 | Eng | Doctor Check[]|STOP registry + mode matrix (TE4) | Taste | P5 | --fix/--fast ordering | category grouping |
| 60 | Eng | Route golden: AST on master, runtime after buildServeHttpApp extract (TE1) | Taste | P3 | no app handle pre-split | test seam on master |
