/**
 * The fact purge's engine surface, in one list, and its pre-write check. `purge_fact` (the `gbrain forget <id> --purge`
 * operation, src/core/facts/purge.ts) admits a write request into the persistence journal and then runs one transaction
 * of about thirty typed members and a few raw-SQL sites. On a Rust brain some of them are not served yet, so the purge
 * used to journal its request and stop inside the transaction on the first one, with a refusal that named no owner and
 * no date. `requireFactPurgeServed` (called by the operation in src/core/ops/purge.ts, never by facts/purge.ts) reads this
 * list instead and refuses before the purge calls any engine member: nothing is journaled, written or read, and the
 * refusal names the first stop with the lane that lifts it and the date.
 *
 * It uses the page purge's list types and check (persistence/purge-path-members.ts) and reads the Rust engine's own
 * classification (`rustMemberCapability`), so a member leaves the list's stops the moment the Rust engine serves it.
 *
 * Which requests it covers (`factPurgeEntryPoint`): a real run (`purge`) and `--status --continue` (`continue`: it first
 * continues the derivation sweep, which writes). A dry run, `--match` and a plain `--status` only read, so they are not
 * checked and run on a Rust brain as they did. A remote call is refused as host-only by the purge itself, first.
 *
 * Where an entry can stop a purge, as in the page list: a member the Rust engine does not serve carries `stop`; a
 * raw-SQL site refuses on an engine without `raw_sql` unless its branch is guarded away from that engine (`guarded`);
 * an unguarded one is a stop. PGLite and Postgres serve every entry, so the check is a no-op there. Every stop carries
 * its `owner` and `due` date. The entries marked `entry: 'purge'` are reached only by a real run; the rest also by
 * `--status --continue`.
 *
 * The order is the order a purge reaches the entries in, so the first stop is the first thing a Rust purge would hit.
 * The list is the union of the purge's branches (a purge of a fact with pages, takes, derived rows, staged uploads
 * and a belief ledger): a stop in a branch this purge does not take still refuses it, because the check cannot know
 * before the purge has run which branch it takes.
 *
 * test/fact-purge-path-members.test.ts runs the purge through a recording engine proxy and fails when it calls a member
 * or a raw site that is not listed, when a listed member is missing from an engine, and when a member that is not served
 * on Rust has no stop. When a lane serves a stop, its entry loses `stop` in the lane's commit; the check then stops
 * refusing for it and for nothing else. There is no manual or partial lift.
 *
 * What the stops are, from a trial merge of rust-engine/rust-5a bc4cc890fe (nothing merged, nothing pushed):
 * - rust-5a serves the purge transaction's statements and the fingerprint count (`factPurgeTx`, due Nov 23);
 * - it does not serve the version-body SELECT of `rewriteVersionBodies`, which is raw SQL with no constant text to type;
 * - the sweep after the commit, `continueDerivationPurges`, is the typed member `continueDerivationSweep`, served on Rust by this lane
 *   (page_body/derivation_sweep.rs): no stop is left for it;
 * - the receipt's ledger reads and the generation-ledger scrub keep the owners and dates the page purge list names;
 * - the segmented-page branches (a page stored as segments, a staged upload and the write that would publish it) add raw sites,
 *   each with the owner and date Ember ruled: the segmented rewrite statements (trunk, Nov 23; lifted: segment-pending-stamp serves
 *   them as typed members), the segmented purge writes (the
 *   flip, the segmented version insert and prune, the derivation delete, the inline version insert and the version-body read:
 *   lane 1, Nov 25) and the cancellation of a staged write with its terminal compaction (lane 5, Nov 25).
 *   No stop is left without an owner and a date (test/fact-purge-path-members.test.ts).
 */
import type { BrainEngine } from '../engine.ts';
import { refusePurgeEntryStop } from '../rust-engine/errors.ts';
import { PURGE_DUE, PURGE_OWNERS, entryStops, type PurgePathEntry, type PurgePathStop } from './purge-path-members.ts';

/** The requests that write: a real run, and `--status --continue` (it continues the derivation sweep). */
export type FactPurgeEntryPoint = 'purge' | 'continue';
export type FactPurgeEntry = PurgePathEntry<'purge'>;

