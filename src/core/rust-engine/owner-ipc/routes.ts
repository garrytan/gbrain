/**
 * How each BrainEngine member behaves on a client of the Rust engine owner (docs/designs/RUST_ENGINE.md, "Owner
 * protocol for the Rust engine"), and the typed errors a client call ends with.
 *
 * - `local`: the client answers it itself (identity and lifecycle).
 * - `forward`: the call crosses the owner socket as data and runs on the owner engine. Every member that takes only
 *   data is forwarded, executeRaw included (one statement, never a transaction).
 * - `refuse`: the member takes a callback that must run against the engine (a transaction body, a reserved
 *   connection, a schema lock, a store whose calls run inside a transaction: worktreeClaimStore and writerAdminStore, and
 *   the managed-mode stores, whose answer is an object of functions).
 *   Transactions do not cross the socket, so the member rejects at once with `engine_capability_missing` and nothing runs.
 *   owner-ipc/whole-op.ts can send a whole operation that needs a transaction to run inside the owner, but no entry point
 *   calls it yet: a journaled write from a client (put_page, remember) stops at write admission, which opens a transaction,
 *   on this refusal with reason `transactions`.
 *
 * Before any of these, a client whose owner is a Rust engine (hello `kind: 'rust'`) checks the member's capability
 * class against the capabilities in the hello. A member the owner lacks (executeRaw without raw_sql, getPage without
 * pages, transaction without transactions) rejects at the client with the same `engine_capability_missing` error the
 * in-process RustEngine gives, byte for byte, and nothing crosses the socket (client.ts, missingOnRustOwner).
 *
 * The table is derived from RUST_ENGINE_MEMBERS, which the compiler checks against BrainEngine, so a new member is
 * forwarded by default; a forwarded call whose arguments carry a function the client cannot send refuses the same way.
 */
import type { Capability } from '../../engine-capabilities.ts';
import { OperationError, opError } from '../../ops/contract.ts';
import { CODES } from '../../error-registry.ts';
import { RUST_ENGINE_MEMBERS, type RustEngineMember } from '../members.ts';
import {
  OWNER_IPC_CONFIRMING_NOTES, OWNER_IPC_CONFIRMING_READS, OWNER_IPC_LOCAL_ONLY_READS, OWNER_IPC_WHOLE_OP_CONFIRMING_READS,
} from './confirming-reads.ts';

export type OwnerIpcRoute = 'local' | 'forward' | 'refuse';

// withManagedPersistencePaused runs its callback on the caller's side and reaches the owner only through its two typed
// members (pauseManagedPersistence, restoreManagedPersistence), which are forwarded.
const LOCAL: ReadonlySet<string> = new Set(['kind', 'capabilities', 'connect', 'disconnect', 'reconnect', 'registerBeforeDisconnect',
  'withManagedPersistencePaused']);
const REFUSE: ReadonlySet<string> = new Set(['transaction', 'transactionDirect', 'withReservedConnection', 'holdSchemaMigrationLock', 'keywordBoundedRead',
  'worktreeClaimStore', 'writerAdminStore',
  // The managed-mode stores answer an object of functions that run on the owner's store: a function does not cross the
  // socket, so a client refuses them by name instead of receiving an empty object (lane LM; managed mode runs in the owner).
  'gitDurabilityStore', 'gitEffectStore', 'topologyStore', 'manualLinkStore', 'refreshStore', 'groupPublishStore']);

export const OWNER_IPC_ROUTES: Readonly<Record<RustEngineMember, OwnerIpcRoute>> = Object.fromEntries(
  Object.keys(RUST_ENGINE_MEMBERS).map(member => [member, LOCAL.has(member) ? 'local' : REFUSE.has(member) ? 'refuse' : 'forward']),
) as Record<RustEngineMember, OwnerIpcRoute>;

/**
 * Option keys whose function value is a void notification a client may receive back from the owner: the search
 * metadata hooks (SearchOpts, and `cjkKeyword.onMeta` / `onStatementBudget` of engine-sql/cjk-search.ts). The owner
 * sends each notification before the call's result, so the caller sees it before its promise settles.
 */
