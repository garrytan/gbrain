/**
 * Plan D9 — BrainEngine surface-coverage sweep (mechanical, shrink-only).
 *
 * Three layers, all runtime-enumerated (no TypeScript type machinery):
 *
 *  1. INTERFACE_METHODS is the checked-in literal list of every method on the
 *     `BrainEngine` interface (src/core/engine.ts). It is asserted BOTH ways
 *     against `Object.getOwnPropertyNames(PGLiteEngine.prototype)`: every
 *     listed method must exist on the prototype, and every non-private
 *     prototype member must be classified (interface method or pinned
 *     internal helper). A new engine method therefore forces a visible,
 *     reviewable edit to one of these lists.
 *
 *  2. The UNCALLED allowlist is SHRINK-ONLY. At runtime the test scans every
 *     other file under test/ for a reference to each interface method
 *     (`.name(`, `.name!(`, `.name?.(` call sites, or `name:` stub-property
 *     definitions — the same loose-but-mechanical match a coverage grep
 *     uses; a bare mention in a comment does not count). The set of
 *     methods with ZERO references outside this file must equal UNCALLED
 *     exactly:
 *       - a NEW method with no test anywhere fails ("never-called methods
 *         can't ship") until it either gets a real test or is explicitly
 *         allowlisted + smoked here;
 *       - when real coverage lands elsewhere for an UNCALLED entry, this
 *         test fails until the entry is REMOVED (shrink-only, mechanized).
 *
 *  3. Every UNCALLED entry is smoked ONCE below against a seeded PGLite
 *     engine with a real-shape assertion (not bare no-throw). The SMOKES
 *     map's keys are asserted equal to UNCALLED so an allowlisted method
 *     can't skip its smoke.
 *
 * Known softness (accepted): the corpus scan can false-positive on a
 * `name:` object key that isn't an engine stub. That errs toward "covered"
 * (a stale UNCALLED entry), which the shrink-only equality then flags.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

const DIM = 1536;

/**
 * Every method declared on the BrainEngine interface (src/core/engine.ts),
 * in declaration order. `kind` (a readonly data property, not a prototype
 * method) is asserted separately on the instance in the smoke block.
 */
