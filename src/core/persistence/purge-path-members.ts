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
import { capabilityMissing } from '../rust-engine/errors.ts';

/** Who lifts or owns an entry. */
export const PURGE_OWNERS = {
  /** The page purge port itself: members and sites it serves or has still to serve. */
  ours: 'lane 13',
  /** The receipt reads and probes of the purge verification (facts/purge-verify.ts). */
  receipts: 'lane 13 step 3',
  /** The receipt's four reads (source-prose scan, source path, purge request, purge effects): rust-engine/rust-5a 90e7bea933 (not merged here). */
  receiptReads: 'lane 4 (rust-5a 90e7bea933)',
  /** The `publication_started` stamp of a recovered purge's publication transaction: rust-engine/bound-write-rust 075a30ef45 (journal.markPublicationStarted; not merged here). */
  publicationStamp: 'lane 5 (bound-write-rust 075a30ef45)',
  /** The generation-ledger scrub (generations/ledger-scrub.ts): typed members, rust-engine commit 61b18fbbc. */
  ledgerScrub: 'lane 4 (61b18fbbc)',
  /** The recorded-value probe of the receipt's ledger report: rust-engine/rust-belief-purge e211982aba serves it (not merged here). */
  beliefProbe: 'lane 3 (rust-belief-purge e211982aba)',
  /** The fact-context probe of the receipt's ledger report. */
  factContextProbe: 'lane 4',
  /** The origin-twin read: rust-engine/repair-rust b5945d814f (origin-twins.ts calls the readPageDatabaseOnlyReason member). */
  repairOriginTwin: 'lane 10 (repair-rust b5945d814f)',
  /** The online-built request index read: rust-engine/doctor-checks-3 (8d4d809039) makes it a typed member whose Rust store answers every index as valid. */
  requestIndexes: 'lane 14 (doctor-checks-3 8d4d809039)',
} as const;

export type PurgeEntryPoint = 'delete_page' | 'retention';

interface Base { owner: string; entry?: 'retention' }
/** A BrainEngine member the purge calls. `stop`: not served on Rust (must match the classification). `refuses`: served, but refuses the purge's arguments. */
export interface PurgePathMember extends Base { member: keyof BrainEngine & string; stop?: string; refuses?: string }
/** A raw-SQL site, named `function (file under src/core)` as the recording test attributes it. */
export interface PurgePathSite extends Base { site: string; guarded?: string; stop?: string }
export type PurgePathEntry = PurgePathMember | PurgePathSite;

const { ours, receiptReads, publicationStamp, ledgerScrub, beliefProbe, factContextProbe, repairOriginTwin, requestIndexes } = PURGE_OWNERS;
const served = (owner: string, ...members: Array<keyof BrainEngine & string>): PurgePathMember[] => members.map(member => ({ member, owner }));

/** Retention-only raw sites: the carry's parks and the candidate selection of purgeDeletedPagesCoordinated. */
const RETENTION_STOPS: PurgePathSite[] = [
  ['releaseStaleHolds (persistence/derived-origin-hold.ts)', 'the stale-hold release (op_checkpoints UPDATE)'],
  ['readOwedPurges (persistence/derived-origin-hold.ts)', 'the owed-purge read'],
  ['pruneOwedPurges (persistence/derived-origin-hold.ts)', 'the owed-purge prune'],
  ['readDerivedOriginParks (persistence/derived-origin-hold.ts)', 'the park read'],
  ['pruneDerivedOriginParks (persistence/derived-origin-hold.ts)', 'the park prune'],
  ['<anonymous> (repair/origin-carry.ts)', 'expiringOrigins: the expired-origin read'],
  ['selectPurgeCandidates (persistence/purge-deleted.ts)', 'the candidate selection'],
  ['readPurgeParks (persistence/purge-parks.ts)', 'the purge park read'],
  ['prunePurgeParks (persistence/purge-parks.ts)', 'the purge park prune'],
  ['notePurgeSourceWriter (persistence/purge-parks.ts)', 'the source writer note'],
  ['readUnreviewedSyncTombstones (persistence/sync-delete-tombstones.ts)', 'the unreviewed sync tombstone read'],
  ['readHeldConceptRows (persistence/concept-rebuild.ts)', 'the held concept read'],
].map(([site, what]) => ({ site: site!, owner: ours, entry: 'retention' as const, stop: `${what} runs through raw SQL` }));

