/**
 * The persistence statements of BrainEngine: the write journal, sync holds, claims, housekeeping, effect worker and connect gate.
 * Declarations moved verbatim out of engine.ts; `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type { AccessTokenWriteGrant, AdmissionRate, ClaimedWriteRow, CompletedWriteRow, CounterRow, OAuthClientWriteGrant, PublicationEffectsSpec, WriteCompletion, WriteRequestInsert } from '../engine-sql/persistence-journal.ts';
import type { CapacityForecastInputs, ProjectionJobRef } from '../engine-sql/persistence-housekeeping.ts';
import type { ClaimRelease, ClaimRenewal, SourceMembership } from '../engine-sql/persistence-claims.ts';
import type { EffectClaimRef, EffectWorktreeOwner } from '../engine-sql/persistence-effect-worker.ts';
import type { RequestEffectState } from '../engine-sql/persistence-effect-scans.ts';
import type { ManagedRootBindingRow, PersistenceTable } from '../engine-sql/connect-gate.ts';
import type { WriteContextInput, WriteContextResult } from '../engine-sql/transaction-settings.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { CounterColumn } from '../engine-sql/writer-release.ts';
import type { SegmentedGateEvidenceRow } from '../engine-sql/writer-versions.ts';
import type { TerminalIntentCompaction } from '../engine-sql/persistence-journal.ts';

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
}