const { ours, beliefProbe, factContextProbe, receiptReads, factPurgeTx, segmentedRewrite, beliefLedger } = PURGE_OWNERS;
const { nov23 } = PURGE_DUE;
const served = (owner: string, ...members: Array<keyof BrainEngine & string>): FactPurgeEntry[] => members.map(member => ({ member, owner }));

/**
 * Raw sites a fact purge reaches on PGLite and Postgres whose branch a Rust brain does not take. The Rust purge (with
 * raw SQL stubbed to answer nothing, in the trial merge) reached none of them.
 */
const GUARDED_SITES: FactPurgeEntry[] = [
  ['purgedFenceRows (facts/purge-overlay.ts)', 'an engine without raw_sql asks the typed isFactPurged'],
  ['canAnalyzePages (search/projection-statistics.ts)', 'no query planner on Rust (D18): lacksRawSql returns before the raw SQL'],
  ['<anonymous> (search/projection-statistics.ts)', 'no query planner on Rust (D18): refreshProjectionStatistics returns before the raw SQL'],
  ['readProjectionStatistics (search/projection-statistics.ts)', 'no query planner on Rust (D18): refreshProjectionStatistics returns before the raw SQL'],
  ['beginFullAnalyze (planner-stats.ts)', 'no query planner on Rust (D18): lacksRawSql returns before the raw SQL'],
  ['readWatermarks (planner-stats.ts)', 'no query planner on Rust (D18): lacksRawSql returns before the raw SQL'],
  ['publishWatermark (planner-stats.ts)', 'no query planner on Rust (D18): lacksRawSql returns before the raw SQL'],
  ['noteProjectionRebuilds (page-state/projections.ts)', 'no query planner on Rust (D18): the page count is read only when lacksRawSql is false'],
  ['readManagedMode (persistence/managed-mode.ts)', 'a Rust brain reads readManagedModeRows (isRustBrain branch)'],
  ['overlayCanonicalBodies (page-state/snapshot.ts)', 'reached through a SQL engine\'s own readPageSnapshot; the Rust engine serves that member from its store'],
].map(([site, guarded]) => ({ site: site!, owner: ours, guarded: guarded! }));

/**
 * The purge's path, in the order a real run reaches it: the members it calls (lane 4's rust-5a serves the purge
 * transaction's statements, the fact-context probe and the effect read, so they are no stops), the raw-SQL stops, then
 * the members the Rust engine serves, then the raw sites guarded away from it.
 */
