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
 *   each with the owner and date Ember ruled: the segmented rewrite statements (trunk, Nov 23), the segmented purge writes (the
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

const { ours, ledgerScrub, beliefProbe, factContextProbe, receiptReads, factPurgeTx, segmentedRewrite, segmentedPurgeWrites, purgeTerminal } = PURGE_OWNERS;
const { nov23, nov24, nov25 } = PURGE_DUE;
const served = (owner: string, ...members: Array<keyof BrainEngine & string>): FactPurgeEntry[] => members.map(member => ({ member, owner }));
const tx = (member: keyof BrainEngine & string, stop: string, reached: 'purge' | 'purge and continue' = 'purge'): FactPurgeEntry =>
  ({ member, owner: factPurgeTx, due: nov23, ...(reached === 'purge' ? { entry: 'purge' as const } : {}), stop });

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
  ['missingPreimages (belief/preimages.ts)', 'the belief batch drafts events only on a brain with a belief ledger; a Rust brain has none'],
  ['derivedStreamSlugs (belief/purge.ts)', 'the belief-ledger purge runs only when hasBeliefEvents is true; a Rust brain has no ledger'],
  ['redactPurgedKeys (belief/purge.ts)', 'the belief-ledger purge runs only when hasBeliefEvents is true; a Rust brain has no ledger'],
  ['redactCarryingFields (belief/purge.ts)', 'the belief-ledger purge runs only when hasBeliefEvents is true; a Rust brain has no ledger'],
  ['quotingSlugs (belief/purge.ts)', 'the belief-ledger purge runs only when hasBeliefEvents is true; a Rust brain has no ledger'],
].map(([site, guarded]) => ({ site: site!, owner: ours, guarded: guarded! }));

