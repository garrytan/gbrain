/**
 * The read that tells whether a call sent to the Rust brain's owner committed, for a call whose answer never came
 * back (cancelled after the send, its deadline passed after the send, or the owner went away). The owner does not stop
 * a store call it started, so a write can still commit after this process stopped waiting; a rerun without the read
 * can repeat it (a second insertFact is a second fact). The error then names this read instead of advising a rerun.
 *
 * Members that only read write nothing, so a rerun cannot repeat a write: OWNER_IPC_REMOTE_READS (routes.ts) plus the
 * forwarded reads below that a remote caller may not send. Every other forwarded member has an entry, and each read it
 * names is a member that only reads; test/rust-owner-ipc-confirming-reads.test.ts fails otherwise. routes.ts
 * (confirmingReadAdvice) turns the entry into the error's advice.
 */
/** Forwarded members that only read but are not open to remote callers. */
export const OWNER_IPC_LOCAL_ONLY_READS: ReadonlySet<string> = new Set([
  // Typed reads that land ahead of their callers (Rust engine landing parts), as main classes them.
  'readPageIndexingState', 'readWriteVisibilityProbe', 'listSlugAliases', 'readPageTrustRows', 'readOwnerOnlySourcesPresent', 'readOwnerOnlySourceConfig', 'readSourceRow', 'listGuestSourceIds', 'readWriterAdminState', 'readReflexLiveKeys', 'readReflexPages', 'readSegmentedEmbedPage', 'readPageEmbeddingBudget', 'readEmbeddingCompletion', 'loadPurgeTarget', 'countPurgeProbe', 'listPurgeProbeItems', 'probePurgeDerivations', 'countPagePurgeTombstones', 'listPurgeEffects', 'listFactProvenance', 'listSlotRows', 'isFactPurged', 'listWriteGateReceiptsFor', 'listWriteGateHoldRows', 'getWriteGateHoldRow', 'getTrustProposal', 'listTrustProposals', 'readWriterSlugFence', 'readOwnedLinks', 'readLinkTargetPages', 'readWriteRequest', 'readWriteRequestById', 'readOAuthClientWriteGrant', 'readAccessTokenWriteGrant', 'readCounterRows', 'readSourceMembership', 'readRequestEffects', 'readSegmentedGateEvidence', 'readLiveMember', 'readFolderAccess', 'readMayActFor', 'readAudiencePrincipals', 'readLinkedMember', 'readOauthClient', 'readScopeSourceConfigs', 'readLivePageIdBySlug', 'findTakeId', 'getLatestCalibrationProfile', 'readBeliefStateRows',
  'readStoredBodyBytes', 'readPageBodySizes', 'readFieldUsageSamples', 'listFiles', 'getCodeTraversalCache',
  'listSegmentedPages', 'hasWithdrawnFenceClaim',
  // N3: the alias, export, body-manifest, trust-tier, withdrawal-discovery, belief-coverage, search-vector and queue-health reads:
  // SELECTs only. They stay closed to remote callers, as the decide reads below do.
  'readEntityAliasRows', 'readPageAliasRows', 'readPageTitle', 'resolveCaseSensitiveAliases',
  'listAccessPolicySourceIds', 'listExportPageKeys', 'listExportWithdrawals', 'listForcedCutSeqs', 'normalizeFenceLines',
  'readBodyManifestMeta', 'readBodyManifestOutline', 'readBodyManifestRows', 'readExportPageRows', 'readExportWithdrawalLedgerBytes',
  'readSegmentedPageHead', 'readSegmentedVersionBodyBytes', 'listPageTypesByIds', 'listVersionReasonWriters', 'listVersionTrustTiers',
  'readWithdrawalDiscovery', 'listCoveredSources', 'countSearchVectorRows',
  'readQueueHealthSignals', 'listPrivateQueueHealth', 'listQueueWedgeCounts', 'listStuckActiveJobsByName', 'listWaitingByQueue',
  'readOldestWaitingAge', 'readQueueDivergence', 'readWedgeSignals',
  // The core-edit notice read (engine-sql/trust-tier-reads.ts): a SELECT only, closed to remote callers like the other trust-tier reads.
  'listPendingCoreEditNotices',
  // The decide store: SELECTs only (getDecideProposal and getDecideReviewProposal may lock the row, released when
  // the call ends).
  'readDecideState', 'dailyDecideSpend', 'listDecideSpendBySlot', 'listDecideReceiptStats', 'decideSlotUsage',
  'decideConflictNoEntityCounts', 'listDecideReplayReceipts', 'listDecideResolvedModels', 'listDecideMixedModelDecisions',
  'listDecideCalibrations', 'getDecideCalibration', 'getDecideProposal', 'listDecideProposalIds', 'listDecideProposals',
  'listDecideProposedPairs', 'listDecideReviewProposals', 'getDecideReviewProposal', 'listDecideReviewProposalIds',
  'readProposalReviewRates', 'listDueDecideReviewQueue', 'listDueDecideSweepDeferred',
  // The open-loop, timeline, source-state, proposal and access reads of the write-side members (engine-sql/open-loops.ts,
  // timeline-reads.ts, write-misc.ts): SELECTs only (readSourceState may take a share lock, released when the call ends).
  'countSegmentedTimelinePages', 'countTimelineCommentMarkupRows', 'getWorktreeBinding', 'hasExtractedEvents',
  'hasLabelledOnlyMember', 'listAccessTokens', 'listActiveAccessMembers', 'listAwaitingMemoryProposals',
  'listMemoryProposalRows', 'listOpenLoops', 'countOpenLoopsByCounterpartyEmail', 'listOwnerProposalRows', 'listSharedSkillPackRoots',
  'listStoredTimelineRowsOrdered', 'listSynopsisSourceIds', 'listTimelineOrphanPages', 'notifierCoverageRecorded',
  'readAdmissionSource', 'readEntityOpenLoops', 'readHealthMemoClock', 'readMaxTimelineEntryId',
  'readMemoryProposal', 'readOpCheckpointKeys', 'readPendingProposalSummary', 'readSourceState',
  'sampleEffectiveDateSources', 'sampleEffectiveDates', 'sharedSkillPackTablePresent', 'storedTimelineRowsByPageIds',
]);