/**
 * Raw sites a purge reaches on PGLite and Postgres whose branch a Rust brain does not take. The Rust purge, with raw
 * SQL stubbed to answer nothing, reached none of them (it reached only the stops above and below).
 */
const GUARDED_SITES: PurgePathSite[] = [
  ['purgeSecretsForSlugs (secret-store/store.ts)', 'runs only when deletePurgedSlugStoreRows reports secret rows (the Rust store keeps none)'],
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
  ['derivedStreamSlugs (belief/purge.ts)', 'the belief-ledger purge runs only when hasBeliefEvents is true; a Rust brain has no ledger'],
  ['pageLifetimesOf (belief/purge.ts)', 'the belief-ledger purge runs only when hasBeliefEvents is true; a Rust brain has no ledger'],
  ['pagePurgeClaims (belief/purge.ts)', 'the belief-ledger purge runs only when hasBeliefEvents is true; a Rust brain has no ledger'],
  ['redactPurgedKeys (belief/purge.ts)', 'the belief-ledger purge runs only when hasBeliefEvents is true; a Rust brain has no ledger'],
  ['redactCarryingFields (belief/purge.ts)', 'the belief-ledger purge runs only when hasBeliefEvents is true; a Rust brain has no ledger'],
  ['quotingSlugs (belief/purge.ts)', 'the belief-ledger purge runs only when hasBeliefEvents is true; a Rust brain has no ledger'],
].map(([site, guarded]) => ({ site: site!, owner: ours, guarded: guarded! }));

/**
 * The purge's path, in the order the first refusal is chosen: the retention-only stops, then the stops a delete_page
 * purge reaches in the order it reaches them (prepare, publication, sweep, receipt), then the members it calls and
 * serves, then the raw sites guarded away from a Rust brain.
 */
export const PURGE_PATH: readonly PurgePathEntry[] = [
  ...RETENTION_STOPS,
  // preparePagePurge: the request-index state read, then the origin-twin read.
  { site: 'readRequestIndexStates (persistence/checkpoint-validation.ts)', owner: requestIndexes, stop: 'the online-built request index read runs through raw SQL' },
  { site: 'isOriginTwinPage (persistence/origin-twins.ts)', owner: repairOriginTwin, stop: 'the origin-twin read (page-prepare isOriginTwinPage, also :461 and :676) runs through raw SQL; member readPageDatabaseOnlyReason' },
  // The publication transaction of a recovered journaled purge: the `publication_started` stamp (the exclusive source lock
  // before it is the typed member `lockSourceForUpdate`).
  { site: '<anonymous> (persistence/coordinator.ts)', owner: publicationStamp, stop: 'the publication transaction of a recovered purge stamps publication_started through raw SQL (UPDATE persistence_requests ... RETURNING *)' },
  // sweepPurgedPage: the generation-ledger scrub.
  { site: 'scrubGenerationLedger (generations/ledger-scrub.ts)', owner: ledgerScrub, stop: 'the generation-ledger scrub runs through raw SQL' },
  // verifyPagePurge: the receipt. Its store probes (`countPurgeProbe`) are served, the fact purge's `fingerprint` and
  // `claim_text` probes included.
  // ledgerReports: runs for every purge whose page has fact claims, belief ledger or not.
  { member: 'listBeliefEventsForPurgeProbe', owner: beliefProbe, stop: 'the receipt pages the recorded values for the purged claims; not served until e211982aba is merged' },
  { member: 'listFactContextsForPurgeProbe', owner: factContextProbe, stop: 'the receipt pages the live fact contexts that quote the purged claims; not served' },
  { member: 'listPageProseHits', owner: receiptReads, stop: 'the source-prose scan of the receipt is not served' },
  { member: 'readPurgeReceiptSourcePath', owner: receiptReads, stop: 'the receipt source path read is not served' },
  { member: 'readDeletePageRequest', owner: receiptReads, stop: 'the purge request read of the receipt is not served' },
  { member: 'listPurgeEffects', owner: receiptReads, stop: 'the purge effect read of the completion is not served' },
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
    // the derived-origin carry: labels, parks, the owed-purge record
    'putPage', 'createVersion', 'addPageTagsById', 'pruneFrontmatterTags', 'replaceDerivedAliases', 'setPageAliases', 'upsertChunks',
    'deleteChunksExcept', 'getChunkReuseRows', 'moveChunkIndexes', 'findDuplicatePage', 'writePageLabelGuard', 'writeTextProjectionSeal',
    'upsertDerivedOriginPark', 'recordOwedPurgeRows', 'listCheckoutFiles', 'hasWithdrawnFenceClaim',
    // the belief ledger (a brain with belief events)
    'readBeliefFactsById', 'readBeliefStateRows', 'readOpenBeliefLifetimes', 'insertBeliefEvents', 'endBeliefLifetime', 'markBeliefCommits',
    // the persistence journal and consumer that run the purge request
    'declarePersistence', 'insertWriteRequest', 'completeWriteRow', 'completeEffectRow', 'insertPublicationEffects', 'readWriteRequest',
    'readWriteRequestById', 'readWriteRequestProgress', 'lockWriteRequest', 'lockWriteRequests', 'lockPageKeys', 'lockPersistenceCounters',
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
  ),
  ...GUARDED_SITES,
];