const INTERFACE_METHODS: readonly string[] = [
  // Cycle-lock leases
  'acquireCycleLock', 'refreshCycleLock', 'releaseCycleLock', 'readCycleLocks', 'deleteCycleLock', 'deleteCycleLockIfStale',
  'assertCycleLease', 'takePageEmbeddingLease', 'renewPageEmbeddingLease', 'releasePageEmbeddingLease',
  // Minion jobs: the job lifecycle (engine-sql/jobs.ts)
  'admitJob', 'getJob', 'listJobs', 'claimNextJob', 'renewJobLease', 'completeJob', 'failJob', 'reclaimStalledJobs',
  // Minion queue: operator writes, sweeps, inbox, private queues, stats and attachments (engine-sql/jobs-queue.ts)
  'deleteTerminalJob', 'pauseJob', 'resumeJob', 'failParentJob', 'resolveParentJob', 'resolveStrandedParents', 'detachChildJob',
  'updateJobProgress', 'addJobTokens', 'delayActiveJob', 'releaseWatchdogClaim', 'markJobWatchdogSuspect',
  'promoteDelayedJobs', 'cancelJobs', 'killTimedOutJobs', 'killWallClockJobs', 'pruneJobs', 'retryJob',
  'listSynthesisCompletionKeys', 'listRecentSynthesisCompletions',
  'postInboxMessage', 'readJobInbox', 'readChildCompletions',
  'listOpenJobIdsInQueue', 'renewPrivateQueueLease', 'listOwnedPrivateQueues', 'readPrivateQueueState',
  'listStaleWaitingJobIds', 'countTtlExpiredWaiting', 'readJobStats', 'readQueueFamilyStats', 'hasOverdueWatchdogSuspect',
  'listUnreviewedJobs', 'getFailedJobForRetry', 'countOpenJobsByOwner', 'readJobSourceState', 'lockOAuthClient', 'listJobPage',
  'listJobAttachmentNames', 'insertJobAttachment', 'listJobAttachments', 'getJobAttachment', 'deleteJobAttachment',
  // Minion queue: health reads (engine-sql/jobs-health.ts)
  'readQueueHealthSignals', 'listWaitingByQueue', 'readQueueDivergence', 'listQueueWedgeCounts', 'listPrivateQueueHealth',
  'readWedgeSignals', 'readOldestWaitingAge', 'countWaitingJobs', 'listStuckActiveJobsByName',
  // gbrain migrate --to <engine>: the source-side reads (engine-sql/engine-migration.ts)
  'readEngineMigrationHistory', 'readMigrationRows', 'readMigrationPageColumns', 'listManualLinkTransitions', 'countLiveTimelineEntries',
  // Minion job counts and last-run reads for the status surfaces, lane L5 group B (engine-sql/jobs-status.ts)
  'readLastAutopilotCycles', 'countJobsByStatus', 'readWaitingQueueDepths', 'readLastCompletedJobAt', 'countTtlCancelledByName',
  'readWaitingScopeState', 'countRecentCompletedJobs', 'listRecentFailedJobErrors', 'readQueuedPageChars', 'readSourceJobCounts',
  'readEmbedBackfillBySource',
  // doctor job checks
  'listStalledEmbedBackfillSources', 'readGlobalMaintenanceDeaths', 'readLastFailedGlobalMaintenanceJob', 'listFactsAbsorbJobsStillDead', 'readLegacyJobAuthority',
  'readQueuedSpendRows', 'listBuildSkewStacktraceLines', 'countDeadDreamSubmissionRows', 'listFactsAbsorbJobsByKeyPrefix', 'listDeadFactsAbsorbJobsByKeys',
  // group D (jobs insight)
  'readJobInsight',
  // group C (spend reservations and lease pressure)
  'readJobSpendTree', 'insertSpendReservation', 'expireSpendReservations', 'settleSpendReservation', 'markSpendUsageUnknown',
  'insertLeasePressure', 'countLeasePressure', 'listRecentLeasePressure',
  // spend ledger and client budgets (engine-sql/spend-log.ts)
  'reserveClientSpend', 'reserveGroupSpend', 'readGroupSpendTotals', 'settleSpendWithLog', 'insertSpendLog', 'sumClientSpendSince',
  'readClientBudgetUsd', 'insertOauthClient', 'updateOauthClientBudget', 'readAgentClientSpend',
  // oauth_clients rows (engine-sql/oauth-clients.ts)
  'readOauthClient', 'listOauthClients', 'patchOauthClient',
  // access_tokens rows (engine-sql/access-tokens.ts)
  'insertAccessToken', 'findActiveAccessTokens', 'setAccessTokenMinTrust',
  // group B (subagent transcript and tool ledger)
  'listSubagentMessages', 'countSubagentMessages', 'insertSubagentMessage', 'listSubagentToolExecutions', 'hasSubagentToolExecution', 'listSubagentWriteOutcomes', 'listSubagentOneshotLedger', 'summarizeSubagentToolExecutions', 'listSubagentPutPageSlugs', 'listSubagentPutPageWrites', 'listSubagentRetainedPutPages', 'listSubagentStagedPages', 'listSubagentTimelineAppendCalls', 'recordSubagentToolExecutions', 'startSubagentToolExecution', 'completeSubagentToolExecution', 'failSubagentToolExecution',
  // group D (takes, salience and code-edge reads)
  'countOffGridTakeWeights', 'countTakes', 'planFactPurgeTakes',
  'listTakeRowsForPage', 'readTakePreimages', 'countMcpResolvedTakes', 'listTakeSupersessionCandidates', 'countZeroWeightWithTakes', 'hasCodeEdgesSymbol',
  'readLivePageIdBySlug', 'readPageTierRef', 'readPageTierRows', 'pageHasFrontmatterKey', 'listTakeIdsLeavingFence', 'listTakePreimages', 'deleteTakesByIds', 'findTakeId',
  // The take-supersession repair reads and pointer write (engine-sql/takes-reads.ts; test/engine-parity/repair-takes-timeline.test.ts)
  'listTakePointers', 'listTakeSupersedeReceipts', 'setTakeSupersededBy',
  // The accepted-takes repair reads (engine-sql/takes-reads.ts; test/engine-parity/repair-history-kinds.test.ts)
  'listAcceptedTakeRemovals', 'readTakeRowTier',
  // The batch 6a history repair reads (engine-sql/version-reasons.ts, overwrite-reads.ts, atom-restore-reads.ts,
  // moved-page-reads.ts; test/engine-parity/repair-history-kinds.test.ts)
  'listVersionsByChangeReason', 'replaceVersionChangeReasons', 'listRetainedVersionBodies', 'readArchivedVersionBody',
  'listOverwriteCandidates', 'listVersionsAfter', 'listOverwriteLivePages', 'readVersionContent',
  'listRestorableAtoms', 'countKeptAtomRetirements',
  'listLivePagesBySourcePaths', 'listLivePagesByFileName', 'listLivePagesSharingFrontmatterId', 'hasSegmentedHistory', 'readLivePagesByIds',
  // The batch 7 generation repair reads (engine-sql/lost-fence-reads.ts, stale-atom-reads.ts;
  // test/engine-parity/repair-generation-kinds.test.ts)
  'listRetiredFenceItems', 'listInlineVersionTexts', 'hasActiveFactText', 'hasTakeClaim', 'readFactTrustTier', 'listFenceFactRowNums',
  'listTakeRowNums', 'readLiveFactRowTier', 'readTakeRowTierByClaim', 'listStaleAtoms',
  // decide family, group B: calibration profiles
  'getLatestCalibrationProfile', 'isCalibrationProfileUnchanged', 'insertCalibrationProfile', 'readVoiceGateHealth', 'purgeCalibrationProfilesByWave',
  'listHeldFenceTakeRows',
  'readTakePreimages',
  // Lifecycle
  'connect', 'disconnect', 'reconnect', 'initSchema', 'transaction', 'transactionDirect', 'registerBeforeDisconnect', 'withReservedConnection',
  // Pages CRUD
  'getPage', 'readPageSnapshot', 'readPageSnapshotsBatch', 'lockPageKeys', 'putPage', 'findDuplicatePage', 'findDuplicatePages', 'deletePage', 'deletePages', 'resolveSlugsByPaths',
  'softDeletePage', 'softDeletePages', 'restorePage', 'purgeDeletedPages', 'listPages', 'findPages', 'countPagesBy', 'resolveSlugs', 'getAllSlugs',
  'listAllPageRefs', 'listEntityKeyRows', 'listIdentityDecisions', 'listRestrictedIdentityMembers', 'applyIdentityDecisions', 'listAllSources', 'listSourceLocalPaths', 'listLocalPathSources', 'listSourceRoutingRows', 'countDefaultSourceSplit', 'updateSourceConfig', 'getSource', 'readSourceDeleteImpact', 'deleteSourceRecord', 'listStaleSyncSourceIds', 'readSourceRow', 'lockSourceRow', 'readSourceChunkerVersion', 'setSourceChunkerVersion', 'countSourcePages', 'insertSource', 'listPrefixSampledPages', 'listCorpusSample', 'markSourceSynced',
  'readPlainSyncSource', 'readOwnerOnlySourcesPresent', 'readOwnerOnlySourceConfig',
  'countRepoBoundSources', 'listNotifierHostSourceRows', 'advanceSourceCommit', 'listSourcePathPages', 'listQuarantinedSlugs', 'readRenameIdentityRows', 'readLiveIdentityHolders', 'readPageSizeRows', 'holdPageEmbedding', 'readReasonPurgeTombstones', 'writeReasonPurgeTombstones',
  // Hybrid search reads (engine-sql/search-reads.ts) and the onboarding signal count (engine-sql/health.ts)
  'cosinesByChunkIds', 'hasSupersedeEdges', 'supersedingPageSlugs', 'aliasCanonicalRefs', 'pageCollapseFacts', 'slugsEndingIn',
  'generatedPagesIn', 'livePageIdsAt', 'pagesLinkingTo', 'countOnboardSignal', 'countBrainLivePages', 'countLivePagesBySource', 'countChunksBySource', 'readBrainMaturity',
  // Graph and doctor link reads (engine-sql/link-reads.ts)
  'inboundLinkCoverage', 'listJunkEntityHubs', 'countEntityPages', 'entityGraphCoverage', 'countForeignEdges',
  'listLivePageSummaries', 'countInboundLinks', 'readEntityInboundEdges', 'listLinkEndpointPages', 'listPagesTitledIn', 'wordLexemes',
  'readLinkContextMatches', 'readLinkContextOriginPages',
  // Link temporal state, search-vector maintenance and retrieval coverage (engine-sql/link-temporal.ts, search-vector.ts, retrieval-coverage.ts).
  'readLinkRelationshipEvidence', 'writeLinkRelationshipState', 'linkRelationshipKeysForPages', 'staleLinkRelationshipKeys', 'linkRelationshipKeysForOrigin', 'applyLinkTemporalRows',
  'writeManualLinkTransitions', 'removeManualLinkTransitions', 'listRelationshipNoteRows', 'edgeValidityCounts', 'listPageStatusByRef', 'listRecordMetadataRows',
  'countSearchVectorRows', 'replaceSearchVectorTriggerFunction', 'backfillSearchVectors', 'ensureFactsKeywordIndex', 'countPendingProjectionPages', 'countEmbeddingHeldPages', 'projectionRebuildProgress',
  'readProjectionReadinessGeneration', 'readProjectionReadiness',
  // Code, doctor, withdrawal, repair and evidence chunk reads (engine-sql/chunk-reads.ts)
  'findCodeDefinitions', 'listSymbolTypesForName', 'findCodeRefChunks', 'countOversizedEmbedSkips', 'countOrphanChunks',
  'countCodeChunkPages', 'codeChunksExist', 'hasUnsealedPages', 'currentCodeChunksExist', 'listQualifiedSymbolNames', 'listWithdrawalChunks',
  'deleteChunksForPages', 'listContextualModeCandidates', 'resolveFrozenHits',
  // CLI reads (engine-sql/cli-reads-ops.ts; covered by test/engine-parity/cli-reads-ops.test.ts)
  'scanExactBatch', 'nextLivePageAfter', 'listExactIdentityCandidates', 'rankEntities', 'listExtractionPendingPages',
  'listUnattributedFacts', 'listWantedPages', 'readRankCoverage', 'readExactSnippetChunks', 'listExactRescanChunks', 'listHeldFenceCells', 'readFenceOverlayRows',
  // Op checkpoints, health memo clock, synopsis sources (engine-sql/write-misc.ts; covered by test/engine-parity/write-misc.test.ts)
  'readOpCheckpointKeys', 'writeOpCheckpointKeys', 'appendOpCheckpointPaths', 'deleteOpCheckpoint', 'deleteOpCheckpointPaths',
  'readOpCheckpointRecord', 'writeOpCheckpointRecord',
  'readOpCheckpointRecords', 'writeOpCheckpointRecords', 'readSyncImportPageRows', 'declareSyncImportPageCursor', 'fetchSyncImportPageCursor',
  'readAdmittedWriteRequests', 'readPageRevisionWriter', 'readRevisionWriterRequest', 'writeSyncAdmissionStamp', 'readSyncAdmissionEffects',
  'listSourceIncarnations', 'listOrphanBindings', 'deleteOrphanBinding', 'readLoopFactState', 'expireSourceFactNow',
  'listConnectorSources', 'listOrphanConnectorCheckpoints', 'countConnectorCheckpointsKeyed', 'deleteOrphanConnectorCheckpoint',
  'listManagedSyncOrphanRows', 'listArchivedSourceIds', 'listManagedSyncFailureKeys', 'applyManagedSyncRetireLimits',
  'retireManagedSyncPassSlugMode', 'retireManagedSyncCursor', 'deleteManagedSyncFailureRow', 'deleteManagedSyncManifest',
  'listOwnedContentRows', 'readContentReceiptBinding', 'readConfigForUpdate',
  // Page repair reads (engine-sql/repair-page-reads.ts; covered by test/engine-parity/repair-page-reads.test.ts)
  'countPageChildOrphans', 'clearPageChildOrphans', 'probeTornPages', 'listAccessReaderDrift', 'countAccessReaderDrift', 'deriveAccessReaders', 'readOriginIndexState', 'listOriginTwinCounts',
  // Alias targets (engine-sql/alias-orphans.ts; covered by test/engine-parity/repair-aliases.test.ts)
  'listAliasTargets', 'deleteOrphanedAliases',
  // Repair page scans (engine-sql/repair-page-scans.ts; covered by test/engine-parity/repair-page-scans.test.ts)
  'listSafeChunksPending', 'listOriginTwinGroups', 'listLegacyOriginPairs', 'listLiveOriginPages', 'countLiveFileBackedPages', 'listRepairScanPages', 'listFileTombstones', 'listTwinMergeLosers',
  'listContactRowPages', 'listSplitFactsPages', 'listAtomFenceCandidates', 'listPageTruths',
  // Repair plan scans (engine-sql/repair-plan-scans.ts; covered by test/engine-parity/repair-plan-scans.test.ts)
  'listPagesByOriginPath', 'countSegmentedOriginPages', 'listSegmentedPageSlugs', 'listProvenAttributionTargets', 'countUnfilledAttribution', 'listFailedWriteRequests', 'readDriftConflictBounds', 'listDriftConflictGroups', 'readDriftConflictDetails', 'listUntiledSegmentedPages', 'listSourceHoldRecords',
  // Git sync hold writes (engine-sql/git-holds.ts; covered by test/engine-parity/git-holds.test.ts)
  'requestGitHoldRetry',
  // A repair's busy-set rows (engine-sql/repair-busy.ts; covered by test/engine-parity/repair-busy.test.ts)
  'readRepairBusyRows',
  // The page writes a repair apply runs (engine-sql/write-guards.ts; covered by test/engine-parity/page-repair-writes.test.ts)
  'detachPageOrigin',
  'readPageDatabaseOnlyReason',
  'bumpPageKnowledgeRevision',
  'removePageFrontmatterKeys',
  'setPageType',
  'readHealthMemoClock', 'listSynopsisSourceIds',
  // The synopsis tier's configuration read (engine-sql/synopsis-tier.ts; covered by test/engine-parity/write-misc.test.ts)
  'readSynopsisTierSources',
  // A source's own contextual-retrieval mode (engine-sql/source-cr-mode.ts; covered by test/engine-parity/write-misc.test.ts)
  'setSourceContextualMode',
  // Write attribution reads (engine-sql/write-attribution.ts; covered by test/engine-parity/write-attribution.test.ts)
  'readWriteAttributionNames', 'readPageRevisionAttribution', 'readVersionAttributions', 'readOldestVersionAttribution', 'readRowAttribution',
  // CLI export and segmented-body reads (engine-sql/export-reads.ts; covered by test/engine-parity/cli-reads-export.test.ts)
  'listExportPageKeys', 'readExportWithdrawalLedgerBytes', 'listExportWithdrawals', 'readExportPageRows', 'normalizeFenceLines', 'readSegmentedPageHead',
  'readBodyManifestRows', 'readBodyManifestMeta', 'readBodyManifestOutline', 'listForcedCutSeqs', 'readManifestSeqAt', 'readSegmentedVersionBodyBytes',
  'listAccessPolicySourceIds', 'setLocalStatementTimeout',
  // CLI import and extract reads (engine-sql/cli-reads-import.ts; covered by test/engine-parity/cli-reads-import.test.ts)
  'listSourceRecords', 'readSourceIncarnation', 'readSyncDispatchRow', 'hasCompanyBrainReceipt', 'readGuestSourceRow', 'listGuestSourceIds',
  'hasGuestSource', 'readPageTrustRows', 'readRowTrustRows', 'readDatabaseClock', 'listLinkPageMetadata', 'listLinkPageMetadataForSlugs', 'listAttendedOriginSlugs', 'listStoredTimelineRows',
  'filterPagesAtRevision',
  // Wanted-link writes (engine-sql/wanted-links.ts; covered by test/engine-parity/wanted-links.test.ts)
  'lockRegisteredSourceIds', 'replaceWantedLinkRows',
  // Facts statements (engine-sql/facts-doctor.ts, facts-cycle.ts, facts-purge.ts, facts-repair.ts, facts-trust.ts)
  'listConversationFactRows', 'countRedactedFacts', 'listOutsideContentFenceCounts', 'countAtomFacts', 'listUnpreviewedTrustFacts',
  'countUnlinkedFactsByOrigin', 'countUnlinkedFactStats', 'countFactRelinkOutcomes', 'listUnlinkedConversationSlugs', 'countFactEmbeddingCoverage',
  'countStaleFactEmbeddings',
  // Embedding catalog (engine-sql/embedding-catalog.ts; covered by test/engine-parity/embedding-catalog.test.ts)
  'readChunkVectorColumn', 'readEmbeddingIdentity', 'listEmbeddingStores', 'hasStoredVectors', 'countChunkVectorCoverage',
  'upsertFactRelinkAttempt', 'listFactRelinkOutcomes', 'deleteFactRelinkMemos',
  'placeRelinkedFact', 'linkConversationFact', 'listConversationRelinkPages',
  'listActiveFactsForEntity', 'listFreshExtractionOutcomes', 'listFenceRowGroups', 'readFactSubject', 'listFactsForPage', 'countLegacyFactsPending',
  'countUnconsolidatedFactsBySource', 'findBulkFactDays', 'maxFenceRowNum', 'readFenceRowOccupant', 'listStoredFenceFactRows', 'countWorldFacts',
  // lane 4 facts-cycle sites (item 4.2)
  'listPhantomFactRows', 'listCanonicalFenceRowNums', 'moveFactToPage', 'repointInboundLinks', 'repointOutboundLinks', 'pageHasTimelineEntries',
  'maxFenceRowNumOfPage', 'listRootPageSlugsAfter', 'listOwnLinkIds', 'listActiveFactIdsOfPage', 'listFactIdsStillOnPage', 'listLinkIdsOnPage',
  'readPageFileOrigin', 'listFenceRowClaims', 'adoptFactIntoFence', 'listFenceRowSupersession', 'setFactSupersededBy', 'listHeldWideningFactIds',
  'expireFactInPlace', 'expireAndDetachFact', 'updateFenceFactCells', 'listExpirableFactIdsOfDeletedPage', 'readDeletedPageBody', 'expireFactsByIds',
  'listOntologyObservationSlugs', 'listDeletedPageSlugsWithActiveFacts', 'scanUnfencedFactRows', 'listHeldFactRows', 'listFencedFactsOfMissingPages',
  'readFenceRowNumHint', 'readSourceCheckoutPath', 'readLiveStoredBody', 'listPageStates', 'countSegmentedVersionsOfPage',
  'countFactFingerprintLeftovers', 'loadPurgeTarget', 'planFactPurgeIds', 'listFactsReconcileBacklog', 'settleFactsReconcile', 'lockReconcileRevision', 'selectFactsReconcileDrain', 'listRelinkCandidateRows',
  'countRelinkCandidates', 'listSimilarActiveFacts', 'findActiveSingleFact', 'listSingleFactMetadata', 'listUnfencedFactRows',
  'listHeldFenceFactRows', 'listWithdrawalSlugs', 'expireFactsByWithdrawal', 'insertFactPurge', 'upsertPagePurges', 'loopFactDrift', 'closedLoopWithActiveFact',
  'expireFactsOfGonePages', 'readPurgeSourceLocalPath', 'listGitEffectsCarryingReason', 'listPageGitEffectsForStrip',
  'setPurgeEffectData', 'listPageChangeReasons', 'listRequestsRecordingReasons', 'heldEntityPageDeleted', 'readHeldAccessState',
  'heldTargetPageLive', 'listHeldMoveRows', 'listStruckHeldRows', 'readHeldRowVisibility', 'heldMoveDue', 'readHeldConfigValue',
  'readHeldPageLocation', 'readHeldVersionsEdited', 'listSegmentedPageBodies', 'listSegmentedVersionBodies', 'setPurgeProbeTimeout',
  'probePurgeDerivations', 'listBeliefEventsForPurgeProbe', 'listFactContextsForPurgeProbe', 'listPageSourcePathsForPurge',
  'listNearestFactsForPurge', 'countLegacyDerivedPages', 'vacuumPurgedTables', 'listPageProseHits', 'readPurgeReceiptSourcePath',
  'countPagePurgeTombstones', 'readDeletePageRequest', 'listPurgeEffects', 'countPurgeFingerprintResidue',
  'listStagingPartEdges', 'listStagingsHoldingClaim', 'purgeSubjectPageLive', 'listPurgePagesById', 'countPurgeVersionsCarryingClaim',
  'countPurgeReviewRows', 'listPurgeStreamSlugs', 'findPurgeBlockedPublication', 'listPagesForPurgeRewrite', 'updatePageBodyForPurge',
  'setPurgeVersionBody', 'redactVersionChangeReasons', 'listSegmentedVersionsForPurge', 'abortPurgedStagings', 'deletePurgedStagingParts',
  'deletePageViewDigests', 'deleteUnreferencedPurgedTexts', 'listPurgeMatchCandidates', 'lockPurgeSource', 'insertHoldingPagePurges',
  'insertTakePurge', 'deletePurgedTakes', 'deletePurgeReviewQueue', 'deletePurgeReviewProposals', 'deletePurgeDecideProposals',
  'deletePurgeTrustProposals', 'deletePurgeOpenLoops', 'deletePurgeWriteGateHolds', 'deletePurgeWriteGateReceipts', 'deletePurgeTakeProposals',
  'blankPurgeCoreEditNotices', 'deletePurgedFacts', 'deletePurgedChunks', 'listPurgedPageRevisions', 'insertPurgeEffects',
  'listSessionFactsForClassification', 'listSessionFactTwins', 'listCapturedFactsForClassification', 'countLabelFacts',
  // conversation-labels preview reads (engine-sql/label-repair-reads.ts; test/engine-parity/repair-takes-timeline.test.ts)
  'listLabelFactCandidates', 'listSegmentedLabelPages', 'hasActiveAuditMarker',
  // redacted-facts and the conversation-labels retirement (engine-sql/fact-text-repair.ts; test/engine-parity/repair-history-kinds.test.ts)
  'listRedactedFactCandidates', 'restoreRedactedFactTexts', 'listProjectedFenceRows', 'listUnexpiredFactIds', 'lockFactRows',
  'expireFactWithNote', 'expirePageFactsBySource', 'readMaxFactRowNum',
  'listExtractorFactsForClassification', 'listClosedConsolidationTies', 'listPagelessEntityFacts', 'listOntologyFactCandidates', 'listDuplicateFactRows', 'listFactsOnValidDay', 'readLivePageByPath', 'listPurgedPageFactCandidates', 'listFactsHomeCandidates', 'listHeldHomeRows', 'listOrphanedFenceRows', 'readFactSnapshots', 'listConceptLineageRows', 'listConceptInputRows', 'listNamedVisibilityRows', 'countPurgedPageFacts', 'listUnwithdrawnFacts', 'listWorldFactsFromPrivateSources', 'listFactsForRelevance',
  'countUncomparableFacts', 'matchSavedFacts', 'readFactForOwnerAction', 'listStandingPreferences', 'listLexicalContestCandidates', 'listFactsFromQuotedPages',
  'listOwnerTierFacts', 'listRestatedPrivateCopies', 'countDerivedFactTaint',
  // Fact purge plan, dry run and --match reads (engine-sql/facts-purge-plan.ts; covered by test/engine-parity/purge-plan.test.ts)
  'listRequestsCarryingClaim', 'listRequestsHoldingStagings', 'countPurgeProbe', 'listPurgeProbeItems',
  // Repair, doctor and write-path statements (engine-sql/facts-repair.ts, facts-doctor.ts, facts-trust.ts; test/engine-parity/facts-repair-sites.test.ts)
  'listActiveSourceIds', 'readRepairBrainId', 'listAgentSessionTakeCandidates', 'listSettledSessionFacts', 'reattributeSessionFacts', 'retireSessionTakes', 'listFenceRewriteRows', 'listOtherAttributedFactIds', 'listInactiveTakeIds', 'expireCapturedFacts', 'listExpiredFactIds', 'readEntityRehomeState', 'rehomeEntityFacts', 'countSegmentedCensusPages', 'listFactsPageBodies', 'readFactTableCatalog', 'readFactEntitySlugById', 'readSupersessionReplacement', 'linkSupersededFact', 'listLivePageTitles', 'listPageAliasNames', 'listCaptureDuplicateCandidates', 'computeFactFingerprints', 'listClaimConflictPairs', 'countClaimConflictPairs', 'listUnarchivedSourceRows', 'listPagelessEntityFacts', 'listSourceIncarnations',
  // Facts write-path and recall-pool statements (engine-sql/facts-trust.ts, facts-recall.ts; test/engine-parity/facts-rest-sites.test.ts)
  'readPendingWriteReceipt', 'lockSourceShared', 'listOversizedStaleFacts', 'listLivePersonTitles', 'readLiveFactEntityPage', 'lockAgentWritebackSetting', 'listFactsToRetireFromPage', 'listContestedProposalPairs', 'listFactProvenance', 'recordDerivationEdges', 'listDerivedRows', 'expireDerivedFacts', 'deactivateDerivedTakes', 'softDeleteDerivedPages', 'markNeedsRederive', 'readMemberPageWithdrawal', 'readFactVisibility', 'readReplacementTarget', 'readPairFactRow', 'expireSupersededFact', 'restoreSupersededFact', 'readFactForForget', 'expireFactSuperseded', 'expireFactAtDate', 'readWithdrawalAnchor', 'readFactActivity', 'readReviewAcceptedMark', 'readFactsFtsIndexState', 'swapFactsFtsIndex',
  'readFactsEmbeddingColumn', 'listNearestFacts', 'listSlotRows', 'listPoolUnbackedKeys', 'listCallOffCueFacts', 'listPoolEntityPairs', 'listFactRowsByIds',
  // Trust tier reads (engine-sql/trust-tier-reads.ts; covered by test/engine-parity/trust-tier-reads.test.ts)
  'listCorePageRows', 'listTrustScanRows', 'countUnscannedTrustRows', 'readBeliefHistoryRows', 'listVisibleBeliefLifetimes',
  'listVersionTrustTiers', 'listVersionReasonWriters', 'listPageRefsByIds', 'listPageTrustTiersByKey', 'lockLivePagesByKey', 'listValidTimeIdentities', 'pickValidTimeEdition', 'listAmendmentsNotApplied',
  'readPageVersionEdition', 'readCursorEdition', 'pageAwaitsRederive',
  // Memory mutation reads (engine-sql/memory-mutation-reads.ts; covered by test/engine-parity/memory-mutation-reads.test.ts)
  'readSourceWriteRow', 'readSourceLocalPath', 'readFactEntitySlug', 'hasLiveFileBackedPage', 'factReadableUnder', 'readRemoteForgetTier', 'readForgetTarget',
  'isFactEntityUnbacked', 'readLinkedFactCopies', 'hasHiddenFactCopy', 'ownerReachesFact', 'readFactWithdrawalClaim',
  // Withdrawal discovery reads (engine-sql/withdrawal-discovery.ts; covered by test/engine-parity/withdrawal-discovery-reads.test.ts)
  'readWithdrawalDiscovery',
  // Withdrawal page statements (engine-sql/withdrawal-pages.ts; covered by test/engine-parity/withdrawal-forget.test.ts)
  'listSegmentedPages', 'invalidateWithdrawnPages',
  // Withdrawal fence check (engine-sql/withdrawal-fence.ts; covered by test/engine-parity/withdrawal-fence.test.ts)
  'hasWithdrawnFenceClaim',
  // Conversation fact publication and relink statements (engine-sql/facts-conversation.ts; covered by test/engine-parity/facts-conversation-sites.test.ts)
  'readNewestConversationFactId', 'findSpentConversationRequest', 'listConversationBatchRequests', 'readStoredConversationEntry',
  'readPrincipalCounters', 'countConversationPagesToExtract', 'listMergedEntityAliases', 'moveConversationSourceWindows',
  'stampConversationSourceWindows', 'countActiveConversationFacts', 'readConversationSlotValueHash', 'deleteConversationOutcomeRows',
  'listPurgeTombstoneMatches', 'maxConversationRowNum', 'listHeldFactSlots', 'countPageConversationFacts', 'countConversationWindowFacts',
  'countConversationFactsOutsideWindows', 'clearConversationPageFacts', 'findSameClaimFenceRow', 'findOntologyTwin', 'readRelinkSource',
  'factRelinkAttemptsTableExists', 'readReextractOutcomeRow', 'listUnbackedConversationRows', 'listUnlinkedConversationRows', 'listEntityHintPages',
  'lockPageById', 'listClearedRelinkedFacts', 'countEmbeddedFactsAmong',
  // Derivation trust (engine-sql/derivation-trust.ts; covered by test/engine-parity/generation-write-parity.test.ts)
  'lowerTrustTier', 'countDerivedRowTaint', 'stampPageFrontmatter',
  // Timeline site reads (engine-sql/timeline-reads.ts)
  'sampleEffectiveDates', 'sampleEffectiveDateSources', 'readMaxTimelineEntryId', 'listStoredTimelineRowsOrdered',
  'deleteTimelineRows', 'storedTimelineRowsByPageIds', 'countSegmentedTimelinePages', 'countTimelineCommentMarkupRows',
  'listTimelineOrphanPages',
  // Timeline repair reads (engine-sql/timeline-repair-reads.ts; test/engine-parity/repair-takes-timeline.test.ts)
  'listTimelineHistoryPages', 'listTimelineVersionWitnesses', 'readTimelineVersionBody', 'listTimelineMarkupRows',
  'listMaterializedMarkerPages', 'rewriteTimelineRow', 'listDateBulletPages', 'listConnectorFencePages',
  // Search telemetry, MCP usage and the chat usage ledger (engine-sql/telemetry.ts, engine-sql/chat-usage.ts; covered by
  // test/engine-parity/telemetry.test.ts)
  'recordSearchTelemetry', 'readSearchStats', 'readClientOpUsage', 'readMcpRollupPrunedBefore',
  'logMcpRequest', 'readMcpLogPruneCutoff', 'pruneMcpRequestLogBatch', 'readMcpLifetimeUsage',
  'logChatUsage', 'readChatUsage',
  // schema detect --fields page samples (engine-sql/field-usage.ts; covered by test/engine-parity/field-usage.test.ts)
  'readFieldUsageSamples',
  // Alias fan-out reads (engine-sql/alias-fanout-reads.ts; covered by test/engine-parity/alias-fanout-reads.test.ts)
  'findPagesByTitles', 'resolveCaseSensitiveAliases', 'readPageTitle', 'readPageAliasRows', 'readEntityAliasRows', 'listSlugAliases',
  // Import writes (engine-sql/chunks.ts, tags.ts, pages.ts)
  'deleteChunksExcept', 'setChunkerVersion', 'writeTextProjectionSeal', 'moveChunkIndexes', 'getChunkReuseRows', 'pruneFrontmatterTags',
  'addPageTagsById', 'replaceDerivedAliases', 'getPageSealState', 'refreshPageOrigin',
  // Page write guards (engine-sql/write-guards.ts).
  'readPageOrigin', 'listOriginClaims', 'bindPageOrigin', 'stampPageIngest', 'sealImportedPage', 'readLivePageBody', 'readPageIndexingState', 'hasSegmentStorage',
  'readInlinePageRegions', 'readStoredPageTier',
  // Page visibility guards of a remote page write (engine-sql/page-visibility.ts).
  'readPageHiddenFromCaller', 'readCallerPageAccess', 'readWriteVisibilityProbe', 'readWriterSlugFence',
  // The remote links effect and a finished batch's re-arm (engine-sql/remote-links.ts).
  'setEffectTransactionLimits', 'readOwnedLinks', 'deleteOwnedLinks', 'readLinkTargetPages', 'rearmLinksEffects',
  // The facts backstop effect's extraction reads (engine-sql/facts-backstop.ts).
  'hasPendingFactsExtraction', 'hasCompletedFactsExtraction',
  // The large-page write guard's stored body size read (engine-sql/large-page.ts).
  'readStoredBodyBytes',
  'readPageBodySizes',
  // The relational recall arm's page reads (engine-sql/relational-reads.ts).
  'readAdmittedPageRefs',
  'readPageSynopses',
  'readSeedTitleSlugs',
  // The entity resolver's page reads (engine-sql/entity-reads.ts, entities/resolve.ts).
  'readLiveSlugs', 'readLivePageTypes', 'readTrigramCandidates', 'readPrefixCandidates', 'readPrefixDirs', 'readPrefixTitleMatches', 'readNamedEntitySlugs',
  // The source purge epoch read (engine-sql/sync-reason-reads.ts) and the job principal read (engine-sql/access-control.ts).
  'readSourcePurgeEpoch', 'readJobPrincipal',
  // The fence guard's reads of a page's fact rows (engine-sql/facts.ts, engine-sql/trust-fence.ts).
  'listFenceRetireCandidates', 'listFenceFactRows', 'restorePageTrust', 'listHeldRows', 'listGuardedTakeRows',
  // The fact rows adapter's before-state read and restore (engine-sql/facts.ts) and its consolidation ledger reads
  // (engine-sql/derived-generations.ts).
  'readFactPreimages', 'restoreFactPreimage', 'listFactIdsBySourcePrefix', 'expireFactRows', 'readGenerationRestored', 'clearTieHeldGenerationRows',
  // The trust decision queue (engine-sql/trust-proposals.ts).
  'insertTrustProposal', 'getTrustProposal', 'listTrustProposals', 'pendingTrustProposalsFor', 'updatePendingTrustProposalAfter',
  'transitionTrustProposal',
  // The connect gate's persistence reads (engine-sql/connect-gate.ts).
  'hasPersistenceTable', 'listManagedRootBindings', 'readGraduationGateRow', 'listRetiredDeactivations',
  // Group A (decide store)
  'readDecideState', 'upsertDecideState', 'deleteDecideState', 'ensureDecideState',
  'insertDecideSpend', 'dailyDecideSpend', 'listDecideSpendBySlot',
  'insertDecideReceipts', 'pruneDecideReceipts', 'listDecideReceiptStats', 'decideSlotUsage', 'decideConflictNoEntityCounts',
  'listDecideReplayReceipts', 'listDecideResolvedModels', 'listDecideMixedModelDecisions',
  'insertDecideCalibration', 'storeDecideQualification', 'listDecideCalibrations', 'getDecideCalibration', 'setDecideCalibrationRetired',
  // Search
  'searchKeyword', 'countKeywordPages', 'searchKeywordPages', 'searchTitles', 'searchVector', 'getEmbeddingsByChunkIds',
  // Chunks
  'upsertChunks', 'sealChunks', 'getChunks', 'getChunkPage', 'getChunkWindows', 'countStaleChunks', 'sumStaleChunkChars', 'setPageEmbeddingSignature',
  'invalidateStaleSignatureEmbeddings', 'invalidateContentDriftEmbeddings', 'listStaleChunks',
  // The page embedding ledger (engine-sql/page-embedding-budget.ts).
  'readPageEmbeddingBudget', 'recordPageEmbeddingHold', 'openPageEmbeddingHold', 'reservePageEmbedding', 'settlePageEmbeddingReservation',
  // The embedding effect's install path (engine-sql/embedding-install.ts).
  'readEmbeddingCompletion', 'lockEffectClaimRow', 'lockEmbeddingSwitch', 'installChunkEmbeddings',
  'countChunklessPagesWithContent', 'listChunklessPagesWithContent', 'readEmbeddingStateCounts', 'listEmbeddingStateRows', 'deleteChunks',
  // Extraction watermark
  'countStalePagesForExtraction', 'listStalePagesForExtraction', 'markPagesExtractedBatch', 'markPagesAttendanceBlocked',
  // #6454 stale reserved frontmatter keys
  'countStaleFrontmatterKeyPages', 'listStaleFrontmatterKeyPages', 'stripStaleFrontmatterKeys',
  // Links + graph
  'addLink', 'addLinksBatch', 'replaceDerivedLinks', 'replaceDerivedLinksBatch', 'removeLink', 'getLinks', 'getBacklinks', 'listLinkSources',
  'findByTitleFuzzy', 'traverseGraph', 'traversePaths', 'traversePathsDetailed', 'relationalFanout', 'relationalChainHop', 'getBacklinkCounts',
  'getAdjacencyBoosts', 'getContentFlagsByPageIds', 'getUnverifiedExtractionPageIds',
  'getPageTimestamps', 'getEffectiveDates', 'getSalienceScores', 'findOrphanPages',
  // Tags
  'addTag', 'removeTag', 'getTags',
  // Timeline + chronicle
  'addTimelineEntry', 'addTimelineEntriesBatch', 'getTimeline', 'getTimelineForDate', 'getSince',
  'getOnThisDay', 'getLastSeen', 'upsertEventProjection', 'removeTimelineRows', 'updateTimelineDetails', 'insertCanonicalTimelineRows',
  // Ontology
  'mergeOntologyFact', 'getOntology', 'discoverOntologyDimensions', 'findOntologyConflicts',
  // Raw data + files
  'putRawData', 'getRawData', 'upsertFile', 'getFile', 'listFilesForPage',
  // files commands and file operations (engine-sql/files-ops.ts)
  'hasFileWithHash', 'listFileRowsForVerify',
  'readSourceLocalPathForVerify', 'upsertCliFileRow', 'upsertRawFileRow', 'upsertSyncFileRow',
  'sourceIdExists', 'readPageIdInSource', 'readFileOwner', 'claimFilePage',
  'upsertOpFileRow', 'listReadableFileRows', 'readReadableFileForUrl', 'readReadablePageId',
  'countUnreadableFilesAt', 'countFilesRegisteredElsewhere', 'registerFileRow', 'readReadableFileForVerify',
  'listReadableFilePaths', 'listFiles',
  // contradictions, ontology re-key/repair and admin statements (engine-sql/contradictions-cycle.ts, ontology-repair.ts, admin-reads.ts)
  'listEdgeContradictionCandidates', 'listKnownEdgeProposals', 'listLinkContexts', 'recordEdgeProposal',
  'readEdgeProposal', 'edgeClosureLanded', 'readEdgeProposalEvidence', 'readEdgeProposalHash',
  'markEdgeProposalStale', 'setEdgeProposalStatus', 'rejectOpenEdgeProposal', 'markEdgeProposalUndone',
  'markRevertedEdgeProposals', 'listLiveChunksByIds', 'listLiveTakesByIds', 'readLastContradictionsPromptVersion',
  'listEvalCandidateQueries', 'listRekeyLosers', 'repointSupersededToKept', 'clearOntologySlots',
  'deleteRekeyLosers', 'restoreOntologyFact',
  'listVisiblePageSlugs', 'readPagesForVersionHistory',
  // Takes
  'addTakesBatch', 'listTakes', 'searchTakes', 'searchTakesVector', 'getTakeEmbeddings',
  'countStaleTakes', 'listStaleTakes', 'updateTake', 'supersedeTake', 'resolveTake',
  'getScorecard', 'getCalibrationCurve', 'addSynthesisEvidence', 'matchTakeRows', 'deleteTakeRows',
  // Dream verdicts (sweepDreamVerdicts: wave-k #4069 TTL housekeeping,
  // covered by test/dream-verdict-cache-ttl.test.ts)
  'getDreamVerdict', 'putDreamVerdict', 'sweepDreamVerdicts',
  // Dream cycle statements (engine-sql/dream-cycle.ts; pinned by test/engine-parity/dream-cycle-sites.test.ts)
  'listDreamQueueCandidates', 'listLiveDreamCycleLocks', 'readDreamJobStatus', 'ensureDreamMapConfigRow',
  'lockDreamMapConfigRow', 'writeDreamMapConfigRow', 'recordDreamBreakerReset', 'stampDreamPageProvenance',
  'listDreamPageIds', 'countDreamProvenancePages', 'readDreamDeferralReceipt', 'listConsolidationClaimValues',
  'setConsolidatedFactValidUntil', 'listReadersSourcedFactIds', 'findConsolidationPageIds', 'readConsolidationTakesMaxRowNum',
  'findConsolidatedTakes', 'refreshConsolidatedTakeSource', 'findConsolidatedTakeIds', 'listConsolidationClaimShapes',
  'listRetainedDreamOutputSources', 'readDreamSourceIncarnation', 'listDreamAtomPages', 'listSynthesisPageBodies',
  'listLaterPersistenceRequests', 'listCommittedOutputRequests', 'readDreamVerifyEpoch', 'listDreamJobCreatedAt',
  'readDreamPreRunRevision', 'listCompletedSynthJobs', 'countCoalescibleSynthJobs', 'listWaitingChildJobIds',
  'listDreamChildJobTimings', 'countRecentDreamSynthSubmissions',
  // Contradiction probe
  'listActiveTakesForPages', 'writeContradictionsRun', 'loadContradictionsTrend',
  'getContradictionCacheEntry', 'putContradictionCacheEntry', 'sweepContradictionCache',
  // Facts (hot memory)
  'insertFact', 'insertFacts', 'deleteFactsForPage', 'expireFact', 'listFactsByEntity',
  'listFactsSince', 'listFactsKeyset', 'listFactsBySession', 'listSupersessions', 'countUnconsolidatedFacts',
  'findCandidateDuplicates', 'consolidateFact', 'findTrajectory', 'getFactsHealth',
  // Versions
  'createVersion', 'getVersions', 'revertToVersion', 'readLatestVersionId', 'readLatestVersionIdAtTier', 'stampVersionChangeReason', 'pruneHoldingPageVersions',
  // Stats + health + ingest log
  'getStats', 'getHealth', 'logIngest', 'getIngestLog',
  // Sync + aliases + narrow updates
  'updateSlug', 'rewriteLinks', 'resolveSlugWithAlias', 'resolveSlugWithAliasDetailed', 'resolveAliases', 'setPageAliases',
  'refreshPageBody', 'updatePageContextualRetrievalState', 'migrateFactsToCanonical',
  // Config + migration + raw SQL
  'getConfig', 'setConfig', 'unsetConfig', 'listConfigKeys', 'runMigration',
  'getChunksWithEmbeddings', 'executeRaw', 'executeRawDirect', 'keywordBoundedRead',
  // v0.46.28-34 master waves (classified at the test-gap-wave merge):
  // #3980 bulk config read, #3776 takes-embedding update, #3674 scoped
  // link removal.
  'getAllConfig', 'getConfigValues', 'readManagedModeRows', 'getSourceStrictness', 'readPersistenceBrainId', 'declarePersistence', 'requireSynchronousCommit', 'readLocalWriterRow', 'insertLocalWriterRow', 'readTransactionSettings', 'applyTransactionSettings', 'readCurrentWriteTrust', 'setWriteContext', 'beginSnapshotRead', 'readLedgerSource', 'isFolderRestricted', 'listCoveredSources', 'readMayActFor', 'readAudiencePrincipals', 'readAccessMembers', 'readAccessCredentials', 'listAudienceAccessMembers', 'readLiveMember', 'listAppliedPolicyRevisions', 'readJournalLimitRows', 'readHeldPageRows', 'readHeldCoverageRows', 'listFenceHoldRows', 'readWriteRequest', 'readWriteRequestById', 'readWriteRequestProgress', 'countOutstandingBySource', 'ownsSchemaTables', 'readCounterRows', 'readAdmissionRate', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'lockWriteRequest', 'completeWriteRow', 'lockWriteRequestsById', 'compactTerminalIntent', 'insertPublicationEffects', 'insertWithdrawalEffects', 'readMentionLastPass', 'countPagesDueForMentions', 'readIdentitySiblingCandidates', 'findExactSlug', 'readExtractionLagCounts', 'readIgnoredPrivacyLabelPages', 'updateTakeEmbeddings', 'removeLinksByPagesAndSource',
    'readWorktreeAdmission', 'completeSyncedRefresh', 'hasDeferralRoom', 'readRefreshTiming', 'countHeldBehindImport', 'readStoredConfigValue',
    'listGenerationSourceIncarnations', 'readChronicleDepthRow', 'listChronicleOwnedHashes', 'listRetiredGenerationItemKeys', 'listEventProjectionRows',
    'listPageContentHashes', 'listLiveGenerationItems', 'hasChronicleSkipDecision', 'readEventProjectionId', 'pageSlugExists', 'deleteEventProjections',
    'restoreEventProjection', 'listOrphanedChronicleOwners', 'listChronicleEventSlotRows',
  'readOAuthClientWriteGrant', 'readAccessTokenWriteGrant', 'shareLockWriteCredential',
  'readFolderAccess', 'cancelWriteRow', 'readRetirementHop', 'readEntityCardRows', 'findFuzzyEntityCandidates', 'findExactBasenameCandidates', 'listWriteRequestRows',
  'readAccessStoreConfig', 'writeAccessStoreConfig', 'ensureAccessPolicyState', 'lockAccessPolicy', 'listAccessRules', 'readAccessPolicyRevisions', 'listAccessCoverage', 'readAccessStateUnreadable', 'applyAccessRuleChanges', 'restampAccessWindow', 'finishAccessRestamp', 'insertAccessPolicyRevision', 'markAccessRevisionsApplied', 'approveAccessPolicyRevision', 'hasAccessPolicyState', 'listAccessPrefixSlugs', 'readAccessPolicyMarks', 'replaceAccessInvalidCoverage', 'listUnboundTokenNames', 'listUnboundClientIds', 'readLiveAccessToken', 'listUnarchivedSourceIds', 'recordTokenSetupReads', 'listKeysReadingSource', 'countCompanyPages', 'revokeAccessTokenById', 'readUnfinishedAccessMigration', 'insertAccessMigration', 'recordAccessMigrationPhase', 'switchAccessMigration', 'listAccessPolicySources', 'countPeopleFolderPages', 'readGitHoldRecords', 'readGitHoldRetryRequest', 'readGitHoldReportInputs', 'lockGitHoldSummary', 'adjustGitHoldSummary', 'readGitHoldRow', 'writeGitHoldRow', 'replaceGitHoldRow', 'deleteGitHoldRow', 'countGitHolds', 'readGitHoldListingRows', 'readGitHoldCodeCountRows', 'readGitImageHoldCountRows', 'readSyncConversionRows', 'readSyncPassRow', 'readLiveSyncPassRows', 'writeSyncPassRow', 'readSyncStatusSourceRow', 'readSyncStatusCommittedRow', 'readManagedSyncCursorHeader', 'readRetiredManagedSyncCursor', 'readManagedSyncFailureRows', 'readOrphanedManagedSyncFailureRows', 'readSyncHeadRequestRow', 'readSyncRecoveryProbeRow', 'readIdentityDowngradeRows', 'readWriteWatermarkRow', 'readSourceCheckoutRoot', 'readUnembeddedPageSummary',
  'readFenceOriginGone', 'lockGenerationKey', 'clearFenceHoldRows', 'readFenceHoldFiles', 'readLiveGenerationRow', 'activateGenerationRows', 'recordHeldGenerationRow', 'heldGenerationRowsForInput', 'readHeldGenerationContext', 'liveGenerationForOperation', 'countGenerationAttempt', 'clearGenerationAttempts', 'readGenerationValve', 'bumpGenerationValve', 'scrubGenerationPageRows', 'scrubGenerationTextRows', 'recordGenerationActivation', 'markGenerationActivated', 'readGenerationActivationState', 'settleGenerationMember', 'listPendingGenerationMembers', 'listGenerationOrphanCandidates', 'readGenerationItemsByIds', 'listUnmatchedGenerationRows', 'listRestorableGenerationRows', 'listHeldGenerationRows', 'readHeldGenerationProposal', 'listRecordedFenceItemKeys', 'hasBodylessPageVersion', 'listFenceVersionBodies', 'moveKeptFactRows', 'readGenerationFenceBlocks', 'listOwnedGenerationItems', 'readLiveGenerationId', 'readGenerationPageRows', 'readAtomOriginInput', 'listProducerVersionRows', 'listAtomWriteReceipts',
  // The write journal's claim upkeep, admission reads and housekeeping (engine-sql/persistence-claims.ts, persistence-housekeeping.ts).
  'readSourceMembership', 'findTopologyChanges', 'renewWriteClaim', 'releaseUnpublishedClaim', 'expireStaleWriteClaims', 'hasClaimableWrite', 'selectClaimableWrite', 'listHostConsumerRows', 'probeLiveConsumerRows',
  'renewConsumerRow', 'deleteConsumerRow', 'stampWorktreeHeartbeats', 'readTopologyChange', 'insertTopologyChange', 'claimHousekeepingTurn',
  'completeHousekeepingTurn', 'readReceiptBudget', 'listCompactableReceipts', 'readReceiptCompactionWindow', 'listReceiptCompactionCandidates', 'countKeptFailedReceipts', 'listReservationsAfter', 'listTrueUpRequests', 'listWriteRequestsByRequestIds', 'trueUpReservations', 'readCapacityForecastInputs', 'listPendingSegmentedProjections', 'selectProjectionWindowJobs',
  'claimSegmentedProjection', 'renewSegmentedProjectionClaim', 'releaseSegmentedProjectionClaim', 'deleteProjectionJob', 'markProjectionRebuildFailed',
  'readWriterVersionCutoff', 'listWriterVersions', 'recentWriterVersions',
  // A page projection rebuild's queue listing, job reason, keep plan and drained probe, the deferred chunk
  // replacement's step, the rebuild loop's queue stamps and the re-seal's pending count (engine-sql/projection-rebuild.ts).
  'listQueuedPageProjections', 'readProjectionJobReason', 'readChunkKeepState', 'clearUnkeptChunkVectors',
  'setProjectionChunkerVersion', 'hasDrainableProjectionJob', 'readChunkRowsFingerprint', 'deleteUnkeptChunks',
  'listStaleChunkVectors', 'clearChunkVectors', 'readProjectionHead', 'isDeferredReplacementHeld',
  'renewDeferredReplacementClaim', 'releaseDeferredReplacementClaim', 'hasSegmentedPage', 'rekeyProjectionJob', 'stampDeferredProjectionJob',
  'touchUnclaimedProjectionJob', 'deferProjectionJob', 'countPendingTextChunks', 'probeProjectionWindowCandidates',
  'readWriteRequestsByRequestIds', 'insertWriteRequestGroup', 'readOwnerHostBinding', 'listTopologyRecoveries', 'readSegmentedGateEvidence',
  'claimNotifierLease', 'readNotifierLease', 'holdsNotifierLease', 'releaseNotifierLease', 'readNotifierSources', 'writeNotifierState', 'writeNotifierCoverage', 'recordNotifierSyncerHost', 'readNotifierStatusRows', 'hasNotifierCoverage', 'upsertWantedMarker', 'attachWantedMarkerJob', 'readWantedMarkers', 'readDueWantedMarkers', 'pruneSatisfiedWantedMarkers', 'clearWantedMarker', 'settleFreshnessMarker', 'listSourceWantedMarkers', 'readFirstDue',
  // The effect worker's recovery scans (engine-sql/persistence-effect-scans.ts).
  'listGatedMirrorRequests', 'listEffectRecoveries', 'selectClaimableEffect', 'readRequestEffects', 'listEmbeddingCandidates',
  // The write owner's housekeeping scans (engine-sql/persistence-owner-scans.ts).
  'listOverdueHeldWrites', 'lockOverdueHold', 'listOwnerRecoveryHeads', 'listResumableRefreshes', 'listSourceLastCommits',
  // The effect worker's claim, settle and gate statements (engine-sql/persistence-effect-worker.ts).
  'stampEffectClaim', 'renewEffectClaim', 'advanceEffectRow', 'completeEffectRow', 'retryEffectRow', 'retryBusyEffectRow', 'requeueEffectRow', 'parkEffectRow', 'failEffectRow', 'readMirrorGateRows', 'lockEffectGuard', 'hasRearmableTargets', 'probeIdleWork',
  // The no-op embedding settle statements (engine-sql/persistence-embedding-noop-settle.ts).
  'probeNoopEmbeddingSettle', 'lockNoopEmbeddingWindow', 'readNoopEmbeddingCandidates', 'settleNoopEmbeddingRows',
  // The page-write reads and upkeep that belong to no other domain (engine-sql/write-misc.ts).
  'readSourceState', 'readAdmissionSource', 'sharedSkillPackTablePresent', 'listSharedSkillPackRoots', 'getWorktreeBinding', 'isSourceClaimed', 'hasExtractedEvents', 'listActiveAccessMembers', 'listAccessTokens', 'hasLabelledOnlyMember', 'expireMemoryProposals', 'listAwaitingMemoryProposals', 'purgeMemoryProposals', 'attachSourcePath', 'readMemoryProposal', 'readPendingProposalSummary', 'listMemoryProposalRows', 'listOwnerProposalRows',
  'worktreeClaimStore', 'readWriterAdminState', 'writerAdminStore',
  // Code edges
  'addCodeEdges', 'deleteCodeEdgesForChunks', 'getCallersOf', 'getCalleesOf', 'getEdgesByChunk',
  'getCodeTraversalCache', 'putCodeTraversalCache', 'clearCodeTraversalCache',
  'searchKeywordChunks',
  // Eval capture
  'logEvalCandidate', 'listEvalCandidates', 'deleteEvalCandidatesBefore', 'logEvalCaptureFailure',
  'listEvalCaptureFailures',
  // Salience + anomaly + enrich
  'batchLoadEmotionalInputs', 'setEmotionalWeightBatch', 'getRecentSalience', 'listEnrichCandidates',
  'findAnomalies',
  // Wave B segmented page bodies (src/core/engine-sql/page-body.ts; covered by test/large-pages/ and test/engine-sql-page-body.test.ts)
  'allocateBodyOccurrenceIds', 'stageSegmentTexts', 'readSegmentTexts', 'stageManifestRows', 'readManifest', 'readSegmentedEmbedPage', 'stageSegmentChunks',
  'createSegmentedPageShell', 'flipBodyGeneration', 'sealSegmentedPage', 'openBodyStaging', 'setBodyStagingState', 'sweepSegments',
  // Wave B PR 4 per-segment derivation rows (same SQL module; covered by test/engine-sql-segment-derivations.test.ts and its Postgres arm)
  'readSegmentDerivations', 'upsertSegmentDerivations', 'retireSegmentDerivations',
  // Belief ledger writes (engine-sql/belief-ledger.ts)
  'readLatestBeliefCoverage', 'hasBeliefBaseline', 'listBeliefBaselinePending', 'countBeliefBaselineSlugs',
  'readBeliefTombstones', 'readBeliefRedactions', 'insertBeliefRedaction', 'releaseBeliefRedactions', 'insertBeliefEvents',
  'markBeliefCommits', 'readOpenBeliefLifetimes', 'endBeliefLifetime', 'mintBeliefLifetime', 'renameBeliefLifetime', 'readMovedBeliefLifetimes',
  // Belief ledger state reads (engine-sql/belief-state.ts)
  'readBeliefStateRows', 'readBeliefFactsById',
  // The belief side of a purge (engine-sql/belief-purge.ts)
  'bumpSourcePurgeEpoch', 'hasBeliefEvents', 'registerPurgeRedaction', 'releasePurgeRedactionsForField', 'replayPagePurges', 'readPurgeReplaySchema',
  // Trust: the fact withdrawal ledger (engine-sql/trust-withdrawals.ts)
  'hasCoveringFactWithdrawal', 'insertFactWithdrawal', 'isFactWithdrawn', 'isFactPurged', 'listFactWithdrawalDates', 'moveFactWithdrawalSubject',
  'hasFactWithdrawalForSubject', 'listFactWithdrawalKeys', 'readFactCacheWatermark', 'readTrustGeneration', 'readSourcePurgeFlags', 'listPurgedTakeRows',
  // Trust: the forget commit and the fact_withdrawn refusal (same SQL module; covered by test/engine-parity/forget-commit.test.ts)
  'lockFactForWithdrawal', 'queueWithdrawalReview', 'listSegmentedPagesBySlug', 'bumpWithdrawnPageRevisions', 'readPageRevisions', 'appendFactForgetReason', 'readFactWithdrawnRow', 'readFactWithdrawnBacking',
  // Trust: the write gate's receipts and holds (engine-sql/trust-write-gate.ts)
  'upsertWriteGateReceipt', 'upsertPageWriteGateReceipt', 'deleteStalePageWriteGateReceipts', 'listWriteGateReceiptsFor',
  'deleteStaleWriteGateReceipts', 'upsertWriteGateHold', 'listWriteGateHoldRows', 'getWriteGateHoldRow', 'decideWriteGateHold',
  // Open loops (engine-sql/open-loops.ts)
  'upsertOpenLoop', 'listOpenLoops', 'closeOpenLoop',
  // Loop mutes (engine-sql/loop-mutes.ts; pinned by test/engine-parity/loop-mutes.test.ts)
  'addLoopSuppression', 'removeLoopSuppression', 'listLoopSuppressions', 'listMuteRecheckThreads',
  'closeMutedLoops', 'requeueMutedLoops', 'closeThreadLoops', 'settleMuteRecheck',
  // Source archive (engine-sql/source-archive.ts; pinned by test/engine-parity/source-archive.test.ts)
  'archiveSource', 'restoreArchivedSource', 'listArchivedSourceRows', 'listExpiredArchivedSources',
  'listUnverifiedArchivedSourceIds', 'listSourceOAuthClients',
  // Group C: decide proposals and review proposals (engine-sql/decide-proposals.ts; pinned by test/engine-parity/decide-proposals.test.ts)
  'insertDecideProposal', 'getDecideProposal', 'listDecideProposalIds', 'listDecideProposals', 'transitionDecideProposal',
  'listDecideProposedPairs', 'insertDecideReviewProposal', 'listDecideReviewProposals', 'getDecideReviewProposal',
  'transitionDecideReviewProposal', 'listDecideReviewProposalIds', 'readProposalReviewRates', 'listDueDecideReviewQueue',
  'applyDecideReviewQueue', 'listDueDecideSweepDeferred', 'applyDecideSweepDeferred',
  // Group A (jobs-tables): the Wakeshift report-back tables (engine-sql/jobs-wake.ts)
  'openWakeWatch', 'listWakeWatches', 'endWakeWatches', 'countWakeWatches', 'readWakeDoctor', 'countPendingWakeForgets', 'listWakeCrons',
  'addWakeCron', 'removeWakeCron', 'hasWakeCron', 'recordWakeCronRun', 'hasWakeTermsAcceptance', 'recordWakeTermsAcceptance', 'listDueWakeWatches',
  'claimWakeWatch', 'settleWakeWatch', 'queueWakeForget', 'claimWakeForgets', 'settleWakeForget',
  // GST-3032 owner-only delete triggers (src/core/engine-sql/owner-only-marks.ts; covered by test/owner-only-removal-lineage.test.ts)
  'ownerOnlyMarkTriggers',
  'readEntityOpenLoops', 'linkEntityIdentityRow', 'unlinkEntityIdentityRow', 'listEntityIdentityRows', 'readEntityIdentityIdsForPages', 'readCanonicalTwin', 'listPendingContradictions', 'listTrustAllowRuleRows', 'bumpPageRetrievals',
  'purgeStaleCheckpoints',
];

