
import type * as TrustWithdrawalsSql from '../engine-sql/trust-withdrawals.ts';
import type * as TrustWriteGateSql from '../engine-sql/trust-write-gate.ts';

export interface GovernanceMembers {
  /** Records a withdrawal of `claim` (by its fingerprint) for `subject`, at `withdrawnAt` (an ISO time) or now; false when that withdrawal was already recorded. */
  insertFactWithdrawal(sourceId: string, visibility: string, claim: string, subject: string, withdrawnAt: string | null): Promise<boolean>;
  /** Whether a purge tombstone of the source at `visibility` names the fingerprint of `claim` for subject '*' or `entitySlug`. */
  isFactPurged(sourceId: string, visibility: string, claim: string, entitySlug: string | null): Promise<boolean>;
  /** Whether the source has any fact purge tombstone (`facts`) and any take purge tombstone (`takes`). */
  readSourcePurgeFlags(sourceId: string): Promise<{ facts: boolean; takes: boolean }>;
  /** The row numbers of `takes` whose claim fingerprint a take purge tombstone of the source names, under subject '*' or `subject` (any subject when null), each once. No set order. Reads take_purges. */
  listPurgedTakeRows(sourceId: string, takes: readonly TrustWithdrawalsSql.TakeClaimRow[], subject: string | null): Promise<number[]>;

  // Trust: the write gate's receipts and holds (engine-sql/trust-write-gate.ts). Writers call these inside their
  // publication transaction, so a rolled-back write leaves no receipt or hold.
  /** Record a flag or quarantine receipt; the same target, content hash and detector version refreshes it. Returns its id. */
  upsertWriteGateReceipt(input: TrustWriteGateSql.WriteGateReceiptInput): Promise<number>;
  /** Record a receipt on the live page (sourceId, slug); null when no live page has that slug. */
  upsertPageWriteGateReceipt(sourceId: string, slug: string, receipt: TrustWriteGateSql.WriteGateReceiptFields): Promise<number | null>;
  /** One row's receipts, newest `last_seen_at` first (ties: higher id first), at most `limit`. */
  listWriteGateReceiptsFor(targetTable: string, targetId: string, limit: number): Promise<TrustWriteGateSql.WriteGateReceiptRow[]>;
  /** Hold a quarantined fact or take; the same source, slug, fingerprint and detector version re-opens the hold. Returns its id. */
  upsertWriteGateHold(input: TrustWriteGateSql.WriteGateHoldRowInput): Promise<number>;
  /** Holds, highest id first. */
  listWriteGateHoldRows(opts: TrustWriteGateSql.WriteGateHoldListOpts): Promise<TrustWriteGateSql.WriteGateHoldRow[]>;
  /** One hold by id, any status. */
  getWriteGateHoldRow(id: number): Promise<TrustWriteGateSql.WriteGateHoldRow | null>;
}
