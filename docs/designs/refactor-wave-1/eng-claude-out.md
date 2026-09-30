INPUT: eng e0efd14a6f2d0ce08cf01b9204b102a9374b22bbb165d02a07a2dd73998893b9

# Independent ENG review: GBrain Refactor Wave 1

The input was read in full: native-prompt.md, 254 lines. I checked the claims against /workspace/gbrain at master 608a174 using read-only commands.

**Verdict:** The plan is sound in direction and unusually well-gated. W0, W5, W3 and W4 are mostly mechanical and adequately guarded. The real risk sits in W1 and W2. In both, the plan treats the conversion as "move SQL to one place", but the code shows three problems:

- The Postgres driver's tagged-template path and its `unsafe` path behave differently in ways the goldens cannot see: prepared statements, protocol, pool gauge, and transaction binding.
- The PGLite bootstrap is a runtime template, not static text.
- The migration split has an ESM import-cycle hazard.

None of these blocks the plan. Each needs an explicit rule and a test before the first W1 or W3 commit. Severity scale: CRITICAL (ship-blocking correctness or security), HIGH (likely regression the current gates miss), MEDIUM (real gap, bounded blast radius), LOW (clarity or hygiene).

---

## 1. Architecture

### A-1 HIGH: Moving Postgres from tagged `sql\`\`` to `runUnsafe` silently drops prepared statements, and the proposed fix is more complex than it needs to be
- **What's wrong:** In the vendored postgres.js, `unsafe()` hard-codes `prepare: false` (vendor/postgres/src/index.js:119-125). The final flag is `options.prepare && ('prepare' in q.options ? q.options.prepare : true)` (connection.js:238). So every tagged call that becomes `runUnsafe` today is unprepared on direct Postgres. `runUnsafe` (postgres-engine.ts:5340) calls `conn.unsafe(sql, params, { cancelFence })` and passes no prepare flag. A4 says "pass `{prepare}` from `db.resolvePrepare(url)`". But tx clones are made with `Object.create(this)`, and threading the URL to each call site is awkward.
- **Fix:** The executor should pass `prepare: true` on every call. The connection-level `prepare` (already `false` under PgBouncer via `resolvePrepare` at connect time) gates it, so PgBouncer stays unprepared and direct Postgres stays prepared, with no URL plumbing. Add an E5 assertion that reads `pg_prepared_statements` after a store call on direct Postgres (non-empty) and on PgBouncer (no prepare error under load).

### A-2 HIGH: Zero-parameter `unsafe` switches to the simple query protocol
- **What's wrong:** `unsafe` sets `simple: args.length === 0` (index.js:124). Tagged templates always use the extended protocol. A store query with no bind values would run over the simple protocol, which allows multiple statements, has different error and notice framing, and returns a result array for multi-statement text. That is both a behavior difference and extra injection surface next to the A2b concatenation rule.
- **Fix:** The executor always passes `simple: false`. Add an E5 case: a zero-param `SELECT 1; SELECT 2` must be rejected.

### A-3 HIGH: Transaction binding for the executor is an unwritten invariant
- **What's wrong:** `transactionOn` (postgres-engine.ts:576-595) builds the tx engine with `Object.create(this)` and overrides the `sql` getter. The existing peel keeps this working only by convention. `PgFactsDeps.sql` says "Getter-backed at the call site". If an engine-sql executor or store deps object is cached at construction or connect time, writes inside `engine.transaction()` silently run on the pool and outside the transaction. No golden or parity test in the plan catches this, because the happy path returns the same rows.
- **Fix:** Document "the executor is resolved from `this.sql` / `this.db` on every call, never cached" in the A1 contract. Add a per-domain test on both engines: write inside `engine.transaction(...)`, throw, and assert the row is absent. Also test `transactionDirect` under dual-pool.

