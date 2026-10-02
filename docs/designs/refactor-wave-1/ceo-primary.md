# CEO Review, primary voice: GBrain structural refactor (W1-W5, one PR)

- Plan under review: `~/.gstack/projects/garrytan-gbrain/autoplan-ceo-KudV1P/ceo-implementation.md`
- Repo / base: `garrytan/gbrain` at `608a174dc` (v0.60.10.0), clean tree
- Mode: **SELECTIVE EXPANSION** (autoplan override; auto-decided with the 6 principles, CEO tiebreak P1+P2)
- Depth: implementation-ready
- Status: read-only review. Nothing in the repo was modified. Measurements used a scratch TypeScript install under `~/.capy/work/refactor/scratch/` (the repo has no `node_modules`).

Verdict in two sentences: the diagnosis is right and W1 (one SQL implementation per domain) plus W5 (function-size ratchet) are the highest-leverage structural work available in this repo. But the plan undersells W1's risk (it is a rewrite of ~230 Postgres query call sites from postgres.js tagged templates to positional SQL, not a move), misstates the schema gap, and misses three silent-failure paths (RLS scope binding, the PGLite snapshot hash, per-route admin middleware) that must become explicit obligations before implementation.

---

## Pre-review system audit

### Claims vs measured reality

| Plan claim | Measured | Evidence | Impact |
|---|---|---|---|
| 451k lines, 1,473 files in `src/` | 451,218 lines, 1,473 `.ts` files | `find src -name '*.ts' \| xargs cat \| wc -l` | Confirmed |
| Engines 6,184 + 5,590 lines | Confirmed | `wc -l` | Confirmed |
| "160 methods each, 159 shared" | 188 (PGLite) / 190 (Postgres) class members incl. accessors, **180 shared**; shared-method bodies total 4,779 / 4,654 lines | TS AST over class members | Scale of W1 is larger than stated: ~4,700 lines per engine |
| 165 commits edited both engines | 165 of 188/196 | `git log` intersection | Confirmed; strongest evidence in the plan |
| "~8 parity test files" | **28** `*parity*`/drift files across `test/` and `test/e2e/` | `ls test test/e2e \| grep parity` | Better safety net than claimed |
| Per-engine domain files "split per engine, preserving duplication" | True, but `diff` of each pair differs on nearly every line (facts 901 diff lines for 786/697-line files; takes 804; salience 533) because PGLite uses `db.query($n)` and Postgres uses tagged `sql\`...\`` | `diff src/core/{pglite,postgres}-engine/<f>.ts` | **Merging is a rewrite of the Postgres call style, not a move** |
| `schema.sql` 75 vs `pglite-schema.ts` 47 `CREATE TABLE` | Raw grep yes, but the **composed** PGLite bootstrap (`PGLITE_SCHEMA_SQL`, which interpolates 9 imported TS schema fragments) has **71** tables vs **75** in `getPostgresSchema()`. Real deltas: Postgres-only `file_migration_ledger` (intentional, allowlisted), `code_edges_chunk`, `code_edges_symbol`, `dream_verdicts`; PGLite-only `slug_aliases`, `page_aliases` (Postgres gets them from migrations `migrate.ts:4839`, `:5030`) | Runtime import of both schema builders; `pglite-schema.ts:1-7,1266-1312` | The "reconcile a 28-table gap" framing is wrong; end-state parity is already gated by `test/e2e/schema-drift.test.ts` (columns + indexes) |
| PGLite = schema.sql minus RLS/roles/grants/advisory locks | Composed bootstraps differ by 71 vs 75 tables, 107 vs 117 indexes, 14 vs 16 functions, 16 vs 17 triggers, **19 vs 54 `ALTER TABLE`**, 1 vs 36 RLS mentions, 1 PGLite-only view; 94.8 KB vs 121.6 KB | `/tmp/stm.ts` statement census | The strip transform is materially more than "strip RLS"; see W2 findings |
| `schema.sql` is the single source | `schema.sql` **inlines copies** of 20 tables that PGLite imports from TS fragments (`persistence_*` x9, `shared_skill_*` x9, `oauth_grant_audit`, `page_write_guards`) | grep per table | There are **three** copies today, not two |
| Freshness guard "same shape as `check-pglite-embedded.sh`" | That script checks that a compiled binary embeds PGLite WASM assets; it is not a generated-file freshness guard | `scripts/check-pglite-embedded.sh:1-20` | Wrong model; use `check-tool-catalog-fresh.sh` / `check-skills-manifest-fresh.sh` |
| `migrate.ts` 7,307 lines, `MIGRATIONS` 175 entries ~6,600 lines | 7,307 lines; **170 entries**, versions 2..175, gaps {17,18,19,100}; array spans `migrate.ts:196-6780`; not in version order (runner sorts at `migrate.ts:7114`); 29 entries have `handler` closures, 24 `sqlFor`, 15 `transaction`, 99 `idempotent`, 1 `verify` | runtime import of `MIGRATIONS` | Golden hash must cover more than SQL |
| `doctor.ts buildChecks()` 662-4124, 3,460 lines, 235 pushes | `662-4105`, **3,444** lines, 235 `checks.push` | AST + grep | Confirmed (minor span drift) |
| `sync.ts performSyncInner()` 1349-4054, 46 `let`s; `runSyncInner` 1,001 | Exact: 2,706 lines, 46 `let`s; `runSyncInner` 4546-5546 (1,001). Also **`performFullSync` 4056-4491 = 436 lines**, not listed | AST | Goal (b) requires it too |
| `serve-http.ts runServeHttp()` 858-3108, 44 routes | Exact (2,251 lines, 44 `app.*(` registrations). Inner anonymous `/mcp` POST handler `2032-2446` = **415 lines** | AST | Route split alone does not meet goal (b) |
| `jobs.ts runJobs()` 1,554 + "18 inline handlers" | `runJobs` 633-2186 (1,554); **`registerBuiltinHandlers` 2200-3262 = 1,063 lines with 24 `register(` calls** | AST + grep | Handler count and function size understated |
| `cli.ts handleCliOnly()` 1,515, 62 cases | Exact (2095-3609, 62 `case`). Also **`main` 450-864 = 415 lines** | AST | Goal (b) requires `main` too |
| `hybrid.ts hybridSearch()` 1,310 | **1,244** (1122-2365). Also **`hybridSearchCached` 2432-2868 = 437 lines** | AST | Goal (b) requires it too |
| `autopilot.ts runAutopilot()` 1,111 | Exact (594-1704) | AST | Confirmed |
| `doctor-categories.ts` | Lives at `src/core/doctor-categories.ts`, not under `src/commands/` | `find` | Path fix |
| TypeScript compiler API in devDeps | `typescript ^5.6.0` devDep; `scripts/check-engine-dynamic-import.ts` already uses it | `package.json:185` | Confirmed; good precedent |
| "About 20 open fix PRs" touch hot files | `gh pr list` returned the 200-PR cap; **51** touch the hot files (doctor 19, pglite-engine 14, cli.ts 12, postgres-engine 12, autopilot 8, hybrid 6, jobs 5, migrate 4, schema.sql 3, pglite-schema 3, sync 3, serve-http 2) | `gh pr list --json files` | Conflict cost is ~2.5x what the plan budgets |
| jscpd 913 identical engine lines | Not re-run (no jscpd installed) | n/a | Unverified; not load-bearing |

### Missed hotspots inside the plan's own blast radius

- `src/core/pglite-engine.ts:1100-1703` `applyForwardReferenceBootstrap` (**604 lines**) and `src/core/postgres-engine/forward-reference-bootstrap.ts:34-688` `applyPostgresForwardReferenceBootstrap` (**655 lines**): the same engine-parity duplication W1 targets, and both violate goal (b). Not mentioned by the plan.
- Repo-wide there are **77 functions over 300 lines**; the plan's W4 list covers 9. Outside touched files the biggest are `cycle.ts runCycle` 1,227, `bootstrap/harness.ts applyHarness` 1,167, `cycle/synthesize.ts runPhaseSynthesizeInner` 1,043, `commands/import.ts runImport` 956, `import-file.ts importFromContent` 910, `minions/handlers/subagent.ts makeSubagentHandler` 884, `commands/config.ts runConfig` 834. W5's ratchet must freeze all 77 at current length on day one.

### Retrospective check (prior deferrals in TODOS.md this plan touches)

