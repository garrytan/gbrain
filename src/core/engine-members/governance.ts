
import type * as TrustWriteGateSql from '../engine-sql/trust-write-gate.ts';

export interface GovernanceMembers {
  /** Whether a purge tombstone of the source at `visibility` names the fingerprint of `claim` for subject '*' or `entitySlug`. */
  isFactPurged(sourceId: string, visibility: string, claim: string, entitySlug: string | null): Promise<boolean>;

  // Trust: the write gate's receipts and holds (engine-sql/trust-write-gate.ts). Writers call these inside their
  // publication transaction, so a rolled-back write leaves no receipt or hold.
  /** Record a flag or quarantine receipt; the same target, content hash and detector version refreshes it. Returns its id. */
  upsertWriteGateReceipt(input: TrustWriteGateSql.WriteGateReceiptInput): Promise<number>;
  /** One row's receipts, newest `last_seen_at` first (ties: higher id first), at most `limit`. */
  listWriteGateReceiptsFor(targetTable: string, targetId: string, limit: number): Promise<TrustWriteGateSql.WriteGateReceiptRow[]>;
  /** Hold a quarantined fact or take; the same source, slug, fingerprint and detector version re-opens the hold. Returns its id. */
  upsertWriteGateHold(input: TrustWriteGateSql.WriteGateHoldRowInput): Promise<number>;
  /** Holds, highest id first. */
  listWriteGateHoldRows(opts: TrustWriteGateSql.WriteGateHoldListOpts): Promise<TrustWriteGateSql.WriteGateHoldRow[]>;
  /** One hold by id, any status. */
  getWriteGateHoldRow(id: number): Promise<TrustWriteGateSql.WriteGateHoldRow | null>;
}