export const OWNER_IPC_CALLBACK_KEYS: ReadonlySet<string> = new Set([
  'onVectorPoolMeta', 'onKeywordIncomplete', 'onMeta', 'onStatementBudget',
]);

/**
 * Forwarded members a remote caller (an agent-facing MCP request, a non-application submission authority, a remote
 * verified writer) may send to the owner: each only reads. Every other member, a write or anything not listed here
 * (executeRaw, lock and lease calls, settings), is refused for a remote caller at the client with
 * `engine_capability_missing` before it is sent, because the owner would run it with the owner's own authority: the
 * call does not carry the caller's remote flag, submission authority or verified writer. A new member is a write here
 * until it is added. A local caller sends every forwarded member as before.
 */
export const OWNER_IPC_REMOTE_HAND_READS: ReadonlySet<string> = new Set([
  'aliasCanonicalRefs', 'batchLoadEmotionalInputs', 'cosinesByChunkIds', 'countChunklessPagesWithContent',
  'countEmbeddingHeldPages', 'countKeywordPages', 'countOnboardSignal', 'countPagesBy',
  'countPendingProjectionPages', 'countStaleChunks', 'countStaleFrontmatterKeyPages', 'countStalePagesForExtraction',
  'countStaleTakes', 'countUnconsolidatedFacts', 'discoverOntologyDimensions', 'findAnomalies', 'findByTitleFuzzy',
  'findCandidateDuplicates', 'findDuplicatePage', 'findDuplicatePages', 'findOntologyConflicts', 'findOrphanPages',
  'findPages', 'findPagesByTitles', 'findTrajectory', 'generatedPagesIn', 'getAdjacencyBoosts', 'getAllConfig',
  'getAllSlugs', 'getBacklinkCounts', 'getBacklinks', 'getCalibrationCurve', 'getCalleesOf', 'getCallersOf',
  'getChunkPage', 'getChunkReuseRows', 'getChunkWindows', 'getChunks', 'getChunksWithEmbeddings', 'getConfig',
  'getConfigValues', 'getContentFlagsByPageIds', 'getContradictionCacheEntry', 'getDreamVerdict', 'getEdgesByChunk',
  'getEffectiveDates', 'getEmbeddingsByChunkIds', 'getFactsHealth', 'getFile', 'getHealth', 'getIngestLog',
  'getLastSeen', 'getLinks', 'getOnThisDay', 'getOntology', 'getPage', 'getPageSealState', 'getPageTimestamps',
  'getRawData', 'getRecentSalience', 'getSalienceScores', 'getScorecard', 'getSince', 'getSource',
  'getSourceStrictness', 'getStats', 'getTags', 'getTakeEmbeddings', 'getTimeline', 'getTimelineForDate',
  'getUnverifiedExtractionPageIds', 'getVersions', 'hasNotifierCoverage', 'hasSupersedeEdges', 'hasUnsealedPages',
  'isFolderRestricted', 'listActiveTakesForPages', 'listAllPageRefs', 'listAllSources',
  'listChunklessPagesWithContent', 'listConfigKeys', 'listCorpusSample', 'listEmbeddingStateRows',
  'listEnrichCandidates', 'listEntityKeyRows', 'listEvalCandidates', 'listEvalCaptureFailures', 'listFactsByEntity',
  'listFactsBySession', 'listFactsKeyset', 'listFactsSince', 'listFilesForPage', 'listIdentityDecisions',
  'listLinkSources', 'listPages', 'listPrefixSampledPages', 'listRestrictedIdentityMembers', 'listSourceLocalPaths',
  'listStaleChunks', 'listStaleFrontmatterKeyPages', 'listStalePagesForExtraction', 'listStaleTakes',
  'listSupersessions', 'listTakes', 'livePageIdsAt', 'loadContradictionsTrend', 'pageCollapseFacts',
  'pagesLinkingTo', 'projectionRebuildProgress', 'readCycleLocks', 'readEmbeddingStateCounts',
  'readHeldCoverageRows', 'readLedgerSource', 'readLocalWriterRow', 'readManagedModeRows', 'readManifest',
  'readPageSnapshot', 'readPageSnapshotsBatch', 'readPersistenceBrainId', 'readProjectionReadiness',
  'readProjectionReadinessGeneration', 'readSegmentDerivations', 'readSegmentTexts', 'readTransactionSettings',
  'relationalChainHop', 'relationalFanout', 'resolveAliases', 'resolveCaseSensitiveAliases', 'resolveSlugWithAlias',
  'resolveSlugWithAliasDetailed', 'resolveSlugs', 'resolveSlugsByPaths', 'searchKeyword', 'searchKeywordChunks',
  'searchKeywordPages', 'searchTakes', 'searchTakesVector', 'searchTitles', 'searchVector', 'slugsEndingIn',
  'sumStaleChunkChars', 'supersedingPageSlugs', 'traverseGraph', 'traversePaths', 'traversePathsDetailed',
]);