/** The purge's path, in the order a real run reaches it: the stops, then the members it calls and the Rust engine serves, then the raw sites guarded away from it. */
export const FACT_PURGE_PATH: readonly FactPurgeEntry[] = [
  // assertNoPendingPublication, then the belief streams of the facts.
  tx('findPurgeBlockedPublication', 'the pending-publication check over the write journal is not served'),
  tx('listPurgeStreamSlugs', 'the belief stream slugs of the facts are not served'),
  // hideDerivedRows: the rows derived from the facts are hidden through their own tables and marked for re-derivation.
  tx('expireDerivedFacts', 'hiding a derived fact is not served'),
  tx('deactivateDerivedTakes', 'hiding a derived take is not served'),
  tx('softDeleteDerivedPages', 'hiding a derived page is not served'),
  tx('markNeedsRederive', 'the re-derive queue is not served'),
  // The deletes of the purge itself.
  tx('deletePurgedTakes', 'the delete of the claim\'s verbatim takes is not served'),
  tx('deletePurgeTrustProposals', 'the delete of the trust proposals that name the facts or takes is not served'),
  tx('deletePurgeOpenLoops', 'the delete of the open loops that name the facts is not served'),
  tx('deletePurgeWriteGateHolds', 'the delete of the held writes that carry the claim is not served'),
  tx('deletePurgeWriteGateReceipts', 'the delete of the gate receipts that name purged rows is not served'),
  tx('deletePurgeTakeProposals', 'the delete of the take proposals that carry the claim is not served'),
  tx('blankPurgeCoreEditNotices', 'the blanking of the core edit notices that quote the claim is not served'),
  tx('deletePurgedFacts', 'the delete of the fact rows is not served'),
  // rewritePageBodies: the pages that held the claim lose its fence rows. A segmented page publishes a new generation
  // (rewriteLiveSegmentedFences, then a version of the old revision); an inline page is versioned first, then rewritten.
  tx('listPagesForPurgeRewrite', 'the read of the pages to rewrite is not served'),
  { site: 'rewriteLiveSegmentedFences (page-body/segment-rewrite.ts)', owner: segmentedRewrite, due: nov23, entry: 'purge',
    stop: 'rewriting a segmented page\'s live fences reads the page and restores its deleted_at through raw SQL (segment-rewrite.ts:174, :194); typed and served on Rust by segmented-staging-2' },
  { site: 'occurrencesWithoutChunks (page-body/ingest.ts)', owner: segmentedRewrite, due: nov23, entry: 'purge',
    stop: 'the segmented body\'s chunked-occurrence read is raw SQL; typed (listChunkedOccurrences) on segmented-staging-2' },
  { site: 'reuseSegmentChunkVectors (import-chunk-reuse.ts)', owner: segmentedRewrite, due: nov23, entry: 'purge',
    stop: 'the reuse of the retired segments\' chunk vectors is raw SQL; typed on segmented-staging-2' },
  { site: 'hasStaleChunks (page-body/projection.ts)', owner: segmentedRewrite, due: nov23, entry: 'purge',
    stop: 'the stale segment chunk probe is raw SQL; typed (hasStaleSegmentChunks) on segmented-staging-2' },
  { site: 'applySegmentedBody (persistence/segmented-apply.ts)', owner: segmentedPurgeWrites, due: nov25, entry: 'purge',
    stop: 'the flip that publishes the rewritten generation locks the staging and deletes chunks through raw SQL (segmented-apply.ts); still raw on every rust-engine branch' },
  { site: 'deleteRewrittenDerivations (page-body/segment-derive.ts)', owner: segmentedPurgeWrites, due: nov25, entry: 'purge',
    stop: 'the delete of the derivation rows a rewritten segment may hold is raw SQL; still raw on every rust-engine branch' },
  { site: 'insertSegmentedVersion (page-state/versions.ts)', owner: segmentedPurgeWrites, due: nov25, entry: 'purge',
    stop: 'createPageVersion of a segmented page inserts the version through raw SQL; still raw on every rust-engine branch' },
  { site: 'pruneSegmentedVersions (page-state/versions.ts)', owner: segmentedPurgeWrites, due: nov25, entry: 'purge',
    stop: 'createPageVersion of a segmented page prunes its old versions through raw SQL; still raw on every rust-engine branch' },
  { site: '<anonymous> (page-state/versions.ts)', owner: segmentedPurgeWrites, due: nov25, entry: 'purge',
    stop: 'createPageVersion, which the purge calls for the pre-purge version of each inline page it rewrites, inserts into page_versions through raw SQL; the Rust engine serves the typed createVersion, but facts/purge.ts does not call it' },
  tx('updatePageBodyForPurge', 'the rewrite of a page body is not served'),
  tx('deletePurgedChunks', 'the delete of the rewritten pages\' chunks is not served'),
  // redactPageVersions: the change reasons first, then the inline versions, then the segmented ones.
  tx('redactVersionChangeReasons', 'the redaction of change reasons that quote the claim is not served'),
  {
    site: 'rewriteVersionBodies (facts/purge.ts)', owner: segmentedPurgeWrites, due: nov25, entry: 'purge',
    stop: 'the version-body SELECT (WHERE, column list and lock clause built from the purge and the held-fact move) is raw SQL with no constant text to type; rust-5a does not serve it',
  },
  tx('setPurgeVersionBody', 'the rewrite of a saved version body is not served'),
  tx('listSegmentedVersionsForPurge', 'the read of the segmented versions to rewrite is not served'),
  { site: 'rewriteSegmentedGeneration (page-body/segment-rewrite.ts)', owner: segmentedRewrite, due: nov23, entry: 'purge',
    stop: 'rebuilding a retained generation of a segmented page locks the page and rewrites its manifest through raw SQL (segment-rewrite.ts:216-244); typed and served on Rust by segmented-staging-2' },
  // The generation ledger.
  { site: 'scrubGenerationLedger (generations/ledger-scrub.ts)', owner: ledgerScrub, due: nov25, entry: 'purge', stop: 'the generation-ledger scrub runs through raw SQL' },
  // purgeSegmentStorage: the writes that would publish a staged body are cancelled, the stagings aborted, the texts deleted.
  { site: 'cancelRequestsHoldingStagings (persistence/intent-redaction.ts)', owner: purgeTerminal, due: nov25, entry: 'purge',
    stop: 'cancelling the queued writes that would publish a staged body that holds the claim locks them through raw SQL (intent-redaction.ts:222); still raw on every rust-engine branch' },
  { site: 'finishTerminal (persistence/journal.ts)', owner: purgeTerminal, due: nov25, entry: 'purge',
    stop: 'completing such a cancelled write with purged_content compacts its stored intent through raw SQL (journal.ts finishTerminal); still raw on every rust-engine branch' },
  tx('abortPurgedStagings', 'aborting the uncommitted stagings that hold the claim is not served'),
  tx('deletePurgedStagingParts', 'the delete of those stagings\' upload parts is not served'),
  tx('deletePageViewDigests', 'the delete of the rewritten pages\' cached view digests is not served'),
  tx('deleteUnreferencedPurgedTexts', 'the delete of the segment texts that held the claim is not served'),
  // The purge effects of the git mirror.
  tx('listPurgedPageRevisions', 'the read of the rewritten pages\' revisions is not served'),
  tx('insertPurgeEffects', 'the purge effect rows are not served'),
  // verifyFactPurge: the receipt.
  { member: 'listBeliefEventsForPurgeProbe', owner: beliefProbe, due: nov24, entry: 'purge', stop: 'the receipt pages the recorded values for the purged claims; not served until e211982aba is merged' },
  { member: 'listFactContextsForPurgeProbe', owner: factContextProbe, due: nov24, entry: 'purge', stop: 'the receipt pages the live fact contexts that quote the purged claims; not served' },
  // The completion of a purge (also read by `--status --continue`): the effect rows, then the fingerprint count.
  { member: 'listPurgeEffects', owner: receiptReads, due: nov25, stop: 'the purge effect read of the completion is not served' },
  tx('countPurgeFingerprintResidue', 'the receipt\'s count of the rows that still hold the claim\'s fingerprint is not served', 'purge and continue'),
  // The members the purge calls and the Rust engine serves.
  ...served(ours,
    // the derivation sweep after the commit (and again by `--status --continue`): served on Rust since part B of step 6
    'continueDerivationSweep',
    'listRequestsHoldingStagings', 'readManifest', 'readSegmentedPageHead', 'readSegmentTexts', 'readSourceIncarnation', 'openBodyStaging',
    'stageSegmentTexts', 'allocateBodyOccurrenceIds', 'stageManifestRows', 'stageSegmentChunks', 'setBodyStagingState', 'readPageOrigin',
    'flipBodyGeneration', 'sealSegmentedPage', 'readSegmentedVersionBodyBytes',
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
    'upsertChunks', 'writeTextProjectionSeal'
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
