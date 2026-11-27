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
const MEMBERS_DIR = join(REPO, 'src', 'core', 'engine-members');
export const COVERAGE_FILE = join(PARITY_DIR, 'coverage.tsv');

/**
 * Method families (research 01 grouping). Every callable BrainEngine member
 * must appear exactly once; the generator throws otherwise, so a new engine
 * method forces a visible family assignment here.
 */
export const FAMILIES: Record<string, readonly string[]> = {
  mention_pass: ['storeSegmentDerivationsIfLive'],
  belief_purge: ['hasBeliefEvents', 'bumpSourcePurgeEpoch'],
  connect_gate: ['listManagedRootBindings', 'hasPersistenceTable'],
  projection_rebuild: ['queuePageProjectionJob', 'releaseDeferredReplacementClaim', 'renewDeferredReplacementClaim', 'isDeferredReplacementHeld', 'readProjectionHead', 'countPendingTextChunks', 'clearChunkVectors', 'listStaleChunkVectors', 'deleteUnkeptChunks', 'readChunkRowsFingerprint', 'hasDrainableProjectionJob', 'setProjectionChunkerVersion', 'clearUnkeptChunkVectors', 'readChunkKeepState'],
  facts_cycle_sites: ['readLiveStoredBody'],
  cli_reads_ops: ['readFenceOverlayRows', 'listHeldFenceCells'],
  link_reads: ['readLinkContextOriginPages', 'readLinkContextMatches'],
  calibration_profiles: ['purgeCalibrationProfilesByWave', 'insertCalibrationProfile', 'getLatestCalibrationProfile'],
  trust: ['upsertPageWriteGateReceipt', 'listPurgedTakeRows', 'readSourcePurgeFlags', 'insertFactWithdrawal', 'getWriteGateHoldRow', 'listWriteGateHoldRows', 'upsertWriteGateHold', 'listWriteGateReceiptsFor', 'upsertWriteGateReceipt', 'isFactPurged'],
  minion_queue: ['readOauthClient', 'readScopeSourceConfigs'],
  belief_ledger: ['readBeliefFactsById', 'endBeliefLifetime', 'readOpenBeliefLifetimes', 'insertBeliefEvents', 'readBeliefStateRows', 'markBeliefCommits'],
  persistence_journal: ['deleteProjectionJob', 'readCapacityForecastInputs', 'releaseUnpublishedClaim', 'findTopologyChanges', 'readOwnerHostBinding', 'readAdmissionRate', 'readWriteRequestsByRequestIds', 'readSourcePurgeEpoch', 'readJournalLimitRows', 'hasNotifierCoverage', 'readNotifierStatusRows', 'readSegmentedGateEvidence', 'lockEffectGuard', 'failEffectRow', 'completeEffectRow', 'renewEffectClaim', 'readRequestEffects', 'renewWriteClaim', 'readSourceMembership', 'insertPublicationEffects', 'compactTerminalIntent', 'lockWriteRequestsById', 'completeWriteRow', 'lockWriteRequest', 'stampWriteClaim', 'insertWriteRequest', 'lockPersistenceCounters', 'readCounterRows', 'shareLockWriteCredential', 'readAccessTokenWriteGrant', 'readOAuthClientWriteGrant', 'readWriteRequestById', 'readWriteRequest', 'requireSynchronousCommit', 'declarePersistence'],
  facts_recall: ['listSlotRows'],
  facts_trust: ['markNeedsRederive', 'softDeleteDerivedPages', 'deactivateDerivedTakes', 'expireDerivedFacts', 'listDerivedRows', 'listFactProvenance'],
  purge_plan: ['listRequestsHoldingStagings', 'listPurgeProbeItems', 'countPurgeProbe'],
  facts_purge: ['insertPurgeEffects', 'listPurgedPageRevisions', 'deletePurgeTakeProposals', 'insertHoldingPagePurges', 'deleteUnreferencedPurgedTexts', 'deletePageViewDigests', 'deletePurgedStagingParts', 'abortPurgedStagings', 'listSegmentedVersionsForPurge', 'redactVersionChangeReasons', 'setPurgeVersionBody', 'findPurgeBlockedPublication', 'listPurgeStreamSlugs', 'countPurgeReviewRows', 'countPurgeVersionsCarryingClaim', 'countPurgeFingerprintResidue', 'readDeletePageRequest', 'readPurgeReceiptSourcePath', 'listPageProseHits', 'vacuumPurgedTables', 'countLegacyDerivedPages', 'listNearestFactsForPurge', 'listPageSourcePathsForPurge', 'listFactContextsForPurgeProbe', 'listBeliefEventsForPurgeProbe', 'listSegmentedVersionBodies', 'listSegmentedPageBodies', 'listRequestsRecordingReasons', 'listPageChangeReasons', 'listPageGitEffectsForStrip', 'countFactFingerprintLeftovers', 'deletePurgeDecideProposals', 'deletePurgeReviewProposals', 'deletePurgeReviewQueue', 'listPurgeEffects', 'countPagePurgeTombstones', 'probePurgeDerivations', 'setPurgeProbeTimeout', 'upsertPagePurges', 'insertTakePurge', 'insertFactPurge', 'loadPurgeTarget'],
  reflex_reads: ['readReflexPages', 'readReflexLiveKeys'],
  trust_proposals: ['listTrustProposals', 'getTrustProposal', 'insertTrustProposal'],
  remote_links: ['rearmLinksEffects', 'readLinkTargetPages', 'deleteOwnedLinks', 'readOwnedLinks', 'setEffectTransactionLimits'],
  page_visibility: ['readWriterSlugFence', 'readWriteVisibilityProbe'],
  write_guards: ['sealImportedPage', 'readPageOrigin', 'readPageIndexingState'],
  access_members: ['readLinkedMember'],
  cli_reads_import: ['readRowTrustRows', 'hasCompanyBrainReceipt', 'readSourceIncarnation', 'readPageTrustRows', 'listGuestSourceIds', 'listSourceRecords', 'readGuestSourceRow'],
  lifecycle: ['connect', 'disconnect', 'reconnect', 'initSchema', 'holdSchemaMigrationLock', 'transaction', 'transactionDirect',
    'registerBeforeDisconnect', 'withReservedConnection'],
  pages: ['readLivePageIdBySlug', 'lockSourceRow', 'readSourceRow', 'readOwnerOnlySourceConfig', 'readOwnerOnlySourcesPresent', 'getPage', 'readPageSnapshot', 'readPageSnapshotsBatch', 'lockPageKeys', 'putPage', 'findDuplicatePage', 'findDuplicatePages',
    'deletePage', 'deletePages', 'resolveSlugsByPaths', 'softDeletePage', 'softDeletePages', 'restorePage', 'purgeDeletedPages',
    'listPages', 'findPages', 'countPagesBy', 'resolveSlugs', 'getAllSlugs', 'listAllPageRefs', 'listEntityKeyRows', 'listIdentityDecisions', 'listRestrictedIdentityMembers', 'applyIdentityDecisions', 'listAllSources', 'listSourceLocalPaths', 'updateSourceConfig', 'getSource',
    'listPrefixSampledPages', 'listCorpusSample', 'getPageSealState', 'refreshPageOrigin', 'listLocalPathSources', 'listSourceRoutingRows', 'countDefaultSourceSplit', 'markSourceSynced', 'listActiveSourceConfigs'],
  search: ['searchKeyword', 'countKeywordPages', 'searchKeywordPages', 'searchTitles', 'searchVector', 'getEmbeddingsByChunkIds',
    'searchKeywordChunks'],
  search_reads: ['cosinesByChunkIds', 'hasSupersedeEdges', 'supersedingPageSlugs', 'aliasCanonicalRefs', 'pageCollapseFacts',
    'slugsEndingIn', 'generatedPagesIn', 'livePageIdsAt', 'pagesLinkingTo'],
  chunks: ['hasUnsealedPages', 'installChunkEmbeddings', 'lockEmbeddingSwitch', 'lockEffectClaimRow', 'readEmbeddingCompletion', 'settlePageEmbeddingReservation', 'reservePageEmbedding', 'openPageEmbeddingHold', 'recordPageEmbeddingHold', 'readPageEmbeddingBudget', 'upsertChunks', 'sealChunks', 'getChunks', 'getChunkPage', 'getChunkWindows', 'countStaleChunks', 'sumStaleChunkChars',
    'setPageEmbeddingSignature', 'invalidateStaleSignatureEmbeddings', 'invalidateContentDriftEmbeddings', 'listStaleChunks',
    'countChunklessPagesWithContent', 'listChunklessPagesWithContent', 'readEmbeddingStateCounts', 'listEmbeddingStateRows',
    'deleteChunks', 'getChunksWithEmbeddings', 'deleteChunksExcept', 'setChunkerVersion', 'writeTextProjectionSeal',
    'moveChunkIndexes', 'getChunkReuseRows'],
  extraction: ['countStalePagesForExtraction', 'listStalePagesForExtraction', 'markPagesExtractedBatch', 'markPagesAttendanceBlocked',
    'countStaleFrontmatterKeyPages', 'listStaleFrontmatterKeyPages', 'stripStaleFrontmatterKeys'],
  links: ['addLink', 'addLinksBatch', 'replaceDerivedLinks', 'replaceDerivedLinksBatch', 'removeLink', 'removeLinksByPagesAndSource',
    'getLinks', 'getBacklinks', 'listLinkSources', 'findByTitleFuzzy', 'traverseGraph', 'traversePaths', 'traversePathsDetailed',
    'relationalFanout', 'relationalChainHop', 'getBacklinkCounts', 'getAdjacencyBoosts', 'getContentFlagsByPageIds',
    'getUnverifiedExtractionPageIds', 'getPageTimestamps', 'getEffectiveDates', 'getSalienceScores', 'findOrphanPages'],
  tags: ['addTag', 'removeTag', 'getTags', 'pruneFrontmatterTags', 'addPageTagsById'],
  timeline: ['addTimelineEntry', 'addTimelineEntriesBatch', 'getTimeline', 'getTimelineForDate', 'getSince', 'getOnThisDay',
    'getLastSeen', 'upsertEventProjection', 'removeTimelineRows', 'updateTimelineDetails',
    'countSegmentedTimelinePages', 'countTimelineCommentMarkupRows', 'deleteTimelineRows', 'listStoredTimelineRowsOrdered', 'listTimelineOrphanPages', 'readMaxTimelineEntryId', 'sampleEffectiveDateSources', 'sampleEffectiveDates', 'storedTimelineRowsByPageIds'],
  ontology: ['mergeOntologyFact', 'getOntology', 'discoverOntologyDimensions', 'findOntologyConflicts'],
  raw_files: ['putRawData', 'getRawData', 'upsertFile', 'getFile', 'listFilesForPage', 'listFiles'],
  takes: ['findTakeId', 'addTakesBatch', 'updateTakeEmbeddings', 'listTakes', 'searchTakes', 'searchTakesVector', 'getTakeEmbeddings',
    'countStaleTakes', 'listStaleTakes', 'updateTake', 'supersedeTake', 'resolveTake', 'getScorecard', 'getCalibrationCurve',
    'addSynthesisEvidence', 'listActiveTakesForPages', 'matchTakeRows', 'deleteTakeRows'],
  dream: ['getDreamVerdict', 'putDreamVerdict', 'sweepDreamVerdicts'],
  contradictions: ['listLiveTakesByIds', 'listLiveChunksByIds', 'writeContradictionsRun', 'loadContradictionsTrend', 'getContradictionCacheEntry', 'putContradictionCacheEntry',
    'sweepContradictionCache'],
  facts: ['insertFact', 'insertFacts', 'deleteFactsForPage', 'expireFact', 'listFactsByEntity', 'listFactsSince', 'listFactsKeyset',
    'listFactsBySession', 'listSupersessions', 'countUnconsolidatedFacts', 'findCandidateDuplicates', 'consolidateFact',
    'findTrajectory', 'getFactsHealth'],
  segmented_body: ['deleteRewrittenSegmentDerivations', 'readSegmentedEmbedPage', 'allocateBodyOccurrenceIds', 'stageSegmentTexts', 'readSegmentTexts', 'stageManifestRows', 'readManifest',
    'stageSegmentChunks', 'createSegmentedPageShell', 'flipBodyGeneration', 'sealSegmentedPage', 'openBodyStaging', 'setBodyStagingState', 'sweepSegments',
    'readSegmentDerivations', 'upsertSegmentDerivations', 'retireSegmentDerivations'],
  versions: ['createVersion', 'getVersions', 'revertToVersion'],
  stats_ingest: ['getStats', 'getHealth', 'countOnboardSignal', 'logIngest', 'getIngestLog'],
  sync_aliases: ['updateSlug', 'rewriteLinks', 'resolveSlugWithAlias', 'resolveSlugWithAliasDetailed', 'resolveAliases',
    'setPageAliases', 'replaceDerivedAliases', 'refreshPageBody', 'updatePageContextualRetrievalState', 'migrateFactsToCanonical'],
  config: ['readStoredConfigValue', 'getConfig', 'setConfig', 'unsetConfig', 'listConfigKeys', 'getAllConfig', 'getConfigValues'],
  // withdrawal_pages: the page statements a fact withdrawal runs on the pages that carry the claim
  withdrawal_pages: ['listSegmentedPages', 'invalidateWithdrawnPages'],
  // withdrawal_fence: the withdrawal check a prepared import runs on a malformed facts fence
  withdrawal_fence: ['hasWithdrawnFenceClaim'],
  import_guards: ['setWriteContext', 'beginSnapshotRead', 'ownsSchemaTables', 'readManagedModeRows', 'getSourceStrictness', 'readPersistenceBrainId', 'readLocalWriterRow', 'insertLocalWriterRow',
    'readTransactionSettings', 'applyTransactionSettings', 'readLedgerSource', 'isFolderRestricted'],
  cycle_locks: ['releasePageEmbeddingLease', 'renewPageEmbeddingLease', 'takePageEmbeddingLease', 'acquireCycleLock', 'refreshCycleLock', 'releaseCycleLock', 'readCycleLocks', 'deleteCycleLock', 'deleteCycleLockIfStale'],
  raw_sql: ['runMigration', 'executeRaw', 'executeRawDirect', 'keywordBoundedRead'],
  code_edges: ['addCodeEdges', 'deleteCodeEdgesForChunks', 'getCallersOf', 'getCalleesOf', 'getEdgesByChunk',
    // group D (code traversal cache)
    'getCodeTraversalCache', 'putCodeTraversalCache', 'clearCodeTraversalCache'],
  eval_capture: ['logEvalCandidate', 'listEvalCandidates', 'deleteEvalCandidatesBefore', 'logEvalCaptureFailure',
    'listEvalCaptureFailures'],
  // large_page: the remote put_page large-page guard's stored body size read (engine-sql/large-page.ts)
  large_page: ['readStoredBodyBytes', 'readPageBodySizes'],
  // field_usage: schema detect --fields page samples (engine-sql/field-usage.ts)
  field_usage: ['readFieldUsageSamples'],
  // the decide proposal tables (engine-sql/decide-proposals.ts)
  decide_proposals: [
    'applyDecideReviewQueue', 'applyDecideSweepDeferred', 'getDecideProposal', 'getDecideReviewProposal',
    'insertDecideProposal', 'insertDecideReviewProposal', 'listDecideProposalIds', 'listDecideProposals',
    'listDecideProposedPairs', 'listDecideReviewProposalIds', 'listDecideReviewProposals', 'listDueDecideReviewQueue',
    'listDueDecideSweepDeferred', 'readProposalReviewRates', 'transitionDecideProposal', 'transitionDecideReviewProposal'],
  // the decide state, spend, receipt and calibration tables (engine-sql/decide-store.ts)
  decide_store: [
    'dailyDecideSpend', 'decideConflictNoEntityCounts', 'decideSlotUsage', 'deleteDecideState', 'ensureDecideState',
    'getDecideCalibration', 'insertDecideCalibration', 'insertDecideReceipts', 'insertDecideSpend',
    'listDecideCalibrations', 'listDecideMixedModelDecisions', 'listDecideReceiptStats', 'listDecideReplayReceipts',
    'listDecideResolvedModels', 'listDecideSpendBySlot', 'pruneDecideReceipts', 'readDecideState',
    'setDecideCalibrationRetired', 'storeDecideQualification', 'upsertDecideState'],
  // alias_fanout_reads: the alias reads of search's alias fan-out and the entity card (engine-sql/alias-fanout-reads.ts)
  alias_fanout_reads: ['listSlugAliases', 'resolveCaseSensitiveAliases', 'readPageTitle', 'readPageAliasRows', 'readEntityAliasRows'],
  // cli_reads_export: the reads gbrain export ran through executeRaw (engine-sql/export-reads.ts)
  cli_reads_export: ['listExportPageKeys', 'readExportWithdrawalLedgerBytes', 'listExportWithdrawals', 'readExportPageRows', 'normalizeFenceLines',
    'readSegmentedPageHead', 'readBodyManifestRows', 'readBodyManifestMeta', 'listAccessPolicySourceIds', 'readBodyManifestOutline',
    'listForcedCutSeqs', 'readSegmentedVersionBodyBytes'],
  // jobs_health: the queue health reads of doctor, the advisor and the submit probe (engine-sql/jobs-health.ts)
  jobs_health: ['readQueueHealthSignals', 'listWaitingByQueue', 'readQueueDivergence', 'listQueueWedgeCounts', 'listPrivateQueueHealth',
    'readWedgeSignals', 'readOldestWaitingAge', 'listStuckActiveJobsByName'],
  // trust_tier_reads: the stamped-tier reads of core memory, the trust scan, belief history and page history (engine-sql/trust-tier-reads.ts)
  trust_tier_reads: ['pageAwaitsRederive', 'readCursorEdition', 'readPageVersionEdition', 'listAmendmentsNotApplied', 'pickValidTimeEdition', 'listValidTimeIdentities', 'lockLivePagesByKey', 'listPageTrustTiersByKey', 'listPageRefsByIds', 'listVisibleBeliefLifetimes', 'readBeliefHistoryRows', 'readTrustScanCeilings', 'listClaimPendingSourceIds', 'writeTrustScanCursor', 'readTrustScanCursor', 'countUnscannedTrustRows', 'listTrustScanRows', 'listCorePageRows', 'listVersionTrustTiers', 'listVersionReasonWriters'],
  // withdrawal_discovery: the reads of a fact withdrawal's discovery pass (engine-sql/withdrawal-discovery.ts)
  withdrawal_discovery: ['readWithdrawalDiscovery'],
  // belief_reads / search_vector: single reads (engine-sql/belief.ts, search-vector.ts)
  belief_reads: ['listCoveredSources'],
  search_vector: ['countSearchVectorRows'],
  // open_loops: the loop upsert, list and close statements (engine-sql/open-loops.ts)
  open_loops: [
    'closeOpenLoop', 'listOpenLoops', 'purgeStaleAppliedCaptures', 'listPendingCoreEditNotices', 'countOpenLoopsByCounterpartyEmail', 'readEntityOpenLoops', 'upsertOpenLoop'],
  // write_misc: the small write-side reads (engine-sql/write-misc.ts)
  write_misc: ['readAccessMembers', 'addPersistenceCounters', 'publicationJournalStore', 'readWorktreeManifest', 'readAudiencePrincipals', 'readMayActFor', 'readFolderAccess', 'readLiveMember', 'deleteOpCheckpoint', 'writerAdminStore', 'readWriterAdminState', 'worktreeClaimStore', 
    'attachSourcePath', 'expireMemoryProposals', 'getWorktreeBinding', 'hasExtractedEvents', 'hasLabelledOnlyMember',
    'listAccessTokens', 'listActiveAccessMembers', 'listAwaitingMemoryProposals', 'listMemoryProposalRows',
    'listOwnerProposalRows', 'listSharedSkillPackRoots', 'listSynopsisSourceIds', 'purgeMemoryProposals', 'readAdmissionSource', 'readHealthMemoClock', 'readMemoryProposal', 'readOpCheckpointKeys',
    'readPendingProposalSummary', 'readSourceState', 'sharedSkillPackTablePresent'],
  entity_reads: ['readIgnoredPrivacyLabelPages', 'readLivePageFrontmatter', 'readImageSealProbe', 'readPageChunkerVersion'],
  owner_only: ['ownerOnlyMarkTriggers'],
  wanted_links: ['lockRegisteredSourceIds', 'replaceWantedLinkRows'],
  salience_enrich: ['batchLoadEmotionalInputs', 'setEmotionalWeightBatch', 'getRecentSalience', 'listEnrichCandidates', 'findAnomalies'],
};