/**
 * Non-interface prototype members that are legitimate engine internals
 * (helpers/getters shared across the peeled engine modules). Names starting
 * with `_` are treated as private implicitly and need no entry here. Adding
 * a new PUBLIC helper requires a row here — a visible review event, same as
 * a new interface method.
 */
const ENGINE_INTERNAL_HELPERS: readonly string[] = [
  'db',
  'connectForRestore',
  // Write attribution: the unscoped engine-sql executor the get_write_attribution reads run through.
  'attributionReads',
  'applyForwardReferenceBootstrap',
  'getBulkRetryOpts',
  'batchRetry',
  'activeEmbeddingColId',
  'codeEdgesDeps',
  // group 5 facts sites: per-call transaction executor getter for the facts relevance reads (engine-sql/facts-trust.ts).
  'rawTransaction',
  // refactor wave 1 C9: per-call engine-sql executor getter (EO1).
  'engineSql',
  // Cycle-lock leases: the engine-sql executor the lease statements run through (the methods themselves are in INTERFACE_METHODS).
  'cycleLockSql',
  // Hybrid search reads: the unscoped engine-sql executor the search-read methods run through.
  'searchRead',
  // Graph and doctor link reads: the unscoped engine-sql executor the link-read methods run through.
  'linkRead',
  // Link temporal state, search-vector and retrieval-coverage members: the unscoped engine-sql executor they run through.
  'linkTemporal',
  // Code, doctor, withdrawal, repair and evidence chunk reads: the unscoped engine-sql executor they run through.
  'chunkRead',
  // Timeline site reads: the unscoped engine-sql executor they run through.
  'timelineRead',
  // Search telemetry and MCP usage reads: the unscoped engine-sql executor they run through.
  'telemetryRead',
  // Alias fan-out reads: the unscoped engine-sql executor they run through.
  'aliasFanoutRead',
  // Entity identity reads: the unscoped engine-sql executor they run through.
  'entityIdentityRead',
  // CLI reads: the executors the CLI read members run through (PGLite rawRead wraps executeRaw; cliReads is the unscoped engine-sql executor).
  'rawRead',
  'cliReads',
  // Entity reads: the PGLite executeRaw view the two timed entity reads run through.
  'untimedRead',
  // Engine graduation: PGLite close/open that keeps the kernel lock across the custody window.
  'closeRetainingLock',
  'connectWithHeldLock',
  // #9227: whether this engine holds the datastore lock; the PGLite abandoned-claim release rests on it.
  'holdsDatastoreLock',
  // The unscoped executor the write-misc members run through (engine-sql/write-misc.ts).
  'writeMiscReads', 'attributionReads',
  // The unscoped executor the bookkeeping repair reads run through (engine-sql/repair-bookkeeping.ts).
  'repairBookkeepingReads',
];

