# Eng Review (Phase 3, primary voice): GBrain Refactor Wave 1

- Target: `~/.gstack/projects/garrytan-gbrain/autoplan-eng-M2VyUI/eng-implementation.md` (plan already amended by CEO and DX phases).
- Baseline: `garrytan/gbrain` master @ `608a174dc` (v0.60.10.0), clean tree. Read-only review: nothing in the repo was modified.
- Methodology: gstack `/plan-eng-review` (full file read, 2,256 lines), executed at full depth with the autoplan overrides:
  skipped Preamble, Scope gate, AskUserQuestion format, Completeness Principle, Search Before Building, Completion Status,
  Telemetry, base-branch detection, Readiness Dashboard, Plan File Review Report, Prerequisite Skill Offer, Outside Voice.
  No questions asked; every issue auto-decided with the 6 principles (P1 completeness, P2 boil lakes, P3 pragmatic, P4 DRY,
  P5 explicit over clever, P6 bias to action). Eng tiebreak: P5 + P3. Scope never reduced.
- Prior phases (accepted, not re-litigated): CEO `ceo-primary.md` (A1-A19, E1-E5, E9, T1 include, T2 flat, T3 defer, UC1 pending),
  DX `dx-primary.md` (D1-D37, O1-O20).
- Owner constraints honored: ONE integrated PR, PATCH release, generic placeholders only in public artifacts.
- Evidence: every finding below quotes the code line it rests on (file:line at 608a174). Function sizes re-measured with a TS AST
  scan (`~/.capy/work/refactor/scratch/fnsize.ts`); import-graph reachability with a static relative-import walk.

Verdict in two sentences: the amended plan is buildable and the workstream order is right, but five engineering facts the CEO
and DX phases did not see would make W1/W2/W4 silently wrong: the engine transaction clone (an executor cached on the engine
escapes `transaction()`), RLS scoping that the W1-core domains never had, every existing PGLite brain replaying the regenerated
schema blob on its next boot, a CLI command table that loses the pre-connect dispatch phase, and a goal (b) that drags ~133
re-pointed test files into mandatory decomposition. All five are closed below by concrete obligations with tests; two are
CRITICAL GAPs in the plan as written.

---

## Step 0: Scope Challenge

### A. Assess the target

#### What already solves each sub-problem (read in code, not assumed)