/**
 * Callable members of `interface BrainEngine`, in declaration order (`kind` excluded): its own members, then those of
 * the interfaces it extends (src/core/engine-members/*.ts, in `extends` order).
 */
export function interfaceMethods(): string[] {
  const names: string[] = [];
  const declared = new Map<string, ts.InterfaceDeclaration>();
  const load = (file: string) => {
    const text = readFileSync(file, 'utf8'); // test-reads-source-ok[structural]: parse the interface member names only.
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    sf.forEachChild((node) => { if (ts.isInterfaceDeclaration(node)) declared.set(node.name.text, node); });
  };
  load(ENGINE_FILE);
  for (const entry of readdirSync(MEMBERS_DIR).filter((f) => f.endsWith('.ts')).sort()) load(join(MEMBERS_DIR, entry));
  const walk = (node: ts.InterfaceDeclaration) => {
    for (const member of node.members) {
      if (!member.name || !ts.isIdentifier(member.name)) continue;
      const callable = ts.isMethodSignature(member)
        || (ts.isPropertySignature(member) && member.type !== undefined && ts.isFunctionTypeNode(member.type));
      if (callable && !names.includes(member.name.text)) names.push(member.name.text);
    }
    for (const clause of node.heritageClauses ?? []) {
      for (const type of clause.types) {
        const parent = ts.isIdentifier(type.expression) ? declared.get(type.expression.text) : undefined;
        if (!parent) throw new Error(`engine-parity coverage: ${node.name.text} extends ${type.expression.getText()}, which is not declared in src/core/engine.ts or src/core/engine-members/`);
        walk(parent);
      }
    }
  };
  const brainEngine = declared.get('BrainEngine');
  if (brainEngine) walk(brainEngine);
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