/**
 * SHRINK-ONLY allowlist: interface methods with zero references anywhere in
 * test/ outside this file (verified mechanically by the corpus-scan test
 * below). Each entry is smoked once in the SMOKES block. Do NOT add an
 * entry without a smoke; REMOVE an entry as soon as real coverage lands
 * elsewhere (the scan test forces both).
 *
 * Zero-production-caller flags (deletion candidates — maintainer decision,
 * per the coverage-plan D9 spec; smoked here regardless):
 *   - getPageTimestamps: @deprecated since v0.29.1 in favor of
 *     getEffectiveDates; ZERO src/ callers outside the two engines.
 *   - getTakeEmbeddings left the list at the master merge: wave-k's #3776
 *     semantic takes retrieval gave it real callers + coverage (the ratchet
 *     shrank, as designed — its smoke below stays as a shape pin).
 *   - listPrefixSampledPages, listCorpusSample and getPageTimestamps left the
 *     list in refactor wave 1 W0: the Postgres SQL-text goldens
 *     (test/helpers/postgres-engine-sql-cases.ts) call them. Their PGLite
 *     smokes stay below, unchanged, as ex-UNCALLED shape pins.
 *   - rewriteLinks left the list when the BrainEngine parity suite
 *     (test/engine-parity/sync-aliases.test.ts) began calling it on every
 *     engine arm. Its PGLite smoke stays below as an ex-UNCALLED shape pin.
 */