### A-4 MEDIUM: Routing through `runUnsafe`/`executeRaw` changes checkout-gauge accounting
- **What's wrong:** `executeRaw` acquires `checkoutGauge('raw')`. Tagged calls acquire nothing. `runUnsafe` with a signal also *reserves* an exclusive connection. The gauge snapshot is surfaced as `tracked` (postgres-engine.ts:666). A4 says "keeps checkoutGauge labels" but does not say *which* label store calls use. Using `'raw'` inflates raw counts and changes diagnostics.
- **Fix:** Call `runUnsafe` directly with no gauge acquire, which matches today's tagged path. Only paths that go through `executeRaw` today keep `'raw'`. Pin this with a gauge-snapshot assertion in E5.

### A-5 HIGH: Converting nested `sql` fragments to positional `$n` needs a fragment combinator, and the plan rejects "a query builder"
- **What's wrong:** Conditional fragment interpolation is common. Counting `? sql\``, `: sql\`` and `${sql\``: postgres-engine.ts has 91, facts.ts 33, takes.ts 28, salience.ts 16, code-edges.ts 9. There are also 52+ uses of `sql.json`, `sql([...])` and `sql.unsafe`. With hand-numbered `$n` in conditional SQL, renumbering bugs appear only on the branch combination nobody tested. A13 and the parity suites cover a small share of the filter combinations.
- **Fix:** Allow and specify a minimal `sqlFragment` concat helper (text plus values, automatic renumbering, no identifiers). That is not an ORM, so it stays within the "no query builder" rejection. Make it the only way to compose store SQL, and extend the A2b scanner to reject a literal `$<digit>` in any string that is concatenated or interpolated. Add a property test that concatenates random fragment trees and checks the placeholder count against the values length.

### A-6 HIGH: The PGLite bootstrap is a runtime template, but W2 describes generating static text
- **What's wrong:** `getPGLiteSchema(dims, ...)` (pglite-schema.ts:1297-1306) applies `applyChunkEmbeddingIndexPolicy` and `applyFtsLanguagePolicy` over `PGLITE_SCHEMA_SQL_TEMPLATE` at runtime. The E4 catalog snapshot at default dims and language proves nothing about the other configurations, such as non-default dims crossing the halfvec threshold or a non-English FTS config.
- **Fix:** The generator must emit the *template*, placeholders included, and leave policy application at runtime. E4 should snapshot at least three configs on both engines: default, a high-dims config that triggers the halfvec/index-policy branch, and a non-default FTS language.

### A-7 MEDIUM: There are four schema-text copies, not three, and the generator chain has an order
- **What's wrong:** `src/core/schema-embedded.generated.ts` is already generated from `schema.sql` by `scripts/build-schema.sh`. With T1, TS fragments → schema.sql regions → schema-embedded.generated.ts → PGLite template form a *chain*. A freshness guard that checks only one link lets a fragment edit ship with a stale embedded blob. `check-jsonb-pattern.sh` and `check-search-path.sh` also scan all three files, so generated text must still satisfy them. The fragment modules are TS values (for example, the `PERSISTENCE_SCHEMA_STATEMENTS` array), so the generator has to *execute* them under Bun rather than parse their text.
- **Fix:** `build:schema` runs the whole chain in fixed order. The freshness guard regenerates the chain into a temp dir and diffs all outputs. Write the chain into the W2 canonical-source graph and into CONTRIBUTING's "add a column" worked example.

### A-8 HIGH: Splitting migrations can create an ESM import cycle
- **What's wrong:** Many of the 29 handlers call module-scope helpers in `migrate.ts`. If `schema-migrations/vNNN-*.ts` imports helpers from `migrate.ts` while `migrate.ts` imports `schema-migrations/index.ts`, evaluation order becomes cycle-dependent. Any top-level use (a const built from a helper, or a `sqlFor` computed at module init) throws a TDZ `ReferenceError`. It may appear only in the compiled binary or on one import path, such as `cli.ts:3766`'s lazy import compared with a static import from one of the 22 other `LATEST_VERSION` importers.
- **Fix:** Move shared helpers to `schema-migrations/_shared.ts` or their existing domain modules. Add a guard that no file under `schema-migrations/` imports `migrate.ts`, and check `check-compile-autoload.sh` / `check-cli-executable.sh` against a compiled binary that runs `apply-from-empty`.