/** An entry's name, as the refusal and the tests print it. */
export const purgeEntryName = (entry: PurgePathEntry): string => ('member' in entry ? entry.member : entry.site);

export interface PurgePathStop { entry: PurgePathEntry; name: string; owner: string; capability: Capability; why: string }

/**
 * Every listed entry that stops a purge on `engine` from `entryPoint`, in list order. An engine that is not the Rust
 * engine serves every entry (PGLite, Postgres) and a transaction handle or fake has nothing to refuse, so only a Rust
 * engine is read against the list.
 */
export async function purgePathStops(engine: object, entryPoint: PurgeEntryPoint = 'delete_page'): Promise<PurgePathStop[]> {
  if ((engine as { kind?: unknown }).kind !== 'rust') return [];
  const { rustMemberCapability } = await import('../rust-engine.ts');
  const { RUST_ENGINE_MEMBERS } = await import('../rust-engine/members.ts');
  const stops: PurgePathStop[] = [];
  for (const entry of PURGE_PATH) {
    if (entry.entry === 'retention' && entryPoint !== 'retention') continue;
    const name = purgeEntryName(entry);
    if ('site' in entry) {
      if (entry.stop) stops.push({ entry, name, owner: entry.owner, capability: 'raw_sql', why: entry.stop });
      continue;
    }
    const capability = rustMemberCapability(entry.member);
    if (capability) stops.push({ entry, name, owner: entry.owner, capability, why: entry.stop ?? 'not served by the Rust engine' });
    else if (entry.refuses) stops.push({ entry, name, owner: entry.owner, capability: (RUST_ENGINE_MEMBERS as unknown as Record<string, Capability>)[entry.member]!, why: entry.refuses });
  }
  return stops;
}

/**
 * The pre-write check of every entry that reaches a purge (delete_page --purge, the retention purge, a recovered purge
 * request): throws the typed `engine_capability_missing` refusal naming the first stop and its owner lane, with
 * outcome `none` (nothing ran). Call it before the purge reads or writes anything.
 */
export async function requirePurgePathServed(engine: object, entryPoint: PurgeEntryPoint = 'delete_page'): Promise<void> {
  const [first] = await purgePathStops(engine, entryPoint);
  if (!first) return;
  throw capabilityMissing(first.capability, `${entryPoint === 'retention' ? 'the retention purge' : 'delete_page --purge'}, which needs ${first.name} (owner ${first.owner}: ${first.why})`);
}