const UNCALLED: readonly string[] = [];

function methodNames(): string[] {
  return Object.getOwnPropertyNames(PGLiteEngine.prototype).filter((n) => n !== 'constructor');
}

describe('BrainEngine surface — mechanical enumeration (D9)', () => {
  test('every interface method exists as a function on the PGLite prototype', () => {
    const missing = INTERFACE_METHODS.filter((n) => {
      const d = Object.getOwnPropertyDescriptor(PGLiteEngine.prototype, n);
      return !d || typeof d.value !== 'function';
    });
    expect(missing).toEqual([]);
  });

  test('no unclassified public members on the prototype (new methods must be listed)', () => {
    const unclassified = methodNames().filter(
      (n) =>
        !n.startsWith('_') &&
        !INTERFACE_METHODS.includes(n) &&
        !ENGINE_INTERNAL_HELPERS.includes(n),
    );
    expect(unclassified).toEqual([]);
  });

  test('classification lists carry no stale rows', () => {
    const proto = new Set(methodNames());
    expect(ENGINE_INTERNAL_HELPERS.filter((n) => !proto.has(n))).toEqual([]);
    // UNCALLED must stay a subset of the interface.
    expect(UNCALLED.filter((n) => !INTERFACE_METHODS.includes(n))).toEqual([]);
    // No duplicates in the checked-in lists.
    expect(new Set(INTERFACE_METHODS).size).toBe(INTERFACE_METHODS.length);
    expect(new Set(UNCALLED).size).toBe(UNCALLED.length);
  });

  test('UNCALLED equals the set of methods with zero references in the rest of test/ (shrink-only)', () => {
    const testRoot = import.meta.dir; // <repo>/test
    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && p !== import.meta.path) files.push(p);
      }
    })(testRoot);
    // Fail closed if the walk ever breaks — an empty corpus would classify
    // EVERYTHING as uncovered (or, inverted, mask a regression).
    expect(files.length).toBeGreaterThan(500);

    let corpus = '';
    for (const f of files) corpus += readFileSync(f, 'utf8') + '\n';

    // One pass over the corpus collects every referenced identifier:
    // `.name(` / `.name!(` call sites, `.name?.(` optional-chain calls,
    // or `name:` stub-property definitions on engine test doubles.
    // One regex per method instead scans the corpus up to that method's first
    // reference, so its cost depended on readdir order and drifted past the
    // 5 s default when a checkout reordered test/.
    const seen = new Set<string>();
    for (const m of corpus.matchAll(/[.](\w+)(?:\s*!?\s*\(|\?\.\()|\b(\w+)\s*:/g)) seen.add(m[1] ?? m[2]!);

    const unreferenced = INTERFACE_METHODS.filter((n) => !seen.has(n));

    // Two-direction diff for actionable failure output:
    //  - newlyUncovered: add a real test, or allowlist + smoke it here.
    //  - nowCovered: coverage landed elsewhere — SHRINK the UNCALLED list.
    const newlyUncovered = unreferenced.filter((n) => !UNCALLED.includes(n));
    const nowCovered = UNCALLED.filter((n) => !unreferenced.includes(n));
    expect({ newlyUncovered, nowCovered }).toEqual({ newlyUncovered: [], nowCovered: [] });
  });
});