const page = 'getPage for that slug and source';
const pageId = 'getPage for the page with that id (find its slug with getAllSlugs or listPages)';
const chunks = 'getChunks for that page';
const links = 'getLinks for each page the call named';
const timeline = 'getTimeline for that page';
const takes = 'listTakes for that page';
const configKey = 'getConfig for that key';
const cycleLock = 'readCycleLocks for that lock id';
const decideKey = 'readDecideState for that key';
const calibration = 'getDecideCalibration for that id';

export const OWNER_IPC_CONFIRMING_READS: Readonly<Record<string, string>> = {
  beginSnapshotRead: 'nothing: the setting lasts only for the call, so running it again repeats no write',
  declarePersistence: 'nothing: the setting lasts only for the call, so running it again repeats no write',
  requireSynchronousCommit: 'nothing: the setting lasts only for the call, so running it again repeats no write',
  lockSourceRow: 'nothing: the lock is released when the call ends, so running it again repeats no write',
  deleteOpCheckpoint: 'readOpCheckpointKeys for that operation',
  worktreeClaimStore: 'nothing: the lock is released when the call ends, so running it again repeats no write',
  writerAdminStore: 'nothing: the setting lasts only for the call, so running it again repeats no write',
  recordPageEmbeddingHold: 'readPageEmbeddingBudget for that page',
  openPageEmbeddingHold: 'readPageEmbeddingBudget for that page',
  reservePageEmbedding: 'readPageEmbeddingBudget for that page',
  settlePageEmbeddingReservation: 'readPageEmbeddingBudget for that page',
  lockEffectClaimRow: 'nothing: the lock is released when the call ends, so running it again repeats no write',
  lockEmbeddingSwitch: 'nothing: the lock is released when the call ends, so running it again repeats no write',
  installChunkEmbeddings: 'getChunksWithEmbeddings for that page',
  insertFactPurge: 'listPurgeEffects for that purge',
  insertTakePurge: 'probePurgeDerivations for that purge',
  upsertPagePurges: 'nothing: the write is an upsert keyed by its source and content hash, so running it again repeats no write',
  setPurgeProbeTimeout: 'nothing: the setting lasts only for the call, so running it again repeats no write',
  deletePurgeReviewQueue: 'probePurgeDerivations for that purge',
  deletePurgeReviewProposals: 'probePurgeDerivations for that purge',
  deletePurgeDecideProposals: 'probePurgeDerivations for that purge',
  upsertWriteGateReceipt: 'listWriteGateReceiptsFor that page',
  upsertWriteGateHold: 'getWriteGateHoldRow for that hold',
  insertTrustProposal: 'getTrustProposal for that id',
  setEffectTransactionLimits: 'nothing: the setting lasts only for the call, so running it again repeats no write',
  deleteOwnedLinks: 'readOwnedLinks for that source',
  shareLockWriteCredential: 'nothing: the lock is released when the call ends, so running it again repeats no write',
  lockPersistenceCounters: 'nothing: the lock is released when the call ends, so running it again repeats no write',
  insertWriteRequest: 'readWriteRequest for that request',
  stampWriteClaim: 'readWriteRequest for that request',
  lockWriteRequest: 'nothing: the lock is released when the call ends, so running it again repeats no write',
  completeWriteRow: 'readWriteRequest for that request',
  lockWriteRequestsById: 'nothing: the lock is released when the call ends, so running it again repeats no write',
  compactTerminalIntent: 'readWriteRequest for that request',
  insertPublicationEffects: 'readRequestEffects for that request',
  renewWriteClaim: 'readWriteRequest for that request',
  renewEffectClaim: 'readRequestEffects for that request',
  completeEffectRow: 'readRequestEffects for that request',
  failEffectRow: 'readRequestEffects for that request',
  lockEffectGuard: 'nothing: the lock is released when the call ends, so running it again repeats no write',
  takePageEmbeddingLease: 'readPageEmbeddingBudget for that page',
  renewPageEmbeddingLease: 'readPageEmbeddingBudget for that page',
  releasePageEmbeddingLease: 'readPageEmbeddingBudget for that page',
  insertCalibrationProfile: 'getLatestCalibrationProfile for that source',
  markBeliefCommits: 'readBeliefStateRows',
  executeRaw: 'a SELECT of the rows the statement changes', executeRawDirect: 'a SELECT of the rows the statement changes',
  runMigration: 'the brain schema version (gbrain doctor --json)', initSchema: 'the brain schema version (gbrain doctor --json)',
  ownerOnlyMarkTriggers: 'the trigger state in gbrain doctor --json',
  applyTransactionSettings: 'nothing: the settings last only for the call, so running it again repeats no write',
  lockPageKeys: 'nothing: the lock is released when the call ends, so running it again repeats no write',
  lockRegisteredSourceIds: 'nothing: the lock is released when the call ends, so running it again repeats no write',
  replaceDerivedAliases: 'resolveAliases for that page', refreshPageOrigin: page, putPage: page, deletePage: page,
  deletePages: 'getPage for each slug in that source', softDeletePage: page,
  softDeletePages: 'getPage for each slug in that source', restorePage: page,
  purgeDeletedPages: 'listPages with deleted pages included, for that source',
  applyIdentityDecisions: 'listIdentityDecisions for those entities',
  markPagesExtractedBatch: 'listStalePagesForExtraction for that source',
  markPagesAttendanceBlocked: 'getPage for each page the call named', stripStaleFrontmatterKeys: 'listStaleFrontmatterKeyPages for that source',
  updateSlug: 'getPage for the old and the new slug', setPageAliases: 'resolveAliases for that page',
  updatePageContextualRetrievalState: page, updateSourceConfig: 'getSource for that source id',
  setConfig: configKey, unsetConfig: configKey, createVersion: 'getVersions for that slug',
  revertToVersion: 'getVersions and getPage for that slug', refreshPageBody: page,
  allocateBodyOccurrenceIds: 'nothing: unused ids are never read, so running it again only skips ids',
  stageSegmentTexts: 'readSegmentTexts for that staging id', stageManifestRows: 'readManifest for that page',
  stageSegmentChunks: 'getChunks for that page generation', createSegmentedPageShell: page,
  flipBodyGeneration: 'getPageSealState for that page', sealSegmentedPage: 'getPageSealState for that page',
  openBodyStaging: 'getPageSealState for that page', setBodyStagingState: 'getPageSealState for that page',
  sweepSegments: 'nothing: a sweep removes only unreferenced rows, so running it again removes nothing more',
  upsertSegmentDerivations: 'readSegmentDerivations for that page', retireSegmentDerivations: 'readSegmentDerivations for that page',
  pruneFrontmatterTags: 'getTags for that slug', addPageTagsById: 'getTags for that page', addTag: 'getTags for that slug',
  removeTag: 'getTags for that slug', deleteChunksExcept: chunks, setChunkerVersion: chunks,
  writeTextProjectionSeal: 'getPageSealState for that page', moveChunkIndexes: chunks, upsertChunks: chunks,
  sealChunks: chunks, deleteChunks: chunks, setPageEmbeddingSignature: page,
  invalidateStaleSignatureEmbeddings: 'countStaleChunks for that source', invalidateContentDriftEmbeddings: 'countStaleChunks for that source',
  addLink: links, addLinksBatch: links, replaceDerivedLinks: 'getLinks for the origin page',
  replaceDerivedLinksBatch: 'getLinks for each origin page', replaceWantedLinkRows: 'getLinks for the origin page',
  removeLink: links, removeLinksByPagesAndSource: links, rewriteLinks: 'getBacklinks for the old and the new slug',
  addTimelineEntry: timeline, addTimelineEntriesBatch: 'getTimeline for each page the call named',
  upsertEventProjection: 'getTimeline for the depth page and the event page', removeTimelineRows: timeline,
  updateTimelineDetails: timeline,
  insertFact: 'listFactsByEntity for that entity', insertFacts: 'listFactsByEntity for each entity the call named',
  deleteFactsForPage: 'listFactsByEntity for that page\'s entity', expireFact: 'listFactsByEntity for that fact\'s entity',
  consolidateFact: 'listFactsByEntity for that fact\'s entity', migrateFactsToCanonical: 'listFactsByEntity for the canonical entity',
  addTakesBatch: 'listTakes for each page the call named', updateTakeEmbeddings: 'getTakeEmbeddings for those takes',
  updateTake: takes, supersedeTake: takes, resolveTake: takes, addSynthesisEvidence: 'listTakes for the synthesis page',
  matchTakeRows: takes, deleteTakeRows: takes, upsertFile: 'getFile for that path',
  addCodeEdges: 'getCallersOf and getCalleesOf for those symbols', deleteCodeEdgesForChunks: 'getEdgesByChunk for those chunks',
  putCodeTraversalCache: 'getCodeTraversalCache for that key', clearCodeTraversalCache: 'getCodeTraversalCache for that key',
  setEmotionalWeightBatch: 'getSalienceScores for those pages', putRawData: 'getRawData for that slug and source',
  logEvalCandidate: 'listEvalCandidates', deleteEvalCandidatesBefore: 'listEvalCandidates',
  logEvalCaptureFailure: 'listEvalCaptureFailures', logIngest: 'getIngestLog',
  putDreamVerdict: 'getDreamVerdict for that file and content hash',
  sweepDreamVerdicts: 'nothing: a sweep removes only expired verdicts, so running it again removes nothing more',
  writeContradictionsRun: 'loadContradictionsTrend', putContradictionCacheEntry: 'getContradictionCacheEntry for that key',
  sweepContradictionCache: 'nothing: a sweep removes only expired entries, so running it again removes nothing more',
  mergeOntologyFact: 'getOntology for that entity', insertLocalWriterRow: 'readLocalWriterRow for that writer',
  acquireCycleLock: cycleLock, refreshCycleLock: cycleLock, releaseCycleLock: cycleLock, deleteCycleLock: cycleLock,
  deleteCycleLockIfStale: cycleLock, invalidateWithdrawnPages: 'getPage for each slug in that source',
  upsertDecideState: decideKey, deleteDecideState: decideKey, ensureDecideState: decideKey,
  insertDecideSpend: 'nothing: a row whose request id is already stored is skipped, so running it again adds no row',
  insertDecideReceipts: 'listDecideReplayReceipts for that slot (look for those decision ids)',
  pruneDecideReceipts: 'nothing: a prune removes only rows past the retention, so running it again removes nothing more',
  insertDecideCalibration: 'listDecideCalibrations for that slot', storeDecideQualification: calibration,
  setDecideCalibrationRetired: calibration, insertDecideProposal: 'listDecideProposalIds for that sweep',
  transitionDecideProposal: 'getDecideProposal for that id', insertDecideReviewProposal: 'listDecideReviewProposalIds for that sweep',
  transitionDecideReviewProposal: 'getDecideReviewProposal for that id',
  applyDecideReviewQueue: 'listDueDecideReviewQueue for that kind and source',
  applyDecideSweepDeferred: 'listDueDecideSweepDeferred for that source',
  // The write-side members (engine-sql/open-loops.ts, timeline-reads.ts, write-misc.ts).
  upsertOpenLoop: 'listOpenLoops for that loop\'s source', closeOpenLoop: 'listOpenLoops for that loop\'s source',
  deleteTimelineRows: 'storedTimelineRowsByPageIds for the pages the call named', attachSourcePath: 'readSourceState for that source',
  expireMemoryProposals: 'listMemoryProposalRows for that source', purgeMemoryProposals: 'listMemoryProposalRows for that source',
  // The applied-capture purge (engine-sql/op-checkpoint.ts).
  purgeStaleAppliedCaptures: 'nothing: a purge removes only records past the retention, so running it again removes nothing more',
};