/**
 * Typed reads (owner-ipc/typed-member-classes.ts) a remote caller may send: each one is added by name once a served
 * parity file proves it on both multi-user routes (ruling A, batch 1). Since K the brain server runs a remote-marked
 * read under the caller's record with the remote flag on, exactly as an in-process remote call runs, so the answer is
 * the in-process one. The hand list above is frozen; a new remote read goes here (test/rust-owner-ipc-remote.test.ts).
 */
export const OWNER_IPC_REMOTE_TYPED_READS: readonly string[] = [
  // mcp-get-tags: a remote get_tags quotes the tags of a quoted page.
  'listPageQuoteTiers',
  // write-request-reads: a remote caller reads its own write receipts and a memory proposal's state.
  'readWriteRequest', 'listWriteRequestRows', 'readMemoryProposal',
  // search-caller-refusals: a remote fuzzy get_page drops the private-only candidates in its snapshot (ops/pages.ts).
  'readPrivateOnlySlugs',
  // The remote reads the remote-write files make once their writes cross (batch 3): admin-counts, credential-grant-writes,
  // fence-row-trust, owner-write-privacy, page-mutation-reads, plain-member-writes, query-filters, remote-access-matrix,
  // remote-links, source-scope-reads, takes-prepare, timeline-add, unbound-claim, world-only-spelling-read,
  // write-request-cancel. Each is a typed read the server runs under the caller's record with the remote mark.
  'computeFactFingerprints', 'filterPageIdsByFrontmatter', 'findExactSlug', 'getWorktreeBinding', 'hasGuestSource',
  'listContestedProposalPairs', 'listFactRowsByIds', 'listFactsForRelevance', 'listFactsFromQuotedPages',
  'listFenceHoldRows', 'listFenceRowTrust', 'listHeldFenceCells', 'listOwnerTierFacts', 'listPageRefsByIds',
  'listPageStatusByRef', 'listPagesTitledIn', 'listSharedSkillPackRoots', 'listSlotRows', 'matchSavedFacts',
  'pageAwaitsRederive', 'readAccessTokenWriteGrant', 'readAdmissionSource', 'readAdmittedPageRefs',
  'readFenceOverlayRows', 'readHeldPageRows', 'readIdentitySiblingCandidates', 'readJournalLimitRows',
  'readLinkContextMatches', 'readLinkContextOriginPages', 'readOAuthClientWriteGrant',
  'readOwnerOnlySourceConfig', 'readPageTrustRows', 'readRowTrustRows', 'readSourceMembership', 'readSourceRow',
  'readStoredSlugSpellings', 'readWriteRequestsByRequestIds', 'readWriteVisibilityProbe', 'readWriterSlugFence',
  'sharedSkillPackTablePresent', 'wordLexemes',
  // Lane 2b member refusals (cli-reads-ops, caller-typed-reads, mention-coverage): the typed reads not already listed above.
  // cli-reads-ops: a remote whois by phone number lists its candidates under the caller's excludePrivate.
  'listExactIdentityCandidates',
  // caller-typed-reads: the remote facts delta reads each fact's provenance.
  'listFactProvenance',
  // mention-coverage: a world-only caller's backlinks and coverage, under the caller's referrer scope.
  'listReferrerTargetSources', 'readMentionIndexStatus', 'countLivePagesInSource', 'countReferrerRows',
  'readReferrerPageDetails', 'readReferrerRows',
  // entity-variants, labelled-only-reads (served, both routes): a remote entity reads its card rows and ranks title
  // variants without a private one; a remote get_versions reads each version's reason writers.
  'readEntityCardRows', 'rankEntities', 'listNameVariantCardCandidates', 'readVisibleVariantPages',
  'listVisibleNameVariantCandidates', 'readRetirementHop', 'readEntityAliasRows', 'readRankCoverage', 'readReferrerTargetCounts',
  'listVersionReasonWriters',
  // served-remote-feedback-record (served, both routes): a remote search, query, recall and think read each result page's
  // learned feedback weight (search/feedback-boost.ts) when feedback is on. The server serves it only when every id names a
  // page the caller may read (served/remote-member-policy.ts PAGE_ID_GUARDS).
  'readPageFeedbackWeights',
  // S4 (retrieval), served-remote-resolve: a remote query, search, recall, traverse_graph and memory_recall resolve a named entity
  // (title, bare-name prefix family, same-name siblings, a meeting's title seed, a chain anchor, the entity anchor's titles),
  // ask which sources the caller cannot read, and read their source configs.
  'readPageTitle', 'readPageTitlesById', 'readPrefixCandidates', 'readPrefixDirs', 'readPrefixTitleMatches',
  'readSiblingGroupRows', 'readSeedTitleSlugs', 'resolveChainAnchorRows', 'readSourcesNotReadable', 'readScopeSourceConfigs',
  // S4 (retrieval), served-remote-entity-context: a remote entity card reads its referrer groups, record pages and text
  // mentions; context_pack reads the trust generation; volunteer_context reads its reflex pages (privacy narrowed by
  // remote-member-policy.ts) and live keys and its usage counts.
  'readReflexPages', 'readReflexLiveKeys', 'readVolunteerUsage', 'readTrustGeneration',
  'readReferrerGroupRows', 'readReferrerRecordCandidates', 'readReferrerRecordPages', 'readTextMentionPages',
  // S4 (retrieval), served-remote-segmented: a remote get_page and get_versions of a segmented page read its head and its
  // version body sizes (page-id guarded, remote-member-policy.ts); search reads the regions of a page with more than two
  // hits; search_exact scans a batch of pages for a phrase.
  'readSegmentedPageHead', 'readSegmentedVersionBodyBytes', 'readSegmentRegions', 'scanExactBatch',
];

