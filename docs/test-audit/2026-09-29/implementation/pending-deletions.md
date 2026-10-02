# Slice evidence: pending deletions + process-cleanup double-signal fix

Branch: `test-reduction-wave` (uncommitted). Bun 1.3.14. Mutations applied one at a time with an exact-string replace and reverted with `git checkout -- <file>`; counts are executed-test counts (`N pass / M fail`). E2E runs used a local `pgvector/pgvector:pg16` container (`GBRAIN_TEST_ALLOW_DATABASE_URL=1`).

## 1. `gbrain features` typeof probes (vacuous assertion)

| Deleted test | Probe edit | Result | Surviving owner | Owner result |
|---|---|---|---|---|
| `test/features.test.ts` › "exports runFeatures" | `src/commands/features.ts`: `runFeatures` throws on entry | deleted test passes (blind; HEAD file 12 pass / 6 fail, the 3 probes all pass) | `test/features.test.ts` › "runFeatures behavior" (6 cases) | fails (10 pass / 6 fail) |
| `test/features.test.ts` › "covers all 7 recipes" (asserts only `runFeatures` is defined) | same | passes (blind) | `runFeatures behavior` › "the no-integrations pitch names exactly the recipes…" (every `RECIPE_META` name checked) | fails |
| `test/features.test.ts` › "exports featuresTeaserForDoctor" | `featuresTeaserForDoctor` returns `null` | passes (blind; HEAD file 18 pass / 0 fail) | NEW `test/features.test.ts` › "the doctor teaser names missing embeddings and stays silent on a healthy brain" | fails (15 pass / 1 fail) |

The teaser had no behavioral owner before; the new case (real PGLite, one missing embedding) replaces the typeof probe. `features-recipe-secrets.test.ts` stays 7 / 0 under the throw (it owns secret names, not the command). Export existence is enforced by `bun run typecheck` (doctor.ts destructures the dynamic import).

## 2. `test/embed-helper-migration.test.ts` (8 source-grep pins, deleted)

New file `test/embed-pool-abort.test.ts`: real `runEmbedCore` → gateway path, one worker (`GBRAIN_EMBED_CONCURRENCY=1` via `withEnv`), an embed transport that aborts the caller's `AbortController` on its first call; asserts exactly one embed call and that only the first page's snapshot was read, on `--stale` and `--all`.

| Pin / property | Probe edit (`src/commands/embed.ts` unless noted) | Deleted pin | New / surviving owner | Owner result |
|---|---|---|---|---|
| stale pool gets `signal: effectiveSignal` | remove `signal: effectiveSignal` from the `embedAllStale` pool | fails (7/1) | `embed-pool-abort` › "--stale: no page after the aborting one…" | fails (1/1) |
| caller signal composed into the stale pool | `anySignal(budgetSignal, externalSignal)` → `anySignal(budgetSignal, undefined)` | passes (blind, 8/0) | same | fails (1/1) |
| `embedAll` pool's caller signal (`...(signal && { signal })`) | remove it | passes (blind, 8/0) | `embed-pool-abort` › "--all: …" | passes (2/0): **equivalent mutation**. `embedOnePage` returns on `isAborted(signal)` at entry, right after each claim, so the pool signal is redundant defense in depth |
| (same contract, both layers) | remove the pool signal AND the `embedOnePage` entry guard | passes (blind) | `embed-pool-abort` › "--all: …" | fails (1/1) |
| (entry guard alone) | remove only `if (isAborted(signal)) return;` | passes | `embed-pool-abort` | passes (pool signal still stops claims) |
| `failureLabel: (page) => page.slug` slug projector | remove it from the `embedAll` pool | fails (7/1) | none possible at the embed boundary; see disposition | `embed-pool-abort` 2/0, `embed-default-concurrency` 2/0, `embed.serial` 52/0 |
| failures[] memory bound | `src/core/worker-pool.ts`: store the item instead of `labelFn(item)` | n/a | `test/worker-pool.test.ts` › "failures store idx + label, NOT full item" | fails (23/1) |
| default 20 on both paths | (evidence-16) `'20'` → `'19'` | fails | `test/embed-default-concurrency.test.ts` | fails (1/1 each) |
| `workers: CONCURRENCY` on both pools | stale pool `workers: 5` / all pool `workers: 5` | fails | `embed-default-concurrency` | fails (1/1) / fails (1/1) |
| imports `runSlidingPool`, ≥2 call sites, old inline-pool shapes gone | structural | vacuous | pool wiring is exercised by the peak-20 barrier tests above; import existence by typecheck | — |