| Sub-problem | Existing code (608a174) | Evidence | How the plan should use it |
|---|---|---|---|
| Cross-engine positional executor | `sqlQueryForEngine`, `executeRawJsonb`, `SqlValue` | `src/core/sql-query.ts:17-41,111-143` | Keep the scalar-only tag untouched. `executeRawJsonb(engine: BrainEngine, ...)` takes an engine, so "reuse" requires widening its first parameter to `Pick<BrainEngine,'executeRaw'>` (structural; all 18 callers unchanged). |
| Postgres raw path with cancellation | `runUnsafe(conn, sql, params, {signal})` -> `conn.unsafe(sql, params, { cancelFence: !!signal })` | `postgres-engine.ts:5340-5376` | The Postgres adapter calls `runUnsafe` directly (no `checkoutGauge`, see CQ6) with an added `{prepare: true, simple: false}` pass-through. |
| Prepared-statement policy | Resolved once per pool: `const prepare = db.resolvePrepare(url)` at `postgres-engine.ts:331`; postgres.js ANDs the per-call option with it: `q.prepare = options.prepare && ('prepare' in q.options ? q.options.prepare : true)` | `vendor/postgres/src/connection.js:238`; `unsafe()` defaults `prepare: false, simple: args.length === 0` at `vendor/postgres/src/index.js:119-125` | Per-call `resolvePrepare(url)` (CEO A4 wording) is unnecessary: pass `prepare: true` always and the connection option gates it. |
| RLS scope binding | `withScopedReadTransaction(sourceIds, sourceId, cb, {alwaysTransaction})`: flag off returns `callback(this.sql)`; flag on opens `this.transaction` and `set_config('app.scopes', ...)` | `postgres-engine.ts:281-312`; 23 call sites; pinned by `test/postgres-engine-rls-scope.test.ts` (fake sql, #1794 no per-read pool hold) | Scoping status must be preserved per method (AR2). |
| Transaction clone | `const txEngine = Object.create(this); Object.defineProperty(txEngine, 'sql', { get: () => tx })` | `postgres-engine.ts:585-588`; PGLite `Object.defineProperty(txEngine, 'db', { get: () => tx })` at `pglite-engine.ts:1725` | The executor must be resolved through the same getter on every call (AR1). Existing peeled deps already do this: `return { get sql() { return self.sql; } }` at `postgres-engine.ts:5566-5569`. |
| Per-domain peeled modules | `src/core/{pglite,postgres}-engine/{facts,takes,salience,code-edges,cjk-search}.ts` (5,058 lines total with the other modules) | `ls`; narrow deps interfaces e.g. `PgSalienceDeps { readonly sql }` | W1-core converts these pairs into one `engine-sql/<domain>.ts`. |
| Shared SQL fragment builders | `pageReadFilter`, `buildRecencyComponentSql`, `privatePagesFilterFragment`, `currentCodeEdgeFilter`, `buildCJKKeywordSql` | `search/sql-ranking.ts:381-406` inlines LIKE literals and numeric coefficients; `postgres-engine/takes.ts:303`; `code-edges.ts:99` | These are the vetted builder registry for A2b (CQ3). |
| Migrations | `MIGRATIONS` array `migrate.ts:196-6780`; module-private `interface Migration` (`:61`, not exported); private helpers `migrationNotice` (`:43`, 4 uses in the array), `dropInvalidConcurrentIndex` (`:170`, 16 uses), module state `quietMigrationNotices` (`:39`) | `sed`/`grep` counts | Helpers move to a leaf module (SC2); the type moves to `schema-migrations/types.ts` (SC1). |
| Schema text | `build-schema.sh` (sed of `src/schema.sql` into `schema-embedded.generated.ts`); `getPGLiteSchema(dims, model)` applies `applyChunkEmbeddingIndexPolicy`, `applyFtsLanguagePolicy`, `__EMBEDDING_DIMS__/__EMBEDDING_MODEL__` at runtime | `scripts/build-schema.sh:1-18`; `pglite-schema.ts:1297-1312` | The generator output stays a template with runtime policy (SC20). |
| Schema replay on every boot | PGLite `initSchema`: `applyForwardReferenceBootstrap()`, `db.exec(getPGLiteSchema(dims, model))`, `runMigrations(this)` | `pglite-engine.ts:1042-1070` | Every existing PGLite brain replays the regenerated blob on first boot after upgrade (AR3). |
| Bootstrap callers | `PostgresEngine.initSchema`, `db.ts:initSchema` (`applyPostgresForwardReferenceBootstrap(conn); await conn.unsafe(SCHEMA_SQL)` at `db.ts:369-371`), PGLite `applyForwardReferenceBootstrap` (`pglite-engine.ts:1100-1703`) | read | E1's single bootstrap must accept a raw executor for the `db.ts` caller. |
| Snapshot hash | `computeSnapshotSchemaHash` hard list of 31 files; does NOT include `pglite-engine.ts` (where the PGLite bootstrap lives) | `pglite-engine.ts:334-366`; the 11 CI keys DO include `src/core/pglite-engine.ts` (`e2e.yml:71`) | Derive inputs from the import closure (AR7). |
| Schema end-state gate | `test/e2e/schema-drift.test.ts` + `test/helpers/schema-diff.ts` (columns by name, `ORDER BY table_name, ordinal_position` but diff by name) | `schema-diff.ts:59-62,224,291` | E4 extends; add ordinal for PGLite master-vs-branch (T-G13). |
| Forward-reference coverage | `test/schema-bootstrap-coverage.test.ts` parser-driven checks over both blobs + `REQUIRED_BOOTSTRAP_COVERAGE`; reads `POSTGRES_BOOTSTRAP_PATH = 'src/core/postgres-engine/forward-reference-bootstrap.ts'` (`:52`) | read | Must be re-pointed by E1 (CEO wrote "unchanged"; impossible because it reads the moved path). |
| Doctor | `buildChecks` `doctor.ts:662-4105`: shared `let schemaVersion` (`:2017`), early `return checks` (`:1850`, `:1886`), 235 pushes incl. loops; `test/helpers/doctor-source.ts` containment vs positional loaders | read | Registry entries return `Check[] | STOP` with an explicit context (CQ4). |
| CLI | `handleCliOnly` `cli.ts:2095-3609`: ~69 `if (command === ...)` branches (most dispatched before the generic `connectEngine()` terminator at `cli.ts:3012`, several opening their own connection with `probeOnly` or a timeout), then `switch (command)` at `:3074` (62 cases); thin-client pre-guard `cli.ts:2103` (`THIN_CLIENT_REFUSED_COMMANDS.has(command) || command === 'cache' || command === 'quarantine'`); subcommand routing `cli.ts:2113` | read | Table records need `phase` and a thin-client mode (AR5). |
| Flag registry generator | `generate-flag-registry.ts:257` segments on `^[ \t]*if \(\s*command === '...'` and `^      case '...':`; `facadeExpansion()` `:113` | read | Re-target to the table in the same commit (DX O6). |
| serve-http | `runServeHttp` `serve-http.ts:858-3108`, `function requireAdmin` declared inside it (`:1435`), 44 `app.*` registrations, no app-returning seam | read | Route golden cannot be runtime on master (AR6). |
| Admin route guard | `test/serve-http-admin-route-guard.test.ts` (structural, 7-entry allowlist) | exists | Extend (DX D32). |
| Module-size ratchet | `check-module-size.sh:46-57` `measure_region_exempt`; migrate row ceiling 722 `region-exempt` | read | Drop policy in W3. |
| Generated-file convention | `build-schema.sh:3-4`: "`.generated.ts` suffix: module-size ratchet + other source-file guards exempt generated files by that naming convention" | read | Name the migrations registry `registry.generated.ts` (SC3). |
| E2E selection | `select-e2e.ts:63-92` escape hatches (`src/core/migrate.ts`); `e2e-test-map.ts:252-346` engine and per-domain rows | read | Add `engine-sql/**` and `schema-migrations/**` (DX O16). |
| Scanner guards naming moved paths | `check-jsonb-pattern.sh:53` (`src/core/migrate.ts` in the max_stalled schema scan); `check-engine-dynamic-import.sh:26-33` (engines + migrate + peeled dirs); `check-jsonb-params.mjs:45` scans all `src` (covers engine-sql automatically) | read | Extend the first two; the third needs no change. |

#### Minimum changes that achieve the goal

The goal is five behaviors: one SQL copy per migrated domain, one schema DDL copy, one file per migration, no god functions in
touched src files, and a ratchet. Every workstream is needed for at least one of them; the only deferrable work is already on
the plan's cut line (jobs, hybrid, autopilot) and UC1's W1-extended. Per P2 nothing is cut here.

#### Complexity check (counted, labelled estimates)

| Kind | Count | Basis |
|---|---|---|
| New src files | ~210-240 | 170 migration files + registry + helpers + types (W3); engine-sql executor + 2 adapters + normalizer + 5 core domains + bootstrap (~10, up to ~17 with W1-extended); sync phases ~6; doctor check modules ~10-20 (finishing peel); serve-http 3 new modules; CLI table + command modules ~5-10 |
| New scripts/guards | 6 | `check-function-size.ts`, engine-sql ratchet, engine-sql dynamic-SQL scanner, schema freshness, migrations registry generator/freshness, `verify-move-only.ts` |
| Changed existing files | ~200+ | 2 engines, migrate.ts, schema.sql, pglite-schema.ts (deleted -> generated), doctor.ts, sync.ts, serve-http.ts + 2 modules, cli.ts, jobs.ts, hybrid.ts, autopilot.ts, ~133 source-reading tests, 11 workflow cache keys, ~35 path consumers, ~12 docs |
| New classes/services | 4+ | engine-sql executor, schema generator, migration registry generator, doctor registry runner, CLI command table, SyncRun |

This trips the 8-file / 2-service gate. Under autoplan the gate is auto-decided: no feature cuts (P2, owner's one-PR rule), and
the structure question resolves to **Original arrangement** with three naming/placement corrections that keep every contract
(SC1, SC2, SC3). Scope record: `feature answers: none (autoplan, P2); structure: A Original arrangement (auto); accepted
scope: amended plan as written + Eng obligations EO1-EO22; pending remedies: none (UC1 is the owner's, not an Eng remedy)`.

#### Search check

Skipped per the autoplan override (Search Before Building). Layer labels applied from in-distribution knowledge: raw SQL with
positional params behind a thin dialect adapter is **[Layer 1]** (same shape as Kysely dialect adapters without the builder);
generated static-import registries with freshness guards are **[Layer 1]** in this repo (`check-tool-catalog-fresh.sh`);
branded types for capability-scoped handles are **[Layer 1]** TypeScript practice. No **[EUREKA]**.

#### TODOS cross-reference

- Closes when its workstream lands: `TODOS.md:1868` (3-way schema parity; W2+E4), `:1956` (Wave 4a sync), `:1962` (Wave 4b doctor
  hoist), `:~1976` (migrate-runner extraction), `:~4445` (TODO-V19-C doctor registry).
- Interacts: `TODOS.md` "Test-audit follow-ups (filed 2026-09-29)" item "Extract a testable autopilot tick function, then retire
  the 8 autopilot wiring greps": if autopilot stays on the cut line, leave it; if it lands, do the extraction the TODO names in the
  same commit instead of re-pointing 8 grep files twice.
- Interacts: same section, "`gbrain auth rescope-client ... --dry-run` fail with unknown flag" (flag-registry generator drops
  `--dry-run` for `auth`). DX O6 requires the regenerated registry to be byte-identical, which deliberately preserves this bug.
  Correct for a behavior-preserving PR; do not fix it here, do not let the generator rewrite "fix" it silently.
- Deferred D3 (T3 phase-named sync errors, `TODOS.md:5338`) stays deferred.

#### Distribution check

No new artifact is published. Compiled binary must keep bundling: 170 migration modules (static imports only), engine-sql modules
(static), command modules (lazy but with string-literal specifiers, AR8). Existing gates: `check-compile-autoload.sh`,
`check-pglite-embedded.sh`, `check-cli-executable.sh`. The dominant install path `bun install -g github:garrytan/gbrain` runs
source, so module count does affect engine-connect cold start (PF3).

### C. Scope Challenge findings

| # | Sev | Conf | Evidence (quoted) | Finding | Disposition |
|---|---|---|---|---|---|
| SC1 | P1 | 9 | `migrate.ts:61` `interface Migration {` (no `export`) | Plan says migrate.ts "keeps re-exporting `MIGRATIONS`, `LATEST_VERSION`, `Migration`"; `Migration` is not exported today, and 170 files now need it. | Accepted: move to `src/core/schema-migrations/types.ts`; migrate.ts `export type { Migration }` (type-only; runtime export golden unchanged, .d.ts snapshot gains one type, recorded as intended). |
| SC2 | P1 | 8 | `migrate.ts:43` `function migrationNotice(line: string)`; `:39` `let quietMigrationNotices = false;`; `:170` `async function dropInvalidConcurrentIndex(` (16 uses inside the array) | Moved handlers importing these from migrate.ts create a `migrate.ts -> registry -> vNNN -> migrate.ts` cycle; a future top-level `const` reference hits TDZ at module load, including in the compiled binary. | Accepted: leaf `schema-migrations/helpers.ts` owns both helpers and the quiet flag (setter called by the runner); a test asserts no file under `schema-migrations/` imports `migrate.ts`. |
| SC3 | P2 | 8 | `build-schema.sh:3-4` "`.generated.ts` suffix: module-size ratchet + other source-file guards exempt generated files" | Plan names the generated registry `schema-migrations/index.ts`. | Accepted: `src/core/schema-migrations/registry.generated.ts`, marked in `.gitattributes` `linguist-generated`. |
| SC4 | P1 | 9 | AST scan: `test/doctor.test.ts` anonymous callback 724 lines (17-740); `test/sync.test.ts` 414 lines (408-821) | Goal (b) "any file touched by this PR" includes ~133 re-pointed test files whose `describe` callbacks exceed 300 lines, forcing test restructuring that risks the zero-loosened-assertion rule. | Accepted: goal (b) and the W5 guard scope = `src/**/*.ts` minus `*.generated.ts`; tests and scripts excluded, stated in the guard's TESTING.md section. |
| SC5 | P1 | 9 | `index.js:119-125` `prepare: false, ...options, simple: 'simple' in options ? options.simple : args.length === 0`; `connection.js:238` | CEO A4 "passes `{prepare}` from `db.resolvePrepare(url)`" is over-specified and can diverge from the pool actually used (instance pool, dual-pool ddl, tx clone). Zero-arg converted queries would silently switch to the simple protocol (unprepared, multi-statement allowed). | Accepted: adapter always passes `{prepare: true, simple: false}`; connection option gates prepare; contract test T-G4. |
| SC6 | P1 | 9 | `postgres-engine.ts:5566-5569` `return { get sql() { return self.sql; } };` (salience), same for facts `:4361-4366`; zero `withScoped` hits in `postgres-engine/*.ts`; cjk-search runs inside `withScopedReadTransaction` at `:1923` | A3 "store read functions accept only a branded `ScopedExecutor`" would newly wrap 4 domains' reads (behavior change with the flag on: BEGIN + set_config + pool hold per read, the #1794 class) or force `unscopedExecutor()` everywhere (vacuous brand). | Accepted (AR2): preserve master's per-method scoping status exactly; W0 inventory golden; extending scoping is a TODO. |
| SC7 | P1 | 9 | `postgres-engine.ts:585-588` `const txEngine = Object.create(this) as PostgresEngine; ... Object.defineProperty(txEngine, 'sql', { get: () => tx });` | An executor stored on the engine instance at connect time is inherited by `txEngine` and still bound to the pool: writes inside `engine.transaction()` commit outside it. Silent atomicity loss. Not raised by CEO or DX. | Accepted (AR1): CRITICAL GAP closed by EO1. |
| SC8 | P2 | 9 | `sql-query.ts:118` `export async function executeRawJsonb<R>(engine: BrainEngine, ...)` | Cannot be reused on a scoped tx handle as written. | Accepted: widen to `Pick<BrainEngine,'executeRaw'>`. |
| SC9 | P2 | 8 | `postgres-engine.ts:5388` `this.checkoutGauge.acquire('raw');` in `executeRaw`; tagged sites call `sql\`...\`` with no gauge | Routing converted sites through `executeRaw` inflates the `raw` gauge that doctor pool checks read. | Accepted (CQ6). |
| SC10 | P1 | 9 | `sql-ranking.ts:405` ``branches.push(`WHEN ${slugColumn} LIKE ${literal} THEN ${c} * ${h}.0 / (${h}.0 + ${daysOldSql})`)``; `postgres-engine/facts.ts:489` ``ORDER BY embedding <=> ${sql.unsafe(`'${lit}'::vector`)}`` | A2b "only identifiers/ordering from constant allowlists may be concatenated" rejects the existing vetted builders; complying would rewrite them and change SQL text and plans. | Accepted (CQ3). |
| SC11 | P1 | 8 | `cli.ts:3012` generic `engine = await connectEngine(...)` terminator after ~900 lines of pre-connect `if (command === ...)` branches; `cli.ts:2103` thin-client pre-guard incl. `cache`/`quarantine`; `cli.ts:2113` subcommand routing | Plan's record `{name, load, selfHelp, thinClientRefused, skipStartupHooks, aliases}` cannot express pre-connect vs post-connect dispatch or route-then-refuse. Engine-free commands (`status`, `db-repair` must answer with the DB down) would silently start connecting. | Accepted (AR5). |
| SC12 | P1 | 8 | `serve-http.ts:858` `export async function runServeHttp(engine, options)` builds and listens; `requireAdmin` declared inside at `:1435` | W0 "route table with per-route ordered middleware" captured on master cannot be runtime introspection (no app handle). | Accepted (AR6): AST golden on master, runtime golden after a move-only extraction; both must agree. |
| SC13 | P1 | 9 | `pglite-engine.ts:1066-1069` `await this.applyForwardReferenceBootstrap(); await this.db.exec(getPGLiteSchema(dims, model)); ... await runMigrations(this);` | E4 proves fresh-install equality only. Every existing PGLite brain replays the regenerated blob on its next boot. | Accepted (AR3): CRITICAL GAP closed by EO3. |
| SC14 | P1 | 8 | `pglite-engine.ts:347-356` hash list lacks `pglite-engine.ts`; CI keys include it | Moving the bootstrap to `engine-sql/` leaves it covered by neither; plan's A6 lists only migrations and generated schema. | Accepted (AR7). |
| SC15 | P2 | 8 | A11 "handler source-text hash"; moving `handler: async (engine) => {...}` from array indentation to a top-level const re-indents the body; `Function.prototype.toString` preserves whitespace | Golden fails on a correct move, inviting someone to regenerate it and lose the proof. | Accepted: hash the whitespace-normalized token stream (shared normalizer with E3). |
| SC16 | P2 | 8 | E3 "normalized token multisets preserved"; W3 turns `{ version: 2, ... },` into `export const v002: Migration = { version: 2, ... };` | Every W3 file fails a naive move-only check. SyncRun conversion (`foo` -> `run.foo`) is not move-only at all. | Accepted (CQ7): wrapper mode + rename-map mode; SyncRun commits carry `Mechanical-Rename: yes`, not `Move-Only: yes`. |
| SC17 | P2 | 8 | `doctor.ts:2017` `let schemaVersion = 0;` read by later checks; `:1850`/`:1886` `return checks;` | `{name, run}` entries that each return one Check cannot express shared state, multi-push loops or early stop. | Accepted (CQ4). |
| SC18 | P2 | 7 | Plan W7 lists the path-consumer inventory "before the first move" and the 11-key snapshot test, but W7 lands last | Intermediate commits (each gated by the full parity run per W1 rule) would run with guards scanning empty files and stale cache keys. | Accepted: inventory + scanner re-point in W0; snapshot test lands with W3 (ordering fix, AR9). |
| SC19 | P2 | 8 | E5 "green on both engines before any W1 conversion"; executor does not exist on master | Ambiguous what E5 runs against on master. | Accepted: on master E5 drives `engine.executeRaw` (the same `unsafe()` path); after C10 the same table runs against the executor adapters. |
| SC20 | P2 | 8 | `pglite-schema.ts:1305-1309` runtime `applyFtsLanguagePolicy(applyChunkEmbeddingIndexPolicy(TEMPLATE, dims)).replace(/__EMBEDDING_DIMS__/g, ...)`; blob interpolates TS fragments (`${PAGE_STATE_SCHEMA_SQL}` etc.) | The generator must evaluate TS fragment modules (so `build:schema` becomes a Bun TS script, not sed) and emit a template, not a finished string. | Accepted: `scripts/build-schema.ts` (the `.sh` becomes a one-line wrapper to keep `build:schema` stable); generated PGLite output keeps placeholders; `getPGLiteSchema` signature unchanged. |
| SC21 | P3 | 8 | Import walk from `src/cli.ts`: 555 modules, `migrate.ts` not reachable | 170 migration files do not touch `gbrain --version`; they do load on every engine connect for source installs. | Accepted (PF3). |
| SC22 | P3 | 7 | `TODOS.md` test-audit item on `auth --dry-run` | Byte-identical flag registry preserves a known bug. | Noted, no change. |

Scope Challenge result: **scope accepted as-is** (MODE: FULL_REVIEW). 22 findings, all accepted as amendments; none reduce scope.

---

## Section 1: Architecture review

### Component graph after the amended plan (new components in `[ ]`, existing in plain text)

```
                              ENTRY POINTS
   src/cli.ts main()                                   src/commands/serve-http.ts runServeHttp()
     |  [CLI_COMMANDS table: name, phase,                 |  [buildServeHttpApp(engine, opts)]  (move-only extract, AR6)
     |   thinClient, selfHelp, skipHooks,                 |    app.use order (cookie, CORS gates, metrics, json)
     |   aliases, load: () => import('lit')]              |    mountOAuth ........ serve-http-oauth.ts (existing, extended)
     |  derives CLI_ONLY / CLI_ONLY_SELF_HELP /           |    [mountAdminApi] ... [serve-http-admin-api.ts] (requireAdmin passed in)
     |  THIN_CLIENT_REFUSED / STARTUP_HOOK_SKIP           |    mountMetrics ...... serve-http-metrics.ts (existing, extended)
     |  pre-connect branch -> load().run(args)            |    [mountSpa] ........ [serve-http-spa.ts] (/admin static + {*path})
     |  connectEngine() terminator                        |    [mountMcp] ........ [serve-http-mcp.ts] (/mcp GET/POST, 415-line handler split)
     |  post-connect -> load().run(engine,args)           |
     v                                                    v
   scripts/generate-flag-registry.ts  <--reads-- CLI_COMMANDS table (+ facadeExpansion: commands/sync/, doctor/)
                                                          |
   src/commands/doctor.ts buildChecks()                   |       src/commands/sync.ts performSync()
     -> [DOCTOR_REGISTRY: ordered {name, run(ctx)}]       |         -> [SyncRun state] -> [commands/sync/{preflight,deletes,
        run returns Check[] | STOP; category from         |             renames,imports,finalize,args}.ts]
        doctor-categories.ts categorizeCheck()            |            phases read/write run.<field> only
                                                          v
                     src/core/operations.ts (unchanged contract) ---> BrainEngine interface (engine.ts, unchanged surface)
                                                          |
                 +----------------------------------------+----------------------------------------+
                 |                                                                                 |
     PGLiteEngine (facade)                                                          PostgresEngine (facade)
       get db() / tx clone getter                                                     get sql() / tx clone getter
       one-line delegations for migrated domains                                      withScopedReadTransaction (RLS)
       dialect-specific methods (baseline TSV)                                        dialect-specific methods (baseline TSV)
                 |  get engineSql() -> new executor per call (AR1)                                 |
                 v                                                                                 v
     [engine-sql/dialect-pglite.ts]                                                  [engine-sql/dialect-postgres.ts]
       db.query(sql, params) via the same                                              runUnsafe(conn, sql, params,
       checkpoint admission / PgliteStatementCache                                     {signal?, prepare:true, simple:false})
       affectedRows from result                                                        no checkoutGauge (CQ6); count -> affectedRows
                 \                                                                                 /
                  +-------------------> [engine-sql/executor.ts]  <-----------------------------+
                                          Executor { query(sql, params, opts) -> {rows, affectedRows} }
                                          ScopedRead / LegacyUnscopedRead brands (AR2)
                                          [engine-sql/normalize.ts] declared column kinds (A5)
                                          reuses SqlValue + executeRawJsonb(Pick<BrainEngine,'executeRaw'>) from sql-query.ts
                                                          |
             [engine-sql/{facts,takes,salience,code-edges,cjk-search}.ts]  (+ W1-extended domains if UC1 includes them)
             [engine-sql/bootstrap.ts] E1 single forward-reference bootstrap (callers: both engines' initSchema, db.ts:initSchema)
                 imports only: executor types, search/read-policy-sql, search/sql-ranking, cjk-keyword-sql, types.ts
                 NEVER imports pglite-engine.ts / postgres-engine.ts (layering test, AR4)

   SCHEMA TEXT (W2)
     src/schema.sql (canonical, non-fragment tables) --+
     TS fragment modules (canonical, 20 tables) -------+--> [scripts/build-schema.ts] --> schema-embedded.generated.ts (PG blob)
     PGLite-only rules (slug_aliases, page_aliases) ---+        (T1: also writes schema.sql   --> [pglite-schema.generated.ts]
                                                                 BEGIN/END GENERATED regions)       template w/ placeholders
                                                                                                    getPGLiteSchema(dims, model) unchanged
   MIGRATIONS (W3)
     [schema-migrations/v002-...v175-*.ts] --> [scripts/build-schema-migrations.ts] --> [schema-migrations/registry.generated.ts]
     [schema-migrations/types.ts, helpers.ts] (leaf)                                      static imports, sorted
     src/core/migrate.ts (runner ~720 lines): imports registry; re-exports MIGRATIONS, LATEST_VERSION, type Migration

   TEST-ONLY HASH (AR7)
     computeSnapshotSchemaHash inputs == static-import closure of {pglite-schema.generated.ts, registry.generated.ts,
       engine-sql/bootstrap.ts, migrate.ts}  (asserted by a unit test; same list feeds all 11 CI cache keys)

   GUARDS (W5/W7)
     [check-function-size.ts] (src only, name-path keys) ; [engine-sql ratchet + baseline TSV] ; [engine-sql dynamic-SQL scanner]
     [schema freshness] ; [migrations registry freshness/duplicate/filename] ; [verify-move-only.ts] (reviewer tool)
     existing, re-pointed: check-jsonb-pattern.sh, check-engine-dynamic-import.sh, select-e2e.ts, e2e-test-map.ts,
       serve-http-admin-route-guard.test.ts, test/helpers/*-source.ts loaders
```

### Workstream dependency and ordering

```
W0 gates on master (goldens, inventories, E5 via executeRaw, loaders, path-consumer re-point)   <- must precede every move
 |
 +--> W5 function-size guard (baseline 77 rows, src only)  -- each later commit updates baseline rows it moves
 |
 +--> W3 migrations split  (+ AR7 hash-closure test + 11 CI keys, same commit)                     <- before W2: the generated
 |                                                                                                    registry is a hash input
 +--> W2 schema generation (+E4, +T1, + EO3 upgrade-replay)                                         <- before E1: bootstrap probe
 |                                                                                                    sets follow the new blob
 +--> W1 executor (C10) -> W1-core domains, one commit each, full parity run each -> E1 bootstrap last
 |       (W1-extended domains after, only if UC1 includes them and each passes its inventory)
 |
 +--> W4 (independent of W1 code; ordered after it to keep engine files stable while W4 edits commands/)
 |       sync (move, then mechanical-rename, then behavior) -> doctor -> serve-http (AR6 extract first) -> cli (+generator)
 |       -> cut line: jobs, hybrid, autopilot
 |
 +--> W6 moved-symbol map from AST (merge-base..head), porting kit, rebase, final goldens
 +--> W7 docs (CLAUDE.md, CONTRIBUTING, ENGINES, key-files) + build:llms ; ceilings lowered ; PATCH bump via /ship
```

Ordering verdict: the plan's order W0, W5, W3, W2, W1, W4, W6, W7 is correct with one fix (AR9: path-consumer re-pointing and the
snapshot-key test belong to W0/W3, not W7).

### Findings

**AR1 [P1] (confidence 9/10) CRITICAL GAP. `src/core/postgres-engine.ts:585-588`, `src/core/pglite-engine.ts:1725`: executor lifetime vs transaction clone.**
Quoted: `const txEngine = Object.create(this) as PostgresEngine; ... Object.defineProperty(txEngine, 'sql', { get: () => tx });`.
If the engine-sql executor is constructed once (in `connect()` or the constructor) and stored in a field, `txEngine` inherits that
field through the prototype chain and every migrated write inside `engine.transaction()` runs on the pool, commits immediately, and
survives the rollback. Nothing errors; data integrity breaks silently. Realistic trigger: `putPage` + facts write inside one
transaction, followed by a failure. Fix: the executor is a getter that wraps `this.sql` / `this.db` at call time (the pattern the
peeled deps already use, `get sql() { return self.sql; }`), plus contract test EO1 on both engines. Auto-decided: accept (P1, P5).

**AR2 [P1] (9/10) RLS scoping status must be preserved per method, not imposed. `postgres-engine.ts:281-312`, `:5566-5569`.**
The brand in A3 is right in spirit and wrong in rule. Master scopes 23 read sites; the W1-core salience/facts/takes/code-edges reads
are unscoped. Fix: two brands, `ScopedRead` (only from `withScopedReadTransaction`) and `LegacyUnscopedRead` (from
`legacyUnscopedRead(reason)`), both accepted by read functions whose master counterpart used that mode; a W0 inventory golden lists
every engine read method and its master mode; a unit test fails if a migrated method's mode differs. Casting to either brand is
banned by the guard. Extending RLS scoping to the unscoped reads is a security improvement and a behavior change: TODO (E-TODO-1).
Auto-decided: preserve (P5, plan's behavior-preserving goal). Taste TE3 recorded.

**AR3 [P1] (9/10) CRITICAL GAP. Existing PGLite brains replay the regenerated blob. `pglite-engine.ts:1066-1069`.**
E4 compares fresh installs. An existing brain built by master runs the new generated blob plus bootstrap on first boot after the
upgrade: any forward reference the old template did not have, any `ALTER` from `schema.sql` that is not a no-op on that shape, or
any `CREATE OR REPLACE FUNCTION` body that differs would mutate or wedge real user brains (the #239-#396 incident class the
bootstrap exists for). Fix EO3: an upgrade-replay test that builds a PGLite data dir with master's blob (the committed
`test/fixtures/pglite-snapshot.tar` of master, pinned as a golden fixture in W0), opens it with the branch, runs `initSchema`, and
asserts success, identical E4 catalog, and an idempotent second boot. Plus the existing `schema-bootstrap-coverage.test.ts` runs
unchanged against the generated blob.

**AR4 [P2] (8/10) Layering: no back-edges.** `engine-sql/**` must never import either engine file (would recreate the god class
through the back door and create cycles with the facades); `schema-migrations/**` must never import `migrate.ts` (SC2). Fix: one
layering unit test over the static import graph (reuse the orphan-module walker in `scripts/check-orphan-modules.mjs`), bad/good
fixtures. Accept (P5).

**AR5 [P1] (8/10) CLI table must carry the dispatch phase and thin-client mode. `cli.ts:2103`, `:2113`, `:3012`.**
Record shape becomes `{ name, phase: 'pre-connect' | 'post-connect', thinClient: 'none' | 'refuse' | 'route-then-refuse',
selfHelp, skipStartupHooks, aliases, load }`. Subcommand-specific routing (`sources writer|...`, `takes add|...`, `capture`,
`forget`, `call` to the persistence delegate; `agent register` pre-guards) stays as explicit ordered code before table dispatch,
because it depends on `args`, not the command name (P5: explicit beats a clever predicate field). W0 golden (static extraction on
master): per command, its phase (branch position relative to the `connectEngine()` terminator), its thin-client mode, and each
subcommand routing rule; the table test asserts equality. Behavioral proof: EO5 runs every engine-free command with an unreachable
`DATABASE_URL` and asserts the master exit code and output.

**AR6 [P1] (8/10) serve-http route golden needs a feasible capture method. `serve-http.ts:858`.**
Decision: W0 captures an AST golden on master (ordered `app.use/get/post/all(path, ...handlers)` calls across `serve-http*.ts`,
following `mount*(app, ...)` calls, recording handler identifiers or `<inline:N>`). The first W4 serve-http commit is move-only and
extracts `buildServeHttpApp(engine, options)` which `runServeHttp` calls (a production caller exists, so no test-only seam). From
then on a runtime golden reads Express 5 `app.router.stack` (method, path, handler names, including `requireAdmin` which is a named
function declaration). At the extraction commit both goldens must describe the same order; afterwards the runtime golden is
authoritative and the extended admin-route guard (DX D32/O8) uses the same introspection plus its structural scan. Taste TE1.

**AR7 [P1] (8/10) Snapshot hash inputs derived from the import closure, not hand lists. `pglite-engine.ts:334-366`.**
Fix EO7: a unit test computes the static relative-import closure of `pglite-schema.generated.ts`, `registry.generated.ts`,
`engine-sql/bootstrap.ts` and `migrate.ts`, and asserts (a) `computeSnapshotSchemaHash` hashes every file in it (directory reads
are fine: `readdirSync` over `schema-migrations/` sorted), and (b) each of the 11 CI keys covers the same set (globs allowed:
`src/core/schema-migrations/**`, `src/core/engine-sql/**`). Supersedes the hand-list parts of CEO A6 and DX O7 while keeping their
verifications. This also closes today's gap where the PGLite bootstrap in `pglite-engine.ts` is not hashed at runtime.

**AR8 [P2] (8/10) Compiled binary: command loaders must stay statically analyzable.** Switch cases were literal
`await import('./commands/x.ts')` by construction; a table invites `import(\`./commands/${name}.ts\`)`, which `bun build --compile`
cannot bundle. Fix: table test asserts every `load` is an arrow returning an `ImportCall` with a `StringLiteral` argument;
`check-compile-autoload.sh` stays the backstop. Accept (P1).

**AR9 [P2] (7/10) Ordering of guard re-points.** See SC18. Accept.

Security summary: RLS (AR2), admin auth (AR6 + DX O8), OAuth/CORS order (plan's authenticated request-outcome tests + route golden),
trust boundary (`remote:false` set in cli.ts stays in `main`; the table never constructs `OperationContext`), SQL injection (CQ3).
No new secrets, dependencies or network surfaces.

One realistic production failure per new path: executor in tx (AR1), RLS-on host (AR2), PGLite upgrade (AR3), cyclic import at load
(AR4), DB-down `status` (AR5), admin route without auth (AR6), stale snapshot false-green (AR7), missing command in compiled binary
(AR8). Each has an obligation below.

---

## Section 2: Code quality review

**CQ1 [P1] (9/10) Prepare and protocol parity. `postgres-engine.ts:5363`** `pending = conn.unsafe(sql, params as ..., { cancelFence: !!signal });`
Extend `runUnsafe`'s opts with `prepare?: boolean; simple?: boolean` forwarded to `unsafe()`. The engine-sql adapter always passes
`{prepare: true, simple: false}`; `executeRaw`/`executeRawDirect` keep passing nothing (unchanged). Accept (P5, P3).

**CQ2 [P2] (9/10) DRY on JSONB. `sql-query.ts:118`.** Widen `executeRawJsonb(engine: Pick<BrainEngine,'executeRaw'>, ...)`; the
engine-sql executor implements `executeRaw` so the same helper (and its top-level-array refusal) serves both. No second JSONB
helper; verify with `rg -n "function executeRawJsonb" src` = 1 hit. Accept (P4).

**CQ3 [P1] (9/10) Dynamic-SQL rule that matches the code. `sql-ranking.ts:405`, `postgres-engine/facts.ts:489`.**
Amend A2b: in `engine-sql/**`, a `${...}` inside a SQL template (or `+` string concatenation into SQL) is allowed only when the
expression is (1) a member of a constant `as const` identifier/ORDER allowlist, (2) a call to a registered vetted builder
(`pageReadFilter`, `buildRecencyComponentSql`, `privatePagesFilterFragment`, `currentCodeEdgeFilter`, `buildCJKKeywordSql`,
`ENRICH_ORDER_SQL`; registry lives in the scanner with a one-line reason each), or (3) a numeric expression guarded by
`Number.isFinite` in the same function (the vector-literal case). Everything else fails with FAIL/Why/Fix/See. Inlined literals on
master stay inlined (planner behavior). Accept (P1, P5).

**CQ4 [P2] (8/10) Doctor registry contract. `doctor.ts:2017`, `:1850`, `:1886`.**
`type DoctorEntry = { name: string; run(ctx: DoctorContext): Promise<Check[] | typeof STOP_DOCTOR> }`. `DoctorContext` carries the
parsed flags (`jsonOutput, fastMode, doFix, dryRun, scope, orphanRatioSourceId`), `engine`, `progress`, `skillsDir`, and the
explicitly named cross-check values (`schemaVersion`, `autoFixReport`), written by the entry that computes them. The runner stops
on `STOP_DOCTOR` exactly where master returned early. `name` is the entry's primary check name for the ordered-names golden; entries
that emit several checks list them in `emits: readonly string[]` so the category test covers all. Accept (P5). Taste TE4.

**CQ5 [P2] (8/10) Generated file naming.** SC3. Accept.

**CQ6 [P2] (8/10) Pool diagnostics parity. `postgres-engine.ts:5388`.** The adapter calls `runUnsafe` directly, not `executeRaw`,
so `checkoutGauge` accounting matches master (tagged sites never touched it). Pool-diagnostics golden: gauge snapshot after a fixed
op sequence equals master. Accept (P5).

**CQ7 [P2] (8/10) One token normalizer for two proofs.** A11's handler hash and E3's move-only verifier both need "tokens with
whitespace and comments normalized". Put it once in `scripts/lib/normalize-tokens.ts` (TS scanner based). E3 gains two modes:
`--wrapper migration` (compare the object-literal expression per version, ignoring the `export const vNNN: Migration =` wrapper)
and `--rename-map <file>` (identifier rewrites such as `pullFailed -> run.pullFailed`), used by commits tagged
`Mechanical-Rename: yes`. Accept (P4, P5). Taste TE5.

**CQ8 [P2] (9/10) Explicit row-count contract.** `postgres-engine/facts.ts:128` `return (result.count ?? 0) > 0;` vs
`pglite-engine/facts.ts:123` `return (result.affectedRows ?? 0) > 0;`. Executor returns `{ rows, affectedRows }` from both adapters
(Postgres `RowList.count`, PGLite `affectedRows`); domain code reads only `affectedRows`. E5 adds UPDATE/DELETE/INSERT ... ON
CONFLICT DO NOTHING rows. Accept (P5).

Error-handling gaps: executor and domains never catch (CEO rule kept); `runUnsafe` already throws synchronously on a pre-aborted
signal, and adapters must use try/finally, not `.finally` (the pattern documented at `postgres-engine.ts:5385-5387`).
Stale diagrams in touched files: `pglite-schema.ts:9-28` header (removed by W2), `schema-drift.test.ts:1-23` (update with E4),
`doctor-categories.ts` header, `check-module-size.sh:12` region-exempt comment, `schema-bootstrap-coverage.test.ts:26-31` "When you
add a new schema-blob forward reference" steps (must name `engine-sql/bootstrap.ts` after E1).

Shared-code rubric applied: CQ2 (callers: 18 existing `executeRawJsonb` sites + engine-sql adapters; net savings ~0 lines, reliability
gain: one JSONB rule) and CQ7 (callers: A11 golden test + `verify-move-only.ts`; ~60 lines once instead of twice) pass. Rejected: a
shared "route table extractor" used by both the AST and runtime goldens (different inputs, no common contract).

---

## Section 3: Test review

### Test framework

CLAUDE.md routes to `docs/TESTING.md`: Bun test (`bun test`), tiers `bun run test` (unit shards + serial), `bun run verify` (guards,
`scripts/run-verify-parallel.sh` CHECKS), `test:e2e` (real Postgres, `DATABASE_URL`), `ci:local` / `ci:ubicloud` (full gate incl.
PgBouncer). Guard fixtures under `test/fixtures/guards/<guard>/{bad,good}/` via `GBRAIN_GUARD_ROOT`; registry
`scripts/guards-manifest.tsv`; source reads need `test-reads-source-ok[<category>]` markers (`test/test-reads-source-smell.test.ts`).
No LLM/prompt files are touched: no eval suites required (CEO's optional LongMemEval-mini smoke stays optional).

### Coverage diagram (codepaths and user flows; planned code, traced against current code)

```
CODE PATHS                                                              USER FLOWS
[+] engine-sql/executor.ts + adapters (W1, C10)                         [+] Storage call through engine (every op)
  |- query(sql, params, opts)                                             |- [GAP->EO1 ★★★] write in transaction() then throw -> rolled back
  |   |- params: text[]/int[]/real[], jsonb obj, jsonb top-level array   |     (PGLite + Postgres)  [->E2E]
  |   |   (refused), bigint>2^53, Date tz, null, bool, vector literal     |- [★★★ EXISTS] 28 parity/drift files, engine-parity.test.ts,
  |   |   [GAP->E5 ★★★ planned] both engines; on master via executeRaw    |     operations-source-isolation-matrix.test.ts (run per domain)
  |   |- empty array                     [GAP->E5 row]                    |- [GAP->EO4 ★★★] RLS flag ON: scoped reads bind app.scopes;
  |   |- affectedRows (UPDATE/DELETE/ON CONFLICT) [GAP->CQ8 row]          |     legacy-unscoped reads open no tx  [->E2E]
  |   |- errors 23505 / 57014 / 40P01 pass-through [DX O14 planned]       |- [GAP->EO6 ★★] direct PG reuses prepared stmt; PgBouncer none
  |   |- signal: pre-aborted (sync throw) / mid-query cancel              |     [->E2E]
  |   |   [★★★ EXISTS for executeRaw: postgres-engine cancellation tests; |
  |   |    GAP: same matrix through adapter -> E5 row]                    [+] Upgrade and init
  |   |- prepare:true, simple:false forwarded     [GAP->EO6]              |- [★★ EXISTS] fresh init schema-drift (cols+indexes)
  |   |- no checkoutGauge on adapter path         [GAP->EO9 golden]       |- [GAP->E4 ★★★ planned] catalog-level incl. PGLite ordinal (T-G13)
  |- get engineSql() per call (tx clone)          [GAP->EO1 CRITICAL]     |- [GAP->EO3 ★★★ CRITICAL] master-built PGLite brain -> branch boot
  |- brands ScopedRead / LegacyUnscopedRead                               |- [GAP->W3 planned ★★★] PG brain at older version -> apply split
  |   |- typecheck rejects plain executor         [A3 @ts-expect-error]   |     registry -> E4 catalog  [->E2E]
  |   |- mode per method == master inventory      [GAP->EO4 unit]         |
  |- normalize(row, kinds) jsonb/bigint/date/vector/text[] [A5 planned]   [+] CLI (thin client, DB down, help)
  |   |- unknown kind throws                      [A5 planned]            |- [GAP->EO5 ★★★] engine-free cmds with unreachable DB: status,
[+] engine-sql/<domain>.ts x5 (+W1-extended)                              |     db-repair, pglite-repair, bootstrap, hook (exit + output)
  |- SQL text byte-equal to master modulo $N renumbering [GAP->EO8]       |- [GAP->A16b planned ★★★] --help, --tools-json, unknown cmd,
  |- inlined literals stay inlined (vector, decay map) [GAP->EO8]         |     thin-client refusal matrix (command AND subcommand level)
  |- dynamic fragments only via vetted builders   [GAP->CQ3 scanner]      |- [★★ EXISTS] test/cli-flag-validation.test.ts; regenerated
[+] engine-sql/bootstrap.ts (E1)                                          |     registry zero diff (DX O6)
  |- 3 callers: PG initSchema, db.ts initSchema, PGLite initSchema        |- [GAP->EO5b] synthetic table command: flag ok / unknown rejected
  |- per-engine probe sets preserved              [★★★ EXISTS             |     / help engine-free (plan W4 item, keep)
  |   schema-bootstrap-coverage.test.ts, re-pointed not rewritten]        |
  |- legacy-shape boot both engines               [★★ EXISTS              [+] serve-http
  |   test/e2e/postgres-bootstrap.test.ts; PGLite via test:382]           |- [★★ EXISTS] test/e2e/serve-http-oauth.test.ts (revocation, PKCE,
[+] schema-migrations/ (W3)                                               |     CORS, DCR)
  |- registry.generated.ts sorted, static imports [GAP->W3 planned ★★★]   |- [GAP->A16/AR6 ★★★] route table golden (AST@master, runtime after)
  |   |- duplicate version -> FAIL names both files [DX O10 planned]      |- [★★ EXISTS->extend] admin-route-guard: scan every module +
  |   |- filename/version mismatch                [DX O4 planned]         |     runtime; mutation test in moved module  [->E2E-ish unit]
  |   |- file missing from registry (freshness)   [W3 planned]            |- [GAP->plan] authenticated outcome: OAuth preflight/CORS order,
  |   |- gaps 17-19,100 preserved; 170 entries    [A11 planned]           |     admin 401 vs 200 on every /admin/api route
  |- helpers.ts leaf; no import of migrate.ts     [GAP->EO10 layering]    |
  |- handler token hash normalized                [GAP->CQ7]              [+] doctor
  |- migrate.ts re-exports (MIGRATIONS, LATEST_VERSION, type Migration)   |- [GAP->W0 planned ★★★] normalized --json goldens PGLite/PG/degraded
  |   [DX O13 export golden]                                              |- [GAP->EO11] null engine / connection failure / --fast early stop
  |- snapshot hash closure incl. bootstrap        [GAP->EO7 CRITICAL      |- [GAP->DX O5] uncategorized entry fails with FAIL/Why/Fix/See
  |   silent false-green otherwise]                                       |
[+] scripts/build-schema.ts (W2)                                          [+] sync
  |- evaluates TS fragments; template placeholders preserved [GAP->EO12]  |- [★★★ EXISTS] test/sync.test.ts, sync-* tests (re-pointed per A10)
  |- BEGIN/END GENERATED banners; freshness guard names source file       |- [GAP->A17 ★★★] phase-await vs watchdog / vs timeout, both orders,
  |   [W2 planned + DX O9]                                                |     latch-wrapped BrainEngine + fake timers (seam=none)
  |- capability rules (PG-only, PGLite-only tables) not subtraction       |- [GAP->A17 guard] no destructuring of run fields
  |   [W2 planned; proven by E4]                                          |- [★★ EXISTS] resume-from-checkpoint tests
  |- unknown construct -> exit !=0                [GAP->fixture]          |
[+] DOCTOR_REGISTRY runner (W4)                                           [+] search
  |- ordered names == master AST order           [GAP->W0 planned]        |- [GAP->A13 planned ★★★] hybrid golden cold+warm exact (id,score)
  |- Check[] | STOP semantics                     [GAP->EO11]              |- [★★ EXISTS] hybrid-*.test.ts, hybrid-arm-rethrow.test.ts
  |- category from categorizeCheck, emits[] covered [DX O5]               |
[+] SyncRun + commands/sync/* phases (W4)                                 [+] jobs (cut line)
  |- run.<field> only (guard)                     [A17 planned]           |- [GAP->A15 planned] 24 names same order; supervisor probe
  |- controlled-order tests                       [A17 planned]           |     (supervisor.ts:859 dynamic import) keeps working
[+] CLI_COMMANDS table + derived sets (W4)                                |
  |- derived sets == master sets                  [plan W0 golden]        [+] Contributor flows (W7)
  |- phase + thinClient per command == master     [GAP->EO5 golden]       |- [GAP->DX O18] timed dry-run, six change kinds
  |- load is literal import()                     [GAP->EO13]             |- [★ smoke only] docs-cli-commands truth check for new recipes
  |- generator reads table; registry zero diff    [DX O6]
[+] buildServeHttpApp + serve-http-*.ts modules (W4)
  |- global app.use order + per-route chain       [AR6 goldens]
  |- 415-line /mcp handler split: same responses  [★★ EXISTS e2e oauth/mcp; runtime golden]
[+] guards: function-size / engine-sql ratchet / dynamic-SQL / freshness x2 / verify-move-only
  |- bad+good fixtures, FAIL/Why/Fix/See, manifest rows [DX O9 planned]
  |- function-size: arrow/obj-method/class-prop/anon handler forms [A18 planned]
  |- function-size: src-only scope, tests excluded [GAP->SC4 fixture]
  |- verify-move-only: wrapper + rename-map modes  [GAP->CQ7 fixtures]
[+] perf budgets (f)                               [GAP->EO14 bench incl. engine-connect cold start]

COVERAGE (planned codepaths + flows): 58 paths | existing ★★/★★★ owners: 13 (22%) | planned by CEO/DX/plan: 29 | new Eng gaps: 16
QUALITY of existing owners: ★★★:5 ★★:8 ★:1 (docs truth check)
GAPS after all accepted obligations: 0 unowned (2 CRITICAL closed: EO1, EO3; 1 silent CI false-green closed: EO7)
E2E-marked: 8 ([->E2E]); EVAL: 0 (no prompt/LLM change)
```

Legend: ★★★ behavior + edge + error | ★★ happy path | ★ smoke | [->E2E] needs real Postgres / PgBouncer | [GAP->X] gap closed by obligation X.

### Regression rule (IRON RULE) applied

Every rewrite that puts existing behavior at risk has a named regression contract (auto-approved under autoplan, recorded in the
audit trail): storage behavior (28 parity files unchanged + E5 + EO1 + EO4 + EO6 + EO8), schema end state (E4 + EO3), migration
content and apply (A11 + W3 apply-from-older), CLI (A16b + EO5), HTTP auth (A16 + AR6 + O8), doctor (W0 goldens + EO11), sync
(A17), hybrid (A13), export surface (O13). Intentional differences: none, except the `.d.ts` gaining `export type { Migration }`.

### Missing tests added to the plan (Eng; each with a value card)

| ID | File (naming follows repo) | Type | Assertion | Value card |
|---|---|---|---|---|
| T-G1 (EO1) | `test/e2e/engine-sql-transaction-parity.test.ts` + PGLite arm in `test/engine-sql-transaction.test.ts` | unit + E2E | inside `engine.transaction()`: migrated write (facts insert, takes upsert, code-edges insert) then throw; afterwards rows absent; a concurrent pool read during the tx does not see them | protects=transaction atomicity for engine-sql writes; fails_when=executor bound to pool at connect time; why_new=no test writes through a peeled module inside transaction(); seam=none |
| T-G2 (EO3) | `test/pglite-upgrade-replay.test.ts` | unit (PGLite) | master-built data dir fixture -> branch `initSchema` succeeds; catalog == master catalog; second `initSchema` changes nothing | protects=existing PGLite users' first boot after upgrade; fails_when=generated blob adds a non-idempotent statement or forward ref; why_new=E4 is fresh-install only; seam=none |
| T-G3 (EO4) | `test/engine-sql-read-scope.test.ts` (extends fake-sql pattern of `postgres-engine-rls-scope.test.ts`) + `test/e2e/engine-sql-rls-scope.test.ts` | unit + E2E | per migrated read method: flag ON -> scoped methods show `set_config` in the tx lane, legacy-unscoped methods show pool lane only; e2e asserts `current_setting('app.scopes')` inside a scoped store read | protects=RLS layer 2 and #1794 no-pool-hold; fails_when=a method gains or loses the scoped tx; why_new=existing test pins the helper, not each migrated method; seam=none |
| T-G4 (EO6) | row in E5 contract test + `test/e2e/engine-sql-prepare-parity.test.ts` | E2E | direct PG: after 2 calls `pg_prepared_statements` on that backend contains the statement; PgBouncer: none; zero-arg query never simple protocol (fake-conn unit asserts options) | protects=no Describe round trip regression on direct Postgres; fails_when=adapter drops prepare:true or lets args.length===0 pick simple; why_new=tagged templates prepared implicitly; seam=none |
| T-G5 (EO9) | row in `test/postgres-engine.test.ts` pool diagnostics section | unit | gauge snapshot after fixed op sequence == master golden | protects=doctor pool-check inputs; fails_when=adapter routes via executeRaw; why_new=gauge untested for peeled domains; seam=none |
| T-G6 (EO5) | `test/cli-dispatch-phase.test.ts` (golden) + `test/cli-engine-free-db-down.serial.test.ts` | unit + serial CLI | per command phase/thinClient == master extraction; engine-free commands with unreachable DB give master exit code and first output line | protects=DB-down contract and thin-client routing; fails_when=table drops phase; why_new=no test pins dispatch phase; seam=none |
| T-G7 (EO13) | inside the CLI table test | unit | every `load` is `() => import('<literal>')` | protects=compiled binary includes every command; fails_when=computed specifier; why_new=switch made it structural; seam=none |
| T-G8 (EO7) | `test/snapshot-inputs-closure.test.ts` (merged with DX O7's cache-key test, one file) | unit | closure ⊆ hash inputs; closure ⊆ each of 11 CI keys; failure names file + both places | protects=unit suite never runs on stale snapshot; fails_when=bootstrap or a migration helper omitted; why_new=hash list omits pglite-engine.ts today; seam=none |
| T-G9 (EO10) | `test/scripts/layering.test.ts` + guard fixtures | unit | engine-sql imports no engine file; schema-migrations imports no migrate.ts | protects=acyclic load order (TDZ-safe in compiled binary); fails_when=a handler imports migrationNotice from migrate.ts; why_new=new dirs; seam=none |
| T-G10 (EO11) | extend `test/doctor.test.ts` buildChecks cases | unit | `buildChecks(null, ...)`, connection failure, `--fast`: returned check names and statuses == master golden | protects=doctor early-stop contract; fails_when=runner ignores STOP; why_new=registry runner new; seam=none |
| T-G11 | `test/fixtures/guards/check-engine-sql-dynamic/{bad,good}` | guard fixture | raw string interpolation fails; vetted builder and finite numeric pass | protects=no injection via conversion; fails_when=allowlist too loose or too strict; why_new=new scanner; seam=none |
| T-G12 | `test/scripts/verify-move-only.test.ts` | unit | wrapper mode passes a real W3 move; rename-map mode passes SyncRun rewrite; single edited token fails both | protects=move proof usable at ~50k lines; fails_when=normalizer ignores a changed token; why_new=new tool; seam=none |
| T-G13 | extend `test/helpers/schema-diff.ts` + E4 test | E2E | PGLite master-vs-branch includes `ordinal_position`; PG-vs-PGLite stays name-based | protects=column order for `SELECT *` consumers; fails_when=generator reorders columns; why_new=diff is name-based; seam=none |
| T-G14 (CQ8) | rows in E5 | unit + E2E | UPDATE/DELETE/ON CONFLICT DO NOTHING affectedRows equal across engines | protects=boolean/count results of write methods; fails_when=adapter reads wrong field; why_new=per-engine code read different fields; seam=none |
| T-G15 (EO14) | perf harness under `scripts/` (bench, not a test) | bench | PGLite connect+initSchema cold (snapshot on/off), `gbrain --version`, hot paths; within noise / +20 ms | protects=cold start and hot-path latency; fails_when=170-module load or lost prepare; why_new=no budget exists; seam=none |
| T-G16 (EO8) | `test/engine-sql-sql-text.test.ts` (W0 golden per converted Postgres method) | unit | SQL text emitted by each converted method == master tagged-template text with `$N` renumbering (captured with fake sql on master) | protects=no semantic SQL drift during tagged-to-positional conversion; fails_when=a clause, literal or cast changes; why_new=parity tests check results on fixtures, not text; seam=none |

Rejected (value bar): a separate "executor unit test with mocked driver" beyond E5 (covered_elsewhere: E5 runs both real engines).
Tests made obsolete by this plan: none (retirement requires evidence per TESTING.md; not proposed).

Test plan artifact: `(autoplan scratch)`.

---

## Section 4: Performance review

**PF1 [P1] (9/10) Prepared statements and protocol (direct Postgres).** Covered by CQ1/SC5. Without `prepare: true`, every converted
hot query (`searchVector`, `searchKeyword`, `_upsertChunksOnce`, `getPage` if W1-extended) takes a Parse+Describe round trip
(`connection.js:244` `q.describeFirst = q.onlyDescribe || (parameters.length && !q.prepared)`), 30-80 ms on hosted Postgres.
Budget: T-G4 + EO14 bench, no regression beyond noise.

**PF2 [P2] (8/10) RLS wrap would add a pool hold per read.** Avoided by AR2 (preserve).

**PF3 [P2] (8/10) Cold start.** `gbrain --version` does not load migrate.ts (import walk: 555 modules from `src/cli.ts`, migrate.ts
absent), so the CEO budget holds trivially there. Every DB-touching command on source installs now loads ~175 extra modules through
`engine-factory -> engine -> migrate -> registry`. Budget (EO14): PGLite connect + initSchema (snapshot path) cold start ≤ +20 ms
on the 4-core machine; if exceeded, fallback is a single generated bundle module for the registry, not dynamic imports (engine
dynamic-import rule).

**PF4 [P3] (7/10) Checkpoint gauge / connection reservation.** Adapter forwards `signal` only where master did (A4); `runUnsafe`
reserves a connection only when a signal is present (`postgres-engine.ts:5358`). No change if A4 is followed; T-G5 guards gauge.

**PF5 [P3] (8/10) N+1 and batching.** Batch writes use `unnest` / `jsonb_to_recordset` today (`code-edges.ts:42,65`,
`salience.ts setEmotionalWeightBatch`). EO8's SQL-text golden prevents a per-row loop sneaking in during conversion.

**PF6 [P3] (7/10) Memory.** 170 module records + closures are already allocated today inside one array; no growth. Prepared statement
cache per backend grows with distinct SQL text exactly as today (vetted builders produce the same variants).

**PF7 [P2] (8/10) CI wall time and cost.** W1 rule "full e2e parity run after each domain commit": 5 core + E1 + up to 7 extended =
up to 13 `ci:ubicloud` runs at ~5 min wall + 70-90 s setup each, against a 256 vCPU project quota shared with PR CI (TESTING.md
"Ubicloud fan-out"). Run them with the default 4 VMs, never `--vms 10`, and batch W4 commits into one gate per god function.
New verify guards: TS-AST function-size over ~1,473 files (~2-3 s measured by CEO scratch run), engine-sql scanners over a small dir.
DX O15 (<15 s each, verify +<20%) holds.

**PF8 [P3] (7/10) Caching.** `PgliteStatementCache` and checkpoint admission kept by the PGLite adapter (A4); snapshot fixture stays
valid across the PR because hash inputs change only when schema inputs change (AR7).

---

## NOT in scope

- D1 (CEO): the ~60 other >300-line functions outside touched src files (`runCycle` 1,227, `applyHarness` 1,167,
  `runPhaseSynthesizeInner` 1,043, `runImport` 956, `importFromContent` 910, `makeSubagentHandler` 884, `runConfig` 834). W5 freezes them.
- D2 (CEO): `src/core/` regroup, `ai/gateway.ts` adapters, cycle/extract/embed/import-file/init.
- T3 (CEO): phase-named sync errors (keeps goldens byte-identical).
- Engine table-set reconciliation (a real schema change for existing PGLite brains).
- Extending RLS scoping to reads that master leaves unscoped (AR2): security improvement, separate behavior change (E-TODO-1).
- Fixing the flag-registry `auth --dry-run` drop (existing TODO): byte-identical registry preserves it.
- Timestamp migration versions, router-level `requireAdmin`, scaffolders beyond the migration scaffold (DX).
- Replacing the 28 parity tests with executor contract tests (E-TODO-3): only after every domain is migrated.
- Decomposing test-file `describe` callbacks over 300 lines (SC4): tests are outside goal (b) and W5.
- Rejected: cyclomatic guard, store-vs-legacy feature flag, ORM/query builder, migration renumbering, runtime-computed command loaders.

## What already exists

Reuse (not rebuild): `sql-query.ts` (`SqlValue`, widened `executeRawJsonb`), `runUnsafe` (extended opts), `withScopedReadTransaction`
(unchanged), peeled-deps getter pattern (executor lifetime), vetted SQL fragment builders (A2b registry), `build-schema.sh` (becomes a
wrapper over `build-schema.ts`), `schema-drift.test.ts` + `schema-diff.ts` (E4, ordinal), `schema-bootstrap-coverage.test.ts`
(re-pointed, logic unchanged), `computeSnapshotSchemaHash` (closure-derived inputs), `doctor-source.ts` (generalized loaders),
`doctor/checks/*` + `categorizeCheck` (registry), `serve-http-{oauth,metrics,...}.ts` `mount*` convention, existing
`serve-http-admin-route-guard.test.ts` (extended), `generate-flag-registry.ts` `facadeExpansion` (re-targeted),
`check-module-size.sh` semantics (copied by the new ratchets), `check-engine-dynamic-import.ts` (AST guard pattern),
`check-orphan-modules.mjs` import walker (layering test), `guards-manifest.tsv` + `guard-self-test.sh`,
`test/postgres-engine-rls-scope.test.ts` fake-sql pattern (T-G3), `check-test-discriminates.sh`.
Accepted shared-code choices: CQ2 and CQ7 (rubric evidence in Section 2).

## Failure modes registry

```
CODEPATH                         | FAILURE MODE                                   | TEST (after obligations)    | ERROR HANDLING      | USER SEES          | FLAG
---------------------------------|------------------------------------------------|-----------------------------|---------------------|--------------------|-------------------------------
engine-sql executor in tx clone  | cached executor bound to pool; writes escape tx| none in plan -> EO1/T-G1    | none                | silent data change | CRITICAL GAP (closed by EO1)
PGLite upgrade boot (W2)         | regenerated blob mutates/wedges existing brain | none in plan -> EO3/T-G2    | initSchema throws   | boot failure or    | CRITICAL GAP (closed by EO3)
                                 |                                                |                             | only on wedge       | silent drift       |
snapshot hash inputs (W3/E1)     | bootstrap/helper not hashed; stale snapshot    | partial (A6/O7) -> EO7/T-G8 | none                | CI false green     | CRITICAL GAP (closed by EO7)
RLS scoping (W1)                 | method gains/loses scoped tx                   | partial (A3) -> EO4/T-G3    | none                | silent cross-scope | HIGH (closed by EO4)
                                 |                                                |                             |                     | read / pool hold   |
prepare/simple (W1, PG direct)   | unprepared + Describe RTT; simple protocol     | none -> EO6/T-G4            | n/a                 | slower search      | WARNING (closed)
converted SQL text (W1)          | clause/literal/cast drift in conversion        | parity files -> EO8/T-G16   | driver error or     | wrong results      | HIGH (closed)
                                 |                                                |                             | silent              |                    |
dynamic SQL (W1)                 | raw value concatenated into SQL                | none -> CQ3/T-G11           | none                | injection risk     | HIGH (closed)
row counts (W1)                  | affectedRows read from wrong field             | none -> CQ8/T-G14           | none                | false/0 results    | MEDIUM (closed)
pool gauge (W1)                  | raw gauge inflated                             | none -> EO9/T-G5            | none                | misleading doctor  | LOW (closed)
schema-migrations load (W3)      | import cycle -> TDZ at load                    | none -> EO10/T-G9           | module-load throw   | CLI crash on       | MEDIUM (closed)
                                 |                                                |                             |                     | engine connect     |
migration registry (W3)          | dup/dropped/mis-sorted version                 | A11 + DX O10                | generator exit 1    | CI red             | covered
build-schema.ts (W2)             | TS fragment eval fails / placeholder lost      | EO12 + E4                   | exit !=0 / E4 diff  | CI red             | covered
CLI table (W4)                   | engine-free command connects first             | none -> EO5/T-G6            | connect error       | `status` fails     | HIGH (closed)
                                 |                                                |                             |                     | when DB is down    |
CLI table (W4)                   | computed import specifier                      | none -> EO13/T-G7           | module not found    | command missing in | MEDIUM (closed)
                                 |                                                |                             | at runtime          | compiled binary    |
serve-http modules (W4)          | requireAdmin/limiter dropped or order changed  | O8 + AR6 goldens            | none                | auth bypass        | covered (was CRITICAL in CEO)
doctor registry (W4)             | continues after STOP / drops check             | W0 goldens + EO11/T-G10     | per-check catch     | changed output     | covered
SyncRun (W4)                     | stale destructured field across await          | A17 guard + ordering tests  | none                | partial sync       | covered
hybrid stages (W4 cut line)      | rank/score change                              | A13 golden                  | existing rethrow    | different results  | covered
function-size guard (W5)         | syntax form not counted / tests pulled in      | A18 fixtures + SC4 fixture  | exit 1              | CI red             | covered
verify-move-only (W6)            | false failures on wrappers; reviewers skip it  | CQ7/T-G12                   | exit 1              | none (review aid)  | covered
```

Plan as written: 3 CRITICAL GAPS (no test, no error handling, silent): executor in transaction clone, PGLite upgrade replay (silent
drift case), snapshot inputs false-green. All three closed by accepted obligations EO1, EO3, EO7.

## Worktree parallelization strategy (lanes integrate into the ONE PR branch; no PR stack)

| Step | Modules touched | Depends on |
|---|---|---|
| S0 W0 goldens, inventories, loaders, path-consumer re-point | test/, test/helpers/, scripts/, .github/ | — |
| S1 W5 function-size guard | scripts/, test/fixtures/guards/ | S0 |
| S2 W3 migrations split | src/core/ (migrate, schema-migrations/), scripts/, .github/ | S0 |
| S3 W2 schema generation | src/ (schema.sql), src/core/ (pglite-schema, fragments), scripts/ | S2 |
| S4 W1 executor + domains + E1 | src/core/ (engines, engine-sql/, sql-query) | S3 |
| S5a W4 sync | src/commands/ (sync, sync/) | S0 |
| S5b W4 doctor | src/commands/ (doctor, doctor/) | S0 |
| S5c W4 serve-http | src/commands/ (serve-http*) | S0 |
| S5d W4 cli + generator | src/cli.ts, scripts/ (generate-flag-registry) | S0 |
| S6 W6/W7 docs, map, porting kit, ceilings | docs/, CLAUDE.md, CONTRIBUTING.md, scripts/module-size-limits.tsv | S1-S5 |

Lanes: Lane A: S2 -> S3 -> S4 (shared src/core/ schema+engine). Lane B: S5a. Lane C: S5b. Lane D: S5c. Lane E: S5d.
Execution order: land S0 then S1 on the branch. Launch Lane A and Lanes B-E in parallel worktrees. Merge B-E into the branch in
any order (disjoint command files), then Lane A. Then S6, final rebase, full gate.
Conflict flags: `scripts/module-size-limits.tsv` and the function-size baseline TSV are touched by every lane (resolve by
re-running the generators/guards after each merge, never by hand-merging rows); `.github/workflows/*` touched by S0 and S2
(sequence S0 first); `scripts/guards-manifest.tsv` touched by S0, S1, S2, S4 (append-only rows, sorted).

---

## Completion Summary

```
+====================================================================+
|            ENG PLAN REVIEW - COMPLETION SUMMARY (primary voice)     |
+====================================================================+
| Step 0: Scope Challenge | scope accepted as-is (22 findings, all    |
|                         | accepted as amendments; no reduction)     |
| Architecture Review     | 9 issues found (2 CRITICAL: AR1, AR3)     |
| Code Quality Review     | 8 issues found                            |
| Test Review             | diagram produced, 16 gaps identified      |
| Performance Review      | 8 issues found (1 P1: prepare/protocol)   |
| NOT in scope            | written (10 items + rejected list)        |
| What already exists     | written                                   |
| TODOS.md updates        | 13 items proposed (all phases)            |
| Failure modes           | 20 rows, 3 critical gaps flagged          |
|                         | (all closed by EO1/EO3/EO7)               |
| Unresolved decisions    | 0 in this review (UC1 stays the owner's)  |
| Outside voice           | skipped (autoplan override; driver owns)  |
| Parallelization         | 5 lanes, 5 parallel / 3 sequential steps  |
| Lake Score              | N/A (no coverage choices asked; Y=0)      |
+====================================================================+
issues_found (Arch+CQ+Perf+Test gaps) = 9 + 8 + 8 + 16 = 41 ; critical_gaps = 3 ; mode = FULL_REVIEW
```

---

## TODOS.md updates (proposed entries from all phases; NOT written to the repo)

Format: What / Why / Pros / Cons / Context / Depends on. Disposition auto-decided (A = add, C = build now, B = skip).

1. **P2 (CEO D1) Wave 2: decompose the remaining >300-line functions outside wave-1 files.** What: `runCycle` 1,227, `applyHarness`
   1,167, `runPhaseSynthesizeInner` 1,043, `runImport` 956, `importFromContent` 910, `makeSubagentHandler` 884, `runConfig` 834 and the
   rest of the W5 baseline. Why: W5 only freezes them. Pros: shrinks the baseline, same bug-farm class. Cons: path churn vs open PRs.
   Context: baseline TSV rows name each function; W4 patterns (state object, registry, stages) apply. Depends on: wave 1 merged +
   72-hour revert window. **A.**
2. **P3 (CEO D2) `src/core/` regroup and `ai/gateway.ts` provider adapters.** Why: next layer of structure. Pros: navigability.
   Cons: large path churn; adapter design question. Context: plan NOT-in-scope. Depends on: D1 partly. **A.**
3. **P2 (CEO T3) Phase-named sync errors (`TODOS.md:5338`).** What: SyncRun phases name the failing phase in error/timeout text.
   Why: debuggability. Pros: small once SyncRun exists. Cons: changes golden text (intentional). Context: `src/commands/sync/*`.
   Depends on: wave 1 W4 sync. **A** (first follow-up).
4. **P3 (DX) Timestamp-based migration versions.** Why: sequential numbers collide under ~50 concurrent PRs. Pros: no rebase
   renumbering. Cons: `schema_version` semantics and runner changes. Context: generator's duplicate diagnostic is the stopgap.
   Depends on: W3. **A.**
5. **P3 (DX) Router-level admin auth (`express.Router` + `router.use(requireAdmin)`).** Why: structural auth. Pros: impossible to
   forget per route. Cons: changes middleware order pinned by goldens. Context: `serve-http-admin-api.ts`. Depends on: W4 serve-http. **A.**
6. **P2 (DX, conditional) Land jobs / hybrid / autopilot decomposition if cut from the window.** What: the plan's cut-line items with
   their goldens (A13, A15). Context: plan W4 cut line. Depends on: wave 1. **A** only if cut.
7. **P3 (DX O19) +3-month re-measure.** What: fix-commit causes (plan e) plus share of storage PRs editing both engines, conflicts on
   target paths per merged PR, remaining baseline rows (engine-sql, function-size), median rebase-to-merge. Context: git/GitHub
   queries recorded in the PR. Depends on: merge date + 3 months. **A.**
8. **Closure edits (DX)** for `TODOS.md:1868`, `:1956`, `:1962`, `:~1976`, `:~4445` when their workstream lands. **C** (in this PR).
9. **P3 (DX) Scaffolders for doctor check / route / command.** Decision: **B** (skip until O18 dry-run shows the need).
10. **P2 (Eng E-TODO-1) Extend RLS scope binding to reads master leaves unscoped.** What: move `LegacyUnscopedRead` methods (salience,
    facts, takes, code-edges reads and others in the inventory) to `ScopedRead`. Why: RLS layer 2 covers only 23 sites today. Pros:
    defense in depth on hosted Postgres. Cons: with `GBRAIN_RLS_SCOPE_BINDING=1`, adds a tx + pool hold per read (the #1794 class);
    needs PgBouncer load test. Context: W0 inventory golden lists them; brand makes the change a type edit. Depends on: wave 1 W1. **A.**
11. **P3 (Eng E-TODO-2) Autopilot tick extraction coordination.** What: if W4 autopilot lands, do the existing test-audit TODO
    ("Extract a testable autopilot tick function, then retire the 8 autopilot wiring greps") in the same change. Why: avoids
    re-pointing 8 grep files twice. Context: `TODOS.md` Test-audit follow-ups. Depends on: cut-line decision. **A** (annotation on
    the existing TODO, not a new entry).
12. **P3 (Eng E-TODO-3) Collapse per-domain parity tests into executor contract tests.** What: once every domain is in engine-sql,
    replace duplicated per-domain PGLite/Postgres parity scenarios with executor contract + one shared scenario suite per domain.
    Why: 28 parity files exist because of dual SQL. Pros: less test maintenance. Cons: retirement needs TESTING.md evidence per file.
    Context: TESTING.md "Retiring a test". Depends on: all domains migrated (W1-extended or wave 2). **A.**
13. **P2 (Eng E-TODO-4, conditional) W1-extended domains not landed in wave 1.** What: `pages, links, tags, timeline, sources, files,
    chunks` on the proven executor, each with its per-method inventory and baseline-row removal in the same commit (DX D35). Context:
    UC1 outcome. Depends on: UC1. **A** only if UC1 = W1-core.

---

## Decision Audit Trail (Eng phase)

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| E1 | Step 0 B | Scope accepted as-is; Original arrangement with naming fixes | Mechanical | P2, P6 | Owner's one-PR rule; every workstream serves a goal | Feature cuts; smaller arrangement that drops E1/T1 |
| E2 | SC1 | Move `Migration` type to `schema-migrations/types.ts`, type re-export from migrate.ts | Mechanical | P5 | Type is module-private today (`migrate.ts:61`) | Exporting from each migration file |
| E3 | SC2 | Leaf `schema-migrations/helpers.ts` for `migrationNotice`, quiet flag, `dropInvalidConcurrentIndex` | Mechanical | P5 | Avoids migrate.ts cycle and TDZ | Importing helpers from migrate.ts |
| E4 | SC3 | Registry file `registry.generated.ts` | Mechanical | P5 | Repo convention (`build-schema.sh:3-4`) | `index.ts` |
| E5 | SC4 | Goal (b) and W5 scoped to `src/**` minus generated | Mechanical | P3, P5 | Tests have >300-line describe callbacks | "Any touched file" |
| E6 | SC5/CQ1 | Adapter passes `{prepare:true, simple:false}`; no per-call resolvePrepare | Mechanical | P5, P3 | `connection.js:238` gates per-call prepare | CEO A4's per-call `resolvePrepare(url)` |
| E7 | AR1 | Executor resolved per call via getter; tx rollback contract test | Mechanical | P1, P5 | `Object.create(this)` tx clone | Instance field executor |
| E8 | AR2 | Preserve per-method RLS scoping; two brands; inventory golden | Taste (TE3) | P5 | Behavior-preserving goal; #1794 | Scope every migrated read now |
| E9 | AR3 | PGLite upgrade-replay test with master-built fixture | Mechanical | P1 | initSchema replays blob every boot | Fresh-install E4 only |
| E10 | AR4 | Layering test (no back-edges) via orphan-module walker | Mechanical | P5, P4 | Cycles and god-class regrowth | Review-only rule |
| E11 | AR5 | CLI records carry `phase` + `thinClient` mode; subcommand routing stays explicit code | Mechanical | P5 | `cli.ts:2103,2113,3012` | Plan's 6-field record; predicate fields for subcommands |
| E12 | AR6 | AST route golden on master + runtime golden after move-only `buildServeHttpApp` extract | Taste (TE1) | P5, P1 | No app handle on master | Test-only seam on master; AST only |
| E13 | AR7 | Snapshot inputs = import closure, asserted by test, feeds 11 CI keys | Mechanical | P1, P4 | Bootstrap not hashed today | Hand lists (A6/O7 wording) |
| E14 | AR8 | Command loaders must be literal `import()` (test) | Mechanical | P1 | bun --compile bundling | Computed specifiers |
| E15 | AR9/SC18 | Path-consumer re-point in W0; snapshot test with W3 | Mechanical | P6 | Per-commit gates need live guards | Doing it in W7 |
| E16 | CQ2 | Widen `executeRawJsonb` to `Pick<BrainEngine,'executeRaw'>` | Mechanical | P4 | One JSONB rule | Second JSONB helper |
| E17 | CQ3 | A2b via vetted builder registry + finite numerics; inlined literals stay | Mechanical | P1, P5 | `sql-ranking.ts:405`, `facts.ts:489` | Constant-allowlist-only rule; rewriting builders |
| E18 | CQ4 | Doctor entries return `Check[]` or `STOP` with explicit `DoctorContext`, `emits[]` | Taste (TE4) | P5 | Shared `schemaVersion`, early returns | One-check-per-entry registry |
| E19 | CQ6 | Adapter bypasses checkoutGauge; gauge golden | Mechanical | P5 | Tagged sites never counted | Route via executeRaw |
| E20 | CQ7 | One token normalizer; E3 wrapper + rename-map modes; `Mechanical-Rename` trailer | Taste (TE5) | P4, P5 | W3 wrappers and SyncRun rewrites | Naive token multiset only |
| E21 | CQ8 | Executor returns `{rows, affectedRows}` | Mechanical | P5 | `.count` vs `.affectedRows` | Per-domain driver checks |
| E22 | SC15 | A11 handler hash on normalized tokens | Mechanical | P5 | Re-indent changes `toString` | Raw source hash |
| E23 | SC19 | E5 runs through `executeRaw` on master, adapters after C10 | Mechanical | P5 | Executor absent on master | Undefined E5 target |
| E24 | SC20 | `build-schema.ts` evaluates fragments; template output keeps placeholders | Mechanical | P1 | Runtime policy in `getPGLiteSchema` | sed-based generation |
| E25 | T-G13 | Ordinal positions in PGLite master-vs-branch catalog | Mechanical | P1 | Name-based diff misses reorder | Name-only |
| E26 | T-G16 | Per-method SQL-text golden for converted Postgres methods | Mechanical | P1 | Parity fixtures miss clause drift | Result-only parity |
| E27 | PF3 | Engine-connect cold-start budget ≤ +20 ms; fallback = generated bundle, not dynamic import | Mechanical | P1, P5 | 175 modules on connect path | `--version` budget only |
| E28 | PF7 | Per-domain gates on default 4-VM Ubicloud fleet | Mechanical | P3 | Shared 256 vCPU quota | `--vms 10` |
| E29 | TODO | 13 TODO proposals dispositions as listed | Mechanical | P6 | Collected from all phases | Silent drops |
| E30 | SC22 | Preserve flag-registry `auth --dry-run` bug byte-identically | Mechanical | P5 | Behavior-preserving PR; existing TODO owns fix | Fixing inside the refactor |

## Taste decisions (for the final gate; all auto-chosen as recommended)

- **TE1** Route golden: AST golden on master + runtime golden after a move-only `buildServeHttpApp` extraction (recommended) vs adding
  a test-only seam on master first. Recommended because the extraction has a production caller and the AST golden proves the extract.
- **TE3** RLS: preserve master's per-method scoping (recommended) vs scope every migrated read now. Preserve keeps the PR
  behavior-preserving and avoids the #1794 pool-hold class; the improvement is E-TODO-1.
- **TE4** Doctor registry: `Check[] | STOP` entries with an explicit context (recommended) vs splitting doctor into fixed phases.
- **TE5** Move proof: normalizer with wrapper and rename-map modes plus a `Mechanical-Rename: yes` trailer (recommended) vs tagging
  only pure moves and leaving mechanical rewrites unverified.

User Challenges: none new. UC1 (W1 breadth) remains the owner's decision; Eng input: the executor, E5, EO1, EO4, EO6 and EO8 must be
green on W1-core before any W1-extended domain starts, whatever UC1 decides.

## ACCEPTED OBLIGATIONS (Eng; add to the plan)

| ID | Requirement | Verification |
|---|---|---|
| EO1 | Engine-sql executor is obtained through a getter over `this.sql` / `this.db` on every call (never stored in a field); adapters are cheap wrappers. | T-G1: write-then-throw inside `engine.transaction()` rolls back on PGLite and Postgres; a mutation that caches the executor at connect makes it fail (`check-test-discriminates.sh`). |
| EO2 | Postgres adapter calls `runUnsafe(conn, sql, params, { signal?, prepare: true, simple: false })`; `runUnsafe` forwards the two new opts to `unsafe()`; `executeRaw`/`executeRawDirect` unchanged. | Unit with fake conn asserts the options; T-G4 on direct PG + PgBouncer. |
| EO3 | PGLite upgrade replay: W0 pins master's PGLite data dir (snapshot tar + version) as a golden fixture; branch `initSchema` on it succeeds, catalog equals master, second boot is a no-op; `schema-bootstrap-coverage.test.ts` logic unchanged against the generated blob. | T-G2 in the unit lane; runs in every W2/E1 commit gate. |
| EO4 | W0 inventory golden of every Postgres engine read method's scoping mode (23 scoped sites vs unscoped). Engine-sql read functions accept `ScopedRead` or `LegacyUnscopedRead` matching master; brand casts banned by the engine-sql guard. | T-G3 unit (fake sql lanes per method) + e2e with `GBRAIN_RLS_SCOPE_BINDING=1`; `@ts-expect-error` fixture for a plain executor. |
| EO5 | CLI records carry `phase` and `thinClient` (`none`, `refuse`, `route-then-refuse`); subcommand routing stays explicit pre-dispatch code; W0 static golden of phase/thinClient/subcommand rules on master. | T-G6 golden equality + engine-free commands with unreachable DB match master exit code and first output line. |
| EO6 | Prepared-statement and protocol parity for converted queries. | T-G4 (`pg_prepared_statements` on direct PG, none on PgBouncer, no simple protocol for zero-arg). |
| EO7 | Snapshot hash inputs and all 11 CI cache keys cover the static import closure of the PGLite schema, migration registry, engine-sql bootstrap and migrate.ts. | T-G8 fails naming the missing file and both places; discrimination by removing one closure file. |
| EO8 | W0 captures the SQL text of every Postgres method converted in W1 (fake sql on master); converted method emits identical text modulo `$N` renumbering; inlined literals stay inlined. | T-G16; parity suite unchanged per domain commit. |
| EO9 | Adapter bypasses `checkoutGauge`; gauge snapshot golden after a fixed op sequence equals master. | T-G5. |
| EO10 | Layering: `engine-sql/**` imports no engine facade; `schema-migrations/**` imports no `migrate.ts`; helpers live in `schema-migrations/helpers.ts`; `Migration` type in `schema-migrations/types.ts`. | T-G9 with bad/good fixtures; `bun build --compile` smoke (`check-cli-executable.sh`). |
| EO11 | Doctor registry: `run(ctx)` returning `Check[]` or `STOP`, explicit `DoctorContext`, `emits[]`; ordered-name golden from a master AST extraction; null-engine / connection-failure / `--fast` goldens. | T-G10; W0 `doctor --json` goldens byte-identical. |
| EO12 | `scripts/build-schema.ts` evaluates TS fragment modules, emits `pglite-schema.generated.ts` as a template with `__EMBEDDING_DIMS__`/`__EMBEDDING_MODEL__` and policy hooks intact; `getPGLiteSchema(dims, model)` signature unchanged; `build:schema` command name unchanged; unknown construct exits non-zero. | E4 on dims 1536 and one non-default dims/model; fixture with an unknown construct fails; freshness guard fixtures. |
| EO13 | Every command table `load` is `() => import('<string literal>')`. | T-G7; `check-compile-autoload.sh`, `check-cli-executable.sh` green. |
| EO14 | Perf budgets add PGLite engine connect + initSchema cold start (snapshot on and off) ≤ +20 ms; hot paths within noise on PGLite, direct PG, PgBouncer. | T-G15 bench numbers in the PR body, master vs candidate, same machine. |
| EO15 | Goal (b) and `check-function-size.ts` scope = `src/**/*.ts` excluding `*.generated.ts`. | Guard fixture: a >300-line test callback is ignored; a >300-line src arrow fails. |
| EO16 | `executeRawJsonb` first param widened to `Pick<BrainEngine,'executeRaw'>`; engine-sql uses it for JSONB. | Typecheck; `rg -n "function executeRawJsonb" src` = 1; `test/sql-query.test.ts` unchanged and green. |
| EO17 | A2b scanner semantics per CQ3 (constant allowlist, vetted builder registry with reasons, `Number.isFinite` numerics). | T-G11 fixtures; FAIL/Why/Fix/See text (DX O9). |
| EO18 | Executor result contract `{ rows, affectedRows }`; domain code never reads driver-specific count fields. | T-G14 rows in E5 on both engines; grep guard: no `.count`/`.affectedRows` under `engine-sql/<domain>.ts`. |
| EO19 | Token normalizer in `scripts/lib/normalize-tokens.ts` shared by A11 hash and `verify-move-only.ts`; wrapper and rename-map modes; `Mechanical-Rename: yes` trailer for SyncRun-style rewrites. | T-G12. |
| EO20 | E5 runs on master through `engine.executeRaw`, then the identical table against the adapters from C10 on. | E5 receipts on master commit and C10. |
| EO21 | Guard re-points and path-consumer inventory land in W0; snapshot-closure test lands in the W3 commit. | Per-commit gate logs show the guards scanning new dirs from their first commit. |
| EO22 | `schema-bootstrap-coverage.test.ts` re-pointed to `engine-sql/bootstrap.ts` via a single-file positional loader; its "When you add a forward reference" steps updated; assertions unchanged. | A10 before/after listing in the PR; test green on both blobs. |

## Final aggregated implementation task list (commit sequence, ONE PR)

Effort assumptions (human ÷ CC): scaffolding ~100x, tests ~50x, features ~30x, refactor with regression proof ~20x, architecture ~5x.
Sources: C = CEO task, D = DX task, E = Eng obligation. P1 blocks ship, P2 same branch, P3 follow-up.

- [ ] **C0 (P1, human ~1d / CC ~1.5h)** — baseline — Outcome baseline (plan e): classify 6 months of fix commits; perf baselines (f + EO14) on PGLite, direct PG, PgBouncer. Files: PR body, `scripts/` bench. Verify: numbers recorded.
- [ ] **C1 (P1, human ~2d / CC ~2.5h)** — W0 goldens — migrations full-record golden (A11, normalized handler tokens EO19), E4 catalog snapshot both engines (+ordinal T-G13), hybrid golden (A13), doctor ordered names (AST) + `--json` goldens + early-stop goldens (EO11), serve-http AST route golden (AR6), CLI goldens incl. phase/thinClient/subcommand matrix (A16b, EO5), SQL-text goldens for W1-core Postgres methods (EO8), RLS scoping inventory (EO4), gauge golden (EO9), export-surface golden (O13), PGLite master data-dir fixture (EO3). Files: `test/fixtures/goldens/*`, new golden tests. Verify: all green on master.
- [ ] **C2 (P1, human ~1d / CC ~1h)** — W0 contracts — E5 binding matrix via `executeRaw` (EO20) incl. empty arrays, affectedRows, error pass-through (O14). Verify: green on PGLite, direct PG, PgBouncer.
- [ ] **C3 (P1, human ~1d / CC ~1h)** — W0 loaders + re-points — generalize `doctor-source.ts` per surface (A10, O17 markers); path-consumer inventory and scanner re-point with new-dir fixtures (O16, EO21); layering test (EO10). Verify: `test-reads-source-smell` counts only drop; guard self-test.
- [ ] **C4 (P1, human ~1d / CC ~1h)** — W5 — `check-function-size.ts` (src-only EO15, name-path keys D19, all function forms A18), 77-row baseline, manifest row, fixtures, TESTING.md section; trim touched TSV notes. Verify: `bun run check:guard-self-test`; verify timing <15 s.
- [ ] **C5 (P1, human ~4h / CC ~30m)** — W3 prep — `schema-migrations/types.ts`, `helpers.ts` (SC1, SC2); `normalize-tokens.ts` + `verify-move-only.ts` wrapper mode (E3, EO19). Verify: T-G12.
- [ ] **C6 (P1, human ~1d / CC ~1h, Move-Only)** — W3 split — 170 files `v<NNN>-<name>.ts`, generator `build:schema-migrations` + `registry.generated.ts` (SC3), duplicate/filename diagnostics (O10), `new:migration` scaffold (D8), migrate.ts runner only + re-exports; drop `region-exempt`; snapshot-closure test + 11 CI keys (EO7, O7). Verify: A11 golden, apply-from-empty and apply-from-older both engines == E4, verify-move-only receipt.
- [ ] **C7 (P1, human ~1.5d / CC ~2h)** — W2a — `scripts/build-schema.ts` (EO12), `pglite-schema.generated.ts` template, capability rules, banners, freshness guard. Verify: E4 master==branch (PGLite, dims default + non-default), EO3 upgrade replay, schema-bootstrap-coverage unchanged.
- [ ] **C8 (P2, human ~1d / CC ~1.5h)** — W2 T1 — generate schema.sql's 20 fragment-table regions. Verify: E4, freshness guard names source file.
- [ ] **C9 (P1, human ~1d / CC ~1h)** — W1 executor — `engine-sql/executor.ts`, `dialect-{pglite,postgres}.ts`, `normalize.ts`, brands (EO4), per-call getters (EO1), `runUnsafe` opts (EO2), gauge bypass (EO9), `{rows, affectedRows}` (EO18), `executeRawJsonb` widening (EO16), dynamic-SQL scanner (EO17), engine-sql ratchet + baseline TSV (D18). Verify: E5 on adapters, T-G1, T-G3, T-G4, T-G5, T-G14.
- [ ] **C10-C14 (P1, human ~1d each / CC ~1h each)** — W1-core domains, one commit each: `salience`, `facts`, `takes`, `code-edges`, `cjk-search`. Verify per commit: EO8 SQL-text golden, 28 parity files unchanged, source-isolation matrix, `ci:ubicloud` full gate (4 VMs), perf check.
- [ ] **C15 (P1, human ~1d / CC ~1.5h)** — E1 — `engine-sql/bootstrap.ts` single implementation, three callers incl. `db.ts:initSchema`; hash closure updated (EO7); coverage test re-pointed (EO22). Verify: legacy-shape boots both engines, EO3, full gate.
- [ ] **C16+ (P2, human ~1-2d each / CC ~1-2h each, only if UC1 includes)** — W1-extended per domain after its inventory; baseline rows removed in the same commit (D35). Verify: same as C10.
- [ ] **C17 (P1, human ~2d / CC ~2.5h)** — W4 sync — move-only to `src/commands/sync/` (Move-Only), SyncRun conversion (`Mechanical-Rename: yes`), behavior commit; destructuring guard; controlled-order tests (A17); `performFullSync`, `runSyncInner` -> `sync/args.ts`. Verify: sync suites, A17 tests, full gate.
- [ ] **C18 (P1, human ~1.5d / CC ~2h)** — W4 doctor — registry runner (EO11, D15, O5). Verify: W0 doctor goldens byte-identical, T-G10.
- [ ] **C19 (P1, human ~1.5d / CC ~2h)** — W4 serve-http — move-only `buildServeHttpApp` extract; runtime golden == AST golden (AR6); modules `serve-http-admin-api.ts`, `-mcp.ts`, `-spa.ts`, extend oauth/metrics (D10); split `/mcp` handler; extend admin-route guard (O8). Verify: route goldens, mutation test, `test/e2e/serve-http-oauth.test.ts`, authenticated outcome tests.
- [ ] **C20 (P1, human ~2d / CC ~2.5h)** — W4 cli — command table with `phase`/`thinClient` (EO5), literal loaders (EO13), derived sets, `main` decomposition; re-target `generate-flag-registry.ts` (O6). Verify: A16b + T-G6/T-G7 goldens, registry/TOOL_CATALOG/admin build zero diff, synthetic command test.
- [ ] **C21-C23 (P2, human ~1-1.5d each / CC ~1.5h each, cut line)** — jobs (A15, 24 handlers, supervisor probe), hybrid stages (A13), autopilot dispatch (+E-TODO-2). Verify: respective goldens.
- [ ] **C24 (P1, human ~4h / CC ~30m)** — ceilings — lower every touched `module-size-limits.tsv` ceiling; goal (b) check over touched src files. Verify: `check:module-size`, function-size report zero >300 in touched src.
- [ ] **C25 (P1, human ~1d / CC ~1h)** — W7 docs — CLAUDE.md invariants, CONTRIBUTING "Where does my change go?" (O1, O2), ENGINES, rls-and-you, infra-layer, key-files (split pages, D26), executor decision table (D14), ASCII diagram; `build:llms`. Verify: stale-phrase `rg` empty, `test/build-llms.test.ts`, `check-key-files-current-state.sh`.
- [ ] **C26 (P2, human ~4h / CC ~40m)** — W6 porting kit — AST moved-symbol map markdown + JSON (E2, O11), recipes, agent prompt, announcement (D34), squash-body summary (O12). Verify: every JSON `old` resolves to a `new` symbol on the candidate.
- [ ] **C27 (P2, human ~4h / CC ~1h)** — DX dry-run (O18) and new-guard timings (O15). Verify: six timings ≤ 30 min; each guard <15 s.
- [ ] **C28 (P1, human ~2h / CC ~20m)** — release — rebase, re-run all W0 goldens and full `ci:ubicloud` gate on the final candidate, PATCH bump via `/ship` (five-file version lockstep), CHANGELOG with generic placeholders (O20), TODOS entries 1-13 per dispositions. Verify: version gate, `check-privacy.sh`, full gate green.

Total estimate (whole amended wave, W1-core, cut-line items included): human team ~7-9 weeks; CC+gstack ~5-7 working days
(W0 ~1d, W5 ~0.2d, W3 ~0.3d, W2 ~0.5d, W1-core+E1 ~1.5d, W4 in-line ~1.2d, cut line ~0.6d, W6/W7 + release ~0.7d), plus up to
~1.5d for W1-extended if UC1 includes it.

### Unresolved decisions that may bite you later

None from this review. Every Eng issue was auto-decided (4 taste decisions above). UC1 (W1 breadth) is the owner's open
User Challenge from the CEO phase and gates C16+.

---

## Appendix: suppressed findings (confidence ≤ 4, not in the main report)

- (4/10) Express 5 `app.router.stack` is an internal structure; a minor Express upgrade could change its shape and break the runtime
  route golden. Mitigation if it happens: pin the introspection helper to the installed Express version in one test helper.
- (4/10) PGLite may bind JS `bigint` params differently from postgres.js for `int8[]`; E5 already covers `bigint > 2^53` scalars but
  not bigint arrays. Add a row if any W1-extended domain binds `int8[]`.
- (3/10) Generated `registry.generated.ts` with 170 static imports could slow `tsc --incremental` typecheck noticeably on Windows
  (verify's 120 s per-check cap). Measure during C6.

No durable learnings logged by this voice (read-only phase). Candidate learnings for the driver: "GBrain engine `transaction()`
clones the engine with `Object.create(this)` and a `sql`/`db` getter; any per-engine helper must resolve the connection per call"
(observed, confidence 9) and "postgres.js `unsafe()` per-call `prepare` is ANDed with the connection option
(`vendor/postgres/src/connection.js:238`); zero-arg `unsafe()` uses the simple protocol unless `simple:false`" (observed, 9).
