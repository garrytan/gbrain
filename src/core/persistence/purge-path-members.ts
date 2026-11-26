/**
 * The page purge's engine surface, in one list: every BrainEngine member the purge calls, and every raw-SQL site still
 * on its path, each with the lane that owns it. The pre-write check (`requirePurgePathServed`) is derived only from
 * this list: it refuses a purge on an engine that cannot serve every entry, before the purge writes anything (a label,
 * a park, a soft delete, a `page_purges` row, a journal row), and names the first entry it cannot serve and its owner.
 *
 * Where an entry can stop a purge:
 * - a member is served on the Rust engine when `rustMemberCapability` (rust-engine.ts) finds it implemented or in the
 *   store members; one that is not served is a known stop and carries `stop`.
 * - a member the store serves but refuses on the purge's own arguments carries `refuses` (a conditional stop the
 *   classification cannot see).
 * - a raw-SQL site refuses on an engine without `raw_sql` (the Rust engine) unless its branch is guarded away from
 *   that engine (`guarded` says how); an unguarded one is a known stop (`stop`).
 * PGLite and Postgres serve every entry, so the check passes there without reading the list.
 *
 * The PGLite test (test/page-purge-path-members.test.ts) runs the purge through a recording engine proxy and fails when
 * the purge calls a member or a raw site that is not listed (a new purge-path call cannot slip past the check), when a
 * listed member is missing from an engine, and when a member that is not served on Rust has no stop. When a lane serves
 * a stop, its entry loses `stop`/`refuses` in the lane's commit; the check then stops refusing for it and for nothing
 * else. There is no manual or partial lift: the purge runs on Rust only when no listed entry stops it.
 *
 * `entry`: `retention` entries are reached only by the retention purge (maintain --purge, the cycle and the `purge`
 * job, concept rebuild: `purgeDeletedPagesCoordinated`); the rest are on every purge.
 */
import type { BrainEngine } from '../engine.ts';
import type { Capability } from '../engine-capabilities.ts';
import { refusePurgeEntryStop } from '../rust-engine/errors.ts';

/** Who lifts or owns an entry. */
export const PURGE_OWNERS = {
  /** The page purge port itself: members and sites it serves or has still to serve. */
  ours: 'lane 13',
  /** The receipt reads and probes of the purge verification (facts/purge-verify.ts). */
  receipts: 'lane 13 step 3',
  /** The receipt's four reads (source-prose scan, source path, purge request, purge effects): rust-engine/rust-5a 90e7bea933 (not merged here). */
  receiptReads: 'lane 4 (rust-5a 90e7bea933)',
  /** The recorded-value probe of the receipt's ledger report: rust-engine/rust-belief-purge e211982aba serves it (carried here). */
  beliefProbe: 'lane 3 (rust-belief-purge e211982aba)',
  /** The fact-context probe of the receipt's ledger report. */
  factContextProbe: 'lane 4 (rust-5a 90e7bea933)',
  /** The online-built request index read: rust-engine/doctor-checks-3 (b78e56edb9, contains 8d4d809039) makes it a typed member whose Rust store answers every index as valid. */
  requestIndexes: 'lane 14 (doctor-checks-3 b78e56edb9, contains 8d4d809039)',
  /** The fact purge's transaction statements and receipt counts: rust-engine/rust-5a bc4cc890fe serves them (not merged here); see fact-purge-path-members.ts. */
  factPurgeTx: 'lane 4 (rust-5a bc4cc890fe)',
  /** The segmented rewrite statements and their chunk probes, typed and served on Rust by segmented-staging-2 (34fa27c472): Ember's ruling, Nov 21. */
  segmentedRewrite: 'trunk (segment-pending-stamp f71c844551, contains 34fa27c472)',
  /** The belief-ledger half of a purge (belief/purge.ts, belief/preimages.ts): typed members the Rust store serves (rust-engine/purge-ledger-sites). */
  beliefLedger: 'lane 3 (purge-ledger-sites)',
} as const;

/**
 * When another lane's stop is due to lift: the date its serving head reaches this branch's base. Ember's rulings, Nov 21:
 * the fact purge receipt's ledger reads are due Nov 24; the page receipt reads, the slot-end read and the four page purge
 * stops served on other branches (request index, origin twin, publication stamp, generation-ledger scrub) are due Nov 25,
 * the last landing date. The fact purge's transaction statements, served on rust-5a, are due Nov 23 (the step 6 ruling).
 */