// ============================================================
// Smokes: each UNCALLED method called once against a seeded engine,
// asserting a minimal real-shape invariant.
// ============================================================

let engine: PGLiteEngine;
let fundAPageId: number;
let fundATakeId: number;

function unitEmbedding(): Float32Array {
  const e = new Float32Array(DIM);
  e[0] = 1;
  return e;
}

// Ex-UNCALLED shape pins: methods that gained references elsewhere (the
// ratchet shrank, as designed); each keeps its original seeded-PGLite smoke.
const EX_UNCALLED_SHAPE_PINS: Record<string, () => Promise<void>> = {
  listPrefixSampledPages: async () => {
    // One row per two-segment prefix, ordered by prefix; inbound-link count
    // is the tiebreaker inside a prefix; representative_chunk_id resolves to
    // the lowest embedded chunk (null when the page has no embedded chunks).
    const rows = await engine.listPrefixSampledPages({ prefixes: ['wiki/vc', 'wiki/biology'] });
    expect(rows.map((r) => r.prefix)).toEqual(['wiki/biology', 'wiki/vc']);
    const bio = rows[0];
    expect(bio.slug).toBe('wiki/biology/cells');
    expect(bio.source_id).toBe('default');
    expect(bio.connection_count).toBe(0);
    expect(bio.representative_chunk_id).toBeNull();
    const vc = rows[1];
    // fund-b has 1 inbound link (from fund-a) → beats fund-a on the
    // connection_count tiebreak.
    expect(vc.slug).toBe('wiki/vc/fund-b');
    expect(vc.connection_count).toBe(1);
    expect(typeof vc.page_id).toBe('number');
    expect(vc.compiled_truth).toContain('fund b');
    expect(vc.representative_chunk_id).not.toBeNull();
    // Unknown prefix → no row; empty prefix list short-circuits to [].
    expect(await engine.listPrefixSampledPages({ prefixes: ['no/such'] })).toEqual([]);
    expect(await engine.listPrefixSampledPages({ prefixes: [] })).toEqual([]);
  },

  listCorpusSample: async () => {
    const a = await engine.listCorpusSample({ n: 2, seed: 0.42 });
    expect(a).toHaveLength(2);
    for (const row of a) {
      expect(typeof row.slug).toBe('string');
      expect(row.source_id).toBe('default');
      expect(row.page_id).toBeGreaterThan(0);
      expect(typeof row.connection_count).toBe('number');
    }
    // Deterministic under an explicit seed (the documented test contract).
    const b = await engine.listCorpusSample({ n: 2, seed: 0.42 });
    expect(b.map((r) => r.slug)).toEqual(a.map((r) => r.slug));
    // n <= 0 short-circuits without touching the DB.
    expect(await engine.listCorpusSample({ n: 0 })).toEqual([]);
  },

  getPageTimestamps: async () => {
    const ts = await engine.getPageTimestamps(['wiki/vc/fund-a', 'missing/none']);
    expect(ts.size).toBe(1);
    const when = ts.get('wiki/vc/fund-a');
    expect(when).toBeInstanceOf(Date);
    expect(Number.isNaN(when!.getTime())).toBe(false);
    expect(ts.has('missing/none')).toBe(false);
    // Empty input short-circuits to an empty map.
    expect((await engine.getPageTimestamps([])).size).toBe(0);
  },
  rewriteLinks: async () => {
    // Ex-UNCALLED: test/engine-parity/sync-aliases.test.ts calls it on every arm.
    // Documented no-op stub on PGLite: links key on integer page_id FKs, so
    // they are already correct after updateSlug. Pin the no-op contract —
    // resolves undefined and leaves the link table untouched.
    const before = await engine.getLinks('wiki/vc/fund-a');
    expect(before.length).toBe(1);
    const out = await engine.rewriteLinks('wiki/vc/fund-a', 'wiki/vc/renamed');
    expect(out).toBeUndefined();
    const after = await engine.getLinks('wiki/vc/fund-a');
    expect(after.map((l) => l.to_slug)).toEqual(before.map((l) => l.to_slug));
  },
};

