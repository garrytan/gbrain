/**
 * The request-row work of a bound (worktree) publication around its files (persistence/coordinator.ts publishMutation and
 * recoverPublication, journal.ts prepareRecovery, clearResolvedRecovery and markRecovering, page-prepare.ts, ownership.ts
 * guardOwnership, effect-journal.ts and staging.ts upgradeRecoveryStaging).
 *
 * - `publicationJournalStore` (BrainEngine) returns narrow reads and writes with the row shapes those files decide on, so
 *   the checks, the refusals and their texts stay in the persistence files and a Rust brain hands them the same store
 *   over its own records (src/core/rust-engine/store-members/publication-journal.ts). Called on a transaction engine,
 *   every call runs in that transaction; called on the engine, each call is its own statement.
 * - A conditional write answers whether it changed the row (`boolean`) or returns the changed row (`null` when the
 *   conditions held for none). A counter release below zero refuses, as the CHECK (>= 0) does.
 * - The row locks (`FOR SHARE`, `FOR UPDATE`) are the persistence files' ordering on Postgres and PGLite; a store that
 *   runs one write transaction at a time takes none.
 */
import type { BrainEngine } from '../engine.ts';
import type { RecoveryRecord, WriteRequest } from '../persistence/model.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

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

export function sqlPublicationJournalStore(exec: RawSql): PublicationJournalStore {
  return {
    async heldBehindImport(sourceId, slug, sequence) {
      const [row] = await exec.executeRaw<{ deferred_import_from: string }>(`SELECT r.deferred_import_from FROM persistence_requests r
        JOIN sources s ON s.id=r.source_id WHERE r.source_id=$1 AND r.slug=$2 AND r.sequence<$3 AND r.state='deferred' AND r.deferred_import_from IS NOT NULL
          AND COALESCE(s.last_commit,'')=r.deferred_import_from ORDER BY r.sequence LIMIT 1`, [sourceId, slug, String(sequence)]);
      return row?.deferred_import_from ?? null;
    },
    async recoveryBlocker(worktreeId, excludeId) {
      const rows = await exec.executeRaw(`SELECT 1 FROM persistence_requests
        WHERE worktree_id=$1::uuid AND id<>$2::uuid AND recovery IS NOT NULL
        UNION ALL SELECT 1 FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1`, [worktreeId, excludeId]);
      return rows.length > 0;
    },
    async ownerPath(worktreeId) {
      const [row] = await exec.executeRaw<{ local_path: string }>(`SELECT h.local_path FROM persistence_host_bindings h
        JOIN persistence_worktrees w ON w.id=h.worktree_id AND w.owner_host_id=h.host_id WHERE w.id=$1::uuid`, [worktreeId]);
      return row?.local_path ?? null;
    },
    async shareWorktreeOwner(worktreeId) {
      const [row] = await exec.executeRaw<WorktreeOwnerRow>('SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [worktreeId]);
      return row ?? null;
    },
    async shareWorktree(worktreeId) {
      await exec.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [worktreeId]);
    },
    async lockSource(sourceId) {
      await exec.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    },
    async recordRecovery({ id, executionToken, recovery, bytes, keys }, checked) {
      if (checked) {
        const [reserved] = await exec.executeRaw(`WITH recorded AS (UPDATE persistence_requests SET recovery=$3::text::jsonb,recovery_bytes=$4,updated_at=now()
            WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND recovery IS NULL RETURNING id),
          reserved AS (UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$4 WHERE key=ANY($5::text[]) AND EXISTS (SELECT 1 FROM recorded))
          SELECT id FROM recorded`, [id, executionToken, JSON.stringify(recovery), bytes, keys]);
        return reserved !== undefined;
      }
      const rows = await exec.executeRaw(`WITH reserved AS (UPDATE persistence_counters SET recovery_bytes=recovery_bytes+$4 WHERE key=ANY($5::text[]))
        UPDATE persistence_requests SET recovery=$3::text::jsonb,recovery_bytes=$4,updated_at=now()
        WHERE id=$1::uuid AND execution_token=$2::uuid RETURNING id`, [id, executionToken, JSON.stringify(recovery), bytes, keys]);
      return rows.length > 0;
    },
    async clearKnownRecovery(id, keys, recovery) {
      const [cleared] = await exec.executeRaw(`WITH locked AS (SELECT id,recovery_bytes FROM persistence_requests WHERE id=$1::uuid AND recovery=$3::text::jsonb
          AND state IN ('committed','conflict','failed','cancelled') FOR UPDATE),
        released AS (UPDATE persistence_counters SET recovery_bytes=recovery_bytes-(SELECT recovery_bytes FROM locked) WHERE key=ANY($2::text[]) AND EXISTS (SELECT 1 FROM locked))
        UPDATE persistence_requests r SET recovery=NULL,recovery_bytes=0,blocked_reason=NULL FROM locked WHERE r.id=locked.id RETURNING r.id`,
      [id, keys, JSON.stringify(recovery)]);
      return cleared !== undefined;
    },
    async clearRecovery(id, keys, bytes) {
      await exec.executeRaw(`WITH released AS (UPDATE persistence_counters SET recovery_bytes=recovery_bytes-$3 WHERE key=ANY($2::text[]))
        UPDATE persistence_requests SET recovery=NULL,recovery_bytes=0,blocked_reason=NULL WHERE id=$1::uuid`, [id, keys, bytes]);
    },
    async markRecovering(id, executionToken, reason, failure) {
      await exec.executeRaw(`UPDATE persistence_requests SET state='recovering',blocked_reason=$3,updated_at=now(),
        error_code=COALESCE(error_code,$4),error_message=COALESCE(error_message,$5),
        error_detail=CASE WHEN error_code IS NULL THEN $6::text::jsonb ELSE error_detail END
        WHERE id=$1::uuid AND execution_token=$2::uuid AND state IN ('running','recovering') AND set_config('gbrain.persistence_protocol','2',true)='2'`,
      [id, executionToken, reason, failure?.code ?? null, failure?.message ?? null, failure?.detail ? JSON.stringify(failure.detail) : null]);
    },
    async markPublicationStarted(id) {
      const [row] = await exec.executeRaw<WriteRequest>('UPDATE persistence_requests SET publication_started=true WHERE id=$1::uuid RETURNING *', [id]);
      return row ?? null;
    },
    async blockCapacity(id) {
      const [row] = await exec.executeRaw<WriteRequest>(`UPDATE persistence_requests SET blocked_reason='writer_pool_capacity',updated_at=now()
        WHERE id=$1::uuid AND recovery IS NOT NULL AND state IN ('running','recovering') AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING *`, [id]);
      return row ?? null;
    },
    async blockRecovery(id, reason) {
      const [row] = await exec.executeRaw<WriteRequest>(`UPDATE persistence_requests SET
        state=CASE WHEN state IN ('committed','conflict','failed','cancelled') THEN state ELSE 'recovering' END,
        blocked_reason=$2,updated_at=now() WHERE id=$1::uuid RETURNING *`, [id, reason]);
      return row ?? null;
    },
    async requeueRecovered(id, kept, clearError) {
      const [row] = await exec.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='queued',execution_token=NULL,
        claim_expires_at=NULL,recovery=NULL,recovery_bytes=0,publication_started=false,blocked_reason=NULL,outcome=COALESCE($2::text::jsonb,outcome),
        error_code=CASE WHEN $3::boolean THEN NULL ELSE error_code END,error_message=CASE WHEN $3::boolean THEN NULL ELSE error_message END,
        error_detail=CASE WHEN $3::boolean THEN NULL ELSE error_detail END,updated_at=now()
        WHERE id=$1::uuid RETURNING *`, [id, kept ? JSON.stringify(kept) : null, clearError]);
      return row ?? null;
    },
    async stagingDurability() {
      await exec.executeRaw("SELECT set_config('synchronous_commit','on',true),set_config('lock_timeout','1s',true),set_config('statement_timeout','5s',true)");
    },
    async recoveryStaging(table, id) {
      const [row] = await exec.executeRaw<RecoveryStagingRow>(recoveryStagingSql(table).read, [id]);
      return row ?? null;
    },
    async growRecoveryStaging(table, id, recovery, extra) {
      await exec.executeRaw(recoveryStagingSql(table).grow,
        [id, JSON.stringify(recovery), extra]);
    },
  };
}

/** `publicationJournalStore()` on PGLite and Postgres: the store over `exec` (a transaction engine runs every call in it). */
export async function publicationJournalStore(exec: RawSql): Promise<PublicationJournalStore> {
  return sqlPublicationJournalStore(exec);
}