`failureLabel` disposition (vacuous at this boundary): both embed call sites discard the `runSlidingPool` result, so `failures[]`, the only consumer of the label, never leaves the pool; without the projector the default `String(page)` label is also a short string, so no Page object is retained either way. The memory bound is a worker-pool property owned by `worker-pool.test.ts`. **Finding (not fixed, out of scope):** in `--all`, an error thrown by the page snapshot read (outside `embedOnePage`'s try) is swallowed by the pool and dropped: a probe with a throwing `readPageSnapshot` returned `{embedded: 0, failures: 0, pages_processed: 0}`, so the run exits 0 with pages unembedded (#3037 class). Recording pool failures into `result.failures` would fix it and make the slug projector observable.

## 3. `test/postgres-engine-singleton-ownership.test.ts` (7 source pins, deleted)

New file `test/postgres-engine-singleton-lifecycle.test.ts`: no mocks, no Postgres. Each test opens its own local TCP endpoint that accepts connections and never answers the Postgres handshake (a pending `SELECT 1` holds a connect in flight), then answers with a FATAL `ErrorResponse` to release them.

| Property | Probe edit | Deleted pin | New unit test | E2E owners (idempotency / shared-recovery / reconnect-singleton) |
|---|---|---|---|---|
| P1 borrower `db.connect` returns false | `src/core/db.ts`: join path returns `true` | fails | "an engine that joins an in-flight create is a borrower…" fails (2/1) | 3/2, 2/1, 3/0: **caught** |
| P2 TOCTOU: engine pre-samples the singleton with an await before `db.connect` | `postgres-engine.ts`: `existed = getConnection()` probe; `await Promise.resolve()`; `await db.connect`; `owns = !existed` | fails | borrower test fails (2/1) | 5/0, 3/0, 3/0: **missed** |
| P2 TOCTOU: `db.connect` awaits between its null check and the create | `db.ts`: `await Promise.resolve()` after the `if (sql)` block | passes (blind, 7/0) | borrower test fails; disconnect test fails (its setup relies on the synchronous create) | not run |
| P2 pre-sample with no await (evidence-18 shape) | same probe without the `await Promise.resolve()` | fails (textual) | passes (3/0): **equivalent mutation**. The sample and `db.connect`'s own check run in one synchronous stretch, so no interleaving can separate them | missed (evidence-18) |
| P3 disconnect only when owner | unconditional `db.disconnect()` | fails | borrower test fails (2/1) | 3/2, 2/1, 3/0: **caught** |
| P4 snapshot + null before awaiting `end()` | `db.ts`: `await endPoolBounded(s)` before `sql = null` | fails | "db.disconnect() detaches the singleton before awaiting end()…" fails (1 fail) | 5/0, 3/0, 3/0: **missed** |
| P5 module reconnect never tears down the shared pool | `db.disconnect()` before `db.connect` in the module branch | passes (blind, 7/0) | passes (not targeted) | 5/0, 3/0, 2/1: **caught** by reconnect-singleton |
| P6 `_reconnecting` set | remove `this._reconnecting = true` | fails | "a reconnect during a running rebuild returns at once…" fails | 5/0, 3/0, 3/0: **missed** |
| P6 `_reconnecting` cleared in `finally` | remove `this._reconnecting = false` | passes (blind, 7/0) | same test fails (next reconnect never rebuilds) | 5/0, 3/0, 3/0: **missed** |

Cadence exception (record in PR body): the deleted pin ran on every unit shard. P2/P4/P6 now have unit owners (every unit shard, same cadence). P1/P3/P5 are owned by the three E2E files, which run when `src/core/postgres-engine.ts` changes (map entry added in PR 1 item 7); `src/core/db.ts` is unmapped, so a `db.ts` change selects the whole E2E suite. The new unit borrower test also catches P1 and P3, so only P5 relies on E2E cadence alone.

Test-only access: the P6 test sets the engine's private `_savedConfig` / `_connectionStyle` / `_sql` directly because an instance connect needs a completed handshake.

## 4. `src/core/process-cleanup.ts`: a second signal exited before the lock DELETE

Fix: `runCleanupPass` keeps the in-flight pass promise (`cleanupPass ??= runCleanupCallbacks()`); every signal handler and `triggerCleanupAndExit` awaits that same promise before `process.exit`. Callbacks still run once; the 3 s deadline still bounds the pass.

| Test | Pre-fix code | Fixed code |
|---|---|---|
| NEW `test/process-cleanup.test.ts` › "later signals and a stdout EPIPE during the cleanup pass wait for it before exiting" (held cleanup callback; SIGTERM, SIGPIPE, stdout `EPIPE`; expects exits `[143, 141, 0]` all after the callback finished) | fails (14/1: SIGPIPE exits before cleanup finished) | passes (15/0) |
| NEW `test/e2e/sync-lock-recovery.test.ts` › "closing the output pipe as soon as the lock row appears still releases the lock" | fails 3 of 3 | passes 20 of 20 consecutive local runs; whole file 9/0 |
| scratch repro (`(scratch) scratch/repro-lock-boundary.ts`: 1,000-file repo, close stdout+stderr the moment `gbrain-sync:default` carries the child PID) | lock row left 6 of 6 (exit 141, 0 imported) | lock row left 0 of 6, then 0 of 20 |

The 20-run check was on this Capy machine without a unit shard alongside, not the plan's Ubicloud bar.

EPIPE listeners: **kept (reachable)**. Measured with a Bun writer that installs a SIGPIPE listener and a stdout `error` listener, read by `| head -c 10`, a Bun parent (`Bun.spawn` pipe, reader cancelled) and a Node parent (`child_process` pipe destroyed):

| Writer | SIGPIPE listener | Events observed (all three readers) |
|---|---|---|
| `process.stdout.write` | yes | ~4,400-4,600 SIGPIPE **and** 22-24 stdout `EPIPE` error events; exit code decided by whichever handler ran first (0 or 141) |
| `process.stdout.write` | no | 39 stdout `EPIPE` events |
| `console.log` | yes | SIGPIPE only |
| `console.log` | no | nothing (writes fail silently) |

So PR 1's note ("the EPIPE listeners are not reached") holds only for `console.log` output; `process.stdout.write` output reaches them. Removing them would be unsafe. The TODOS.md P2 entry is closed with this evidence, and the misleading SIGPIPE comment in `process-cleanup.ts` was corrected.

## Ratchets and bookkeeping

- `test/test-reads-source-smell.test.ts`: removed the entries for the two deleted files, plus a **pre-existing stale entry** `distribution-import-boundary.test.ts: 1` (the file has 0 unjustified reads since slice 19; the ratchet failed at HEAD before this slice).
- Weights: removed the deleted files from `scripts/test-weights.json` and `scripts/ubicloud/weights.json` (they were not in `serial-weights.json` or `e2e-weights.json`). Grep of `scripts/`, `.github/`, `scripts/e2e-test-map.ts`, `test/fixtures/e2e-unmapped-baseline.txt`: no other references.
- `scripts/structural-suites.tsv` regenerated (`bun scripts/classify-tests.ts`): one row removed.
- Docs: `docs/architecture/key-files/commands-2.md` and `engines-2.md` repointed from the deleted pins to the new owners.
