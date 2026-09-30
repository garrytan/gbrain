INPUT: ceo b660cbb92232f81e85e10c8176e0e9c0d019c904aa51a2ee948da7b92a75289e

# CEO review: behavior-preserving structural refactor (W1-W5)

Read: native-prompt.md lines 1-129, complete. Claims spot-checked against /workspace/gbrain at 608a174dc (v0.60.10.0).

**Verdict:** It's the right problem. The engine duplication and the god functions are real, and my checks confirm the plan's numbers: engines are 6,184 and 5,590 lines, `CREATE TABLE` counts are 75 vs 47, and there are 32 peeled doctor checks. But the plan has two problems. First, it undercounts how exposed it is to master moving underneath it. Second, it overstates what W1 and W2 can preserve, because both reach below the SQL text. W5 and W3 are cheap and high-value, W1 is the prize but also the risk, and W2 as written is a schema change dressed up as a refactor.

This review respects the standing preference to ship fix waves as one PR. None of the fixes below recommend splitting into several PRs. They cover ordering, gates and scope cuts inside the one PR.

## Verified facts that change the plan

- There are **243 open PRs**, and **52 of them touch W1-W4 target files**. The plan says "about 20".
- Master moves fast. In the last 30 days there were 56 commits, 26 of them to the engine files and 16 to `migrate.ts`.
- The Postgres engine uses **180 tagged-template `sql\`...\`` calls**, 70 `unsafe()` calls and 12 `sql.array/json` helpers, plus `resolvePrepare` for PgBouncer. PGLite uses `db.query($n)`, 115 calls.
- `MIGRATIONS` contains 29 `handler:` functions, 24 `sqlFor:` engine-specific branches, 11 `transaction:` flags and 83 `idempotent:` flags, alongside 155 `sql:` fields.
- The `pglite-schema.ts` drift warning points at `schema-embedded.ts` and `test/edge-bundle.test.ts`, not at `schema.sql` directly.

## Findings

### 1. The rebase and conflict blast radius is underestimated by more than 2x (CRITICAL)
**What's wrong:** 52 open PRs touch the target files, and master changes the engines about once a day. Move-only commits make *this* PR's rebase mechanical. They do nothing for the 52 other authors: git does not follow code that moved between files, so every open engine, sync or doctor PR turns into a manual port. The six-month regret looks like this: the collector sits in review for weeks, gets re-rebased repeatedly, the community PR waves stall or quietly reintroduce the old patterns, and the refactor lands half-stale.
**Fix:**
- Plan a declared landing window: triage or merge the high-value open PRs that touch targets first, then freeze the target paths for the review-to-merge window.
- Ship a short porting guide with the PR (old location → new location per domain and per extracted phase) so open-PR authors can re-apply their diffs.
- Rebase right before **merge**, not only before review, and re-run the golden snapshots after that final rebase.
- Correct the "about 20" number to 52 in the plan.

### 2. W1's "semantically identical SQL" is not the same as identical behavior (CRITICAL)
**What's wrong:** Moving Postgres methods from tagged templates onto a generic `executeRaw(sql, params)` changes how postgres.js does parameter type inference, array and JSON serialization, and prepared statements (PgBouncer transaction mode relies on `resolvePrepare`). It also changes bigint and Date round-tripping. The existing parity tests catch engine-vs-engine drift. They don't catch Postgres-before vs Postgres-after drift. On top of that, a row-normalization helper applied to every row sits on hot paths, and HEAD just shipped a 3.7x PGLite write-speed win that this layer could erode without anyone noticing.
**Fix:**
- Specify the `SqlExecutor` param-encoding contract explicitly: arrays, jsonb, vector, bigint, Date and null.
- Migrate one domain per commit. For each migrated method, add a before/after round-trip test on Postgres direct, on PgBouncer and on PGLite.
- Add a perf gate: benchmark put/get/search before and after on both engines, with a regression threshold.

### 3. Success criterion (a), "structurally impossible", isn't delivered by one-line delegations (HIGH)
**What's wrong:** If each engine keeps a one-line delegation per method, a new storage feature still edits the `BrainEngine` interface plus both engine files. The two-file tax shrinks but doesn't go away, so the headline metric ("165 commits edited both") can keep climbing.
**Fix (the 10x reframe):** Put the shared methods in one shared base, either an abstract class or a mixin over `SqlExecutor`. Engines then override only the dialect and runtime primitives, and a new domain method touches exactly one file. Measure the result with a CI check: a new shared-SQL method must not appear in either engine file.

