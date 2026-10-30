# TLA+ specs

TLA+ models of gbrain's concurrency protocols, checked exhaustively at small bounds by TLC, the TLA+ model checker. Each
guard a model relies on is a mutant: removing it from the model must break a named property, and removing it from the
code must fail a named test. The crash robot (`scripts/persistence/`) samples real schedules; these models cover every
interleaving of the modelled actions inside their bounds. The approach follows Parcha's agentrun `spec/receipts`
(Apache-2.0); no code was copied.

## Run it

```sh
bun run test:tla                                   # every config of every spec, then every mutant (model and code)
bash scripts/spec/tlc.sh drain-lease DrainLease.cfg  # one config
bun scripts/spec/mutants.ts --only renewal-ignores-token
bun scripts/spec/mutants.ts --spec-only            # model mutants only (no Bun tests)
```

Needs Java 11 or later (CI uses temurin 21), GNU `timeout` (`brew install coreutils` on macOS) and Bun.
`scripts/spec/tla-jar.sh` downloads tla2tools.jar once into `~/.cache/gbrain/tla` and checks it against the sha256 in
`scripts/spec/tla-tools.env`; set `TLA2TOOLS` to use a jar you already have (it is checked too). The code mutants
that need Postgres run when `DATABASE_URL` points at a test database (with `GBRAIN_TEST_ALLOW_DATABASE_URL=1`);
otherwise they print `skip`, and CI passes `--require-postgres`. Logs and counterexample traces land in
`.context/tlc/` (`TLC_OUT`), and CI uploads them as the `tla-spec-logs` artifact.

`.github/workflows/tla-spec.yml` runs all of it nightly, on dispatch, and on pull requests and master pushes that touch a
spec, its runner, the code a spec models, or a test a mutant names.

### When it fails

Nothing here writes product files or data: TLC runs on copies under `TLC_OUT`, and code mutants run in a scratch
copy of the tree there. A failed or interrupted run leaves only partial logs in `TLC_OUT`.

| Code | Meaning | What to do |
| --- | --- | --- |
| `TLC_VIOLATION` | A property is violated. | Read the trace in the log; the action table below maps each step to code. Fix the code, or fix the spec when it is wrong and say why in the PR. Never rerun to make it pass. |
| `TLC_TIMEOUT` | TLC did not finish within `TLC_TIMEOUT_S` (600 s). | If the spec or a config changed, find the action that multiplies states. Shrinking a config's bounds reduces what is checked: that needs review in the PR. If nothing changed, the runner was slow: rerun once, then report it. |
| `TLC_ERROR` | TLC stopped without a result: a parse or semantic error (the log names the line), out of memory, or killed. | Fix the error the log names; for memory, raise `-Xmx` in `TLC_JAVA_OPTS`. A killed run may be rerun once. |
| `TLA_JAVA_MISSING` | No `java` on `PATH`. | Install Java 11 or later. |
| `TLA_JAR_MISSING` | `TLA2TOOLS` names a file that does not exist. | Point it at the jar, or unset it to download the pinned one. |
| `TLA_JAR_DOWNLOAD_FAILED` | The jar did not download. | A network failure: rerun once. |
| `TLA_JAR_SHA_MISMATCH` | The jar is not the reviewed release. | Never rerun or bypass it; a new pin in `tla-tools.env` needs review. |
| `MUTANT_USAGE` | An unknown flag, or `--spec-only` with `--code-only`. | Fix the command. |
| `MUTANT_STALE` | A mutant's `before` text is not found exactly once. | The spec or code moved: update the mutant's text in `mutants.json` to the new line that implements the same guard. |
| `MUTANT_SURVIVED` | No property caught a model mutant, or the named test passed with the guard removed from the code. | A property or a test stopped pinning the guard. Restore it; never delete the mutant to go green. |
| `MUTANT_WRONG_PROPERTY` | A different property caught it, or a survivor became load-bearing. | Read the trace; update `expect`, and give a new load-bearing guard a code edit and a test. |
| `MUTANT_INCOMPLETE` | TLC did not finish or did not start; a named test failed without the edit or matched no test; or with the edit the test did not end in a clean assertion failure (a signal, a timeout, a load error, an error between tests). | Read the log the message names. Fix the test or filter first; a run that did not fail on the test's own assertion proves nothing. A named test asserts with plain `expect()`: a custom message makes Bun report the failure as an `Error`, not an `AssertionError`. An interrupted run may be rerun once with the printed command. |
| `MUTANT_NOTHING_CHECKED` | Every check the selection asked for was skipped (a Postgres test without `DATABASE_URL`). | Point `DATABASE_URL` at a test database (`GBRAIN_TEST_ALLOW_DATABASE_URL=1`). |

## drain-lease: the managed-sync drain lease

