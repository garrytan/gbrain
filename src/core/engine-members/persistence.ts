/**
 * The persistence statements of BrainEngine: the write journal, sync holds, claims, housekeeping, effect worker and connect gate.
 * Declarations moved verbatim out of engine.ts; `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type { AccessTokenWriteGrant, AdmissionRate, ClaimedWriteRow, CompletedWriteRow, CounterRow, HeldCoverageRow, OAuthClientWriteGrant, OutstandingBySource, PublicationEffectsSpec, WithdrawalEffectsSpec, WriteCancelResult, WriteCancellation, WriteCompletion, WriteRequestInsert, WriteRequestListFilter, WriteRequestProgress, HeldHitQuery, HeldHitRow } from '../engine-sql/persistence-journal.ts';
import type { AtomOriginInputRow, AtomWriteReceiptRow, GenerationVersionProducer, ProducerVersionRow } from '../engine-sql/generation-atom-reads.ts';
import type { CapacityForecastInputs, HousekeepingTurnClaim, PendingSegmentedProjection, ProjectionJobRef, ProjectionPageRef, ProjectionWindowRow, ReceiptBudget, SegmentedProjectionClaimOutcome, SegmentedProjectionFilter, TrueUpReservation } from '../engine-sql/persistence-housekeeping.ts';
import type * as ChronicleEventsSql from '../engine-sql/chronicle-events.ts';
import type { ClaimExpiry, ClaimHeadSpec, ClaimRelease, ClaimRenewal, ConsumerProbe, ConsumerRenewal, ConsumerRowKey, ConsumerRowRead, SourceMembership, TopologyChange, TopologyChangeInsert } from '../engine-sql/persistence-claims.ts';
import type { EffectClaim, EffectClaimRef, EffectWorktreeOwner, MirrorGateRow } from '../engine-sql/persistence-effect-worker.ts';
import type { FenceHoldFileRow, FenceHoldKey, FenceHoldRow } from '../engine-sql/fence-holds.ts';
import type { FenceVersionBodyRow } from '../engine-sql/generation-fence-evidence.ts';
import type { GatedMirrorRequest, RequestEffectState } from '../engine-sql/persistence-effect-scans.ts';
import type { GenerationActivationRecord, GenerationActivationState, GenerationOrphanRow, PendingGenerationMemberRow } from '../engine-sql/generation-activations.ts';
import type { GenerationActivationRow, GenerationAttemptCount, GenerationLedgerRow, GenerationRowKey, GenerationValveRow, HeldGenerationRow, HeldInputRow, LiveGenerationRow } from '../engine-sql/derived-generations.ts';
import type { GenerationFenceBlockRow, GenerationOwnedItemRow } from '../engine-sql/generation-fence-restore.ts';
import type { GenerationPageRow, GenerationPageRowsQuery } from '../engine-sql/generation-page-rows.ts';
import type { GenerationRepairFilter, GenerationRepairItemRow, HeldGenerationListRow, HeldGenerationProposalRow, RestorableGenerationRow, SourceIncarnationListRow, UnmatchedGenerationRow } from '../engine-sql/generation-repair.ts';
import type { GitHoldRecordsQuery, GitHoldReportInputs } from '../engine-sql/sync-hold-reads.ts';
import type { GitHoldSummaryWeights, SyncConversion, SyncPassRowRead, SyncPassRowWrite } from '../engine-sql/sync-hold-store.ts';
import type { GraduationGateRow, ManagedRootBindingRow, PersistenceTable, RetiredDeactivationRow } from '../engine-sql/connect-gate.ts';
import type { IdleProbeRow, IdleProbeSpec } from '../engine-sql/persistence-idle-probe.ts';
import type { LedgerScrubCounts } from '../engine-sql/generation-ledger.ts';
import type { LedgerSource } from '../engine-sql/belief.ts';
import type { NoopSettleCandidate, NoopSettleCandidateSpec, NoopSettleWindow, NoopSettledRow } from '../engine-sql/persistence-embedding-noop-settle.ts';
import type { OverdueHold, OverdueHoldKind } from '../engine-sql/persistence-owner-scans.ts';
import type { ProjectionScanCursor } from '../page-state/projection-window.ts';
import type { RecentWriterVersionRow, WriterVersionRow } from '../engine-sql/writer-versions.ts';
import type { ReservedConnection } from '../engine.ts';
import type { SourceCheckoutRoot, SourceMovementBinding, SourceMovementRows, UnembeddedPageSummary, WriteWatermarkRow } from '../engine-sql/applied-watermark-reads.ts';
import type { WriteContextInput, WriteContextResult } from '../engine-sql/transaction-settings.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { CounterColumn } from '../engine-sql/writer-release.ts';
import type { EmbeddingCandidate } from '../engine-sql/persistence-effect-scans.ts';
import type { GitHoldListingRow } from '../engine-sql/sync-hold-store.ts';
import type { IdentityDowngradeCarry, IdentityDowngradeOldPage, IdentityRemedySideRow, ManagedSyncFailureRow, SyncHeadRequestRow, SyncRecoveryProbeRow, SyncStatusCommittedRow, SyncStatusProbeOptions, SyncStatusSourceRow } from '../engine-sql/sync-status-reads.ts';
import type { ReceiptCompactionCandidate, ReceiptCompactionWindow } from '../engine-sql/persistence-housekeeping.ts';
import type { RefreshTiming, WorktreeAdmission, WorktreeAdmissionKey } from '../engine-sql/persistence-admission.ts';
import type { SegmentedGateEvidenceRow } from '../engine-sql/writer-versions.ts';
import type { TerminalIntentCompaction, WriteRequestGroupInsert } from '../engine-sql/persistence-journal.ts';
import type { HeadBlockerReadOpts, HeadBlockerRow, RecoveringHeadRow } from '../engine-sql/head-blocker.ts';
import type { IncompleteSyncReceiptRow, IncompleteSyncReceiptSpec, OpenPassWorkSpec } from '../engine-sql/checkpoint-validation.ts';
import type { FenceOpts } from '../engine-sql/lease-token.ts';

export interface PersistenceMembers {
  /** The atom generation a page's content keys on (engine-sql/atom-generation.ts): the kept content's, else the current one, 0 with none. Reads op_checkpoints. */
  readAtomGeneration(pageId: number, contentHash: string): Promise<number>;
  /** Bumps a page's atom generation and drops the extraction state and completed managed-atoms runs of its other content. Writes op_checkpoints and extract_atoms_page_state. */
  recordAtomGenerationBump(sourceId: string, incarnation: string, pageId: number, keepContentHash: string | null, keepGeneration: number | null): Promise<void>;
  // Write-journal statements (engine-sql/persistence-journal.ts): the text journal.ts, limits.ts and held-reads.ts sent through executeRaw.
  /** The journal limit config rows, then one row with a null key: the largest page stored in segments, or 'unindexed'. */
  readJournalLimitRows(): Promise<Array<{ key: string | null; value: string | null }>>;
  /** The current-incarnation hold rows (`record`, page `revision`) naming these page ids, in fingerprint order. */
  readHeldPageRows<R = Record<string, unknown>>(pageIds: string[]): Promise<Array<{ record: R; revision: string | null }>>;
  /** The holds naming a read's hit pages (`record`, page `revision`) in fingerprint order, then one row with how many held files could affect the read (stampHeldHits). */
  readHeldHitRows<R = Record<string, unknown>>(query: HeldHitQuery): Promise<Array<HeldHitRow<R>>>;
  /** The held-file summary rows of live sources with at least one held file, in source order; null reads every source. */
  readHeldCoverageRows(sourceIds: string[] | null): Promise<HeldCoverageRow[]>;
  /** The held fence results of `kinds` in `sourceIds` (one owner with `ownerKey`), oldest first (`listFenceHolds`, engine-sql/fence-holds.ts). */
  listFenceHoldRows(sourceIds: readonly string[], kinds: readonly string[], ownerKey?: string): Promise<FenceHoldRow[]>;
  /** A fence publish's statements (generations/fence.ts, engine-sql/fence-holds.ts): whether the page is deleted or gone, the generation key lock, the held rows a readable fence clears, and the held pages' file state. */
  readFenceOriginGone(sourceId: string, slug: string): Promise<boolean>;
  lockGenerationKey(lockKey: string): Promise<void>;
  clearFenceHoldRows(key: FenceHoldKey): Promise<void>;
  readFenceHoldFiles(sourceIds: readonly string[], slugs: readonly string[]): Promise<FenceHoldFileRow[]>;
  /** The generation ledger statements of generations/publish.ts (engine-sql/derived-generations.ts): the live generation with its items, a new generation's activation, and a held result. */
  readLiveGenerationRow(key: GenerationRowKey): Promise<LiveGenerationRow | null>;
  activateGenerationRows(key: GenerationRowKey, liveId: number | null, row: GenerationActivationRow, items: readonly GenerationLedgerRow[]): Promise<number>;
  recordHeldGenerationRow(key: GenerationRowKey, row: HeldGenerationRow): Promise<void>;
  /** The git sync hold records of each source's current incarnation, by source then fingerprint (SQL in engine-sql/sync-hold-reads.ts). */
  readGitHoldRecords<R = Record<string, unknown>>(opts?: GitHoldRecordsQuery): Promise<Array<{ record: R }>>;
  /** The pending `sources retry-held` request's keys for one source incarnation's fingerprint, or null (SQL in engine-sql/sync-hold-reads.ts). */
  readGitHoldRetryRequest(fingerprint: string): Promise<Array<{ paths?: unknown }> | null>;
  /** A sync hold report's summary counters (null when none) and the source's `mirror_read_only` text (SQL in engine-sql/sync-hold-reads.ts). */
  readGitHoldReportInputs(sourceId: string, fingerprint: string): Promise<GitHoldReportInputs>;
  /** The source's purge epoch as stored, which every fact purge bumps, or null for an unknown source (SQL in engine-sql/sync-reason-reads.ts). */
  readSourcePurgeEpoch(sourceId: string): Promise<string | number | null>;
  // The git sync hold store (SQL in engine-sql/sync-hold-store.ts); sync-holds.ts keeps the hold semantics.
  /** Creates the source incarnation's hold summary row when missing, else touches it (Postgres: locks it); returns its count. */
  lockGitHoldSummary(sourceId: string, incarnation: string): Promise<number>;
  /** Adds `delta` to the hold summary's count and each weight to its counter, none below zero; no summary row, no write. */
  adjustGitHoldSummary(sourceId: string, incarnation: string, delta: number, weights: GitHoldSummaryWeights): Promise<void>;
  /** The hold record at `path` of the source incarnation as stored, or null. */
  readGitHoldRow<R = Record<string, unknown>>(sourceId: string, incarnation: string, path: string): Promise<R | null>;
  /** Stores `record` as the hold at `path`, replacing any. */
  writeGitHoldRow(sourceId: string, incarnation: string, path: string, record: object): Promise<void>;
  /** Replaces the hold at `path` with `next` only while it is still `expected` (JSON equality); true when it landed. */
  replaceGitHoldRow(sourceId: string, incarnation: string, path: string, expected: object, next: object): Promise<boolean>;
  /** Deletes the hold at `path`; no hold, no change. */
  deleteGitHoldRow(sourceId: string, incarnation: string, path: string): Promise<void>;
  /** The source incarnation's outstanding holds (its summary's count), 0 without a summary. */
  countGitHolds(sourceId: string, incarnation: string): Promise<number>;
  /** Each listed source with outstanding holds and its first `limit` current-incarnation hold records by fingerprint (a null record when none is listed), by source then fingerprint. */
  readGitHoldListingRows<R = Record<string, unknown>>(sourceIds: readonly string[], limit: number): Promise<Array<GitHoldListingRow<R>>>;
  /** Each listed source's current-incarnation holds counted per code, in no set order. */
  readGitHoldCodeCountRows(sourceIds: readonly string[]): Promise<Array<{ source_id: string; code: string | null; n: number }>>;
  /** Each listed source whose hold summary counts unsupported-image holds, with that count, in no set order. */
  readGitImageHoldCountRows(sourceIds: readonly string[]): Promise<Array<{ source_id: string; images: number }>>;
  /** The stored conversion log of each listed source's current incarnation, in no set order. */
  readSyncConversionRows<C = Record<string, unknown>>(sourceIds: readonly string[]): Promise<Array<{ source_id: string; conversions: C[] | null }>>;
  /** Puts the conversion first in the source incarnation's log, keeping the newest SYNC_CONVERSION_KEEP (SQL in engine-sql/sync-hold-store.ts). */
  recordSyncConversion(sourceId: string, incarnation: string, conversion: SyncConversion): Promise<void>;
  /** The managed sync pass row of one source incarnation, or null (SQL in engine-sql/sync-hold-store.ts). */
  readSyncPassRow<V = Record<string, unknown>>(sourceId: string, incarnation: string): Promise<SyncPassRowRead<V> | null>;
  /** The managed sync pass rows of the sources' live incarnations (null: every source), in no set order. */
  readLiveSyncPassRows<V = Record<string, unknown>>(sourceIds: readonly string[] | null): Promise<Array<SyncPassRowRead<V> & { source_id: string }>>;
  /** Writes the managed sync pass row under its lease fence; false when it did not land (persistence/sync-pass-row.ts writePassRow). */
  writeSyncPassRow(sourceId: string, incarnation: string, value: { lease_token?: unknown }, opts?: SyncPassRowWrite): Promise<boolean>;
  /** `sync status`'s source read of one live source: the row, its pass row and withheld record, the admission setting and probes (SQL in engine-sql/sync-status-reads.ts). */
  readSyncStatusSourceRow<P = Record<string, unknown>, W = Record<string, unknown>, F = Record<string, unknown>>(sourceId: string): Promise<SyncStatusSourceRow<P, W, F> | null>;
  /** `sync status`'s committed read: managed-sync pages committed in the last ten minutes, the push and fence hold probes and the newest managed-sync commit. */
  readSyncStatusCommittedRow(sourceId: string): Promise<SyncStatusCommittedRow>;
  /** The newest managed-sync cursor of a source incarnation, the one keyed `failedKey` first; null when none. */
  readManagedSyncCursorHeader<H = Record<string, unknown>>(sourceId: string, incarnation: string, failedKey: string): Promise<{ header: H; key: string } | null>;
  /** The oldest unfinished managed-sync cursor of the source under another incarnation; null when none. */
  readRetiredManagedSyncCursor(sourceId: string, incarnation: string): Promise<{ first_seen: string } | null>;
  /** The unfinished managed-sync cursors of the listed sources (null: every source) with their receipts, failures and paths. */
  readManagedSyncFailureRows<V = Record<string, unknown>, R = Record<string, unknown>, F = Record<string, unknown>>(sourceIds: readonly string[] | null): Promise<Array<ManagedSyncFailureRow<V, R, F>>>;
  /** The commit targets of a worktree's freshness samples (committed managed-sync imports in the window), newest first, at most `limit`. */
  listFreshnessTargets(worktreeId: string, incarnation: string, windowHours: number, limit: number): Promise<string[]>;
  /** The recorded managed-sync failures of the listed sources (null: every source) whose cursor row is gone. */
  readOrphanedManagedSyncFailureRows<F = Record<string, unknown>>(sourceIds: readonly string[] | null): Promise<Array<{ failure: F }>>;
  /** The drain's head probe: the source binding's head unfinished request, or null. */
  readSyncHeadRequestRow(sourceId: string, opts?: SyncStatusProbeOptions): Promise<SyncHeadRequestRow | null>;
  /** How many of the source's requests hold a publication recovery record, and the first. */
  readSyncRecoveryProbeRow(sourceId: string, opts?: SyncStatusProbeOptions): Promise<SyncRecoveryProbeRow>;
  /** The open identity-downgrade records of the listed sources (null: every source), oldest first, with the live slugs at each new path. */
  readIdentityDowngradeRows<D = Record<string, unknown>>(sourceIds: readonly string[] | null): Promise<Array<{ record: D | string; new_slugs: string[] | null }>>;
  /** The soft-deleted page an identity-downgrade record names (by recorded path, else slug), most recently deleted first, or null. */
  readIdentityDowngradeOldPage(sourceId: string, path: string, slug: string): Promise<IdentityDowngradeOldPage | null>;
  /** What an old page carries into a downgrade record: the source's facts about the slug, the page's links and the slug's aliases. */
  countIdentityDowngradeCarry(sourceId: string, slug: string, pageId: number): Promise<IdentityDowngradeCarry>;
  /** One page of the source by id or slug, deleted or not, as the identity remedy binds it, or null. */
  readIdentityRemedySide(sourceId: string, by: { pageId: number } | { slug: string }): Promise<IdentityRemedySideRow | null>;
  /** A source's sync point and pending write requests, for the applied watermark (SQL in engine-sql/applied-watermark-reads.ts). */
  readWriteWatermarkRow(sourceId: string): Promise<WriteWatermarkRow>;
  /** One source binding's movement rows for readSourceMovement: the managed-sync watermark, the head request and the hold summary. */
  readSourceMovementRows(binding: SourceMovementBinding): Promise<SourceMovementRows>;
  /** The id of the active `sync` job with a live lock that drains the source, or null. */
  readLiveSyncJobId(sourceId: string): Promise<number | null>;
  /** A source's incarnation and its checkout on host `hostId` (else the source's path); null when absent. */
  readSourceCheckoutRoot(sourceId: string, hostId: string | null): Promise<SourceCheckoutRoot | null>;
  /** The source's pages still waiting for an embedding in `column`: count, oldest edit, budget-held count. */
  readUnembeddedPageSummary(sourceId: string, column: string): Promise<UnembeddedPageSummary>;
  /** publishGeneration's producer-path statements: held rows of one input, a held row's context, the identical replay, the attempt counter and the valve. */
  heldGenerationRowsForInput(key: GenerationRowKey, pin: string): Promise<HeldInputRow[]>;
  readHeldGenerationContext(key: GenerationRowKey, holdId: string): Promise<{ held_context: Record<string, unknown> | null } | null>;
  liveGenerationForOperation(operationId: string): Promise<number | null>;
  countGenerationAttempt(key: GenerationRowKey, holdId: string, code: string): Promise<GenerationAttemptCount>;
  clearGenerationAttempts(holdId: string): Promise<void>;
  /** The consolidation ledger statements of generations/adapters/fact-rows.ts: whether a key's live row is a restore, and the clear of one entity's `tie` holds (`ownerPrefix` is compared over its JavaScript length). */
  readGenerationRestored(key: GenerationRowKey): Promise<boolean>;
  clearTieHeldGenerationRows(sourceId: string, kind: string, ownerPrefix: string): Promise<void>;
  readGenerationValve(key: GenerationRowKey, windowKey: string): Promise<GenerationValveRow>;
  bumpGenerationValve(key: GenerationRowKey, windowKey: string, retired: number): Promise<void>;
  /** The purge scrub of the generation ledger (generations/ledger-scrub.ts, engine-sql/generation-ledger.ts): one page's rows, or every row whose text carries a needle. */
  scrubGenerationPageRows(sourceId: string, fenceKinds: readonly string[], slug: string): Promise<LedgerScrubCounts>;
  scrubGenerationTextRows(sourceId: string, needles: readonly string[]): Promise<LedgerScrubCounts>;
  /** The managed activation rows of generations/managed.ts (engine-sql/generation-activations.ts): record, flip, member gate, settle and the two operator lists. */
  recordGenerationActivation(key: GenerationRowKey, row: GenerationActivationRecord): Promise<void>;
  markGenerationActivated(activationId: string, generationId: number): Promise<void>;
  readGenerationActivationState(activationId: string, slug: string, sourceId: string): Promise<GenerationActivationState | null>;
  settleGenerationMember(activationId: string, slug: string): Promise<void>;
  listPendingGenerationMembers(sourceIds: readonly string[], kind: string | null): Promise<PendingGenerationMemberRow[]>;
  listGenerationOrphanCandidates(sourceIds: readonly string[], kind: string | null): Promise<GenerationOrphanRow[]>;
  /** The reads of gbrain repair generations (engine-sql/generation-repair.ts); the three lists take the typed selector filter. */
  readGenerationItemsByIds(generationIds: readonly number[]): Promise<GenerationRepairItemRow[]>;
  listUnmatchedGenerationRows(sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter): Promise<UnmatchedGenerationRow[]>;
  listRestorableGenerationRows(sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter): Promise<RestorableGenerationRow[]>;
  listHeldGenerationRows(sourceIds: readonly string[], kind: string, filter: GenerationRepairFilter): Promise<HeldGenerationListRow[]>;
  readHeldGenerationProposal(id: number): Promise<HeldGenerationProposalRow | null>;
  /** The incarnation of each known source of `sourceIds` as text, in id order (the preview hash of a repair binds it). */
  listGenerationSourceIncarnations(sourceIds: readonly string[]): Promise<SourceIncarnationListRow[]>;
  /** The fence evidence statements of generations/fence-evidence.ts (engine-sql/generation-fence-evidence.ts, #8819). */
  listRecordedFenceItemKeys(key: GenerationRowKey, itemKeys: readonly string[]): Promise<Array<{ item_key: string }>>;
  hasBodylessPageVersion(sourceId: string, slug: string): Promise<boolean>;
  listFenceVersionBodies(sourceId: string, slug: string, before: number | null, limit: number): Promise<FenceVersionBodyRow[]>;
  moveKeptFactRows(sourceId: string, slug: string, ids: readonly number[], claimed: readonly number[]): Promise<void>;
  /** The fence restore reads of generations/fence-restore.ts (engine-sql/generation-fence-restore.ts). */
  readGenerationFenceBlocks(generationIds: readonly number[]): Promise<GenerationFenceBlockRow[]>;
  listOwnedGenerationItems(generationIds: readonly number[]): Promise<GenerationOwnedItemRow[]>;
  readLiveGenerationId(key: GenerationRowKey): Promise<{ id: number | string } | null>;
  /** The page rows a page generation adapter reads, deleted rows included, by slug (engine-sql/generation-page-rows.ts). */
  readGenerationPageRows(query: GenerationPageRowsQuery): Promise<GenerationPageRow[]>;
  /**
   * The Life Chronicle event statements (engine-sql/chronicle-events.ts): the depth page row, the ledger's owned event
   * hashes and skip decisions, the chronicle items a generation retired or holds live, the event projection rows (read,
   * deleted, restored), page content hashes and event slot fields, and the live generations whose depth page is gone.
   */
  readChronicleDepthRow(sourceId: string, slug: string): Promise<ChronicleEventsSql.ChronicleDepthRow | null>;
  listChronicleOwnedHashes(sourceId: string, pageId: number): Promise<string[]>;
  listRetiredGenerationItemKeys(sourceId: string, kind: string, itemKeys: readonly string[]): Promise<string[]>;
  listEventProjectionRows(eventPageIds: readonly number[]): Promise<ChronicleEventsSql.EventProjectionRow[]>;
  listPageContentHashes(query: ChronicleEventsSql.PageContentHashQuery): Promise<ChronicleEventsSql.PageContentHashRow[]>;
  listLiveGenerationItems(key: GenerationRowKey): Promise<Array<{ item_key: string; identity_hash: string }>>;
  readEventProjectionId(eventPageId: number, date: string): Promise<number | null>;
  pageSlugExists(sourceId: string, slug: string): Promise<boolean>;
  deleteEventProjections(sourceId: string, slugs: readonly string[]): Promise<void>;
  restoreEventProjection(row: ChronicleEventsSql.EventProjectionRestore): Promise<void>;
  hasChronicleSkipDecision(decision: ChronicleEventsSql.ChronicleSkipDecision): Promise<boolean>;
  listOrphanedChronicleOwners(sourceId: string, kind: string, limit: number): Promise<string[]>;
  listChronicleEventSlotRows(sourceId: string, slugs: readonly string[]): Promise<ChronicleEventsSql.ChronicleEventSlotRow[]>;
  /** The chronicle advisor's coverage-gap read: recent chronicle-shaped pages that no event projection covers yet. */
  listChronicleCoverageGapRows(): Promise<ChronicleEventsSql.ChronicleCoverageGapRow[]>;
  /** The atom adapter's reads (engine-sql/generation-atom-reads.ts): a live page origin's input pin, the stored versions a producer wrote, committed managed atom receipts. */
  readAtomOriginInput(sourceId: string, slug: string): Promise<AtomOriginInputRow | null>;
  listProducerVersionRows(sourceId: string, slugs: readonly string[], producer: GenerationVersionProducer): Promise<ProducerVersionRow[]>;
  listAtomWriteReceipts(sourceId: string, slugs: readonly string[]): Promise<AtomWriteReceiptRow[]>;
  /** The request a principal admitted under `requestId` (a uuid), or null. */
  readWriteRequest(principalKind: string, principalId: string, requestId: string): Promise<WriteRequest | null>;
  /** The requests a principal admitted under any of `requestIds` (uuids), in no order (a grouped admission's replays). */
  readWriteRequestsByRequestIds(principalKind: string, principalId: string, requestIds: readonly string[]): Promise<WriteRequest[]>;
  /** At most two requests with this request_id (a uuid), from any principal, in no set order. */
  readWriteRequestsByRequestId(requestId: string): Promise<WriteRequest[]>;
  /** The request with journal id `id`, or null; `signal` cancels the read. */
  readWriteRequestById(id: string, opts?: { signal?: AbortSignal }): Promise<WriteRequest | null>;
  /** The requests admitted under any of the client request ids `requestIds` (uuids), any principal. */
  listWriteRequestsByRequestIds(requestIds: readonly string[]): Promise<WriteRequest[]>;
  /** A principal's requests in one live source, newest sequence first, through the cursor and fences (list_write_requests). */
  listWriteRequestRows(principalKind: string, principalId: string, sourceId: string, filter: WriteRequestListFilter): Promise<WriteRequest[]>;
  /** The progress columns of request `id` (state, error, outcome, deferral), or null; `signal` cancels the read. */
  readWriteRequestProgress(id: string, opts?: { signal?: AbortSignal }): Promise<WriteRequestProgress | null>;
  /** The sources holding outstanding (queued, deferred, running, recovering) requests of one principal, as `{ source_id, n }`: the most first, a tie in byte order of the source id. */
  countOutstandingBySource(principalKind: string, principalId: string): Promise<OutstandingBySource[]>;
  /** Inside the admission transaction: the managed worktree row (share-locked), its active refresh (locked with `lockRefresh`) and whether the source binding holds (engine-sql/persistence-admission.ts). */
  readWorktreeAdmission(key: WorktreeAdmissionKey, opts?: { lockRefresh?: boolean }): Promise<WorktreeAdmission>;
  /** Completes a `syncing` refresh whose member sources all reached its target head; true when it did. */
  completeSyncedRefresh(refreshId: string): Promise<boolean>;
  /** Whether every consumer renewed within `liveMs` on the worktree's owner host advertises `capability`. */
  hasDeferralRoom(worktreeId: string, capability: string, liveMs: number): Promise<boolean>;
  /** How long refresh `refreshId` has run and its worktree's typical refresh duration, or null when it does not exist. */
  readRefreshTiming(refreshId: string): Promise<RefreshTiming | null>;
  /** The deferred writes (of one principal, or all) held behind a source's managed sync, and their intent bytes. */
  countHeldBehindImport(sourceId: string, principal: { kind: string; id: string } | null): Promise<{ count: number; bytes: number }>;
  /** Whether this connection's role owns the gbrain tables (so it can apply migrations); false only when it provably does not. */
  ownsSchemaTables(): Promise<boolean>;
  /** The live grant row of the OAuth client that owns a write, or null; `lock` holds it FOR SHARE so a revocation waits. */
  readOAuthClientWriteGrant(clientId: string, opts?: { lock?: boolean }): Promise<OAuthClientWriteGrant | null>;
  /** The live grant row of the legacy token that owns a write (the token grant columns this brain has, and revoked_at), or null; `lock` as above. */
  readAccessTokenWriteGrant(tokenId: string, opts?: { lock?: boolean }): Promise<AccessTokenWriteGrant | null>;
  /** Holds the OAuth client or legacy token row FOR SHARE for the caller's transaction (a missing row locks nothing). */
  shareLockWriteCredential(kind: 'oauth_client' | 'legacy_token', id: string): Promise<void>;
  /** The existing counter rows of `keys` in key byte order, without a lock (a missing key has no row). */
  readCounterRows(keys: readonly string[]): Promise<CounterRow[]>;
  /** The brain's first request id and a sample of the latest 1,000 admissions (one principal's, or the brain's): count, age of the oldest, mean reservation, mean compacted size. `{ sample: false }` reads only the first request id. */
  readAdmissionRate(principal: { kind: string; id: string } | null, opts?: { sample?: boolean }): Promise<AdmissionRate>;
  /** Creates the missing counter rows and locks them all FOR UPDATE in key order; returns the locked rows. */
  lockPersistenceCounters(keys: readonly string[]): Promise<CounterRow[]>;
  /** Adds `delta` to counter row `key`'s columns (an absent column adds 0); a sum below zero refuses (engine-sql/writer-release.ts). */
  addPersistenceCounters(key: string, delta: Partial<Record<CounterColumn, number>>): Promise<void>;
  /** Inserts an admitted request and charges its (already locked) counters; returns the stored row. */
  insertWriteRequest(row: WriteRequestInsert): Promise<WriteRequest>;
  /** Inserts a grouped admission's page requests in item order and charges their (already locked) counters; returns the stored rows. */
  insertWriteRequestGroup(group: WriteRequestGroupInsert): Promise<WriteRequest[]>;
  /** The owner host's checkout path of worktree `worktreeId` (its host binding's `local_path`), or null without an owner or a binding. */
  readOwnerHostBinding(worktreeId: string): Promise<string | null>;
  /** Stamps a claim (running, token, lease, first phase) on request `id`; null when the refresh barrier refused it. */
  stampWriteClaim(id: string, token: string, leaseMs: number, phaseJson: string, opts?: FenceOpts): Promise<ClaimedWriteRow | null>;
  /** Request `id` locked FOR UPDATE until the transaction ends, or null. */
  lockWriteRequest(id: string): Promise<WriteRequest | null>;
  /** Records a request's terminal state and releases its counters; null when the result exceeds its reservation. */
  completeWriteRow(completion: WriteCompletion): Promise<CompletedWriteRow | null>;
  /** The requests with these ids, locked FOR UPDATE until the transaction ends, in id order (a purge's cancel of the writes holding a staging). */
  lockWriteRequestsById(ids: readonly string[]): Promise<WriteRequest[]>;
  /** Drops a terminal request's intent that carried purged content and shrinks its reservation (journal.ts finishTerminal); null for an unknown id. */
  compactTerminalIntent(compaction: TerminalIntentCompaction): Promise<WriteRequest | null>;
  /** Cancels a request still queued as the caller read it, in one step: lock, check, complete, release its counters; null when it does not exist. */
  cancelWriteRow(cancel: WriteCancellation): Promise<WriteCancelResult | null>;
  /** Inserts a publication's effects in queue order (a gated one only while auto-linking is on); returns the kinds inserted. */
  insertPublicationEffects(spec: PublicationEffectsSpec): Promise<string[]>;
  /** Queues a managed-request withdrawal's three effects for its source; an unknown source queues none, a kind already queued is kept. */
  insertWithdrawalEffects(spec: WithdrawalEffectsSpec): Promise<void>;
  /** `gbrain repair segmented-mirror`: queues a re-mirror's `withdrawal-mirror` and `git` effects for request row `requestId` (engine-sql/segmented-mirror-effects.ts); run it in the re-mirror's write transaction. */
  insertRemirrorEffects(requestId: string, sourceId: string, data: Record<string, unknown>): Promise<void>;
  /** `gbrain repair segmented-mirror`: the effects of request row `requestId` the apply waits on, in kind order. */
  readRemirrorEffects(requestId: string): Promise<import('../engine-sql/segmented-mirror-effects.ts').RemirrorEffectState[]>;
  /** The withdrawal overlay's `*` purges: the source's subject-`*` purges of claim fingerprints `hashes` as withdrawals, world rows only when `worldOnly` (page-state/snapshot.ts overlayCanonicalBodiesTyped). */
  listGlobalPurgeWithdrawals(sourceId: string, hashes: readonly string[], worldOnly: boolean): Promise<import('../page-state/types.ts').PageWithdrawal[]>;
  /** The first record of each `op` checkpoint naming one of `sourceIds` as `source_id` (all when null), in fingerprint byte order (engine-sql/fence-repair-records.ts). */
  listSourceCheckpointRecords<R>(op: string, sourceIds: readonly string[] | null): Promise<import('../engine-sql/fence-repair-records.ts').SourceCheckpointRecord<R>[]>;
  /** Stores the checkpoint parent when none exists; true when this call stored it (the fence repair attempt store's claim). */
  insertOpCheckpointIfAbsent(op: string, fingerprint: string, completedKeys: readonly unknown[]): Promise<boolean>;
  /** Replaces the parent's records only while its first record's `v` is `expected`; true when this call replaced them. */
  replaceOpCheckpointAtVersion(op: string, fingerprint: string, completedKeys: readonly unknown[], expected: number): Promise<boolean>;
  /** Stores the sync run's fence trend row, or rewrites it keeping the `day` of its first write (the sync run's total counts once). */
  upsertFenceTrendRunRecord(op: string, fingerprint: string, record: unknown): Promise<void>;
  /** The earliest `held_at` of the sources' Git sync holds with hold code `code`, or null (the fences and slug-conflicts verification). */
  readOldestSyncHoldAt(code: string, sourceIds: readonly string[]): Promise<string | null>;
  /** The daily budget ledger (budget/daily-ledger.ts): releases expired held reservations and settles expired dispatched ones at their estimate (engine-sql/budget-ledger-writes.ts). */
  reclaimBudgetReservations(key: import('../engine-sql/budget-ledger-writes.ts').BudgetLedgerKey, nowIso: string): Promise<{ released: number; uncertain: number }>;
  /** Holds a reservation when the day stays within its cap; true when held. */
  reserveBudgetReservation(key: import('../engine-sql/budget-ledger-writes.ts').BudgetLedgerKey, spec: import('../engine-sql/budget-ledger-writes.ts').BudgetReservationSpec): Promise<boolean>;
  /** Marks a held, unexpired reservation dispatched; true when it was. */
  dispatchBudgetReservation(key: import('../engine-sql/budget-ledger-writes.ts').BudgetLedgerKey, id: string, nowIso: string): Promise<boolean>;
  /** Settles a reservation at `actual` and moves the day's totals; the row the protocol reads, or null. */
  settleBudgetReservation(key: import('../engine-sql/budget-ledger-writes.ts').BudgetLedgerKey, id: string, actual: string): Promise<import('../engine-sql/budget-ledger-writes.ts').BudgetSettleRow | null>;
  /** Releases a held reservation and frees its estimate; true when released. */
  releaseBudgetReservation(key: import('../engine-sql/budget-ledger-writes.ts').BudgetLedgerKey, id: string): Promise<boolean>;
  /** The secret store (GST-2988; engine-sql/secret-store.ts): the entry id that holds this (source, value MAC), or null. */
  findSecretEntryByMac(sourceId: string, mac: string): Promise<string | null>;
  /** Whether a secret store entry has this id. */
  secretEntryExists(id: string): Promise<boolean>;
  /** Writes one sealed entry (ciphertext and MAC as given); the id when written, null when the conflict clause skipped it. */
  insertSecretEntry(row: import('../engine-sql/secret-store.ts').SecretEntryInsert, conflict: import('../engine-sql/secret-store.ts').SecretEntryConflict): Promise<string | null>;
  /** Records where a marker was put. */
  insertSecretOccurrence(o: import('../engine-sql/secret-store.ts').SecretOccurrenceInsert): Promise<void>;
  /** One entry as stored (never a value), or null. */
  readSecretEntry(id: string): Promise<import('../engine-sql/secret-store.ts').SecretEntryRow | null>;
  /** The recorded places of one entry, in recording order. */
  listSecretOccurrences(entryId: string): Promise<import('../engine-sql/secret-store.ts').SecretOccurrenceRow[]>;
  /** Entries with their occurrence counts and slugs, oldest first. */
  listSecretEntrySummaries(filter: { sourceId: string | null; slug: string | null; limit: number }): Promise<import('../engine-sql/secret-store.ts').SecretEntrySummaryRow[]>;
  /** Entries and occurrences per rule. */
  countSecretsByRule(sourceId: string | null): Promise<Array<{ rule: string; entries: number; occurrences: number }>>;
  /** The key and MAC of every restored (allowed) value: of one source, or of every source in key order. */
  listAllowedSecretMacs(sourceId: string | null): Promise<import('../engine-sql/secret-store.ts').SecretAllowedMac[]>;
  /** Key ids entries were sealed with, by host. */
  listSecretKeysInUse(): Promise<import('../engine-sql/secret-store.ts').SecretKeyInUse[]>;
  /** Every entry and occurrence row, from one snapshot (an encrypted backup's input). */
  readSecretStoreSnapshot(): Promise<{ entries: import('../engine-sql/secret-store.ts').SecretBackupEntryRow[]; occurrences: import('../engine-sql/secret-store.ts').SecretBackupOccurrenceRow[] }>;
  /** Writes a backed-up entry unless its id or (source, value) is held, for a source this brain has; true when written. */
  insertBackupSecretEntry(row: import('../engine-sql/secret-store.ts').SecretBackupEntryRow): Promise<boolean>;
  /** Whether the row under `id` holds this (source, value MAC): null when no row has the id. */
  readBackupEntryHold(id: string, sourceId: string, mac: string): Promise<boolean | null>;
  /** Writes a backed-up occurrence once, on the page holding `pageId` (or at its slug); true when written. */
  insertBackupSecretOccurrence(o: import('../engine-sql/secret-store.ts').SecretBackupOccurrenceRow, pageId: number | null): Promise<boolean>;
  /** Deletes an entry no occurrence references; true when it did. */
  deleteUnreferencedSecretEntry(id: string): Promise<boolean>;
  /** The pages of the source at these slugs, each with whether its inline stores hold entry `id`'s marker. */
  listSecretHoldingPages(sourceId: string, slugs: readonly string[], id: string): Promise<import('../engine-sql/secret-store.ts').SecretHoldingPageRow[]>;
  /** Entries no occurrence references (doctor). */
  countUnreferencedSecretEntries(): Promise<number>;
  /** `gbrain secrets restore` preview: the live page's revision and whether it still holds the marker; null without a live page. */
  readRestorePageHit(sourceId: string, slug: string, marker: string): Promise<import('../engine-sql/secret-store.ts').RestorePageHit | null>;
  /** Marks an entry restored (allowed). */
  markSecretEntryAllowed(id: string): Promise<void>;
  /** `gbrain repair secret-spans` (engine-sql/secret-spans-rows.ts): the live page at (source, slug) as a redaction reads it, or null. */
  readPageRedactionRow(sourceId: string, slug: string): Promise<import('../engine-sql/secret-spans-rows.ts').PageRedactionRow | null>;
  /** The timeline rows, facts, takes, link contexts and raw data of a page, each in id order. */
  readPageRedactionRows(pageId: number, sourceId: string, slug: string): Promise<import('../engine-sql/secret-spans-rows.ts').PageRedactionRows>;
  /** Every timeline row of the pages whose rows belong to page `pageId`. */
  listTimelineDedupRows(pageId: number): Promise<import('../engine-sql/secret-spans-rows.ts').TimelineDedupRow[]>;
  /** The page's retained versions in id order. */
  listVersionBodiesForRedaction(pageId: number): Promise<import('../engine-sql/secret-spans-rows.ts').RetainedVersionBody[]>;
  /** The number of retained versions of a page. */
  countPageVersionRows(pageId: number): Promise<number>;
  /** Rewrites a retained version's text and frontmatter. */
  setRetainedVersionBody(pageId: number, id: number, compiledTruth: string | null, frontmatter: unknown): Promise<void>;
  /** Every stored chunk row of a page (staged and retired included): ids and texts for a rewrite, texts alone for the residual scan. */
  listChunkTextsForRedaction(pageId: number, purpose: 'rewrite' | 'scan'): Promise<import('../engine-sql/secret-spans-rows.ts').ChunkTextRow[]>;
  /** Deletes chunk rows by id. */
  deleteChunksByIds(pageId: number, ids: readonly number[]): Promise<void>;
  /** Rewrites the page row's text fields and content hash. */
  setRedactedPageFields(pageId: number, fields: import('../engine-sql/secret-spans-rows.ts').RedactedPageFields): Promise<void>;
  /** The data of one raw data row, named by (page, id). */
  readRawDataValue(pageId: number, id: number): Promise<unknown>;
  /** Replaces the data of one raw data row. */
  setRawDataValue(pageId: number, id: number, data: unknown): Promise<void>;
  /** Rewrites one text column of a timeline, fact, take or link row (a fact or take loses its embedding). */
  setRedactedRowText(pageId: number, store: import('../engine-sql/secret-spans-rows.ts').RedactedRowStore, id: number, column: string, text: string): Promise<void>;
  /** The twin merge: drops the twin's colliding derived links and transitions and moves the rest onto the survivor, with the relationship keys before and after (engine-sql/twin-merge-moves.ts). Run it in the merge's transaction. */
  moveTwinRelationships(ids: import('../engine-sql/twin-merge-moves.ts').TwinMergeIds): Promise<import('../engine-sql/twin-merge-moves.ts').TwinRelationshipMoves>;
  /** The twin merge: moves the twin's timeline rows and events, raw data, user-added tags, files and free-text aliases to the survivor; the tags moved. */
  moveTwinPageChildren(move: import('../engine-sql/twin-merge-moves.ts').TwinPageChildrenMove): Promise<string[]>;
  /** The twin merge: rekeys the facts other pages assert about the twin's slug to the survivor's; the moved fact ids. */
  moveTwinFacts(sourceId: string, twinSlug: string, survivorSlug: string): Promise<number[]>;
  /** Records `oldSlug -> newSlug` in the rename history and the slug aliases for a page renamed or merged into another (engine-sql/rename-alias-rows.ts; page-state/rename-alias.ts is the wrapper). Run it in the caller's transaction; the same slug records nothing. */
  recordRenameAlias(sourceId: string, oldSlug: string, newSlug: string): Promise<void>;
  /** The moved-pages fold: moves every page version of `fromPageId` to `toPageId`; the moved version ids in id order. */
  movePageVersions(fromPageId: number, toPageId: number): Promise<number[]>;
  // Write-claim statements (engine-sql/persistence-claims.ts): the text journal.ts, authority.ts and consumer.ts sent through executeRaw.
  /** A source's incarnation and archive flag, or null; `lock` reads it FOR SHARE (`'update'`: FOR UPDATE) until the transaction ends. */
  readSourceMembership(sourceId: string, opts?: { lock?: boolean | 'update' }): Promise<SourceMembership | null>;
  /** `[{ request_id }]` for the first of `requestIds` a topology change of local writer `principalId` used, or []. */
  findTopologyChanges(principalId: string, requestIds: string[]): Promise<Array<{ request_id: string }>>;
  /** The digest a topology change with this request id recorded for this source, or null (the `sources add` replay). */
  readTopologyChangeDigest(requestId: string, sourceId: string): Promise<string | null>;
  /** The topology changes with a recovery whose worktree host `hostId` owns, after change id `after`, in id order, at most `limit`. */
  listTopologyRecoveries(hostId: string, after: string | null, limit: number): Promise<TopologyChange[]>;
  readTopologyChange(principalId: string, requestId: string): Promise<TopologyChange | null>;
  insertTopologyChange(row: TopologyChangeInsert): Promise<TopologyChange>;
  /** Extends a claim's lease (and records its phase); true while the request is running under the token. Postgres sends it on the direct pool. */
  renewWriteClaim(renewal: ClaimRenewal, opts?: { signal?: AbortSignal }): Promise<boolean>;
  /** Returns a claim that never began to publish to queued under its token; `direct` sends it on the Postgres direct pool. */
  releaseUnpublishedClaim(release: ClaimRelease, opts?: { direct?: boolean }): Promise<void>;
  /** Returns expired claims and claims of dead owners to queued, at most 100; `direct` sends it on the Postgres direct pool. */
  expireStaleWriteClaims(expiry: ClaimExpiry, opts?: { signal?: AbortSignal; direct?: boolean }): Promise<void>;
  /** Whether a claim would find a row now; `priority` overrides the foreground-priority config row when set. */
  hasClaimableWrite(hostId: string, excludeRoots: string[], opts?: { priority?: boolean | null; signal?: AbortSignal }): Promise<boolean>;
  /** Head-blocker probe rows (engine-sql/head-blocker.ts): for each queued request in `ids`, whether a consumer on `hostId` may claim it and the facts naming why not. */
  readHeadBlockerRows(ids: readonly string[], hostId: string | null, opts?: HeadBlockerReadOpts): Promise<HeadBlockerRow[]>;
  /** A recovering head's recovery record and its worktree's owner host, or null when it has no recovery record or no worktree. */
  readRecoveringHeadRow(id: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RecoveringHeadRow | null>;
  /** The request id of a receipt that blocks a managed sync run's checkpoint on a worktree, or null (engine-sql/checkpoint-validation.ts); the 57014 timeout stays with the caller. */
  readIncompleteSyncReceipt(spec: IncompleteSyncReceiptSpec): Promise<string | null>;
  /** The request id of the work that blocks a pass stamp on a worktree (a recovery row, or another open managed-sync request), or null. */
  readOpenPassWork(spec: OpenPassWorkSpec): Promise<string | null>;
  /** Every receipt (up to 20, in sequence order) that would block the run's checkpoint now, with what `sync status` shows. */
  readIncompleteSyncReceiptRows(spec: IncompleteSyncReceiptSpec): Promise<IncompleteSyncReceiptRow[]>;
  /** The request a FIFO claim takes next, locked FOR UPDATE SKIP LOCKED until the transaction ends, or null (journal.ts `claimNextWrite`). */
  selectClaimableWrite<R = Record<string, unknown>>(spec: ClaimHeadSpec): Promise<R | null>;
  /** Consumer rows (persistence/consumer-heartbeat.ts): the host's rows oldest first, and its live full rows other than the caller's. `direct`: the Postgres direct pool. */
  listHostConsumerRows(hostId: string, opts?: { signal?: AbortSignal; direct?: boolean }): Promise<ConsumerRowRead[]>;
  probeLiveConsumerRows(probe: ConsumerProbe, opts?: { signal?: AbortSignal; direct?: boolean }): Promise<ConsumerRowRead[]>;
  /** The heartbeat's renewal (purges the host's lapsed rows), its row delete and its worktree stamp; Postgres sends each on the direct pool. */
  renewConsumerRow(renewal: ConsumerRenewal, opts?: { signal?: AbortSignal }): Promise<void>;
  deleteConsumerRow(key: ConsumerRowKey, opts?: { signal?: AbortSignal }): Promise<void>;
  stampWorktreeHeartbeats(hostId: string, opts?: { signal?: AbortSignal }): Promise<void>;
  // Housekeeping statements (engine-sql/persistence-housekeeping.ts): the text housekeeping-turn.ts, compaction-pass.ts, journal.ts,
  // receipt-true-up.ts, capacity-forecast.ts and the projection queue readers sent through executeRaw after a write.
  /** Leases this host's housekeeping turn; true when it was free. `direct` sends it on the Postgres direct pool. */
  claimHousekeepingTurn(claim: HousekeepingTurnClaim, opts?: { signal?: AbortSignal; direct?: boolean }): Promise<boolean>;
  /** Marks this host's leased housekeeping turn finished. `direct` sends it on the Postgres direct pool. */
  completeHousekeepingTurn(turn: { op: string; hostId: string }, opts?: { direct?: boolean }): Promise<void>;
  /** The explicit receipt retention (null when unset), the brain's reserved terminal bytes and now minus `floorDays`, as text. */
  readReceiptBudget(retentionKey: string, floorDays: number): Promise<ReceiptBudget>;
  /** Up to 100 compactable receipts completed over `retentionDays` ago, oldest first, without unresolved caller refusals or open-sync rows. */
  listCompactableReceipts<R = Record<string, unknown>>(retentionDays: number): Promise<R[]>;
  /** `repair receipt-compaction`'s window: now minus `hours` as a UTC ISO time with microseconds, and the newest request sequence (null when none). */
  readReceiptCompactionWindow(hours: number): Promise<ReceiptCompactionWindow>;
  /** The settled, unrecovered, uncompacted receipts in `states` completed before `cutoff` up to `maxSequence`, oldest first, without open-sync rows or each worktree's newest sync receipt. */
  listReceiptCompactionCandidates(states: readonly string[], cutoff: string, maxSequence: string): Promise<ReceiptCompactionCandidate[]>;
  /** How many failed, conflicted or cancelled receipts completed before `cutoff` are still uncompacted and unrecovered. */
  countKeptFailedReceipts(cutoff: string): Promise<number>;
  /** `{ id, sequence, compacted }` of up to `limit` requests after sequence `after`, in sequence order. */
  listReservationsAfter(after: string, limit: number): Promise<Array<{ id: string; sequence: string; compacted: boolean }>>;
  /** The terminal requests among `ids` with their effect bytes and whether an effect is unfinished, in sequence order. */
  listTrueUpRequests<R = Record<string, unknown>>(ids: readonly string[]): Promise<R[]>;
  /** Inside the true-up's transaction, after its counter locks: shrinks each unchanged settled request to what its receipt keeps and releases the freed bytes from the counters; returns the bytes given back. */
  trueUpReservations(rows: readonly TrueUpReservation[]): Promise<number>;
  /** The capacity forecast's reads: counters, per-day principal and topology rows, history, reclaimable bytes and the table size. */
  readCapacityForecastInputs(opts?: { light?: boolean }): Promise<CapacityForecastInputs>;
  /** Pending segmented-page projection jobs ready to rebuild, oldest first. */
  listPendingSegmentedProjections(filter: SegmentedProjectionFilter): Promise<PendingSegmentedProjection[]>;
  /** The resident projection pass's window of pending jobs after `cursor`, with the high-water row last. */
  selectProjectionWindowJobs(cursor: Pick<ProjectionScanCursor, 'after' | 'highWater'>, retryCooldown: boolean): Promise<ProjectionWindowRow[]>;
  // The segmented projector's queue writes (page-body/projection.ts). `claim` is `segmented_projecting:<uuid>`, unique to one build.
  /** Claims the page's queued job unless another live claim holds it: `claimed`, `held`, or `absent` when the page has no job. */
  claimSegmentedProjection(ref: ProjectionPageRef, claim: string): Promise<SegmentedProjectionClaimOutcome>;
  /** Moves this build's claim to now, in the caller's transaction when it has one; false when the job no longer carries `claim`. */
  renewSegmentedProjectionClaim(ref: ProjectionPageRef, claim: string): Promise<boolean>;
  /** Puts a job that still carries `claim` back to `canonical_change`, so another build can take it. */
  releaseSegmentedProjectionClaim(ref: ProjectionPageRef, claim: string): Promise<void>;
  /** Deletes the job when it is still queued at `job.revision` (the page sealed at that revision). */
  deleteProjectionJob(job: ProjectionJobRef): Promise<void>;
  /** Marks a job still queued at `job.revision` and not under a live claim `rebuild_failed`, starting its retry window. */
  markProjectionRebuildFailed(job: ProjectionJobRef): Promise<void>;
  // Effect scans (engine-sql/persistence-effect-scans.ts): the reads the effect worker's pass sent through executeRaw.
  /**
   * Up to 100 requests on worktrees `hostId` owns whose failed withdrawal mirror is parked by `gateCode` and whose other
   * unsettled effects are parked only with a code in `allowedCodes` (`resumeGatedMirrors`). A non-uuid host id refuses.
   */
  listGatedMirrorRequests(hostId: string, gateCode: string, allowedCodes: readonly string[]): Promise<GatedMirrorRequest[]>;
  /**
   * Up to `limit` effects on worktrees `hostId` owns with a recovery due now, in id order after effect id `after` (from
   * the start when null) (`selectEffectRecoveries`). A non-uuid host, a non-bigint `after` or a negative limit refuses.
   */
  listEffectRecoveries<R = Record<string, unknown>>(hostId: string, after: string | null, limit: number): Promise<R[]>;
  /**
   * The next effect host `hostId` may claim, row-locked for the current transaction (rows another transaction holds are
   * skipped), or null; `deadOwners` are owner keys whose running effects are claimable now (`claimPersistenceEffect`).
   * A non-uuid host id refuses.
   */
  selectClaimableEffect<R = Record<string, unknown>>(hostId: string, deadOwners: readonly string[]): Promise<R | null>;
  /**
   * The effects of journal request `requestId` as its receipt reads them (state, error code, outcome, whether a recovery
   * is open), in kind order, or only its Git effect when `kind` is `'git'`. A non-uuid request id refuses.
   */
  readRequestEffects(requestId: string, kind?: 'git'): Promise<RequestEffectState[]>;
  /** Request row `id` of `sourceId` (`SELECT *`), or null (retryParkedEffects). A non-uuid id refuses. */
  readSourceRequestById<R = Record<string, unknown>>(sourceId: string, id: string): Promise<R | null>;
  /** At most two request rows of `sourceId` admitted under client request id `requestId`; two mean it is ambiguous. A non-uuid id refuses. */
  listSourceRequestsByRequestId<R = Record<string, unknown>>(sourceId: string, requestId: string): Promise<R[]>;
  /** The effects of request row `requestRowId` that a parked-effect retry tracks, by kind in byte order (`SELECT *`). */
  listRetryTrackedEffects<R = Record<string, unknown>>(requestRowId: string, parkedOnly: boolean, failedCodes: readonly string[]): Promise<R[]>;
  /** Effect `id` (`SELECT *`) locked FOR UPDATE until the transaction ends, or null. */
  lockEffectRow<R = Record<string, unknown>>(id: string | number): Promise<R | null>;
  /**
   * The stale queued and failed embedding effects of committed writes on `sourceIds` (or on a removed or replaced source
   * incarnation), in effect id order, leaving out a failed effect whose code is in `neverRetried`.
   */
  listEmbeddingCandidates(sourceIds: readonly string[], neverRetried: readonly string[]): Promise<EmbeddingCandidate[]>;

  // Owner scans (engine-sql/persistence-owner-scans.ts): the reads the write owner's housekeeping sent through executeRaw.
  /**
   * Up to 100 deferred writes on worktrees `hostId` owns whose `hold` (a refresh barrier, or an import that has not
   * landed) is past the wait limit `maxWaitMs`, in sequence order (`expireDeferredWrites`). A non-uuid host id refuses.
   */
  listOverdueHeldWrites<R = Record<string, unknown>>(hostId: string, maxWaitMs: number, hold: OverdueHoldKind, opts?: { signal?: AbortSignal }): Promise<R[]>;
  /**
   * Whether the hold an expiry scanned still stands, its row locked for the current transaction: the refresh still
   * unreleased, or the write still deferred on the same pending import and past its limit (`expireDeferredWrites`).
   */
  lockOverdueHold(hold: OverdueHold): Promise<boolean>;
  /**
   * The oldest recovering write of each worktree `hostId` owns that is not in `excluded`, at most 16 (the consumer's
   * recovery scan). `direct` takes the Postgres direct lane (the consumer passes `consumerOnDirectLane`). A non-uuid
   * host id refuses.
   */
  listOwnerRecoveryHeads<R = Record<string, unknown>>(hostId: string, excluded: readonly string[], opts?: { signal?: AbortSignal; direct?: boolean }): Promise<R[]>;
  /**
   * The interrupted refreshes of worktrees `hostId` owns that the owner's topology scan converges, at most 16, a
   * syncing row last; each carries `stale` (no move for `budgetMs`). A non-uuid host id refuses.
   */
  listResumableRefreshes<R = Record<string, unknown>>(hostId: string, budgetMs: number): Promise<(R & { stale: boolean })[]>;
  /** The last commit of each named source that exists (null before its first sync), in source id order (the refresh resume's lag check). */
  listSourceLastCommits(sourceIds: readonly string[]): Promise<{ last_commit: string | null }[]>;

  // Effect worker (engine-sql/persistence-effect-worker.ts): the claim stamp and the statements that settle a claim,
  // which effect-journal.ts sent through executeRaw. Each settle statement matches only effect `id` still claimed under
  // `token` (a null token matches none), so a claim that moved changes nothing.
  /** Claims effect `id` under `token` (running, a 2-minute lease, one more attempt): the claimed row, or null when no effect has the id. */
  stampEffectClaim<R = Record<string, unknown>>(claim: EffectClaim): Promise<R | null>;
  /**
   * Extends an effect claim's lease by 2 minutes; true while it is running under the token with no recovery. `direct`
   * runs it on the Postgres direct lane (`executeRawDirect`), outside any pooled transaction.
   */
  renewEffectClaim(claim: EffectClaimRef, opts?: { direct?: boolean }): Promise<boolean>;
  /** Requeues a claimed effect (no recovery) due now with its scan cursor at `slug` (`advanceEffectCursor`). */
  advanceEffectRow(claim: EffectClaimRef & { slug: string }): Promise<void>;
  /** Finishes a claimed effect (no recovery) with `outcomeJson`: committed, or failed `targets_parked` when it parked targets. */
  completeEffectRow(claim: EffectClaimRef & { outcomeJson: string }): Promise<void>;
  /** Requeues a claimed effect after `delayMs` with error code `reason`, a claim under recovery included. */
  retryEffectRow(claim: EffectClaimRef & { reason: string; delayMs: number }): Promise<void>;
  /** Requeues a claimed effect as `writer_busy` after `delayMs`, merging `dataJson` (the busy streak) into its data. */
  retryBusyEffectRow(claim: EffectClaimRef & { dataJson: string; delayMs: number }): Promise<void>;
  /** Requeues a claimed effect (no recovery) with data `dataJson`, error code `reason`, after `delayMs`. */
  requeueEffectRow(claim: EffectClaimRef & { dataJson: string; reason: string | null; delayMs: number }): Promise<void>;
  /** Fails a claimed effect (no recovery) as `targets_parked` with data `dataJson`. */
  parkEffectRow(claim: EffectClaimRef & { dataJson: string }): Promise<void>;
  /** Fails a claimed effect (no recovery) with error code `reason`. */
  failEffectRow(claim: EffectClaimRef & { reason: string }): Promise<void>;
  /** The withdrawal mirrors that gate these requests (`mirrorGates`): each not committed, or committed with its publications. */
  readMirrorGateRows(requestIds: readonly string[]): Promise<MirrorGateRow[]>;
  /**
   * The effect guard's locks (`guardEffectSource`): share-locks the brain row, then the effect's worktree row, and
   * returns that worktree's owner and state; null without a worktree id or when the worktree row is gone.
   */
  lockEffectGuard(worktreeId: string | null): Promise<EffectWorktreeOwner | null>;
  /** Whether one of these requests has a target parked under `code` that its committed withdrawal mirror re-arms (`hasRearmableTargets`). */
  hasRearmableTargets(requestIds: readonly string[], code: string): Promise<boolean>;
  /**
   * The persistence consumer's idle probe (`persistence-idle-probe.ts`): whether any worker a full tick fans out to has
   * work now, and where the resident projection window stands. Runs on `opts.lane` (the consumer's reserved idle lane)
   * when given, else on the Postgres direct lane when `opts.direct`, else on the engine; `opts.signal` cancels it.
   */
  probeIdleWork(spec: IdleProbeSpec, opts?: { signal?: AbortSignal; lane?: ReservedConnection; direct?: boolean }): Promise<IdleProbeRow | null>;

  // No-op embedding settle (engine-sql/persistence-embedding-noop-settle.ts): the statements embedding-noop-settle.ts
  // sends to settle, in bulk, queued page embedding effects whose chunks already carry current vectors. The caller
  // runs the last three in one transaction and keeps the source guard, the cursor and the true-up.
  /** Whether an unattempted queued embedding effect lies past effect id `from` (`probeNoopEmbeddingSettle`). */
  probeNoopEmbeddingSettle(from: string): Promise<boolean>;
  /** The newest effect id, then the next `limit` unattempted embedding effects past `from`, locked skip-locked (`lockNoopEmbeddingWindow`). */
  lockNoopEmbeddingWindow(spec: { from: string; limit: number }): Promise<NoopSettleWindow>;
  /** The window effects the runner would find nothing to embed for, before their source guard; share-locks their pages (`readNoopEmbeddingCandidates`). */
  readNoopEmbeddingCandidates(spec: NoopSettleCandidateSpec): Promise<NoopSettleCandidate[]>;
  /** Settles these queued effects as the runner's claim and completion of a no-op leave them (`settleNoopEmbeddingRows`). */
  settleNoopEmbeddingRows(ids: readonly string[]): Promise<NoopSettledRow[]>;

  /**
   * The current value of each named transaction-local setting (`current_setting(name, true)`), in `names` order, null
   * where unset. On a transaction engine it reads inside that transaction. Names are code constants (dotted lowercase).
   */
  readTransactionSettings(names: readonly string[]): Promise<Array<string | null>>;

  /** Sets each named setting to the value at its index for the rest of the current transaction (`set_config(name, value, true)`), in one statement. */
  applyTransactionSettings(names: readonly string[], values: readonly string[]): Promise<void>;
  /** Starts the current transaction as one snapshot (`REPEATABLE READ`, and `READ ONLY` with `readOnly`); call it first. */
  beginSnapshotRead(opts?: { readOnly?: boolean }): Promise<void>;
  /**
   * Bounds every later statement of the current transaction to `ms` milliseconds (`SET LOCAL statement_timeout`).
   * `ms` is a non-negative integer. On the Rust engine it does nothing: the store has no statement timeout.
   */
  setLocalStatementTimeout(ms: number): Promise<void>;

  /**
   * The writer's trust declaration in force on this transaction: the raw `gbrain.write_trust_tier` and
   * `gbrain.write_origin` settings, each null (or '') where unset (persistence/context.ts `currentWriteTrust` parses them).
   */
  readCurrentWriteTrust(): Promise<{ tier: string | null; origin: string | null }>;

  /**
   * Establishes a coordinated write's context on the current transaction in one statement (persistence/context.ts
   * `withCoordinatedWrite`): source scope, actor (an enclosing actor is kept), trust (nests as min(outer, inner)) and the
   * git protocol. Sets nothing when the persistence identity row is missing (`brainId` null). `previous` holds the values
   * it replaced, '' where unset, in engine-sql/transaction-settings.ts WRITE_CONTEXT_SETTINGS order.
   */
  setWriteContext(input: WriteContextInput): Promise<WriteContextResult>;

  // The writer-version reads (engine-sql/writer-versions.ts): which binaries admitted and published the retained requests.
  /** When the brain started stamping writer versions (migration 178), as ISO text; null when not recorded. */
  readWriterVersionCutoff(): Promise<string | null>;
  /** The latest admitter and consumer version per host and principal across all retained requests, newest first, at most `limit`. */
  listWriterVersions(limit: number): Promise<WriterVersionRow[]>;
  /** Committed requests published in the last `days`, grouped per role, host, principal and version, stamped after the cutoff. */
  recentWriterVersions(days: number): Promise<RecentWriterVersionRow[]>;
  /** Every writer the segmented-storage gate saw in the last `days` (requests, ingest log, consumers), grouped with its mark, newest first. */
  readSegmentedGateEvidence(days: number): Promise<SegmentedGateEvidenceRow[]>;

  // The connect gate's persistence reads (engine-sql/connect-gate.ts): table probes, managed roots, graduation, retired epochs.
  /** Whether persistence table `table` exists (a brain before the persistence migrations has none). */
  hasPersistenceTable(table: PersistenceTable): Promise<boolean>;
  /** The managed roots host `hostId` binds, plus every source with a local path, in one snapshot. */
  listManagedRootBindings(hostId: string, opts?: { signal?: AbortSignal }): Promise<ManagedRootBindingRow[]>;
  /** The graduation custody row, or null; `withRunSetting` adds the run the current transaction declares. */
  readGraduationGateRow(opts?: { withRunSetting?: boolean }): Promise<GraduationGateRow | null>;
  /** The outcome of every committed writer deactivation. */
  listRetiredDeactivations(): Promise<RetiredDeactivationRow[]>;

  /**
   * What the belief ledger knows about one source (incarnation, purge epoch, newest coverage event, whether any purge
   * exists), or null for an unknown source. `batch` also returns the managed-mode rows and the plan-cache mode it
   * replaced, and switches the transaction to generic plans when coverage is active.
   */
  readLedgerSource(sourceId: string, opts?: { batch?: boolean }): Promise<LedgerSource | null>;
  /** The sources with a belief event about `subjectKey` in their current incarnation, by id (engine-sql/belief.ts). */
  listCoveredSources(subjectKey: string): Promise<string[]>;
}