/**
 * Members that never cross the wire for a remote caller, each with its reason. The remote read list guard fails when
 * any of these is added to OWNER_IPC_REMOTE_READS.
 */
const SECRET_STORE = 'the secret store: its entries, MACs and spans locate secret values in the brain';
const CREDENTIALS = 'credential material: token and code hashes, challenges and credential rows';
const READ_LOG = 'the access read log: who read which page, a privacy record of other callers';
const DECIDE = 'the decide store: the owner\'s paid-provider spend, proposals and calibrations';
export const OWNER_IPC_REMOTE_DENY: Readonly<Record<string, string>> = {
  readCommitLog: 'the commit log lists every key family\'s write ids and origins, across all callers',
  lastCommitPosition: 'a commit position from the log; the served side answers positions from the store itself',
  listEntityFactsInCommitOrder: 'fact ids in commit order, before any visibility filter; a remote caller reads facts through the filtered reads',

  beginSnapshotRead: 'opens a snapshot on the server that outlives the call; not a plain read (inside a transaction the caller holds it may cross: OWNER_IPC_REMOTE_TXN_SETTINGS)',
  readStoredBodyBytes: 'the stored body bytes before any visibility or quoting is applied',
  readPageBodySizes: 'body sizes of every page, private ones included, reveal what exists',
  readFieldUsageSamples: 'samples frontmatter values across every page, private ones included',
  listFiles: 'host filesystem paths of the brain\'s files',
  getCodeTraversalCache: 'a host-side cache of code traversal results, not a brain read',
  ...Object.fromEntries(['findSecretEntryByMac', 'secretEntryExists', 'readSecretEntry', 'listSecretOccurrences', 'listSecretEntrySummaries',
    'countSecretsByRule', 'listAllowedSecretMacs', 'listSecretKeysInUse', 'readSecretStoreSnapshot', 'listSecretHoldingPages',
    'countUnreferencedSecretEntries', 'listPageSecretOccurrences'].map(m => [m, SECRET_STORE])),
  ...Object.fromEntries(['readActiveAccessTokenByHash', 'readOauthCodeChallenge', 'readOauthCodeForUpdate', 'readOauthRefreshTokenForUpdate',
    'readAccessCredentials', 'listOwnerCredentialRows', 'listAttestCredentialRows'].map(m => [m, CREDENTIALS])),
  ...Object.fromEntries(['readAccessReadLog', 'listAccessReadPageRefs', 'readAccessReadsOfPages', 'tallyAccessReadsOfPages'].map(m => [m, READ_LOG])),
  ...Object.fromEntries(['readDecideState', 'dailyDecideSpend', 'listDecideSpendBySlot', 'listDecideReceiptStats', 'getDecideProposal',
    'listDecideProposals', 'getDecideReviewProposal', 'listDecideCalibrations', 'getDecideCalibration'].map(m => [m, DECIDE])),
  readSharedSourceRows: 'every live source\'s config, guest flag and owner list across all callers; the remote grant and personal-source checks need a server-side scoped form',
};