const SMOKES: Record<string, () => Promise<void>> = {};

describe('uncovered-method smokes (seeded PGLite)', () => {
  beforeAll(async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: DIM,
      env: { ...process.env },
    });
    engine = new PGLiteEngine();
    await engine.connect({}); // in-memory
    await engine.initSchema();

    const fundA = await engine.putPage('wiki/vc/fund-a', {
      type: 'note',
      title: 'Fund A',
      compiled_truth: 'about fund a.',
    });
    fundAPageId = fundA.id;
    await engine.putPage('wiki/vc/fund-b', { type: 'note', title: 'Fund B', compiled_truth: 'about fund b.' });
    await engine.putPage('wiki/biology/cells', { type: 'note', title: 'Cells', compiled_truth: 'about cells.' });
    // fund-b gets one inbound link → the prefix-sampling tiebreaker target.
    await engine.addLink('wiki/vc/fund-a', 'wiki/vc/fund-b');
    // One embedded chunk on fund-b → representative_chunk_id is non-null.
    await engine.upsertChunks('wiki/vc/fund-b', [
      {
        chunk_index: 0,
        chunk_text: 'about fund b.',
        chunk_source: 'compiled_truth',
        embedding: unitEmbedding(),
        token_count: 3,
      },
    ]);
    // One take with a hand-written embedding for getTakeEmbeddings.
    await engine.addTakesBatch([
      { page_id: fundAPageId, row_num: 1, claim: 'Fund A is focused', kind: 'take', holder: 'world', weight: 0.7 },
    ]);
    const [take] = await engine.listTakes({ page_id: fundAPageId });
    fundATakeId = take.id;
    const vecStr = '[' + Array.from(unitEmbedding()).join(',') + ']';
    await engine.executeRaw(`UPDATE takes SET embedding = $1::vector, embedded_at = now() WHERE id = $2`, [
      vecStr,
      fundATakeId,
    ]);
  }, 120_000);

  afterAll(async () => {
    await engine.disconnect();
    resetGateway(); // R5: restore the preload baseline for later files in this shard
  });

  test('kind discriminator (readonly instance property, not on the prototype)', () => {
    expect(engine.kind).toBe('pglite');
  });

  test('smoke map covers exactly the UNCALLED allowlist', () => {
    expect(Object.keys(SMOKES).sort()).toEqual([...UNCALLED].sort());
  });

  for (const name of Object.keys(SMOKES)) {
    test(`smoke: ${name}`, () => SMOKES[name]());
  }

  for (const name of Object.keys(EX_UNCALLED_SHAPE_PINS)) {
    test(`shape pin (ex-UNCALLED): ${name}`, () => EX_UNCALLED_SHAPE_PINS[name]());
  }

  // getTakeEmbeddings left UNCALLED at the master merge (#3776 gave it real
  // coverage elsewhere); its shape pin stays here, inside the seeded engine's
  // lifecycle, no longer tied to the UNCALLED map.
  test('getTakeEmbeddings shape pin (ex-UNCALLED): Float32Array rehydration + omissions', async () => {
    const embs = await engine.getTakeEmbeddings([fundATakeId, 999_999]);
    expect(embs.size).toBe(1);
    const vec = embs.get(fundATakeId);
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec!.length).toBe(DIM);
    expect(vec![0]).toBeCloseTo(1);
    expect((await engine.getTakeEmbeddings([])).size).toBe(0);
  });
});