/**
 * The read that confirms each whole operation (whole-op.ts) a client sends as one request. Kept apart from
 * OWNER_IPC_CONFIRMING_READS, whose keys are exactly the forwarded BrainEngine writes.
 */
export const OWNER_IPC_WHOLE_OP_CONFIRMING_READS: Readonly<Record<string, string>> = {
  importFromContent: 'getPage for that slug and source',
  importFromFile: 'getPage for the slug of that file',
  importImageFile: 'getPage for the slug of that file',
  importManagedFiles: 'getPage for each slug the call named',
  snapshotStore: 'nothing: a snapshot writes only a new directory, so the brain is as it was; ask snapshotStatus for the operation id',
  snapshotStatus: 'nothing: it only reads what the owner remembers',
};

/**
 * What the advice adds for a write whose confirming read cannot answer every case. Both decide reads list only due
 * rows (`next_attempt_at <= now()` and fewer than 5 attempts).
 */
export const OWNER_IPC_CONFIRMING_NOTES: Readonly<Record<string, string>> = {
  applyDecideReviewQueue: 'That read lists only due rows: a defer or clear that committed takes the row out of it, so a row still listed means the call did not commit, and an enqueue that committed shows its row.',
  applyDecideSweepDeferred: 'That read lists only due rows: a defer or clear that committed takes the row out of it, so a row still listed means the call did not commit. A defer of a fact that had no row is never listed, so the read cannot tell; a rerun of a defer that did commit only adds one attempt and pushes the next try back.',
};

const MEMBER_TOKEN = /\b[a-z]+[A-Z]\w*\b/g;

/**
 * The members the owner holds back while a `write` it started still runs, whether or not its caller still waits
 * (server.ts, orphanAhead): the reads its confirming read names, or the write itself when that read goes through the same member
 * (executeRaw's SELECT). A write whose rerun repeats nothing (`nothing:`) holds nothing back.
 */
export function membersWaitingFor(write: string): ReadonlySet<string> {
  const read = OWNER_IPC_CONFIRMING_READS[write] ?? OWNER_IPC_WHOLE_OP_CONFIRMING_READS[write];
  if (read === undefined || read.startsWith('nothing:')) return new Set();
  const named = read.match(MEMBER_TOKEN) ?? [];
  return new Set(named.length === 0 ? [write] : named);
}