export const FACT_PURGE_PATH: readonly FactPurgeEntry[] = [
  // assertNoPendingPublication, then the belief streams of the facts.
  ...served(factPurgeTx, 'findPurgeBlockedPublication'),
  ...served(factPurgeTx, 'listPurgeStreamSlugs'),
  // On a source that records belief events: the derived rows' belief streams (belief/purge.ts derivedStreamSlugs).
  ...served(beliefLedger, 'listDerivedStreamSlugs'),
  // hideDerivedRows: the rows derived from the facts are hidden through their own tables and marked for re-derivation.
  ...served(factPurgeTx, 'expireDerivedFacts'),
  ...served(factPurgeTx, 'deactivateDerivedTakes'),
  ...served(factPurgeTx, 'softDeleteDerivedPages'),
  ...served(factPurgeTx, 'markNeedsRederive'),
  // The deletes of the purge itself.
  ...served(factPurgeTx, 'deletePurgeTakeProposals'),
  // rewritePageBodies: the pages that held the claim lose its fence rows. A segmented page publishes a new generation
  // (rewriteLiveSegmentedFences, then a version of the old revision); an inline page is versioned first, then rewritten.
  // The segmented page's live fences are rewritten through typed members since segment-pending-stamp (segmented-writes.ts).
  ...served(segmentedRewrite, 'readSegmentedRewritePage', 'restorePageDeletedAt', 'restorePageUpdatedAt', 'setSegmentedVersionHash'),
  // The segmented body's chunk reads the rewrite makes are typed members the Rust store serves (repair-rust b6b, segmented-writes.ts).
  ...served(segmentedRewrite, 'listChunkedOccurrences', 'readRetiredChunkVectors', 'hasStaleSegmentChunks'),
  ...served(ours, 'normalizeFenceLines'),
  // redactPageVersions: the change reasons first, then the inline versions, then the segmented ones.
  ...served(factPurgeTx, 'redactVersionChangeReasons'),
  ...served(factPurgeTx, 'setPurgeVersionBody'),
  ...served(factPurgeTx, 'listSegmentedVersionsForPurge'),
  ...served(segmentedRewrite, 'lockSegmentedGenerationPage', 'splitManifestGeneration', 'publishRebuiltGeneration', 'setMaterializingRevision', 'installSegmentedVectors'),
  // purgeSegmentStorage: the writes that would publish a staged body are cancelled, the stagings aborted, the texts deleted.
  ...served(factPurgeTx, 'abortPurgedStagings'),
  ...served(factPurgeTx, 'deletePurgedStagingParts'),
  ...served(factPurgeTx, 'deletePageViewDigests'),
  ...served(factPurgeTx, 'deleteUnreferencedPurgedTexts'),
  // The purge effects of the git mirror.
  ...served(factPurgeTx, 'listPurgedPageRevisions'),
  ...served(factPurgeTx, 'insertPurgeEffects'),
  // On a source that records belief events: the belief batch's preimage check, then the ledger redaction after the deletes
  // (belief/purge.ts: purged keys, carrying fields, live and version carriers, the derived-hidden keys).
  ...served(beliefLedger, 'listMissingPreimages', 'redactPurgedBeliefKeys', 'listBeliefCarrierEvents', 'readBeliefEventValue', 'rewriteBeliefEventFields',
    'rechainBeliefPriorHash', 'listBeliefQuotingRows', 'listPurgeCarrierVersions', 'listKnownBeliefSubjectKeys'),
  // verifyFactPurge: the receipt.
  // The receipt pages the recorded values for the purged claims (trust/belief_purge.rs).
  ...served(beliefProbe, 'listBeliefEventsForPurgeProbe'),
  ...served(factContextProbe, 'listFactContextsForPurgeProbe'),
  // The completion of a purge (also read by `--status --continue`): the effect rows, then the fingerprint count.
  ...served(receiptReads, 'listPurgeEffects'),
  ...served(factPurgeTx, 'countPurgeFingerprintResidue'),
  // The members the purge calls and the Rust engine serves.
  ...served(ours,
    // the derivation sweep after the commit (and again by `--status --continue`): served on Rust since part B of step 6
    'continueDerivationSweep',
    'listRequestsHoldingStagings', 'readManifest', 'readSegmentedPageHead', 'readSegmentTexts', 'readSourceIncarnation', 'openBodyStaging',
    'stageSegmentTexts', 'allocateBodyOccurrenceIds', 'stageManifestRows', 'stageSegmentChunks', 'setBodyStagingState', 'readPageOrigin',
    'flipBodyGeneration', 'sealSegmentedPage', 'readSegmentedVersionBodyBytes', 'readPagesRowEstimate',
    'applyTransactionSettings', 'bumpSourcePurgeEpoch', 'clearQueryCache', 'clearUnkeptChunkVectors', 'completeWriteRow',
    'countFactFingerprintLeftovers', 'countLegacyDerivedPages', 'countPurgeProbe', 'countPurgeReviewRows',
    'countPurgeVersionsCarryingClaim', 'declarePersistence', 'deleteChunksExcept', 'deleteProjectionJob',
    'deletePurgeDecideProposals', 'deletePurgeReviewProposals', 'deletePurgeReviewQueue', 'findTopologyChanges', 'getChunks',
    'getConfig', 'getConfigValues', 'getSource', 'hasBeliefEvents', 'hasDrainableProjectionJob', 'hasPersistenceTable',
    'insertBeliefEvents', 'insertFactPurge', 'insertHoldingPagePurges', 'insertTakePurge', 'insertWriteRequest',
    'listDerivationClaimForms', 'listDerivedRows', 'listGitEffectsCarryingReason', 'listPageSourcePathsForPurge',
    'listPurgeMatchCandidates', 'listPurgePagesById', 'listQueuedPageProjections', 'listRequestsCarryingClaim',
    'listSegmentedPageBodies', 'listSegmentedVersionBodies', 'listSimilarActiveFacts', 'listStagingPartEdges',
    'listStagingsHoldingClaim', 'listWithdrawalChunks', 'loadPurgeTarget', 'lockPageKeys', 'lockPersistenceCounters',
    'lockPurgeSource', 'lockWriteRequest', 'lockWriteRequestsById', 'markBeliefCommits', 'planFactPurgeIds', 'planFactPurgeTakes',
    'probePurgeDerivations', 'purgeSubjectPageLive', 'readBeliefFactsById', 'readBeliefStateRows', 'readChunkKeepState',
    'readDerivationPurgeState', 'readEffectBytes', 'readGraduationGateRow', 'readJournalLimitRows', 'readLedgerSource',
    'readLocalWriterRow', 'readOpenBeliefLifetimes', 'readPageIndexingState', 'readPageSnapshot', 'readPageTrustRows',
    'readPersistenceBrainId', 'readProjectionJobReason', 'readPurgeSourceLocalPath', 'readSourceMembership', 'readSourcePurgeFlags',
    'readSourceRow', 'readTopologyChange', 'readTransactionSettings', 'readWithdrawalDiscovery', 'readWriteRequest',
    'recordDerivationPurgeRow', 'redactWriteRequestRow', 'relationExists', 'releaseTerminalBytes', 'requireSynchronousCommit',
    'restorePageTrust', 'setProjectionChunkerVersion', 'setPurgeProbeTimeout', 'setWriteContext', 'sweepSegments', 'transaction',
    'upsertChunks', 'writeTextProjectionSeal',
    // served on Rust by main's batch 9: the purge's writes (purge_writes.rs), the segmented purge writes (lane 1), the terminal
    // compaction (lane 5) and the generation ledger's typed text scrub
    'deletePurgedTakes', 'deletePurgeTrustProposals', 'deletePurgeOpenLoops', 'deletePurgeWriteGateHolds', 'deletePurgeWriteGateReceipts', 'blankPurgeCoreEditNotices', 'deletePurgedFacts', 'listPagesForPurgeRewrite', 'updatePageBodyForPurge', 'deletePurgedChunks', 'compactTerminalIntent', 'createVersion', 'deleteRewrittenSegmentDerivations', 'deleteUnstagedSegmentChunks', 'listPurgeVersionBodies', 'scrubGenerationTextRows'
  ),
  ...GUARDED_SITES,
];

