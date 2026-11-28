/**
 * Which served Rust engine members only read and which write, for the engine's writer gate (rust-engine.ts `_admit`).
 *
 * A read runs on a snapshot and never waits for an open transaction; a write waits until no transaction holds the
 * writer. The member table has no read/write column, so every served member is listed here by name, in exactly one
 * set: test/rust-engine-member-access.test.ts fails when a served member is in neither set or in both, or when a set
 * names a member that is not served. At run time a member missing from both sets counts as a write and waits, which
 * is always safe (the transaction runs on its own executor, so a waiting write can never block it); the test makes
 * the omission a CI failure instead of a silent wait. The transaction members admit themselves (`SELF_ADMITTED`).
 */

/** Members that run on their own admission (the transaction members) rather than the writer gate. */
export const SELF_ADMITTED_MEMBERS: ReadonlySet<string> = new Set(['transaction', 'transactionDirect', 'lockPageKeys']);

/** Served members that only read: they never wait for an open transaction. */
export const READ_MEMBERS: ReadonlySet<string> = new Set([
  'aliasCanonicalRefs', 'batchLoadEmotionalInputs', 'cosinesByChunkIds', 'countChunklessPagesWithContent',
  'countDefaultSourceSplit', 'countKeywordPages', 'countOpenLoopsByCounterpartyEmail', 'countPagesBy',
  'countStaleChunks', 'countStaleFrontmatterKeyPages', 'countStalePagesForExtraction', 'countStaleTakes',
  'countUnconsolidatedFacts', 'dailyDecideSpend', 'decideConflictNoEntityCounts', 'decideSlotUsage',
  'discoverOntologyDimensions', 'findAnomalies', 'findByTitleFuzzy', 'findCandidateDuplicates', 'findDuplicatePage',
  'findDuplicatePages', 'findOntologyConflicts', 'findOrphanPages', 'findPages', 'findTrajectory',
  'generatedPagesIn', 'getAdjacencyBoosts', 'getAllConfig', 'getAllSlugs', 'getBacklinkCounts', 'getBacklinks',
  'getCalibrationCurve', 'getCalleesOf', 'getCallersOf', 'getChunkPage', 'getChunkWindows', 'getChunks',
  'getChunksWithEmbeddings', 'getConfig', 'getConfigValues', 'getContentFlagsByPageIds',
  'getContradictionCacheEntry', 'getDecideCalibration', 'getDecideProposal', 'getDecideReviewProposal',
  'getDreamVerdict', 'getEdgesByChunk', 'getEffectiveDates', 'getEmbeddingsByChunkIds', 'getFactsHealth', 'getFile',
  'getHealth', 'getIngestLog', 'getLastSeen', 'getLinks', 'getOnThisDay', 'getOntology', 'getPage',
  'getPageSealState', 'getPageTimestamps', 'getRawData', 'getRecentSalience', 'getSalienceScores', 'getScorecard',
  'getSince', 'getSource', 'getSourceStrictness', 'getStats', 'getTags', 'getTakeEmbeddings', 'getTimeline',
  'getTimelineForDate', 'getUnverifiedExtractionPageIds', 'getVersions', 'hasCompanyBrainReceipt',
  'hasSupersedeEdges', 'listActiveSourceConfigs', 'listActiveTakesForPages', 'listAllPageRefs', 'listAllSources',
  'listChunklessPagesWithContent', 'listConfigKeys', 'listCorpusSample', 'listDecideCalibrations',
  'listDecideMixedModelDecisions', 'listDecideProposalIds', 'listDecideProposals', 'listDecideProposedPairs',
  'listDecideReceiptStats', 'listDecideReplayReceipts', 'listDecideResolvedModels', 'listDecideReviewProposalIds',
  'listDecideReviewProposals', 'listDecideSpendBySlot', 'listDueDecideReviewQueue', 'listDueDecideSweepDeferred',
  'listEmbeddingStateRows', 'listEnrichCandidates', 'listEvalCandidates', 'listEvalCaptureFailures',
  'listFactsByEntity', 'listFactsBySession', 'listFactsKeyset', 'listFactsSince', 'listFilesForPage',
  'listLinkSources', 'listLocalPathSources', 'listOpenLoops', 'listPages', 'listPrefixSampledPages',
  'listPrivateQueueHealth', 'listQueueWedgeCounts', 'listSourceLocalPaths', 'listSourceRecords',
  'listSourceRoutingRows', 'listStaleChunks', 'listStaleFrontmatterKeyPages', 'listStalePagesForExtraction',
  'listStaleTakes', 'listStuckActiveJobsByName', 'listSupersessions', 'listTakes', 'listWaitingByQueue',
  'livePageIdsAt', 'loadContradictionsTrend', 'ownsSchemaTables', 'pageCollapseFacts', 'pagesLinkingTo',
  'readDecideState', 'readEmbeddingStateCounts', 'readEntityOpenLoops', 'readFieldUsageSamples',
  'readGuestSourceRow', 'readIgnoredPrivacyLabelPages', 'readLivePageFrontmatter', 'readLocalWriterRow',
  'readManagedModeRows', 'readManifest', 'readOldestWaitingAge', 'readPageSnapshot', 'readPageSnapshotsBatch',
  'readPersistenceBrainId', 'readProposalReviewRates', 'readQueueDivergence', 'readQueueHealthSignals',
  'readSegmentDerivations', 'readSegmentTexts', 'readSourceIncarnation', 'readSourceRow', 'readTransactionSettings',
  'readWedgeSignals', 'readWriterAdminState', 'relationalChainHop', 'relationalFanout', 'resolveAliases',
  'resolveSlugWithAlias', 'resolveSlugWithAliasDetailed', 'resolveSlugs', 'resolveSlugsByPaths', 'searchKeyword',
  'searchKeywordChunks', 'searchKeywordPages', 'searchTakes', 'searchTakesVector', 'searchTitles', 'searchVector',
  'slugsEndingIn', 'sumStaleChunkChars', 'supersedingPageSlugs', 'traverseGraph', 'traversePaths',
  'traversePathsDetailed',
]);

