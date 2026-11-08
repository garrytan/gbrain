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
bun scripts/spec/mutants.ts refresh-barrier          # one spec's mutants (the default is drain-lease)
bun scripts/spec/mutants.ts --spec-only            # model mutants only (no Bun tests)
```

Needs Java 11 or later (CI uses temurin 21), GNU `timeout` (`brew install coreutils` on macOS) and Bun.
`scripts/spec/tla-jar.sh` downloads tla2tools.jar once into `~/.cache/gbrain/tla` and checks it against the sha256 in
`scripts/spec/tla-tools.env`; set `TLA2TOOLS` to use a jar you already have (it is checked too). The code mutants
that need Postgres run when `DATABASE_URL` points at a test database (with `GBRAIN_TEST_ALLOW_DATABASE_URL=1`);
otherwise they print `skip`, and CI passes `--require-postgres`. Logs and counterexample traces land in
`.context/tlc/` (`TLC_OUT`), and CI uploads them as the `tla-spec-logs-<spec>` artifact (`tla-spec-logs-refresh-barrier`, for example).

`.github/workflows/tla-spec.yml` runs all of it, one job per spec, nightly, on dispatch, and on pull requests and master pushes that touch a
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

## refresh-barrier: the refresh write barrier and its deferred-write queue

With `persistence.refresh_barrier` on, a page write admitted while a managed refresh runs is journaled `deferred`
behind that refresh and published by itself once the refresh is released (docs/designs/REFRESH_WRITE_BARRIER.md). The
model holds one managed worktree with one page P whose canonical file is F, single-page writes to P (one blind
put_page, one with expected_revision), one refresh at a time, another agent's plain-git commit to F, managed sync, the
owner's expiry, the refreshing process killed at any step and recovered by `recoverOne`, and Postgres's four row-lock modes per transaction (`KS`, `S`, `NKU`, `U`) over the brain row,
the worktree, the source row, the counters, each refresh row and each request row. A transaction holds its locks until
it commits; a waits-for cycle among them is a deadlock (Postgres aborts one side with 40P01), so `NoDeadlock` is an
invariant. Behind constants it also models the stacked follow-ups: writes held for an import and deferral behind
`recovery_required` (#8705), and local-edit adoption (#8708).

| Config | What it checks |
| --- | --- |
| `RefreshBarrier.cfg` | #8682, with the fix for the fenced-orphan finding below modelled: two writes (one blind), one refresh, one foreign commit: every safety property. |
| `RefreshBarrierEnv.cfg` | The same with a shared-skill restore and a credential revocation that may each run once, no foreign commit. |
| `RefreshBarrierLiveness.cfg` | `FairSpec`, one write: every deferred write leaves deferral and every admitted write ends. `RefreshBarrierLivenessNightly.cfg` checks two writes (nightly). |
| `RefreshBarrierAdopt.cfg` | #8708 on #8705 with its fixes: an uncommitted local edit adopted by a drift refusal, no foreign commit. `RefreshBarrierAdoptNightly.cfg` adds the foreign commit (nightly). |
| `RefreshBarrierImport.cfg` | #8705 with its fixes (03b89121): writes held for an import, a later write held beside them, the import expiry, deferral behind `recovery_required`: every property. |
| `RefreshBarrierAbortLiveness.cfg` | `FairSpec` without outside help (`OutsideHelp = FALSE`): no scheduled sync runs and time never forces the wait limit, and the foreign commit lands while a refresh drains, so the refresh aborts and a write deferred behind it is held for that import. Every deferred write still leaves deferral and every write ends, through the sync a refresh run owes after an aborted refresh (GST-1853). |

Every config kills the refreshing process once (`MaxCrashes = 1`), at any step, after which `recoverOne` resumes the
refresh row it left. A refresh that finds HEAD moved at the merge aborts and the tick retries, as `fenceAndMerge` does,
so `recovery_required` is reached only through recovery; a refused merge aborts too (GST-1674). `RefreshBarrier.cfg` also lets
someone reset the checkout to old_head after the merge (`MayReset`).

`test/spec-refresh-barrier.test.ts` keeps the default config on #8682 alone, every safety config on every invariant,
every config killing the refresh at least once, and the workflow's path filter covering every file a mutant names.

### Properties

| Property | Holds that |
| --- | --- |
| `NoDeadlock` | no waits-for cycle among open transactions' row locks |
| `AppliedAtMostOnce`, `ReceiptMatchesApply` | no write is applied twice, and a receipt says committed exactly when it was applied |
| `EveryEndNamed` | every write that ends has a named outcome (nothing is dropped silently) |
| `ImportedRevisionNeverHidden` | a write never replaces a committed version of F the page never had, so a blind put_page after an import never hides the imported revision from page history |
| `FenceNeverMidPrepare` | the fence never comes up, and the checkout never moves, while a write is claimed |
| `DeferredWaitsForRelease`, `RefreshChangeNeverOverwritten` | a deferred write commits only after its refresh is released, and never over a file that refresh changed |
| `NoDeferToReleased`, `ReleasedWhenEnded` | admission never defers to a released refresh; a completed or aborted refresh is released |
| `RecoveryOnlyByPolicy` | a refresh goes `recovery_required` (a person must act while every write deferred to it waits) only in the policy case recorded in `rwhy`: its merge ran and HEAD no longer holds the target (`merge_started_off_target`: a reset plus an unrelated commit); never for a merge that never started or that git refused, nor with HEAD at or past the target |
| `ExpiryOnlyWhileWaiting` | an expiry ends only a write that still waits (its refresh unreleased, or its import not landed) |
| `RestoreLeavesNoOpenWrite` | a restore leaves no write admitted before it open (finding C) |
| `NoApplyAfterRevoke` | no write commits after its credential was revoked |
| `CommitsInAdmissionOrder` | writes to one page commit in admission order |
| `DeferredLeaves`, `EveryWriteEnds` | liveness under `Fairness`: a deferred write leaves deferral; an admitted write ends |

### Actions and code

| Action | Code |
| --- | --- |
| `AdmBegin`, `AdmRef`, `AdmRead`, `AdmCommit` | `admitWrite` (journal.ts): the protocol declaration, the worktree `FOR SHARE`, the active refresh row `FOR NO KEY UPDATE`, the source, `lockCounters`, the INSERT (queued, or deferred with `deferred_refresh_id`) |
| `ConsBegin`, `ConsSelect`, `ConsClaim` | `claimNextWrite`: `claimableWriteSql` (EARLIER_HEAD, EARLIER_DEFERRED, RELEASED_DEFERRED, `refreshFenceClear`) then the v292 guard trigger |
| `ConsPrep` | preparation: `compareFileTarget` (page-prepare.ts) and `deferredReplayRefusal` (refresh-barrier.ts) |
| `ConsPub` | `publishMutation` / `publishGroup`: `authorizeStoredRequest`, the request row, the revision and file rechecks |
| `ConsHold` | #8705 `holdForImport` |
| `ConsAdopt`, `ConsRelease` | #8708 `adoptLocalEdit`, then the claim's release |
| `ConsDone` | `completeWrite` of a refusal |
| `RefBegin` … `CompleteCommit` | worktree-refresh.ts: `fenceDraining`, the drain poll, `fenceAndMerge` (re-counts under `lockTopologyRows`), the ff-only merge under the commit lock, `bookkeeping`, `syncMembers`, `resumeOrAbandon`, and the v292 release trigger on completed or aborted |
| `Crash`, `RecoverBegin`, `RecoverCommit` | the refreshing process killed (its open transaction rolls back), then `recoverOne` from the owner's topology scan or `--resume`: draining aborts; fenced with HEAD at old_head aborts, and so does a fenced row whose merge never started (`outcome.merge_started` false: `rmstart`), whoever moved HEAD, and one whose merge started but never reached the target (`rmstart` with `rtgt` 0; the code reads the reflogs of HEAD and its branch since `outcome.merge_started_at`, and keeps `recovery_required` when it cannot); fenced with HEAD holding the target (the target or a strict descendant) runs `bookkeeping`; syncing with HEAD at or past the target stays syncing; a `recovery_required` row whose HEAD holds the target runs `bookkeeping`, and otherwise stays; anything else is `markRecoveryRequired` |
| `ExpRefBegin`, `ExpRefCommit` | `expireDeferredWrites`: the protocol, the refresh row re-read `released_at IS NULL FOR NO KEY UPDATE`, `completeWrite` |
| `ExpImpBegin`, `ExpImpRecheck`, `ExpImpCommit` | #8705's import expiry in `expireDeferredWrites` |
| `SyncBegin` … `SyncStamp` | a managed sync pass, whose rows go through the claim like writes: no write passes the queued row importing its page or a running sync row, and a sync row waits behind earlier writes and is never claimed while a write runs; the page row, then its checkpoint row's `UPDATE sources SET last_commit` (sync-prepare.ts) |
| `OwedSyncBegin` | GST-1853 `syncAfterUnfinishedRefresh` (worktree-refresh.ts): while the worktree's newest refresh is aborted and a member's `last_commit` is not HEAD, a refresh run ends by running that member's managed `--no-pull` sync |
| `Foreign`, `LocalEdit`, `Age`, `Revoke`, `Restore` | the environment: another agent's plain-git commit, an uncommitted edit, the wait limit passing, a revoked token, `quarantineSharedSkillRestore` (PGLite-only, one transaction, no worker) |

### Mutants

`mutants.json`. Each guard mutant has a code edit (every engine branch) and the tests that must fail under it.

| Mutant | Kind | Caught by | Code and test |
| --- | --- | --- | --- |
| `expiry-locks-refresh-first` | guard | `NoDeadlock` | finding D reverted: the expiry locks the refresh row before the brain row; the Postgres test where an expiry overlaps a fence |
| `restore-keeps-deferred` | guard | `RestoreLeavesNoOpenWrite` (Env) | finding C reverted in restore.ts; the restore test (PGLite) |
| `replay-ignores-refresh-change` | guard | `RefreshChangeNeverOverwritten` | `deferredReplayRefusal`'s diff check; the deferred blind write over a refreshed page |
| `release-only-on-completed` | guard | `ReleasedWhenEnded` | the v292 release trigger (both engines); the write deferred behind an aborted refresh |
| `expiry-skips-release-recheck` | guard | `ExpiryOnlyWhileWaiting` | the expiry's `released_at IS NULL` under the lock; a Postgres race with a refresh ending |
| `admission-skips-refresh-lock` | guard | `NoDeferToReleased` | admission's `FOR NO KEY UPDATE` on the refresh row; a Postgres race with a refresh ending |
| `publication-skips-reauth` | guard | `NoApplyAfterRevoke` (Env) | `authorizeStoredRequest` in publishMutation and publishGroup; a token revoked after the claim |
| `preparation-ignores-drift` | guard | `ImportedRevisionNeverHidden` | `compareFileTarget`; the #7436 pending-import test |
| `drain-ignores-running` | guard | `FenceNeverMidPrepare` | `drainCounts`; test 13e in persistence-worktree-refresh.test.ts |
| `trigger-allows-unreleased` | survivor | — | the model's only consumer claims through the predicate; the trigger stops an older binary's claim, and the code test still pins it |
| `fence-skips-recount` | survivor | — | every admission after the refresh row exists is deferred, so nothing queues between the drain poll and the fence |
| `claim-ignores-fence` | survivor | — | under the fence nothing is claimable at these bounds |
| `claim-skips-protocol` | survivor | — | the drain count and the request-row lock already order a claim against the fence |
| `replay-skips-reauth` | survivor | — | publication re-authorizes every write |
| `hold-beside-held-off` | guard | `CommitsInAdmissionOrder` (Import) | compareFileTarget's held-first read; the later write that must not pass a held one (import-write-barrier.test.ts) |
| `import-expiry-locks-source-first` | guard | `NoDeadlock` (Import) | the import expiry's lock order; a Postgres expiry overlapping a fence (import-write-barrier.test.ts) |
| `import-expiry-skips-source-lock` | guard | `ExpiryOnlyWhileWaiting` (Import) | the import expiry's `FOR SHARE OF s`; a Postgres import landing while the expiry waits (import-write-barrier.test.ts) |
| `resume-marks-unmerged-recovery` | guard | `RecoveryOnlyByPolicy` | `movedBeforeMerge` (the finding below): the code edit aborts only a HEAD moved by gbrain's own commits; the refresh killed at fenced after a foreign commit, aborted by the owner scan |
| `resume-marks-refused-merge-recovery` | guard | `RecoveryOnlyByPolicy` | `refusedBeforeAbort` (GST-1674): a refresh killed after git refused its fast-forward, before the abort, is marked `recovery_required`; the refresh SIGKILLed right after the refused merge (persistence-worktree-refresh-restart.test.ts), aborted by the owner scan |
| `resume-needs-exact-target` | guard | `RecoveryOnlyByPolicy` | `recoverOne`'s bookkeeping branch: with HEAD only exactly at the target, a commit between the merge and bookkeeping strands the row; the refresh killed after its merge |
| `abort-skips-owed-sync` | guard | `DeferredLeaves` (AbortLiveness) | `syncAfterUnfinishedRefresh`: no refresh run syncs the members an aborted refresh left behind HEAD; the three GST-1853 tests (aborted then diverged, killed at fenced then `--resume`, owner-scan abort then a diverged tick) |

#8708's local-edit adoption has no guard mutant of its own: `RefreshBarrierAdopt.cfg` checks it against every safety property.

### Found in #8682: a refresh killed at fenced after HEAD moved

A flag-on eval found it first, and the model reproduces it (`resume-marks-unmerged-recovery`, `RecoveryOnlyByPolicy`).
The precheck records `old_head` before the drain. A write already queued drains and commits, and its ledger commit moves
HEAD past `old_head` (another agent's plain-git commit does the same); the fence comes up, and the process is killed
before the merge. `recoverOne` then finds a fenced row whose HEAD is neither `old_head` nor the target and marks it
`recovery_required`. The owner's scan never resumes that state, `--resume` refuses, and the documented way out resets the
checkout to `old_head`, which drops the drained write's commit; until a person acts, every write deferred to the refresh
waits. A live tick in the same state aborts and retries instead. A commit landing between the merge and `bookkeeping`
strands the row the same way (`resume-needs-exact-target`), since recovery wanted HEAD exactly at the target.

The fix (#8705) records `outcome.merge_started`, false at the fence and set in its own transaction just before
`git merge --ff-only`. Recovery aborts a fenced row whose merge never started, and runs `bookkeeping` for one whose HEAD
is the target or a strict descendant of it. `recovery_required` remains only for a merge that ran on a HEAD that no
longer holds the target (`merge_started_off_target`): a reset plus an unrelated commit (test 7 in
test/persistence-worktree-refresh.test.ts). Every config passes with the fix, and that policy case stays reachable.

GST-1674 closed the last other case: a plain-git commit between the HEAD check and the merge makes the ff-only merge
refuse. The live tick aborts it (#8765), and a process killed between the refused merge and that abort is aborted by
recovery when the reflogs of HEAD and its branch show HEAD never reached the target since `outcome.merge_started_at`
(`RefusedAbortable`, `resume-marks-refused-merge-recovery`). The model reads that fact from `rtgt` and assumes the
reflog is kept; without one the code keeps `recovery_required`, which leaves the row for a person, as before.

### Races found in #8705

This model found two races in #8705's first version; 03b89121 fixed both, with the repro tests in
test/import-write-barrier.test.ts. The mutants below put each one back.

- **A held write landed on top of a later one** (`hold-beside-held-off`, `CommitsInAdmissionOrder`). A write held for
  an import holds back nothing in the claim's FIFO rules, so after the sync's page row imported F (the file now matching
  the page) and before its checkpoint stamped `last_commit`, a later write to P was claimed, passed the queued
  checkpoint, prepared cleanly and committed; the stamp then released the held write, which landed over it, its
  `supersedes` naming the later write's commit as the import. The fix holds the later write beside the held one
  (compareFileTarget refuses it `pending_import` with the held write's `deferred_import_from`; constant
  `HoldBehindHeld`). A later write claimed while the held one waits cannot be prepared after the stamp: a sync row is
  never claimed while a foreground write runs. Blocking the later write behind the held one in the claim FIFO instead
  stalls the sync: a pass stopped after a slice queues its checkpoint behind the blocked write.
- **The import expiry failed a write whose import had landed** (`import-expiry-skips-source-lock`,
  `ExpiryOnlyWhileWaiting`; Postgres only). The re-check read `last_commit` without a lock on the source row, so a
  checkpoint that committed between it and `completeWrite` left the write `pending_import_expired`. The fix declares the
  protocol and then reads the source row `FOR SHARE` (`ImportExpiryLocksSource`); taking the source row first deadlocks
  with `fenceDraining`'s brain, worktree, source order (`import-expiry-locks-source-first`).

### Found in GST-1853: writes held behind an aborted refresh

A flag-on eval found it, and `RefreshBarrierAbortLiveness.cfg` reproduces it (`abort-skips-owed-sync`, `DeferredLeaves`).
Another agent commits F with plain git while a refresh drains, so the fence keeps managed sync from importing it and
the moved HEAD aborts the refresh. The abort releases the write deferred behind it; preparing it meets the unimported
commit (`pending_import`) and holds it for the import. Only a refresh's own member sync imports while sync is fenced,
and an aborted refresh never runs one, so the write waited for some later sync or refresh (indefinitely while the
checkout stayed diverged) or the wait limit. The other configs never saw it because their fairness lets a scheduled sync
run and time pass the wait limit; this one forces neither. The fix: a refresh run that finds the worktree's newest
refresh aborted runs the members' managed `--no-pull` sync on its way out (`OwedSyncBegin`).

### Not modelled

The removed deferred-write cap (`persistence.refresh_barrier_max_deferred`, no longer read since GST-1582), consumers without the capability, repo-less
sources, `gbrain upgrade --check-downgrade`, edit_page and forget replays, and source lifecycle changes, each covered
by test/refresh-write-barrier.test.ts; more than one worktree, page or refresh at a time; older binaries' claims
(the v292 guard trigger, pinned by its test); effects other than page writes; side effects outside the database.