### A-9 MEDIUM: `ScopedExecutor` branding forces a per-read decision the plan does not budget for
- **What's wrong:** Only 23 call sites use `withScopedReadTransaction` today (postgres-engine.ts:281). With the flag off it is a pure pass-through. With the flag on it opens a transaction, and that is the #1794 PgBouncer pool-hold class the code comment warns about. "Store read functions accept only a branded ScopedExecutor" leaves two bad outcomes for every read not wrapped today. Wrapping it is a behavior change: new pool holds with the flag on and new RLS coverage. Using `unscopedExecutor(reason)` everywhere makes the brand theater.
- **Fix:** For each read method, the W1 inventory records whether it is wrapped today. The wrapped set stays exactly the same, which a golden pins. Unwrapped reads get `unscopedExecutor('pre-wave-1: unwrapped on master')` and are listed in the PR. Widening RLS coverage is a follow-up with its own pool-pressure test.

---

## 2. Edge cases (10x load, nil/empty/error)

- **E-1 MEDIUM: Prepared-statement cache growth.** postgres.js keys prepared statements by `types + string` per connection (connection.js:240) and never evicts. Once A-1 restores prepare, any store SQL whose *text* varies with input (IN-list arity, optional filters) grows each backend's statement map without bound under 10x cardinality. **Fix:** Add an A2b rule that lists bind as `= ANY($n::type[])` and never expand to `IN ($1,$2,...)`. The scanner flags `.map(() => '$')`-style expansion. E5 checks that the statement count stays flat across 1..N list sizes.
- **E-2 MEDIUM: Per-row normalizer cost on hot paths.** A5's declared per-column kinds are right. A per-row, per-column kind lookup on `searchVector` and `_upsertChunksOnce` returns, however, adds measurable CPU at 10x. **Fix:** Compile the normalizer once per statement into a closure over a column→fn array. Budget (f) should include a large-result `searchVector` case (limit=MAX_SEARCH_LIMIT), not only the median.
- **E-3 MEDIUM: Error and abort paths.** `runUnsafe` throws a `DOMException('aborted')` *synchronously* on a pre-aborted signal, and existing code uses try/finally for exactly that reason (postgres-engine.ts:5385). Store functions and the executor must keep try/finally semantics, or gauges and leases leak. Inside a transaction, `conn.reserve` is absent, so cancellation takes a different branch. **Fix:** E5 adds a pre-aborted signal case, a mid-query abort inside `engine.transaction`, and 23505/57014/40P01 pass-through on PGLite, direct Postgres and PgBouncer. Class, `.code` and message must be identical to master.
- **E-4 LOW: Empty inputs.** Empty arrays for `ANY($1::text[])` behave differently if a store function short-circuits in one engine but not the other. PGLite takes some paths that return `[]` early today. **Fix:** The per-method inventory records early-return behavior per engine and keeps it.
- **E-5 MEDIUM: Migration versions landing out of order.** The generator catches *duplicate* versions but not *out-of-order landing*. Suppose branch A scaffolds v176 and branch B scaffolds v177, and B merges first. Brains that upgrade to 177 skip 176 forever, because the runner applies `version > current`. `new:migration` makes local next-number picking the default path, so this becomes more likely. **Fix:** Add a CI check: every migration file added relative to merge-base must have a version greater than the max version on `origin/master`. The error text points at the renumber recipe.

---

## 3. Tests (what breaks at 2am Friday)