### 4. W2 contradicts "no schema changes" (HIGH)
**What's wrong:** Making fresh-install PGLite produce the same table set as fresh-install Postgres is a real schema change for PGLite users. It changes bootstrap and migration interplay, and any migration that isn't truly idempotent against pre-created tables becomes an upgrade hazard for existing brains. The generator also lands on the wrong seam. The drift chain today runs through `schema-embedded.ts` and the edge bundle, and the 24 `sqlFor` branches show that the engines legitimately differ.
**Fix:**
- Split W2 into two steps inside the PR. **W2a:** generation whose output is semantically equal to the current `pglite-schema.ts`, plus the freshness guard. **W2b:** table-set reconciliation, labeled explicitly as a schema change with its own upgrade test (an existing PGLite brain at the current version upgrades cleanly).
- If W2b can't clear that gate, cut it to wave 2.
- Evaluate the alternative the plan skipped: run the migrations on an empty database and snapshot the result, making migrations the single source of truth, instead of text-transforming `schema.sql`.

### 5. W3's golden "SQL hash" misses most of the risky surface (HIGH)
**What's wrong:** Hashing SQL text ignores 29 `handler` functions, 24 `sqlFor` engine branches, and the `transaction` and `idempotent` flags. Those are where a move can silently change migration behavior.
**Fix:** Make the golden cover the full normalized migration record: version, name, `sql`, `sqlFor` per engine, flags, and a `handler.toString()` hash. Also run apply-from-v0 and apply-from-current-master on both engines and compare the final schema dumps.

### 6. The premise measures a proxy (MEDIUM)
**What's wrong:** "165 commits edited both engines" measures co-change cost, not bugs. Co-editing is expected whenever a feature crosses engines. The plan never counts parity *bugs* or the churn cost of god functions, so it can't show afterwards that the refactor paid off.
**Fix:** Before starting, pull a baseline from git: fix commits touching parity or engine drift, and sync hang or partial fixes, over the last 6 months. Re-measure at +3 months. That turns a "vibes-free" problem statement into an outcome you can check.

### 7. W1 feasibility isn't inventoried (MEDIUM)
**What's wrong:** Only 913 token-identical lines exist across the 159 shared methods. The plan doesn't say how many methods are actually movable, so the target of "each engine under 2,500 lines" is a guess and could force risky rewrites to hit a number.
**Fix:** Produce a per-method inventory first: identical, identical after normalization, or dialect-specific. Set the line target from that inventory, and treat the 2,500 figure as an outcome rather than a mandate.

### 8. Doctor golden coverage is too narrow (MEDIUM)
**What's wrong:** One seeded PGLite `doctor --json` snapshot only covers the checks that fire on that brain. Postgres-only and config-conditional checks, which make up much of the 235 `checks.push` calls, go unexercised.
**Fix:**
- Snapshot the ordered registry of check names and categories, independent of which checks fire.
- Add a `doctor --json` golden on both engines, plus one run with a degraded config.

### 9. The cheapest leverage is buried last (MEDIUM)
**What's wrong:** W5, the function-size ratchet, is the only piece that prevents regrowth. It is low-risk, conflict-free and independent of the others, but it's listed last and depends on nothing. If the PR stalls, the gap that let the god functions grow is still open.
**Fix:** Make W5 plus the W3 registry the first commits in the collector, and define a cut line for the rest: W1 domains beyond the first few, and the W4 autopilot and jobs items, drop to wave 2 if the landing window slips. Scope shrinks, the PR count stays at one.

### 10. The competitive risk is opportunity cost, not rivals (MEDIUM)
**What's wrong:** No competitor will "solve GBrain's internal structure first". The real risk is a multi-week slowdown in feature and fix work, and in community PR throughput, while other agent-memory products keep shipping user-visible capability. Nothing in this plan changes retrieval quality or UX by design.
**Fix:** Time-box the effort, publish the landing window, and keep the retrieval and research track moving in parallel on non-target files. The measured-benefit priority argues against letting a structural refactor starve evaluation work.

## Alternatives dismissed without enough analysis
- **A shared abstract base over `SqlExecutor`** instead of delegation stubs (Finding 3).
- **Migrations-as-source-of-truth** schema snapshotting instead of a `schema.sql` text transform (Finding 4).
- **Codemod or porting-guide support for open PRs** instead of assuming move-only commits keep everyone's rebases mechanical (Finding 1).
- **`gateway.ts` deferral** is well justified. **Flat `src/core/` regrouping** is correctly excluded.

## Bottom line
Proceed with one PR, but only with the landing window, the driver-level and perf parity gates for W1, full-record migration goldens, and W2 reconciliation either gated as an explicit schema change or cut. If W1's per-method inventory shows fewer than about half the shared methods are movable, rescope W1 to the shared-base reframe for the domain files only.