/** Which request an operation call is, for the pre-write check: null for a call that only reads, or that the purge itself refuses as host-only. */
export function factPurgeEntryPoint(ctx: { remote?: unknown; dryRun?: unknown }, params: Record<string, unknown>): FactPurgeEntryPoint | null {
  if (ctx.remote !== false) return null;
  if (params.status === true) return params.continue === true ? 'continue' : null;
  if (typeof params.match === 'string') return null;
  if (ctx.dryRun === true || params.dry_run === true) return null;
  return 'purge';
}

/** Every listed entry that stops a fact purge on `engine` from `entryPoint`, in list order. */
export const factPurgeStops = (engine: object, entryPoint: FactPurgeEntryPoint = 'purge'): Promise<PurgePathStop<'purge'>[]> =>
  entryStops(FACT_PURGE_PATH, engine, entry => entry.entry !== 'purge' || entryPoint === 'purge');

/**
 * The pre-write check: throws the typed `engine_capability_missing` refusal naming the first stop, its owner lane and its
 * due date (in the message and the detail), with outcome `none` (nothing ran). Call it before the purge reads or writes anything.
 */
export async function requireFactPurgeServed(engine: object, entryPoint: FactPurgeEntryPoint = 'purge'): Promise<void> {
  const [first] = await factPurgeStops(engine, entryPoint);
  refusePurgeEntryStop(entryPoint === 'continue' ? 'purge_fact --status --continue' : 'purge_fact (forget --purge)', first);
}