export const PURGE_DUE = { nov23: '5 PM PST Nov 23', nov24: '5 PM PST Nov 24', nov25: '5 PM PST Nov 25' } as const;

export type PurgeEntryPoint = 'delete_page' | 'retention';

/**
 * `due`: when the owning lane lifts the stop. Every stop another lane owns carries one (test/page-purge-path-members.test.ts).
 * `entry`: the entry point that alone reaches the entry (`E`; the page purge's is `retention`, the fact purge's `purge`).
 */
interface Base<E extends string = 'retention'> { owner: string; entry?: E; due?: string }
/** A BrainEngine member the purge calls. `stop`: not served on Rust (must match the classification). `refuses`: served, but refuses the purge's arguments. */
export interface PurgePathMember<E extends string = 'retention'> extends Base<E> { member: keyof BrainEngine & string; stop?: string; refuses?: string }
/** A raw-SQL site, named `function (file under src/core)` as the recording test attributes it. */
export interface PurgePathSite<E extends string = 'retention'> extends Base<E> { site: string; guarded?: string; stop?: string }
export type PurgePathEntry<E extends string = 'retention'> = PurgePathMember<E> | PurgePathSite<E>;

const { ours, beliefProbe, requestIndexes } = PURGE_OWNERS;
const { nov25 } = PURGE_DUE;
const served = (owner: string, ...members: Array<keyof BrainEngine & string>): PurgePathMember[] => members.map(member => ({ member, owner }));

/** Retention-only raw sites: the carry's parks and the candidate selection of purgeDeletedPagesCoordinated. */
const RETENTION_STOPS: PurgePathSite[] = [
  ['releaseStaleHolds (persistence/derived-origin-hold.ts)', 'the stale-hold release (op_checkpoints UPDATE)'],
  ['readOwedPurges (persistence/derived-origin-hold.ts)', 'the owed-purge read'],
  ['pruneOwedPurges (persistence/derived-origin-hold.ts)', 'the owed-purge prune'],
  ['pruneDerivedOriginParks (persistence/derived-origin-hold.ts)', 'the park prune'],
  ['<anonymous> (repair/origin-carry.ts)', 'expiringOrigins: the expired-origin read'],
  ['selectPurgeCandidates (persistence/purge-deleted.ts)', 'the candidate selection'],
  ['prunePurgeParks (persistence/purge-parks.ts)', 'the purge park prune'],
  ['notePurgeSourceWriter (persistence/purge-parks.ts)', 'the source writer note'],
  ['readHeldConceptRows (persistence/concept-rebuild.ts)', 'the held concept read'],
].map(([site, what]) => ({ site: site!, owner: ours, entry: 'retention' as const, stop: `${what} runs through raw SQL` }));

/**
 * Raw sites a purge reaches on PGLite and Postgres whose branch a Rust brain does not take. The Rust purge, with raw
 * SQL stubbed to answer nothing, reached none of them (it reached only the stops above and below).
 */
