/**
 * BrainEngine parity coverage list generator.
 *
 *   bun test/engine-parity/coverage.ts           # print the list
 *   bun test/engine-parity/coverage.ts --write   # refresh test/engine-parity/coverage.tsv
 *
 * Reads the BrainEngine interface (src/core/engine.ts) with the TypeScript
 * compiler API, reads every `parityTest(name, { methods: [...] }, ...)` call
 * in test/engine-parity/*.test.ts, and writes one row per callable interface
 * member: its family, how many parity cases cover it, and whether the legacy
 * Postgres-gated suite (test/e2e/engine-parity*.test.ts) calls it.
 * `coverage.test.ts` fails when the checked-in list is stale.
 *
 * A method counts as covered only through a harness case: those run on every
 * arm (PGLite always, Postgres with DATABASE_URL, Rust with GBRAIN_TEST_RUST_ARM=1) and the harness
 * proves each declared method was really called.
 *
 * The per-arm columns say what each arm must do for the method: `yes` (runs
 * and is compared), `serves` (the Rust engine serves the member, so with
 * GBRAIN_TEST_RUST_ARM=1 it must return the same answer, or end on the typed refusal of an
 * option or input it declines (a served member can refuse part of its surface: a
 * `source_path` write, `listColumnsOnly`, a vector, a fuzzy `resolveSlugs`, a
 * multi-source `getChunks`), or differ only the way a row in
 * test/rust-expected-divergence/ names), `refuses:<capability>` (the arm must throw the typed
 * `engine_capability_missing` refusal) or `n/a:<why>` (the method does not
 * exist on that arm). They come from each case's `requires` declaration and
 * test/engine-parity/arm-capabilities.ts.
 */
import ts from 'typescript';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PARITY_ARMS, armHas, missingCapability, type EngineCapability, type ParityArmName } from './arm-capabilities.ts';
import { rustRefusal } from './rust-arm.ts';

const REPO = join(import.meta.dir, '..', '..');
const PARITY_DIR = import.meta.dir;
const LEGACY_DIR = join(REPO, 'test', 'e2e');
// test-reads-source-ok[structural]: the coverage denominator is the declared BrainEngine member list.
const ENGINE_FILE = join(REPO, 'src', 'core', 'engine.ts');
export const COVERAGE_FILE = join(PARITY_DIR, 'coverage.tsv');

/**
 * Method families (research 01 grouping). Every callable BrainEngine member
 * must appear exactly once; the generator throws otherwise, so a new engine
 * method forces a visible family assignment here.
 */