/**
 * Engine members that write and that a remote caller may still send, over the served wire only (ruled 2026-11-26): the
 * usage stamp a remote read makes in process too (last-retrieved.ts bumpLastRetrievedAt), best-effort and idempotent, and
 * the retrieval event a remote answer records for its caller (feedback/record.ts, via `insertRetrievalEvents`). The brain
 * server stamps only page ids the caller may read and refuses the call otherwise, and stores an event only for the client
 * its call frame claims, only for pages and links the caller may read, and never over another client's answer id
 * (served/remote-member-policy.ts; the claim is member-claim.ts). Neither is a read: both stay out of
 * OWNER_IPC_REMOTE_READS, and test/rust-owner-ipc-remote.test.ts pins this list to exactly these two members.
 */
export const OWNER_IPC_REMOTE_SIDE_WRITES: ReadonlySet<string> = new Set(['bumpPageRetrievals', 'insertRetrievalEvents']);

/**
 * Members a remote caller may send only on a transaction it holds (the served wire's `txn`), never outside one: each
 * sets that transaction and nothing beyond it. `beginSnapshotRead` makes the caller's own transaction one snapshot, or
 * read-only; the transaction ends with the caller's commit or rollback, so the snapshot never outlives it. A remote
 * fuzzy get_page reads its candidates this way in process (ops/pages.ts). Outside a transaction it stays on
 * OWNER_IPC_REMOTE_DENY; test/rust-owner-ipc-remote.test.ts pins this list to exactly this one member.
 */
export const OWNER_IPC_REMOTE_TXN_SETTINGS: ReadonlySet<string> = new Set(['beginSnapshotRead']);

/**
 * Forwarded members a remote caller may send to the owner: the frozen hand list and the typed additions above. Every
 * other member, a write or anything not listed, is refused for a remote caller before it is sent.
 */
export const OWNER_IPC_REMOTE_READS: ReadonlySet<string> = new Set([...OWNER_IPC_REMOTE_HAND_READS, ...OWNER_IPC_REMOTE_TYPED_READS]);

/** The capability family a member belongs to, for the refusal's `reason`. */
function memberCapability(member: string): Capability {
  const cls = (RUST_ENGINE_MEMBERS as Record<string, string>)[member];
  return (cls === undefined || cls === 'implemented' ? 'raw_sql' : cls) as Capability;
}

/** A member (or one of its arguments) that cannot run from a client process; nothing ran. */
export function ownerIpcRefusal(member: string, why: string): OperationError {
  const capability = memberCapability(member);
  return opError('engine_capability_missing',
    `${member} cannot run from a second process on this brain: ${why}, so nothing ran.`,
    'Run it in the process that owns the brain (for example through gbrain serve tools), or stop the owner process and run it again.',
    { reason: capability, detail: `member=${member} capability=${capability} outcome=none written=nothing via=owner_ipc`,
      why: 'Another process owns this brain and this process reaches it over the owner socket. Transactions and callbacks do not cross that socket, and a page write, a memory write or an import opens a transaction, so it cannot run from this process yet.' });
}

/** True when `member` only reads, so a rerun cannot repeat a write. */
export function ownerMemberOnlyReads(member: string): boolean {
  return OWNER_IPC_REMOTE_READS.has(member) || OWNER_IPC_LOCAL_ONLY_READS.has(member);
}