const GUARDED_SITES: PurgePathSite[] = [
  ['purgeSecretOccurrences (engine-sql/secret-store.ts)', 'runs only when deletePurgedSlugStoreRows reports secret rows (the Rust store keeps none)'],
  ['purgedFenceRows (facts/purge-overlay.ts)', 'an engine without raw_sql asks the typed isFactPurged'],
  ['intentCarriesPurgedContent (persistence/purged-intent.ts)', 'an engine without raw_sql asks the typed isFactPurged'],
  ['readPersistenceBrain (persistence/managed-mode.ts)', 'a Rust brain reads readManagedModeRows (isRustBrain branch)'],
  ['readManagedMode (persistence/managed-mode.ts)', 'a Rust brain reads readManagedModeRows (isRustBrain branch)'],
  ['scan (persistence/topology-recovery.ts)', 'managesWorktrees: a brain without managed_persistence has no worktree to scan'],
  ['vacuumPersistenceQueues (persistence/journal.ts)', 'runs on PGLite only'],
  ['releaseAbandonedClaims (persistence/effect-journal.ts)', 'abandonedClaimCutoff: PGLite only'],
  ['pipelined (page-state/transactions.ts)', 'the journal statements of the PGLite and Postgres persistence consumer; a Rust brain journals through the typed persistence members listed below'],
  ['<anonymous> (persistence/journal.ts)', 'the journal statements of the PGLite and Postgres consumer; a Rust brain uses the typed persistence members'],
  ['<anonymous> (persistence/effects.ts)', 'the effect statements of the PGLite and Postgres consumer; a Rust brain uses the typed persistence members'],
  ['<anonymous> (persistence/effect-journal.ts)', 'the effect statements of the PGLite and Postgres consumer; a Rust brain uses the typed persistence members'],
  ['queuePublicationEffects (persistence/effect-journal.ts)', 'the effect statements of the PGLite and Postgres consumer; a Rust brain uses the typed persistence members'],
  ['publishMutation (persistence/coordinator.ts)', 'the publication statements of the PGLite and Postgres consumer; a Rust brain uses the typed persistence members'],
  ['compareFileTarget (persistence/page-prepare.ts)', 'a worktree file target: a brain without managed_persistence binds no worktree'],
  ['prepareDeletePageMutation (persistence/page-prepare.ts)', 'a worktree file target: a brain without managed_persistence binds no worktree'],
  ['<anonymous> (persistence/page-prepare.ts)', 'a worktree file target: a brain without managed_persistence binds no worktree'],
  ['findLiveFileClaimants (persistence/file-claims.ts)', 'a worktree file target: a brain without managed_persistence binds no worktree'],
  ['originCommitted (persistence/sync-markers.ts)', 'a worktree file target: a brain without managed_persistence binds no worktree'],
  ['writeOriginDeletedMarker (persistence/sync-markers.ts)', 'a worktree file target: a brain without managed_persistence binds no worktree'],
  ['isMirrorOnlyPage (persistence/mirror-read-only.ts)', 'a worktree file target: a brain without managed_persistence binds no worktree'],
  ['isUnboundSourcePage (persistence/unbound-source.ts)', 'a worktree file target: a brain without managed_persistence binds no worktree'],
  ['readSyncImportProvenance (persistence/sync-holds.ts)', 'a worktree file target: a brain without managed_persistence binds no worktree'],
].map(([site, guarded]) => ({ site: site!, owner: ours, guarded: guarded! }));

/**
 * The purge's path, in the order the first refusal is chosen: the retention-only stops, then the stops a delete_page
 * purge reaches in the order it reaches them (prepare, publication, sweep, receipt), then the members it calls and
 * serves, then the raw sites guarded away from a Rust brain.
 */