export const FAMILIES: Record<string, readonly string[]> = {
  lifecycle: ['connect', 'disconnect', 'reconnect', 'initSchema', 'holdSchemaMigrationLock', 'transaction',
    'transactionDirect', 'registerBeforeDisconnect', 'withReservedConnection'],
  pages: ['getPage', 'readPageSnapshot', 'readPageSnapshotsBatch', 'lockPageKeys', 'putPage', 'findDuplicatePage',
    'findDuplicatePages', 'deletePage', 'deletePages', 'resolveSlugsByPaths', 'softDeletePage', 'softDeletePages',
    'restorePage', 'purgeDeletedPages', 'listPages', 'findPages', 'countPagesBy', 'resolveSlugs', 'getAllSlugs',
    'listAllPageRefs', 'listAllSources', 'listSourceLocalPaths', 'countRepoBoundSources', 'listNotifierHostSourceRows',
    'listLocalPathSources', 'readPlainSyncSource', 'readOwnerOnlySourcesPresent', 'readOwnerOnlySourceConfig',
    'listSourceRoutingRows', 'countDefaultSourceSplit', 'listStaleSyncSourceIds', 'listSourceIds', 'readSoleSourceId',
    'readFirstSourceId', 'lockAllSourceRows', 'readSourceRow', 'lockSourceRow', 'countSourcePages', 'insertSource',
    'updateSourceConfig', 'getSource', 'readPageIdentity', 'writeSourceSyncHeartbeat',
    'writeSourceUpstreamObservation', 'advanceSourceCommit', 'listSourcePathPages', 'readRenameIdentityRows',
    'readLiveIdentityHolders', 'readPageSizeRows', 'holdPageEmbedding', 'readReasonPurgeTombstones',
    'advanceSourcePurgeEpoch', 'listPrefixSampledPages', 'listCorpusSample', 'bumpPageRetrievals', 'getPageSealState',
    'refreshPageOrigin', 'listEntityKeyRows', 'listIdentityDecisions', 'listRestrictedIdentityMembers',
    'applyIdentityDecisions', 'readLivePageIdBySlug', 'readPageTierRef', 'readPageTierRows', 'pageHasFrontmatterKey'],
  search: ['searchKeyword', 'countKeywordPages', 'searchKeywordPages', 'searchTitles', 'searchVector',
    'getEmbeddingsByChunkIds', 'searchKeywordChunks'],
  search_reads: ['cosinesByChunkIds', 'hasSupersedeEdges', 'supersedingPageSlugs', 'aliasCanonicalRefs',
    'pageCollapseFacts', 'slugsEndingIn', 'generatedPagesIn', 'livePageIdsAt', 'pagesLinkingTo'],
  link_reads: ['inboundLinkCoverage', 'listJunkEntityHubs', 'countEntityPages', 'entityGraphCoverage',
    'entityFeatureCoverage', 'countDatedMeetingPages', 'countForeignEdges', 'listLivePageSummaries',
    'countInboundLinks', 'readEntityInboundEdges', 'listLinkEndpointPages', 'listPagesTitledIn', 'wordLexemes',
    'readLinkContextMatches', 'readLinkContextOriginPages'],
  link_temporal: ['readLinkRelationshipEvidence', 'writeLinkRelationshipState', 'linkRelationshipKeysForPages',
    'staleLinkRelationshipKeys', 'linkRelationshipKeysForOrigin', 'applyLinkTemporalRows',
    'writeManualLinkTransitions', 'removeManualLinkTransitions', 'listRelationshipNoteRows', 'edgeValidityCounts',
    'listPageStatusByRef', 'listRecordMetadataRows', 'readReferrerGroupRows', 'readReferrerPageDetails',
    'readReferrerTargetCounts', 'listReferrerTargetSources', 'countReferrerRows', 'readReferrerRows',
    'readReferrerRecordCandidates', 'readReferrerRecordPages', 'readReferrerTypes',
    'readPageReferenceDate'],
  search_vector: ['countSearchVectorRows', 'replaceSearchVectorTriggerFunction', 'backfillSearchVectors',
    'ensureFactsKeywordIndex'],
  retrieval_coverage: ['countPendingProjectionPages', 'countEmbeddingHeldPages', 'projectionRebuildProgress',
    'readProjectionReadinessGeneration', 'readProjectionReadiness'],
  chunks: ['upsertChunks', 'sealChunks', 'getChunks', 'getChunkPage', 'getChunkWindows', 'countStaleChunks',
    'sumStaleChunkChars', 'setPageEmbeddingSignature', 'invalidateStaleSignatureEmbeddings',
    'invalidateContentDriftEmbeddings', 'listStaleChunks', 'readPageEmbeddingBudget', 'recordPageEmbeddingHold',
    'openPageEmbeddingHold', 'reservePageEmbedding', 'settlePageEmbeddingReservation', 'readEmbeddingCompletion',
    'lockEffectClaimRow', 'lockEmbeddingSwitch', 'installChunkEmbeddings', 'countChunklessPagesWithContent',
    'listChunklessPagesWithContent', 'readEmbeddingStateCounts', 'listEmbeddingStateRows', 'deleteChunks',
    'getChunksWithEmbeddings', 'deleteChunksExcept', 'setChunkerVersion', 'readSourceChunkerVersion',
    'setSourceChunkerVersion', 'writeTextProjectionSeal', 'moveChunkIndexes', 'getChunkReuseRows',
    'findCodeDefinitions', 'listSymbolTypesForName', 'findCodeRefChunks', 'countOversizedEmbedSkips',
    'countOrphanChunks', 'countCodeChunkPages', 'codeChunksExist', 'hasUnsealedPages', 'currentCodeChunksExist',
    'listQualifiedSymbolNames', 'listWithdrawalChunks', 'deleteChunksForPages', 'listContextualModeCandidates',
    'resolveFrozenHits'],
  extraction: ['countStalePagesForExtraction', 'listStalePagesForExtraction', 'listFactsFencePages',
    'listSweepStalePages', 'listSweepDeferredPages', 'listPageRefsForSlugs', 'markPagesExtractedBatch',
    'markPagesAttendanceBlocked', 'countStaleFrontmatterKeyPages', 'listStaleFrontmatterKeyPages',
    'stripStaleFrontmatterKeys'],
  links: ['addLink', 'addLinksBatch', 'replaceDerivedLinks', 'replaceDerivedLinksBatch', 'removeLink',
    'removeLinksByPagesAndSource', 'getLinks', 'getBacklinks', 'listLinkSources', 'findByTitleFuzzy', 'traverseGraph',
    'traversePaths', 'traversePathsDetailed', 'relationalFanout', 'relationalChainHop', 'getBacklinkCounts',
    'getAdjacencyBoosts', 'getContentFlagsByPageIds', 'getUnverifiedExtractionPageIds', 'getPageTimestamps',
    'getEffectiveDates', 'getSalienceScores', 'findOrphanPages'],
  tags: ['addTag', 'removeTag', 'getTags', 'pruneFrontmatterTags', 'addPageTagsById'],
  timeline: ['addTimelineEntry', 'addTimelineEntriesBatch', 'getTimeline', 'getTimelineForDate', 'getSince',
    'getOnThisDay', 'getLastSeen', 'upsertEventProjection', 'listEventProjectionRows', 'readEventProjectionId',
    'deleteEventProjections', 'restoreEventProjection', 'removeTimelineRows', 'updateTimelineDetails',
    'sampleEffectiveDates', 'sampleEffectiveDateSources', 'readMaxTimelineEntryId', 'listStoredTimelineRowsOrdered',
    'deleteTimelineRows', 'storedTimelineRowsByPageIds', 'countSegmentedTimelinePages',
    'countTimelineCommentMarkupRows', 'listTimelineOrphanPages', 'insertCanonicalTimelineRows',
    'readNewestTimelineEntryId'],
  ontology: ['mergeOntologyFact', 'getOntology', 'discoverOntologyDimensions', 'findOntologyConflicts',
    'listRekeyLosers', 'repointSupersededToKept', 'clearOntologySlots', 'deleteRekeyLosers',
    'listOntologyFactCandidates', 'restoreOntologyFact'],
  raw_files: ['putRawData', 'getRawData', 'upsertFile', 'getFile', 'listFilesForPage', 'listFiles', 'hasFileWithHash',
    'listFileRowsForVerify', 'readSourceLocalPathForVerify', 'upsertCliFileRow', 'upsertRawFileRow',
    'upsertSyncFileRow', 'sourceIdExists', 'readPageIdInSource', 'readFileOwner', 'claimFilePage', 'upsertOpFileRow',
    'listReadableFileRows', 'readReadableFileForUrl', 'readReadablePageId', 'countUnreadableFilesAt',
    'countFilesRegisteredElsewhere', 'registerFileRow', 'readReadableFileForVerify', 'listReadableFilePaths'],
  takes: ['addTakesBatch', 'updateTakeEmbeddings', 'listTakes', 'searchTakes', 'searchTakesVector',
    'getTakeEmbeddings', 'countStaleTakes', 'listStaleTakes', 'updateTake', 'supersedeTake', 'resolveTake',
    'getScorecard', 'getCalibrationCurve', 'addSynthesisEvidence', 'listActiveTakesForPages', 'matchTakeRows',
    'deleteTakeRows', 'countOffGridTakeWeights', 'countTakes', 'planFactPurgeTakes', 'listTakeRowsForPage',
    'readTakePreimages', 'readTakeRowTrust', 'readTakeTrustRef', 'countMcpResolvedTakes',
    'listTopResolvedTakesForHolder', 'listAbandonedTakes', 'listTakeSupersessionCandidates', 'listHeldFenceTakeRows',
    'listTakeIdsLeavingFence', 'listTakePreimages', 'deleteTakesByIds', 'findTakeId'],
  dream: ['getDreamVerdict', 'putDreamVerdict', 'sweepDreamVerdicts', 'listDreamQueueCandidates',
    'listLiveDreamCycleLocks', 'readDreamJobStatus', 'ensureDreamMapConfigRow', 'lockDreamMapConfigRow',
    'writeDreamMapConfigRow', 'recordDreamBreakerReset', 'stampDreamPageProvenance', 'listDreamPageIds',
    'countDreamProvenancePages', 'readDreamDeferralReceipt', 'listConsolidationClaimValues',
    'setConsolidatedFactValidUntil', 'listReadersSourcedFactIds', 'findConsolidationPageIds',
    'readConsolidationTakesMaxRowNum', 'findConsolidatedTakes', 'refreshConsolidatedTakeSource',
    'findConsolidatedTakeIds', 'listConsolidationClaimShapes', 'listRetainedDreamOutputSources',
    'readDreamSourceIncarnation', 'listDreamAtomPages', 'listSynthesisPageBodies', 'listLaterPersistenceRequests',
    'listCommittedOutputRequests', 'readDreamVerifyEpoch', 'listDreamJobCreatedAt', 'readDreamPreRunRevision',
    'listCompletedSynthJobs', 'countCoalescibleSynthJobs', 'listWaitingChildJobIds', 'listDreamChildJobTimings',
    'countRecentDreamSynthSubmissions'],
  contradictions: ['writeContradictionsRun', 'loadContradictionsTrend', 'getContradictionCacheEntry',
    'putContradictionCacheEntry', 'sweepContradictionCache', 'listEdgeContradictionCandidates',
    'listKnownEdgeProposals', 'listLinkContexts', 'recordEdgeProposal', 'readEdgeProposal', 'edgeClosureLanded',
    'readEdgeProposalEvidence', 'readEdgeProposalHash', 'markEdgeProposalStale', 'setEdgeProposalStatus',
    'rejectOpenEdgeProposal', 'markEdgeProposalUndone', 'markRevertedEdgeProposals', 'listLiveChunksByIds',
    'listLiveTakesByIds', 'readLastContradictionsPromptVersion', 'listEvalCandidateQueries'],
  facts: ['insertFact', 'insertFacts', 'deleteFactsForPage', 'expireFact', 'listFactsByEntity', 'listFactsSince',
    'listFactsKeyset', 'listFactsBySession', 'listSupersessions', 'countUnconsolidatedFacts',
    'findCandidateDuplicates', 'consolidateFact', 'findTrajectory', 'getFactsHealth', 'listFenceRetireCandidates',
    'readFactPreimages', 'restoreFactPreimage', 'listFactIdsBySourcePrefix', 'expireFactRows'],
  segmented_body: ['allocateBodyOccurrenceIds', 'stageSegmentTexts', 'readSegmentTexts', 'stageManifestRows',
    'readManifest', 'readSegmentedEmbedPage', 'stageSegmentChunks', 'createSegmentedPageShell', 'flipBodyGeneration',
    'sealSegmentedPage', 'openBodyStaging', 'setBodyStagingState', 'sweepSegments', 'readSegmentDerivations',
    'upsertSegmentDerivations', 'retireSegmentDerivations'],
  versions: ['createVersion', 'getVersions', 'revertToVersion', 'readLatestVersionId', 'readLatestVersionIdAtTier',
    'stampVersionChangeReason', 'pruneHoldingPageVersions'],
  stats_ingest: ['getStats', 'getHealth', 'countOnboardSignal', 'readBrainMaturity', 'logIngest', 'getIngestLog',
    'pingStore', 'listVisiblePageSlugs', 'readPagesForVersionHistory'],
  sync_aliases: ['updateSlug', 'rewriteLinks', 'resolveSlugWithAlias', 'resolveSlugWithAliasDetailed',
    'resolveAliases', 'setPageAliases', 'replaceDerivedAliases', 'refreshPageBody',
    'updatePageContextualRetrievalState', 'migrateFactsToCanonical'],
  config: ['getConfig', 'setConfig', 'unsetConfig', 'listConfigKeys', 'getAllConfig', 'getConfigValues'],
  import_guards: ['readManagedModeRows', 'getSourceStrictness', 'readPersistenceBrainId', 'readLocalWriterRow',
    'insertLocalWriterRow', 'readTransactionSettings', 'applyTransactionSettings', 'beginSnapshotRead',
    'readCurrentWriteTrust', 'setWriteContext', 'readLedgerSource', 'isFolderRestricted', 'listCoveredSources'],
  access_grants: ['readOAuthClientReceiptGrant', 'readAccessTokenReceiptGrant', 'readOAuthClientMemberGrant',
    'readAccessTokenMemberGrant', 'readLocalWriterMemberGrant', 'readSharedSkillServingEpoch', 'revokeLocalWriterRow'],
  access_members: ['insertAccessMember', 'setAccessMemberDisabled', 'setAccessMemberEmail', 'setAccessMemberKind',
    'setAccessMemberLabelledOnly', 'tombstoneAccessMember', 'addAccessGroupMembers', 'removeAccessGroupMembers',
    'deleteAccessGroup', 'readCredentialBindingForUpdate', 'writeCredentialBinding', 'writeCredentialReadsUnscoped',
    'readCredentialMemberId', 'readLinkedMember', 'readAccessMemberLink', 'insertAccessMemberLink',
    'deleteAccessMemberLink', 'listAccessMemberLinks'],
  shared_skill_members: ['readSharedSkillCatalogIdentity', 'listSharedSkillCatalogHeads', 'readSharedSkillPolicyRow',
    'listSharedSkillFollowSources', 'lockSharedSkillBrainId', 'readSharedSkillMember', 'countSharedSkillMembers',
    'enrollSharedSkillMember', 'rebindSharedSkillMember', 'leaveSharedSkillMember', 'issueSharedSkillDeliveryBatch',
    'readSharedSkillDeliveryBatch', 'acknowledgeSharedSkillDeliveryBatch', 'writeSharedSkillPolicy',
    'writeSharedSkillRevision', 'readSharedSkillRevision'],
  persistence_journal: ['readJournalLimitRows', 'readHeldPageRows', 'readHeldCoverageRows', 'readGitHoldRecords',
    'readGitHoldRetryRequest', 'readGitHoldReportInputs', 'lockGitHoldSummary', 'adjustGitHoldSummary',
    'readGitHoldRow', 'writeGitHoldRow', 'replaceGitHoldRow', 'deleteGitHoldRow', 'countGitHolds', 'readSyncPassRow',
    'readLiveSyncPassRows', 'writeSyncPassRow', 'readSourcePurgeEpoch', 'readWriteWatermarkRow',
    'readSourceCheckoutRoot', 'readUnembeddedPageSummary', 'listFenceHoldRows', 'readFenceOriginGone',
    'lockGenerationKey', 'clearFenceHoldRows', 'readFenceHoldFiles', 'readLiveGenerationRow', 'activateGenerationRows',
    'recordHeldGenerationRow', 'heldGenerationRowsForInput', 'readHeldGenerationContext', 'liveGenerationForOperation',
    'countGenerationAttempt', 'clearGenerationAttempts', 'readGenerationRestored', 'clearTieHeldGenerationRows',
    'readGenerationValve', 'bumpGenerationValve', 'scrubGenerationPageRows', 'scrubGenerationTextRows',
    'recordGenerationActivation', 'markGenerationActivated', 'readGenerationActivationState', 'settleGenerationMember',
    'listPendingGenerationMembers', 'listGenerationOrphanCandidates', 'readGenerationItemsByIds',
    'listUnmatchedGenerationRows', 'listRestorableGenerationRows', 'listHeldGenerationRows',
    'readHeldGenerationProposal', 'listSourceIncarnations', 'listRecordedFenceItemKeys', 'hasBodylessPageVersion',
    'listFenceVersionBodies', 'moveKeptFactRows', 'readGenerationFenceBlocks', 'listOwnedGenerationItems',
    'readLiveGenerationId', 'readGenerationPageRows', 'readAtomOriginInput', 'readChronicleDepthRow',
    'listChronicleOwnedHashes', 'listRetiredGenerationItemKeys', 'listPageContentHashes', 'listLiveGenerationItems',
    'hasChronicleSkipDecision', 'pageSlugExists', 'listOrphanedChronicleOwners', 'listChronicleEventSlotRows',
    'listProducerVersionRows', 'listAtomWriteReceipts', 'readWriteRequest', 'readWriteRequestsByRequestId',
    'readWriteRequestById', 'listWriteRequestRows', 'readWriteRequestProgress', 'countOutstandingBySource',
    'ownsSchemaTables', 'readOAuthClientWriteGrant', 'readAccessTokenWriteGrant', 'shareLockWriteCredential',
    'readCounterRows', 'readAdmissionRate', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim',
    'lockWriteRequest', 'completeWriteRow', 'cancelWriteRow', 'insertPublicationEffects', 'insertWithdrawalEffects',
    'readSourceMembership', 'findTopologyChanges', 'renewWriteClaim', 'releaseUnpublishedClaim',
    'expireStaleWriteClaims', 'hasClaimableWrite', 'selectClaimableWrite', 'listHostConsumerRows',
    'probeLiveConsumerRows', 'renewConsumerRow', 'deleteConsumerRow', 'stampWorktreeHeartbeats', 'readTopologyChange',
    'insertTopologyChange', 'claimHousekeepingTurn', 'claimNotifierLease', 'readNotifierLease', 'holdsNotifierLease',
    'releaseNotifierLease', 'readNotifierSources', 'writeNotifierState', 'writeNotifierCoverage',
    'recordNotifierSyncerHost', 'readNotifierStatusRows', 'hasNotifierCoverage', 'upsertWantedMarker',
    'attachWantedMarkerJob', 'readWantedMarkers', 'readDueWantedMarkers', 'pruneSatisfiedWantedMarkers',
    'clearWantedMarker', 'settleFreshnessMarker', 'listSourceWantedMarkers', 'readSourceSyncShape',
    'readNotifierFirstDue', 'readSourceLastCommit', 'readDrainHolderProgress', 'readLiveJobIds',
    'readDrainLeaseBeacon', 'writeDrainLeaseHolder', 'refreshDrainLeaseHolder', 'releaseDrainLeaseHolder',
    'completeHousekeepingTurn', 'readReceiptBudget', 'listCompactableReceipts', 'listReservationsAfter',
    'listTrueUpRequests', 'trueUpReservations', 'readCapacityForecastInputs', 'listPendingSegmentedProjections',
    'selectProjectionWindowJobs', 'declarePersistence', 'requireSynchronousCommit', 'listGatedMirrorRequests',
    'listEffectRecoveries', 'selectClaimableEffect', 'readRequestEffects', 'stampEffectClaim', 'renewEffectClaim',
    'advanceEffectRow', 'completeEffectRow', 'retryEffectRow', 'retryBusyEffectRow', 'requeueEffectRow',
    'parkEffectRow', 'failEffectRow', 'readMirrorGateRows', 'lockEffectGuard', 'hasRearmableTargets', 'probeIdleWork',
    'probeNoopEmbeddingSettle', 'lockNoopEmbeddingWindow', 'readNoopEmbeddingCandidates', 'settleNoopEmbeddingRows',
    'listOverdueHeldWrites', 'lockOverdueHold', 'listOwnerRecoveryHeads', 'listResumableRefreshes',
    'listSourceLastCommits', 'readWriterVersionCutoff', 'listWriterVersions', 'recentWriterVersions',
    'claimSegmentedProjection', 'renewSegmentedProjectionClaim', 'releaseSegmentedProjectionClaim',
    'deleteProjectionJob', 'markProjectionRebuildFailed'],
  entity_reads: ['readMentionLastPass', 'readMentionIndexStatus', 'countLivePagesInSource', 'countMentionDueSince',
    'recountMentionIndexStatus', 'countPagesDueForMentions', 'readIdentitySiblingCandidates', 'findExactSlug',
    'readLiveSlugs', 'readLivePageTypes', 'readTrigramCandidates', 'readPrefixCandidates', 'readPrefixDirs',
    'readPrefixTitleMatches', 'readNamedEntitySlugs', 'readRetirementHop', 'readEntityCardRows',
    'readExtractionLagCounts', 'readIgnoredPrivacyLabelPages', 'listUnretiredPagesBySlugPattern',
    'listNameVariantCandidates', 'countDistinctInboundLinkers', 'findFuzzyEntityCandidates',
    'findExactBasenameCandidates',
    'readLivePageFrontmatter', 'readEntityAnchoredPages', 'readPageTitlesById', 'readTextMentionPages'],
  cycle_locks: ['acquireCycleLock', 'refreshCycleLock', 'releaseCycleLock', 'readCycleLocks', 'deleteCycleLock',
    'deleteCycleLockIfStale', 'assertCycleLease', 'takePageEmbeddingLease', 'renewPageEmbeddingLease',
    'releasePageEmbeddingLease'],
  minion_jobs: ['admitJob', 'getJob', 'readJobDataByIdempotencyKey', 'coalesceOnIdempotencyKey', 'listJobs',
    'claimNextJob', 'renewJobLease', 'completeJob', 'failJob', 'reclaimStalledJobs'],
  minion_queue: ['deleteTerminalJob', 'pauseJob', 'resumeJob', 'resolveParentJob', 'failParentJob',
    'resolveStrandedParents', 'detachChildJob', 'updateJobProgress', 'addJobTokens', 'delayActiveJob',
    'releaseWatchdogClaim', 'markJobWatchdogSuspect', 'promoteDelayedJobs', 'cancelJobs', 'killTimedOutJobs',
    'killWallClockJobs', 'pruneJobs', 'retryJob', 'postInboxMessage', 'listSynthesisCompletionKeys',
    'listRecentSynthesisCompletions', 'readJobInbox', 'readChildCompletions', 'listOpenJobIdsInQueue',
    'renewPrivateQueueLease', 'listOwnedPrivateQueues', 'readPrivateQueueState', 'listStaleWaitingJobIds',
    'countTtlExpiredWaiting', 'readJobStats', 'readQueueFamilyStats', 'hasOverdueWatchdogSuspect',
    'listUnreviewedJobs', 'getFailedJobForRetry', 'countOpenJobsByOwner', 'readJobSourceState', 'lockOAuthClient',
    'listJobPage', 'listJobAttachmentNames', 'insertJobAttachment', 'listJobAttachments', 'getJobAttachment',
    'deleteJobAttachment', 'readQueueHealthSignals', 'listWaitingByQueue', 'readQueueDivergence',
    'listQueueWedgeCounts', 'listPrivateQueueHealth', 'readWedgeSignals', 'readOldestWaitingAge', 'countWaitingJobs',
    'listStuckActiveJobsByName', 'listStalledEmbedBackfillSources', 'readGlobalMaintenanceDeaths',
    'readLastFailedGlobalMaintenanceJob', 'listFactsAbsorbJobsStillDead', 'readLegacyJobAuthority',
    'readQueuedSpendRows', 'listBuildSkewStacktraceLines', 'countDeadDreamSubmissionRows',
    'listFactsAbsorbJobsByKeyPrefix', 'listDeadFactsAbsorbJobsByKeys', 'readJobInsight', 'readJobSpendTree',
    'insertSpendReservation', 'expireSpendReservations', 'settleSpendReservation', 'markSpendUsageUnknown',
    'insertLeasePressure', 'countLeasePressure', 'listRecentLeasePressure', 'reserveClientSpend', 'reserveGroupSpend',
    'readGroupSpendTotals', 'settleSpendWithLog', 'insertSpendLog', 'sumClientSpendSince', 'readClientBudgetUsd',
    'insertOauthClient', 'updateOauthClientBudget', 'readAgentClientSpend', 'readOauthClient', 'listOauthClients',
    'patchOauthClient', 'insertAccessToken', 'findActiveAccessTokens', 'setAccessTokenMinTrust', 'listAccessTokens',
    'readActiveAccessTokenGrant', 'accessTokenLive', 'oauthClientLive', 'readOauthClientColumns',
    'setOauthClientTokenTtl', 'insertOauthClientGrant', 'readTokenLifetimeClampedClients', 'readScopeSourceConfigs',
    'readOauthAccessTokenRows', 'lockActiveAccessTokens', 'writeAccessTokenGrant', 'writeAccessTokenPrivateGrant',
    'lockLegacyAccessTokens', 'readActiveAccessTokenByHash', 'touchAccessTokenLastUsed',
    'deleteExpiredOauthCredentials', 'insertOauthToken', 'convertLegacyAccessTokenGrant', 'expireAllOauthCredentials',
    'insertOauthCode', 'readOauthCodeForUpdate', 'deleteOauthCode', 'readOauthCodeChallenge', 'issueOauthTokens',
    'readOauthRefreshTokenForUpdate', 'deleteOauthRefreshToken', 'readOauthClientForUpdate', 'lockOauthClientName',
    'listAccessTokenRows', 'readLiveOauthClients', 'readLiveAccessTokenRows', 'oauthClientHoldsAuthorization',
    'readSourceArchivedForShare', 'readSourceAttestState', 'replaceSourceConfig', 'persistOauthClientGrant',
    'readLatestCatalogProvenanceAudit', 'listOauthGrantAudit', 'deleteOauthTokenByHash', 'softDeleteOauthClient',
    'deleteOauthClientTokens', 'deleteOauthClientCodes', 'deleteOauthClientRow', 'setOauthClientRevision',
    'insertOauthGrantAudit', 'countOauthAccessTokens'],
  minion_status: ['readLastAutopilotCycles', 'countJobsByStatus', 'readWaitingQueueDepths', 'readLastCompletedJobAt',
    'countTtlCancelledByName', 'readWaitingScopeState', 'countRecentCompletedJobs', 'listRecentFailedJobErrors',
    'listBudgetOwners', 'readQueuedPageChars', 'readSourceJobCounts', 'readEmbedBackfillBySource'],
  minion_subagent: ['listSubagentMessages', 'countSubagentMessages', 'insertSubagentMessage',
    'listSubagentToolExecutions', 'hasSubagentToolExecution', 'listSubagentWriteOutcomes', 'listSubagentOneshotLedger',
    'summarizeSubagentToolExecutions', 'listSubagentPutPageSlugs', 'listSubagentPutPageWrites',
    'listSubagentRetainedPutPages', 'listSubagentStagedPages', 'listSubagentTimelineAppendCalls',
    'recordSubagentToolExecutions', 'startSubagentToolExecution', 'completeSubagentToolExecution',
    'failSubagentToolExecution'],
  cli_reads_ops: ['scanExactBatch', 'nextLivePageAfter', 'listExactIdentityCandidates', 'rankEntities',
    'listExtractionPendingPages', 'listUnattributedFacts', 'listWantedPages', 'readRankCoverage',
    'readExactSnippetChunks', 'listExactRescanChunks', 'listHeldFenceCells', 'readFenceOverlayRows',
    'probePageTypes', 'readLongPageSizes'],
  // brief_reads: the proactive brief's meeting, loop and edit reads (engine-sql/brief-reads.ts)
  brief_reads: ['readBriefMeetingPages', 'readBriefEmailAliasPages', 'readBriefWorldFacts', 'readBriefEditPage', 'readBriefTimelineEntry', 'readBriefPageVersions'],
  // reflex_reads: the retrieval reflex's page reads and the brief's entity pages (engine-sql/reflex-reads.ts)
  reflex_reads: ['readReflexLiveKeys', 'readReflexPages', 'readBriefEntityPages'],
  facts_doctor: ['listConversationFactRows', 'countRedactedFacts', 'listOutsideContentFenceCounts', 'countAtomFacts',
    'listUnpreviewedTrustFacts', 'countUnlinkedFactsByOrigin', 'countUnlinkedFactStats', 'countFactRelinkOutcomes',
    'listUnlinkedConversationSlugs', 'countFactEmbeddingCoverage', 'countStaleFactEmbeddings',
    'countSegmentedCensusPages', 'listFactsPageBodies', 'readFactTableCatalog'],
  embedding_catalog: ['readChunkVectorColumn', 'readEmbeddingIdentity', 'listEmbeddingStores', 'hasStoredVectors',
    'countChunkVectorCoverage', 'readChunkColumnTypes', 'countChunkColumnCoverage'],
  doctor_reads: ['countPageChildOrphans'],
  doctor_derived: ['readIgnoredPrivacyLabelCounts', 'countSafeIndexPending', 'countCredentialProjectionPending',
    'countPagesByTypeAndOwner', 'listRecordedTombstones', 'countDerivedVisibility', 'listUntiledSegmentedPageRows',
    'listTimelineHistoryBatch', 'listAtomFenceCandidates', 'readPageCompiledTruths', 'readEmbeddingBacklogAge',
    'listBudgetLimitedRows', 'readBudgetHoldAge', 'listImageAssetFiles', 'listAmbiguousExtractionInputs',
    'listExtractionInputReceipts', 'listUnpricedDerivationModels', 'listRestorableAtomRetirements',
    'countLedgerCoveredAtomRetirements', 'listLiveGenerationRetirements', 'listHeldGenerations',
    'listOrphanGenerationCandidates', 'readAtomProvenanceCounts', 'readExtractRollup7d', 'listRecordedHaltReasons7d'],
  doctor_persistence: ['listCapacityCounters', 'listOutstandingHolders', 'countPersistenceRequestRows',
    'listLifetimeCounters', 'readAdmissionSample', 'listRunningRequestStalls', 'readLiveConsumerSummary',
    'readCounterDrift', 'readMaxRequestSequence', 'listRefusalBreakerRows', 'listRecentDriftReceiptSlugs',
    'listOlderDriftReceiptSlugs', 'readPublicationRefusals', 'countParkedEffects', 'listParkedEffects',
    'listGitPushHoldRows', 'listStalledCatchupRows', 'listParkedGroupRows', 'readStaleEmbeddingCounts',
    'listStaleEmbeddingEffects', 'listOrphanBindingRows', 'readPersistenceBrainIdText', 'listWorktreeIds',
    'listManagedRoots', 'listUnboundSourcePages', 'listRecentWriterVersions', 'listRecentPurgeRequests',
    'listStuckWorktreeRefreshes', 'listSourceBindingsForMovement', 'listRunningClaimOwners', 'listOwnerBindings',
    'listConsumerOwners', 'listOverwriteCandidates', 'listCallerRefusalRows', 'countCompactedCallerRefusals',
    'listLocalEditAdoptions', 'listDerivationPurgeSweeps'],
  doctor_pages: ['listOversizedPages', 'listScraperJunkCandidates', 'countMarkedPages', 'countOversizedCorePages',
    'readRawProvenanceGaps', 'countUnverifiedExtractions', 'listContentHashDuplicates', 'countTranscriptImportPages',
    'countPageRows', 'countPagesBySlugPrefix', 'countLivePages', 'readOldestPageCreatedAt', 'countPageTrustTiers',
    'countPagesWithMentionLinks', 'countImageModalityMismatches', 'readImagePageCoverage', 'listBracketPathPages',
    'listSlugPathCandidates'],
  doctor_search: ['listOrphanedAliasCounts', 'readSoftDeletedAliasCounts', 'listPageTypePairs',
    'listTruncatedMarkdownBodies', 'countSegmentedMarkdownBodies', 'listRecentPageBodies', 'countSegmentedRecentPages',
    'countPagesHiddenByPrefix', 'listGitImageHoldCounts', 'readProjectionBacklog', 'countAtomExtractionBacklog'],
  doctor_reads_acc: ['isAccessStateUnreadable', 'listRawOnlyRules', 'listAudienceMemberIds',
    'listLabelledOnlyMemberIds', 'listAccessMemberRows', 'listAttestCredentialRows', 'listActiveAccessTokenRows',
    'listActiveOauthClientRows', 'listOauthClientAuthShapes', 'listDanglingFederatedReads',
    'listOrphanWorkspaceSources', 'listPrivilegedDcrClients', 'readMcpRequestLogBytes', 'countMcpRequestLogRows',
    'hasMcpLogRowsPastWindow', 'readKnowledgeRevisionNotNull', 'readDriftSchema', 'listDriftLiveRows',
    'listDriftVersionRows', 'originIndexPresent', 'listDecideReceiptStats', 'readChronicleLedgerStats',
    'readChronicleDuplicateEvents', 'readFeedbackStatus', 'listVolunteerChannels'],
  doctor_checkpoints: ['listFenceCandidateRecords', 'listDerivedOriginParks', 'listPurgeParks', 'readSoakCounterRows',
    'listUnfinishedManagedSyncCursors', 'listManagedSyncPassStops', 'listManagedSyncBacklogHeaders',
    'readManagedSyncPassRow', 'listLiveManagedSyncPassRows', 'listCheckpointBlockedSources',
    'listOpenIdentityDowngrades', 'listHeldManagedAtomRows', 'readDoctorLastKnown', 'writeDoctorLastKnown',
    'readSyncAdmissionSettingRow', 'readLatestConnectorReceipt', 'listFactsAbsorbFailureGroups',
    'listCredentialResealHoldRows'],
  doctor_sync: ['listManagedSyncCursorFailureRows', 'listManagedSyncOrphanRowsets',
    'listDurableManagedSyncFailureKeys'],
  doctor_brain: ['listInterimStoredObjectCounts', 'readOldestSourceCreatedAt', 'listVisibilityCandidatePages',
    'countVisibilityNoncanonicalHolds', 'listContentBlockedReceipts', 'listPassAdmittedReceipts',
    'listOrphanConnectorCheckpoints'],
  doctor_terminal: ['readTerminalFailureGroups', 'listTerminalFailureBatch', 'listOpenPassCheckpointBlockers',
    'listWorktreeBlockerRequests'],
  doctor_fence_census: ['listFenceCensusSources', 'readFencePassHorizon', 'listFenceCensusPagesById',
    'listFenceCensusPagesUpdated', 'listLiveFencePageIds', 'readFenceScanRecord', 'writeFenceScanRecord',
    'upsertFenceCandidatePart', 'clearFenceCandidateParts', 'readFenceTrendRecords', 'countSegmentedFencePages',
    'readBudgetLedgerDay'],
  doctor_facts_trust: ['countConversationPipelinePages', 'listPersistentWriterContention', 'countRowTrustTiers',
    'countLegacyUnknownBySource', 'listTrustColumns', 'listTrustClaimTargets', 'countClaimLiftedRows'],
  doctor_sources: ['readDoctorSources', 'listGuestSourceRows', 'listCheckoutRoots', 'listPendingRoster',
    'listOwnedContentRows', 'countDefaultSourceFiles'],
  fact_relink_attempts: ['upsertFactRelinkAttempt', 'listFactRelinkOutcomes', 'deleteFactRelinkMemos'],
  fact_relink_writes: ['placeRelinkedFact', 'linkConversationFact', 'listConversationRelinkPages'],
  facts_cycle: ['listActiveFactsForEntity', 'listFreshExtractionOutcomes', 'listFenceRowGroups', 'readFactSubject',
    'listFactsForPage', 'countLegacyFactsPending', 'countUnconsolidatedFactsBySource', 'findBulkFactDays',
    'maxFenceRowNum', 'listStoredFenceFactRows', 'countWorldFacts', 'readFenceRowOccupant'],
  facts_purge: ['countFactFingerprintLeftovers', 'loadPurgeTarget', 'planFactPurgeIds', 'listFactsReconcileBacklog',
    'listRelinkCandidateRows', 'countRelinkCandidates', 'listSimilarActiveFacts', 'findActiveSingleFact',
    'listSingleFactMetadata', 'listUnfencedFactRows', 'listHeldFenceFactRows', 'listWithdrawalSlugs',
    'expireFactsByWithdrawal', 'insertFactPurge', 'settleFactsReconcile', 'lockReconcileRevision',
    'selectFactsReconcileDrain', 'listDerivedRows', 'expireFactsOfGonePages', 'readPurgeSourceLocalPath',
    'insertReasonPurgeTombstones', 'listGitEffectsCarryingReason', 'listPageGitEffectsForStrip', 'setPurgeEffectData',
    'listPageChangeReasons', 'listRequestsRecordingReasons', 'heldEntityPageDeleted', 'readHeldAccessState',
    'heldTargetPageLive', 'listHeldMoveRows', 'listStruckHeldRows', 'readHeldRowVisibility', 'heldMoveDue',
    'readHeldConfigValue', 'readHeldPageLocation', 'readHeldVersionsEdited', 'listSegmentedPageBodies',
    'listSegmentedVersionBodies', 'setPurgeProbeTimeout', 'probePurgeDerivations', 'listBeliefEventsForPurgeProbe',
    'listFactContextsForPurgeProbe', 'listPageSourcePathsForPurge', 'listNearestFactsForPurge',
    'countLegacyDerivedPages', 'vacuumPurgedTables', 'listPageProseHits', 'readPurgeReceiptSourcePath',
    'countPagePurgeTombstones', 'readDeletePageRequest', 'listPurgeEffects', 'countPurgeFingerprintResidue',
    'listStagingPartEdges', 'listStagingsHoldingClaim', 'purgeSubjectPageLive', 'listPurgePagesById',
    'countPurgeVersionsCarryingClaim', 'countPurgeReviewRows', 'listPurgeStreamSlugs', 'findPurgeBlockedPublication',
    'listPagesForPurgeRewrite', 'updatePageBodyForPurge', 'setPurgeVersionBody', 'redactVersionChangeReasons',
    'listSegmentedVersionsForPurge', 'abortPurgedStagings', 'deletePurgedStagingParts', 'deletePageViewDigests',
    'deleteUnreferencedPurgedTexts', 'listPurgeMatchCandidates', 'lockPurgeSource', 'insertHoldingPagePurges',
    'insertTakePurge', 'deletePurgedTakes', 'deletePurgeReviewQueue', 'deletePurgeReviewProposals',
    'deletePurgeDecideProposals', 'deletePurgeTrustProposals', 'deletePurgeOpenLoops', 'deletePurgeWriteGateHolds',
    'deletePurgeWriteGateReceipts', 'deletePurgeTakeProposals', 'blankPurgeCoreEditNotices', 'deletePurgedFacts',
    'deletePurgedChunks', 'listPurgedPageRevisions', 'insertPurgeEffects'],
  facts_repair: ['loopFactDrift', 'closedLoopWithActiveFact', 'listSessionFactsForClassification',
    'listSessionFactTwins', 'listCapturedFactsForClassification', 'countLabelFacts',
    'listExtractorFactsForClassification', 'countPurgedPageFacts', 'listUnwithdrawnFacts',
    'listWorldFactsFromPrivateSources', 'listActiveSourceIds', 'readRepairBrainId', 'listAgentSessionTakeCandidates',
    'listSettledSessionFacts', 'reattributeSessionFacts', 'retireSessionTakes', 'listFenceRewriteRows',
    'listOtherAttributedFactIds', 'listInactiveTakeIds', 'expireCapturedFacts', 'listExpiredFactIds',
    'listPagelessEntityFacts', 'readEntityRehomeState', 'rehomeEntityFacts'],
  facts_trust: ['listFactsForRelevance', 'countUncomparableFacts', 'matchSavedFacts', 'readFactForOwnerAction',
    'listStandingPreferences', 'listLexicalContestCandidates', 'listRestatedPrivateCopies', 'countDerivedFactTaint',
    'listFactProvenance', 'listFactsFromQuotedPages', 'listOwnerTierFacts', 'readFactEntitySlugById',
    'readSupersessionReplacement', 'linkSupersededFact', 'listLivePageTitles', 'listPageAliasNames',
    'listCaptureDuplicateCandidates', 'computeFactFingerprints', 'listClaimConflictPairs', 'countClaimConflictPairs',
    'listUnarchivedSourceIds', 'readPendingWriteReceipt', 'lockSourceShared', 'listOversizedStaleFacts',
    'listLivePersonTitles', 'readLiveFactEntityPage', 'lockAgentWritebackSetting', 'listFactsToRetireFromPage',
    'listContestedProposalPairs', 'recordDerivationEdges', 'expireDerivedFacts', 'deactivateDerivedTakes',
    'softDeleteDerivedPages', 'markNeedsRederive', 'readMemberPageWithdrawal', 'readFactVisibility',
    'readReplacementTarget', 'readPairFactRow', 'expireSupersededFact', 'restoreSupersededFact', 'readFactForForget',
    'expireFactSuperseded', 'expireFactAtDate', 'readWithdrawalAnchor', 'readFactActivity', 'readReviewAcceptedMark',
    'readFactsFtsIndexState', 'swapFactsFtsIndex', 'listAllUnarchivedSourceIds',
    'readEntityNewestFacts', 'matchHeadStems', 'listOntologyStreamSlugs', 'readOntologyRival', 'listBeliefStreamSlugs'],
  trust_tier_reads: ['listCorePageRows', 'listTrustScanRows', 'countUnscannedTrustRows', 'readTrustScanCursor',
    'writeTrustScanCursor', 'listClaimPendingSourceIds', 'readTrustScanCeilings', 'readBeliefHistoryRows',
    'listVisibleBeliefLifetimes', 'listVersionTrustTiers', 'listVersionReasonWriters', 'listPageRefsByIds',
    'listValidTimeIdentities', 'pickValidTimeEdition', 'listAmendmentsNotApplied', 'readPageVersionEdition',
    'readCursorEdition', 'pageAwaitsRederive'],
  derivation_trust: ['lowerTrustTier', 'countDerivedRowTaint', 'stampPageFrontmatter'],
  raw_sql: ['runMigration', 'executeRaw', 'executeRawDirect', 'keywordBoundedRead'],
  code_edges: ['addCodeEdges', 'deleteCodeEdgesForChunks', 'getCallersOf', 'getCalleesOf', 'getEdgesByChunk',
    'hasCodeEdgesSymbol', 'getCodeTraversalCache', 'putCodeTraversalCache', 'clearCodeTraversalCache'],
  eval_capture: ['logEvalCandidate', 'listEvalCandidates', 'deleteEvalCandidatesBefore', 'logEvalCaptureFailure',
    'listEvalCaptureFailures'],
  salience_enrich: ['batchLoadEmotionalInputs', 'setEmotionalWeightBatch', 'getRecentSalience', 'listEnrichCandidates',
    'findAnomalies', 'countZeroWeightWithTakes'],
  trust: ['hasCoveringFactWithdrawal', 'insertFactWithdrawal', 'isFactWithdrawn', 'isFactPurged',
    'listFactWithdrawalDates', 'moveFactWithdrawalSubject', 'hasFactWithdrawalForSubject', 'listFactWithdrawalKeys',
    'readFactCacheWatermark', 'readTrustGeneration', 'upsertWriteGateReceipt', 'upsertPageWriteGateReceipt',
    'deleteStalePageWriteGateReceipts', 'listWriteGateReceiptsFor', 'deleteStaleWriteGateReceipts',
    'upsertWriteGateHold', 'listWriteGateHoldRows', 'getWriteGateHoldRow', 'decideWriteGateHold',
    'listTrustAllowRuleRows', 'readSourcePurgeFlags', 'lockFactForWithdrawal', 'queueWithdrawalReview',
    'listSegmentedPagesBySlug', 'bumpWithdrawnPageRevisions', 'readPageRevisions', 'appendFactForgetReason',
    'readFactWithdrawnRow', 'readFactWithdrawnBacking'],
  open_loops: ['upsertOpenLoop', 'listOpenLoops', 'readEntityOpenLoops', 'closeOpenLoop'],
  entity_identities: ['linkEntityIdentityRow', 'unlinkEntityIdentityRow', 'listEntityIdentityRows',
    'readEntityIdentityIdsForPages', 'readCanonicalTwin'],
  cli_reads_import: ['listSourceRecords', 'readSourceIncarnation', 'readSyncDispatchRow', 'hasCompanyBrainReceipt',
    'readGuestSourceRow', 'listGuestSourceIds', 'hasGuestSource', 'readPageTrustRows', 'readRowTrustRows',
    'readDatabaseClock', 'listLinkPageMetadata', 'listStoredTimelineRows', 'filterPagesAtRevision'],
  wanted_links: ['lockRegisteredSourceIds', 'replaceWantedLinkRows'],
  write_misc: ['readSourceState', 'readAdmissionSource', 'sharedSkillPackTablePresent', 'listSharedSkillPackRoots',
    'getWorktreeBinding', 'isSourceClaimed', 'hasExtractedEvents', 'listActiveAccessMembers',
    'listAppliedPolicyRevisions', 'readMayActFor', 'readAudiencePrincipals', 'readJobPrincipal', 'readAccessMembers',
    'readAccessCredentials', 'revokeAccessTokensNamed', 'revokeAccessToken', 'deleteOAuthClient',
    'listAudienceAccessMembers', 'readAccessGroups', 'listPagesNamingReader', 'readLiveMember',
    'hasLabelledOnlyMember', 'readFolderAccess', 'readAccessStoreConfig', 'writeAccessStoreConfig',
    'ensureAccessPolicyState', 'lockAccessPolicy', 'listAccessRules', 'readAccessPolicyRevisions',
    'listAccessCoverage', 'readAccessStateUnreadable', 'applyAccessRuleChanges', 'restampAccessWindow',
    'finishAccessRestamp', 'insertAccessPolicyRevision', 'markAccessRevisionsApplied', 'approveAccessPolicyRevision',
    'hasAccessPolicyState', 'listAccessPrefixSlugs', 'readAccessPolicyMarks', 'replaceAccessInvalidCoverage',
    'listUnboundTokenNames', 'listUnboundClientIds', 'readLiveAccessToken', 'recordTokenSetupReads',
    'listKeysReadingSource', 'countCompanyPages', 'revokeAccessTokenById', 'readUnfinishedAccessMigration',
    'insertAccessMigration', 'recordAccessMigrationPhase', 'switchAccessMigration', 'listAccessPolicySources',
    'countPeopleFolderPages', 'countOpenPages', 'expireMemoryProposals', 'listAwaitingMemoryProposals',
    'purgeMemoryProposals', 'attachSourcePath', 'readMemoryProposal', 'readPendingProposalSummary',
    'listMemoryProposalRows', 'listOwnerProposalRows', 'readOpCheckpointKeys', 'writeOpCheckpointKeys',
    'appendOpCheckpointPaths', 'deleteOpCheckpoint', 'deleteOpCheckpointPaths', 'purgeStaleCheckpoints',
    'readHealthMemoClock', 'listSynopsisSourceIds', 'hasSynopsisFrontmatterOverride'],
  write_attribution: ['readWriteAttributionNames', 'readPageRevisionAttribution', 'readVersionAttributions',
    'readOldestVersionAttribution', 'readRowAttribution'],
  telemetry: ['recordSearchTelemetry', 'readSearchStats', 'readClientOpUsage', 'readMcpRollupPrunedBefore',
    'logMcpRequest', 'readMcpLogPruneCutoff', 'pruneMcpRequestLogBatch', 'readMcpLifetimeUsage', 'logChatUsage',
    'readChatUsage', 'countMcpRequestsLastDay', 'countMcpRequestsLastDayByToken', 'readPendingWriteHealth',
    'readMcpRequestLogPage'],
  field_usage: ['readFieldUsageSamples'],
  session_state: ['upsertSessionState', 'readSessionCursor', 'readDeltaSessionRow', 'readCheckpointManifestRow',
    'writeCheckpointManifest', 'ageOutSessionState', 'capSessionStatePerClient'],
  alias_fanout_reads: ['findPagesByTitles', 'resolveCaseSensitiveAliases', 'readPageTitle', 'readPageAliasRows',
    'readEntityAliasRows'],
  write_guards: ['readPageOrigin', 'listOriginClaims', 'bindPageOrigin', 'stampPageIngest', 'sealImportedPage',
    'readLivePageBody', 'readInlinePageRegions', 'readStoredPageTier', 'readPageIndexingState', 'hasSegmentStorage'],
  page_visibility: ['readPageHiddenFromCaller', 'readCallerPageAccess', 'readWriteVisibilityProbe',
    'readWriterSlugFence'],
  large_page: ['readStoredBodyBytes', 'readPageBodySizes'],
  relational_reads: ['readAdmittedPageRefs', 'readPageSynopses', 'readSeedTitleSlugs'],
  trust_fence: ['listFenceFactRows', 'restorePageTrust', 'listHeldRows', 'listGuardedTakeRows'],
  trust_proposals: ['insertTrustProposal', 'getTrustProposal', 'listTrustProposals', 'pendingTrustProposalsFor',
    'updatePendingTrustProposalAfter', 'transitionTrustProposal', 'listPendingContradictions', 'listUnreadablePrivacyHoldIds'],
  connect_gate: ['hasPersistenceTable', 'listManagedRootBindings', 'readGraduationGateRow', 'listRetiredDeactivations'],
  jobs_wake: ['openWakeWatch', 'listWakeWatches', 'endWakeWatches', 'countWakeWatches', 'readWakeDoctor',
    'countPendingWakeForgets', 'listWakeCrons', 'addWakeCron', 'removeWakeCron', 'hasWakeCron', 'recordWakeCronRun',
    'hasWakeTermsAcceptance', 'recordWakeTermsAcceptance', 'listDueWakeWatches', 'claimWakeWatch', 'settleWakeWatch',
    'queueWakeForget', 'claimWakeForgets', 'settleWakeForget', 'forgetWakeMember', 'forgetWakeCredential'],
  cli_reads_export: ['setLocalStatementTimeout', 'listExportPageKeys', 'readExportWithdrawalLedgerBytes',
    'listExportWithdrawals', 'readExportPageRows', 'normalizeFenceLines', 'readSegmentedPageHead',
    'readBodyManifestRows', 'readBodyManifestMeta', 'listAccessPolicySourceIds', 'readBodyManifestOutline',
    'listForcedCutSeqs', 'readManifestSeqAt', 'readSegmentedVersionBodyBytes'],
  facts_cycle_sites: ['listPhantomFactRows', 'listCanonicalFenceRowNums', 'moveFactToPage', 'repointInboundLinks',
    'repointOutboundLinks', 'pageHasTimelineEntries', 'maxFenceRowNumOfPage', 'listRootPageSlugsAfter',
    'listOwnLinkIds', 'listActiveFactIdsOfPage', 'listFactIdsStillOnPage', 'listLinkIdsOnPage', 'readPageFileOrigin',
    'listFenceRowClaims', 'adoptFactIntoFence', 'listFenceRowSupersession', 'setFactSupersededBy',
    'listHeldWideningFactIds', 'expireFactInPlace', 'expireAndDetachFact', 'updateFenceFactCells',
    'listExpirableFactIdsOfDeletedPage', 'readDeletedPageBody', 'expireFactsByIds', 'listOntologyObservationSlugs',
    'listDeletedPageSlugsWithActiveFacts', 'scanUnfencedFactRows', 'listHeldFactRows', 'listFencedFactsOfMissingPages',
    'readFenceRowNumHint', 'readSourceCheckoutPath', 'readLiveStoredBody', 'listPageStates',
    'countSegmentedVersionsOfPage'],
  facts_recall: ['readFactsEmbeddingColumn', 'listNearestFacts', 'listSlotRows', 'listPoolUnbackedKeys',
    'listCallOffCueFacts', 'listPoolEntityPairs', 'listFactRowsByIds',
    'listReadablePageSlugs'],
  facts_conversation: ['readNewestConversationFactId', 'findSpentConversationRequest', 'listConversationBatchRequests',
    'readStoredConversationEntry', 'readPrincipalCounters', 'countConversationPagesToExtract',
    'listMergedEntityAliases', 'moveConversationSourceWindows', 'stampConversationSourceWindows',
    'countActiveConversationFacts', 'readConversationSlotValueHash', 'deleteConversationOutcomeRows',
    'listPurgeTombstoneMatches', 'maxConversationRowNum', 'listHeldFactSlots', 'countPageConversationFacts',
    'countConversationWindowFacts', 'countConversationFactsOutsideWindows', 'clearConversationPageFacts',
    'findSameClaimFenceRow', 'findOntologyTwin', 'readRelinkSource', 'factRelinkAttemptsTableExists',
    'readReextractOutcomeRow', 'listUnbackedConversationRows', 'listUnlinkedConversationRows', 'listEntityHintPages',
    'lockPageById', 'listClearedRelinkedFacts', 'countEmbeddedFactsAmong'],
  memory_mutation_reads: ['readSourceWriteRow', 'readSourceLocalPath', 'readFactEntitySlug', 'hasLiveFileBackedPage',
    'factReadableUnder', 'readRemoteForgetTier', 'readForgetTarget', 'isFactEntityUnbacked', 'readLinkedFactCopies',
    'hasHiddenFactCopy', 'ownerReachesFact', 'readFactWithdrawalClaim'],
  withdrawal_discovery: ['readWithdrawalDiscovery'],
  withdrawal_pages: ['listSegmentedPages', 'invalidateWithdrawnPages'],
  withdrawal_fence: ['hasWithdrawnFenceClaim'],
  calibration_profiles: ['getLatestCalibrationProfile', 'isCalibrationProfileUnchanged', 'insertCalibrationProfile',
    'readVoiceGateHealth', 'purgeCalibrationProfilesByWave'],
  decide_proposals: ['insertDecideProposal', 'getDecideProposal', 'listDecideProposalIds', 'listDecideProposals',
    'transitionDecideProposal', 'listDecideProposedPairs', 'insertDecideReviewProposal', 'listDecideReviewProposals',
    'getDecideReviewProposal', 'transitionDecideReviewProposal', 'listDecideReviewProposalIds',
    'readProposalReviewRates', 'listDueDecideReviewQueue', 'applyDecideReviewQueue', 'listDueDecideSweepDeferred',
    'applyDecideSweepDeferred'],
  decide_store: ['readDecideState', 'upsertDecideState', 'deleteDecideState', 'ensureDecideState', 'insertDecideSpend',
    'dailyDecideSpend', 'listDecideSpendBySlot', 'insertDecideReceipts', 'pruneDecideReceipts', 'decideSlotUsage',
    'decideConflictNoEntityCounts', 'listDecideReplayReceipts', 'listDecideResolvedModels',
    'listDecideMixedModelDecisions', 'insertDecideCalibration', 'storeDecideQualification', 'listDecideCalibrations',
    'getDecideCalibration', 'setDecideCalibrationRetired'],
  owner_only: ['ownerOnlyMarkTriggers'],
};

