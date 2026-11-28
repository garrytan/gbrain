# Rust engine: the store members `gbrain put` and `gbrain get` need

Research note for import part E. It records what a real `gbrain put` then `gbrain get` of one page calls on a Rust
brain, and what master plus import parts A and B still refuse. It is a measurement, not a design.

## How it was measured

- Served members: a put then a get of one note through the real CLI on a Rust brain built from rust-engine/main
  (put and get both exit 0), with a proxy that logs every store member the Rust engine serves and every napi call.
- Raw SQL sites: the same put then get on a PGLite brain at master plus parts A and B, with a proxy that logs each
  `executeRaw` caller. A Rust brain refuses every one of these sites (`engine_capability_missing`).
- Stop points: the same put then get on a Rust brain at master plus parts A and B, plus the draft journal port on
  this branch.

## Totals

- 97 store members are served on the rust-engine/main put and get path.
- 60 of them are not served at master plus parts A and B: 27 already have a master interface member and
  need only the Rust store member; 33 need a new interface member and call-site rewrites from raw SQL.
- 2 napi functions on that path are missing on master: `hasExtractedEvents` and `pageAwaitsRederive`
  (rust-engine/main: `rust/crates/gbrain-store/src/chronicle_state.rs`, `generations/needs_rederive.rs`; napi in
  `families/chronicle_state.rs` and `facts_purge_tx.rs`). Master's store has no `chronicle_state.rs`, so they need a
  Rust port and an addon build.
- Part C serves none of the 60. Part D serves 3: `readLedgerSource`, `replaceDerivedAliases`,
  `moveChunkIndexes`. Part E drops them if D lands first.
- 62 raw SQL caller sites in 38 files run on the PGLite put and get path.

## Result (import part E)

- `gbrain put` (new page, second page, update with `--expected-revision`) and `gbrain get` (`--json` and raw) exit 0
  on a non-managed Rust brain. `test/rust-cli-put.test.ts` runs the same CLI calls on PGLite, Postgres and Rust and
  compares stdout, the JSON key order and the stored bytes; it fails on the part E base and passes on this branch.
- All 60 members above are served except `listCompactableReceipts` (see the refusal below). 85 more members that the put and get path reaches are served too, with the
  `getChunks`, `readPageSnapshot`/`getPage` and `createVersion` options rust-engine/main added. `readPageTrustRows`
  now carries `precedence` (Rust: `cli_reads/precedence.rs`; no store format change).
- `hasExtractedEvents` and `pageAwaitsRederive` are served by `put_reads.rs` and answer `false`: master's store has
  no extracted-event or rederive state, so `false` is the true answer there (no store format bump).
- A put of a note that links to another page reads the source's slug aliases (`listSlugAliases`) and which link
  targets are live pages (`listLinkEndpointPages`) to follow a renamed page's old slug, and builds the source's basename
  index from `getAllSlugs` on an engine without raw SQL (`persistence/links-preparation.ts`). A put in a source with a
  shared skill pack reads the page's origin row (`readPageOrigin`, now with `source_uri`) in
  `shared-skills/knowledge-guard.ts`. `test/rust-cli-put.test.ts` (a wikilinked put through the CLI) and
  `test/engine-parity/page-write-readers.test.ts` (alias, basename and skill-pack cases) pin them on all three engines.
- Refusals that remain on the path, none of which changes the output:
  - Receipt compaction: `listCompactableReceipts` is not served, because `compactReceipt` runs `SET LOCAL` and raw SQL
    per receipt. `compactWriteReceiptsDetailed` refuses up front with `engine_capability_missing` (nothing read or
    written). `runCompactionPass` does not ask on an engine without `raw_sql`: it records `receipt_compaction_unsupported`
    and carries on, so a put reaches no refusing member there.
  - `slug-params.ts` `storedSpellings` runs raw SQL on a `get` miss; the refusal is caught and the miss is reported
    as on the other engines.
  - `MinionQueue.add` with `coalesceOnIdempotencyKey` on a short put; the refusal is caught and no job is queued.
  - A slug stored with capital letters: the Rust store lowercases slugs, so it refuses `engine_capability_missing`
    (`putPage (a slug with capitals)`) instead of storing a second spelling.
- Not on the put and get path, still refused on Rust: `delete_page` (`originOf`), `restore_page`
  (`clearOwedPurges`), `append_page` (`inlineRegions`), the facts and takes fence projection family, multi-source
  `getChunks`, and the fuzzy `get` fallback's `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`.

## Current stop points before part E (master plus A, B and the draft journal port)

- put: `src/core/ops/page-mutations.ts:454` runs `ADMISSION_SOURCE_SQL` through `executeRaw`. rust-engine/main calls
  `ctx.engine.readAdmissionSource(sourceId)` there (and in `preadmit-cache.ts`). Earlier, the walk passes a
  non-fatal refusal at `behavior-change-notice.ts:164` (`brainCreatedBefore`).
- get: `readPageSnapshot` with option `resolveAlias` (`src/core/rust-engine/store-members/common.ts` takeOptions,
  from `src/core/ops/pages.ts:161`).