One drainer per source at a time (`src/core/persistence/sync-lease.ts` over `src/core/db-lock.ts`). The lease is one
`gbrain_cycle_locks` row; its `acquisition_token` is the fencing token. Every transaction that admits sync work or
swaps the cursor runs `assertDrainLease`, which reads the row by token `FOR KEY SHARE` (`fenceLockRow`, #7442). The pass
stamp takes the same lock with the token stamped on its request: a folded stamp's proof (`provenStamp`) and the checkpoint request
(`applyPassCheckpoint`), both run by the write coordinator, possibly in another process.

| Config | What it checks |
| --- | --- |
| `DrainLease.cfg` | Two drainers, one fenced transaction at a time, the code's timing at 10 s ticks, fenced transactions up to 60 s (twice the renewal timeout), no renewal priority and the pass stamp's fence on: every property. |
| `DrainLeaseSafety.cfg` | Every adverse assumption on (live holders stolen by a lying pid probe or `--force-break-lock`, fenced transactions longer than the renewal timeout, no renewal priority, a cancelled renewal settling late), 20 s ticks: the safety properties, which must hold anyway. |
| `DrainLeaseStamp.cfg` | The same, plus the pass stamp's fence: a coordinator transaction that holds the row `FOR KEY SHARE` by any issued token, overlaps the holder's and survives its crash. |
| `DrainLeaseLanesNightly.cfg` | The safety config with two overlapping fenced transactions per holder, at a shorter clock bound. About 2 minutes on 4 CPUs, so `tlc.sh` runs it only with `TLC_NIGHTLY=1` (the schedule and dispatch). |

`test/spec-drain-lease-constants.test.ts` keeps every config's timing equal to the code's constants and checks the
ordering the liveness property needs.

### Properties

| Property | Holds that |
| --- | --- |
| `FencedTxnsMatchRow` | every open fenced transaction belongs to the row's current holder, so every commit is made under the live lease |
| `OneDrainer` | at most one process has fenced work open |
| `CursorMonotone` | the sync cursor never moves backward |
| `NoSpuriousLapse` | a holder that never slept (machine asleep, event loop blocked) never loses its lease, under the timing assumptions below |

### Timing assumptions

An awake holder runs its timers on time: the clock does not pass a due renewal, a renewal that can land, a renewal
timeout, its local lease deadline, or a fenced transaction at its bound. On top of that, `NoSpuriousLapse` needs:

- **A cancelled renewal settles within `CancelMs`** (10 s; the database answers the cancel). The clock runs while it is
  pending, and no new renewal starts until it settles.
- **Fenced transactions of one holder do not overlap** (`Lanes = 1` in `DrainLease.cfg`; admissions are serial). Two lanes
  were checked once at `MaxTime = 12` (6,420,020 states, every property); that run is not in CI.

The fence no longer needs a bound on fenced transactions. Before #7442 it took the row `FOR SHARE`, so the renewal's
`UPDATE` waited behind the holder's own fenced transactions and the pass stamp, and TLC found a live holder losing its lease
once a fenced transaction outlived the renewal timeout. `FOR KEY SHARE` conflicts only with writes to the key (the takeover
upsert's `SET id = EXCLUDED.id`) and with `DELETE`, so the renewal lands while the row is fenced; mutant
`fence-takes-share-lock` puts the old lock back and TLC finds the lapse again.

Times are rounded so the model is never kinder than the code: TTL and graces round down, the refresh interval,
renewal timeout and transaction bound round up. A renewal's `now()` is its statement's start, so the row's expiry
counts from the request, not from the moment it got the row.

### Actions and code

| Action | Code |
| --- | --- |
| `Acquire` | `tryAcquireDbLock`'s upsert: insert, or take over a row whose TTL expired and whose last refresh is older than the steal grace; it writes the key (`SET id = EXCLUDED.id`), so it waits for every `FOR KEY SHARE` |
| `DeadPidTakeover` | `tryAcquireDbLock`'s second path (#1780) and `--break-lock`'s safe path: an unexpired row whose same-host pid the probe calls dead, older than `HOLDER_TAKEOVER_GRACE_MS` |
| `StampBegin`, `StampEnd` | the pass stamp's fence in `provenStamp` (sync-pass-fold.ts) and `applyPassCheckpoint` (sync-prepare.ts): token and expiry, `FOR KEY SHARE` (`fenceLockRow`), no signal check, run by the write coordinator |
| `StartRenew`, `RenewLand` | `withRefreshingLock`'s interval and `handle.refresh()`: one renewal in flight, `UPDATE ... WHERE id AND holder_pid AND acquisition_token`, which writes no key, so the fence does not block it; a refused renewal aborts the lease signal |
| `RenewTimeout`, `CancelSettle` | the renewal timeout aborts the query; it settles later and never extends local authority |
| `LocalDeadline` | the expiry timer: the TTL passed with no confirmed renewal (`renewDeadline`) |
| `BeginFenced`, `Commit`, `Rollback` | `assertDrainLease` inside a transaction (signal, token, expiry, `FOR KEY SHARE`); lane 1 swaps the cursor. |
| `Release` | `withRefreshingLock`'s finally: wait for the in-flight renewal, then `DELETE ... WHERE id AND holder_pid AND acquisition_token` |
| `Sleep`, `Wake`, `Crash` | the environment: a sleeping holder keeps its open transaction and share lock; a crash rolls them back |

### Mutants

`mutants.json`. A guard mutant has a code edit (every engine branch) and the tests that must fail under it.

| Mutant | Kind | Caught by | Code and test |
| --- | --- | --- | --- |
| `fence-ignores-token` | guard | `FencedTxnsMatchRow` | `assertDrainLease`'s `fenceLockRow` call; `test/persistence-sync-lease.test.ts` |
| `fold-stamp-ignores-token` | guard | `FencedTxnsMatchRow` (`DrainLeaseStamp.cfg`) | `provenStamp`'s `fenceLockRow` call (sync-pass-fold.ts); `test/drain-lease-stamp-fence.test.ts` and its Postgres twin |
| `checkpoint-stamp-ignores-token` | guard | `FencedTxnsMatchRow` (`DrainLeaseStamp.cfg`) | `applyPassCheckpoint`'s `fenceLockRow` call (sync-prepare.ts); the same |
| `fold-stamp-without-share-lock` | guard | `FencedTxnsMatchRow` (`DrainLeaseStamp.cfg`) | `provenStamp`; the Postgres twin (a takeover from another connection waits until the import commits) |
| `checkpoint-stamp-without-share-lock` | guard | `FencedTxnsMatchRow` (`DrainLeaseStamp.cfg`) | `applyPassCheckpoint`; the same |
| `fence-without-share-lock` | guard | `FencedTxnsMatchRow` | `assertDrainLease`; `test/e2e/drain-lease-fence-postgres.test.ts` |
| `fence-takes-share-lock` | guard | `NoSpuriousLapse` | `fenceLockRow` takes `FOR SHARE` again (#7442); `test/e2e/drain-lease-key-share-7442-postgres.test.ts` (a renewal commits while a fenced transaction is open) |
| `takeover-skips-key-write` | guard | `FencedTxnsMatchRow` | both upserts in `tryAcquireDbLock` drop `SET id = EXCLUDED.id`; `test/drain-lease-key-share-7442.test.ts` (the token census) and its Postgres twin (a takeover waits for the fence) |
| `takeover-ignores-ttl` | guard | `NoSpuriousLapse` | the upsert's `ON CONFLICT ... WHERE`; `test/drain-lease-guards.test.ts` and its Postgres twin |
| `release-ignores-token` | guard | `NoSpuriousLapse` | `handle.release()`; the same |
| `renewal-ignores-token` | guard | `NoSpuriousLapse` | `handle.refresh()`: a former holder's late renewal, its `now()` taken when it was sent, would rewind its successor's expiry; the same |
| `pid-probe-calls-live-holder-dead` | guard | `NoSpuriousLapse` | `classifyHolderLiveness` (EPERM is alive); `test/db-lock-auto-takeover.test.ts` |
| `fence-ignores-signal` | survivor | — | defense in depth: an abort is also visible to the token or expiry check |
| `fence-ignores-expiry` | survivor | — | defense in depth: `FOR KEY SHARE` blocks a takeover while the transaction is open and the token refuses after it; `test/persistence-sync-lease.test.ts` still pins the refusal |

### Not modelled

Postgres only: PGLite is one connection and serializes everything. Also left out, each covered elsewhere: the
`LEASE_BEACON_QUEUE` holder record older binaries see (`test/persistence-sync-lease.test.ts`,
`test/minions-lease-beacon-sweeps-7261.test.ts`); a follower's wait and `drain_stalled` (`test/persistence-sync-lease.test.ts`);
reentrant passes under one lease; older binaries that take no lock; side effects outside the database; how the
local monotonic clock behaves across a machine suspend; and table
locks on `gbrain_cycle_locks` (writer activation, admin intents, skill activation), which hold every renewal for the
length of their transaction, so they count against the renewal timeout like a long fenced transaction.

### Known gaps

None in the lease protocol at these bounds. The two gaps this model first found (#7442: fenced transactions not bounded
under the renewal timeout, and the pass stamp's share lock overlapping the holder's) are closed by the `FOR KEY SHARE`
fence and the key-writing takeover upsert (#7450); `DrainLease.cfg` now checks `NoSpuriousLapse` with both conditions on.