export const PURGE_PATH: readonly PurgePathEntry[] = [
  ...RETENTION_STOPS,
  // preparePagePurge: the request-index state read, then the origin-twin read.
  { site: 'readRequestIndexStates (persistence/checkpoint-validation.ts)', owner: requestIndexes, due: nov25, stop: 'the online-built request index read runs through raw SQL' },
  // sweepPurgedPage: the generation-ledger scrub.
  // verifyPagePurge: the receipt. Its store probes (`countPurgeProbe`) are served, the fact purge's `fingerprint` and
  // `claim_text` probes included.
  // ledgerReports: runs for every purge whose page has fact claims, belief ledger or not.
  // The receipt pages the recorded values for the purged claims (trust/belief_purge.rs).
  ...served(beliefProbe, 'listBeliefEventsForPurgeProbe'),
  // The belief-ledger steps on a source that records belief events (belief/purge.ts): the derived rows' streams, the page's
  // lifetimes and claim inventory, the purged-key and carrying-field redactions, the live carriers and the derived-hidden keys.
  ...served(PURGE_OWNERS.beliefLedger, 'listDerivedStreamSlugs', 'listPageBeliefLifetimes', 'listPagePurgeLiveClaims', 'listPageVersionFenceBodies',
    'listLifetimeClaimEvents', 'listMissingPreimages', 'redactPurgedBeliefKeys', 'listBeliefCarrierEvents', 'readBeliefEventValue', 'rewriteBeliefEventFields',
    'rechainBeliefPriorHash', 'listBeliefQuotingRows', 'listKnownBeliefSubjectKeys'),
  // The members the purge calls and the Rust engine serves.
  ...served(ours,
    // the purge itself
    'deletePage', 'softDeletePage', 'deletePageStagings', 'deletePurgeDecideProposals', 'deletePurgeReviewProposals', 'deletePurgeReviewQueue',
    'deletePurgedFeedbackRows', 'deletePurgedNameStoreRows', 'deletePurgedPageFacts', 'deletePurgedPageFiles', 'deletePurgedPageGateReceipts',
    'deletePurgedPageHolds', 'deletePurgedPageTrustProposals', 'deletePurgedSlugStoreRows', 'deleteOriginHoldRows', 'insertPageFactPurges',
    'insertTakePurge', 'upsertPagePurges', 'countPageCascadeRows', 'countPageManifestRows', 'countPagePurgeTombstones', 'setPurgeProbeTimeout',
    'bumpSourcePurgeEpoch', 'clearQueryCache', 'hasBeliefEvents', 'relationExists', 'readDerivationPurgeState', 'countPurgeProbe',
    // what the purge reads of the page
    'listDerivedRows', 'listPageChangeReasons', 'listPageGitEffectsForStrip', 'listPageMirrorFacts', 'listPageMirrorTakeHashes',
    'listPageSecretOccurrences', 'listPageSegmentShas', 'listPageTimelineReceipts', 'listPageVersionBodiesForPurge', 'listPageVersionSourcePaths',
    'listPurgeClaimFacts', 'listPurgeClaimTakes', 'listPurgeOrigins', 'listPurgeSegmentClaims', 'listRequestsForSlugs', 'readPurgePageBody',
    'readPrivacyOrigin', 'listOriginDependents', 'listQueuedPagePurges', 'getChunks', 'getPage', 'readPageSnapshot', 'readPageLabelRow',
    'readSourcePurgeFlags', 'sweepPageTextsForClaims', 'listSegmentedPageBodies', 'listSegmentedVersionBodies', 'listPageLinkStreams',
    // the receipt's reads, served on Rust since lane 4 sweep-facts-rust (rust-5a f16c087809, 90e7bea933): the live fact contexts that quote
    // the purged claims, the source-prose scan, the source path, the purge request and the purge effects
    'listFactContextsForPurgeProbe', 'listPageProseHits', 'readPurgeReceiptSourcePath', 'readDeletePageRequest', 'listPurgeEffects',
    // the retention purge's unreviewed sync tombstone read, a typed member served on Rust since lane 11 sync-identity-share (5218d954c1)
    'listUnreviewedSyncTombstones',
    // the derived-origin carry: labels, parks, the owed-purge record
    'putPage', 'createVersion', 'addPageTagsById', 'pruneFrontmatterTags', 'replaceDerivedAliases', 'setPageAliases', 'upsertChunks',
    'deleteChunksExcept', 'getChunkReuseRows', 'moveChunkIndexes', 'findDuplicatePage', 'writePageLabelGuard', 'writeTextProjectionSeal',
    'listDerivedOriginParks', 'listPurgeParks', 'upsertDerivedOriginPark', 'recordOwedPurgeRows', 'listCheckoutFiles', 'hasWithdrawnFenceClaim',
    // the belief ledger (a brain with belief events)
    'readBeliefFactsById', 'readBeliefStateRows', 'readOpenBeliefLifetimes', 'insertBeliefEvents', 'endBeliefLifetime', 'markBeliefCommits',
    // the persistence journal and consumer that run the purge request
    'declarePersistence', 'publicationJournalStore', 'insertWriteRequest', 'completeWriteRow', 'completeEffectRow', 'insertPublicationEffects', 'readWriteRequest',
    'readWriteRequestById', 'readWriteRequestProgress', 'lockWriteRequest', 'lockWriteRequestsById', 'lockPageKeys', 'lockPersistenceCounters',
    'lockEffectGuard', 'lockSourceForUpdate', 'lockNoopEmbeddingWindow', 'hasClaimableWrite', 'hasRearmableTargets', 'selectClaimableWrite', 'selectClaimableEffect',
    'selectProjectionWindowJobs', 'listPendingSegmentedProjections', 'stampWriteClaim', 'stampEffectClaim', 'renewWriteClaim',
    'expireStaleWriteClaims', 'redactWriteRequestRow', 'releaseTerminalBytes', 'trueUpReservations', 'listTrueUpRequests', 'listReservationsAfter',
    'listEffectRecoveries', 'listOverdueHeldWrites', 'listOwnerRecoveryHeads', 'listResumableRefreshes', 'listGatedMirrorRequests',
    'listCompactableReceipts', 'sweepJournalChunk', 'findTopologyChanges', 'readTopologyChange', 'getWorktreeBinding', 'readAdmissionSource',
    'readEffectBytes', 'readGraduationGateRow', 'readJournalCeiling', 'readJournalLimitRows', 'readLedgerSource', 'readLocalWriterRow',
    'readMirrorGateRows', 'readPersistenceBrainId', 'readReceiptBudget', 'readSourceMembership', 'readSourceState', 'readCounterRows',
    'readCycleLocks', 'readManagedModeRows', 'probeIdleWork', 'probeNoopEmbeddingSettle', 'readNoopEmbeddingCandidates', 'readEmbeddingCompletion',
    'readPageEmbeddingBudget', 'readPageIndexingState', 'readSegmentedEmbedPage', 'releasePageEmbeddingLease', 'takePageEmbeddingLease',
    'hasSegmentStorage', 'getSource', 'getSourceStrictness', 'listOnboardingSources', 'listSharedSkillPackRoots', 'sharedSkillPackTablePresent',
    'registerBeforeDisconnect', 'applyTransactionSettings', 'readTransactionSettings', 'setWriteContext', 'transaction', 'transactionDirect',
    // config and the background ticks that share the consumer
    'getConfig', 'getConfigValues', 'getAllConfig', 'setConfig', 'expireMemoryProposals', 'listAwaitingMemoryProposals', 'purgeMemoryProposals',
    'ensureDreamMapConfigRow', 'lockDreamMapConfigRow', 'writeDreamMapConfigRow',
    // served on Rust by main's batch 9: the origin-twin read, the managed worktree reads, the checkpoint records and the typed
    // generation ledger scrub (the page purge's last raw reads)
    'listTopologyRecoveries', 'readOpCheckpointRecords', 'readOwnerHostBinding', 'readPageDatabaseOnlyReason', 'readWorktreeAdmission',
    'scrubGenerationPageRows',
  ),
  ...GUARDED_SITES,
];