- The draft port on this branch already moves `assertPageRequestIdentity` to `readTopologyChange` and
  `getWriteRequest` to `readWriteRequest`, and serves those plus 21 more journal members on the Rust engine.
  It is not yet type-checked.

## Unserved members with a master interface member (27)

- `declarePersistence`
- `deleteTakeRows`
- `expireMemoryProposals`
- `getWorktreeBinding`
- `hasExtractedEvents`
- `hasPersistenceTable`
- `hasWithdrawnFenceClaim`
- `listActiveAccessMembers`
- `listAwaitingMemoryProposals`
- `listGuestSourceIds`
- `listSharedSkillPackRoots`
- `matchTakeRows`
- `moveChunkIndexes` (served by part D)
- `pageAwaitsRederive`
- `publicationJournalStore`
- `purgeMemoryProposals`
- `readAdmissionSource`
- `readCapacityForecastInputs`
- `readLedgerSource` (served by part D)
- `readPageTrustRows`
- `readSourceState`
- `removeTimelineRows`
- `replaceDerivedAliases` (served by part D)
- `sealImportedPage`
- `setWriteContext`
- `sharedSkillPackTablePresent`
- `updateTimelineDetails`

## Unserved members that need a new interface member (33)

- `bumpPageRetrievals`
- `claimHousekeepingTurn`
- `completeHousekeepingTurn`
- `deleteConsumerRow`
- `expireStaleWriteClaims`
- `hasClaimableWrite`
- `hasGuestSource`
- `hasSegmentStorage`
- `listCompactableReceipts`
- `listEffectRecoveries`
- `listFenceFactRows`
- `listFenceHoldRows`
- `listFenceRetireCandidates`
- `listGatedMirrorRequests`
- `listGuardedTakeRows`
- `listLinkEndpointPages`
- `listOverdueHeldWrites`
- `listOwnerRecoveryHeads`
- `listPendingSegmentedProjections`
- `listReservationsAfter`
- `listResumableRefreshes`
- `listRetiredDeactivations`
- `listTopologyRecoveries`
- `readDatabaseClock`
- `readGraduationGateRow`
- `readHeldPageRows`
- `readLivePageBody`
- `readReceiptBudget`
- `renewConsumerRow`
- `selectClaimableEffect`
- `selectClaimableWrite`
- `selectProjectionWindowJobs`
- `stampWorktreeHeartbeats`

## Raw SQL caller sites on the put and get path, by file

- `src/core/access/serves.ts`: `brainServes:29 (put)`
- `src/core/behavior-change-notice.ts`: `brainCreatedBefore:164 (put)`
- `src/core/generations/adapters/fact-rows.ts`: `projectFactFenceGeneration:72 (put)`
- `src/core/generations/fence.ts`: `listFenceHolds:180 (get)`
- `src/core/guests/marker.ts`: `brainHasGuestSource:39 (get)`
- `src/core/last-retrieved.ts`: `<anonymous>:224 (get)`
- `src/core/ops/get-page-projection.ts`: `pageTrustForRead:217 (get)`
- `src/core/page-body/projection.ts`: `rebuildPendingSegmentedProjections:235 (put)`
- `src/core/page-state/projections.ts`: `selectWindowJobs:613 (put)`
- `src/core/persistence/canonical-projections.ts`: `<anonymous>:710 (put)`, `<anonymous>:808 (put)`
- `src/core/persistence/compaction-pass.ts`: `housekeepReceipts:77 (put)`
- `src/core/persistence/consumer.ts`: `phase:972 (put)`
- `src/core/persistence/coordinator.ts`: `<anonymous>:620 (put)`
- `src/core/persistence/deactivation.ts`: `cleanupRetiredManagedMarkers:362 (put)`, `readRetired:331 (put)`
- `src/core/persistence/effect-journal.ts`: `<anonymous>:147 (put)`, `<anonymous>:160 (put)`, `hasRearmableTargets:221 (put)`, `mirrorGates:192 (put)`, `releaseAbandonedClaims:304 (put)`, `releaseAbandonedClaims:307 (put)`
- `src/core/persistence/effect-recovery-scan.ts`: `selectEffectRecoveries:13 (put)`
- `src/core/persistence/graduation-custody.ts`: `assertGraduationAdmission:366 (put)`
- `src/core/persistence/graduation-schema.ts`: `graduationTablePresent:91 (put)`, `readGraduationConnectRow:134 (get)`, `readGraduationConnectRow:134 (put)`
- `src/core/persistence/held-reads.ts`: `<anonymous>:82 (get)`
- `src/core/persistence/housekeeping-turn.ts`: `claimHousekeepingTurn:34 (put)`, `completeHousekeepingTurn:47 (put)`
- `src/core/persistence/journal.ts`: `<anonymous>:318 (put)`, `<anonymous>:359 (put)`, `<anonymous>:863 (put)`, `compactWriteReceiptsDetailed:1231 (put)`, `hasClaimableWrite:783 (put)`, `sweepSegmentStorage:1180 (put)`, `vacuumPersistenceQueues:1158 (put)`, `vacuumPersistenceQueues:1166 (put)`
- `src/core/persistence/limits.ts`: `readReceiptTargetBytes:23 (put)`
- `src/core/persistence/links-preparation.ts`: `prepareAutomaticLinks:131 (put)`
- `src/core/persistence/managed-mode.ts`: `readPersistenceBrain:98 (put)`
- `src/core/persistence/memory-proposals.ts`: `runMemoryProposalUpkeep:193 (put)`, `runMemoryProposalUpkeep:201 (put)`, `runMemoryProposalUpkeep:214 (put)`
- `src/core/persistence/page-mutations.ts`: `<anonymous>:454 (put)`
- `src/core/persistence/protocol.ts`: `declareDurablePersistence:57 (put)`
- `src/core/persistence/receipt-true-up.ts`: `<anonymous>:51 (put)`, `sweepCompactedReservations:83 (put)`, `trueUpRequests:35 (put)`
- `src/core/persistence/refresh-barrier.ts`: `expireDeferredWrites:146 (put)`, `expireDeferredWrites:148 (put)`, `expireDeferredWrites:161 (put)`
- `src/core/persistence/schema-admission.ts`: `schemaAdmissionRefusal:44 (put)`
- `src/core/persistence/segmented-mirror-gate.ts`: `resumeGatedMirrors:89 (put)`
- `src/core/persistence/topology-recovery.ts`: `scan:224 (put)`
- `src/core/persistence/valid-time-advisory.ts`: `<anonymous>:25 (put)`
- `src/core/persistence/worktree-refresh.ts`: `resumeWorktreeRefreshes:1243 (put)`
- `src/core/shared-skills/knowledge-guard.ts`: `<anonymous>:87 (put)`, `<anonymous>:91 (put)`
- `src/core/sources-load.ts`: `fetchSource:285 (put)`
- `src/core/trust/fence-guard.ts`: `guardFenceRows:73 (put)`
- `src/core/wanted-links-store.ts`: `wantedReadAt:36 (put)`