- **T-1 HIGH: The handler source-text hash must not use `Function.toString()`.** The existing `computeSnapshotSchemaHash` comment (pglite-engine.ts:340) says coverage instrumentation changes `Function.toString()`. A registry golden built on `toString()` goes red in coverage lanes only. **Fix:** Hash normalized AST source text extracted from file bytes, the same way on master's `migrate.ts` and on the new files.
- **T-2 HIGH: A per-domain transaction-rollback test** (see A-3). It is missing, and it is the most likely silent regression.
- **T-3 MEDIUM: Coverage diff gate.** `scripts/coverage-gate-exemptions.txt` exempts `postgres-engine.ts`, `pglite-engine.ts`, `postgres-engine/`, `pglite-engine/`, `migrate.ts` and `cli.ts`. It is shrink-only, and additions need a graduation review. Moved code lands in `engine-sql/`, `schema-migrations/`, `commands/sync/` and `doctor/checks/`, none of which are exempt. The gate is report-only today (`COVERAGE_GATE_ENFORCE: '0'`, test.yml:612-617), but the PR summary will show thousands of "uncovered" changed lines, and `test/scripts/coverage-diff-gate.test.ts` references the old paths. **Fix:** Add explicit exemption identity transfer for moved code (the old exemption moves with the code and the old row is removed, so net shrink), justified in the PR under the file's graduation rule.
- **T-4 MEDIUM: Normalize the W0 goldens.** `doctor --json`, the serve-http route table and the hybrid output all carry timestamps, durations, temp paths, or ordering from `Map`/`Set` iteration. **Fix:** Name a normalizer per golden in W0 and prove it by capturing each golden twice on master and diffing to empty, before any move.
- **T-5 MEDIUM: More apply-from-older-version starting points.** A single older version does not exercise the handler migrations. **Fix:** Replay from several checkpoints on both engines, each followed by an E4 comparison: v1, a pre-handler-heavy version, the version before the forward-reference bootstrap was introduced, and LATEST-1.
- **T-6 MEDIUM: Shared serve-http state after the module split.** The `/mcp` POST handler and the admin routes close over per-server state today: rate limiters (`adminLimits`), session maps and token caches. If a mounted module builds its own instance, rate limits and caches split per module and nothing fails. **Fix:** `mount<Area>(app, ctx)` takes one shared context object. Add a request-outcome test that exhausts the admin limiter through one module's route and sees it enforced on another's.
- **T-7 LOW: Sync controlled-order tests.** Add a third ordering: watchdog fires *during* checkpoint write, where partial state was previously visible through a closure `let`.

---

## 4. Security

- **S-1 HIGH: The E9 wording would loosen the admin route guard as written.** The plan says "keeps its 7-entry allowlist, adds `/metrics` and `/admin/events`". The allowlist has 6 entries (7 occurrences, since `/admin/{*path}` counts 2) at test/serve-http-admin-route-guard.test.ts:119-135. Both `/metrics` (serve-http.ts:1455) and `/admin/events` (:1884) already carry `requireAdmin`. Adding them to the *allowlist* exempts two guarded routes. **Fix:** Reword to "add `/metrics` and `/admin/events` to the must-carry-`requireAdmin` scan set". `/metrics` is not under the `/admin` prefix and needs an explicit inclusion. The mutation test should cover `/metrics` specifically.
- **S-2 MEDIUM: Global middleware order.** Per-route ordered middleware is captured, but order-sensitive global `app.use` paths are not named: CORS/preflight, body parsers, and the SPA fallback that excludes `/admin/api/`, `/admin/events` and `/admin/login` (serve-http.ts:1913, :1952). **Fix:** The A16 golden includes the full ordered `app._router.stack` (or the Express 5 equivalent) with global middleware, not only route handlers.
- **S-3 MEDIUM: Forging `ScopedExecutor`, and who may call `unscopedExecutor`.** Banning `as ScopedExecutor` misses `as unknown as ScopedExecutor`, object-literal construction with the brand key, and `any` flows. `unscopedExecutor(reason)` exported from `engine-sql/` is also reachable from `core/ops/`, which is MCP-facing (`remote = true`). **Fix:** The guard bans any mention of the brand key outside the factory module and any `as unknown as` near executor types. It restricts `unscopedExecutor` imports to an allowlisted directory set (doctor, maintenance, admin, migrations), and no `core/ops/*` module may import it.
- **S-4 LOW: The A2b scanner must see through indirection.** Concatenation via `+`, template `${}`, `Array.join` and a helper that returns SQL text all need coverage. **Fix:** Bad fixtures for each form, plus the `$<digit>` literal rule from A-5.