- `TODOS.md:1956` Wave 4a "decompose performSyncInner (own plan)" was **blocked by positional source-text guards** (`test/sync.test.ts` #132 prelude scan, `test/redos-hardening.test.ts` ordering).
- `TODOS.md:1962` Wave 4b "hoist buildChecks' inline checks.push literals, finish the doctor split".
- `TODOS.md:1976` P3 "Migrate-runner extraction (revisit only on evidence)" deferred because **9 slice-window source-text assertions in `test/migrate.test.ts` pin locality**.
- `TODOS.md:1868` P3 "full 3-way schema-blob parity test" (pglite-schema / schema-embedded.generated / schema.sql have no general drift guard).
- `TODOS.md:4445` TODO-V19-C doctor check registry (`{name, category, run}`), rejected once as too big for a fix wave.
- `TODOS.md:5338` make sync failures name the phase.

Recurring pattern: every previous attempt at these peels stalled on **source-text tests that pin code location**. Measured: at least 133 test files read these sources as text (cli.ts 79, jobs.ts 12, serve-http.ts 8, sync.ts 7, autopilot.ts 7, pglite-engine.ts 6, postgres-engine.ts 4, migrate.ts 3, doctor.ts 2 + `test/helpers/doctor-source.ts`, hybrid.ts 2, schema.sql 2, pglite-schema.ts 1). The plan's "zero test deletions or weakenings" is right, but it never says how those guards follow the code. That is the architectural concern to solve up front, not per workstream.

### Taste calibration

Good references to copy:
- `src/core/sql-query.ts` (`sqlQueryForEngine`, `executeRawJsonb`): an existing, deliberately narrow cross-engine executor with a documented contract and the JSONB rule baked in.
- `src/core/postgres-engine/salience.ts` / `pglite-engine/salience.ts`: "narrow explicit deps, never an engine-shaped bag" (CLAUDE.md invariant).
- `test/helpers/doctor-source.ts`: the right answer to source-text guards across a peel (containment loader vs positional single-file loader with a file-boundary sentinel).
- `scripts/check-engine-dynamic-import.ts` + `scripts/guards-manifest.tsv`: AST guard with a registry and bad/good fixtures.
- `src/core/search/read-policy-sql.ts`, `sql-ranking.ts`, `cjk-keyword-sql.ts`: shared SQL fragment builders already used by both engines.

Patterns to avoid:
- `doctor.ts buildChecks()` (3,444-line closure sharing locals).
- The `pglite-schema.ts:27-28` DRIFT WARNING comment that points at a file (`schema-embedded.ts`) and a test (`test/edge-bundle.test.ts`) that no longer exist. A written rule rotted; only guards survive here.

---

## Step 0

### 0A. Premise challenge (named)

- **P1 Parity drift is the root bug class, so W1 is the highest-value workstream.** ACCEPT. 165/188 PGLite-engine commits also edited the Postgres engine; the CLAUDE.md "Engine parity" invariant plus 28 parity test files exist only because of this. Do-nothing cost: every storage feature and every storage fix keeps paying 2x edits and a parity-bug tail.
- **P2 W1 is "move-dominant".** REJECT (factual). The two implementations use different driver idioms on nearly every line (Postgres: 231 tagged-template queries, 70 `.unsafe(`, 12 `sql.json`; PGLite: 115 `db.query(`). Unifying them converts Postgres call sites to positional SQL through `unsafe()`, which changes the driver path: `vendor/postgres/src/index.js:119-125` sets `prepare: false` for `unsafe` and uses the simple protocol when there are no args; `vendor/postgres/src/connection.js:244` adds a Describe step for unprepared parameterized queries. W1 must be treated as behavior-touching with its own proof obligations (binding matrix, prepared-statement parity, RLS scope). Amendment A2/A3/A4.
- **P3 There is a 75-vs-47 table gap to reconcile.** REJECT (factual). Composed bootstraps are 71 vs 75; post-init end-state parity is already enforced by `test/e2e/schema-drift.test.ts` with one allowlisted table. The real problem is three copies of the schema text (schema.sql inline copies, TS fragments, pglite-schema template) and the absence of catalog-level (constraints, triggers, functions, views) parity. Amendment A7/A8.
- **P4 PGLite bootstrap = schema.sql minus RLS/roles/grants/advisory locks.** PARTIALLY WRONG. The difference also includes 35 `ALTER TABLE`s, 10 indexes, 2 functions, 1 trigger, a PGLite-only view and the fragment imports. Generation is still the right direction but the transform must be proven by end-state equivalence, not by construction. Amendment A7.
- **P5 "Zero test deletions or weakenings" is achievable as literally written.** CLARIFY. ~133 test files read moved code as text. Re-pointing them through shared loaders (the `doctor-source.ts` pattern) is not a weakening; silently letting a positional guard become a containment guard is. Amendment A10 makes the policy explicit.
- **P6 Goal (b) "no function in the touched files exceeds 300 lines" is satisfied by the W4 list.** WRONG (scope). Touched files hold 8 more functions over 300 lines (see audit). Keep the goal (completeness), enumerate them, define "touched". Amendment A9.
- **P7 The 165-commit pattern becomes "structurally impossible".** OVERCLAIM. After W1 each new domain method still adds a one-line delegation in both engine classes (the `BrainEngine` interface requires it). What becomes impossible is two SQL implementations. Amendment A12 restates metric (a) and adds a guard.
- **P8 ~20 open PRs; move-only commits keep the rebase mechanical.** UNDERSTATED. 51 open PRs touch hot files. Move-only commits help *this* branch rebase; they do nothing for the 51 PRs that must rebase onto it after merge. Expansion E2 (moved-symbol map) addresses that.
- **P9 Behavior-preserving refactor with no schema change is the right thing to build now.** ACCEPT with one caveat raised as a User Challenge candidate (UC1: W1 domain breadth in the same PR).

### 0B. Existing code leverage

| Sub-problem | Existing code | Plan reuses it? | Verdict |
|---|---|---|---|
| Cross-engine SQL executor | `src/core/sql-query.ts` (`sqlQueryForEngine`, `executeRawJsonb`, `SqlValue`), `BrainEngine.executeRaw`, `ReadQuery` in `search/read-enrichment.ts:7` | Mentions read-enrichment/page-state, not sql-query.ts | Must build on sql-query.ts (DRY). Its scalar-only rule stays for auth; the store executor is a sibling that allows arrays with explicit casts |
| Shared SQL fragments | `search/read-policy-sql.ts`, `sql-ranking.ts`, `cjk-keyword-sql.ts`, `ENRICH_ORDER_SQL` in `types.ts` | No | Store modules must import these, not re-inline |
| RLS scope binding | `PostgresEngine.withScopedReadTransaction` (`postgres-engine.ts:281-312`, used at 18+ read sites) | Not mentioned | Store read functions must receive the scoped tx executor |
| Cancellation / pool accounting | `runUnsafe` (`postgres-engine.ts:5340`), `checkoutGauge`, `postgres-engine/cancellation.ts` | Not mentioned | Store executor on Postgres must route through `runUnsafe` |
| Prepared-statement policy | `db.resolvePrepare(url)` (`db.ts:76-110`) | No | Store executor passes `{prepare}` from the same resolver |
| Schema generation | `scripts/build-schema.sh` -> `schema-embedded.generated.ts` | Yes (extend) | Keep; add a PGLite output |
| Generated-file freshness guard | `check-tool-catalog-fresh.sh`, `check-skills-manifest-fresh.sh`, `check-eval-glossary-fresh.sh` | Points at the wrong script | Use these |
| End-state schema parity | `test/e2e/schema-drift.test.ts` + `test/helpers/schema-diff.ts`, `test/schema-bootstrap-coverage.test.ts`, `test/private-queue-schema-parity.test.ts` | Partly | Extend to catalog level (E4) |
| Snapshot invalidation | `computeSnapshotSchemaHash` (`pglite-engine.ts:334-366`), e2e.yml snapshot cache keys (`.github/workflows/e2e.yml:71,186`) | Not mentioned | Must be updated in the same commit as W2/W3 (A6) |
| Source-text guard portability | `test/helpers/doctor-source.ts` | No | Generalize for sync/cli/jobs/migrate/serve-http/hybrid (A10) |
| Doctor categories | `src/core/doctor-categories.ts` | Yes (wrong path) | Fix path |
| Peeled doctor checks | `src/commands/doctor/checks/` (32 modules), `bootstrap-checks.ts`, `schema-pack-checks.ts`, `skill-checks.ts`, `report-remote.ts` | Yes | Continue |
| serve-http peels | `serve-http-{admin-limits,clients,grants,metrics,oauth,registration}.ts` | Plan proposes a new `serve-http/` dir | Taste T2 |
| Minion handlers | `src/core/minions/handlers/*` (15 modules) | Plan proposes one `builtin-jobs.ts` | Use handlers/ per handler (A15) |
| Module-size ratchet | `scripts/check-module-size.sh` + `module-size-limits.tsv` | Yes | Extend with the function-size sibling |
| AST guard precedent | `scripts/check-engine-dynamic-import.ts`, `guards-manifest.tsv`, `guard-self-test.sh` | Partly | New guard registered with fixtures (A18) |

No sub-problem needs a rebuild from scratch.

### 0C. Dream state mapping

```
  CURRENT STATE                         THIS PLAN (as amended)                    12-MONTH IDEAL
  two engines x ~4,700 lines of   --->  one store/<domain> SQL module per  --->   one data-access layer; engines are
  duplicated SQL in two driver          domain on a narrow executor; engines       thin dialect adapters (<1,500 lines);
  idioms; 3 schema copies; 170          delegate; PGLite bootstrap generated;       schema defined once as ordered TS
  migrations in one array; 9 god        migrations one file each; 9 god             fragments that generate both engines'
  functions (1,000-3,400 lines);        functions + 8 more split; function-         bootstrap and schema.sql; parity tests
  77 functions >300 lines; no           size ratchet freezes the other ~60;         become executor contract tests; every
  function-size guard                   catalog-level schema parity gate            command/check/route is a registry entry;
                                                                                    no function >300 lines anywhere
```

The plan moves roughly 60% of the way. The remaining 40% is wave 2 (gateway, cycle, import, bootstrap harness, schema.sql itself generated from fragments if T1 is deferred).

### 0D. Approach alternatives

No required approach choice blocks Step 0: the plan's approach (extract-and-delegate, one PR) matches the owner's standing rule and the repo's façade convention. Alternatives considered and not selected:
- (B, smallest) W5 ratchet + W3 split only: cheap, but leaves the parity bug class untouched. Rejected under P1.
- (C, larger) Replace both engines with a query builder / ORM layer: no evidence it beats narrow executor + raw SQL here, adds a dependency, conflicts with JSONB/pgvector/CJK specifics. Rejected under P3/P5.

W1 breadth inside approach A is raised as UC1 (not decided).

### 0E. Mode

Mode: SELECTIVE EXPANSION (set by the autoplan driver). Approved decisions at entry: owner constraints (one integrated PR, PATCH bump, no real names in public artifacts). File-count heuristic would recommend REDUCTION (>15 files); overridden by the driver and by the owner's fix-wave rule. No new approach decision was needed.

### 0F/0G. Expansion analysis and cherry-picks

HOLD-SCOPE checks first:
1. Complexity: far above 8 files / 2 new services. Justified only because each workstream removes more surface than it adds; the risk is concentrated in W1, which is where the obligations go.
2. Minimum change for the goal: W1 on the domains with the most co-change + W3 + W5. Everything else is deferrable without blocking, but the owner wants the whole wave; no deferral forced.
3. Invariants to keep: façade exports (CLAUDE.md "Peeled façades keep their surface"), engine-dynamic-import rule, JSONB rule, source isolation, module-size ratchet semantics.

10x check: the 10x version is "storage features are written once and cannot drift", which W1 delivers if the executor contract is right. The 2x-effort add that gets closest is making the executor contract testable in isolation (binding matrix, E5), which turns 28 parity tests' worth of worry into one contract suite.

Delight scan (adjacent, small):
- E2 moved-symbol map for the 51 overlapping PRs.
- E3 mechanical move-only verifier for review.
- E9 admin-route auth invariant test.
- Actionable function-size guard failure text (names the extraction pattern and the TSV row to edit).
- Engines key-files entry gets an ASCII diagram of store -> executor -> dialect adapter.

| # | Proposal | Effort | Risk | Decision | Principle / reasoning |
|---|---|---|---|---|---|
| E1 | Dedupe forward-reference bootstrap (`pglite-engine.ts:1100-1703` + `postgres-engine/forward-reference-bootstrap.ts:34-688`) into one store module with dialect hooks | M (CC ~3h) | Medium (bootstrap DDL for old brains) | **ACCEPTED** | P2: same parity class as W1, in blast radius, <1d; also required by goal (b) |
| E2 | Generated moved-symbol map (old `file:function` -> new `file:function`) in PR body + `docs/architecture` note, for rebasing the 51 open PRs | S (CC ~30m) | Low | **ACCEPTED** | P2/P6: cheap, directly reduces the real cost of this PR |
| E3 | `scripts/verify-move-only.ts`: for commits tagged move-only, prove normalized token multisets are preserved (import lines excepted); used by reviewers, not wired into verify | S (CC ~45m) | Low | **ACCEPTED** | P5: "git diff --color-moved" is not proof at ~50k moved lines |
| E4 | Extend `schema-drift.test.ts` from columns+indexes to catalog level: constraints (incl. CHECK text), triggers, functions (signature + body hash), views, column defaults | S-M (CC ~1h) | Low | **ACCEPTED** | P1: this is the equivalence proof W2 needs anyway; closes `TODOS.md:1868` |
| E5 | Executor binding-matrix contract test (arrays text/int/real, JSONB object/array, bigint, Date, null, boolean, vector literal) on both engines, run before any W1 conversion | S (CC ~1h) | Low | **ACCEPTED** | P1: turns the W1 risk into a gated precondition |
| E9 | serve-http route snapshot includes per-route middleware chain; invariant test that every `/admin/api/*`, `/metrics`, `/admin/events` route has `requireAdmin` except an explicit allowlist (`/admin/login`, `/admin/api/issue-magic-link`, `/admin/auth/:token`) | S (CC ~45m) | Low | **ACCEPTED** | P1: security-sensitive routes are the stated motivation of the split |
| T1 | Generate `schema.sql`'s 20 inline fragment tables from the TS fragment modules so schema text has exactly one copy | M (CC ~3-4h, 4-11 files) | Medium (Postgres canonical file generation path) | **TASTE DECISION** (recommend include) | P1 vs P3: W2 is titled "one schema source of truth"; without T1 there are still two copies. Borderline size |
| T2 | serve-http route modules: flat `serve-http-<area>-routes.ts` (existing convention) vs new `serve-http/` directory | S | Low | **TASTE DECISION** (recommend flat) | P5/P3: one convention, zero churn of 6 existing modules |
| T3 | SyncRun phases name the failing phase in sync error/timeout messages (`TODOS.md:5338`) | S (CC ~1h) | Low | **TASTE DECISION** (recommend defer) | Goal says behavior-preserving; golden outputs stay byte-identical; do it as the first follow-up |
| R1 | Cyclomatic-complexity guard alongside function size | S | Low | **REJECTED** | YAGNI; function size is the measured failure mode |
| D1 | Decompose the other ~60 >300-line functions outside touched files (runCycle, applyHarness, runImport, ...) | XL | Medium | **DEFERRED** (TODOS, wave 2) | Outside blast radius; W5 freezes them |
| D2 | `src/core/` directory regroup, `ai/gateway.ts` | L | Medium | **DEFERRED** (plan's own NOT-in-scope) | Agree with plan's rationale |

### 0H. Spec review loop (inline adversarial review of the plan spec)

Reviewer: this voice, inline (no subagent dispatch per driver override). One pass, five dimensions.

| # | Dimension | Issue in plan spec | Accepted amendment |
|---|---|---|---|
| S1 | Feasibility | W1 called move-dominant; it rewrites Postgres query call style | A2: W1 is behavior-touching; per-domain commits each gated by e2e parity |
| S2 | Completeness | `SqlExecutor` contract silent on RLS scope, cancellation, pool gauge, prepare mode, reserved connections | A3, A4 |
| S3 | Completeness | "row-normalization helper" has no acceptance criteria | A5: per-type contract tests on both engines |
| S4 | Completeness | W3/W2 move files that feed `computeSnapshotSchemaHash` and the CI cache key | A6 |
| S5 | Consistency | "reconcile 75-vs-47 gap" contradicts existing schema-drift gate; wrong freshness-guard model | A7, A8, A14 |
| S6 | Clarity | Goal (b) "touched files" undefined; list incomplete | A9 |
| S7 | Consistency | "zero test changes" vs 133 source-text tests | A10 |
| S8 | Clarity | Golden hash "byte-identical SQL" ignores `sqlFor`, flags, 29 handlers; "175 entries" wrong | A11 |
| S9 | Clarity | Metric (a) overclaims | A12 |
| S10 | Clarity | "existing eval fixtures" for hybrid undefined; `hybridSearchCached` omitted | A13 |
| S11 | Completeness | serve-http route-table snapshot may omit middleware; `/mcp` handler 415 lines | A16, E9 |
| S12 | Feasibility | jobs "18 handlers" into one `builtin-jobs.ts` would be a 1,000-line file; supervisor dynamically imports `registerBuiltinHandlers` from jobs.ts (`supervisor.ts:859`) | A15 |
| S13 | Completeness | SyncRun: no rule against snapshotting mutable fields; no ordering tests | A17 |
| S14 | Completeness | New guard not registered in `guards-manifest.tsv`; no fixtures | A18 |
| S15 | Completeness | Commit/land order across workstreams unspecified | A19 |
| S16 | Completeness | PR conflict fallout for 51 PRs | E2 |

Score: 6/10 before amendments (strong diagnosis, weak acceptance criteria on the risky parts); all 16 issues have accepted amendments; remaining open items are UC1 and taste decisions T1-T3. Metrics (not persisted by this voice; driver owns the analytics write): iterations=1, issues_found=16, issues_fixed=16 (as amendments), remaining=0 spec issues + 1 user challenge + 3 taste decisions.

### 0I. Temporal interrogation

```
HOUR 1 (foundations): capture goldens on master BEFORE any move: doctor --json (normalized), route table
                      with middleware chain, migrations golden (A11), catalog snapshot both engines (E4),
                      hybrid ranked output (A13), cli --help/--tools-json + thin-client refusal matrix,
                      function-size baseline TSV. Write the binding-matrix test (E5) and make it pass on master.
HOUR 2-3 (core):      ambiguity: which engine methods are "semantically identical"? Answer by per-method SQL
                      normalization diff, not eyeballing; methods whose SQL differs semantically stay in engines
                      and are listed. Ambiguity: scoped vs unscoped executor per store function (A3).
HOUR 4-5 (integration): surprises: ~133 source-text tests break (A10); snapshot hash + e2e.yml cache keys (A6);
                      supervisor dynamic import of registerBuiltinHandlers (A15); postgres.js unsafe() defaults
                      to prepare:false + Describe round trip (A4); doctor golden needs volatile-field masking.
HOUR 6+ (polish):     they will wish they had: moved-symbol map for 51 PRs (E2), move-only verifier (E3),
                      the function-size TSV seeded from the real 77-row baseline, key-files updates + build:llms.
```

Effort (whole amended wave): human team ~7-9 weeks; CC+gstack ~6-8 working days (W1 incl. E1/E5 ~3d, W2+E4(+T1) ~1d, W3 ~0.5d, W4 ~2d, W5 ~0.5d, integration + rebase + full gate ~1d). Feasibility blockers: none, provided A3/A4/A6 are accepted. Pending choices: UC1, T1, T2, T3.

---

## Current scope (entering Section 1)

- Mode: SELECTIVE EXPANSION (driver override).
- Accepted: W1-W5 as written plus amendments A1-A19 and expansions E1, E2, E3, E4, E5, E9.
- Deferred: D1 (other >300-line functions outside touched files), D2 (core regroup, gateway, cycle/extract/embed/import-file/init: plan's own wave 2).
- Rejected: R1.
- Pending: UC1 (user challenge), T1, T2, T3 (taste).

## Section 1: Architecture review

System architecture after the amended plan:

```
                        CLI (src/cli.ts)                 MCP / HTTP (serve-http*.ts, mcp/*)
                  main() -> COMMAND_TABLE[name]      route modules register on app (shared ctx)
                              |                                   |
                              v                                   v
                     src/core/operations.ts  (contract-first; unchanged)
                              |
                              v
                 BrainEngine interface (engine.ts; unchanged surface)
                  /                                   \
     PGLiteEngine (façade, <2,500)              PostgresEngine (façade, <2,500)
     - connect/WASM/checkpoint guard            - pool, PgBouncer, advisory locks,
     - transaction, reserved conn                 cancellation, withScopedReadTransaction (RLS)
     - one-line delegations  ---.       .---    - one-line delegations
                                 v     v
                      src/core/store/<domain>.ts   (pages, links, tags, timeline, sources, files,
                      facts, takes, salience, code-edges, cjk-search, chunks, bootstrap[E1])
                                 |
                                 v
                StoreExecutor (narrow; sibling of sql-query.ts)
                  query(sql, params, {signal})  -> rows
                  scoped(read)                  -> executor bound to RLS tx (Postgres) / identity (PGLite)
                  normalize(row, shape)         -> one row-normalizer (jsonb, bigint, Date, vector)
                  /                          \
     PGLite adapter: db.query           Postgres adapter: runUnsafe(conn, sql, params, {prepare})
                                         prepare from db.resolvePrepare(url); gauge; AbortSignal

  Schema:   src/core/schema/*.ts fragments (+T1) --> build-schema.sh --> schema-embedded.generated.ts (PG)
                                                                     --> pglite-schema.generated.ts (PGLite)
  Migrations: src/core/migrations/v<NNN>-<name>.ts --> migrations/index.ts (static imports) --> migrate.ts runner
  Guards:   check-module-size.sh + check-function-size.ts (new) + freshness guard for generated schema
```

Findings:
- **CRITICAL GAP (A3) RLS scope binding.** `PostgresEngine` wraps 18+ read paths in `withScopedReadTransaction` (`postgres-engine.ts:281-312`), which sets `app.scopes` via `set_config` inside the tx when `rlsScopeBindingEnabled`. A store function that calls a plain engine-level executor instead of the scoped tx executor silently drops the RLS scope binding. Nothing in the plan's `SqlExecutor` shape prevents this.
- **WARNING (A4) Driver path change.** Postgres store calls go through `unsafe()`: `prepare:false` by default (`vendor/postgres/src/index.js:122`), simple protocol with zero args, Describe-first for unprepared parameterized queries (`connection.js:244`). On a direct (prepare=true) Supabase connection this adds a round trip to hot paths (`searchVector` 229 lines, `searchKeyword`, `_upsertChunksOnce` 242 lines) and changes result typing for the zero-arg case.
- **WARNING Coupling.** New coupling store -> executor is justified; it replaces engine -> two copies. Before/after: engines currently import 5 per-engine domain modules each; after, both import one store module per domain. No new cycles if store modules never import engine files (enforce with a guard or an orphan-modules style check; add to A18).
- **OK Scaling.** No new runtime work at 10x/100x beyond A4.
- **OK SPOF.** None added; the store becomes a shared dependency, which is the point.
- **WARNING Rollback posture.** Single squash-revert restores everything (no schema change). After ~1 week of other PRs rebasing onto it, revert becomes a multi-hour conflict job. Rollback window is realistic for ~3 days post-merge; A19 lands it right after a release so a PATCH revert is cheap.
- What makes this obvious to a new engineer: one directory per concern (`store/`, `migrations/`, `schema/`), a README-level ASCII diagram in `docs/architecture/key-files/engines-*.md`, and a guard that rejects SQL string literals in engine façades for migrated domains (A12).
- Platform potential: a third engine (e.g. SQLite for edge, or a hosted API adapter) becomes an adapter + dialect hooks rather than a 6,000-line class.

Accepted cherry-pick fit: E1 fits (same executor); E4/E5 are tests; E9 is serve-http only. No coupling concerns.

## Section 2: Error & rescue map

```
METHOD/CODEPATH                          | WHAT CAN GO WRONG                              | EXCEPTION CLASS
-----------------------------------------|------------------------------------------------|---------------------------
store.<domain>.* via StoreExecutor       | constraint/deadlock/serialization errors        | PostgresError (code 23505, 40P01, 40001), PGlite error
                                         | array/JSON param type not inferable (unsafe)    | PostgresError 42P18 / 42804
                                         | JSONB bound as JSON.stringify -> string scalar  | none (silent)
                                         | read called with unscoped executor              | none (silent RLS bypass)
                                         | caller aborts                                  | DOMException AbortError
                                         | connection dies mid-statement                   | PostgresError / ECONNRESET
row normalizer                           | bigint as string, Date vs ISO, jsonb as string  | none (silent type drift)
forward-reference bootstrap (E1)         | probe DDL fails on old brain shape              | PostgresError / PGlite error
migrations/index.ts registry             | missing import / duplicate version / dropped    | TS compile error / registry test / none (silent gap)
build-schema.sh PGLite transform         | unmatched RLS/GRANT block, dialect construct    | script exit !=0
generated schema freshness               | edited schema.sql, not regenerated              | guard exit 1
computeSnapshotSchemaHash                | migration file not in hash inputs               | none (silent stale snapshot)
doctor registry runner                   | a check throws                                 | Error (per-check today)
cli COMMAND_TABLE                        | unknown command / thin-client refusal missing    | usage error / none (silent local exec)
serve-http route modules                 | route registered before its middleware / w/o requireAdmin | none (silent auth bypass)
SyncRun phases                           | stale snapshot of mutable field across await    | none (silent partial sync)
hybrid stages                            | arm failure / reranker failure                 | existing rethrow semantics (hybrid-arm-rethrow.test.ts)
check-function-size.ts                   | parse failure / unlisted >300 fn                | exit 2 / exit 1
```

```
EXCEPTION CLASS                  | RESCUED?   | RESCUE ACTION                                        | USER SEES
---------------------------------|------------|------------------------------------------------------|--------------------------
PostgresError 23505/40P01/40001  | Y (callers)| store NEVER catches/wraps; callers keep err.code checks (isDeadlockError migrate.ts) | same as today
PostgresError 42P18/42804        | N <- GAP   | E5 binding matrix fails in CI before conversion ships | nothing (caught pre-merge)
JSONB string scalar              | N <- GAP   | check-jsonb-params.mjs + e2e postgres-jsonb + E5      | nothing if gated
Unscoped read (RLS)              | N <- GAP   | A3 branded ScopedExecutor type + e2e with RLS on       | nothing if gated
AbortError                       | Y          | executor forwards opts.signal to runUnsafe            | same as today
Connection death                 | Y          | supervisor reconnect (unchanged); no per-call retry   | same as today
Normalizer type drift            | N <- GAP   | A5 per-type contract tests both engines               | nothing if gated
Bootstrap probe failure (E1)     | Y          | same error surfacing as today; old-brain e2e fixtures | same as today
Registry missing/dup version     | Y          | A11 golden version list + uniqueness test             | CI failure
Transform failure                | Y          | set -euo pipefail; fixture tests                      | CI failure
Stale generated schema           | Y          | freshness guard (A14)                                 | CI failure
Stale snapshot hash              | N <- GAP   | A6 hash covers migrations dir + generated schema; test asserts coverage | CI failure
Doctor check throws              | Y          | preserve per-check try/catch semantics; golden        | same as today
CLI unknown/refusal              | Y          | golden help + refusal matrix (A16b)                   | same as today
Missing requireAdmin             | N <- GAP   | E9 invariant + middleware-chain snapshot              | CI failure
SyncRun stale field              | partial    | A17 no-destructure rule + controlled-order tests      | CI failure
```

Rule applied: no new catch-alls. The store and the executor must not catch; error class, code and message text reaching callers must be byte-identical (callers and tests match on them).

## Section 3: Security & threat model

| Threat | Likelihood | Impact | Mitigated by plan? | Amendment |
|---|---|---|---|---|
| RLS scope binding dropped when a read moves to the store | Med | High (cross-scope read on hosted Postgres with RLS binding on) | No | A3 (branded scoped executor, e2e with `rlsScopeBindingEnabled`) |
| Admin route loses `requireAdmin` or rate limiter during route-module split (auth is per-route, `serve-http.ts` routes at 858+598..1027 of the function) | Med | High | Partially (route-table snapshot, middleware unspecified) | A16, E9 |
| Middleware order drift (cookieParser, CORS gates for `/token` `/register` `/revoke`, `express.json` on `/register`, legacy PRM path) | Low-Med | High | Yes (order asserted) | A16 captures order with handler identity |
| Source isolation regression (`sourceScopeOpts`) when SQL moves | Med | High (cross-source leak) | No explicit | A5b: store functions take the resolved scope explicitly; existing source-isolation tests must stay green unmodified |
| JSONB double-encode on converted Postgres paths (silent data corruption) | Med | High | Guards exist | E5 + keep `check-jsonb-params.mjs` scanning `src/core/store/` |
| SQL injection via dynamic fragment composition (tagged-template fragments become string concatenation) | Med | High | No | A2b: only identifier/ordering fragments from constant allowlists may be concatenated; all values positional; add a scanner rule for `${` inside store SQL template literals except whitelisted helpers |
| Trust boundary (`ctx.remote`) | Low | High | Unchanged | none; W4 cli table must keep `remote:false` setting at the same place |
| Thin-client refusal bypass (a command runs locally against a remote brain) | Low-Med | Med | "identical" asserted, not tested | A16b refusal matrix golden |
| New dependencies / secrets | None | n/a | n/a | none |
| Audit logging | Unchanged | n/a | n/a | `mcp_request_log`, grant audit untouched |

## Section 4: Data flow & interaction edge cases

Store call data flow:
```
caller (op handler) -> engine.method(args, opts) -> store.domain.fn(exec, args)
   INPUT: args, opts.sourceIds/sourceId, opts.signal
   VALIDATION: unchanged (engine/ops layer), clampSearchLimit etc.
   TRANSFORM: build SQL + positional params (arrays with explicit ::type[] casts, jsonb as raw object)
   PERSIST/READ: exec.query(sql, params, {signal})  [Postgres: inside withScopedReadTransaction for reads]
   OUTPUT: normalize(rows) -> typed result
 shadow paths:
   nil args / empty arrays   -> today's behavior (e.g. setEmotionalWeightBatch returns 0 on []); E5 covers empty array binding
   wrong type / too long     -> PostgresError surfaces unchanged
   timeout / abort           -> AbortError unchanged
   conflict / dup            -> ON CONFLICT semantics unchanged (SQL text preserved)
   stale / encoding          -> normalizer contract (A5): bigint, Date, jsonb, vector, text[]
```

Generated schema flow:
```
schema fragments + schema.sql --> build-schema.sh --> {schema-embedded.generated.ts, pglite-schema.generated.ts}
   shadow: fragment edited, generation not run -> freshness guard fails
           transform meets unknown construct   -> script fails loud (no silent drop)
           end-state differs                   -> E4 catalog snapshot vs golden fails
```

Async ordering (SyncRun, A17):
```
invariant: every phase and every watchdog/timeout callback reads and writes the SAME SyncRun fields;
           a checkpoint written by finalize reflects all deletes/renames/imports that committed.

 time | phase task (imports)           | stall watchdog / timeout timer      | SyncRun
 t0   | run.imported = 10; await batch |                                     | imported=10
 t1   | (paused at await)              | reads run.imported -> 10, sets      | stalled=true
      |                                | run.stalled = true, aborts signal   |
 t2   | resumes; checks run.stalled    |                                     | phase exits, finalize
 BAD  | const { stalled } = run  (snapshot before t1) -> never sees stall -> keeps importing after abort
```
Mechanism that prevents the bad order: SyncRun fields are only accessed through `run.<field>` (no destructuring of mutable fields, enforced by a source guard over `src/commands/sync/`), exactly as the 46 closure `let`s behave today. Regression proof: controlled pause/release tests for (phase await vs watchdog fire) and (phase await vs timeout) in both completion orders, asserting abort observed and checkpoint contents.

Interaction edge cases (CLI/HTTP surfaces are the "UI" here):

| Interaction | Edge case | Handled? | How |
|---|---|---|---|
| `gbrain <cmd>` via table | unknown command, alias, `--help` placement | Must be | golden help/usage + exit codes (A16b) |
| thin-client mode | CLI-only command against remote brain | Must be | refusal matrix golden |
| doctor | check throws, `--json`, `--source`, `--scope=brain` | Must be | normalized golden on seeded brain for each flag combo used in tests |
| HTTP routes | duplicate registration, 404 fallthrough to SPA `/admin/{*path}` | Must be | route snapshot includes SPA fallthrough order |
| sync | Ctrl-C mid-phase, timeout, stall, resume from checkpoint | Existing tests | + A17 ordering tests |
| jobs worker | handler registration probe (`supervisor.ts:859`) | Must be | keep `registerBuiltinHandlers` exported from jobs.ts (A15) |

## Section 5: Code quality review

- **DRY (A1):** the proposed `SqlExecutor` duplicates `src/core/sql-query.ts` intent. Put the store executor next to it (or extend it) and keep its documented contract style; share `SqlValue` and the JSONB helper.
- **DRY:** store modules must import `read-policy-sql.ts`, `sql-ranking.ts`, `cjk-keyword-sql.ts` rather than inline predicates (salience already imports `pageReadFilter` in both engines).
- **Organization (A15):** jobs handlers go to `src/core/minions/handlers/<name>.ts` (existing dir, 15 modules), one per handler; `registerBuiltinHandlers` becomes a short table in jobs.ts or `minions/builtin-handlers.ts` and stays re-exported from jobs.ts.
- **Naming:** migration files `v<NNN>-<kebab-name>.ts` with zero-padded 3 digits (versions reach 175; gaps 17-19 and 100 preserved, no renumbering). Store modules named by domain, matching the existing per-engine names (`facts`, `takes`, `salience`, `code-edges`, `cjk-search`).
- **Consistency (T2):** serve-http already peels into flat `serve-http-*.ts`; a second convention (`serve-http/`) is avoidable.
- **Path fix:** `doctor-categories.ts` is `src/core/doctor-categories.ts`.
- **Under-engineering:** "one row-normalization helper" needs a declared shape per call (column -> kind), not a guess on value type; guessing re-introduces engine branching implicitly (A5).
- **Over-engineering risk:** do not build a query builder. Raw SQL strings + positional params + constant fragment helpers only.
- **Complexity:** the new function-size guard must count arrow functions assigned to variables/properties, object-literal methods, class property initializers and nested closures (the 415-line `/mcp` handler is an anonymous arrow); the plan's "AST-based" is right but must be explicit (A18).
- **Stale comment:** `pglite-schema.ts:27-28` references non-existent `schema-embedded.ts` and `test/edge-bundle.test.ts`; W2 deletes it with the hand-maintained file.
- **module-size-limits.tsv notes:** longest rows are 3,401 / 4,691 / 6,397 chars; trimming touched rows to one line is good hygiene and in scope.

## Section 6: Test review

New things and their proof:

```
NEW THING                               TYPE          HAPPY                    FAILURE                          EDGE
StoreExecutor (both adapters)           unit+E2E      E5 matrix round-trips    42P18 on bad array cast caught   [], null, bigint > 2^53, Date tz
Scoped read executor (RLS)              E2E (PG)      scoped read sees scope   unscoped call fails type-check   rlsScopeBindingEnabled on/off
Row normalizer                          unit+E2E      per-kind parity          unknown kind throws              jsonb scalar vs object, vector
store/<domain> modules                  E2E parity    existing 28 parity files unchanged + engine-parity.test.ts
E1 bootstrap dedupe                     E2E           old-brain fixtures boot  probe DDL failure surfaces       both engines, fresh + legacy shape
Generated PGLite schema                 unit+E2E      E4 catalog == golden     transform unknown construct      dims != 1536, custom model
Freshness guard                         guard         clean tree passes        edited schema.sql fails          fixture bad/good
Migrations registry                     unit          golden list == master    dup/missing version fails        gaps 17-19,100 preserved
Snapshot hash coverage (A6)             unit          every migrations/*.ts + generated schema in hash inputs   removed file fails
doctor registry runner                  unit+CLI      normalized golden --json  check throws -> same status      --source, --scope=brain
cli COMMAND_TABLE                       unit+CLI      golden --help/--tools-json  unknown cmd exit code          thin-client refusal matrix
serve-http route modules                unit          route+middleware snapshot  E9 missing requireAdmin fails   SPA fallthrough order
jobs handlers                           unit          24 names registered, same order  supervisor probe path     quiet flag
SyncRun phases                          unit          existing sync tests      A17 ordering tests (2 pairs)     resume from checkpoint
hybrid stages                           unit          ranked IDs+scores == golden (A13)  arm rethrow unchanged  cached path (hybridSearchCached)
check-function-size.ts                  guard         baseline passes          new 301-line fn fails            arrow/obj-method/class-prop fixtures
verify-move-only.ts (E3)                unit          pure move passes         edited token fails               import-only changes allowed
```

Assertion checks tied to requirements:
- "Check names, order, statuses and JSON output byte-identical": assertion is equality of the normalized `doctor --json` document (mask timestamps, durations, absolute paths, versions, PIDs); rejects a reordered or renamed check.
- "Retrieval output identical": assertion is exact equality of `(id, score)` lists at full float precision on a deterministic fixture (stub embedder, seeded PGLite, fixed config, cache cold and warm); rejects any rank or score change.
- "Byte-identical SQL": assertion covers `sql`, `sqlFor.postgres`, `sqlFor.pglite`, `transaction`, `idempotent`, `verify` presence, and the source text hash of each `handler`; rejects any migration content change.
- Test ambition: the 2am-Friday test is the full `ci:ubicloud` gate plus the e2e parity suite on Postgres + PgBouncer (prepare:false) + direct Postgres (prepare:true). The hostile-QA test is E5 + E9. The chaos test is the existing persistence soak (2,500 writes on PR) run on the branch.
- Pyramid: fine (mostly unit/golden; E2E parity already exists).
- Flakiness: goldens must not depend on wall clock or random IDs; hybrid fixture must pin embeddings; doctor golden masks volatile fields.
- LLM/prompt changes: none (no prompt files touched). No eval suites required beyond the hybrid golden; recommend one LongMemEval-mini run (`test/fixtures/longmemeval-mini.jsonl`) as a smoke check that retrieval is unchanged end to end.

## Section 7: Performance review

- **WARNING prepared statements (A4):** direct-Postgres users (prepare=true) lose named prepared statements on every converted query unless the adapter passes `{prepare: true}` mirroring `db.resolvePrepare(url)`. Unprepared parameterized queries also take a Describe round trip (`connection.js:244`). On a 30-80 ms RTT to hosted Postgres this is a visible regression on search and write hot paths. Obligation: bench `searchVector`, `searchKeyword`, `_upsertChunksOnce`, `getPage` before/after on direct Postgres and PgBouncer; no regression beyond noise.
- **OK N+1:** SQL text is preserved; no new loops. Guard against a store helper calling `exec.query` per row where the engine used `unnest` (review item).
- **OK memory / indexes:** no new data structures or queries.
- **Cold start:** 170 statically imported migration modules. Compiled binary bundles them (negligible); `bun src/cli.ts` dev path pays module resolution. Measure `gbrain --version` and `gbrain doctor --fast` cold start before/after; budget <= +20 ms.
- **CI time:** `check-function-size.ts` parses 1,473 files (~2-3 s measured with the scratch script over all of `src/`); fine inside the parallel verify.
- **Connection pool:** `runUnsafe` with a signal reserves a connection (`postgres-engine.ts:5340+`); routing every store call through it with a signal changes reservation behavior vs tagged templates. Keep signal forwarding only where the engine passes a signal today.

## Section 8: Observability & debuggability

- Behavior-preserving means log lines, progress phase names (CLAUDE.md "Keep phase names stable"), doctor messages and error text stay byte-identical. Obligation: grep-diff of all string literals passed to logger/progress/`console.*` in moved code equals zero (E3 covers this for move-only commits; behavior commits list any intentional change, target zero).
- Pool diagnostics (`getPoolDiagnostics`, `checkoutGauge`) must keep counting store traffic under the same labels (`raw`, etc.), otherwise the ops dashboards and doctor pool checks under-report.
- Debuggability improves: a sync hang report can name the phase module (phase names in stack traces). Making the error text name the phase is T3 (recommend defer to keep goldens identical).
- New guard failure text must say which function, its length, the ceiling and the exact TSV row to edit (joy-to-operate item).
- Runbook: `docs/architecture/key-files/engines-*.md` gets the store/executor contract and "how to add a storage method" (one store function + two delegations + parity test).

## Section 9: Deployment & rollout

- **Migrations:** none. Existing brains are untouched. PGLite fresh installs run the generated bootstrap; E4 proves identical end state.
- **Feature flags:** none needed; the refactor is not user-selectable. A flag to toggle store vs legacy SQL would double the code the PR removes; rejected.
- **Rollout order inside the PR (A19):** (0) goldens + E5 on master; (1) W3 migrations split + A6 hash/cache update; (2) W2 generation + E4 (+T1); (3) W1 per-domain commits, each followed by the full e2e parity run, E1 last; (4) W4 per god function, move-only commit then behavior commit; (5) W5 guard with 77-row baseline, then lower ceilings; (6) docs + `build:llms`; (7) PATCH version bump via `/ship`.
- **Mixed-version window:** long-running `jobs work` / autopilot daemons on old code while CLI is new: safe, no schema or protocol change. Compiled binary: `check-compile-autoload.sh`, `check-pglite-embedded.sh`, `check-cli-executable.sh` must pass (static imports only).
- **CI caches:** e2e.yml snapshot cache keys (`.github/workflows/e2e.yml:71,186`) hard-list `src/core/migrate.ts` and `pglite-schema.ts`; must add `src/core/migrations/*.ts`, `src/core/store/bootstrap*.ts` (if E1 feeds bootstrap), and the generated PGLite schema, or CI reuses a stale snapshot tarball.
- **Rollback:** `git revert <squash>` + PATCH release; ~30 min while no other PR has built on it; hours after. Land right after a release (not before a weekend) so a revert is cheap.
- **Post-merge checks:** first hour: master CI + nightly fullCorpus + 10,000-write persistence soak; first day: watch open PRs' conflict rate and publish E2 map in the PR and in a pinned comment.

## Section 10: Long-term trajectory

- Debt introduced: a 77-row function-size allowlist (explicit, shrinking); a store executor that must stay narrow (document its contract like sql-query.ts); ~133 re-pointed source-text tests (reduced debt if centralized loaders are used).
- Path dependency: positive. Future storage work is cheaper; a third engine is feasible.
- Knowledge concentration: mitigated by key-files entries + ASCII diagram + E2 map.
- Reversibility: **3/5** at merge, trending to **2/5** after a week as open PRs rebase onto the new layout.
- Ecosystem fit: matches CLAUDE.md façade and narrow-deps conventions; no new dependency.
- 1-year question: yes, `store/`, `migrations/`, `schema/`, registries and a function-size guard are obvious to a new engineer.
- Phase 2: gateway.ts provider adapters, cycle/import/bootstrap harness god functions, `src/core/` regroup, schema.sql generated from fragments if T1 is deferred.
- Retrospective on cherry-picks: E1 is load-bearing for goal (b) and for W1's claim; E5 is load-bearing for W1's safety. Rejecting either would have undermined accepted scope.

## Section 11: Design & UX

SKIPPED (no UI scope).

---

## NOT in scope

Deferred (to TODOS, with context):
- D1: decomposing the ~60 functions over 300 lines outside the touched files (largest: `cycle.ts runCycle` 1,227; `bootstrap/harness.ts applyHarness` 1,167; `cycle/synthesize.ts runPhaseSynthesizeInner` 1,043; `commands/import.ts runImport` 956; `import-file.ts importFromContent` 910; `minions/handlers/subagent.ts makeSubagentHandler` 884; `commands/config.ts runConfig` 834). W5 freezes them. Wave 2.
- D2: `src/core/` regroup; `ai/gateway.ts` (`chat` 311, `toolLoop` 236, `rerank` 201); cycle/extract/embed/import-file/init (plan's own rationale: path churn vs 51+ open PRs; provider-adapter design question).
- T3 (if the driver accepts the recommendation): phase-named sync errors, `TODOS.md:5338`, first follow-up after this PR.
- T1 (if the driver takes the non-recommended option): generating schema.sql's inline fragment copies.

Rejected:
- R1 cyclomatic-complexity guard (YAGNI).
- Feature flag toggling store vs legacy SQL (would double the code the refactor removes).
- ORM / query-builder replacement for raw SQL (0D option C).
- Renumbering migrations to close gaps 17-19 and 100 (would break recorded `schema_version` history).

## What already exists

See 0B table. Summary: `sql-query.ts` executor + JSONB helper (reuse), shared SQL fragment helpers (reuse), `withScopedReadTransaction`/`runUnsafe`/`resolvePrepare` (must route through), `build-schema.sh` (extend), `schema-drift.test.ts` + `schema-diff.ts` (extend, E4), freshness guards `check-*-fresh.sh` (copy), `doctor-source.ts` (generalize), `doctor/checks/` 32 modules + `doctor-categories.ts` (continue), `serve-http-*.ts` 6 modules (continue, T2), `minions/handlers/` (use), `check-module-size.sh` + TSV + `guards-manifest.tsv` + `check-engine-dynamic-import.ts` (pattern for W5), `computeSnapshotSchemaHash` + e2e.yml cache keys (update, A6), 28 parity test files (keep unchanged).

## Dream state delta

After this plan: SQL for the 12 named domains plus bootstrap exists once; the PGLite bootstrap is generated; migrations are files; 17 god functions are gone; a function-size ratchet exists with a 77-row frozen baseline; catalog-level parity is gated. Still short of the 12-month ideal: schema text still has two copies unless T1 lands; engines remain ~2,500 lines (ideal <1,500); ~60 legacy long functions remain frozen, not fixed; parity tests are not yet reduced to executor contract tests; gateway/cycle/import untouched.

## Error & Rescue Registry

| Codepath | Failure | Exception class | Rescued | Rescue action | User impact |
|---|---|---|---|---|---|
| store.* (all domains) | constraint/deadlock/serialization | PostgresError 23505/40P01/40001; PGlite error | Y (callers) | store never catches/wraps; identical err.code/message | unchanged |
| store.* Postgres | array/jsonb param type inference | PostgresError 42P18/42804 | pre-merge | E5 binding matrix | none if gated |
| store.* Postgres writes | JSONB string scalar | silent | pre-merge | check-jsonb-params + e2e jsonb + E5 | silent corruption if missed |
| store.* reads (PG, RLS on) | unscoped executor | silent | pre-merge | A3 branded scoped executor + e2e | cross-scope read if missed |
| StoreExecutor | abort | DOMException AbortError | Y | forward signal to runUnsafe | unchanged |
| StoreExecutor | connection death | PostgresError/ECONNRESET | Y | supervisor reconnect, no per-call retry | unchanged |
| row normalizer | type drift | silent | pre-merge | A5 per-kind contract tests | wrong types if missed |
| store/bootstrap (E1) | probe DDL failure on legacy shape | PostgresError / PGlite error | Y | same surfacing; legacy fixtures | unchanged |
| migrations registry | dup / dropped version | test failure / silent | pre-merge | A11 golden list | missing DDL if missed |
| build-schema.sh | transform on unknown construct | exit !=0 | Y | loud failure + fixtures | CI red |
| freshness guard | stale generated file | exit 1 | Y | regenerate | CI red |
| computeSnapshotSchemaHash | migration file not hashed | silent | pre-merge | A6 coverage test | tests on stale schema if missed |
| doctor runner | check throws | Error | Y | per-check semantics preserved | unchanged |
| cli table | unknown cmd / missing refusal | usage error / silent | Y / pre-merge | A16b goldens | unchanged |
| serve-http routes | missing requireAdmin / order | silent | pre-merge | A16 + E9 | auth bypass if missed |
| SyncRun | stale destructured field | silent | pre-merge | A17 guard + ordering tests | partial sync if missed |
| hybrid stages | arm/rerank failure | existing | Y | existing rethrow; golden | unchanged |
| check-function-size | parse error / new long fn | exit 2 / 1 | Y | actionable message | CI red |

## Failure Modes Registry

```
CODEPATH                    | FAILURE MODE                          | RESCUED? | TEST?            | USER SEES?          | LOGGED?
----------------------------|---------------------------------------|----------|------------------|---------------------|--------
store reads (PG+RLS)        | scope GUC not set (unscoped exec)     | N        | N in plan -> A3  | Silent              | N   CRITICAL GAP (closed by A3)
serve-http route modules    | requireAdmin/limiter dropped          | N        | partial -> E9    | Silent              | N   CRITICAL GAP (closed by A16/E9)
snapshot hash / CI cache    | migrations moved, snapshot stale      | N        | N in plan -> A6  | Silent (CI false green) | N   CRITICAL GAP (closed by A6)
row normalizer              | bigint/Date/jsonb type drift          | N        | N in plan -> A5  | Silent              | N   CRITICAL GAP (closed by A5)
store writes (PG)           | JSONB double-encode                   | N        | Y (guards+e2e)   | Silent              | N   WARNING (E5 strengthens)
store (PG)                  | array param inference error           | N        | E5               | Error               | Y
store (PG direct)           | prepared statements lost, +RTT        | n/a      | A4 bench         | Slower search/write | N   WARNING
migrations registry         | dropped/dup version                   | N        | Y (A11)          | Silent schema gap   | N   covered
generated PGLite schema     | end-state differs                     | N        | Y (E4)           | Silent              | N   covered
doctor registry             | order/name/status change              | Y        | Y (golden)       | Changed output      | Y   covered
cli table                   | thin-client refusal lost              | N        | Y (A16b)         | Local exec on remote| N   covered
SyncRun                     | stale field across await              | N        | Y (A17)          | Partial sync        | N   covered
hybrid stages               | rank/score change                     | n/a      | Y (A13)          | Different results   | N   covered
jobs handlers               | handler missing from registry         | Y        | Y (name list)    | Job fails "no handler" | Y covered
function-size guard         | arrow/obj-method not counted          | n/a      | Y (fixtures A18) | Ratchet silently weak| N  covered
```
Totals: 15 failure modes; 4 CRITICAL GAPS in the plan as written, all closed by accepted amendments.

## Diagrams

Produced above: system architecture (S1), store data flow + generated schema flow with shadow paths (S4), SyncRun async schedule / state (S4). Error flow, deployment sequence and rollback:

```
ERROR FLOW (store call)
caller -> engine.method -> [PG read? withScopedReadTransaction(tx)] -> store.fn(exec) -> exec.query
   error -> propagate unchanged (no catch in store/executor) -> engine -> caller's existing handling
   abort -> DOMException AbortError -> caller
```
```
DEPLOYMENT SEQUENCE (inside the one PR)
goldens@master -> W3 (+A6) -> W2 (+E4,+T1?) -> W1 per domain (e2e parity each) -> E1 -> W4 (move, then behavior)
 -> W5 guard (77-row baseline) -> ceilings lowered -> docs + build:llms -> /ship PATCH -> ci:ubicloud green -> PR
```
```
ROLLBACK
master red / prod regression? -> yes -> within ~3 days and no dependent PRs? -> yes -> git revert squash -> PATCH release
                                                                            -> no  -> targeted fix-forward (goldens name the diff)
```

### Stale diagram audit
- `pglite-schema.ts:9-28` header prose (differences list + DRIFT WARNING) is stale (names non-existent files; understates differences). Removed by W2.
- `test/e2e/schema-drift.test.ts:1-23` header says it snapshots only columns; update when E4 lands.
- `doctor-categories.ts` header ("every Check.name produced by src/commands/doctor.ts") must say the registry after W4.
- `check-module-size.sh:12` region-exempt policy comment goes away with W3.

## Implementation tasks (synthesized from findings)

- [ ] **T1 (P1, human ~1d / CC ~1h)** core/store - Build StoreExecutor beside `sql-query.ts` with branded scoped-read executor, signal forwarding, gauge, prepare mode. Files: `src/core/sql-query.ts` or `src/core/store/executor.ts`, both engines. Verify: E5 matrix + RLS e2e.
- [ ] **T2 (P1, human ~4h / CC ~20m)** snapshot - Hash `src/core/migrations/*.ts` + generated schema in `computeSnapshotSchemaHash`; update e2e.yml cache keys; add coverage test. Files: `src/core/pglite-engine.ts`, `.github/workflows/e2e.yml`, new test. Verify: removing a migrations file from inputs fails the test.
- [ ] **T3 (P1, human ~4h / CC ~30m)** serve-http - Route snapshot with middleware chain + E9 invariant. Verify: dropping `requireAdmin` on one route fails.
- [ ] **T4 (P1, human ~4h / CC ~30m)** store - Row normalizer with declared shapes + per-kind contract tests on both engines.
- [ ] **T5 (P1, human ~1d / CC ~1h)** schema - Catalog-level drift snapshot (E4) and pre/post golden for generated PGLite bootstrap.
- [ ] **T6 (P1, human ~4h / CC ~30m)** migrations - Golden covering sql/sqlFor/flags/handler source; version list incl. gaps.
- [ ] **T7 (P2, human ~1d / CC ~1h)** tests - Generalize `doctor-source.ts` into per-surface loaders; re-point ~133 source-text tests; containment vs positional preserved.
- [ ] **T8 (P2, human ~4h / CC ~30m)** perf - Bench hot paths direct PG + PgBouncer before/after; cold-start budget.
- [ ] **T9 (P2, human ~2h / CC ~20m)** review - E2 moved-symbol map + E3 move-only verifier.
- [ ] **T10 (P2, human ~4h / CC ~30m)** guards - `check-function-size.ts` with 77-row baseline, guards-manifest row, bad/good fixtures.

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|---|---|---|---|---|---|
| 1 | 0E | Mode SELECTIVE EXPANSION | Mechanical | driver override | Autoplan sets the mode | HOLD, REDUCTION (file-count heuristic) |
| 2 | 0A | Accept P1: parity drift is the root bug class; W1 highest value | Mechanical | P1 | 165/188 co-change commits; 28 parity files | Deprioritizing W1 |
| 3 | 0A | Reject "move-dominant" framing for W1; treat as behavior-touching (A2) | Mechanical | P5 | Driver idioms differ on ~every line; `unsafe()` prepare:false | Treating W1 conversions as move-only |
| 4 | 0A | Correct table-gap premise: 71 vs 75 composed; end-state parity already gated | Mechanical | P5 | Runtime census of both schema builders | "Reconcile 28 missing tables" |
| 5 | 0A | Correct migrations facts: 170 entries, gaps 17-19/100, unsorted array | Mechanical | P5 | Runtime import of MIGRATIONS | 175 entries, contiguity assumptions |
| 6 | S1/S3 | A3: branded scoped-read executor preserving RLS scope binding | Mechanical | P1 | `withScopedReadTransaction` at 18+ sites | Plain `executeRaw` executor |
| 7 | S1/S7 | A4: executor honors `resolvePrepare`, forwards signal via `runUnsafe`, keeps gauge; bench hot paths | Mechanical | P1 | `vendor/postgres/src/index.js:122`, `connection.js:244` | Bare `sql.unsafe` |
| 8 | 0G | E1 dedupe forward-reference bootstrap into store | Mechanical | P2 | Same parity class, 1,259 lines, <1d, required by goal (b) | Leaving both copies |
| 9 | 0A | A9 keep goal (b); enumerate +8 functions; define touched = non-import lines changed | Mechanical | P1 | AST list | Narrowing goal (b) |
| 10 | 0A | A10 re-point source-text guards via shared loaders; never delete/weaken; positional stays positional | Mechanical | P1/P5 | ~133 files; prior waves stalled on this | Literal "no test edits" |
| 11 | S2 | A6 snapshot hash + CI cache keys cover moved/generated schema inputs + coverage test | Mechanical | P1 | `pglite-engine.ts:334-366`, e2e.yml:71,186 | Leaving hand list |
| 12 | 0G | T1 generate schema.sql's 20 inline fragment tables from TS fragments | Taste | P1 vs P3 | W2 goal is one source; borderline size and Postgres canonical path risk | (recommend include) |
| 13 | 0G | E4 catalog-level schema parity | Mechanical | P1 | Needed to prove W2; closes TODOS:1868 | Columns+indexes only |
| 14 | S5 | A14 freshness guard modeled on `check-*-fresh.sh` | Mechanical | P5 | `check-pglite-embedded.sh` checks binary assets | Plan's reference |
| 15 | S5 | A15 jobs handlers to `minions/handlers/*`, 24 registrations, keep jobs.ts export | Mechanical | P4 | Existing dir; `supervisor.ts:859` dynamic import | Single `builtin-jobs.ts` |
| 16 | 0G | T2 serve-http route modules flat `serve-http-*-routes.ts` | Taste | P5/P3 | Existing 6 flat peels | New `serve-http/` dir |
| 17 | 0G | E9 per-route middleware snapshot + admin-auth invariant | Mechanical | P1 | Auth is per-route in serve-http | Path-only route table |
| 18 | S6 | A13 deterministic hybrid fixture; include `hybridSearchCached` | Mechanical | P5 | "existing eval fixtures" undefined | Vague fixture |
| 19 | S4 | A17 SyncRun no-destructure rule + ordering tests | Mechanical | P1 | 46 closure lets across awaits | Unguarded state object |
| 20 | 0G | E2 moved-symbol map | Mechanical | P2/P6 | 51 overlapping PRs | None |
| 21 | 0G | E3 move-only verifier | Mechanical | P2/P5 | Review proof at ~50k moved lines | `--color-moved` alone |
| 22 | S5 | A18 function-size guard counts all function forms; guards-manifest row + fixtures | Mechanical | P1 | 415-line anonymous `/mcp` handler | Declarations-only count |
| 23 | 0A | UC1 W1 domain breadth in the same PR | User Challenge | n/a | Risk concentration; user must decide | not decided |
| 24 | S9 | A19 commit/land order; land right after a release | Mechanical | P6 | Cheap revert window | Unspecified order |
| 25 | 0A | A12 restate metric (a); guard: no SQL literals in engine façades for migrated domains | Mechanical | P5 | Delegations still touch both files | "Structurally impossible" |
| 26 | 0G | T3 phase-named sync errors: defer | Taste | goal vs P2 | Keeps goldens byte-identical | Include now |
| 27 | 0G | R1 complexity guard | Mechanical | P3 | YAGNI | Include |
| 28 | 0G | D1/D2 deferrals to wave 2 | Mechanical | P3 | Outside blast radius; ratchet freezes | Include |
| 29 | S3 | A2b dynamic SQL fragments only from constant allowlists; scanner rule in store | Mechanical | P1 | Tagged-template fragments become concatenation | Free-form concatenation |
| 30 | S3 | A5b store functions receive resolved source scope explicitly | Mechanical | P1 | Source isolation invariant | Store resolving scope |
| 31 | S6 | A16b CLI goldens: --help, --tools-json, thin-client refusal matrix, exit codes | Mechanical | P1 | "identical" asserted, not tested | None |
| 32 | S1 | A1 build executor on `sql-query.ts` | Mechanical | P4 | Existing cross-engine executor | New parallel abstraction |

Lake score: N/A (no coverage-scored user questions were asked; all decisions auto-resolved or deferred to the gate).

## Taste decisions (for the final gate)

- **T1** Generate `schema.sql`'s 20 inline fragment tables from the TS fragment modules. Recommend **include**: without it W2 still leaves two copies. Cost ~3-4h CC, 4-11 files; risk is limited to the Postgres canonical SQL file order, which E4 catches.
- **T2** serve-http route modules as flat `serve-http-<area>-routes.ts` (recommend) vs a new `serve-http/` directory.
- **T3** Phase-named sync errors: recommend **defer** to the first follow-up so every golden stays byte-identical.

## User Challenge candidates (not decided)

- **UC1 W1 breadth.** The plan converts all 12 domains (~4,700 shared lines per engine, 231 Postgres tagged-template sites) in the same PR as W2-W5 and 7 god-function splits. Option A (plan): all 12 domains + E1. Option B: the 5 already-peeled per-engine domains (facts, takes, salience, code-edges, cjk-search; ~2,100 lines per engine) + E1 + the executor/contract tests now; the remaining 7 domains in the next wave on the proven executor. Still one PR either way. Why it matters: W1 is the only workstream that changes the Postgres driver path; its failure modes are silent (RLS, JSONB, type drift). The owner's one-PR rule is respected in both options; the question is how much of the riskiest rewrite rides in this PR.
- No other premise is clearly wrong enough to challenge; the factual corrections (P2-P8) are recorded as mechanical amendments.

## ACCEPTED OBLIGATIONS (add to the plan)

1. **A1 Executor home.** Build the store executor beside `src/core/sql-query.ts`, sharing `SqlValue` and `executeRawJsonb`; document its contract in the same style. Verify: review + no second JSONB helper exists (`rg executeRawJsonb`).
2. **A2 W1 is behavior-touching.** One commit per domain; each followed by the full e2e parity run (Postgres direct, PgBouncer, PGLite). Methods whose SQL differs semantically between engines stay in the engines and are listed in the PR. Verify: per-domain CI receipts.
3. **A2b Dynamic SQL safety.** Only identifiers/ordering from constant allowlists may be concatenated into store SQL; every value is positional. Verify: scanner rule over `src/core/store/` (extend `check-jsonb-params.mjs` or a new guard) with bad/good fixtures.
4. **A3 RLS scope.** Store read functions accept only a branded `ScopedExecutor` obtainable from `withScopedReadTransaction` (PGLite: identity). Verify: typecheck rejects unscoped use; e2e with `rlsScopeBindingEnabled` asserts `current_setting('app.scopes')` inside store reads.
5. **A4 Driver parity.** Postgres adapter routes through `runUnsafe`, forwards `signal` only where the engine does today, keeps `checkoutGauge` labels, passes `{prepare}` from `db.resolvePrepare(url)`. Verify: bench `searchVector`, `searchKeyword`, `_upsertChunksOnce`, `getPage` on direct PG and PgBouncer, no regression beyond noise; pool-diagnostics tests unchanged.
6. **A5 Row normalizer.** Declared per-column kinds (jsonb, bigint, date, vector, text[]); no value-type guessing. Verify: per-kind contract test on both engines.
7. **A5b Source scope.** Store functions receive the already-resolved source scope; they never resolve it. Verify: existing source-isolation tests pass unmodified.
8. **A6 Snapshot inputs.** `computeSnapshotSchemaHash` hashes every `src/core/migrations/*.ts` (sorted glob), the generated PGLite schema, and any store module that feeds bootstrap; `.github/workflows/e2e.yml` cache keys updated identically. Verify: a unit test fails if any migrations file or generated schema is absent from the hash inputs.
9. **A7 W2 equivalence.** Generated PGLite bootstrap must reproduce the pre-change fresh-install end state. Verify: E4 catalog snapshot (columns, defaults, indexes, constraints incl. CHECK text, triggers, function signatures + body hash, views) captured on master equals branch for PGLite, and PGLite == Postgres except the existing allowlist.
10. **A8 Correct the W2 narrative.** Replace "75 vs 47" with the composed 71 vs 75 facts and the three-copy problem; document which tables each engine gets from bootstrap vs migrations (slug_aliases, page_aliases, code_edges_chunk, code_edges_symbol, dream_verdicts, file_migration_ledger).
11. **A9 Goal (b) list.** "Touched" = file with changed non-import lines. Add: `sync.ts performFullSync` (436), `cli.ts main` (415), `hybrid.ts hybridSearchCached` (437), `jobs.ts registerBuiltinHandlers` (1,063), serve-http `/mcp` POST handler (415), both forward-reference bootstraps (604, 655). Verify: `check-function-size.ts` reports zero >300 functions in touched files.
12. **A10 Test re-point policy.** Source-text guards are re-pointed through shared per-surface loaders (generalize `test/helpers/doctor-source.ts`); containment guards may use the concatenated loader; positional guards must name the single file that now holds the code. No assertion removed or loosened. Verify: E3-style review listing every edited test with before/after assertion, plus `check-test-discriminates.sh` green.
13. **A11 Migrations golden.** Golden captured on master covers version, name, `sql`, `sqlFor.{postgres,pglite}`, `transaction`, `idempotent`, `verify` presence and handler source-text hash for all 170 entries; version set equals master (gaps 17-19, 100 preserved); runner sort unchanged. Verify: registry test.
14. **A12 Metric (a).** Restate as "each migrated domain's SQL exists once in `src/core/store/`; engine files contain only delegation". Verify: guard that rejects SQL keywords in string/template literals inside engine methods listed as migrated.
15. **A13 Hybrid golden.** Deterministic fixture: stub embedder, seeded PGLite corpus, fixed config, cold and warm cache (`hybridSearchCached`). Exact `(id, score)` equality. Verify: golden test + existing `hybrid-*.test.ts` unchanged.
16. **A14 Freshness guard.** Model on `check-tool-catalog-fresh.sh` / `check-skills-manifest-fresh.sh`; wire into `run-verify-parallel.sh` and `guards-manifest.tsv` with fixtures. Verify: guard self-test.
17. **A15 Jobs handlers.** One module per handler under `src/core/minions/handlers/`; 24 registrations in the same order; `registerBuiltinHandlers` still exported from `src/commands/jobs.ts`. Verify: name/order test + supervisor probe test.
18. **A16 serve-http.** Route snapshot records method, path, and ordered middleware identities per route, plus global `app.use` order; E9 invariant on admin routes. Verify: mutation test (drop `requireAdmin` on one route -> fail).
19. **A16b CLI goldens.** `gbrain --help`, `--tools-json`, unknown-command exit code/text, thin-client refusal matrix for all 62 former cases. Verify: golden tests.
20. **A17 SyncRun.** Mutable fields accessed only as `run.<field>`; no destructuring of mutable fields (source guard over `src/commands/sync/`); controlled-order tests for phase-await vs watchdog and phase-await vs timeout in both orders. Also re-point `test/sync.test.ts` #132 and `test/redos-hardening.test.ts` per A10.
21. **A18 Function-size guard.** Counts function declarations, methods, accessors, arrow functions and function expressions (incl. object-literal and class-property forms); baseline TSV seeded with all 77 current >300-line functions at current length; actionable failure text; `guards-manifest.tsv` row with bad/good fixtures. Verify: guard self-test.
22. **A19 Order and timing.** Commit order per Section 9; land right after a release; PATCH bump via `/ship`; `build:llms` after doc edits.
23. **E1** Forward-reference bootstrap single implementation. Verify: legacy-shape boot fixtures on both engines + `schema-bootstrap-coverage.test.ts` unchanged.
24. **E2** Moved-symbol map generated from AST (old `path:function` -> new `path:function`) in the PR body. Verify: covers every symbol removed from the 12 hot files.
25. **E3** `scripts/verify-move-only.ts` + unit test; run on every commit tagged move-only; results in the PR. Verify: fails on a single edited token.
26. **E4** Catalog-level schema parity (see A7).
27. **E5** Executor binding-matrix contract test on both engines, green on master before any W1 conversion.
28. **E9** Admin-route auth invariant (see A16).
29. Observability: logger/progress/error string literals in moved code unchanged; pool gauge labels unchanged; cold-start budget `gbrain --version` <= +20 ms.
30. Docs: update `docs/architecture/key-files/engines-*.md`, `commands-2.md` (doctor), `commands-6.md` (sync), `core-search-*.md` (hybrid), `core-minions-*.md`, tooling entry for the new guard; ASCII diagram of store -> executor -> adapter; fix `doctor-categories.ts` path references; remove the stale `pglite-schema.ts` DRIFT WARNING with the file. Privacy: generic placeholders only in all public artifacts.

## Completion Summary

```
+====================================================================+
|            MEGA PLAN REVIEW - COMPLETION SUMMARY                   |
+====================================================================+
| Mode selected        | SELECTIVE EXPANSION (driver override)       |
| System Audit         | 6 factual corrections; 8 missed >300-line   |
|                      | fns in touched files; 51 overlapping PRs;   |
|                      | ~133 source-text tests pin moved code       |
| Step 0               | 9 premises (2 accepted, 5 corrected, 1      |
|                      | clarified, 1 UC); 16 spec issues amended    |
| Section 1  (Arch)    | 5 issues (1 critical: RLS)                  |
| Section 2  (Errors)  | 17 error paths mapped, 6 GAPS (all amended) |
| Section 3  (Security)| 10 threats, 4 High impact unmitigated->amended |
| Section 4  (Data/UX) | 12 edge cases mapped, 0 unhandled after A17 |
| Section 5  (Quality) | 10 issues found                             |
| Section 6  (Tests)   | Diagram produced, 7 gaps (all amended)      |
| Section 7  (Perf)    | 3 issues (prepare/RTT, cold start, reserve) |
| Section 8  (Observ)  | 4 gaps found                                |
| Section 9  (Deploy)  | 4 risks flagged (CI cache, rollback window, |
|                      | compiled binary, land timing)               |
| Section 10 (Future)  | Reversibility: 3/5 -> 2/5, debt items: 3    |
| Section 11 (Design)  | SKIPPED (no UI scope)                       |
+--------------------------------------------------------------------+
| NOT in scope         | written (8 items: 4 deferred, 4 rejected)   |
| What already exists  | written                                     |
| Dream state delta    | written                                     |
| Error/rescue registry| 18 rows, 5 pre-merge-only rescues (gated)   |
| Failure modes        | 15 total, 4 CRITICAL GAPS (closed by A3/A5/A6/A16) |
| TODOS.md updates     | 2 items proposed (D1, D2) + T3 if deferred  |
| Scope proposals      | 11 proposed, 6 accepted, 2 deferred, 1 rejected, 3 taste |
| CEO plan             | not persisted by this voice (driver owns)   |
| Outside voice        | skipped (driver handles)                    |
| Lake Score           | N/A                                         |
| Diagrams produced    | 6 (architecture, data flow x2, async state, |
|                      | error flow, deployment, rollback)           |
| Stale diagrams found | 4                                           |
| Unresolved decisions | 4 (UC1, T1, T2, T3)                         |
+====================================================================+
```

Unresolved decisions for the final gate: UC1 (W1 breadth), T1 (schema.sql fragments), T2 (serve-http layout), T3 (phase-named sync errors).

No durable learnings logged by this voice (read-only phase). Candidate learning for the driver: "GBrain peels stall on source-text tests; plan the loader re-point up front" and "postgres.js `unsafe()` defaults to `prepare:false` (vendor/postgres/src/index.js:122)".