/** An entry's name, as the refusal and the tests print it. */
export const purgeEntryName = (entry: PurgePathEntry<string>): string => ('member' in entry ? entry.member : entry.site);

export interface PurgePathStop<E extends string = 'retention'> { entry: PurgePathEntry<E>; name: string; owner: string; due?: string; capability: Capability; why: string }

/**
 * Every entry of `path` that `reached` selects and that stops a purge on `engine`, in list order: a site that is marked
 * `stop`, a member the Rust engine does not serve (or serves but `refuses`). An engine that is not the Rust engine serves
 * every entry (PGLite, Postgres) and a transaction handle or fake has nothing to refuse, so only a Rust engine is read
 * against the list. The page purge's check and the fact purge's (fact-purge-path-members.ts) both read their list here.
 */
export async function entryStops<E extends string>(path: readonly PurgePathEntry<E>[], engine: object, reached: (entry: PurgePathEntry<E>) => boolean): Promise<PurgePathStop<E>[]> {
  if ((engine as { kind?: unknown }).kind !== 'rust') return [];
  const { rustMemberCapability } = await import('../rust-engine.ts');
  const { RUST_ENGINE_MEMBERS } = await import('../rust-engine/members.ts');
  const stops: PurgePathStop<E>[] = [];
  for (const entry of path) {
    if (!reached(entry)) continue;
    const name = purgeEntryName(entry);
    if ('site' in entry) {
      if (entry.stop) stops.push({ entry, name, owner: entry.owner, due: entry.due, capability: 'raw_sql', why: entry.stop });
      continue;
    }
    const capability = rustMemberCapability(entry.member);
    if (capability) stops.push({ entry, name, owner: entry.owner, due: entry.due, capability, why: entry.stop ?? 'not served by the Rust engine' });
    else if (entry.refuses) stops.push({ entry, name, owner: entry.owner, due: entry.due, capability: (RUST_ENGINE_MEMBERS as unknown as Record<string, Capability>)[entry.member]!, why: entry.refuses });
  }
  return stops;
}

/** Every listed entry that stops a purge on `engine` from `entryPoint`, in list order. */
export const purgePathStops = (engine: object, entryPoint: PurgeEntryPoint = 'delete_page'): Promise<PurgePathStop[]> =>
  entryStops(PURGE_PATH, engine, entry => entry.entry !== 'retention' || entryPoint === 'retention');

/**
 * The pre-write check of every entry that reaches a purge (delete_page --purge, the retention purge, a recovered purge
 * request): throws the typed `engine_capability_missing` refusal naming the first stop and its owner lane, with
 * outcome `none` (nothing ran). Call it before the purge reads or writes anything.
 */
export async function requirePurgePathServed(engine: object, entryPoint: PurgeEntryPoint = 'delete_page'): Promise<void> {
  const [first] = await purgePathStops(engine, entryPoint);
  // A stop with a due date names owner and date in the message and the detail (errors.ts); one without (this lane's own) names its owner.
  refusePurgeEntryStop(entryPoint === 'retention' ? 'the retention purge' : 'delete_page --purge', first);
}
