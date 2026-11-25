
import type { RecoveryRecord, WriteRequest } from '../persistence/model.ts';

// Each statement is constant text: protocol.ts PERSISTENCE_PROTOCOL_PREDICATE is written out where a statement
// declares protocol 2 for itself (as engine-sql/persistence-claims.ts does).

/** The table a recovery-staging upgrade reads and writes (persistence/staging.ts). */
export type RecoveryTable = 'persistence_requests' | 'persistence_effects';
/** One row's recovery record, its reserved bytes and its source. */
export interface RecoveryStagingRow { recovery: unknown; recovery_bytes: number | string; source_id: string }
/** The worktree row guardOwnership compares with the request. */
export interface WorktreeOwnerRow { owner_host_id: string | null; owner_epoch: string | number; state: string }
/** A recovery to record: `keys` are the counter rows its bytes are reserved on. */
export interface RecoveryReservation { id: string; executionToken: string | null; recovery: RecoveryRecord; bytes: number; keys: string[] }
/** The failure a refused publication keeps (the first one recorded wins). */
export interface RecoveringFailure { code: string; message: string; detail?: unknown }

export interface PublicationJournalStore {
  /**
   * The import an earlier deferred write to the same page waits on (`deferred_import_from`, the source's last commit
   * when it deferred) while that import has not landed: the earliest such write before `sequence`, or null.
   */
  heldBehindImport(sourceId: string, slug: string, sequence: number | string): Promise<string | null>;
  /** Whether a request on the worktree other than `excludeId`, or an effect on it, holds a recovery record. */
  recoveryBlocker(worktreeId: string, excludeId: string): Promise<boolean>;
  /** The checkout root of the worktree's owner host; null when the owner has no host binding. */
  ownerPath(worktreeId: string): Promise<string | null>;
  /** The worktree row, shared with transfers (FOR SHARE) for the rest of the transaction; null when it is missing. */
  shareWorktreeOwner(worktreeId: string): Promise<WorktreeOwnerRow | null>;
  /** Shares the worktree row (FOR SHARE) for the rest of the transaction. */
  shareWorktree(worktreeId: string): Promise<void>;
  /** Locks the source row (FOR UPDATE) for the rest of the transaction. */
  lockSource(sourceId: string): Promise<void>;
  /**
   * Records the recovery and reserves its bytes on `keys`. `checked`: only while the request still runs under the token
   * with no recovery record, answering whether it did; otherwise by id and token (the caller checked the locked row).
   */
  recordRecovery(reservation: RecoveryReservation, checked: boolean): Promise<boolean>;
  /** Clears a terminal request's recovery when it is still exactly `recovery`, releasing its bytes; whether it did. */
  clearKnownRecovery(id: string, keys: string[], recovery: unknown): Promise<boolean>;
  /** Clears the request's recovery and releases `bytes` from `keys`. */
  clearRecovery(id: string, keys: string[], bytes: number): Promise<void>;
  /** A request still running or recovering under the token moves to `recovering` with `reason`; the first failure is kept. */
  markRecovering(id: string, executionToken: string | null, reason: string, failure?: RecoveringFailure): Promise<void>;
  /** Stamps `publication_started` on the request and returns it (the row lock of the publication). */
  markPublicationStarted(id: string): Promise<WriteRequest | null>;
  /** A running or recovering request with a recovery record waits for a publication slot (`writer_pool_capacity`). */
  blockCapacity(id: string): Promise<WriteRequest | null>;
  /** A live request moves to `recovering` with `reason`; a terminal one keeps its state and takes the reason. */
  blockRecovery(id: string, reason: string): Promise<WriteRequest | null>;
  /** The recovered request goes back to `queued` without its claim and recovery record; `kept` replaces the outcome. */
  requeueRecovered(id: string, kept: Record<string, unknown> | null, clearError: boolean): Promise<WriteRequest | null>;
  /** The staging upgrade's durable commit and its lock and statement timeouts for the rest of the transaction. */
  stagingDurability(): Promise<void>;
  /** One row's recovery record (FOR UPDATE); null when the row is missing. */
  recoveryStaging(table: RecoveryTable, id: string | number): Promise<RecoveryStagingRow | null>;
  /** Replaces the row's recovery record and adds `extra` to its recovery bytes. */
  growRecoveryStaging(table: RecoveryTable, id: string | number, recovery: unknown, extra: number): Promise<void>;
}

/** The two statements of a recovery-staging upgrade for each table; an unknown table name throws. */
const RECOVERY_STAGING_SQL: Readonly<Record<RecoveryTable, { read: string; grow: string }>> = {
  persistence_requests: {
    read: 'SELECT recovery,recovery_bytes,source_id FROM persistence_requests WHERE id=$1 FOR UPDATE',
    grow: 'UPDATE persistence_requests SET recovery=$2::text::jsonb,recovery_bytes=recovery_bytes+$3 WHERE id=$1',
  },
  persistence_effects: {
    read: 'SELECT recovery,recovery_bytes,source_id FROM persistence_effects WHERE id=$1 FOR UPDATE',
    grow: 'UPDATE persistence_effects SET recovery=$2::text::jsonb,recovery_bytes=recovery_bytes+$3 WHERE id=$1',
  },
};
function recoveryStagingSql(table: RecoveryTable): { read: string; grow: string } {
  const sql = Object.hasOwn(RECOVERY_STAGING_SQL, table) ? RECOVERY_STAGING_SQL[table] : undefined;
  if (!sql) throw new TypeError(`Not a recovery table: ${String(table)}`);
  return sql;
}