---

## 5. Hidden complexity

- **H-1: "Identical after normalization" is doing heavy lifting in the W1 inventory.** Differences hide in the PGLite `dropRowTypeArrayParsers` behavior (pglite-statements.ts:196), int8 as string versus bigint, halfvec/vector cast probes (`resolveFactsEmbeddingCast`), and PGLite checkpoint admission. The inventory needs a fourth class: "identical SQL, different driver post-processing". Those methods move SQL but keep an engine-side adapter.
- **H-2: The snapshot hash list is hand-maintained and already misses bootstrap code.** `computeSnapshotSchemaHash` lists about 30 files, and neither forward-reference bootstrap is among them. PGLite's bootstrap is inline in `pglite-engine.ts` (~1077-1400), and Postgres's is in `postgres-engine/forward-reference-bootstrap.ts`. If E1 merges them into a shared module that initSchema runs, decide whether it is a hash input. The W7 transitive-import test should compute inputs from `pglite-schema.ts` + `schema-migrations/index.ts` + the bootstrap module, not from an extended hand list.
- **H-3: Generated `schema-migrations/index.ts` conflicts on every concurrent migration PR** (both append a line). **Fix:** Document "regenerate, never hand-merge" in the porting kit, and optionally set `merge=union` plus the duplicate check, which catches union artifacts.
- **H-4: Cold-start budget covers only `--version`.** Twenty-two modules import `LATEST_VERSION`/`MIGRATIONS`. Under `bun run` (non-compiled), any of them on a hot startup path now parses 170+ files. **Fix:** Add `gbrain doctor --fast` or an engine-connect cold start to (f), non-compiled.
- **H-5: The CLI table must keep the module-load alias collision check** (cli.ts:318-330) running over the derived table. Derived sets equal to master's also preserve master's known inconsistencies. That is correct for behavior preservation, so list them in the PR rather than "fixing" them silently.
- **H-6: One PR with W0-W7 is consistent with the owner's rule, but the review burden needs care.** The mitigation is already in the plan: move-only commits with `verify-move-only`, and cut-lines. The W1-extended gate is "pending owner approval". Resolve that before W1 starts, because it determines whether the landing window (51 open PRs on target paths) is weeks or days.

---

## Summary of required plan edits (priority order)

1. **A-1/A-2/A-4:** The executor calls `runUnsafe` with `{prepare: true, simple: false}`, uses no raw gauge label, and has matching E5 assertions.
2. **A-3/T-2:** Resolve the executor per call. Add a per-domain rollback test on both engines.
3. **A-8/T-1:** No `schema-migrations/` → `migrate.ts` imports (enforced by a guard). Hash handler source from AST, not `toString()`.
4. **S-1:** Fix the E9 wording so `/metrics` and `/admin/events` become must-guard, not allowlisted.
5. **A-6/A-7:** Keep the PGLite bootstrap as a template, snapshot E4 in three configs, and give `build:schema` a full generator chain with a chain freshness guard.
6. **A-5/E-1:** Specify the fragment combinator, ban literal `$n` in composed SQL, and bind lists with `ANY`.
7. **A-9/S-3:** Keep the scoped-read wrap set equal to master's, restrict importers of the unscoped escape hatch, and harden the forge guard.
8. **E-5:** Enforce monotonic migration versions against `origin/master` in CI.
9. **T-3..T-6, S-2, H-2..H-4:** Coverage exemption transfer, golden normalizers, multi-checkpoint replay, a shared serve-http context, a global middleware golden, a computed snapshot hash, and a broader cold-start budget.
