/**
 * The persistence statements of BrainEngine: the write journal, sync holds, claims, housekeeping, effect worker and connect gate.
 * Declarations moved verbatim out of engine.ts; `BrainEngine` extends this interface, so the member set is unchanged.
 */
import type { AccessTokenWriteGrant, ClaimedWriteRow, CompletedWriteRow, CounterRow, OAuthClientWriteGrant, PublicationEffectsSpec, WriteCompletion, WriteRequestInsert } from '../engine-sql/persistence-journal.ts';
import type { ClaimRenewal, SourceMembership } from '../engine-sql/persistence-claims.ts';
import type { EffectClaimRef, EffectWorktreeOwner } from '../engine-sql/persistence-effect-worker.ts';
import type { RequestEffectState } from '../engine-sql/persistence-effect-scans.ts';
import type { WriteRequest } from '../persistence/model.ts';
import type { SegmentedGateEvidenceRow } from '../engine-sql/writer-versions.ts';
import type { TerminalIntentCompaction } from '../engine-sql/persistence-journal.ts';

export interface PersistenceMembers {
  /** The request a principal admitted under `requestId` (a uuid), or null. */
  readWriteRequest(principalKind: string, principalId: string, requestId: string): Promise<WriteRequest | null>;
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
  /** Creates the missing counter rows and locks them all FOR UPDATE in key order; returns the locked rows. */
  lockPersistenceCounters(keys: readonly string[]): Promise<CounterRow[]>;
  /** Inserts an admitted request and charges its (already locked) counters; returns the stored row. */
  insertWriteRequest(row: WriteRequestInsert): Promise<WriteRequest>;
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
  /** Extends a claim's lease (and records its phase); true while the request is running under the token. Postgres sends it on the direct pool. */
  renewWriteClaim(renewal: ClaimRenewal, opts?: { signal?: AbortSignal }): Promise<boolean>;
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
  /** Every writer the segmented-storage gate saw in the last `days` (requests, ingest log, consumers), grouped with its mark, newest first. */
  readSegmentedGateEvidence(days: number): Promise<SegmentedGateEvidenceRow[]>;
}