/** Callable members of `interface BrainEngine`, in declaration order (`kind` excluded). */
export function interfaceMethods(): string[] {
  const text = readFileSync(ENGINE_FILE, 'utf8'); // test-reads-source-ok[structural]: parse the interface member names only.
  const sf = ts.createSourceFile(ENGINE_FILE, text, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  sf.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== 'BrainEngine') return;
    for (const member of node.members) {
      if (!member.name || !ts.isIdentifier(member.name)) continue;
      const callable = ts.isMethodSignature(member)
        || (ts.isPropertySignature(member) && member.type !== undefined && ts.isFunctionTypeNode(member.type));
      if (callable && !names.includes(member.name.text)) names.push(member.name.text);
    }
  });
  if (names.length === 0) throw new Error('engine-parity coverage: BrainEngine interface not found in src/core/engine.ts');
  return names;
}

export interface ParityDeclaration { file: string; name: string; methods: string[]; requires?: EngineCapability }

function stringValue(node: ts.Node): string | null {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

/** Every `parityTest(name, { methods: [...] }, fn)` declaration in the parity files. */
export function parityDeclarations(dir = PARITY_DIR): ParityDeclaration[] {
  const out: ParityDeclaration[] = [];
  for (const entry of readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort()) {
    const path = join(dir, entry);
    const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'parityTest') {
        const [nameArg, optsArg] = node.arguments;
        const where = `${relative(REPO, path)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        const methodsProp = optsArg && ts.isObjectLiteralExpression(optsArg)
          ? optsArg.properties.find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'methods')
          : undefined;
        if (!methodsProp || !ts.isPropertyAssignment(methodsProp) || !ts.isArrayLiteralExpression(methodsProp.initializer)) {
          throw new Error(`${where}: parityTest needs an inline { methods: [...] } array literal`);
        }
        const methods = methodsProp.initializer.elements.map((e) => {
          const value = stringValue(e);
          if (value === null) throw new Error(`${where}: parityTest methods must be string literals`);
          return value;
        });
        const requiresProp = (optsArg as ts.ObjectLiteralExpression).properties
          .find((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'requires');
        let requires: EngineCapability | undefined;
        if (requiresProp) {
          const value = ts.isPropertyAssignment(requiresProp) ? stringValue(requiresProp.initializer) : null;
          if (value === null) throw new Error(`${where}: parityTest requires must be a string literal`);
          missingCapability(value as EngineCapability); // throws on an unknown capability
          requires = value as EngineCapability;
        }
        out.push({ file: relative(REPO, path), name: (nameArg && stringValue(nameArg)) ?? '<dynamic>', methods, ...(requires && { requires }) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/** Interface methods the legacy Postgres-gated parity suite calls (`.name(`). */
export function legacyMethods(methods: readonly string[]): Set<string> {
  const called = new Set<string>();
  const files = readdirSync(LEGACY_DIR).filter((f) => /^engine-parity.*\.test\.ts$/.test(f));
  for (const f of files) {
    const text = readFileSync(join(LEGACY_DIR, f), 'utf8');
    for (const m of methods) if (new RegExp(`\\.${m}\\s*[!?]?\\.?\\s*[(<]`).test(text)) called.add(m);
  }
  return called;
}

export interface CoverageReport { methods: string[]; covered: string[]; text: string }

export function buildCoverage(): CoverageReport {
  const methods = interfaceMethods();
  const family = new Map<string, string>();
  for (const [name, members] of Object.entries(FAMILIES)) {
    for (const m of members) {
      if (family.has(m)) throw new Error(`engine-parity coverage: ${m} is in two families`);
      family.set(m, name);
    }
  }
  const unassigned = methods.filter((m) => !family.has(m));
  const stale = [...family.keys()].filter((m) => !methods.includes(m));
  if (unassigned.length || stale.length) {
    throw new Error(`engine-parity coverage: FAMILIES out of date. Unassigned: ${unassigned.join(', ') || '-'}; not in BrainEngine: ${stale.join(', ') || '-'}`);
  }
  const cases = new Map<string, number>();
  const requirements = new Map<string, Array<EngineCapability | undefined>>();
  for (const decl of parityDeclarations()) {
    for (const m of decl.methods) {
      if (!family.has(m)) throw new Error(`${decl.file} "${decl.name}": ${m} is not a BrainEngine method`);
      cases.set(m, (cases.get(m) ?? 0) + 1);
      requirements.set(m, [...(requirements.get(m) ?? []), decl.requires]);
    }
  }
  /** What `arm` must do for `m`: it runs when any covering case runs there, else the first missing capability's label. */
  const armCell = (m: string, arm: ParityArmName): string => {
    const reqs = requirements.get(m);
    if (!reqs) return '-';
    if (arm === 'rust') {
      // The Rust engine serves the member (it must match PGLite, bar a row in test/rust-expected-divergence/) or refuses its capability.
      const refusal = rustRefusal(m);
      return refusal === null ? 'serves' : `refuses:${refusal}`;
    }
    if (reqs.some((r) => armHas(arm, r))) return 'yes';
    return missingCapability(reqs.find((r) => r !== undefined)!).label;
  };
  const legacy = legacyMethods(methods);
  const covered = methods.filter((m) => cases.has(m));
  const familyOrder = Object.keys(FAMILIES);
  const rows = [...methods].sort((a, b) =>
    familyOrder.indexOf(family.get(a)!) - familyOrder.indexOf(family.get(b)!) || methods.indexOf(a) - methods.indexOf(b));
  const perFamily = familyOrder.map((f) => {
    const members = methods.filter((m) => family.get(m) === f);
    return `# ${f}: ${members.filter((m) => cases.has(m)).length}/${members.length}`;
  });
  const lines = [
    '# BrainEngine parity coverage. GENERATED by `bun test/engine-parity/coverage.ts --write`; do not edit.',
    '# covered = called by a test/engine-parity harness case; the per-arm columns say where that case runs.',
    '# legacy_e2e = called by the Postgres-gated test/e2e/engine-parity*.test.ts suite (informational).',
    '# pglite/postgres/rust = what each arm must do: yes (runs, compared), serves (the Rust engine serves the member: with',
    '#   GBRAIN_TEST_RUST_ARM=1 its case must match PGLite, end on the typed refusal of an option or input the member declines',
    '#   (source_path writes, listColumnsOnly, vectors, fuzzy resolveSlugs, multi-source getChunks), or differ only as a row in',
    '#   test/rust-expected-divergence/ names),',
    '#   refuses:<capability> (throws engine_capability_missing), n/a:<why> (no such member on that arm), - (not covered).',
    `# covered: ${covered.length}/${methods.length}`,
    ...perFamily,
    ['method', 'family', 'covered', 'parity_cases', 'legacy_e2e', ...PARITY_ARMS].join('\t'),
    ...rows.map((m) => [m, family.get(m), cases.has(m) ? 'yes' : 'no', cases.get(m) ?? 0, legacy.has(m) ? 'yes' : 'no',
      ...PARITY_ARMS.map((arm) => armCell(m, arm))].join('\t')),
  ];
  return { methods, covered, text: `${lines.join('\n')}\n` };
}

if (import.meta.main) {
  const report = buildCoverage();
  if (process.argv.includes('--write')) {
    writeFileSync(COVERAGE_FILE, report.text);
    console.log(`wrote ${relative(REPO, COVERAGE_FILE)}: covered ${report.covered.length}/${report.methods.length}`);
  } else {
    process.stdout.write(report.text);
  }
}