/**
 * The advice for a call whose answer never came back after it was sent (cancel, deadline, owner gone): the owner does
 * not stop a started call, so a write may have committed. A rerun is advised only when nothing can have been written
 * (a read, or a write whose entry says a rerun repeats nothing); otherwise the advice names the read that confirms the
 * write (confirming-reads.ts). A write with no entry gets the most general read.
 *
 * The owner holds that read back while the earlier call still runs (server.ts, orphans), so the read answers only
 * after the call has ended, committed or not, and what it finds is final. A read that cannot wait that long ends
 * `owner_unavailable` (`earlier_call_running`) and tells nothing.
 */
export function confirmingReadAdvice(member: string): string {
  if (ownerMemberOnlyReads(member)) return `Before you rerun ${member}: it only reads, so nothing was written and running it again is safe.`;
  const read = OWNER_IPC_CONFIRMING_READS[member] ?? OWNER_IPC_WHOLE_OP_CONFIRMING_READS[member] ?? 'a read of every row the call writes';
  if (read.startsWith('nothing:')) return `Before you rerun ${member}, there is ${read}.`;
  const note = OWNER_IPC_CONFIRMING_NOTES[member];
  return `Before you rerun ${member}, run ${read} to see whether it committed; rerun it only if it did not. `
    + `The owner answers that read only after the earlier ${member} call has ended, so what it finds is final.`
    + (note ? ` ${note}` : '');
}

/**
 * A call that waited behind an earlier write the owner still runs (its caller may have timed out, cancelled or
 * closed its connection), and reached its own deadline there. It never ran. It is the read that
 * would confirm the earlier write, so until that write ends whether it committed is not known: this is not `not_sent`
 * and not a reason to rerun the write.
 */
export function ownerEarlierCallRunning(member: string, earlier: string, ms: number): OperationError {
  return opError('owner_unavailable',
    `${member} did not run within ${ms} ms: the brain's owner holds it back while an earlier ${earlier} call still runs. Until that call ends, whether it committed is not known.`,
    `Wait for the earlier ${earlier} call to end, then run ${member} again; its answer is final then. Do not rerun ${earlier} before that read answers. If it never ends, check the owner process log.`,
    { reason: 'earlier_call_running', retryable: false,
      detail: `member=${member} via=owner_ipc earlier=${earlier} deadline_ms=${ms} sent=true ran=false`,
      why: 'The owner does not stop a store call it started, so a write whose caller timed out or cancelled can still commit. A read that confirms it waits until it has ended, so an empty answer can never come from a write that is about to commit.' });
}

/**
 * Multi-user Rust only: the owner is handing the brain over (it is closing) and did not start this call, so nothing of
 * it ran. The client runs the election again and sends the call to the next owner (client.ts), which is safe for a write
 * too. Reason `owner_handoff`, retryable.
 */
export function ownerHandoff(member: string, ownerPid: number | null): OperationError {
  return opError('owner_unavailable',
    `The process that owns this brain${ownerPid ? ` (pid ${ownerPid})` : ''} is handing it over and did not start ${member}, so nothing of it ran.`,
    'The client sends it to the next owner by itself; if this reaches you, run the command again.',
    { reason: 'owner_handoff', retryable: true, detail: `member=${member} via=owner_ipc owner_pid=${ownerPid ?? 'unknown'} sent=true ran=false`,
      why: 'In multi-user mode an owner that exits answers every call it has not started with this refusal before it closes, and finishes the ones it started, so the next owner can take the rest.' });
}

/** True for the refusal `ownerHandoff` gives: the call never ran. */
export function isOwnerHandoff(error: unknown): boolean {
  return error instanceof OperationError && error.code === 'owner_unavailable' && (error as { reason?: unknown }).reason === 'owner_handoff';
}