/** Served members that write: they wait while a transaction holds the writer. */
export const WRITE_MEMBERS: ReadonlySet<string> = new Set([
  'acquireCycleLock', 'addCodeEdges', 'addLink', 'addLinksBatch', 'addPageTagsById', 'addSynthesisEvidence',
  'addTag', 'addTakesBatch', 'addTimelineEntriesBatch', 'addTimelineEntry', 'allocateBodyOccurrenceIds',
  'applyDecideReviewQueue', 'applyDecideSweepDeferred', 'applyTransactionSettings', 'closeOpenLoop',
  'consolidateFact', 'createSegmentedPageShell', 'createVersion', 'deleteChunks', 'deleteCodeEdgesForChunks',
  'deleteDecideState', 'deleteEvalCandidatesBefore', 'deleteFactsForPage', 'deletePage', 'deletePages',
  'ensureDecideState', 'expireFact', 'flipBodyGeneration', 'initSchema', 'insertDecideCalibration',
  'insertDecideProposal', 'insertDecideReceipts', 'insertDecideReviewProposal', 'insertDecideSpend', 'insertFact',
  'insertFacts', 'insertLocalWriterRow', 'invalidateContentDriftEmbeddings', 'invalidateStaleSignatureEmbeddings',
  'logEvalCandidate', 'logEvalCaptureFailure', 'logIngest', 'markPagesAttendanceBlocked', 'markPagesExtractedBatch',
  'markSourceSynced', 'mergeOntologyFact', 'migrateFactsToCanonical', 'openBodyStaging', 'pruneDecideReceipts',
  'pruneFrontmatterTags', 'purgeDeletedPages', 'purgeStaleAppliedCaptures', 'putContradictionCacheEntry',
  'putDreamVerdict', 'putPage', 'putRawData', 'refreshCycleLock', 'refreshPageBody', 'releaseCycleLock',
  'removeLink', 'removeLinksByPagesAndSource', 'removeTag', 'replaceDerivedLinks', 'replaceDerivedLinksBatch',
  'resolveTake', 'restorePage', 'retireSegmentDerivations', 'revertToVersion', 'rewriteLinks', 'sealChunks',
  'sealSegmentedPage', 'setBodyStagingState', 'setConfig', 'setDecideCalibrationRetired', 'setEmotionalWeightBatch',
  'setPageAliases', 'setPageEmbeddingSignature', 'softDeletePage', 'softDeletePages', 'stageManifestRows',
  'stageSegmentChunks', 'stageSegmentTexts', 'storeDecideQualification', 'stripStaleFrontmatterKeys',
  'supersedeTake', 'sweepContradictionCache', 'sweepDreamVerdicts', 'transitionDecideProposal',
  'transitionDecideReviewProposal', 'unsetConfig', 'updatePageContextualRetrievalState', 'updateSlug',
  'updateSourceConfig', 'updateTake', 'updateTakeEmbeddings', 'upsertChunks', 'upsertDecideState',
  'upsertEventProjection', 'upsertFile', 'upsertOpenLoop', 'upsertSegmentDerivations', 'writeContradictionsRun',
]);

/** True when `member` only reads and so never waits for the writer. A member in neither set counts as a write. */
export function isReadMember(member: string): boolean {
  return READ_MEMBERS.has(member) && !WRITE_MEMBERS.has(member);
}
