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
  lifecycle: ['connect', 'disconnect', 'reconnect', 'initSchema', 'listCatalogRelations', 'readCatalogSchemaVersion', 'listCatalogForeignKeys', 'holdSchemaMigrationLock', 'transaction', 'transactionDirect',
    'registerBeforeDisconnect', 'withReservedConnection'],
  pages: [
    'getPage', 'readPageSnapshot', 'readPageSnapshotsBatch', 'lockPageKeys', 'putPage', 'findDuplicatePage', 'findDuplicatePages',
    'deletePage', 'deletePages', 'resolveSlugsByPaths', 'softDeletePage', 'softDeletePages', 'restorePage', 'purgeDeletedPages',
    'listPages', 'findPages', 'countPagesBy', 'resolveSlugs', 'getAllSlugs', 'listAllPageRefs', 'listEntityKeyRows', 'listIdentityDecisions', 'listRestrictedIdentityMembers', 'applyIdentityDecisions', 'listAllSources', 'listSourceLocalPaths', 'listLocalPathSources', 'readPlainSyncSource', 'readOwnerOnlySourcesPresent', 'readOwnerOnlySourceConfig', 'listSourceRoutingRows',
      'countRepoBoundSources', 'listNotifierHostSourceRows',
    'countDefaultSourceSplit', 'listStaleSyncSourceIds', 'readSourceRow', 'lockSourceRow', 'countSourcePages', 'insertSource', 'updateSourceConfig', 'getSource', 'readSourceDeleteImpact', 'deleteSourceRecord', 'markSourceSynced',
    'listPrefixSampledPages', 'listCorpusSample', 'bumpPageRetrievals', 'getPageSealState', 'refreshPageOrigin',
      'advanceSourceCommit', 'listSourcePathPages', 'listQuarantinedSlugs', 'readRenameIdentityRows', 'readLiveIdentityHolders', 'readPageSizeRows', 'holdPageEmbedding', 'readReasonPurgeTombstones', 'writeReasonPurgeTombstones',
    'readLivePageIdBySlug', 'readPageTierRef', 'readPageTierRows', 'pageHasFrontmatterKey',
    // the atoms-restore and moved-pages repair reads (engine-sql/atom-restore-reads.ts, moved-page-reads.ts)
    'listRestorableAtoms', 'countKeptAtomRetirements', 'listLivePagesBySourcePaths', 'listLivePagesByFileName',
    // the batch 7 stale-atoms read (engine-sql/stale-atom-reads.ts)
    'listStaleAtoms',
    'listLivePagesSharingFrontmatterId', 'hasSegmentedHistory', 'readLivePagesByIds', 'lockSourceForUpdate'],
  search: ['searchKeyword', 'countKeywordPages', 'searchKeywordPages', 'searchTitles', 'searchVector', 'getEmbeddingsByChunkIds',
    'searchKeywordChunks'],
  search_reads: ['cosinesByChunkIds', 'hasSupersedeEdges', 'supersedingPageSlugs', 'aliasCanonicalRefs', 'pageCollapseFacts',
    'slugsEndingIn', 'generatedPagesIn', 'livePageIdsAt', 'pagesLinkingTo'],
  link_reads: ['inboundLinkCoverage', 'listJunkEntityHubs', 'countEntityPages', 'entityGraphCoverage', 'countForeignEdges',
    'listLivePageSummaries', 'countInboundLinks', 'readEntityInboundEdges', 'listLinkEndpointPages', 'listPagesTitledIn', 'wordLexemes',
    'readLinkContextMatches', 'readLinkContextOriginPages'],
  link_temporal: ['readLinkRelationshipEvidence', 'writeLinkRelationshipState', 'linkRelationshipKeysForPages', 'staleLinkRelationshipKeys',
    'linkRelationshipKeysForOrigin', 'applyLinkTemporalRows', 'writeManualLinkTransitions', 'removeManualLinkTransitions',
    'listRelationshipNoteRows', 'edgeValidityCounts', 'listPageStatusByRef', 'listRecordMetadataRows'],
  search_vector: ['countSearchVectorRows', 'replaceSearchVectorTriggerFunction', 'backfillSearchVectors', 'ensureFactsKeywordIndex'],
  retrieval_coverage: ['countPendingProjectionPages', 'countEmbeddingHeldPages', 'projectionRebuildProgress',
    'readProjectionReadinessGeneration', 'readProjectionReadiness'],
  chunks: ['upsertChunks', 'sealChunks', 'getChunks', 'getChunkPage', 'getChunkWindows', 'countStaleChunks', 'sumStaleChunkChars',
    'setPageEmbeddingSignature', 'invalidateStaleSignatureEmbeddings', 'invalidateContentDriftEmbeddings', 'listStaleChunks',
    'readPageEmbeddingBudget', 'recordPageEmbeddingHold', 'openPageEmbeddingHold', 'reservePageEmbedding', 'settlePageEmbeddingReservation',
    'readEmbeddingCompletion', 'lockEffectClaimRow', 'lockEmbeddingSwitch', 'installChunkEmbeddings',
    'countChunklessPagesWithContent', 'listChunklessPagesWithContent', 'readEmbeddingStateCounts', 'listEmbeddingStateRows',
    'deleteChunks', 'getChunksWithEmbeddings', 'deleteChunksExcept', 'setChunkerVersion', 'readSourceChunkerVersion', 'setSourceChunkerVersion', 'writeTextProjectionSeal',
    'moveChunkIndexes', 'getChunkReuseRows', 'findCodeDefinitions', 'listSymbolTypesForName', 'findCodeRefChunks',
    'countOversizedEmbedSkips', 'countOrphanChunks', 'countCodeChunkPages', 'codeChunksExist', 'hasUnsealedPages', 'currentCodeChunksExist',
    'listQualifiedSymbolNames', 'listWithdrawalChunks', 'deleteChunksForPages', 'listContextualModeCandidates', 'resolveFrozenHits', 'readSegmentRegions'],
  extraction: ['countStalePagesForExtraction', 'listStalePagesForExtraction', 'markPagesExtractedBatch', 'markPagesAttendanceBlocked',
    'countStaleFrontmatterKeyPages', 'listStaleFrontmatterKeyPages', 'stripStaleFrontmatterKeys',
    // the extract receipt write's page reads and the extract_rollup_7d day upsert
    'readExtractReceiptSlot', 'readExtractReceiptSeal', 'upsertExtractRollupDay'],
  links: ['addLink', 'addLinksBatch', 'replaceDerivedLinks', 'replaceDerivedLinksBatch', 'removeLink', 'removeLinksByPagesAndSource',
    'getLinks', 'getBacklinks', 'listLinkSources', 'findByTitleFuzzy', 'traverseGraph', 'traversePaths', 'traversePathsDetailed',
    'relationalFanout', 'relationalChainHop', 'getBacklinkCounts', 'getAdjacencyBoosts', 'getContentFlagsByPageIds',
    'getUnverifiedExtractionPageIds', 'getPageTimestamps', 'getEffectiveDates', 'getSalienceScores', 'findOrphanPages'],
  tags: ['addTag', 'removeTag', 'getTags', 'pruneFrontmatterTags', 'addPageTagsById'],
  timeline: ['addTimelineEntry', 'addTimelineEntriesBatch', 'getTimeline', 'getTimelineForDate', 'getSince', 'getOnThisDay',
    'getLastSeen', 'upsertEventProjection', 'listEventProjectionRows', 'readEventProjectionId', 'deleteEventProjections', 'restoreEventProjection', 'removeTimelineRows', 'updateTimelineDetails', 'insertCanonicalTimelineRows', 'sampleEffectiveDates',
    'sampleEffectiveDateSources', 'readMaxTimelineEntryId', 'listStoredTimelineRowsOrdered', 'deleteTimelineRows',
    'storedTimelineRowsByPageIds', 'countSegmentedTimelinePages', 'countTimelineCommentMarkupRows', 'listTimelineOrphanPages',
    // the timeline repair kinds (engine-sql/timeline-repair-reads.ts)
    'listTimelineHistoryPages', 'listTimelineVersionWitnesses', 'readTimelineVersionBody', 'listTimelineMarkupRows',
    'listMaterializedMarkerPages', 'rewriteTimelineRow', 'listDateBulletPages', 'listConnectorFencePages'],
  ontology: ['mergeOntologyFact', 'getOntology', 'discoverOntologyDimensions', 'findOntologyConflicts',
    'listRekeyLosers', 'repointSupersededToKept', 'clearOntologySlots', 'deleteRekeyLosers',
    'restoreOntologyFact'],
  raw_files: [
    'putRawData', 'getRawData', 'upsertFile', 'getFile', 'listFilesForPage',
    'hasFileWithHash', 'listFileRowsForVerify',
    'readSourceLocalPathForVerify', 'upsertCliFileRow', 'upsertRawFileRow', 'upsertSyncFileRow',
    'sourceIdExists', 'readPageIdInSource', 'readFileOwner', 'claimFilePage',
    'upsertOpFileRow', 'listReadableFileRows', 'readReadableFileForUrl', 'readReadablePageId',
    'countUnreadableFilesAt', 'countFilesRegisteredElsewhere', 'registerFileRow', 'readReadableFileForVerify',
    'listReadableFilePaths', 'listFiles',
  ],
  takes: ['addTakesBatch', 'updateTakeEmbeddings', 'listTakes', 'searchTakes', 'searchTakesVector', 'getTakeEmbeddings',
    'countStaleTakes', 'listStaleTakes', 'updateTake', 'supersedeTake', 'resolveTake', 'getScorecard', 'getCalibrationCurve',
    'addSynthesisEvidence', 'listActiveTakesForPages', 'matchTakeRows', 'deleteTakeRows',
    // group D (takes reads)
    'countOffGridTakeWeights', 'countTakes', 'planFactPurgeTakes', 'listTakeRowsForPage', 'readTakePreimages', 'countMcpResolvedTakes',
    'listTakeSupersessionCandidates', 'listHeldFenceTakeRows',
    // the reads and the delete of `gbrain extract takes`
    'listTakeIdsLeavingFence', 'listTakePreimages', 'deleteTakesByIds', 'findTakeId',
    // the take-supersession repair (engine-sql/takes-reads.ts)
    'listTakePointers', 'listTakeSupersedeReceipts', 'setTakeSupersededBy',
    // the accepted-takes repair (engine-sql/takes-reads.ts)
    'listAcceptedTakeRemovals', 'readTakeRowTier',
    // the batch 7 lost-fence-rows take reads (engine-sql/lost-fence-reads.ts)
    'hasTakeClaim', 'listTakeRowNums', 'readTakeRowTierByClaim', 'listLatestTakeGrades', 'readTakeGrade', 'insertTakeGrade', 'deleteTakeGrade', 'readLiveTakePage', 'readTakeClaim', 'upsertTakeHorizon', 'deleteTakeHorizon', 'listTakeHorizons', 'listHorizonScanRows', 'listWaveAppliedTakeIds', 'revertWaveTakeResolutions', 'unapplyWaveTakeGrades', 'purgeTakeNudgesByWave', 'insertTakeNudge', 'listTakeNudges', 'listPendingTakeProposals', 'readTakeProposal', 'claimTakeProposal', 'readStrandedTakeProposalClaim', 'releaseTakeProposalClaim', 'setTakeProposalPromotedRow', 'rejectTakeProposal', 'takeProposalCached', 'listRejectedTakeProposalClaims', 'insertTakeProposal', 'listTakeProposalTombstones', 'deleteTakeProposalTombstones', 'listProposeTakesCandidatePages', 'readOpCheckpointDoc', 'writeOpCheckpointDoc', 'listWriteRequestsByRequestId'],
  dream: ['getDreamVerdict', 'putDreamVerdict', 'sweepDreamVerdicts',
    // dream cycle (engine-sql/dream-cycle.ts)
    'listDreamQueueCandidates', 'listLiveDreamCycleLocks', 'readDreamJobStatus', 'ensureDreamMapConfigRow',
    'lockDreamMapConfigRow', 'writeDreamMapConfigRow', 'recordDreamBreakerReset', 'stampDreamPageProvenance',
    'listDreamPageIds', 'countDreamProvenancePages', 'readDreamDeferralReceipt', 'listConsolidationClaimValues',
    'setConsolidatedFactValidUntil', 'listReadersSourcedFactIds', 'findConsolidationPageIds', 'readConsolidationTakesMaxRowNum',
    'findConsolidatedTakes', 'refreshConsolidatedTakeSource', 'findConsolidatedTakeIds', 'listConsolidationClaimShapes',
    'listRetainedDreamOutputSources', 'readDreamSourceIncarnation', 'listDreamAtomPages', 'listSynthesisPageBodies',
    'listLaterPersistenceRequests', 'listCommittedOutputRequests', 'readDreamVerifyEpoch', 'listDreamJobCreatedAt',
    'readDreamPreRunRevision', 'listCompletedSynthJobs', 'countCoalescibleSynthJobs', 'listWaitingChildJobIds',
    'listDreamChildJobTimings', 'countRecentDreamSynthSubmissions'],
  contradictions: ['writeContradictionsRun', 'loadContradictionsTrend', 'getContradictionCacheEntry', 'putContradictionCacheEntry',
    'sweepContradictionCache',
    'listEdgeContradictionCandidates', 'listKnownEdgeProposals', 'listLinkContexts', 'recordEdgeProposal', 'readEdgeProposal',
    'edgeClosureLanded', 'readEdgeProposalEvidence', 'readEdgeProposalHash', 'markEdgeProposalStale', 'setEdgeProposalStatus',
    'rejectOpenEdgeProposal', 'markEdgeProposalUndone', 'markRevertedEdgeProposals', 'listLiveChunksByIds', 'listLiveTakesByIds',
    'readLastContradictionsPromptVersion', 'listEvalCandidateQueries'],
  facts: ['insertFact', 'insertFacts', 'deleteFactsForPage', 'expireFact', 'listFactsByEntity', 'listFactsSince', 'listFactsKeyset',
    'listFactsBySession', 'listSupersessions', 'countUnconsolidatedFacts', 'findCandidateDuplicates', 'consolidateFact',
    'findTrajectory', 'getFactsHealth', 'listFenceRetireCandidates', 'readFactPreimages', 'restoreFactPreimage',
    'listFactIdsBySourcePrefix', 'expireFactRows',
    // the batch 7 lost-fence-rows fact reads (engine-sql/lost-fence-reads.ts)
    'hasActiveFactText', 'readFactTrustTier', 'listFenceFactRowNums', 'readLiveFactRowTier'],
  segmented_body: ['allocateBodyOccurrenceIds', 'stageSegmentTexts', 'readSegmentTexts', 'stageManifestRows', 'readManifest', 'readSegmentedEmbedPage',
    'stageSegmentChunks', 'createSegmentedPageShell', 'flipBodyGeneration', 'sealSegmentedPage', 'openBodyStaging', 'setBodyStagingState', 'sweepSegments',
    'readSegmentDerivations', 'upsertSegmentDerivations', 'retireSegmentDerivations',
    'lockBodyStagingState', 'deleteUnstagedSegmentChunks', 'deleteRewrittenSegmentDerivations'],
  versions: ['createVersion', 'getVersions', 'revertToVersion', 'readLatestVersionId', 'readLatestVersionIdAtTier', 'stampVersionChangeReason', 'pruneHoldingPageVersions',
    // the batch 6a history repair reads (engine-sql/version-reasons.ts, overwrite-reads.ts)
    'listVersionsByChangeReason', 'replaceVersionChangeReasons', 'listRetainedVersionBodies', 'readArchivedVersionBody',
    'listOverwriteCandidates', 'listVersionsAfter', 'listOverwriteLivePages', 'readVersionContent',
    // the batch 7 lost-fence-rows version read (engine-sql/lost-fence-reads.ts)
    'listInlineVersionTexts'],
  stats_ingest: ['getStats', 'getHealth', 'countOnboardSignal', 'logIngest', 'getIngestLog', 'countBrainLivePages', 'countLivePagesBySource', 'countChunksBySource', 'readBrainMaturity', 'listVisiblePageSlugs', 'readPagesForVersionHistory'],
  sync_aliases: ['updateSlug', 'rewriteLinks', 'resolveSlugWithAlias', 'resolveSlugWithAliasDetailed', 'resolveAliases',
    'setPageAliases', 'replaceDerivedAliases', 'refreshPageBody', 'updatePageContextualRetrievalState', 'migrateFactsToCanonical'],
  config: ['getConfig', 'setConfig', 'unsetConfig', 'listConfigKeys', 'getAllConfig', 'getConfigValues', 'readStoredConfigValue'],
  import_guards: ['readManagedModeRows', 'getSourceStrictness', 'readPersistenceBrainId', 'readLocalWriterRow', 'insertLocalWriterRow',
    'readTransactionSettings', 'applyTransactionSettings', 'beginSnapshotRead', 'readCurrentWriteTrust', 'setWriteContext', 'readLedgerSource', 'isFolderRestricted', 'listCoveredSources'],
  persistence_journal: ['readJournalLimitRows', 'readHeldPageRows', 'readHeldCoverageRows', 'listFenceHoldRows', 'readWriteRequest', 'readWriteRequestById', 'listWriteRequestRows',
    'readWriteRequestProgress', 'countOutstandingBySource', 'ownsSchemaTables', 'readCounterRows', 'readAdmissionRate', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'lockWriteRequest', 'completeWriteRow', 'lockWriteRequestsById', 'compactTerminalIntent', 'cancelWriteRow', 'insertPublicationEffects', 'insertWithdrawalEffects', 'readSourceMembership',
    'readSourcePurgeEpoch', 'listGenerationSourceIncarnations', 'readChronicleDepthRow', 'listChronicleOwnedHashes', 'listRetiredGenerationItemKeys',
    'listPageContentHashes', 'listLiveGenerationItems', 'hasChronicleSkipDecision', 'pageSlugExists', 'listOrphanedChronicleOwners',
    'listChronicleEventSlotRows', 'readGitHoldRecords', 'readGitHoldRetryRequest', 'readGitHoldReportInputs', 'lockGitHoldSummary', 'adjustGitHoldSummary',
    'readGitHoldRow', 'writeGitHoldRow', 'replaceGitHoldRow', 'deleteGitHoldRow', 'countGitHolds', 'readGitHoldListingRows', 'readGitHoldCodeCountRows',
    'readGitImageHoldCountRows', 'readSyncConversionRows', 'readSyncPassRow', 'readLiveSyncPassRows', 'writeSyncPassRow', 'readSyncStatusSourceRow',
    'readSyncStatusCommittedRow', 'readManagedSyncCursorHeader', 'readRetiredManagedSyncCursor', 'readManagedSyncFailureRows',
    'readOrphanedManagedSyncFailureRows', 'readSyncHeadRequestRow', 'readSyncRecoveryProbeRow', 'readIdentityDowngradeRows', 'readWriteWatermarkRow',
    'readSourceCheckoutRoot', 'readUnembeddedPageSummary', 'readWorktreeAdmission', 'completeSyncedRefresh', 'hasDeferralRoom', 'readRefreshTiming',
    'countHeldBehindImport', 'readFenceOriginGone', 'lockGenerationKey', 'clearFenceHoldRows', 'readFenceHoldFiles', 'readLiveGenerationRow',
    'activateGenerationRows', 'recordHeldGenerationRow', 'heldGenerationRowsForInput', 'readHeldGenerationContext', 'liveGenerationForOperation',
    'countGenerationAttempt', 'clearGenerationAttempts', 'readGenerationRestored', 'clearTieHeldGenerationRows', 'readGenerationValve',
    'bumpGenerationValve', 'scrubGenerationPageRows', 'scrubGenerationTextRows', 'recordGenerationActivation', 'markGenerationActivated',
    'readGenerationActivationState', 'settleGenerationMember', 'listPendingGenerationMembers', 'listGenerationOrphanCandidates',
    'readGenerationItemsByIds', 'listUnmatchedGenerationRows', 'listRestorableGenerationRows', 'listHeldGenerationRows', 'readHeldGenerationProposal',
    'listRetiredFenceItems', 'listRecordedFenceItemKeys', 'hasBodylessPageVersion', 'listFenceVersionBodies', 'moveKeptFactRows',
    'readGenerationFenceBlocks', 'listOwnedGenerationItems', 'readLiveGenerationId', 'readGenerationPageRows', 'readAtomOriginInput',
    'listProducerVersionRows', 'listAtomWriteReceipts', 'readReceiptCompactionWindow', 'listReceiptCompactionCandidates', 'countKeptFailedReceipts',
    'listWriteRequestsByRequestIds', 'listEmbeddingCandidates', 'claimNotifierLease', 'readNotifierLease', 'holdsNotifierLease', 'releaseNotifierLease',
    'readNotifierSources', 'writeNotifierState', 'writeNotifierCoverage', 'recordNotifierSyncerHost', 'readNotifierStatusRows', 'hasNotifierCoverage',
    'upsertWantedMarker', 'attachWantedMarkerJob', 'readWantedMarkers', 'readDueWantedMarkers', 'pruneSatisfiedWantedMarkers', 'clearWantedMarker',
    'settleFreshnessMarker', 'listSourceWantedMarkers', 'readFirstDue', 'readWriteRequestsByRequestIds', 'insertWriteRequestGroup', 'readOwnerHostBinding',
    'listTopologyRecoveries', 'readSegmentedGateEvidence',
    'findTopologyChanges', 'renewWriteClaim', 'releaseUnpublishedClaim', 'expireStaleWriteClaims', 'hasClaimableWrite', 'selectClaimableWrite', 'listHostConsumerRows', 'probeLiveConsumerRows',
    'renewConsumerRow', 'deleteConsumerRow', 'stampWorktreeHeartbeats', 'readTopologyChange', 'insertTopologyChange',
    'claimHousekeepingTurn', 'completeHousekeepingTurn', 'readReceiptBudget', 'listCompactableReceipts', 'listReservationsAfter',
    'listTrueUpRequests', 'trueUpReservations', 'readCapacityForecastInputs', 'listPendingSegmentedProjections', 'selectProjectionWindowJobs',
    'claimSegmentedProjection', 'renewSegmentedProjectionClaim', 'releaseSegmentedProjectionClaim', 'deleteProjectionJob', 'markProjectionRebuildFailed', 'declarePersistence', 'requireSynchronousCommit', 'listGatedMirrorRequests', 'listEffectRecoveries', 'selectClaimableEffect', 'readRequestEffects',
    'stampEffectClaim', 'renewEffectClaim', 'advanceEffectRow', 'completeEffectRow', 'retryEffectRow', 'retryBusyEffectRow', 'requeueEffectRow', 'parkEffectRow', 'failEffectRow', 'readMirrorGateRows', 'lockEffectGuard', 'hasRearmableTargets', 'probeIdleWork',
    'probeNoopEmbeddingSettle', 'lockNoopEmbeddingWindow', 'readNoopEmbeddingCandidates', 'settleNoopEmbeddingRows',
    'readOAuthClientWriteGrant', 'readAccessTokenWriteGrant', 'shareLockWriteCredential', 'listOverdueHeldWrites', 'lockOverdueHold', 'listOwnerRecoveryHeads', 'listResumableRefreshes', 'listSourceLastCommits',
      
    'readWriterVersionCutoff', 'listWriterVersions', 'recentWriterVersions',
    'readWriterDiagnosticRows', 'readWriterStatusRows', 'listOnboardingSources', 'listBlockingEffectRows', 'listActiveWorktreeRefreshRows', 'readHeadBlockerRows', 'readRecoveringHeadRow', 'readIncompleteSyncReceipt', 'readOpenPassWork', 'readIncompleteSyncReceiptRows'],
  label_door: ['readPrivacyOrigin', 'listOriginDependents', 'listCheckoutFiles', 'readPageLabelRow', 'writePageLabelGuard'],
  page_purge: ['listPurgeClaimFacts', 'listPurgeClaimTakes', 'listPurgeSegmentClaims', 'listQueuedPagePurges', 'listPageLinkStreams', 'insertPageFactPurges', 'listPageVersionBodiesForPurge', 'readPurgePageBody', 'listPageMirrorFacts', 'listPageMirrorTakeHashes', 'countPageCascadeRows', 'listPageVersionSourcePaths', 'listPagePurgeTombstones', 'listPagePurgeRows', 'deletePagePurgeTombstones', 'deleteFactPurgesByRequests', 'deleteTakePurgesByRequests', 'deletePurgedPageTrustProposals', 'deletePurgedPageHolds', 'deletePurgedPageGateReceipts', 'deletePurgedPageFacts', 'deletePurgedPageFiles', 'listPageTimelineReceipts', 'listPageSegmentShas', 'countPageManifestRows', 'deletePageStagings', 'deletePageSegmentTexts', 'sweepPageTextsForClaims', 'listRequestsForSlugs', 'readJournalCeiling', 'sweepJournalChunk', 'readEffectBytes', 'redactWriteRequestRow', 'releaseTerminalBytes', 'deletePurgedFeedbackRows', 'deletePurgedNameStoreRows', 'clearQueryCache', 'relationExists', 'readDerivationPurgeState', 'recordDerivationPurgeRow', 'continueDerivationSweep', 'listDerivationClaimForms', 'listPurgeOrigins', 'upsertDerivedOriginPark', 'recordOwedPurgeRows', 'deleteOriginHoldRows'],
  entity_reads: ['readMentionLastPass', 'countPagesDueForMentions', 'readIdentitySiblingCandidates', 'findExactSlug', 'findFuzzyEntityCandidates', 'findExactBasenameCandidates', 'readRetirementHop', 'readEntityCardRows',
      'readLiveSlugs', 'readLivePageTypes', 'readTrigramCandidates', 'readPrefixCandidates', 'readPrefixDirs', 'readPrefixTitleMatches', 'readNamedEntitySlugs',
    'readExtractionLagCounts', 'readIgnoredPrivacyLabelPages'],
  cycle_locks: ['acquireCycleLock', 'refreshCycleLock', 'releaseCycleLock', 'readCycleLocks', 'deleteCycleLock', 'deleteCycleLockIfStale',
    'assertCycleLease', 'takePageEmbeddingLease', 'renewPageEmbeddingLease', 'releasePageEmbeddingLease'],
  minion_jobs: ['admitJob', 'getJob', 'listJobs', 'claimNextJob', 'renewJobLease', 'completeJob', 'failJob', 'reclaimStalledJobs'],
  minion_queue: ['deleteTerminalJob', 'pauseJob', 'resumeJob', 'resolveParentJob', 'failParentJob', 'resolveStrandedParents',
    'detachChildJob', 'updateJobProgress', 'addJobTokens', 'delayActiveJob', 'releaseWatchdogClaim', 'markJobWatchdogSuspect',
    'promoteDelayedJobs', 'cancelJobs', 'killTimedOutJobs', 'killWallClockJobs', 'pruneJobs', 'retryJob', 'postInboxMessage',
    'listSynthesisCompletionKeys', 'listRecentSynthesisCompletions',
    'readJobInbox', 'readChildCompletions', 'listOpenJobIdsInQueue', 'renewPrivateQueueLease', 'listOwnedPrivateQueues',
    'readPrivateQueueState', 'listStaleWaitingJobIds', 'countTtlExpiredWaiting', 'readJobStats', 'readQueueFamilyStats',
    'hasOverdueWatchdogSuspect', 'listUnreviewedJobs', 'getFailedJobForRetry', 'countOpenJobsByOwner', 'readJobSourceState', 'lockOAuthClient', 'listJobPage', 'listJobAttachmentNames',
    'insertJobAttachment', 'listJobAttachments', 'getJobAttachment', 'deleteJobAttachment',
    'readQueueHealthSignals', 'listWaitingByQueue', 'readQueueDivergence', 'listQueueWedgeCounts', 'listPrivateQueueHealth',
    'readWedgeSignals', 'readOldestWaitingAge', 'countWaitingJobs', 'listStuckActiveJobsByName',
    // doctor job checks (jobs-checks.test.ts)
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
    'insertAccessToken', 'findActiveAccessTokens', 'setAccessTokenMinTrust'],
  // minion_status: lane L5 group B, job counts and last-run reads for the status surfaces (engine-sql/jobs-status.ts)
  minion_status: ['readLastAutopilotCycles', 'countJobsByStatus', 'readWaitingQueueDepths', 'readLastCompletedJobAt', 'countTtlCancelledByName',
    'readWaitingScopeState', 'countRecentCompletedJobs', 'listRecentFailedJobErrors', 'readQueuedPageChars', 'readSourceJobCounts',
    'readEmbedBackfillBySource'],
  // minion_subagent: lane L5 group B, the subagent transcript and tool ledger (engine-sql/jobs-subagent.ts)
  minion_subagent: ['listSubagentMessages', 'countSubagentMessages', 'insertSubagentMessage', 'listSubagentToolExecutions', 'hasSubagentToolExecution', 'listSubagentWriteOutcomes', 'listSubagentOneshotLedger', 'summarizeSubagentToolExecutions', 'listSubagentPutPageSlugs', 'listSubagentPutPageWrites', 'listSubagentRetainedPutPages', 'listSubagentStagedPages', 'listSubagentTimelineAppendCalls', 'recordSubagentToolExecutions', 'startSubagentToolExecution', 'completeSubagentToolExecution', 'failSubagentToolExecution'],
  // cli_reads_export: the reads gbrain export ran through executeRaw (engine-sql/export-reads.ts)
  cli_reads_export: ['setLocalStatementTimeout', 'listExportPageKeys', 'readExportWithdrawalLedgerBytes', 'listExportWithdrawals', 'readExportPageRows', 'normalizeFenceLines', 'readSegmentedPageHead', 'readBodyManifestRows', 'readBodyManifestMeta', 'listAccessPolicySourceIds', 'readBodyManifestOutline', 'listForcedCutSeqs', 'readManifestSeqAt', 'readSegmentedVersionBodyBytes'],
  cli_reads_ops: ['scanExactBatch', 'nextLivePageAfter', 'listExactIdentityCandidates', 'rankEntities', 'listExtractionPendingPages',
    'listUnattributedFacts', 'listWantedPages', 'readRankCoverage', 'readExactSnippetChunks', 'listExactRescanChunks', 'listHeldFenceCells', 'readFenceOverlayRows'],
  // facts_doctor: doctor checks
  facts_doctor: ['listConversationFactRows', 'countRedactedFacts', 'listOutsideContentFenceCounts', 'countAtomFacts', 'listUnpreviewedTrustFacts',
    'countUnlinkedFactsByOrigin', 'countUnlinkedFactStats', 'countFactRelinkOutcomes', 'listUnlinkedConversationSlugs', 'countFactEmbeddingCoverage',
    'countStaleFactEmbeddings', 'countSegmentedCensusPages', 'listFactsPageBodies', 'readFactTableCatalog'],
  // embedding_catalog: the vector column catalog the embedding commands read (engine-sql/embedding-catalog.ts)
  embedding_catalog: ['readChunkVectorColumn', 'readEmbeddingIdentity', 'listEmbeddingStores', 'hasStoredVectors', 'countChunkVectorCoverage'],

  // fact_relink_attempts: relink-attempt memos
  fact_relink_attempts: ['upsertFactRelinkAttempt', 'listFactRelinkOutcomes', 'deleteFactRelinkMemos'],
  // fact_relink_writes: the guarded relink UPDATEs of facts rows
  fact_relink_writes: ['placeRelinkedFact', 'linkConversationFact', 'listConversationRelinkPages'],

  // facts_cycle: command, cycle and fence reads
  facts_cycle: ['listActiveFactsForEntity', 'listFreshExtractionOutcomes', 'listFenceRowGroups', 'readFactSubject', 'factsOrAliasesMayMatch', 'listFactsForPage', 'countLegacyFactsPending',
    'countUnconsolidatedFactsBySource', 'findBulkFactDays', 'maxFenceRowNum', 'readFenceRowOccupant', 'listStoredFenceFactRows', 'countWorldFacts'],

  // facts_cycle_sites: phantom redirect, fence, facts-home and file-guard statements (item 4.2)
  facts_cycle_sites: ['listPhantomFactRows', 'listCanonicalFenceRowNums', 'moveFactToPage', 'repointInboundLinks',
    'repointOutboundLinks', 'pageHasTimelineEntries', 'maxFenceRowNumOfPage', 'listRootPageSlugsAfter',
    'listOwnLinkIds', 'listActiveFactIdsOfPage', 'listFactIdsStillOnPage', 'listLinkIdsOnPage',
    'readPageFileOrigin', 'listFenceRowClaims', 'adoptFactIntoFence', 'listFenceRowSupersession',
    'setFactSupersededBy', 'listHeldWideningFactIds', 'expireFactInPlace', 'expireAndDetachFact',
    'updateFenceFactCells', 'listExpirableFactIdsOfDeletedPage', 'readDeletedPageBody', 'expireFactsByIds',
    'listOntologyObservationSlugs', 'listDeletedPageSlugsWithActiveFacts', 'scanUnfencedFactRows', 'listHeldFactRows',
    'listFencedFactsOfMissingPages', 'readFenceRowNumHint', 'readSourceCheckoutPath', 'readLiveStoredBody',
    'listPageStates', 'countSegmentedVersionsOfPage'],

  // facts_purge: purge, withdrawal, relink and fence repair

  facts_purge: ['countFactFingerprintLeftovers', 'loadPurgeTarget', 'planFactPurgeIds', 'listFactsReconcileBacklog', 'settleFactsReconcile', 'lockReconcileRevision', 'selectFactsReconcileDrain', 'listRelinkCandidateRows',
    'countRelinkCandidates', 'listSimilarActiveFacts', 'findActiveSingleFact', 'listSingleFactMetadata', 'listUnfencedFactRows', 'countUnfencedFactGroups',
    'listHeldFenceFactRows', 'listWithdrawalSlugs', 'expireFactsByWithdrawal', 'insertFactPurge', 'upsertPagePurges',
    'expireFactsOfGonePages', 'readPurgeSourceLocalPath', 'listGitEffectsCarryingReason', 'listPageGitEffectsForStrip',
    'setPurgeEffectData', 'listPageChangeReasons', 'listRequestsRecordingReasons', 'heldEntityPageDeleted', 'readHeldAccessState',
    'heldTargetPageLive', 'listHeldMoveRows', 'listStruckHeldRows', 'readHeldRowVisibility', 'heldMoveDue',
    'readHeldConfigValue', 'readHeldPageLocation', 'readHeldVersionsEdited', 'listSegmentedPageBodies', 'listSegmentedVersionBodies',
    'setPurgeProbeTimeout', 'probePurgeDerivations', 'listBeliefEventsForPurgeProbe', 'listFactContextsForPurgeProbe', 'listPageSourcePathsForPurge',
    'listNearestFactsForPurge', 'countLegacyDerivedPages', 'vacuumPurgedTables', 'listPageProseHits', 'readPurgeReceiptSourcePath',
    'countPagePurgeTombstones', 'readDeletePageRequest', 'listPurgeEffects', 'countPurgeFingerprintResidue',
    'listStagingPartEdges', 'listStagingsHoldingClaim', 'purgeSubjectPageLive', 'listPurgePagesById', 'countPurgeVersionsCarryingClaim',
    'countPurgeReviewRows', 'listPurgeStreamSlugs', 'findPurgeBlockedPublication', 'listPagesForPurgeRewrite', 'updatePageBodyForPurge',
    'setPurgeVersionBody', 'listPurgeVersionBodies', 'redactVersionChangeReasons', 'listSegmentedVersionsForPurge', 'abortPurgedStagings', 'deletePurgedStagingParts',
    'deletePageViewDigests', 'deleteUnreferencedPurgedTexts', 'listPurgeMatchCandidates', 'lockPurgeSource', 'insertHoldingPagePurges',
    'insertTakePurge', 'deletePurgedTakes', 'deletePurgeReviewQueue', 'deletePurgeReviewProposals', 'deletePurgeDecideProposals',
    'deletePurgeTrustProposals', 'deletePurgeOpenLoops', 'deletePurgeWriteGateHolds', 'deletePurgeWriteGateReceipts', 'deletePurgeTakeProposals',
    'blankPurgeCoreEditNotices', 'deletePurgedFacts', 'deletePurgedChunks', 'listPurgedPageRevisions', 'insertPurgeEffects',
    // the hard delete's slug-keyed stores and write-gate holds (engine-sql/purge-slug-stores.ts)
    'deletePurgedSlugStoreRows', 'listPageSecretOccurrences', 'deletePurgedSlugHolds',
    // the held-concept rebuild's reads and link carry (engine-sql/concept-rebuild.ts)
    'readHeldConcept', 'isConceptStillHeld', 'lockHeldConcept', 'lockLiveConceptMembers', 'listLiveConceptMemberRevisions', 'listConceptIncomingLinks', 'carryConceptIncomingLinks', 'readTombstoneWindow'],

  // purge_plan: a fact purge's request finders and verification probes
  purge_plan: ['listRequestsCarryingClaim', 'listRequestsHoldingStagings', 'countPurgeProbe', 'listPurgeProbeItems'],

  // projection_rebuild: a page projection rebuild's queue listing, job reason, keep plan and drained probe, the
  // deferred chunk replacement's step, the rebuild loop's queue stamps and the re-seal's pending count (its job
  // delete is persistence_journal's deleteProjectionJob, its failed mark persistence_journal's
  // markProjectionRebuildFailed)
  projection_rebuild: ['listQueuedPageProjections', 'readProjectionJobReason', 'readChunkKeepState',
    'clearUnkeptChunkVectors', 'setProjectionChunkerVersion', 'hasDrainableProjectionJob',
    'readChunkRowsFingerprint', 'deleteUnkeptChunks', 'listStaleChunkVectors', 'clearChunkVectors', 'readProjectionHead',
    'isDeferredReplacementHeld', 'renewDeferredReplacementClaim', 'releaseDeferredReplacementClaim', 'hasSegmentedPage', 'rekeyProjectionJob',
    'stampDeferredProjectionJob', 'touchUnclaimedProjectionJob', 'deferProjectionJob', 'countPendingTextChunks',
    'probeProjectionWindowCandidates'],

  // facts_repair: repair classifiers and loop retirement
  facts_repair: ['loopFactDrift', 'closedLoopWithActiveFact', 'listSessionFactsForClassification', 'listSessionFactTwins',
    'listCapturedFactsForClassification', 'countLabelFacts', 'listLabelFactCandidates', 'listSegmentedLabelPages', 'hasActiveAuditMarker', 'listRedactedFactCandidates', 'restoreRedactedFactTexts', 'listProjectedFenceRows', 'listUnexpiredFactIds', 'lockFactRows', 'expireFactWithNote', 'expirePageFactsBySource', 'readMaxFactRowNum', 'listExtractorFactsForClassification', 'listClosedConsolidationTies', 'listPagelessEntityFacts', 'listOntologyFactCandidates', 'listDuplicateFactRows', 'listFactsOnValidDay', 'readLivePageByPath', 'listPurgedPageFactCandidates', 'listFactsHomeCandidates', 'listHeldHomeRows', 'listOrphanedFenceRows', 'readFactSnapshots', 'listConceptLineageRows', 'listConceptInputRows', 'listNamedVisibilityRows', 'countPurgedPageFacts', 'listUnwithdrawnFacts', 'listWorldFactsFromPrivateSources', 'listActiveSourceIds', 'readRepairBrainId', 'listAgentSessionTakeCandidates', 'listSettledSessionFacts', 'reattributeSessionFacts', 'retireSessionTakes', 'listFenceRewriteRows', 'listOtherAttributedFactIds', 'listInactiveTakeIds', 'expireCapturedFacts', 'listExpiredFactIds', 'readEntityRehomeState', 'rehomeEntityFacts'],

  // facts_trust: search relevance and trust reads
  facts_trust: ['listFactsForRelevance', 'countUncomparableFacts', 'matchSavedFacts',
    'readFactForOwnerAction', 'listStandingPreferences', 'listLexicalContestCandidates', 'listFactsFromQuotedPages', 'listOwnerTierFacts', 'listRestatedPrivateCopies', 'countDerivedFactTaint', 'readFactEntitySlugById', 'readSupersessionReplacement', 'linkSupersededFact', 'listLivePageTitles', 'listPageAliasNames', 'listCaptureDuplicateCandidates', 'computeFactFingerprints', 'listClaimConflictPairs', 'countClaimConflictPairs', 'listUnarchivedSourceRows',
    'readPendingWriteReceipt', 'lockSourceShared', 'listOversizedStaleFacts', 'listLivePersonTitles', 'readLiveFactEntityPage', 'lockAgentWritebackSetting', 'listFactsToRetireFromPage', 'listContestedProposalPairs', 'listFactProvenance', 'recordDerivationEdges', 'expireDerivedFacts', 'deactivateDerivedTakes', 'softDeleteDerivedPages', 'markNeedsRederive', 'readMemberPageWithdrawal', 'readFactVisibility', 'readReplacementTarget', 'readPairFactRow', 'expireSupersededFact', 'restoreSupersededFact', 'readFactForForget', 'expireFactSuperseded', 'expireFactAtDate', 'readWithdrawalAnchor', 'readFactActivity', 'readReviewAcceptedMark', 'readFactsFtsIndexState', 'swapFactsFtsIndex', 'listDerivedRows'],

  // facts_recall: the recall pool's candidate reads (nearest, slot, call-off, entity pairs, unbacked keys) and its final row read
  facts_recall: ['readFactsEmbeddingColumn', 'listNearestFacts', 'listSlotRows', 'listPoolUnbackedKeys', 'listCallOffCueFacts', 'listPoolEntityPairs', 'listFactRowsByIds'],

  // facts_conversation: conversation fact publication and relink
  facts_conversation: ['readNewestConversationFactId', 'findSpentConversationRequest', 'listConversationBatchRequests', 'readStoredConversationEntry', 'readPrincipalCounters', 'countConversationPagesToExtract', 'listMergedEntityAliases', 'moveConversationSourceWindows', 'stampConversationSourceWindows', 'countActiveConversationFacts', 'readConversationSlotValueHash', 'deleteConversationOutcomeRows', 'listPurgeTombstoneMatches',
    'maxConversationRowNum', 'listHeldFactSlots', 'countPageConversationFacts', 'countConversationWindowFacts', 'countConversationFactsOutsideWindows', 'clearConversationPageFacts', 'findSameClaimFenceRow', 'findOntologyTwin', 'readRelinkSource', 'factRelinkAttemptsTableExists', 'readReextractOutcomeRow', 'listUnbackedConversationRows', 'listUnlinkedConversationRows', 'listEntityHintPages', 'lockPageById', 'listClearedRelinkedFacts', 'countEmbeddedFactsAmong'],

  // trust_tier_reads: stamped-tier reads of core memory, the trust scan, belief history, page history and valid time
  // belief ledger writes: lifetimes, event appends, commit marks, redactions (engine-sql/belief-ledger.ts); its state reads (engine-sql/belief-state.ts)
  belief_ledger: ['readBeliefTombstones', 'readBeliefRedactions', 'insertBeliefRedaction', 'releaseBeliefRedactions', 'insertBeliefEvents',
    'markBeliefCommits', 'readOpenBeliefLifetimes', 'endBeliefLifetime', 'mintBeliefLifetime', 'renameBeliefLifetime', 'readMovedBeliefLifetimes',
    'readLatestBeliefCoverage', 'hasBeliefBaseline', 'listBeliefBaselinePending', 'countBeliefBaselineSlugs', 'readBeliefStateRows',
    'readBeliefFactsById'],
  // the belief side of a purge: epoch, ledger probe, purge suppressions, restore replay (engine-sql/belief-purge.ts)
  belief_purge: ['bumpSourcePurgeEpoch', 'hasBeliefEvents', 'registerPurgeRedaction', 'releasePurgeRedactionsForField', 'replayPagePurges',
    'readPurgeReplaySchema'],
  trust_tier_reads: ['listCorePageRows', 'listTrustScanRows', 'countUnscannedTrustRows', 'readBeliefHistoryRows', 'listVisibleBeliefLifetimes',
    'listVersionTrustTiers', 'listVersionReasonWriters', 'listPageRefsByIds', 'listPageTrustTiersByKey', 'lockLivePagesByKey', 'listValidTimeIdentities', 'pickValidTimeEdition',
    'listAmendmentsNotApplied', 'readPageVersionEdition', 'readCursorEdition', 'pageAwaitsRederive', 'listPageQuoteTiers'],

  // derivation_trust: the derived-row trust writes (engine-sql/derivation-trust.ts)
  derivation_trust: ['lowerTrustTier', 'countDerivedRowTaint', 'stampPageFrontmatter'],
  // memory_mutation_reads: the reads remember and forget make before admission
  memory_mutation_reads: ['readSourceWriteRow', 'readSourceLocalPath', 'readFactEntitySlug', 'hasLiveFileBackedPage', 'factReadableUnder', 'readRemoteForgetTier', 'readForgetTarget',
    'isFactEntityUnbacked', 'readLinkedFactCopies', 'hasHiddenFactCopy', 'ownerReachesFact', 'readFactWithdrawalClaim'],

  // withdrawal_discovery: the reads discoverWithdrawalTargets makes to find every page that carries a withdrawn claim
  withdrawal_discovery: ['readWithdrawalDiscovery'],

  // withdrawal_pages: the page statements a fact withdrawal runs on the pages that carry the claim
  withdrawal_pages: ['listSegmentedPages', 'invalidateWithdrawnPages'],

  // withdrawal_fence: the withdrawal check a prepared import runs on a malformed facts fence
  withdrawal_fence: ['hasWithdrawnFenceClaim'],

  raw_sql: ['runMigration', 'executeRaw', 'executeRawDirect', 'keywordBoundedRead'],
  code_edges: ['addCodeEdges', 'deleteCodeEdgesForChunks', 'getCallersOf', 'getCalleesOf', 'getEdgesByChunk',
    // group D (code-edge read)
    'hasCodeEdgesSymbol',
    // group D (code traversal cache)
    'getCodeTraversalCache', 'putCodeTraversalCache', 'clearCodeTraversalCache'],
  eval_capture: ['logEvalCandidate', 'listEvalCandidates', 'deleteEvalCandidatesBefore', 'logEvalCaptureFailure',
    'listEvalCaptureFailures'],
  // decide family, group B (calibration-profiles.test.ts)
  calibration_profiles: ['getLatestCalibrationProfile', 'isCalibrationProfileUnchanged', 'insertCalibrationProfile', 'readVoiceGateHealth',
    'purgeCalibrationProfilesByWave'],
  salience_enrich: ['batchLoadEmotionalInputs', 'setEmotionalWeightBatch', 'getRecentSalience', 'listEnrichCandidates', 'findAnomalies',
    // group D (salience read)
    'countZeroWeightWithTakes'],
  trust: ['hasCoveringFactWithdrawal', 'insertFactWithdrawal', 'isFactWithdrawn', 'isFactPurged', 'listFactWithdrawalDates', 'moveFactWithdrawalSubject',
    'hasFactWithdrawalForSubject', 'listFactWithdrawalKeys', 'readFactCacheWatermark', 'readTrustGeneration', 'readSourcePurgeFlags', 'listPurgedTakeRows',
    'lockFactForWithdrawal', 'queueWithdrawalReview', 'listSegmentedPagesBySlug', 'bumpWithdrawnPageRevisions', 'readPageRevisions', 'appendFactForgetReason', 'readFactWithdrawnRow', 'readFactWithdrawnBacking',
    'upsertWriteGateReceipt', 'upsertPageWriteGateReceipt', 'deleteStalePageWriteGateReceipts', 'listWriteGateReceiptsFor',
    'deleteStaleWriteGateReceipts', 'upsertWriteGateHold', 'listWriteGateHoldRows', 'getWriteGateHoldRow', 'decideWriteGateHold',
    'listTrustAllowRuleRows'],
  // open_loops: the loop upsert, list and close statements (engine-sql/open-loops.ts)
  open_loops: ['upsertOpenLoop', 'listOpenLoops', 'readEntityOpenLoops', 'closeOpenLoop'],
  // loop_mutes: mutes and the open-loop statements a mute, an unmute and the thread verdict run (engine-sql/loop-mutes.ts)
  loop_mutes: ['addLoopSuppression', 'removeLoopSuppression', 'listLoopSuppressions', 'listMuteRecheckThreads',
    'closeMutedLoops', 'requeueMutedLoops', 'closeThreadLoops', 'settleMuteRecheck'],
  // source_archive: the archive, restore, archive list, purge candidates and source clients (engine-sql/source-archive.ts)
  source_archive: ['archiveSource', 'restoreArchivedSource', 'listArchivedSourceRows', 'listExpiredArchivedSources',
    'listUnverifiedArchivedSourceIds', 'listSourceOAuthClients'],
  // entity_identities: the identity link, unlink and group reads (engine-sql/entity-identities.ts)
  entity_identities: ['linkEntityIdentityRow', 'unlinkEntityIdentityRow', 'listEntityIdentityRows', 'readEntityIdentityIdsForPages', 'readCanonicalTwin'],
  cli_reads_import: ['listSourceRecords', 'readSourceIncarnation', 'readSyncDispatchRow', 'hasCompanyBrainReceipt', 'readGuestSourceRow', 'listGuestSourceIds', 'readRetainedSources',
    'hasGuestSource', 'readPageTrustRows', 'readRowTrustRows', 'readDatabaseClock', 'listLinkPageMetadata', 'listLinkPageMetadataForSlugs', 'listAttendedOriginSlugs', 'listStoredTimelineRows', 'filterPagesAtRevision'],
  wanted_links: ['lockRegisteredSourceIds', 'replaceWantedLinkRows'],
  write_misc: ['readJobPrincipal', 'readSourceState', 'readAdmissionSource', 'sharedSkillPackTablePresent', 'listSharedSkillPackRoots', 'getWorktreeBinding', 'isSourceClaimed',
      'worktreeClaimStore', 'readWriterAdminState', 'writerAdminStore', 'readAccessStoreConfig', 'writeAccessStoreConfig', 'ensureAccessPolicyState', 'lockAccessPolicy', 'listAccessRules', 'readAccessPolicyRevisions', 'listAccessCoverage', 'readAccessStateUnreadable', 'applyAccessRuleChanges', 'restampAccessWindow', 'finishAccessRestamp', 'insertAccessPolicyRevision', 'markAccessRevisionsApplied', 'approveAccessPolicyRevision', 'hasAccessPolicyState', 'listAccessPrefixSlugs', 'readAccessPolicyMarks', 'replaceAccessInvalidCoverage', 'listUnboundTokenNames', 'listUnboundClientIds', 'readLiveAccessToken', 'listUnarchivedSourceIds', 'recordTokenSetupReads', 'listKeysReadingSource', 'countCompanyPages', 'revokeAccessTokenById', 'readUnfinishedAccessMigration', 'insertAccessMigration', 'recordAccessMigrationPhase', 'switchAccessMigration', 'listAccessPolicySources', 'countPeopleFolderPages', 'purgeStaleCheckpoints',
    'hasExtractedEvents', 'listActiveAccessMembers', 'listAccessTokens', 'listAppliedPolicyRevisions', 'readMayActFor', 'readAudiencePrincipals', 'readAccessMembers', 'readAccessCredentials', 'listAudienceAccessMembers', 'readLiveMember', 'hasLabelledOnlyMember', 'readFolderAccess', 'expireMemoryProposals', 'listAwaitingMemoryProposals', 'purgeMemoryProposals',
    'attachSourcePath', 'readMemoryProposal', 'readPendingProposalSummary', 'listMemoryProposalRows', 'listOwnerProposalRows',
    'readOpCheckpointKeys', 'writeOpCheckpointKeys', 'appendOpCheckpointPaths', 'deleteOpCheckpoint', 'deleteOpCheckpointPaths',
    'readOpCheckpointRecord', 'writeOpCheckpointRecord',
    'readOpCheckpointRecords', 'writeOpCheckpointRecords', 'readSyncImportPageRows', 'declareSyncImportPageCursor', 'fetchSyncImportPageCursor',
    'readAdmittedWriteRequests', 'readPageRevisionWriter', 'readRevisionWriterRequest', 'writeSyncAdmissionStamp', 'readSyncAdmissionEffects',
    'readHealthMemoClock', 'listSynopsisSourceIds', 'readSynopsisTierSources', 'setSourceContextualMode', 'readWorktreeManifest'],
  // repair_bookkeeping: source incarnations, writer bindings, loop facts, connector checkpoints (engine-sql/repair-bookkeeping.ts)
  repair_bookkeeping: ['listSourceIncarnations', 'listOrphanBindings', 'deleteOrphanBinding', 'readLoopFactState', 'expireSourceFactNow',
    'listConnectorSources', 'listOrphanConnectorCheckpoints', 'countConnectorCheckpointsKeyed', 'deleteOrphanConnectorCheckpoint',
    'listManagedSyncOrphanRows', 'listArchivedSourceIds', 'listManagedSyncFailureKeys', 'applyManagedSyncRetireLimits',
    'retireManagedSyncPassSlugMode', 'retireManagedSyncCursor', 'deleteManagedSyncFailureRow', 'deleteManagedSyncManifest',
    'listOwnedContentRows', 'readContentReceiptBinding', 'readConfigForUpdate',
    'countPageChildOrphans', 'clearPageChildOrphans', 'probeTornPages', 'listAccessReaderDrift', 'countAccessReaderDrift', 'deriveAccessReaders', 'readOriginIndexState', 'listOriginTwinCounts',
    'listAliasTargets', 'deleteOrphanedAliases',
    'listSafeChunksPending', 'listOriginTwinGroups', 'listLegacyOriginPairs', 'listLiveOriginPages', 'countLiveFileBackedPages', 'listRepairScanPages', 'listFileTombstones', 'listTwinMergeLosers',
    'listContactRowPages', 'listSplitFactsPages', 'listAtomFenceCandidates', 'listPageTruths',
    'listPagesByOriginPath', 'countSegmentedOriginPages', 'listSegmentedPageSlugs', 'listProvenAttributionTargets', 'countUnfilledAttribution', 'listFailedWriteRequests', 'readDriftConflictBounds', 'listDriftConflictGroups', 'readDriftConflictDetails', 'listUntiledSegmentedPages', 'listSourceHoldRecords',
    'requestGitHoldRetry', 'readRepairBusyRows'],
  // write_attribution: get_write_attribution's receipt and name reads (engine-sql/write-attribution.ts)
  write_attribution: ['readWriteAttributionNames', 'readPageRevisionAttribution', 'readVersionAttributions',
    'readOldestVersionAttribution', 'readRowAttribution'],
  // telemetry: search telemetry, MCP usage and the chat usage ledger (engine-sql/telemetry.ts, engine-sql/chat-usage.ts)
  telemetry: [
    'recordSearchTelemetry', 'readSearchStats', 'readClientOpUsage', 'readMcpRollupPrunedBefore', 'logMcpRequest',
    'readMcpLogPruneCutoff', 'pruneMcpRequestLogBatch', 'readMcpLifetimeUsage', 'logChatUsage', 'readChatUsage',
  ],
  // field_usage: schema detect --fields page samples (engine-sql/field-usage.ts)
  field_usage: ['readFieldUsageSamples'],
  // alias_fanout_reads: search's alias fan-out reads (engine-sql/alias-fanout-reads.ts)
  alias_fanout_reads: ['findPagesByTitles', 'resolveCaseSensitiveAliases', 'readPageTitle', 'readPageAliasRows', 'readEntityAliasRows', 'listSlugAliases'],
  write_guards: ['readPageOrigin', 'listOriginClaims', 'bindPageOrigin', 'stampPageIngest', 'sealImportedPage', 'readLivePageBody',
    'readPageIndexingState', 'readInlinePageRegions', 'readStoredPageTier', 'hasSegmentStorage', 'detachPageOrigin',
    'readPageDatabaseOnlyReason', 'bumpPageKnowledgeRevision', 'removePageFrontmatterKeys', 'setPageType'],
  // page_visibility: the remote page-write visibility guards (engine-sql/page-visibility.ts)
  page_visibility: ['readPageHiddenFromCaller', 'readCallerPageAccess', 'readWriteVisibilityProbe', 'readWriterSlugFence'],
  // remote_links: the remote mention-links effect and a finished batch's links re-arm (engine-sql/remote-links.ts)
  remote_links: ['setEffectTransactionLimits', 'readOwnedLinks', 'deleteOwnedLinks', 'readLinkTargetPages', 'rearmLinksEffects'],
  // facts_backstop: the facts backstop effect's pending and completed extraction reads (engine-sql/facts-backstop.ts)
  facts_backstop: ['hasPendingFactsExtraction', 'hasCompletedFactsExtraction'],
  // large_page: the remote put_page large-page guard's stored body size read (engine-sql/large-page.ts)
  large_page: ['readStoredBodyBytes', 'readPageBodySizes'],
  // relational_reads: the relational recall arm's page reads (engine-sql/relational-reads.ts)
  relational_reads: ['readAdmittedPageRefs', 'readPageSynopses', 'readSeedTitleSlugs'],
  trust_fence: ['listFenceFactRows', 'restorePageTrust', 'listHeldRows', 'listGuardedTakeRows'],
  trust_proposals: ['insertTrustProposal', 'getTrustProposal', 'listTrustProposals', 'pendingTrustProposalsFor',
    'updatePendingTrustProposalAfter', 'transitionTrustProposal', 'listPendingContradictions'],
  connect_gate: ['hasPersistenceTable', 'listManagedRootBindings', 'readGraduationGateRow', 'listRetiredDeactivations'],
  // group C: the decide proposal tables (engine-sql/decide-proposals.ts)
  decide_proposals: [
    'insertDecideProposal', 'getDecideProposal', 'listDecideProposalIds', 'listDecideProposals',
    'transitionDecideProposal', 'listDecideProposedPairs', 'insertDecideReviewProposal', 'listDecideReviewProposals',
    'getDecideReviewProposal', 'transitionDecideReviewProposal', 'listDecideReviewProposalIds', 'readProposalReviewRates',
    'listDueDecideReviewQueue', 'applyDecideReviewQueue', 'listDueDecideSweepDeferred', 'applyDecideSweepDeferred'],
  // decide_store: the decide state, spend, receipt and calibration tables (engine-sql/decide-store.ts)
  decide_store: [
    'readDecideState', 'upsertDecideState', 'deleteDecideState', 'ensureDecideState',
    'insertDecideSpend', 'dailyDecideSpend', 'listDecideSpendBySlot',
    'insertDecideReceipts', 'pruneDecideReceipts', 'listDecideReceiptStats', 'decideSlotUsage', 'decideConflictNoEntityCounts',
    'listDecideReplayReceipts', 'listDecideResolvedModels', 'listDecideMixedModelDecisions',
    'insertDecideCalibration', 'storeDecideQualification', 'listDecideCalibrations', 'getDecideCalibration', 'setDecideCalibrationRetired',
  ],

  // jobs_wake: the Wakeshift report-back tables (engine-sql/jobs-wake.ts), group A of the jobs-tables slice
  jobs_wake: [
    'openWakeWatch', 'listWakeWatches', 'endWakeWatches', 'countWakeWatches', 'readWakeDoctor', 'countPendingWakeForgets', 'listWakeCrons',
    'addWakeCron', 'removeWakeCron', 'hasWakeCron', 'recordWakeCronRun', 'hasWakeTermsAcceptance', 'recordWakeTermsAcceptance', 'listDueWakeWatches',
    'claimWakeWatch', 'settleWakeWatch', 'queueWakeForget', 'claimWakeForgets', 'settleWakeForget',
  ],
  owner_only: ['ownerOnlyMarkTriggers'],
  // engine_migration: the source-side reads of `gbrain migrate --to <engine>` (engine-sql/engine-migration.ts)
  engine_migration: ['readEngineMigrationHistory', 'readMigrationRows', 'readMigrationPageColumns', 'listManualLinkTransitions', 'countLiveTimelineEntries'],
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