/** The owner went away. `sent` says whether the owner may have started the call (its outcome is then unknown). */
export function ownerGone(member: string, ownerPid: number | null, sent: boolean): OperationError {
  const who = ownerPid ? `The process that owns this brain (pid ${ownerPid})` : 'The process that owns this brain';
  return opError('owner_unavailable',
    sent
      ? `${who} exited or closed its socket before it answered ${member}; a write may or may not have committed.`
      : `${who} exited or closed its socket, so ${member} was not sent.`,
    sent
      ? `${confirmingReadAdvice(member)} With no owner running, this process opens the brain itself.`
      : 'Run the command again: with no owner running, this process opens the brain itself.',
    { reason: sent ? 'outcome_unknown' : 'not_sent', retryable: !sent || ownerMemberOnlyReads(member),
      detail: `member=${member} via=owner_ipc owner_pid=${ownerPid ?? 'unknown'} sent=${sent}`,
      why: 'This process reached the brain through the owner process, which went away. A call in flight ends here because the owner may have started it; the next call of a long-lived engine runs the election again, so this process becomes the owner or a client of the new one.' });
}

/**
 * The call's deadline passed before it finished. `stage` says how far it got: `queued` (it waited in the owner queue and
 * never ran), `not_sent` (it never left this process) or `sent` (the owner may have started it). A call the owner
 * already started is not interrupted: the store does not observe the abort, so a write can still commit after this
 * error: a sent call ends `owner_unavailable` with reason `outcome_unknown`, retryable only for a read, and names the
 * read that confirms a write. A call that never ran keeps `timeout`.
 */
export function ownerCallTimeout(member: string, ms: number, stage: 'queued' | 'not_sent' | 'sent'): OperationError {
  const detail = `member=${member} via=owner_ipc deadline_ms=${ms} queued=${stage === 'queued'} sent=${stage !== 'not_sent'}`;
  if (stage !== 'sent') {
    return opError('timeout',
      stage === 'queued'
        ? `${member} did not start within ${ms} ms on the brain's owner: it waited in the owner queue and never ran.`
        : `${member} reached its deadline before it was sent to the brain's owner, so it never ran.`,
      'Retry the same call; it waits again within its own deadline. If it keeps timing out, the owner process is busy: check its log.',
      { reason: stage === 'queued' ? 'not_started' : 'not_sent', retryable: true, detail });
  }
  return opError('owner_unavailable',
    `${member} did not finish within ${ms} ms on the brain's owner. A call the owner already started is not interrupted, so a write may or may not have committed.`,
    `${confirmingReadAdvice(member)} If calls keep timing out, the owner process is busy: check its log.`,
    { reason: 'outcome_unknown', retryable: ownerMemberOnlyReads(member), detail,
      why: 'The owner process is not told to stop a started store call, so it finishes the call after this process stopped waiting.' });
}

/**
 * The caller's AbortSignal fired. Before the call was sent it never ran: `cancelled`. After it was sent the owner is
 * told to stop it, but a call the owner already started is not interrupted (the store does not observe the abort), so
 * a write can still commit: the outcome is unknown, as for a sent call's timeout, and rerunning the call could repeat
 * the write.
 */
export function ownerCallCancelled(member: string, sent: boolean): OperationError {
  if (sent) {
    return opError('owner_unavailable',
      `${member} was cancelled by its caller after it was sent to the brain's owner. A call the owner already started is not interrupted, so a write may or may not have committed.`,
      confirmingReadAdvice(member),
      { reason: 'outcome_unknown', retryable: ownerMemberOnlyReads(member), detail: `member=${member} via=owner_ipc sent=true`,
        why: 'The owner process is not told to stop a started store call, so it finishes the call after this process stopped waiting.' });
  }
  return opError('cancelled',
    `${member} was cancelled by its caller before it was sent.`,
    'Nothing to do unless the cancel was unexpected; run the call again to repeat it.',
    { detail: `member=${member} via=owner_ipc sent=false` });
}

/** The owner's reply exceeded the frame cap. */
export function ownerResponseTooLarge(member: string, maxBytes: number): OperationError {
  return opError('response_too_large',
    `The owner's answer to ${member} was larger than ${maxBytes} bytes, the most the owner socket carries.`,
    'Narrow the call (a smaller limit or one page at a time) and run it again.',
    { detail: `member=${member} via=owner_ipc max_bytes=${maxBytes}` });
}

export type OwnerIpcProtocolReason = 'version_mismatch' | 'hello_missing' | 'duplicate_id' | 'args_not_array' | 'result_undecodable';

