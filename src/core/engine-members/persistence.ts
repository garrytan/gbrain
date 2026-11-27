/**
 * The persistence statements of BrainEngine: the write journal, sync holds, claims, housekeeping, effect worker and connect gate.
 * Declarations moved verbatim out of engine.ts; `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type { AccessTokenWriteGrant, AdmissionRate, ClaimedWriteRow, CompletedWriteRow, CounterRow, OAuthClientWriteGrant, PublicationEffectsSpec, WriteCompletion, WriteRequestInsert, WriteRequestProgress } from '../engine-sql/persistence-journal.ts';
import type { CapacityForecastInputs, ProjectionJobRef } from '../engine-sql/persistence-housekeeping.ts';
import type { ClaimRelease, ClaimRenewal, SourceMembership, TopologyChange } from '../engine-sql/persistence-claims.ts';
import type { EffectClaim, EffectClaimRef, EffectWorktreeOwner, MirrorGateRow } from '../engine-sql/persistence-effect-worker.ts';
import type { RequestEffectState } from '../engine-sql/persistence-effect-scans.ts';
import type { ManagedRootBindingRow, PersistenceTable } from '../engine-sql/connect-gate.ts';
import type { WriteContextInput, WriteContextResult } from '../engine-sql/transaction-settings.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { CounterColumn } from '../engine-sql/writer-release.ts';
import type { SegmentedGateEvidenceRow } from '../engine-sql/writer-versions.ts';
import type { TerminalIntentCompaction } from '../engine-sql/persistence-journal.ts';
import type { ClaimExpiry } from '../engine-sql/persistence-claims.ts';
import type { ClaimHeadSpec } from '../engine-sql/persistence-claims.ts';
import type { ConsumerRenewal } from '../engine-sql/persistence-claims.ts';
import type { ConsumerRowKey } from '../engine-sql/persistence-claims.ts';
import type { FenceHoldFileRow, FenceHoldRow } from '../engine-sql/fence-holds.ts';
import type { GatedMirrorRequest } from '../engine-sql/persistence-effect-scans.ts';
import type { GraduationGateRow } from '../engine-sql/connect-gate.ts';
import type { HousekeepingTurnClaim } from '../engine-sql/persistence-housekeeping.ts';
import type { OverdueHold, OverdueHoldKind } from '../engine-sql/persistence-owner-scans.ts';
import type { PendingSegmentedProjection } from '../engine-sql/persistence-housekeeping.ts';
import type { ProjectionScanCursor } from '../page-state/projection-window.ts';
import type { ProjectionWindowRow } from '../engine-sql/persistence-housekeeping.ts';
import type { ReceiptBudget } from '../engine-sql/persistence-housekeeping.ts';
import type { RetiredDeactivationRow } from '../engine-sql/connect-gate.ts';
import type { SegmentedProjectionFilter } from '../engine-sql/persistence-housekeeping.ts';
import type { IdleProbeRow } from '../engine-sql/persistence-idle-probe.ts';
import type { IdleProbeSpec } from '../engine-sql/persistence-idle-probe.ts';
import type { ReservedConnection } from '../engine.ts';
import type { TrueUpReservation } from '../engine-sql/persistence-housekeeping.ts';
import type { NoopSettleCandidate } from '../engine-sql/persistence-embedding-noop-settle.ts';
import type { NoopSettleCandidateSpec } from '../engine-sql/persistence-embedding-noop-settle.ts';
import type { NoopSettleWindow } from '../engine-sql/persistence-embedding-noop-settle.ts';
import type { NoopSettledRow } from '../engine-sql/persistence-embedding-noop-settle.ts';

export interface PersistenceMembers {
  // Write-journal statements (engine-sql/persistence-journal.ts): the text journal.ts, limits.ts and held-reads.ts sent through executeRaw.
  /** The journal limit config rows, then one row with a null key: the largest page stored in segments, or 'unindexed'. */
  readJournalLimitRows(): Promise<Array<{ key: string | null; value: string | null }>>;
  /** The source's purge epoch as stored, which every fact purge bumps, or null for an unknown source (SQL in engine-sql/sync-reason-reads.ts). */
  readSourcePurgeEpoch(sourceId: string): Promise<string | number | null>;
  /** The request a principal admitted under `requestId` (a uuid), or null. */
  readWriteRequest(principalKind: string, principalId: string, requestId: string): Promise<WriteRequest | null>;
  /** The requests a principal admitted under any of `requestIds` (uuids), in no order (a grouped admission's replays). */
  readWriteRequestsByRequestIds(principalKind: string, principalId: string, requestIds: readonly string[]): Promise<WriteRequest[]>;
  /** The request with journal id `id`, or null; `signal` cancels the read. */
  readWriteRequestById(id: string, opts?: { signal?: AbortSignal }): Promise<WriteRequest | null>;
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
  /** The owner host's checkout path of worktree `worktreeId` (its host binding's `local_path`), or null without an owner or a binding. */
  readOwnerHostBinding(worktreeId: string): Promise<string | null>;
  /** Stamps a claim (running, token, lease, first phase) on request `id`; null when the refresh barrier refused it. */
  stampWriteClaim(id: string, token: string, leaseMs: number, phaseJson: string): Promise<ClaimedWriteRow | null>;
  /** Request `id` locked FOR UPDATE until the transaction ends, or null. */
  lockWriteRequest(id: string): Promise<WriteRequest | null>;
  /** Records a request's terminal state and releases its counters; null when the result exceeds its reservation. */
  completeWriteRow(completion: WriteCompletion): Promise<CompletedWriteRow | null>;
  /** The requests with these ids, locked FOR UPDATE until the transaction ends, in id order (a purge's cancel of the writes holding a staging). */
  lockWriteRequestsById(ids: readonly string[]): Promise<WriteRequest[]>;
  /** Drops a terminal request's intent that carried purged content and shrinks its reservation (journal.ts finishTerminal); null for an unknown id. */
  compactTerminalIntent(compaction: TerminalIntentCompaction): Promise<WriteRequest | null>;
  /** Inserts a publication's effects in queue order (a gated one only while auto-linking is on); returns the kinds inserted. */
  insertPublicationEffects(spec: PublicationEffectsSpec): Promise<string[]>;
  // Write-claim statements (engine-sql/persistence-claims.ts): the text journal.ts, authority.ts and consumer.ts sent through executeRaw.
  /** A source's incarnation and archive flag, or null; `lock` reads it FOR SHARE (`'update'`: FOR UPDATE) until the transaction ends. */
  readSourceMembership(sourceId: string, opts?: { lock?: boolean | 'update' }): Promise<SourceMembership | null>;
  /** `[{ request_id }]` for the first of `requestIds` a topology change of local writer `principalId` used, or []. */
  findTopologyChanges(principalId: string, requestIds: string[]): Promise<Array<{ request_id: string }>>;
  /** The lifecycle receipt row of local writer `principalId` and `requestId`, or null. */
  readTopologyChange(principalId: string, requestId: string): Promise<TopologyChange | null>;
  /** Extends a claim's lease (and records its phase); true while the request is running under the token. Postgres sends it on the direct pool. */
  renewWriteClaim(renewal: ClaimRenewal, opts?: { signal?: AbortSignal }): Promise<boolean>;
  /** Returns a claim that never began to publish to queued under its token; `direct` sends it on the Postgres direct pool. */
  releaseUnpublishedClaim(release: ClaimRelease, opts?: { direct?: boolean }): Promise<void>;
  /** The capacity forecast's reads: counters, per-day principal and topology rows, history, reclaimable bytes and the table size. */
  readCapacityForecastInputs(opts?: { light?: boolean }): Promise<CapacityForecastInputs>;
  /** Deletes the job when it is still queued at `job.revision` (the page sealed at that revision). */
  deleteProjectionJob(job: ProjectionJobRef): Promise<void>;
  /**
   * The effects of journal request `requestId` as its receipt reads them (state, error code, outcome, whether a recovery
   * is open), in kind order, or only its Git effect when `kind` is `'git'`. A non-uuid request id refuses.
   */
  readRequestEffects(requestId: string, kind?: 'git'): Promise<RequestEffectState[]>;
  /**
   * Extends an effect claim's lease by 2 minutes; true while it is running under the token with no recovery. `direct`
   * runs it on the Postgres direct lane (`executeRawDirect`), outside any pooled transaction.
   */
  renewEffectClaim(claim: EffectClaimRef, opts?: { direct?: boolean }): Promise<boolean>;
  /** Finishes a claimed effect (no recovery) with `outcomeJson`: committed, or failed `targets_parked` when it parked targets. */
  completeEffectRow(claim: EffectClaimRef & { outcomeJson: string }): Promise<void>;
  /** Fails a claimed effect (no recovery) with error code `reason`. */
  failEffectRow(claim: EffectClaimRef & { reason: string }): Promise<void>;
  /**
   * The effect guard's locks (`guardEffectSource`): share-locks the brain row, then the effect's worktree row, and
   * returns that worktree's owner and state; null without a worktree id or when the worktree row is gone.
   */
  lockEffectGuard(worktreeId: string | null): Promise<EffectWorktreeOwner | null>;
  /** Starts the current transaction as one snapshot (`REPEATABLE READ`, and `READ ONLY` with `readOnly`); call it first. */
  beginSnapshotRead(opts?: { readOnly?: boolean }): Promise<void>;

  /**
   * Establishes a coordinated write's context on the current transaction in one statement (persistence/context.ts
   * `withCoordinatedWrite`): source scope, actor (an enclosing actor is kept), trust (nests as min(outer, inner)) and the
   * git protocol. Sets nothing when the persistence identity row is missing (`brainId` null). `previous` holds the values
   * it replaced, '' where unset, in engine-sql/transaction-settings.ts WRITE_CONTEXT_SETTINGS order.
   */
  setWriteContext(input: WriteContextInput): Promise<WriteContextResult>;
  /** Every writer the segmented-storage gate saw in the last `days` (requests, ingest log, consumers), grouped with its mark, newest first. */
  readSegmentedGateEvidence(days: number): Promise<SegmentedGateEvidenceRow[]>;

  // The connect gate's persistence reads (engine-sql/connect-gate.ts): table probes, managed roots, graduation, retired epochs.
  /** Whether persistence table `table` exists (a brain before the persistence migrations has none). */
  hasPersistenceTable(table: PersistenceTable): Promise<boolean>;
  /** The managed roots host `hostId` binds, plus every source with a local path, in one snapshot. */
  listManagedRootBindings(hostId: string, opts?: { signal?: AbortSignal }): Promise<ManagedRootBindingRow[]>;
  // Housekeeping statements (engine-sql/persistence-housekeeping.ts): the text housekeeping-turn.ts, compaction-pass.ts, journal.ts,
  // receipt-true-up.ts, capacity-forecast.ts and the projection queue readers sent through executeRaw after a write.
  /** Leases this host's housekeeping turn; true when it was free. `direct` sends it on the Postgres direct pool. */
  claimHousekeepingTurn(claim: HousekeepingTurnClaim, opts?: { signal?: AbortSignal; direct?: boolean }): Promise<boolean>;
  /** Marks this host's leased housekeeping turn finished. `direct` sends it on the Postgres direct pool. */
  completeHousekeepingTurn(turn: { op: string; hostId: string }, opts?: { direct?: boolean }): Promise<void>;
  deleteConsumerRow(key: ConsumerRowKey, opts?: { signal?: AbortSignal }): Promise<void>;
  /** Returns expired claims and claims of dead owners to queued, at most 100; `direct` sends it on the Postgres direct pool. */
  expireStaleWriteClaims(expiry: ClaimExpiry, opts?: { signal?: AbortSignal; direct?: boolean }): Promise<void>;
  /** Whether a claim would find a row now; `priority` overrides the foreground-priority config row when set. */
  hasClaimableWrite(hostId: string, excludeRoots: string[], opts?: { priority?: boolean | null; signal?: AbortSignal }): Promise<boolean>;
  /** Up to 100 compactable receipts completed over `retentionDays` ago, oldest first, without unresolved caller refusals or open-sync rows. */
  listCompactableReceipts<R = Record<string, unknown>>(retentionDays: number): Promise<R[]>;
  /**
   * Up to `limit` effects on worktrees `hostId` owns with a recovery due now, in id order after effect id `after` (from
   * the start when null) (`selectEffectRecoveries`). A non-uuid host, a non-bigint `after` or a negative limit refuses.
   */
  listEffectRecoveries<R = Record<string, unknown>>(hostId: string, after: string | null, limit: number): Promise<R[]>;
  /** The held fence results of `kinds` in `sourceIds` (one owner with `ownerKey`), oldest first (`listFenceHolds`, engine-sql/fence-holds.ts). */
  listFenceHoldRows(sourceIds: readonly string[], kinds: readonly string[], ownerKey?: string): Promise<FenceHoldRow[]>;
  // Effect scans (engine-sql/persistence-effect-scans.ts): the reads the effect worker's pass sent through executeRaw.
  /**
   * Up to 100 requests on worktrees `hostId` owns whose failed withdrawal mirror is parked by `gateCode` and whose other
   * unsettled effects are parked only with a code in `allowedCodes` (`resumeGatedMirrors`). A non-uuid host id refuses.
   */
  listGatedMirrorRequests(hostId: string, gateCode: string, allowedCodes: readonly string[]): Promise<GatedMirrorRequest[]>;
  // Owner scans (engine-sql/persistence-owner-scans.ts): the reads the write owner's housekeeping sent through executeRaw.
  /**
   * Up to 100 deferred writes on worktrees `hostId` owns whose `hold` (a refresh barrier, or an import that has not
   * landed) is past the wait limit `maxWaitMs`, in sequence order (`expireDeferredWrites`). A non-uuid host id refuses.
   */
  listOverdueHeldWrites<R = Record<string, unknown>>(hostId: string, maxWaitMs: number, hold: OverdueHoldKind, opts?: { signal?: AbortSignal }): Promise<R[]>;
  /**
   * The oldest recovering write of each worktree `hostId` owns that is not in `excluded`, at most 16 (the consumer's
   * recovery scan). `direct` takes the Postgres direct lane (the consumer passes `consumerOnDirectLane`). A non-uuid
   * host id refuses.
   */
  listOwnerRecoveryHeads<R = Record<string, unknown>>(hostId: string, excluded: readonly string[], opts?: { signal?: AbortSignal; direct?: boolean }): Promise<R[]>;
  /** Pending segmented-page projection jobs ready to rebuild, oldest first. */
  listPendingSegmentedProjections(filter: SegmentedProjectionFilter): Promise<PendingSegmentedProjection[]>;
  /** `{ id, sequence, compacted }` of up to `limit` requests after sequence `after`, in sequence order. */
  listReservationsAfter(after: string, limit: number): Promise<Array<{ id: string; sequence: string; compacted: boolean }>>;
  /**
   * The interrupted refreshes of worktrees `hostId` owns that the owner's topology scan converges, at most 16, a
   * syncing row last; each carries `stale` (no move for `budgetMs`). A non-uuid host id refuses.
   */
  listResumableRefreshes<R = Record<string, unknown>>(hostId: string, budgetMs: number): Promise<(R & { stale: boolean })[]>;
  /** The outcome of every committed writer deactivation. */
  listRetiredDeactivations(): Promise<RetiredDeactivationRow[]>;
  /** The topology changes with a recovery whose worktree host `hostId` owns, after change id `after`, in id order, at most `limit`. */
  listTopologyRecoveries(hostId: string, after: string | null, limit: number): Promise<TopologyChange[]>;
  /** The graduation custody row, or null; `withRunSetting` adds the run the current transaction declares. */
  readGraduationGateRow(opts?: { withRunSetting?: boolean }): Promise<GraduationGateRow | null>;
  /** The current-incarnation hold rows (`record`, page `revision`) naming these page ids, in fingerprint order. */
  readHeldPageRows<R = Record<string, unknown>>(pageIds: string[]): Promise<Array<{ record: R; revision: string | null }>>;
  /** The explicit receipt retention (null when unset), the brain's reserved terminal bytes and now minus `floorDays`, as text. */
  readReceiptBudget(retentionKey: string, floorDays: number): Promise<ReceiptBudget>;
  /** The heartbeat's renewal (purges the host's lapsed rows), its row delete and its worktree stamp; Postgres sends each on the direct pool. */
  renewConsumerRow(renewal: ConsumerRenewal, opts?: { signal?: AbortSignal }): Promise<void>;
  /**
   * The next effect host `hostId` may claim, row-locked for the current transaction (rows another transaction holds are
   * skipped), or null; `deadOwners` are owner keys whose running effects are claimable now (`claimPersistenceEffect`).
   * A non-uuid host id refuses.
   */
  selectClaimableEffect<R = Record<string, unknown>>(hostId: string, deadOwners: readonly string[]): Promise<R | null>;
  /** The request a FIFO claim takes next, locked FOR UPDATE SKIP LOCKED until the transaction ends, or null (journal.ts `claimNextWrite`). */
  selectClaimableWrite<R = Record<string, unknown>>(spec: ClaimHeadSpec): Promise<R | null>;
  /** The resident projection pass's window of pending jobs after `cursor`, with the high-water row last. */
  selectProjectionWindowJobs(cursor: Pick<ProjectionScanCursor, 'after' | 'highWater'>, retryCooldown: boolean): Promise<ProjectionWindowRow[]>;
  stampWorktreeHeartbeats(hostId: string, opts?: { signal?: AbortSignal }): Promise<void>;
  /** The progress columns of request `id` (state, error, outcome, deferral), or null; `signal` cancels the read. */
  readWriteRequestProgress(id: string, opts?: { signal?: AbortSignal }): Promise<WriteRequestProgress | null>;
  /**
   * The persistence consumer's idle probe (`persistence-idle-probe.ts`): whether any worker a full tick fans out to has
   * work now, and where the resident projection window stands. Runs on `opts.lane` (the consumer's reserved idle lane)
   * when given, else on the Postgres direct lane when `opts.direct`, else on the engine; `opts.signal` cancels it.
   */
  probeIdleWork(spec: IdleProbeSpec, opts?: { signal?: AbortSignal; lane?: ReservedConnection; direct?: boolean }): Promise<IdleProbeRow | null>;
  // Effect worker (engine-sql/persistence-effect-worker.ts): the claim stamp and the statements that settle a claim,
  // which effect-journal.ts sent through executeRaw. Each settle statement matches only effect `id` still claimed under
  // `token` (a null token matches none), so a claim that moved changes nothing.
  /** Claims effect `id` under `token` (running, a 2-minute lease, one more attempt): the claimed row, or null when no effect has the id. */
  stampEffectClaim<R = Record<string, unknown>>(claim: EffectClaim): Promise<R | null>;
  /** Marks a job still queued at `job.revision` and not under a live claim `rebuild_failed`, starting its retry window. */
  markProjectionRebuildFailed(job: ProjectionJobRef): Promise<void>;
  /**
   * Whether the hold an expiry scanned still stands, its row locked for the current transaction: the refresh still
   * unreleased, or the write still deferred on the same pending import and past its limit (`expireDeferredWrites`).
   */
  lockOverdueHold(hold: OverdueHold): Promise<boolean>;
  /** Requeues a claimed effect after `delayMs` with error code `reason`, a claim under recovery included. */
  retryEffectRow(claim: EffectClaimRef & { reason: string; delayMs: number }): Promise<void>;
  /** Whether one of these requests has a target parked under `code` that its committed withdrawal mirror re-arms (`hasRearmableTargets`). */
  hasRearmableTargets(requestIds: readonly string[], code: string): Promise<boolean>;
  /** The terminal requests among `ids` with their effect bytes and whether an effect is unfinished, in sequence order. */
  listTrueUpRequests<R = Record<string, unknown>>(ids: readonly string[]): Promise<R[]>;
  /** Inside the true-up's transaction, after its counter locks: shrinks each unchanged settled request to what its receipt keeps and releases the freed bytes from the counters; returns the bytes given back. */
  trueUpReservations(rows: readonly TrueUpReservation[]): Promise<number>;
  /** The withdrawal mirrors that gate these requests (`mirrorGates`): each not committed, or committed with its publications. */
  readMirrorGateRows(requestIds: readonly string[]): Promise<MirrorGateRow[]>;
  /** Requeues a claimed effect (no recovery) due now with its scan cursor at `slug` (`advanceEffectCursor`). */
  advanceEffectRow(claim: EffectClaimRef & { slug: string }): Promise<void>;
  /** Requeues a claimed effect as `writer_busy` after `delayMs`, merging `dataJson` (the busy streak) into its data. */
  retryBusyEffectRow(claim: EffectClaimRef & { dataJson: string; delayMs: number }): Promise<void>;
  /** Requeues a claimed effect (no recovery) with data `dataJson`, error code `reason`, after `delayMs`. */
  requeueEffectRow(claim: EffectClaimRef & { dataJson: string; reason: string | null; delayMs: number }): Promise<void>;
  /** Fails a claimed effect (no recovery) as `targets_parked` with data `dataJson`. */
  parkEffectRow(claim: EffectClaimRef & { dataJson: string }): Promise<void>;
  readFenceHoldFiles(sourceIds: readonly string[], slugs: readonly string[]): Promise<FenceHoldFileRow[]>;
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
}