## All 97 members served on the rust-engine/main path

`listCompactableReceipts` is in this list as measured on rust-engine/main; this branch does not serve it (see Result).

`addPageTagsById`, `applyTransactionSettings`, `bumpPageRetrievals`, `claimHousekeepingTurn`, `completeHousekeepingTurn`, `completeWriteRow`, `declarePersistence`, `deleteChunks`, `deleteConsumerRow`, `deleteTakeRows`, `expireMemoryProposals`, `expireStaleWriteClaims`, `findDuplicatePage`, `findTopologyChanges`, `getAllConfig`, `getConfig`, `getConfigValues`, `getSource`, `getWorktreeBinding`, `hasClaimableWrite`, `hasExtractedEvents`, `hasGuestSource`, `hasPersistenceTable`, `hasSegmentStorage`, `hasWithdrawnFenceClaim`, `insertLocalWriterRow`, `insertPublicationEffects`, `insertWriteRequest`, `listActiveAccessMembers`, `listAllSources`, `listAwaitingMemoryProposals`, `listCompactableReceipts`, `listConfigKeys`, `listEffectRecoveries`, `listFenceFactRows`, `listFenceHoldRows`, `listFenceRetireCandidates`, `listGatedMirrorRequests`, `listGuardedTakeRows`, `listGuestSourceIds`, `listLinkEndpointPages`, `listOverdueHeldWrites`, `listOwnerRecoveryHeads`, `listPendingSegmentedProjections`, `listReservationsAfter`, `listResumableRefreshes`, `listRetiredDeactivations`, `listSharedSkillPackRoots`, `listSourceRecords`, `listSourceRoutingRows`, `listTopologyRecoveries`, `lockPageKeys`, `lockPersistenceCounters`, `lockWriteRequest`, `matchTakeRows`, `moveChunkIndexes`, `pageAwaitsRederive`, `publicationJournalStore`, `purgeMemoryProposals`, `putPage`, `readAdmissionSource`, `readCapacityForecastInputs`, `readDatabaseClock`, `readGraduationGateRow`, `readHeldPageRows`, `readJournalLimitRows`, `readLedgerSource`, `readLivePageBody`, `readLocalWriterRow`, `readPageSnapshot`, `readPageTrustRows`, `readPersistenceBrainId`, `readReceiptBudget`, `readSourceMembership`, `readSourceState`, `readTopologyChange`, `readWriteRequest`, `readWriterAdminState`, `removeTimelineRows`, `renewConsumerRow`, `renewWriteClaim`, `replaceDerivedAliases`, `replaceDerivedLinks`, `sealImportedPage`, `selectClaimableEffect`, `selectClaimableWrite`, `selectProjectionWindowJobs`, `setConfig`, `setPageAliases`, `setWriteContext`, `sharedSkillPackTablePresent`, `stampWorktreeHeartbeats`, `stampWriteClaim`, `transaction`, `transactionDirect`, `updateTimelineDetails`, `upsertChunks`