/**
 * A frame broke the owner protocol (`owner_ipc_protocol`). `member` is the call it refused, or null for the
 * connection's hello. Only `result_undecodable` may follow a call the owner ran; every other reason refuses before any
 * work.
 */
export function ownerIpcProtocol(reason: OwnerIpcProtocolReason, member: string | null, detail: string): OperationError {
  const what = member ?? 'The connection to the brain owner';
  const messages: Record<OwnerIpcProtocolReason, string> = {
    version_mismatch: `${what} was refused: this process and the brain owner speak different owner protocol versions (${detail}), so nothing was sent.`,
    hello_missing: `${what} came before the connection's hello, so the owner did not run it.`,
    duplicate_id: `${what} reused the id of a call still running on this connection, so the owner did not run it.`,
    args_not_array: `${what} sent arguments that are not a list, so the owner did not run it.`,
    result_undecodable: `The brain owner's answer to ${what} could not be read in this process; the owner may have run it.`,
  };
  return opError('owner_ipc_protocol', messages[reason],
    reason === 'version_mismatch'
      ? 'Run the same gbrain version in every process on this brain: upgrade, then restart the older process or gbrain serve.'
      : reason === 'result_undecodable'
        ? 'Read the data again before you retry a write, and report this as a gbrain bug with the code, reason and detail.'
        : 'Report this as a gbrain bug with the code, reason and detail; the call did not run.',
    { reason, retryable: false, fix: CODES.owner_ipc_protocol.fix,
      detail: `${member === null ? '' : `member=${member} `}via=owner_ipc reason=${reason} ${detail}`.trim() });
}

export type OwnerBusyReason = 'queue_full' | 'inflight_bytes' | 'connections';

/**
 * The owner refused a call or a connection because a bound on its memory was reached (`owner_busy`, retryable): its
 * queue of waiting calls, the bytes of call frames it holds, or its open connections. Nothing ran. `member` is null for
 * a refused connection.
 */
export function ownerBusy(reason: OwnerBusyReason, member: string | null, limit: number): OperationError {
  const what = member ?? 'The connection to the brain owner';
  const messages: Record<OwnerBusyReason, string> = {
    queue_full: `${what} was refused: the brain owner already has ${limit} calls waiting, so it did not run.`,
    inflight_bytes: `${what} was refused: the brain owner already holds close to ${limit} bytes of calls, so it did not run.`,
    connections: `${what} was refused: the brain owner already has ${limit} connections open, so nothing was sent.`,
  };
  return opError('owner_busy', messages[reason],
    'Retry after the calls in flight finish. If it keeps happening, fewer processes or smaller calls on this brain at once help.',
    { reason, retryable: true, fix: CODES.owner_busy.fix,
      detail: `${member === null ? '' : `member=${member} `}via=owner_ipc reason=${reason} limit=${limit}` });
}

export type OwnerPeerRefusedReason = 'peer_uid' | 'socket_owner' | 'socket_mode';

/**
 * The owner socket's other end is not this OS user (`owner_ipc_peer_refused`, not retryable): the owner read another
 * uid from the kernel (`peer_uid`, on either side), or the client found the socket owned by another user
 * (`socket_owner`) or open to group or other users outside a private 0700 directory of this user (`socket_mode`).
 * Nothing was sent or run.
 */
export function ownerPeerRefused(reason: OwnerPeerRefusedReason, detail: string): OperationError {
  const messages: Record<OwnerPeerRefusedReason, string> = {
    peer_uid: 'The other end of the brain owner socket is not this OS user, so the connection was refused and nothing ran.',
    socket_owner: 'The brain owner socket belongs to another OS user, so this process did not connect to it and nothing was sent.',
    socket_mode: 'The brain owner socket can be opened by other OS users, so this process did not connect to it and nothing was sent.',
  };
  return opError('owner_ipc_peer_refused', messages[reason],
    reason === 'peer_uid'
      ? 'Run every gbrain process on this brain as the same OS user.'
      : 'Stop the process that made the socket (gbrain doctor names the owner pid), check the brain directory belongs to you, then run the command again.',
    { reason, retryable: false, fix: CODES.owner_ipc_peer_refused.fix, detail: `via=owner_ipc reason=${reason} ${detail}`.trim() });
}
