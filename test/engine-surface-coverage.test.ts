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
  // The import path's typed reads (part A), each the statement a raw executeRaw call ran on master:
  // sources (engine-sql/sources.ts): the resolver's local-path, routing, default-split and one-row reads, the active-source configs that scope a legacy remote caller, and the folder-import stamp.
  'listLocalPathSources', 'listSourceRoutingRows', 'countDefaultSourceSplit', 'listActiveSourceConfigs', 'markSourceSynced',
  // cli reads (engine-sql/cli-reads-import.ts): the source list, a source's incarnation and company-brain receipt, and the guest lookup.
  'listSourceRecords', 'readSourceIncarnation', 'hasCompanyBrainReceipt', 'readGuestSourceRow',
  // entity reads and writer state: the ignored-privacy-label notice reads, the committed page's frontmatter, the writer-admin state, and whether this role owns the schema tables.
  'readIgnoredPrivacyLabelPages', 'readLivePageFrontmatter', 'ownsSchemaTables',
  // Cycle-lock leases
  'acquireCycleLock', 'refreshCycleLock', 'releaseCycleLock', 'readCycleLocks', 'deleteCycleLock', 'deleteCycleLockIfStale',
  // Alias fan-out reads (engine-sql/alias-fanout-reads.ts; master text pinned by test/n3-sql-move-parity.test.ts)
  'resolveCaseSensitiveAliases', 'readPageTitle', 'readPageAliasRows', 'readEntityAliasRows',
  // CLI export and segmented-body reads (engine-sql/export-reads.ts; master text pinned by test/n3-sql-move-parity.test.ts)
  'listExportPageKeys', 'readExportWithdrawalLedgerBytes', 'listExportWithdrawals', 'readExportPageRows', 'normalizeFenceLines', 'readSegmentedPageHead',
  'readBodyManifestRows', 'readBodyManifestMeta', 'readBodyManifestOutline', 'listForcedCutSeqs', 'readSegmentedVersionBodyBytes', 'listAccessPolicySourceIds',
  // Belief coverage and keyword-index inventory (engine-sql/belief.ts, search-vector.ts)
  'listCoveredSources', 'countSearchVectorRows',
  // Minion queue health reads (engine-sql/jobs-health.ts; master text pinned by test/n3-sql-move-parity.test.ts)
  'readQueueHealthSignals', 'listWaitingByQueue', 'readQueueDivergence', 'listQueueWedgeCounts', 'listPrivateQueueHealth',
  'readWedgeSignals', 'readOldestWaitingAge', 'listStuckActiveJobsByName',
  // Trust-tier reads (engine-sql/trust-tier-reads.ts; master text pinned by test/n3-sql-move-parity.test.ts)
  'listVersionTrustTiers', 'listVersionReasonWriters', 'listPageTypesByIds',
  // Withdrawal discovery (engine-sql/withdrawal-discovery.ts)
  'readWithdrawalDiscovery',
  // Lifecycle
  'connect', 'disconnect', 'reconnect', 'initSchema', 'transaction', 'transactionDirect', 'registerBeforeDisconnect', 'withReservedConnection',
  // Pages CRUD
  'getPage', 'readPageSnapshot', 'readPageSnapshotsBatch', 'lockPageKeys', 'putPage', 'findDuplicatePage', 'findDuplicatePages', 'deletePage', 'deletePages', 'resolveSlugsByPaths',
  'softDeletePage', 'softDeletePages', 'restorePage', 'purgeDeletedPages', 'listPages', 'findPages', 'countPagesBy', 'resolveSlugs', 'getAllSlugs',
  'listAllPageRefs', 'listEntityKeyRows', 'listIdentityDecisions', 'listRestrictedIdentityMembers', 'applyIdentityDecisions', 'listAllSources', 'listSourceLocalPaths', 'updateSourceConfig', 'getSource', 'listPrefixSampledPages', 'listCorpusSample',
  // Hybrid search reads (engine-sql/search-reads.ts) and the onboarding signal count (engine-sql/health.ts)
  'cosinesByChunkIds', 'hasSupersedeEdges', 'supersedingPageSlugs', 'aliasCanonicalRefs', 'pageCollapseFacts', 'slugsEndingIn',
  'generatedPagesIn', 'livePageIdsAt', 'pagesLinkingTo', 'countOnboardSignal',
  'readFieldUsageSamples',
  // schema detect --fields page samples (engine-sql/field-usage.ts; covered by test/engine-parity/field-usage.test.ts)
  'hasWithdrawnFenceClaim',
  // Withdrawal fence check (engine-sql/withdrawal-fence.ts; SQL text pinned by test/withdrawal-fence-sql-pin.test.ts)
  'listSegmentedPages', 'invalidateWithdrawnPages',
  // Withdrawal page statements (engine-sql/withdrawal-pages.ts; SQL text pinned by test/withdrawal-pages-sql-pin.test.ts)
  // Import writes (engine-sql/chunks.ts, tags.ts, pages.ts)
  'deleteChunksExcept', 'setChunkerVersion', 'writeTextProjectionSeal', 'moveChunkIndexes', 'getChunkReuseRows', 'pruneFrontmatterTags',
  'addPageTagsById', 'replaceDerivedAliases', 'getPageSealState', 'refreshPageOrigin',
  'readPageBodySizes',
  'readStoredBodyBytes',
  // The large-page write guard's stored body size read (engine-sql/large-page.ts).
  // Wanted-link, timeline-write, take-fence and code-traversal-cache members (engine-sql/wanted-links.ts, timeline.ts, takes.ts, code-traversal-cache.ts)
  'lockRegisteredSourceIds', 'replaceWantedLinkRows', 'removeTimelineRows', 'updateTimelineDetails', 'matchTakeRows', 'deleteTakeRows',
  'getCodeTraversalCache', 'putCodeTraversalCache', 'clearCodeTraversalCache',
  // Search
  'searchKeyword', 'countKeywordPages', 'searchKeywordPages', 'searchTitles', 'searchVector', 'getEmbeddingsByChunkIds',
  // Chunks
  'upsertChunks', 'sealChunks', 'getChunks', 'getChunkPage', 'getChunkWindows', 'countStaleChunks', 'sumStaleChunkChars', 'setPageEmbeddingSignature',
  'invalidateStaleSignatureEmbeddings', 'invalidateContentDriftEmbeddings', 'listStaleChunks',
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
  'getOnThisDay', 'getLastSeen', 'upsertEventProjection',
  // Ontology
  'mergeOntologyFact', 'getOntology', 'discoverOntologyDimensions', 'findOntologyConflicts',
  // Raw data + files
  'putRawData', 'getRawData', 'upsertFile', 'getFile', 'listFilesForPage', 'listFiles',
  // Takes
  'addTakesBatch', 'listTakes', 'searchTakes', 'searchTakesVector', 'getTakeEmbeddings',
  'countStaleTakes', 'listStaleTakes', 'updateTake', 'supersedeTake', 'resolveTake',
  'getScorecard', 'getCalibrationCurve', 'addSynthesisEvidence',
  // Dream verdicts (sweepDreamVerdicts: wave-k #4069 TTL housekeeping,
  // covered by test/dream-verdict-cache-ttl.test.ts)
  'getDreamVerdict', 'putDreamVerdict', 'sweepDreamVerdicts',
  // Contradiction probe
  'listActiveTakesForPages', 'writeContradictionsRun', 'loadContradictionsTrend',
  'getContradictionCacheEntry', 'putContradictionCacheEntry', 'sweepContradictionCache',
  // Facts (hot memory)
  'insertFact', 'insertFacts', 'deleteFactsForPage', 'expireFact', 'listFactsByEntity',
  'listFactsSince', 'listFactsKeyset', 'listFactsBySession', 'listSupersessions', 'countUnconsolidatedFacts',
  'findCandidateDuplicates', 'consolidateFact', 'findTrajectory', 'getFactsHealth',
  // Versions
  'createVersion', 'getVersions', 'revertToVersion',
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
  'getAllConfig', 'getConfigValues', 'readManagedModeRows', 'getSourceStrictness', 'readPersistenceBrainId', 'readLocalWriterRow', 'insertLocalWriterRow', 'readTransactionSettings', 'applyTransactionSettings', 'readLedgerSource', 'isFolderRestricted', 'updateTakeEmbeddings', 'removeLinksByPagesAndSource',
  // Code edges
  'addCodeEdges', 'deleteCodeEdgesForChunks', 'getCallersOf', 'getCalleesOf', 'getEdgesByChunk',
  'searchKeywordChunks',
  // Eval capture
  'logEvalCandidate', 'listEvalCandidates', 'deleteEvalCandidatesBefore', 'logEvalCaptureFailure',
  'listEvalCaptureFailures',
  // Salience + anomaly + enrich
  'batchLoadEmotionalInputs', 'setEmotionalWeightBatch', 'getRecentSalience', 'listEnrichCandidates',
  'findAnomalies',
  // Wave B segmented page bodies (src/core/engine-sql/page-body.ts; covered by test/large-pages/ and test/engine-sql-page-body.test.ts)
  'allocateBodyOccurrenceIds', 'stageSegmentTexts', 'readSegmentTexts', 'stageManifestRows', 'readManifest', 'stageSegmentChunks',
  'createSegmentedPageShell', 'flipBodyGeneration', 'sealSegmentedPage', 'openBodyStaging', 'setBodyStagingState', 'sweepSegments',
  // Wave B PR 4 per-segment derivation rows (same SQL module; covered by test/engine-sql-segment-derivations.test.ts and its Postgres arm)
  'readSegmentDerivations', 'upsertSegmentDerivations', 'retireSegmentDerivations',
  // GST-3032 owner-only delete triggers (src/core/engine-sql/owner-only-marks.ts; covered by test/owner-only-removal-lineage.test.ts)
  'ownerOnlyMarkTriggers',
  // Decide proposal tables (src/core/engine-sql/decide-proposals.ts; covered by test/engine-parity/decide-proposals.test.ts)
  'applyDecideReviewQueue', 'applyDecideSweepDeferred', 'getDecideProposal', 'getDecideReviewProposal',
  'insertDecideProposal', 'insertDecideReviewProposal', 'listDecideProposalIds', 'listDecideProposals',
  'listDecideProposedPairs', 'listDecideReviewProposalIds', 'listDecideReviewProposals', 'listDueDecideReviewQueue',
  'listDueDecideSweepDeferred', 'readProposalReviewRates', 'transitionDecideProposal', 'transitionDecideReviewProposal',
  // Decide state, spend, receipts and calibrations (src/core/engine-sql/decide-store.ts; covered by test/engine-parity/decide-store.test.ts)
  'dailyDecideSpend', 'decideConflictNoEntityCounts', 'decideSlotUsage', 'deleteDecideState', 'ensureDecideState',
  'getDecideCalibration', 'insertDecideCalibration', 'insertDecideReceipts', 'insertDecideSpend',
  'listDecideCalibrations', 'listDecideMixedModelDecisions', 'listDecideReceiptStats', 'listDecideReplayReceipts',
  'listDecideResolvedModels', 'listDecideSpendBySlot', 'pruneDecideReceipts', 'readDecideState',
  'setDecideCalibrationRetired', 'storeDecideQualification', 'upsertDecideState',
  // Open loops (src/core/engine-sql/open-loops.ts; covered by test/engine-parity/open-loops.test.ts)
  'closeOpenLoop', 'countOpenLoopsByCounterpartyEmail', 'listOpenLoops', 'readEntityOpenLoops', 'upsertOpenLoop',
  // Timeline reads (src/core/engine-sql/timeline-reads.ts; covered by test/engine-parity/timeline-reads.test.ts)
  'countSegmentedTimelinePages', 'countTimelineCommentMarkupRows', 'deleteTimelineRows', 'listStoredTimelineRowsOrdered',
  'listTimelineOrphanPages', 'readMaxTimelineEntryId', 'sampleEffectiveDateSources', 'sampleEffectiveDates',
  'storedTimelineRowsByPageIds',
  // Small write-side reads (src/core/engine-sql/write-misc.ts; pinned by test/write-misc-sql-pin.test.ts)
  'attachSourcePath', 'expireMemoryProposals', 'getWorktreeBinding', 'hasExtractedEvents', 'hasLabelledOnlyMember',
  'listAccessTokens', 'listActiveAccessMembers', 'listAwaitingMemoryProposals', 'listMemoryProposalRows',
  'listOwnerProposalRows', 'listSharedSkillPackRoots', 'listSynopsisSourceIds', 'notifierCoverageRecorded',
  'purgeMemoryProposals', 'readAdmissionSource', 'readHealthMemoClock', 'readMemoryProposal', 'readOpCheckpointKeys',
  'readPendingProposalSummary', 'readSourceState', 'sharedSkillPackTablePresent',
  // Held members the member layer adds before any caller moves (engine-sql/trust-tier-reads.ts, engine-sql/op-checkpoint.ts)
  'listPendingCoreEditNotices', 'purgeStaleAppliedCaptures',
  // Members that land ahead of their callers (Rust engine landing parts), as on the main branch.
  'beginSnapshotRead', 'compactTerminalIntent', 'completeEffectRow', 'completeWriteRow', 'countPagePurgeTombstones', 'countPurgeProbe', 'declarePersistence', 'deleteOpCheckpoint', 'deleteOwnedLinks', 'deletePurgeDecideProposals', 'deletePurgeReviewProposals', 'deletePurgeReviewQueue', 'failEffectRow', 'findTakeId', 'getLatestCalibrationProfile', 'getTrustProposal', 'getWriteGateHoldRow', 'insertCalibrationProfile', 'insertFactPurge', 'insertPublicationEffects', 'insertTakePurge', 'insertTrustProposal', 'insertWriteRequest', 'installChunkEmbeddings', 'isFactPurged', 'listFactProvenance', 'listGuestSourceIds', 'listPurgeEffects', 'listPurgeProbeItems', 'listSlotRows', 'listSlugAliases', 'listTrustProposals', 'listWriteGateHoldRows', 'listWriteGateReceiptsFor', 'loadPurgeTarget', 'lockEffectClaimRow', 'lockEffectGuard', 'lockEmbeddingSwitch', 'lockPersistenceCounters', 'lockSourceRow', 'lockWriteRequest', 'lockWriteRequestsById', 'markBeliefCommits', 'openPageEmbeddingHold', 'probePurgeDerivations', 'readAccessTokenWriteGrant', 'readAudiencePrincipals', 'readBeliefStateRows', 'readCounterRows', 'readEmbeddingCompletion', 'readFolderAccess', 'readLinkTargetPages', 'readLinkedMember', 'readLiveMember', 'readLivePageIdBySlug', 'readMayActFor', 'readOAuthClientWriteGrant', 'readOauthClient', 'readOwnedLinks', 'readOwnerOnlySourceConfig', 'readOwnerOnlySourcesPresent', 'readPageEmbeddingBudget', 'readPageIndexingState', 'readPageTrustRows', 'readReflexLiveKeys', 'readReflexPages', 'readRequestEffects', 'readScopeSourceConfigs', 'readSegmentedEmbedPage', 'readSegmentedGateEvidence', 'readSourceMembership', 'readSourceRow', 'readWriteRequest', 'readWriteRequestById', 'readWriteVisibilityProbe', 'readWriterAdminState', 'readWriterSlugFence', 'recordPageEmbeddingHold', 'releasePageEmbeddingLease', 'renewEffectClaim', 'renewPageEmbeddingLease', 'renewWriteClaim', 'requireSynchronousCommit', 'reservePageEmbedding', 'setEffectTransactionLimits', 'setPurgeProbeTimeout', 'settlePageEmbeddingReservation', 'shareLockWriteCredential', 'stampWriteClaim', 'takePageEmbeddingLease', 'upsertPagePurges', 'upsertWriteGateHold', 'upsertWriteGateReceipt', 'worktreeClaimStore', 'writerAdminStore',
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
  // The member layer's private executors: the raw read the CLI reads run through, and the unscoped CLI-reads executor.
  'rawRead',
  // The raw read the entity reads run through (no statement bound): readIgnoredPrivacyLabelPages, readLivePageFrontmatter.
  'untimedRead',
  'cliReads',
  'connectForRestore',
  'applyForwardReferenceBootstrap',
  'getBulkRetryOpts',
  'batchRetry',
  'activeEmbeddingColId',
  'codeEdgesDeps',
  // refactor wave 1 C9: per-call engine-sql executor getter (EO1).
  'engineSql',
  // Cycle-lock leases: the engine-sql executor the lease statements run through (the methods themselves are in INTERFACE_METHODS).
  'cycleLockSql',
  // Hybrid search reads: the unscoped engine-sql executor the search-read methods run through.
  'searchRead',
  // Alias fan-out reads: the unscoped engine-sql executor the alias read methods run through.
  'aliasFanoutRead',
  // Engine graduation: PGLite close/open that keeps the kernel lock across the custody window.
  'closeRetainingLock',
  'connectWithHeldLock',
  // #9227: whether this engine holds the datastore lock; the PGLite abandoned-claim release rests on it.
  'holdsDatastoreLock',
  // The unscoped engine-sql executors the timeline reads and the write-side reads run through.
  'timelineRead', 'writeMiscReads',
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
