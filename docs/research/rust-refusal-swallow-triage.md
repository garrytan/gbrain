# Rust refusal-swallow triage

Every site the silent-read-catches guard lists under rule `capability_refusal_swallowed` over rust-engine/main, read at its file and line and classified. Docs only: no `src/` code changed, nothing fixed. The rows are in `docs/research/rust-refusal-swallow-triage.tsv` (same order as the guard list).

## What this says

- The guard lists 351 sites (the brief expected about 344; this is the guard's own output, used as is).
- 147 are silent: the handler falls back to an empty, zero, ok or default answer. 52 rethrow, 73 return or record a typed degraded marker, 79 cannot run on a Rust brain.
- 124 are swap blockers (silent and reached by a non-managed Rust brain). 23 more are silent but reached only with managed persistence on: named stops, not blockers.
- 57 of the 124 blockers have no lane in the owner table (autopilot, minion worker and sync handler plumbing, search cache, google, ops loops, budget ledger, bootstrap verify and others). They need an owner before the swap.

## How it was made

- Worktree `/var/tmp/rst`, branch `vorflux/refusal-swallow-triage`, at rust-engine/main `b7b18e5ab3fb4b55ab00a28a4d75690d0324b178`.
- Guard: `check-silent-read-catches.ts`, `silent-read-rules.ts`, `capability-refusal-rule.ts` and `lib/count-ratchet.ts` from the scripts directory at master, copied out of `git show 83eab8df37:scripts/<file>` (origin/master `83eab8df37dfe0175274e28c1082d504a942d836`) into `/var/tmp/rst-guard/`, `node_modules` symlinked to `/var/tmp/rmt/node_modules`.
- Run: `GBRAIN_GUARD_ROOT=/var/tmp/rst bun /var/tmp/rst-guard/check-silent-read-catches.ts --list`. It prints 2096 rows (351 `capability_refusal_swallowed`, 1294 `catch_empty`, 451 `promise_catch_empty`); the 351 rows with the capability rule are the triage set. `file:line` is the catch line.
- Classification: each site was read in context with a small TypeScript helper that prints the guarded raw-SQL call, the handler body, any Rust gate earlier in the enclosing function (`answersFromCatalog`, `servesRawSql`, `engine.kind`, managed checks) and whether every raw call sits inside a nested catch. Helper callees (`checkError`, `capabilityUnknownCheck`, `schemaBehindGuests`, `recoverOrThrow`, `refusal()`) were read where a handler leaned on them.

### Rules used

- `rethrows`: the refusal propagates out on every path (a throw, `fail()`/exit, a helper that always throws, or a handler that rethrows everything except a named non-refusal case such as a missing table or a statement timeout). A swallowed ROLLBACK next to a rethrown read failure is filed under not-reached-on-Rust.
- `typed-degrade`: the handler returns or records a typed marker the caller shows: a doctor `warn` check (`checkError`, `Health unknown`, `not verified`), a `failed`/`pending`/`unknown` status, an `{ ok: false, error }` result, a counted failure, or a warning list entry. A fallback to a typed engine method with the same effect also counts.
- `silent`: a zero, empty, `ok`, `true`/`false`, `null` or default that looks like a real answer, including handlers that only log to stderr and carry on.
- `not-reached-on-Rust`: migrations, migrate-engine, engine graduation, db-repair, vector-index and ANN DDL, pg catalog probes, code gated by `engine.kind === 'postgres'` or `answersFromCatalog`/`servesRawSql` before the call, a transaction cleanup that only runs after a BEGIN a Rust brain refuses first, and the topology named stop (`requireTopologyRawSql`).
- Reach is judged from the gate in the enclosing function and the file's role, not from a full call graph. `REQUIRED_CAPABILITIES` is empty in this tree and nothing enforces it, so no command is refused up front; an ungated raw call on a Rust brain reaches the refusal.
- Shadowed sites: where every raw call of an outer try sits inside an inner catch, the inner site decides what a refusal does. These carry `shadowed` or `partly shadowed` in the notes. They are still counted by the rule above (for example `embedding-health.ts:111` is silent and counted as a blocker, but the inner site at :95 swallows the refusal first, so fixing :95 is what changes behaviour).

## Counts by class

| class | sites |
|---|---|
| silent | 147 |
| rethrows | 52 |
| typed-degrade | 73 |
| not-reached-on-Rust | 79 |
| total | 351 |

## Counts by rust_reach

| rust_reach | sites |
|---|---|
| unmanaged | 215 |
| managed-only | 57 |
| none | 79 |

| class | unmanaged | managed-only | none |
|---|---|---|---|
| silent | 124 | 23 | 0 |
| rethrows | 37 | 15 | 0 |
| typed-degrade | 54 | 19 | 0 |
| not-reached-on-Rust | 0 | 0 | 79 |

## By owner lane

| owner | sites | silent | rethrows | typed-degrade | not-reached | swap blockers | named stops |
|---|---|---|---|---|---|---|---|
| lane 4 | 5 | 3 | 0 | 1 | 1 | 3 | 0 |
| lane 6 | 14 | 10 | 1 | 3 | 0 | 10 | 0 |
| lane 7 | 11 | 3 | 0 | 8 | 0 | 1 | 2 |
| lane 8 | 7 | 7 | 0 | 0 | 0 | 7 | 0 |
| lane 10 | 5 | 4 | 1 | 0 | 0 | 3 | 1 |
| lane 11 | 28 | 17 | 9 | 2 | 0 | 12 | 5 |
| lane 13 | 4 | 0 | 4 | 0 | 0 | 0 | 0 |
| lane 14 | 72 | 20 | 2 | 24 | 26 | 17 | 3 |
| lane 15 | 14 | 9 | 5 | 0 | 0 | 8 | 1 |
| lane 16 | 2 | 0 | 2 | 0 | 0 | 0 | 0 |
| lane 17 | 9 | 2 | 3 | 4 | 0 | 2 | 0 |
| lane 18 | 26 | 5 | 5 | 4 | 12 | 0 | 5 |
| managed-program | 18 | 6 | 8 | 2 | 2 | 4 | 2 |
| unowned | 136 | 61 | 12 | 25 | 38 | 57 | 4 |
| total | 351 | 147 | 52 | 73 | 79 | 124 | 23 |

## Named stops (silent, managed-only)

### lane 7 (2)

- `src/core/persistence/effect-retry.ts:228` `retryIndexLockParks`: empty catch: parked index-lock effects are not retried this pass (effect retry)
- `src/core/persistence/journal.ts:1289` `writeHealthFacts`: () => null so the journal health facts are missing (journal)

### lane 10 (1)

- `src/core/repair/origin-twins-heal.ts:146` `healOriginTwinsAfterManagedSync`: stderr line 'heal did not run' and returns the sync result unchanged (origin twins heal after managed sync)

### lane 11 (5)

- `src/core/persistence/sync-drain.ts:838` `drainManagedSync<anon@1>`: SELECT 1 probe, () => undefined (sync drain)
- `src/core/persistence/sync-ghosts.ts:62` `countSyncGhosts`: .catch(() => []) so no ghost scan report is read (sync ghosts)
- `src/core/persistence/sync-movement.ts:134` `liveSyncJob`: .catch(() => []) so no live sync job is found (sync movement)
- `src/core/persistence/sync-run.ts:1145` `admitWindowGroup`: () => null so no window request id is found (sync run)
- `src/core/persistence/sync-tail.ts:83` `runSyncTail`: () => undefined so the tail checkpoint is not deleted (sync tail)

### lane 14 (3)

- `src/commands/doctor/checks/foreign-writers.ts:143` `repositories`: empty catch: a brain without the managed tables yields no repositories (persistence_host_bindings)
- `src/commands/doctor/checks/foreign-writers.ts:182` `pendingEffectPaths`: empty catch: no persistence tables yields no pending effect paths
- `src/commands/doctor/checks/git-convergence.ts:80` `unwatchedDurableRoots`: .catch(() => []) over persistence_source_bindings yields no unwatched roots

### lane 15 (1)

- `src/core/persistence/page-visibility.ts:160` `assertLabelledOnlyCreate`: .catch(() => []) so the labelled-only config reads as unset (page visibility; access misc)

### lane 18 (5)

- `src/core/persistence/drift-conflicts.ts:191` `claimedBySourcePath`: returns false: the page is not seen as claimed by its source path (drift conflicts)
- `src/core/persistence/landing-gaps.ts:45` `readLandingGaps`: .catch(() => []) so there are no bindings and the gap read reports not_applicable (landing gaps)
- `src/core/persistence/preparation-budget.ts:120` `readPreparationConfigValues`: .catch(() => []) so preparation budget config reads as unset (preparation budget)
- `src/core/persistence/refresh-barrier.ts:174` `deferredWaiting`: .catch(() => [{ waiting: true }]) fail-closed default (refresh barrier)
- `src/core/persistence/soak-counters.ts:42` `recordSoakEvent`: () => undefined so the soak counter is not recorded (soak counters)

### managed-program (2)

- `src/core/persistence/git-conversion.ts:901` `withRecovery`: .catch(() => []) so the source reads as not strict-git during conversion recovery (git conversion)
- `src/core/persistence/put-page-screen.ts:54` `unchangedPutPage`: returns false (not unchanged) so the put proceeds as a normal write (put-page screen)

### unowned (4)

- `src/core/git/redact-finish.ts:37` `sourceRoots`: empty catch: a brain without persistence bindings yields no source roots (git redact-finish)
- `src/core/git/redact-finish.ts:167` `secretPublishMaintenance`: .catch(() => []) over persistence_host_bindings yields no roots (git redact-finish)
- `src/core/git/redact-finish.ts:183` `secretPublishMaintenance`: empty catch ('no persistence tables, or no owner here'): failed git effects not found (git redact-finish)
- `src/core/session-lane.ts:87` `readSessionLane`: () => [] so no live session consumers are read (session lane; not in the lane table)

## Swap blockers (silent, reached by a non-managed Rust brain)

### lane 4 (3)

- `src/commands/recall.ts:693` `splitMayMatch`: returns true (may match) so the recall split runs; facts recall (recall.ts is not under facts/, closest lane 4)
- `src/core/facts/writeback-audience.ts:85` `classifyBrainAudience`: .catch(() => null) so the declared-audience read is empty (writeback audience)
- `src/core/search/facts-arm.ts:451` `applyFactSourcePages`: returns the results without their fact source pages (search facts arm)

### lane 6 (10)

- `src/commands/edges-backfill.ts:94` `runEdgesBackfill`: falls back to sourceIds = ['default'] so other sources are skipped (edges-backfill is links extraction)
- `src/commands/extract-explain.ts:169` `runExtractExplain`: leaves the rollup null (extract-explain)
- `src/core/cycle/extract-atoms-input.ts:117` `releasePartialDispositions`: console.error then continues; cut items stay skipped (extract atoms)
- `src/core/cycle/extract-atoms-input.ts:138` `stampTranscriptTombstone`: fail-soft: transcript tombstone not stamped (extract atoms)
- `src/core/cycle/extract-atoms-stamp.ts:57` `sourcesWithStaleExtractAtomsRun`: returns null; callers do not warn (extract atoms stale-run stamp)
- `src/core/cycle/extract-atoms.ts:470` `discoverExtractablePages`: console.error then returns [] so the transcript path proceeds without page discovery (extract atoms)
- `src/core/cycle/extract-atoms.ts:567` `atomsExistingForHashes`: logs, returns an empty set ('assuming none extracted') so pages are re-extracted (extract atoms)
- `src/core/cycle/extract-atoms.ts:612` `tombstonedTranscriptsForHashes`: logs, returns an empty set ('assuming none tombstoned'), so tombstoned transcripts are re-spent (extract atoms)
- `src/core/cycle/extract-atoms.ts:1020` `runPhaseExtractAtoms>recordItemFailureCount`: logs, returns null so the transcript failure strike is not recorded (extract atoms)
- `src/core/mentions/siblings.ts:110` `siblingCanonical`: returns null so no sibling canonical is found (mentions)

### lane 7 (1)

- `src/core/advisor/collect-chronicle.ts:161` `collectChronicle.collect`: ignored: chronicle advisor input omitted (collect-chronicle is advisor code, closest lane 7)

### lane 8 (7)

- `src/commands/eval-whoknows.ts:272` `loadReplayRows`: returns [] as 'no replay data' (eval capture reads)
- `src/core/context/volunteer-events.ts:295` `purgeStaleVolunteerEvents`: returns 0 purged (volunteer events)
- `src/core/extraction-watermark.ts:194` `readPageWatermark`: warns once, returns { pageId: null, stored: null } so the page re-extracts (extraction watermark)
- `src/core/extraction-watermark.ts:217` `commitExtractionPlan`: warns once; the watermark is not stored (extraction watermark)
- `src/core/extraction-watermark.ts:230` `readExtractionReceipt`: warns once, returns null receipt (extraction watermark)
- `src/core/extraction-watermark.ts:248` `setExtractionReceipt`: warns once; the receipt is not stored (extraction watermark)
- `src/core/page-window/segmented.ts:319` `writeDigest`: cache only: digest row not written (page window; open pages)

### lane 10 (3)

- `src/core/repair/fences.ts:558` `reportFences`: [{ held_at: null }] so the oldest invalid-fence hold is unknown (repair fences report)
- `src/core/repair/slug-conflicts.ts:373` `recordState`: .catch(() => []) so the recorded state has no source_path (repair slug-conflicts)
- `src/core/repair/slug-conflicts.ts:823` `reportConflicts`: [{ held_at: null }] so the oldest hold is unknown (repair slug-conflicts report)

### lane 11 (12)

- `src/core/minions/handlers/sync-job-drain.ts:46` `planJobDrain`: .catch(() => []) so no job-drain timing row is read (sync job drain)
- `src/core/minions/handlers/sync.ts:41` `makeSyncHandler<anon@1>`: falls through to the global config.sync anchor instead of the source's own (sync handler)
- `src/core/minions/handlers/sync.ts:62` `makeSyncHandler<anon@1>`: disabled = false, so a refused read looks like sync enabled (sync handler)
- `src/core/minions/handlers/sync.ts:113` `makeSyncHandler<anon@1>`: .catch(() => []) so concurrent active syncs are not seen (sync handler)
- `src/core/minions/sync-queue-wake.ts:97` `startSyncQueueWake`: logs 'LISTEN failed' and carries on with no wake (sync queue wake)
- `src/core/serve-sync-runner.ts:624` `maybeDrainDeferredEmbeds`: log('embed-drain failed') only (serve sync runner deferred embeds)
- `src/core/sync-cost-gate.ts:496` `runInlineCostGate`: queuedBackfills = 0 (sync cost gate)
- `src/core/sync-git.ts:150` `resolveSlugsForRemovedPaths`: best-effort: removed-path slug not resolved (sync-git)
- `src/core/sync-git.ts:163` `resolveSlugsForRemovedPaths`: best-effort: removed-path slugs not resolved (sync-git)
- `src/core/sync-git.ts:208` `resolveSlugsForRemovedPaths`: fail-open: keeps the legacy removed-path fallback without origin evidence (sync-git)
- `src/core/sync-identity-downgrades.ts:158` `identityRemedyParts`: .catch(() => []) so the identity remedy omits the brain id (sync identity downgrades)
- `src/core/sync-policy.ts:51` `loadActivationPendingSourceIds`: returns an empty set so no source is marked activation-pending (sync policy; activation is also in the managed-program family)

### lane 14 (17)

- `src/commands/config.ts:1459` `runConfig`: console.error WARN then proceeds with the embedding column change (config set embedding coverage probe)
- `src/commands/doctor/checks/content-quality.ts:70` `runContentSanity`: .catch(() => []) so the segmented-page count is dropped with no marker
- `src/commands/doctor/checks/content-quality.ts:119` `runContentSanity`: .catch(() => []) so the junk-page sample count is 0
- `src/commands/doctor/checks/content-quality.ts:368` `runFrontmatter>dbPageCountForSource`: returns null so the partial message drops the DB denominator
- `src/commands/doctor/checks/embedding-health.ts:95` `runEmbeddingProvider`: table may be missing treated as empty; embedded coverage unreported
- `src/commands/doctor/checks/embedding-health.ts:111` `runEmbeddingProvider`: shadowed (every raw call sits in a nested catch; the inner site decides): empty catch around loadConfig and the coverage read
- `src/commands/doctor/checks/extraction-sync.ts:499` `countExtractAtomsBacklogBySource`: returns null so backlog_by_source is omitted from the details and the fix hint loses its per-source list
- `src/commands/doctor/checks/git-convergence.ts:109` `markReadOnlyMirrors`: .catch(() => []) over sources yields no read-only mirror marks
- `src/commands/doctor/checks/memory-writeback.ts:415` `buildMemoryWritebackCheck`: empty catch for 'pre-facts brains': expired-fact count omitted
- `src/commands/doctor/checks/projection-readiness.ts:85` `checkProjectionReadiness`: .catch(() => []) so segmented pending count is 0 and the note is omitted
- `src/commands/doctor/checks/supervisor-health.ts:213` `runSupervisor`: skip silently: lock holder not reported
- `src/commands/doctor/report-remote.ts:201` `doctorReportRemote`: catch pushes status ok 'no event projections yet'
- `src/commands/doctor/skill-checks.ts:272` `skillPreconditionsCheck>countPagesForSource`: returns 0 pages for the source
- `src/core/embed-consent.ts:107` `estimateEmbedBackfillUsd`: returns null so the embed backfill cost estimate is unknown with no marker (embed-consent)
- `src/core/embed-stale.ts:380` `embedStalePages`: stderr line then the next page; no failure counter in the result (embed-stale)
- `src/core/embedding-readiness.ts:140` `prepareEmbeddingProjections`: per-page catch skips the page; no count or marker (embedding projection recovery)
- `src/core/minions/handlers/embed-backfill.ts:393` `makeEmbedBackfillHandler>embedBackfillHandler`: stall record is bookkeeping and is dropped; the job's incomplete failure still stands (embed-backfill handler)

### lane 15 (8)

- `src/core/access/handover.ts:177` `previewHandover`: .catch(() => [{ n: 0 }]) so the handover preview shows 0 facts
- `src/core/access/handover.ts:195` `previewHandover`: .catch(() => [{ n: 0 }]) so the handover preview shows 0 credentials
- `src/core/access/labelled-only.ts:77` `labelledOnlyFor`: returns true (labelled-only, fail-closed default) with no marker
- `src/core/access/read-log.ts:123` `ReadLogWriter.flush<anon@1>`: drops the read-log batch and warns once on stderr; no marker the caller sees
- `src/core/schema-pack/lint-rules.ts:333` `extractableEmptyCorpus`: returns [] so the empty-corpus lint finding is skipped (schema-pack lint)
- `src/core/schema-pack/query-cache-invalidator.ts:74` `invalidateQueryCache`: returns rows_invalidated: 0 so a stale query cache is not cleared (schema-pack cache invalidator)
- `src/core/schema-pack/sync.ts:90` `probePrefix`: returns { count: 0, sample: [] } (schema-pack sync prefix probe)
- `src/core/sources-not-readable.ts:60` `assertUnscopedReadReachesPages`: returns without raising the 'not readable' refusal (sources-not-readable; access misc)

### lane 17 (2)

- `src/core/context/volunteer.ts:384` `volunteerUsageStats`: rows = [] so volunteer usage stats are empty (context/volunteer*)
- `src/core/fence-repair/hold-fix.ts:58` `readFenceAutoRepair`: .catch(() => []) so the fence auto-repair config reads as unset (fence-repair)

### managed-program (4)

- `src/commands/sources-add-next.ts:71` `syncOutOfSearchNotice`: returns null so the 'sync out of search' notice is not shown (sources add)
- `src/commands/sources-lifecycle.ts:58` `addOutcome`: .catch(() => []) so the federated notice defaults
- `src/commands/sources.ts:333` `runAdd`: preflight is best-effort: duplicate google source check skipped
- `src/core/sources-ops.ts:596` `addSource`: () => {}: the cleanup DELETE of the half-added source is lost (sources add)

### unowned (57)

- `src/commands/autopilot-daemon.ts:610` `probeNoWorkerPeer`: logError then returns; the no-worker warning never fires on a refusal (autopilot daemon is not in the lane table)
- `src/commands/autopilot-dispatch.ts:829` `submitAutoDrains`: logError then the auto-drain is not submitted; loop carries on (autopilot dispatch not in lane table)
- `src/commands/autopilot-fanout.ts:330` `readRecentSourceFailures`: no cooldown data, fails open so dispatch proceeds (autopilot fanout not in lane table)
- `src/commands/autopilot-fanout.ts:355` `isSourceInCooldown`: treated as no success, so the source never counts as in cooldown
- `src/commands/autopilot.ts:395` `computeAutopilotIdle`: returns false (not idle) on any error
- `src/commands/code-scope.ts:226` `sourceExists`: returns true (source exists) so the lookup proceeds
- `src/commands/google.ts:717` `runGoogleStatus`: empty catch: status falls back to vault-only (google is not in the lane table)
- `src/commands/serve-health.ts:69` `readServeTransport`: .catch(() => []) so the serve transport is reported unknown/default
- `src/commands/upgrade.ts:1093` `runPostUpgrade`: .catch(() => []) so no brain id is read and the post-upgrade recovery step runs without it
- `src/core/advisor/collect-mcp-client-fit.ts:112` `readClientSurfaces`: returns null so the MCP client-fit check (a) is skipped (advisor is not in the lane table)
- `src/core/backfill-base.ts:180` `getCheckpoint`: returns 0 so the backfill restarts from the beginning with no marker
- `src/core/backfill-base.ts:495` `clearBackfillCheckpoint`: best-effort: the checkpoint is not cleared and nothing says so
- `src/core/bootstrap/verify.ts:257` `removeProbes`: probe cleanup skipped for a 'pre-migration' brain; leftover probe rows (bootstrap verify)
- `src/core/bootstrap/verify.ts:1212` `verifyWorkspace`: sourceRegistered = true, so a refused read looks registered
- `src/core/budget/daily-ledger.ts:185` `dailyLedger>release`: returns false with no reason; the reservation stays held until it expires
- `src/core/code-intel/recursive-walk.ts:133` `symbolLanguages`: returns [] so no symbol languages are found (code-intel)
- `src/core/connectors/api-source.ts:77` `recordRateLimit`: .catch(() => undefined): the connector rate-limit mark is not recorded
- `src/core/connectors/connector-hold-session.ts:50` `ConnectorHoldSession.open`: .catch(() => []) so the hold session opens with no incarnation (connector holds)
- `src/core/core-memory.ts:344` `pendingCoreNotices`: returns [] so pending core-edit notices are not shown
- `src/core/cycle/filing-rules.ts:81` `resolveBrainRepoPath`: returns null so the filing-rules repo path is unresolved (cycle filing rules)
- `src/core/git/redact-finish.ts:168` `secretPublishMaintenance`: partly shadowed (1/2 raw calls sit in a nested catch): empty catch ('no sources table yet') so the root list stays empty (git redact-finish)
- `src/core/google/loop-catchup.ts:269` `pendingLoopsExtractDepth`: returns 0 pending loop-extract jobs (google loop catch-up)
- `src/core/google/people-calendar-sweep.ts:282` `contactPageRelPathByContactId`: rethrows only when deps.managed; otherwise returns null (no contact page path)
- `src/core/google/people-calendar-sweep.ts:301` `calendarPageRelPathByEventId`: rethrows only when deps.managed; otherwise returns null (no calendar page path)
- `src/core/ingestion/applied-captures.ts:76` `purgeStaleAppliedCaptures`: returns 0 purged captures (ingestion applied captures)
- `src/core/minions/handlers/subagent-oneshot.ts:576` `runSubagentOneshot`: existing slugs empty and pageSample = 5 (strict-validation default) (subagent oneshot)
- `src/core/minions/spend-authorization.ts:260` `recordRefusal`: result row not recorded; the caller still throws the spend refusal (benign) (spend authorization)
- `src/core/minions/terminal-hook.ts:119` `terminalHookNotifier>onJobSettled`: console.warn only (terminal hook notifier)
- `src/core/minions/worker.ts:785` `MinionWorker.start>runHealthCheck`: health probe skipped; liveness probe is the fallback (minion worker). UNSURE: the loop at :513 is gated on engine.kind === 'postgres'; runHealthCheck is separate
- `src/core/minions/worker.ts:1005` `MinionWorker.releaseClaimForPause`: console.error; claim lock expires and the stall detector requeues (minion worker)
- `src/core/minions/worker.ts:1051` `MinionWorker.handleQuietHoursDefer`: console.error only (minion worker quiet-hours defer)
- `src/core/onboard/impact-capture.ts:116` `captureMetric`: stderr line then returns null metric (onboard impact capture)
- `src/core/onboard/impact-capture.ts:157` `writeImpactLogRow`: stderr line; the impact log row is not written (onboard impact capture)
- `src/core/ops/jobs.ts:301` `emitNoWorkerNotice`: advice is best-effort: the no-worker notice is dropped (ops jobs)
- `src/core/ops/loops.ts:180` `withheldNoise`: returns null so withheld-noise is omitted (ops loops)
- `src/core/ops/loops.ts:212` `deepLinksFor`: 'links degrade to none' (ops loops)
- `src/core/ops/loops.ts:581` `open_loops.handler`: ranks without backlinks (ops loops open_loops)
- `src/core/ops/put-page-revision-source.ts:33` `rethrowNamingRevisionSource`: advisory hint dropped; the original refusal is unchanged (put-page revision source)
- `src/core/ops/search.ts:596` `prepareExplainTarget`: returns a bare TargetTrace so explain shows no target detail (search explain)
- `src/core/output/writer.ts:196` `WriteTxImpl.createEntity`: advisory lock skipped ('engines may not support advisory locks'); cross-process race protection lost (output writer)
- `src/core/reindex-consent.ts:44` `estimateReindexSpend`: returns est_usd: null so the reindex spend estimate is unknown with no marker (reindex consent)
- `src/core/remediation/run.ts:81` `manualOnlySkips>withoutManualOnly`: .catch(() => []) so no live manual-only jobs are seen (remediation run)
- `src/core/search/dedup.ts:80` `segmentRegions`: returns an empty Map so segment regions are not deduplicated (search dedup)
- `src/core/search/image-vector-presence.ts:22` `brainHasImageVectors`: value = true: reads as image vectors present (search image vector presence)
- `src/core/search/query-cache-gate.ts:139` `buildPageGenerationsSnapshot`: returns the empty page-generations snapshot (search query-cache gate)
- `src/core/search/query-cache.ts:305` `SemanticQueryCache.lookup`: returns { hit: false } for any failure (search query cache)
- `src/core/search/query-cache.ts:383` `SemanticQueryCache.store`: cache write swallowed by design (search query cache)
- `src/core/search/query-cache.ts:404` `SemanticQueryCache.clear`: returns 0 cleared (search query cache)
- `src/core/search/two-pass.ts:108` `expandAnchors`: continues without near-symbol anchors (search two-pass)
- `src/core/search/two-pass.ts:180` `expandAnchors`: best-effort: no direct anchors expanded (search two-pass)
- `src/core/synopsis-sweep.ts:236` `readLastSynopsisSweep`: returns null so the last synopsis sweep is unknown (synopsis sweep)
- `src/core/take-proposals.ts:324` `acceptProposal`: compensation is best-effort: the proposal stays accepted-looking (take proposals)
- `src/core/verbs/entity-names.ts:105` `lookupOne`: .catch(() => []) so the entity lookup finds no body (verbs entity names)
- `src/core/verbs/entity-variants.ts:99` `resolveNameVariant`: returns { matches: [] } (verbs entity variants)
- `src/core/verbs/entity-variants.ts:118` `resolveNameVariant`: .catch(() => []) so the exact-slug read is empty (verbs entity variants)
- `src/core/verbs/entity-variants.ts:180` `readPossibleDuplicates`: returns [] so no possible duplicates are reported (verbs entity variants)
- `src/mcp/source-preflight.ts:51` `assertStdioSourceBindable`: stderr line 'preflight skipped' then proceeds (MCP stdio source preflight)

## Sites to check before relying on them

- Embedding migration (`src/core/embedding-migration.ts` :228 to :1349, `src/commands/migrate-embeddings.ts` :575 and :865, `embedding-migration-retention.ts` :85) is filed as not reached on Rust because it switches the vector column and the Rust store has one fixed vector column. There is no explicit Rust gate in those files. If `gbrain migrate embeddings` (the command `src/commands/migrate-embeddings.ts` serves) can run on a Rust brain, the census and status reads (:555 to :875) become silent blockers for lane 14.
- `src/eval/brainbench/*` (3 sites) is filed as not reached on the reading that the benchmark builds its own in-process engine; no gate says so.
- `src/core/minions/worker.ts:785` (health probe): the worker's readiness loop is gated by `engine.kind === 'postgres'`, but `runHealthCheck` is a separate closure. Filed as unmanaged and silent.
- `src/core/cycle/derived-write-through.ts:302`: the `kept` list that the caller reports was not followed to its reader. Filed typed-degrade.
- `src/core/budget/daily-ledger.ts` :172 (dispatch returns false, the caller releases the reservation) and :185 (release returns false with no reason) are filed typed-degrade and silent respectively; the callers were only read in part.
- `src/core/persistence/held-reads.ts:205` returns a typed unknown (`couldAffect: null`) and its caller also catches; filed typed-degrade, unmanaged because it sits on the search path.
- Doctor `warn` results (`checkError` and the hand-written warns) are filed typed-degrade: they show, but as a plain warn, not the typed `Health unknown` marker. .`content-quality.ts:153` has a typed handler (`capabilityUnknownCheck`) that a refusal never reaches, because the inner `.catch(() => [])` at :119 swallows it first.
- Doctor sites in `foreign-writers.ts` (:143, :182), `git-convergence.ts:80` and `managed-sync-convergence.ts:40` are filed managed-only from the persistence tables they read.

## Owner gaps

57 blockers sit in files the lane table does not name. Biggest groups by file:

- `src/core/minions/worker.ts`: 3
- `src/core/ops/loops.ts`: 3
- `src/core/search/query-cache.ts`: 3
- `src/core/verbs/entity-variants.ts`: 3
- `src/commands/autopilot-fanout.ts`: 2
- `src/core/backfill-base.ts`: 2
- `src/core/bootstrap/verify.ts`: 2
- `src/core/google/people-calendar-sweep.ts`: 2
- `src/core/onboard/impact-capture.ts`: 2
- `src/core/search/two-pass.ts`: 2
- `src/commands/autopilot-daemon.ts`: 1
- `src/commands/autopilot-dispatch.ts`: 1
- `src/commands/autopilot.ts`: 1
- `src/commands/code-scope.ts`: 1
- `src/commands/google.ts`: 1

Where a file fit a lane only loosely the TSV names the lane and says why in the notes (for example `src/commands/recall.ts` to lane 4, `src/core/advisor/collect-chronicle.ts` to lane 7, `src/core/page-state/rename-alias.ts` to lane 18, `src/core/entities/resolve-on-save.ts` left unowned).

## Checks

- The guard list was produced at the shas above and the TSV keeps its order and its `file:line` keys.
- Counts in this file are computed from the TSV by script.
