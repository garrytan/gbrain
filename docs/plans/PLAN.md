# Plan: a Rust storage engine for gbrain

> **The plan of record is [docs/designs/RUST_ENGINE.md](../designs/RUST_ENGINE.md) (PR #9593). This draft is kept as research.**

> **Draft, pending Garry's /autoplan review; no build phase approved yet.**

Status: DRAFT for review with gstack `/autoplan`. Only decisions D1 and D2
are answered (section 2.1). No build phase starts until Garry approves it.

Date: 2026-11-16 (America/Los_Angeles). Updated the same day for decisions D1
and D2, when the plan and the research maps moved into garrytan/gbrain.

## 1. Summary

We add a third storage engine to gbrain. The engine is written in Rust. It
implements the `BrainEngine` interface as engine kind `'rust'`, next to
`'pglite'` and `'postgres'`. Both existing engines stay supported. If the Rust
engine proves itself on parity and on benchmarks, PGLite can be deprecated
later. That deprecation is a separate decision and is not part of this plan.

A full Rust CLI or Rust MCP server is not a target of this plan. The CLI and
MCP stay in TypeScript and call the Rust engine through `BrainEngine`.

The work is split into phases. Each phase ships as a series of small PRs.
Each phase has a parity gate: gbrain tests, gbrain-evals runs and benchmarks
against PGLite and Postgres. A phase is done only when its gate passes.

Phase 0 has no open decision, but like every phase it needs Garry's approval before
any work starts. It would prepare the test and eval harness and add an
engine switch with no behavior change. Section 9 lists the decisions. D1
and D2 are answered. The other eight are open, each with options, a
recommendation and the phase it blocks.

## 2. Decision record and reference pins

### 2.1 Decided

| Item | Decision |
|---|---|
| Direction | A Rust storage engine that implements `BrainEngine` as kind `'rust'` inside garrytan/gbrain. |
| Other engines | PGLite and Postgres stay supported. |
| PGLite deprecation | Possible later, only after the Rust engine passes parity and benchmarks. Not in this plan. |
| Rust CLI and MCP | Not the first target. Out of scope for this plan. |
| Delivery | Phased. Small reviewable PRs. A parity gate for each phase. |
| Where the work lives (D1) | Garry, 2026-11-16: the research maps, this plan and the Rust code all live in garrytan/gbrain. The maps are in [`docs/research/rust-engine/`](../research/rust-engine/README.md), this plan is `docs/plans/PLAN.md`, and the Rust crate goes in gbrain (draft path `native/store/`, next to `native/locks/`). garrytan/gbrain-rust is no longer used. |
| How PRs land (D2) | Garry, 2026-11-16: "No draft PRs: open them and then tell Capy Minder in Capy to put it in the merge queue." Every PR is a normal (non-draft) PR against gbrain `master`. When its head is final and its checks are green, the author asks GBrain Minder (the Capy agent that runs the gbrain merge queue) to queue it. The author never merges and never turns on auto-merge. |

### 2.2 Reference pins

All line numbers in this plan refer to these commits unless a link says
otherwise.

| Repository | Ref | Notes |
|---|---|---|
| garrytan/gbrain | `8bbfd0b5e8` (`master`, VERSION 0.60.733.0) | The research commit for the maps. It is 6 commits after tag `v0.60.733.0` (`6ce7195b44`). |
| garrytan/gbrain | `6ce7195b44` (tag `v0.60.733.0`, also `latest-stable`) | The gbrain pin of gbrain-evals. Proposed parity baseline (decision 9). |
| garrytan/gbrain | `830f193d6a` (`master` on 2026-11-16) | Master moved 12 commits past the tag. The engine-facing drift is small (see 2.3). |
| garrytan/gbrain-evals | `cd447b3ae` (`main`, "Release v0.10.237") | The research commit for the eval maps. `main` is now `71a714b99` (v0.10.238). |
| gbrain-evals pins | gbrain `6ce7195b44a0`, gbrain-cues `939232f` (0.55.0.0), gbrain-reader `e78f1c3` (0.59.0.0) | From the eval import map. |

### 2.3 Drift since the pins

- From tag `v0.60.733.0` to `8bbfd0b5e8`: 142 files changed. The
  engine-facing part is one new migration
  (`v318-guard-ledgers-fail-closed.ts`), 40 lines in `src/schema.sql` and the
  regenerated migration registry.
- From `8bbfd0b5e8` to `830f193d6a`: `src/core/engine.ts` changed 2 lines.
  No schema or parity-test changes.
- Rule: each phase starts with a rebase onto the current baseline tag and a
  diff of `src/core/engine.ts`, `src/schema.sql`,
  `src/core/schema-migrations/` and `test/e2e/engine-parity.test.ts`. A
  change in those paths updates the phase checklist before code starts.

### 2.4 Research maps

The plan is grounded in four groups of research maps. They live in
[`docs/research/rust-engine/`](../research/rust-engine/README.md) in
garrytan/gbrain; that folder's README is the index. They were first written
on research branches of the former garrytan/gbrain-rust repository; the
origin commit of each group is listed for provenance. The two group READMEs
became `storage-engine.md` and `agent-contract.md`.

| Map | Origin commit | Files |
|---|---|---|
| Storage engine | `research/storage-engine` (`732536c`) | [storage-engine.md][se-readme], [brain-engine.md][se-engine], [postgres-features.md][se-pg], [schema.md][se-schema] |
| Jobs and tests | `research/jobs-and-tests` (`dd80436`) | [background-jobs.md][jt-jobs], [subsystems.md][jt-sub], [test-suites.md][jt-tests] |
| Agent contract | `research/agent-contract` (`d938e33`) | [agent-contract.md][ac-readme], [agent-and-eval-usage.md][ac-usage], [brain-format.md][ac-format], [cli.md][ac-cli], [mcp.md][ac-mcp] |
| gbrain-evals | `research/gbrain-evals` (`8bd502b`) | [gbrain-evals.md][ge-main], [engine-selection.md][ge-engine], [brainbench-categories.md][ge-cats], [longmemeval-and-memory-benchmarks.md][ge-lme], [scripts-tests-ci.md][ge-ci], [imports.md][ge-imports] |

## 3. Goals and non-goals

### 3.1 Goals

1. A `RustEngine` class that implements all 197 callable members of
   `BrainEngine` ([`src/core/engine.ts:830`][gb-engine-iface]).
2. Behavior parity with the reference engine (decision 7) on every method,
   proven by tests that run the same cases on each engine.
3. Search quality that is equal to or better than PGLite on gbrain-evals
   retrieval runs, inside the tolerance of decision 7.
4. Better operation than PGLite for local brains. Targets: faster cold open,
   lower memory, faster bulk import, and no `pglite_busy` lockout between
   gbrain processes on one machine.
5. A safe path for an existing PGLite brain to move to the Rust engine, and
   back.
6. Prebuilt native binaries for the same platforms that `native/locks/`
   supports today, and embedding in the `bun --compile` release binaries.

### 3.2 Non-goals

- A Rust CLI, a Rust MCP server, or a change to the agent contract (204 ops,
  186 MCP tools, 707 error codes; see the [agent-contract map][ac-readme]).
- Removal or deprecation of PGLite or Postgres.
- A multi-machine or hosted deployment of the Rust engine. Postgres stays the
  engine for shared and hosted brains.
- Exact equality of search scores with Postgres `ts_rank` or pgvector. Section
  8 defines the tolerance.
- A change to gbrain-evals `main` before decision 10 is answered.

## 4. Architecture sketch

```
            gbrain CLI / MCP / jobs (TypeScript, unchanged)
                              |
                       BrainEngine interface
            +-----------------+------------------+
            |                 |                  |
     PostgresEngine     PGLiteEngine        RustEngine (new, TS facade)
     engine-sql/ +      engine-sql/ +             |
     dialect-postgres   dialect-pglite      binding (decision 5)
                                                  |
                                       gbrain-store (Rust crate)
                                       - storage core (decision 6)
                                       - write-path rules (ported triggers)
                                       - keyword + vector search
                                       - job queue and leases
                                       - raw SQL policy (decision 4)
```

Main points:

- `src/core/rust-engine.ts` is a thin TypeScript facade. It maps each
  `BrainEngine` method to one call into the Rust crate. It holds no SQL.
- The Rust crate owns the schema, the write-path rules and the search. The
  crate exposes typed methods, not a SQL surface.
- The facade converts types at one boundary: `Date` objects, 64-bit ids,
  `null` vs `undefined`, and JSON values (no double encoding). The parity test
  already checks these rules (see [brain-engine.md][se-engine]).
- The existing native addon `native/locks/` is the precedent for the build,
  the prebuilds and the `--compile` embedding: a literal `require` in
  [`src/core/persistence/native-lock.ts:94-140`][gb-native-lock], 8 checked-in
  prebuilds with a `manifest.json` (sha256), `scripts/native/build.ts`,
  `verify.ts`, `toolchain.json`, and CI in `.github/workflows/native-locks.yml`.
- The engine registers through the existing factory:
  [`src/core/engine-construct.ts:12-23`][gb-construct]. ENGINES.md "Adding a
  new engine" describes the steps. Step 4 of that list is not accurate today
  (see [brain-engine.md][se-engine]); PR 0.1 fixes it.

## 5. Risk register

Each row names the risk, the evidence in the maps, the mitigation and the
phase that owns the mitigation.

| # | Risk | Evidence | Mitigation | Phase |
|---|---|---|---|---|
| R1 | Raw Postgres SQL outside the engines. | 1,204 files in `src/` outside `pglite-engine.ts`, `postgres-engine.ts` and `engine-sql/` call `engine.executeRaw` (on master `830f193d6a`; the map counted 1,203). Top areas: `persistence/` 232, doctor 123, repair 61, facts 46, minions 40. About 57 gbrain-evals files and 3,294 gbrain test files also call it. The map calls this the largest single cost ([postgres-features.md][se-pg]). | Phase 0 makes an inventory and a ratchet, so the count can only go down. The Rust `executeRaw` refuses with a typed error that names the call site (decision 4). Each phase ports the call sites of its domain to named `BrainEngine` methods, which help all three engines. A command that reaches an unported site fails with a clear error. It does not fail silently. | 0, then each phase |
| R2 | The parity test is narrow and needs Postgres. | `test/e2e/engine-parity.test.ts` covers 60 of 197 methods. `describeBoth = SKIP_PG ? describe.skip : describe` ([lines 32-33][gb-parity-gate]) also hides the PGLite half when `DATABASE_URL` is unset. The file header and `docs/TESTING.md:509` are wrong about this. Without `DATABASE_URL`, 1 test runs; with it, 76 run. Many of the 137 uncovered methods (salience, takes, contradictions, ontology, segments) have only PGLite unit tests. | Phase 0 un-gates the PGLite half, makes the engine list a parameter (the `getRawData` arms pattern at [lines 2716-2723][gb-parity-arms]), and adds a coverage report of methods vs tests. Each later phase adds parity cases for the methods it builds. The Rust arm joins the 820 dual-arm unit files through `testBackends()`. | 0, 2-6 |
| R3 | About 25 trigger functions hold logic. | Search-vector maintenance, page and tag revisions, the projection queue, derivation scope, the minion queue protocol (`claim_generation` must advance by exactly 1), the managed-writer guard (P0001 `writer_coordinator_required`, which reads the GUCs `gbrain.write_sources`, `gbrain.topology_change`, `gbrain.git_protocol`), skill publication and access/trust/purge guards ([postgres-features.md][se-pg], [schema.md][se-schema]). | Phase 0 writes characterization tests for each trigger. The tests drive the trigger through public methods and run on PGLite and Postgres. In Rust, each trigger becomes an explicit write-path step in one module. The same tests then run on the Rust arm. Storage-core triggers are used only for pure row maintenance. | 0, 4 |
| R4 | `SKIP LOCKED` job claims and named transaction locks. | Claim at [`minions/queue.ts:1463-1520`][gb-claim] uses `UPDATE ... WHERE id=(SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)`. Fenced updates use `lock_token` with `status='active'`. About 15 `pg_advisory_xact_lock(hashtext(...))` key families. Key 42 is the schema lock. `gbrain_cycle_locks` is a TTL lease table. `db-lock.ts` throws `Unknown engine kind for db-lock` for any third kind (8 sites). LISTEN/NOTIFY on Postgres only; PGLite polls every 1 s ([background-jobs.md][jt-jobs]). | With one writer at a time (decision 3), a claim is a plain transaction: select the next row by priority and `created_at`, then set the lease. Named locks become a keyed lock table or an in-process keyed mutex, chosen per key family. Wake-up uses a cheap change counter (for example `PRAGMA data_version` on SQLite) plus the existing poll backstop. Queue property tests (fencing, reapers, retry backoff) run on all engines. | 5 |
| R5 | PGLite single-process model vs Postgres multi-writer model. | PGLite allows one process per data directory through a native flock (`pglite-lock.ts`). It throws `PgliteBusyError` and routes through the owner socket. Postgres serves many writers: CLI, `serve`, `jobs work`, supervisor children, cron, hooks. `persistence/` (353 files, 83,827 lines) is the write coordination layer for managed brains (request journal, owner election, effect journal, graduation). It runs on PGLite too: `persistence/service.ts:160` registers a PGLite reopen hook ([subsystems.md][jt-sub]). | Decision 3. The recommendation is many processes, one writer at a time, with readers that do not block. This is better than PGLite and smaller than Postgres. Managed brains (the `persistence/` layer) are out of scope until Phase 6. Before Phase 6, the Rust engine refuses managed mode with a typed error at open time. | 1, 5, 6 |
| R6 | RLS. | `schema.sql:1830-1861` enables RLS on about 35-37 tables only when the role has BYPASSRLS. There is no `CREATE POLICY`, no `GRANT` and no `SECURITY DEFINER`. Authorization is in application code (`src/core/access/*`, `grants/*`, `scope.ts`, `persistence/authority.ts`, `minions/submission-authority.ts`). The opt-in `GBRAIN_RLS_SCOPE_BINDING` is an operator-managed Postgres layer. | RLS is a Postgres deployment layer, not engine behavior. The Rust engine is single-user and local, so it declares no RLS capability. The engine must honor every source filter that `sourceScopeOpts(ctx)` passes. Phase 2 adds a source-isolation parity suite that runs the same cross-source reads on all engines. `rls-every-table-postgres.test.ts` stays Postgres-only. | 2 |
| R7 | Search ranking cannot match exactly. | Keyword search uses `websearch_to_tsquery` + `ts_rank` with A/B/C weights, the Snowball English stemmer, tsvector caps and a CJK `ILIKE` fallback (2,000-candidate cap). Vector search uses pgvector HNSW with `ef_search`, iterative scan and an exact fallback; storage is `halfvec`. Hybrid uses RRF k=60, so order is what matters there. But `score_details` and keyset cursors expose raw scores. `findByTitleFuzzy` uses pg_trgm with threshold 0.3 ([postgres-features.md][se-pg]). | Do not try to copy `ts_rank`. Define parity as order and set metrics with a tolerance (section 8). Keep the parser rules (websearch syntax, stemmer, weights, CJK fallback) as close as the core allows, and test them case by case. Cursors encode an engine-local score and never cross engines. | 3 |
| R8 | Engine kind branches assume two engines. | About 268 strict `kind ===` sites, about 353 `'pglite'` literals in about 186 files, and about 375 checks that treat "not postgres" as PGLite ([brain-engine.md][se-engine]). | Phase 0 makes an inventory and moves the branches to capability flags where the ENGINES.md rule already asks for that ("never `if (engine === ...)` in domain code"). A guard fails CI on a new "not postgres means PGLite" branch. | 0 |
| R9 | Native build and release. | `release.yml:121-131,170,175` builds only `bun-darwin-arm64` and `bun-linux-x64`. `native/locks/` ships 8 prebuilds. A Rust crate adds a second native toolchain. | Copy the `native/locks/` pattern: checked-in prebuilds with sha256, a verify script, a dedicated CI workflow, and a literal `require` so `--compile` embeds the addon. `compiled-smoke.ts` opens a Rust brain on both release targets. | 1, 7 |
| R10 | Schema upgrades. | 313 migrations (the ledger has about 318 versions), many with data backfills. About 29 kind branches in `schema-migrations/`. `sqlFor` has 42 uses in 34 files. | The Rust engine does not replay Postgres migrations. It owns a versioned Rust schema with its own small migration list. Existing brains move by export and import (decision 8). The `sqlFor` branches get a `rust` arm that is a no-op or a typed method call. | 2, 7 |
| R11 | Precision and encoding rules. | `Date` objects, microsecond `last_wake_at` (`/\.\d{6}Z$/`), 64-bit ids (`loopId 2**40`), no JSON double encoding (#2339), `null` vs `undefined` rules, `TRAVERSE_PATH_ROW_CAP = 5000`, cycle guard at depth 25. | One conversion layer in the facade, with unit tests for each rule. Store time as integer microseconds since the epoch. Store ids as `i64`. Return `bigint` only where the interface does. | 2 |
| R12 | Doc comments that disagree with code. | `addLinksBatch`, `getEffectiveDates`, `createVersion`, `setPageAliases`, `updatePageContextualRetrievalState` and `insertFacts` ([brain-engine.md][se-engine]). | The code is the contract. Phase 0 adds parity tests that pin the code behavior and fixes the comments in the same PR. | 0 |
| R13 | Known PGLite vs Postgres differences. | `searchKeywordChunks` ignores `type`/`types`/`where`/`exclude_slugs` on PGLite. The `stale` flag is computed on PGLite and is a constant `false` on Postgres. | Decision 7 picks the reference for each known difference. The parity suite records each difference as a named, expected divergence, not as a skip. | 0, 3 |
| R14 | Data loss in migration from PGLite. | `gbrain migrate --to <engine>` (`src/commands/migrate-engine.ts`, 1,389 lines) copies pages, sources, facts, links, config and simple tables. Parts of it use `executeRaw`. | Reuse `migrate-engine.ts` with `--to rust`. Add a round-trip test: PGLite to Rust to PGLite, then compare a canonical dump. Never delete the source brain. | 7 |

## 6. Working rules for every phase

1. Small PRs. One PR does one thing. A PR that adds Rust code also adds the
   parity tests for that code.
2. No behavior change for PGLite or Postgres unless the PR says so in its
   title and has a test that shows the change. Phase 0 has no behavior change
   at all.
3. The Rust engine stays behind an experimental switch until Phase 8. Draft
   name: `GBRAIN_EXPERIMENTAL_RUST_ENGINE=1`. Without the switch, `engine:
   'rust'` in a config fails with a typed error and a fix hint. A merge to
   `master` therefore cannot change what users get.
4. Follow the gbrain rules in `CLAUDE.md`: evidence before trust, the
   cross-cutting invariants (fail-closed trust, source isolation, JSONB rule,
   engine parity, contract-first), the module-size ratchet, `changelog.d`
   fragments (PRs carry no version), and `/ship` for any ship step. Garry
   approves each build phase before its first PR.
5. Do not push to `main` or `master` in any repository. Do not merge, and do
   not turn on auto-merge. Open each PR as a normal (non-draft) PR with the
   `rust-engine` label. When its head is final and its checks are green, ask
   GBrain Minder to put it in the merge queue (decision D2). GBrain Minder
   lands it.
6. Each phase ends with a gate report. The report lists the pins (gbrain ref,
   gbrain-evals ref, Rust crate commit), each gate command, its exit status,
   the receipts and the benchmark table. The report goes in the phase's last
   PR.

### 6.1 The common gate (every phase)

Each phase gate includes these items, and they must stay green:

| Item | Command | Purpose |
|---|---|---|
| C1 | `bun run verify` | Typecheck and all guard scripts. |
| C2 | Full unit suite on PGLite (CI `test.yml`, 36 unit shards + 4 serial) | No PGLite regression. |
| C3 | `bun run test:e2e` with `DATABASE_URL` (direct and PgBouncer lanes, `scripts/e2e-backend-matrix.txt`) | No Postgres regression. |
| C4 | `bun run ci:local` (or `ci:ubicloud`) | The full gate, as the release runs it. |
| C5 | The `executeRaw` ratchet from PR 0.6 | The count of unported raw SQL sites does not go up. |
| C6 | The kind-branch guard from PR 0.4 | No new "not postgres means PGLite" branch. |

The phase sections below list only the gate items that are new in that phase.

## 7. Phases

Legend for the PR lists: **[gbrain]** is garrytan/gbrain. **[evals]** is
garrytan/gbrain-evals, on a parity branch until decision 10 is answered.
**[rust]** is the Rust crate inside garrytan/gbrain (decision D1; draft path
`native/store/`).

Overview:

| Phase | Name | Blocked by decisions | Main output |
|---|---|---|---|
| 0 | Harness and engine switch | none | Parity harness that accepts a third engine. A `'rust'` kind that fails closed. Inventories and ratchets. |
| 1 | Spike and skeleton | 3, 5, 6, 9 | Measured answers for binding and storage core. A Rust crate and a facade that open, close and run transactions. |
| 2 | Core data | 4, 7 | Pages, chunks, tags, links, timeline, sources, versions, config. Source isolation. |
| 3 | Search | 7, 10 | Keyword, vector, hybrid, fuzzy title, CJK. Retrieval evals. |
| 4 | Write-path rules and memory domains | 4 | Ported triggers. Facts, takes, salience, contradictions, ontology, segments, trust. |
| 5 | Jobs, locks and processes | 3 | Minion queue, named locks, cycle leases, multi-process access. |
| 6 | Managed brains and remaining raw SQL | 3, 4 | `persistence/` support, doctor, repair. Ratchet at zero for supported commands. |
| 7 | Brain lifecycle and release | 8 | `init --engine rust`, `migrate --to rust`, prebuilds, compiled binaries, docs. |
| 8 | Full parity and benchmark report | 7, 10 | Evidence for a later PGLite deprecation decision. |

### Phase 0: harness and engine switch (no open decision; not approved)

Scope: make the test and eval harness ready for a third engine, and add the
`'rust'` kind with no behavior change. No Rust code. Every PR in this phase is
TypeScript or a script.

PRs:

| PR | Repo | Change | Size |
|---|---|---|---|
| 0.1 | [gbrain] | Fix the parity gate. Replace `describeBoth` ([`engine-parity.test.ts:32-33`][gb-parity-gate]) with an arms list like `getRawData` ([lines 2716-2723][gb-parity-arms]): PGLite always, Postgres when `DATABASE_URL` is set. Fix the file header and `docs/TESTING.md:509`. Keep the Postgres-only `EXPLAIN (FORMAT JSON)` assertion (line 1592) in the Postgres arm only. Fix step 4 of ENGINES.md "Adding a new engine". | S |
| 0.2 | [gbrain] | Engine list as a parameter. `testBackends()` ([`test/helpers/test-backends.ts`][gb-test-backends]) and the parity arms read `GBRAIN_TEST_ENGINES` (draft name; default unchanged). The type stays `'pglite' \| 'postgres'` in this PR. Add a test for the env parsing. | S |
| 0.3 | [gbrain] | Method coverage report. A script lists each `BrainEngine` member and the parity and dual-arm tests that call it. It writes a TSV and fails CI only if coverage goes down. Start value: 60 of 197 in `engine-parity.test.ts`. | S |
| 0.4 | [gbrain] | Kind-branch inventory and guard. A script lists every `kind ===`, `kind !==` and `'pglite'` literal branch (about 268 strict sites, about 353 literals, about 375 "not postgres" checks) with a class: capability, PGLite-only feature, Postgres-only feature, or wrong two-engine assumption. A guard blocks new wrong assumptions. | M |
| 0.5 | [gbrain] | Add the `'rust'` kind, closed. Widen `BrainEngine.kind` ([`engine.ts:832`][gb-engine-iface]), `EngineConfig.engine` (`types.ts:2343`), `GBrainConfig.engine` (`config.ts:37`) and the `openEngine` validator (`engine-open.ts:94-106`). `constructEngine` returns a typed `engine_not_available` error for `'rust'` with a fix hint. `db-lock.ts` (8 sites) and `degraded-engine.ts` get an explicit `rust` arm that refuses. No other behavior change. | M |
| 0.6 | [gbrain] | `executeRaw` inventory and ratchet. A script lists every call site outside the engines (1,204 files today) with its subsystem, the commands that reach it, read or write, and the SQL features it uses (`FOR UPDATE SKIP LOCKED`, advisory locks, `WITH RECURSIVE`, JSONB operators, `tsvector`, pgvector, `information_schema`, `pg_*` catalogs). It stores a baseline TSV, like `scripts/engine-sql-baseline.tsv`. CI fails if the count goes up. | M |
| 0.7 | [gbrain] | Trigger characterization tests. One test file per trigger family: search vectors, page and tag revisions, generation clocks, projection queue, derivation scope, minion queue protocol, managed-writer guard, skill publication, access/trust/purge guards. The tests act through public methods and assert on what a caller sees. They run dual-arm. | M, split in 3 PRs |
| 0.8 | [gbrain] | Doc-versus-code fixes. Parity tests that pin the code behavior for `addLinksBatch`, `getEffectiveDates`, `createVersion`, `setPageAliases`, `updatePageContextualRetrievalState` and `insertFacts`. Fix the doc comments. Record the two known engine differences (keyword filters and `stale`) as named, expected divergences. | S |
| 0.9 | [gbrain] | Engine benchmark harness. A `bench/engine/` script that runs a fixed workload against any engine kind and writes JSON (section 10). Baseline runs on PGLite and Postgres. | M |
| E0.1 | [evals] | `openEvalEngine(gut)` in `eval/runner/gbrain-under-test.ts` (after `importGbrain`, line 119), read from `GBRAIN_EVAL_ENGINE=pglite\|rust` (default `pglite`). Move the 14 static importers to `importGbrain(gut)`. | M |
| E0.2 | [evals] | Lifecycle engine axis: `'rust'` in `eval/runner/lifecycle/slice.ts:37` and in `lifecycle-experiment.ts --engines` (refuses until gbrain has the engine). | S |
| E0.3 | [evals] | Receipts: record `engine_kind` in `resolved_config` and `execution.product`. Stamp `gut.version`, not `gbrainVersion()`. Add the `gbrainCommand(gut)` launcher seam for the later binary lane. | S |
| E0.4 | [evals] | Shared fixes that help all engines: `p5-brain.ts:94 edges()` through `getLinks`; counts through public reads where they exist. (`ensureSource` waits for PR 2.x in gbrain.) | S |

Parity gate for Phase 0:

| Gate | Command | Pass rule |
|---|---|---|
| 0.G1 | Common gate C1-C4 | Green. |
| 0.G2 | `bun test test/e2e/engine-parity.test.ts` without `DATABASE_URL` | The PGLite half runs (about 76 tests), not 1. |
| 0.G3 | Same file with `DATABASE_URL` | Same pass count as before PR 0.1, on both arms. |
| 0.G4 | [evals] gate 0.1: `bun run eval:brainbench` twice on TS PGLite at the pin | Produces the determinism list: entries that differ between two runs are not gates until fixed. |
| 0.G5 | [evals] gate 0.2: `bun run validate` plus the 48 gbrain-free test files | Green. |
| 0.G6 | [evals] gate 0.3: `bun eval/runner/lifecycle-experiment.ts --gbrain-repo <gbrain> --engines pglite --interfaces cli,mcp-stdio,mcp-http` | Green. Baseline receipts saved. |
| 0.G7 | [evals] gate 0.4: gate 0.G4 again with `GBRAIN_EVAL_ENGINE=pglite` after E0.1-E0.3 | Receipts equal to 0.G4 for every deterministic entry. Proves the switch is a no-op. |
| 0.G8 | Benchmark baseline (PR 0.9) on PGLite and Postgres | Numbers recorded. No pass rule. |

Cost: $0. No keys.

### Phase 1: spike and skeleton

Scope: answer decisions 5 and 6 with measurements, then build the smallest
`RustEngine` that can open, close, run a transaction and read and write
config. The spike is time-boxed to one week of work. Its code can be thrown
away; its numbers go in the decision record.

PRs:

| PR | Repo | Change |
|---|---|---|
| 1.1 | [rust] | Spike report, no product code. Load a napi-rs addon from Bun 1.4.4+ in dev and in `bun build --compile` on `bun-darwin-arm64` and `bun-linux-x64`. Measure call overhead (sync and async), large buffer transfer, and event-loop blocking. Measure the storage core candidate on the 0.9 workload: open time, write throughput, keyword and vector query latency, file size. Compare with the sidecar option on the same calls. |
| 1.2 | [rust] | Crate skeleton: `gbrain-store`, its build script, a `toolchain.json` like `scripts/native/toolchain.json`, CI that builds and tests on the 8 `native/locks/` targets, and prebuilds with a sha256 manifest. |
| 1.3 | [rust] | Storage core open, close, schema version table, transactions, a config key/value table. Crash-safety test: kill the process during a write, reopen, check integrity. |
| 1.4 | [gbrain] | `src/core/rust-engine.ts` facade and the `'rust'` case in `constructEngine`, behind the experimental switch. Methods outside this phase throw a typed `engine_method_not_built` error that names the method. Type conversion layer for dates, 64-bit ids, `null`/`undefined` and JSON, with unit tests (R11). |
| 1.5 | [gbrain] | `testBackends()` and the parity arms accept `rust`. The Rust arm runs only the tests whose methods are built. A list file states which; the coverage report from PR 0.3 reads it. |
| 1.6 | [gbrain] | CI lane `rust-engine.yml`: build the crate, run the Rust arm of the parity file and the selected dual-arm unit files. Non-blocking for other PRs until Phase 8. |

Parity gate for Phase 1:

| Gate | Command | Pass rule |
|---|---|---|
| 1.G1 | Common gate | Green. |
| 1.G2 | Spike report in PR 1.1 | Binding works in dev and in compiled binaries on both release targets. Numbers recorded. Garry answers decisions 5 and 6. |
| 1.G3 | Rust unit tests and the crash test | Green on all 8 targets (or on the targets that decision 5 keeps). |
| 1.G4 | `GBRAIN_TEST_ENGINES=rust` on the lifecycle tests for `connect`, `disconnect`, `initSchema`, `transaction`, `getConfig`, `setConfig` | Green. |
| 1.G5 | Benchmark: cold open, empty brain | Recorded against PGLite and Postgres. |

### Phase 2: core data

Scope: the methods that hold the brain itself: pages (put, get, list,
delete, restore, purge), chunks without search, tags, links and backlinks,
graph traversal, timeline, sources, versions, aliases, raw data, ingest log,
stats. Add `ensureSource` and a count-by-source/kind read to `BrainEngine`
and implement them on all three engines. Port the `executeRaw` sites that
these domains reach (decision 4).

PRs (each is one domain, about 5-15 engine methods, with its parity cases):

| PR | Repo | Change |
|---|---|---|
| 2.1 | [rust] + [gbrain] | Sources and source isolation. `ensureSource` on all engines. A source-isolation parity suite: the same cross-source reads must return the same rows on every engine, with `sourceScopeOpts` scalar and federated forms (R6). |
| 2.2 | [rust] + [gbrain] | Pages: `putPage`, `getPage`, `listPages`, soft delete, restore, purge, `getRawData`. Revision and generation numbers as plain write-path steps (the trigger port of those families moves here from Phase 4 because pages need them). |
| 2.3 | [rust] + [gbrain] | Chunks and the projection protocol used by `installFixtureChunks` (`src/core/page-state/projections.ts`). |
| 2.4 | [rust] + [gbrain] | Tags and aliases. |
| 2.5 | [rust] + [gbrain] | Links, backlinks, `traversePaths` with `TRAVERSE_PATH_ROW_CAP = 5000` and the depth-25 cycle guard. |
| 2.6 | [rust] + [gbrain] | Timeline and effective dates. |
| 2.7 | [rust] + [gbrain] | Versions, ingest log, stats, count read. |
| 2.8 | [gbrain] | Port the `executeRaw` sites reached by `put`, `get`, `list`, `sync` of an unmanaged brain to named methods. Update the ratchet baseline. |
| 2.9 | [gbrain] | Hidden `gbrain init --engine rust` (behind the switch) so out-of-process tests can make a Rust brain. Regenerate `cli-flag-registry.generated.ts`. |
| E2.1 | [evals] | Use `ensureSource` and the count read in the runners that `INSERT INTO sources` or count with SQL (Cat 19, 22, 27, 28, N4-similar, N8, ARS). |

Parity gate for Phase 2:

| Gate | Command | Pass rule |
|---|---|---|
| 2.G1 | Common gate | Green. |
| 2.G2 | `engine-parity.test.ts` with `GBRAIN_TEST_ENGINES=pglite,rust` (and `postgres` in CI) | Every describe block for the Phase 2 domains passes on the Rust arm. Exact equality of rows, including null/undefined, Date objects, microsecond times and 64-bit ids. |
| 2.G3 | The dual-arm unit files for these domains with the Rust arm | Green. The list is in the PR 1.5 file. |
| 2.G4 | Source-isolation suite | Green on all three engines. |
| 2.G5 | [evals] gate 1a: Cat 1, 3, 4, 10, 11, 12, 23, N12, N15, `temporal-ingest-answer`, `scripts/generate-v0.41-launch.ts --check` with `GBRAIN_EVAL_ENGINE=rust` | Receipts equal to the PGLite receipts. $0, under 2 minutes. |
| 2.G6 | Benchmark: bulk import of the fixed corpora, `get` and `list` latency | Recorded. Targets in section 10 are report-only until Phase 8. |

### Phase 3: search

Scope: keyword search, vector search, hybrid wiring through the existing
TypeScript `hybridSearch`, `findByTitleFuzzy`, CJK search, the keyword
timeout and negative cache, and the search filters. Score fields stay in the
result type, but the values are engine-local (R7).

PRs:

| PR | Repo | Change |
|---|---|---|
| 3.1 | [rust] + [gbrain] | Keyword: query parser for the websearch syntax (quotes, `or`, `-term`), English stemming, A/B/C field weights, the tsvector length caps, all filters (`type`, `types`, `where`, `exclude_slugs`, sources). Case tests for each syntax rule. |
| 3.2 | [rust] + [gbrain] | CJK keyword fallback with the 2,000-candidate cap. Ordered-equality test for the CJK parity case. |
| 3.3 | [rust] + [gbrain] | Vector: storage at half precision, exact scan first. Inner-pool and escalation behavior for the 120-chunk fixture with an inner pool of 100. |
| 3.4 | [rust] | Vector ANN index, only if the 3.3 benchmark shows the exact scan misses the target at 100k chunks. |
| 3.5 | [rust] + [gbrain] | Fuzzy title match. Calibrate the threshold so the fuzzy parity fixtures give the same hits as pg_trgm at 0.3. |
| 3.6 | [rust] + [gbrain] | Keyword timeout and negative cache (`KeywordSkippedAfterTimeoutError`, 8 s, 600 s). Keyset cursors that encode the engine-local score. |
| 3.7 | [gbrain] | Port the search-path `executeRaw` sites. |
| E3.1 | [evals] | LongMemEval-S runner accepts `GBRAIN_EVAL_ENGINE`. |

Parity gate for Phase 3:

| Gate | Command | Pass rule |
|---|---|---|
| 3.G1 | Common gate | Green. |
| 3.G2 | Search parity blocks in `engine-parity.test.ts` with the Rust arm | Top-1 equal and top-5 set equal on the fixtures (the rule the file uses today). CJK order equal. Scores are not compared. |
| 3.G3 | [evals] gate 1b: P5 trio, Cat 6, 19, 22, 24, 27, 28, N4-similar, N8, ARS, A4, N2, N9 | Verdicts equal to PGLite. Ranked id lists reported per query. $0, about 10 minutes. |
| 3.G4 | [evals] LongMemEval-S `--keyword-only` (470 questions, keyless) on PGLite and Rust | Recall@5 inside the decision-7 tolerance (draft: not lower than PGLite by more than 1.0 point). |
| 3.G5 | [evals] LongMemEval-S hybrid with a warm embed cache (paid once, about $2-$7.56; decision 10) | Same rule as 3.G4. |
| 3.G6 | Benchmark: keyword, vector and hybrid p50 and p99 at 10k and 100k pages | Recorded against PGLite and Postgres. |
| Report only | Cat 7 `perf.ts`, Cat 28 latency, rerank arm (about $0.35-$0.50) | Side by side. |

### Phase 4: write-path rules and memory domains

Scope: port the remaining trigger families as explicit write-path steps, and
build the memory domains that today have only PGLite unit tests: facts,
takes, salience, contradictions, ontology, segments (large page bodies),
trust tiers, page versions with valid time, derivation scope, skill
publication guards.

PRs: one PR per domain (4.1 facts, 4.2 takes, 4.3 salience, 4.4
contradictions, 4.5 ontology, 4.6 segments, 4.7 trust and access guards,
4.8 derivation scope and purge guards, 4.9 skill publication). Each PR:

- implements the methods and the write-path steps in Rust;
- moves the domain's PGLite-only unit tests to dual-arm or parity form, so
  they run on all three engines;
- ports the domain's `executeRaw` sites (facts alone has 46 files);
- runs the PR 0.7 characterization tests for the trigger family on the Rust
  arm.

Parity gate for Phase 4:

| Gate | Command | Pass rule |
|---|---|---|
| 4.G1 | Common gate | Green. |
| 4.G2 | PR 0.7 trigger characterization suite, Rust arm | Green for every trigger family except the minion queue protocol and the managed-writer guard (Phases 5 and 6). |
| 4.G3 | Domain parity and dual-arm tests | Green on the Rust arm. Method coverage (PR 0.3) above an agreed floor (draft: 150 of 197). |
| 4.G4 | [evals] Cat 37-39 (after `memory-trust/sut.ts` drops `dumpDataDir`), N3, temporal-edges, N13, N14, N2 | Receipts equal to PGLite. |
| 4.G5 | Benchmark: write latency for `putPage` with facts and segments | Recorded. |

### Phase 5: jobs, locks and processes

Scope: the minion queue, named locks, cycle leases and access from many
processes, as decision 3 defines.

PRs:

| PR | Repo | Change |
|---|---|---|
| 5.1 | [rust] + [gbrain] | Queue claim, lease and fenced updates by `lock_token`; `claim_generation` advance by exactly 1; priority then `created_at` order. |
| 5.2 | [rust] + [gbrain] | Reapers (stalled, timeouts, wall-clock timeouts), retry with `max_attempts` 3 and exponential backoff with 0.2 jitter. |
| 5.3 | [rust] + [gbrain] | Wake-up: a change counter plus the existing poll backstop. No LISTEN/NOTIFY. |
| 5.4 | [rust] + [gbrain] | Named locks: map each of the about 15 advisory-lock key families and key 42 to a keyed lock (table or in-process mutex, per family, with the reason in a table in the PR). `db-lock.ts` `rust` arm and `gbrain_cycle_locks` leases. |
| 5.5 | [rust] + [gbrain] | Multi-process access per decision 3. Typed busy error with a retry hint if a write cannot get the lock in time. Tests with several real processes: CLI, `serve`, `jobs work`. |
| 5.6 | [gbrain] | Port the minions (40 files) and jobs `executeRaw` sites. |

Parity gate for Phase 5:

| Gate | Command | Pass rule |
|---|---|---|
| 5.G1 | Common gate | Green. |
| 5.G2 | Queue suites and the queue-protocol characterization tests, Rust arm | Green. Includes a property test: N workers, M jobs, every job runs once per attempt, no lost lease, no double claim. |
| 5.G3 | Multi-process stress test (new) | No corruption, no lost write, no deadlock in 30 minutes with 8 processes. |
| 5.G4 | [evals] gate 1c: N1 CI and N5 CI slices; `lifecycle-experiment --engines pglite,rust --interfaces cli,mcp-stdio,mcp-http` | Receipts equal to PGLite. |
| 5.G5 | [evals] skillopt Cat 30-33 (db-lock users) | Receipts equal to PGLite. |
| 5.G6 | Benchmark: claim throughput with 1, 4 and 16 workers; read latency during writes | Recorded against PGLite and Postgres. |

### Phase 6: managed brains and remaining raw SQL

Scope: support managed brains (the `persistence/` layer: request journal,
owner election, effect journal, sync holds) on the Rust engine, and the
managed-writer guard (P0001 `writer_coordinator_required`). Port the doctor
(123 files) and repair (61 files) `executeRaw` sites. PGLite-to-Postgres
graduation stays PGLite and Postgres only, unless decision 8 adds Rust to
it.

PRs: split by `persistence/` area (journal, owner election, effect journal,
sync holds, managed-writer guard), then doctor checks by group, then repair
lanes by group. Each PR ports its sites and adds the Rust arm to the area's
tests.

Parity gate for Phase 6:

| Gate | Command | Pass rule |
|---|---|---|
| 6.G1 | Common gate | Green. |
| 6.G2 | `persistence/` test files, Rust arm | Green. |
| 6.G3 | Managed-writer guard characterization tests, Rust arm | Green. |
| 6.G4 | `executeRaw` ratchet | Zero unported sites on the paths of every supported command. The list of unsupported commands, if any, is in the gate report. |
| 6.G5 | `gbrain doctor --json` on a Rust brain | No check fails because of the engine kind. |

### Phase 7: brain lifecycle and release

Scope: everything a user needs to make, move and run a Rust brain.

PRs:

| PR | Repo | Change |
|---|---|---|
| 7.1 | [gbrain] | `gbrain migrate --to rust` and `--to pglite` from Rust, reusing `src/commands/migrate-engine.ts`. Round-trip test: PGLite to Rust to PGLite, compare a canonical dump (R14). |
| 7.2 | [gbrain] | `init --engine rust` made public (still behind the switch), `engine status`, config inference (`config.ts:738-751`, `toEngineConfig` at `config.ts:1968-1975`), `embedded-engine.ts`. |
| 7.3 | [gbrain] | Doctor checks for the Rust engine (file integrity, schema version, lock state). |
| 7.4 | [gbrain] | Release: add the prebuilds to `release.yml`, extend `compiled-smoke.ts` to create, write, search and reopen a Rust brain on both release targets. |
| 7.5 | [gbrain] | Backups and snapshots: a Rust snapshot format for `backup/snapshot.ts` (which today calls `engine.db.dumpDataDir`). |
| 7.6 | [gbrain] | Docs: ENGINES.md (the "two engines" text at line 7, the capability matrix, "Future engine ideas"), KEY_FILES entries, a guide with "Say to your agent" prompts, `bun run build:llms`. |
| E7.1 | [evals] | Rust snapshot path or rebuild path for Cat 36, Cat 37-39 and LongMemEval-M. |

Parity gate for Phase 7:

| Gate | Command | Pass rule |
|---|---|---|
| 7.G1 | Common gate | Green. |
| 7.G2 | Round-trip test on the fixed corpora and on a large synthetic brain | Canonical dumps equal. |
| 7.G3 | `compiled-smoke.ts` on `bun-darwin-arm64` and `bun-linux-x64` | Green with a Rust brain. |
| 7.G4 | Fresh-machine install test | `bun install -g` from the branch, `init --engine rust`, `put`, `query`, reopen. |

### Phase 8: full parity and benchmark report

Scope: prove parity across the whole system and publish the numbers. This
phase makes no deprecation decision. It gives Garry the evidence.

PRs:

| PR | Repo | Change |
|---|---|---|
| 8.1 | [gbrain] | Rust arm on by default in `testBackends()` and in the parity file. The CI lane becomes blocking. |
| 8.2 | [evals] | Full offline tier with `GBRAIN_EVAL_ENGINE=rust`. Remaining runners moved from bucket C. |
| 8.3 | [evals] | Benchmark report `docs/benchmarks/<date>-rust-engine.md` that follows the 12-section format in the gbrain-evals `CLAUDE.md`. |
| 8.4 | [gbrain] | Remove the experimental switch, if Garry approves. |

Parity gate for Phase 8:

| Gate | Command | Pass rule |
|---|---|---|
| 8.G1 | Common gate plus the full unit suite with the Rust arm | Green. Method coverage 197 of 197. |
| 8.G2 | [evals] `bun run eval:brainbench` with `GBRAIN_EVAL_ENGINE=rust` | All 37 offline entries: receipts equal to PGLite (deterministic entries) or inside tolerance (ranking entries). |
| 8.G3 | [evals] paid retrieval runs that decision 10 names | Inside tolerance. |
| 8.G4 | Benchmark suite (section 10) | Each target met, or each miss explained in the report. |

## 8. Parity method and tolerances

### 8.1 Parity levels

| Level | What is compared | Rule |
|---|---|---|
| L1 Exact | Non-search method results: rows, counts, errors, ids, timestamps, JSON | Exact equality. Same error code and the same error text where tests check text (for example `refusing to overwrite non-empty page`). |
| L2 Order | Keyword and vector result order on fixtures | Top-1 equal and top-5 set equal. CJK order equal. |
| L3 Metric | Retrieval quality on eval datasets | Inside the decision-7 tolerance. Draft: Recall@5 and MRR not lower than the reference by more than 1.0 point absolute. Higher is allowed. |
| L4 Report | Latency, memory, disk size | No equality rule. Side-by-side table. Targets in section 10. |

Score values (`score`, `score_details`) are never compared across engines.
Keyset cursors are valid only on the engine that made them.

### 8.2 Reference behavior

The parity suite has one expected result per case. Where PGLite and Postgres
agree, that result is the reference. Where they differ, decision 7 picks the
reference, and the suite names the difference as an expected divergence on
the other engine. Known differences today:

| Difference | PGLite | Postgres | Draft reference |
|---|---|---|---|
| `searchKeywordChunks` filters (`type`, `types`, `where`, `exclude_slugs`) | Ignored | Applied | Applied (Postgres) |
| `stale` flag | Computed | Constant `false` | Computed (PGLite) |
| Concurrent access | One process per data directory | Many writers | Decision 3 |
| `EXPLAIN` plan shape | Not asserted | Asserted at `engine-parity.test.ts:1592` | Not part of parity |

### 8.3 How to compare eval receipts

From the gbrain-evals map, section 9.3:

- Run each gate twice on TypeScript PGLite first. An entry that differs
  between two TypeScript runs is not a gate until it is fixed.
- Compare receipts, not exit codes: `run_status`, `verdict`, `n_total`,
  `n_scored`, `errors` and the per-item rows. Exact equality for
  deterministic runners. Per-query ranked id lists for ranking runners, with
  order differences and metric differences reported apart.
- Record `engine_kind`, the Rust crate commit and `gut.version` in each
  receipt.

## 9. Open decisions

Garry answered D1 and D2 on 2026-11-16; their rows record the answer. The
other eight are open. Each has options, a recommendation and the phase it
blocks. No open decision blocks Phase 0, but it still needs approval before any work starts.

| # | Decision | Options | Recommendation | Blocks |
|---|---|---|---|---|
| D1 | Where the plan, the maps and the build code live, and what happens to gbrain-rust. | (a) Rust crate and facade in garrytan/gbrain; gbrain-rust keeps the maps and the plan. (b) Crate in gbrain-rust, published as a prebuilt package that gbrain pins. (c) Move everything into gbrain and stop using gbrain-rust. | **Decided by Garry, 2026-11-16: (c).** The maps (`docs/research/rust-engine/`), this plan (`docs/plans/PLAN.md`) and the Rust code all live in garrytan/gbrain. garrytan/gbrain-rust is no longer used. One PR can change the Rust code, the facade and the parity tests together, and one CI runs them. | Answered |
| D2 | How PRs are submitted and landed. | (a) Draft PRs against gbrain `master`; Garry reviews, marks ready and merges. (b) Branches only; Garry opens PRs. (c) A long-lived integration branch. (d) Normal (non-draft) PRs that GBrain Minder lands through its merge queue. | **Decided by Garry, 2026-11-16: (d).** His words: "No draft PRs: open them and then tell Capy Minder in Capy to put it in the merge queue." Each PR carries the `rust-engine` label and a `changelog.d` fragment. When its head is final and checks are green, the author asks GBrain Minder to queue it and never merges it. Build phases still need Garry's approval of this plan first. Open, as I read it: whether gbrain-evals PRs follow the same flow (GBrain Minder lands gbrain PRs only). | Answered |
| D3 | Process model, and whether `persistence/` is in scope. | (a) One writer process (a daemon); other processes call it through a socket, like the PGLite owner socket. (b) Many processes, one writer at a time through the storage core lock (for SQLite: WAL, `BEGIN IMMEDIATE`, `busy_timeout`), readers do not block. (c) An exclusive file lock per brain, like PGLite (`pglite_busy`). For `persistence/`: in scope now, in scope at Phase 6, or out of scope. | (b), with a typed busy error after a bounded wait. It removes the `pglite_busy` lockout and needs no daemon. `persistence/` in scope at Phase 6. Before Phase 6 the Rust engine refuses managed mode. | Phase 1 (design), Phase 5, Phase 6 |
| D4 | Raw SQL handling. | (a) Refuse: Rust `executeRaw` throws a typed error that names the call site. Port call sites to named `BrainEngine` methods, domain by domain. (b) Translate a subset of Postgres SQL to the storage core dialect with a SQL parser. (c) Pass SQL through to the core (works only for an SQL core) with compatibility functions. | (a). Named methods also help PGLite and Postgres, and they are testable. A translator (b) can change meaning without an error, and it grows without limit (JSONB operators, `FOR UPDATE SKIP LOCKED`, `WITH RECURSIVE`, catalogs). The PR 0.6 inventory orders the work by the commands that reach each site. | Phase 2 |
| D5 | Binding. | (a) napi-rs addon in-process. (b) A sidecar process with a local socket protocol. (c) WASM. (d) `bun:ffi`. | (a), with (b) as the fallback if the Phase 1 spike fails. (a) has the lowest call cost and copies the `native/locks/` release pattern. (c) has no mmap and no flock in WASI. (d) is experimental in Bun. | Phase 1 |
| D6 | Storage core. | (a) SQLite (bundled) with FTS5 for keyword search and a vector store in the same file (exact scan first, an ANN index later if needed). (b) A key-value store with tantivy for keyword search and a separate vector index. (c) libSQL, a variant of (a) with native vector columns. | (a). One file and one transaction cover rows, text index and vectors, so a crash cannot leave them out of step. SQL helps the port of `executeRaw` sites. FTS5 ranking is not `ts_rank`, but L2/L3 parity does not need equal scores. (b) gives better ranking control but has several commit logs to keep in step. Confirm with the Phase 1 spike numbers. | Phase 1 |
| D7 | Parity reference and search tolerance. | (a) PGLite is the reference (what the evals measure today). (b) Postgres is the reference. (c) The documented contract is the reference; each known difference is decided case by case. Tolerance: exact ranks, set overlap, or metric delta. | (c), with the draft choices in section 8.2. Tolerance as in section 8.1: L2 top-1 and top-5 set on fixtures; L3 not lower than PGLite by more than 1.0 point on Recall@5 and MRR. | Phase 2 (L1), Phase 3 (L2, L3) |
| D8 | Open existing brains in place, or export and import. | (a) Export and import through `gbrain migrate --to rust` (`src/commands/migrate-engine.ts` already copies between engines). (b) Read a PGLite data directory in place. (c) Both. | (a). A PGLite directory is a Postgres data directory; reading it from Rust means a Postgres storage reader. Export and import also skips the 313 Postgres migrations. Keep the source brain until the user deletes it. | Phase 7 |
| D9 | Pin a gbrain release tag as the parity baseline. | (a) Pin `v0.60.733.0` (`6ce7195b44`, also `latest-stable` and the gbrain-evals pin) for the whole plan. (b) Pin a new tag at the start of each phase. (c) Follow `master`. | (b). Start with `v0.60.733.0`. Rebase onto the newest stable tag at the start of each phase. Record the pin in each gate report. (c) moves under the gate during a run. | Phase 1 |
| D10 | The eval-side switch on gbrain-evals `main`, and which paid runs gate a phase. | Switch: (a) land `openEvalEngine`, the importer move and the receipt fields on `main`; (b) keep them on a parity branch. Paid: (a) none; (b) LongMemEval-S hybrid with a warm cache (about $2-$7.56 once, then about $0 per arm); (c) also rerank arms (about $0.35-$0.50 each) and paid BrainBench categories. | Switch: (b) until gate 0.G7 shows equal receipts, then (a) with Garry's approval. Note: moving the 14 static importers changes what those runners measure under `--gbrain` today. Paid: (b) gates Phase 3 and Phase 8. Rerank is report-only. Paid BrainBench categories are not storage gates. Draft cap: $25 per phase. | Phase 0 eval PRs (branch vs `main`), Phase 3, Phase 8 |

Smaller questions from the eval map that can wait until their phase:

- Are `gbrain-cues` (`939232f`) and `gbrain-reader` (`e78f1c3`) runners in
  scope, or excluded until they are pinned to current gbrain? (Phase 7.)
- Should gbrain-evals CI get a Rust lane, and who bumps the gbrain pin?
  The `GBRAIN_UNDER_TEST` overlay runs `bun install --frozen-lockfile` in a
  `git archive` copy, so the addon must build or download a prebuild there.
  (Phase 1.)
- When should the `gbrainCommand` seam and the operation bridge for the
  binary lane be built? (After Phase 8.)

## 10. Benchmarks

### 10.1 Workloads

| Workload | Corpus | Measures |
|---|---|---|
| W1 Open | Empty brain; 10k-page brain; 100k-page brain | Cold open time, first query time, RSS after open. |
| W2 Bulk import | gbrain-evals world-v1 and amara-life-v1; synthetic 10k and 100k pages from a fixed seed | Pages per second, peak RSS, disk size after import. |
| W3 Point reads | Same corpora | `getPage`, `listPages`, `getLinks`, `traversePaths` p50 and p99. |
| W4 Search | Same corpora; LongMemEval-S haystacks | Keyword, vector and hybrid p50 and p99, with stub or cached embeddings. |
| W5 Writes under read load | 100k-page brain | `putPage` p50 and p99 while 4 readers query. |
| W6 Jobs | Synthetic queue | Claims per second with 1, 4 and 16 workers. |
| W7 Many processes | 100k-page brain | CLI, `serve` and `jobs work` at the same time: error rate and latency. PGLite gives `pglite_busy` here; record it. |

Engines: Rust, PGLite and Postgres (local Docker with pgvector, the image the
e2e lane uses). Same machine, same Bun version, three warm runs, median
reported. The harness is PR 0.9; the published report is PR 8.3.

### 10.2 Draft targets (for review, report-only until Phase 8)

| Metric | Draft target vs PGLite |
|---|---|
| Cold open, 100k pages | 5x faster or better |
| Bulk import | 2x faster or better |
| Point reads p50 | Not slower |
| Search p50 and p99 | Not slower |
| Peak RSS | Lower |
| Disk size | Not larger |
| Many processes (W7) | No busy lockout; bounded wait only |

Postgres numbers are context, not targets. Postgres serves a different
deployment (shared and hosted brains).

## 11. Questions for the `/autoplan` review

These are the parts of the plan that the review should test hardest:

1. Is Phase 1 the right place for the spike, or should the spike come
   before Phase 0 ends, so D5 and D6 are answered sooner?
2. Is "refuse and port" (D4) affordable for 1,204 files? The PR 0.6
   inventory gives the real size. If most sites are in doctor and repair,
   the Rust engine can reach users earlier with a list of unsupported
   commands.
3. Is the Phase 2 to Phase 6 order right? Jobs (Phase 5) may need to move
   earlier, because `sync` and autopilot use the queue on every brain.
4. Is the 1.0-point retrieval tolerance (D7) too loose or too tight?
5. Does the plan keep the "fix waves ship as ONE PR" rule from `CLAUDE.md`
   out of scope correctly? This plan is a feature program, not a fix wave,
   so it uses many small PRs. Garry should confirm.

## 12. Links

### Research maps (`docs/research/rust-engine/` in garrytan/gbrain)

- Index: [README.md](../research/rust-engine/README.md)
- Storage engine (origin `research/storage-engine`):
  [storage-engine.md][se-readme], [brain-engine.md][se-engine],
  [postgres-features.md][se-pg], [schema.md][se-schema]
- Jobs and tests (origin `research/jobs-and-tests`):
  [background-jobs.md][jt-jobs], [subsystems.md][jt-sub],
  [test-suites.md][jt-tests]
- Agent contract (origin `research/agent-contract`):
  [agent-contract.md][ac-readme], [agent-and-eval-usage.md][ac-usage],
  [brain-format.md][ac-format], [cli.md][ac-cli], [mcp.md][ac-mcp]
- gbrain-evals (origin `research/gbrain-evals`):
  [gbrain-evals.md][ge-main], [engine-selection.md][ge-engine],
  [brainbench-categories.md][ge-cats],
  [longmemeval-and-memory-benchmarks.md][ge-lme],
  [scripts-tests-ci.md][ge-ci], [imports.md][ge-imports]

### gbrain source (pinned to `8bbfd0b5e8`)

- [`src/core/engine.ts:830` BrainEngine interface][gb-engine-iface]
- [`src/core/engine-construct.ts:12-23` constructEngine][gb-construct]
- [`test/e2e/engine-parity.test.ts:32-33` describeBoth][gb-parity-gate]
- [`test/e2e/engine-parity.test.ts:2716-2723` getRawData arms][gb-parity-arms]
- [`test/helpers/test-backends.ts`][gb-test-backends]
- [`src/core/minions/queue.ts:1463` claim][gb-claim]
- [`src/core/persistence/native-lock.ts:94-140` native addon load][gb-native-lock]
- [`docs/ENGINES.md`][gb-engines-doc]

[se-readme]: ../research/rust-engine/storage-engine.md
[se-engine]: ../research/rust-engine/brain-engine.md
[se-pg]: ../research/rust-engine/postgres-features.md
[se-schema]: ../research/rust-engine/schema.md
[jt-jobs]: ../research/rust-engine/background-jobs.md
[jt-sub]: ../research/rust-engine/subsystems.md
[jt-tests]: ../research/rust-engine/test-suites.md
[ac-readme]: ../research/rust-engine/agent-contract.md
[ac-usage]: ../research/rust-engine/agent-and-eval-usage.md
[ac-format]: ../research/rust-engine/brain-format.md
[ac-cli]: ../research/rust-engine/cli.md
[ac-mcp]: ../research/rust-engine/mcp.md
[ge-main]: ../research/rust-engine/gbrain-evals.md
[ge-engine]: ../research/rust-engine/gbrain-evals/engine-selection.md
[ge-cats]: ../research/rust-engine/gbrain-evals/brainbench-categories.md
[ge-lme]: ../research/rust-engine/gbrain-evals/longmemeval-and-memory-benchmarks.md
[ge-ci]: ../research/rust-engine/gbrain-evals/scripts-tests-ci.md
[ge-imports]: ../research/rust-engine/gbrain-evals/imports.md
[gb-engine-iface]: https://github.com/garrytan/gbrain/blob/8bbfd0b5e83c166889f2dc0406dc981e84bec570/src/core/engine.ts#L830-L833
[gb-construct]: https://github.com/garrytan/gbrain/blob/8bbfd0b5e83c166889f2dc0406dc981e84bec570/src/core/engine-construct.ts#L12-L23
[gb-parity-gate]: https://github.com/garrytan/gbrain/blob/8bbfd0b5e83c166889f2dc0406dc981e84bec570/test/e2e/engine-parity.test.ts#L32-L33
[gb-parity-arms]: https://github.com/garrytan/gbrain/blob/8bbfd0b5e83c166889f2dc0406dc981e84bec570/test/e2e/engine-parity.test.ts#L2716-L2723
[gb-test-backends]: https://github.com/garrytan/gbrain/blob/8bbfd0b5e83c166889f2dc0406dc981e84bec570/test/helpers/test-backends.ts
[gb-claim]: https://github.com/garrytan/gbrain/blob/8bbfd0b5e83c166889f2dc0406dc981e84bec570/src/core/minions/queue.ts#L1463-L1520
[gb-native-lock]: https://github.com/garrytan/gbrain/blob/8bbfd0b5e83c166889f2dc0406dc981e84bec570/src/core/persistence/native-lock.ts#L94-L140
[gb-engines-doc]: https://github.com/garrytan/gbrain/blob/8bbfd0b5e83c166889f2dc0406dc981e84bec570/docs/ENGINES.md
