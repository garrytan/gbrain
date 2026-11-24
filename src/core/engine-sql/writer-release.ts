/**
 * The store work of writer activation and deactivation (`gbrain sources writer activate|deactivate`) and of the
 * pre-activation claim release (persistence/activation.ts, deactivation.ts, pre-activation-release.ts), plus the
 * counter charges of a topology receipt (persistence/topology-receipts.ts).
 *
 * - `writerReleaseStore` (BrainEngine) returns narrow reads and writes with the row shapes those files decide on, so
 *   the blocker texts, the checks and the error texts stay in the persistence files and a Rust brain hands them the
 *   same store over its own records (src/core/rust-engine/store-members/writer-release.ts). Called on a transaction
 *   engine, every call runs in that transaction; called on the engine, each call is its own statement.
 * - `auditPages` is the page read of the activation preview's drift audit (persistence/reconcile-audit.ts).
 * - `addPersistenceCounters` adds non-negative or negative amounts to one counter row's columns; the CHECK (>= 0)
 *   constraints refuse a charge that would go below zero.
 *
 * Source ids sort by the server's collation here, as the SQL they replace did.
 */
import type { BrainEngine } from '../engine.ts';
import { PAGE_EMBEDDING_LEASE_PREFIX } from '../page-embedding-lease.ts';
import { WRITER_ADMIN_LOCK_KEY } from '../persistence/admin-contract.ts';

/** A write request that keeps the brain from quiescing: outstanding, or holding a recovery record. */
export interface BlockingRequestRow { request_id: string; source_id: string; slug: string; operation: string; state: string; recovering: boolean }
/**
 * A topology change still recovering or holding a recovery record. `admission` is a recovering row with no recovery
 * record (an admitted lifecycle change that stopped before it finished); `automatic` is one an expired-archive purge
 * admitted (`outcome.expired_only`).
 */
export interface RecoveringTopologyRow { id: string; operation: string; source_id: string; request_id: string; admission: boolean; automatic: boolean }
/** An effect with its request's source and public id; `source_live` is whether that source incarnation is live. */
export interface ReleaseEffectRow {
  effect_id: string; kind: string; state: string; source_id: string; request_id: string; error_code: string | null;
  recovering: boolean; source_live: boolean;
}
export interface LiveLeaseRow { id: string; holder_host: string; holder_pid: number }
/** One (worktree, host root) pair; a worktree with no host binding has one row with a null root. */
export interface WorktreeRootRow { id: string; root: string | null }
/** One (source binding, host root) pair; a binding whose worktree has no host binding has one row with a null root. */
export interface ClaimRootRow { source_id: string; worktree_id: string; root: string | null }
export interface ReleaseSourceRow { id: string; incarnation: string; local_path: string | null; kind: string | null }
/** One page the drift audit inspects; `bytes` is the stored truth, timeline and frontmatter size (null on a segmented page). */
export interface AuditPageRow { slug: string; bytes: number | null; source_path: string | null; source_uri: string | null; database_only_reason: string | null }
/** The counter columns a topology receipt charges. */
export type CounterColumn = 'lifetime_ids' | 'terminal_bytes' | 'outstanding_count' | 'intent_bytes' | 'recovery_bytes';

export interface WriterReleaseStore {
  /** The transaction's lock timeout and durable commit; a no-op on an engine that serializes its write transactions. */
  begin(lockTimeoutMs: number): Promise<void>;
  /** The stored operator-lock config value (persistence/admin-lock.ts); null when unset. */
  adminLockValue(): Promise<string | null>;
  /** Shares the brain row with lock and unlock (FOR SHARE) for the rest of the transaction. */
  shareBrain(): Promise<void>;
  /** Locks every worktree and every source row (FOR UPDATE, by id). */
  lockWorktreesAndSources(): Promise<void>;
  /** Blocks fresh cycle-lock admission (SHARE ROW EXCLUSIVE) for the rest of the transaction. */
  lockCycleLocks(): Promise<void>;
  /** Shares one worktree row (FOR SHARE). */
  shareWorktree(id: string): Promise<void>;
  /** The first `limit` blocking requests, by sequence. */
  blockingRequests(limit: number): Promise<BlockingRequestRow[]>;
  /** The first 20 recovering topology changes, oldest first. */
  recoveringTopologyChanges(): Promise<RecoveringTopologyRow[]>;
  /**
   * The first 50 effects by id: `blocking` is queued, running or holding a recovery record; `failed` is terminally
   * failed, with no recovery record and not settled (`data.settled` unset).
   */
  releaseEffects(which: 'blocking' | 'failed'): Promise<ReleaseEffectRow[]>;
  /** Whether any effect holds a recovery record. */
  hasRecoveringEffect(): Promise<boolean>;
  /** The unexpired cycle locks that are not page embedding leases, by id. */
  liveLeases(): Promise<LiveLeaseRow[]>;
  /** Every worktree that is not retired with each of its host roots, by worktree id then root. */
  liveWorktreeRoots(): Promise<WorktreeRootRow[]>;
  /** Every source binding with each of its worktree's host roots, by source id then root. */
  claimRoots(): Promise<ClaimRootRow[]>;
  /** The source ids of every source binding, sorted. */
  boundSourceIds(): Promise<string[]>;
  sourceBindingCount(): Promise<number>;
  /** The source bindings whose source incarnation is live (not archived). */
  liveBoundSourceCount(): Promise<number>;
  /** The writer protocol registrations; throws where the table is missing (the caller treats that as 0). */
  writerProtocolCount(): Promise<number>;
  /** The sources that are not archived, by id; `lock` holds them FOR UPDATE. */
  configuredSources(lock: boolean): Promise<ReleaseSourceRow[]>;
  /** The host binding of `hostId` under worktree `worktreeId`, or null. */
  ownerHostBinding(worktreeId: string, hostId: string): Promise<{ local_path: string; coordination_path: string } | null>;
  /** Every recorded source local path. */
  sourceLocalPaths(): Promise<string[]>;
  /** Every host binding's local path. */
  hostBindingRoots(): Promise<string[]>;
  /**
   * Turns managed persistence on or off and moves `mode_epoch` by one; returns the new epoch as text. Turning it on
   * also records the first activation time.
   */
  setBrainEnabled(enabled: boolean): Promise<string>;
  /**
   * Retires worktrees (state `retired`, rows kept) and deletes every source binding; with `worktreeIds`, retires those
   * worktrees and deletes their host bindings, with null retires every worktree and deletes every host binding.
   */
  releaseBindings(worktreeIds: readonly string[] | null): Promise<void>;
  /** The live markdown pages of `sourceId` whose slug sorts after `after`, by slug, at most `limit`. */
  auditPages(sourceId: string, after: string, limit: number): Promise<AuditPageRow[]>;
}

const BLOCKING_REQUESTS_SQL = `SELECT request_id::text AS request_id, source_id, slug, operation, state, recovery IS NOT NULL AS recovering FROM persistence_requests
     WHERE state IN ('queued','deferred','running','recovering') OR recovery IS NOT NULL ORDER BY sequence LIMIT $1`;
const RECOVERING_TOPOLOGY_SQL = `SELECT id::text AS id, operation, source_id, request_id::text AS request_id, (state='recovering' AND recovery IS NULL) AS admission,
     COALESCE(outcome->>'expired_only','false')='true' AS automatic FROM persistence_topology_changes
     WHERE state='recovering' OR recovery IS NOT NULL ORDER BY created_at LIMIT 20`;
const BLOCKING_EFFECTS_SQL = `SELECT e.id::text AS effect_id, e.kind, e.state, COALESCE(e.source_id, r.source_id) AS source_id, r.request_id::text AS request_id, e.error_code,
       e.recovery IS NOT NULL AS recovering,
       EXISTS (SELECT 1 FROM sources s WHERE s.id = r.source_id AND s.incarnation = r.source_incarnation AND NOT s.archived) AS source_live
     FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
     WHERE e.state IN ('queued','running') OR e.recovery IS NOT NULL ORDER BY e.id LIMIT 50`;
const FAILED_EFFECTS_SQL = `SELECT e.id::text AS effect_id, e.kind, e.state, COALESCE(e.source_id, r.source_id) AS source_id, r.request_id::text AS request_id, e.error_code,
       e.recovery IS NOT NULL AS recovering,
       EXISTS (SELECT 1 FROM sources s WHERE s.id = r.source_id AND s.incarnation = r.source_incarnation AND NOT s.archived) AS source_live
     FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
     WHERE e.state='failed' AND e.recovery IS NULL AND NOT (e.data ? 'settled') ORDER BY e.id LIMIT 50`;
const LIVE_LEASES_SQL = 'SELECT id, holder_host, holder_pid FROM gbrain_cycle_locks WHERE ttl_expires_at > now() AND NOT starts_with(id, $1) ORDER BY id COLLATE "C"';
const LIVE_WORKTREE_ROOTS_SQL = `SELECT w.id::text AS id, h.local_path AS root FROM persistence_worktrees w
      LEFT JOIN persistence_host_bindings h ON h.worktree_id=w.id WHERE w.state<>'retired' ORDER BY w.id, h.local_path COLLATE "C"`;
const CLAIM_ROOTS_SQL = `SELECT b.source_id, b.worktree_id::text AS worktree_id, h.local_path AS root
    FROM persistence_source_bindings b LEFT JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id ORDER BY b.source_id COLLATE "C", h.local_path COLLATE "C"`;
const LIVE_BOUND_SOURCES_SQL = `SELECT COUNT(*)::integer AS count FROM persistence_source_bindings b
      JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation WHERE NOT s.archived`;
const SOURCES_SQL = "SELECT id,incarnation,local_path,config->>'kind' AS kind FROM sources WHERE archived=false ORDER BY id COLLATE \"C\"";
const SOURCES_FOR_UPDATE_SQL = "SELECT id,incarnation,local_path,config->>'kind' AS kind FROM sources WHERE archived=false ORDER BY id COLLATE \"C\" FOR UPDATE";
const ENABLE_SQL = 'UPDATE persistence_brain SET enabled=true,activated_at=COALESCE(activated_at,now()),mode_epoch=mode_epoch+1 WHERE singleton=1 RETURNING mode_epoch::text';
const DISABLE_SQL = 'UPDATE persistence_brain SET enabled=false, mode_epoch=mode_epoch+1 WHERE singleton=1 RETURNING mode_epoch::text';
const AUDIT_PAGES_SQL = `SELECT slug, source_path, source_uri, database_only_reason,
    octet_length(compiled_truth)+octet_length(COALESCE(timeline,''))+octet_length(frontmatter::text) AS bytes
    FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND page_kind='markdown' AND slug COLLATE "C">$2
    ORDER BY slug COLLATE "C" LIMIT $3`;
const ADD_COUNTERS_SQL = `UPDATE persistence_counters SET lifetime_ids=lifetime_ids+$2,terminal_bytes=terminal_bytes+$3,
    outstanding_count=outstanding_count+$4,intent_bytes=intent_bytes+$5,recovery_bytes=recovery_bytes+$6 WHERE key=$1`;

type RawSql = Pick<BrainEngine, 'executeRaw'>;

/** The SQL store over `exec` (a transaction-bound engine inside a transaction). */
export function sqlWriterReleaseStore(exec: RawSql): WriterReleaseStore {
  const count = async (sql: string) => Number((await exec.executeRaw<{ n: number }>(sql))[0]?.n ?? 0);
  return {
    async begin(lockTimeoutMs) {
      await exec.executeRaw("SELECT set_config('lock_timeout',$1,true),set_config('synchronous_commit','on',true)", [`${lockTimeoutMs}ms`]);
    },
    async adminLockValue() {
      const [row] = await exec.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1', [WRITER_ADMIN_LOCK_KEY]);
      return row?.value ?? null;
    },
    async shareBrain() { await exec.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR SHARE'); },
    async lockWorktreesAndSources() {
      await exec.executeRaw('SELECT id FROM persistence_worktrees ORDER BY id FOR UPDATE');
      await exec.executeRaw('SELECT id FROM sources ORDER BY id FOR UPDATE');
    },
    async lockCycleLocks() { await exec.executeRaw('LOCK TABLE gbrain_cycle_locks IN SHARE ROW EXCLUSIVE MODE'); },
    async shareWorktree(id) { await exec.executeRaw('SELECT id FROM persistence_worktrees WHERE id=$1::uuid FOR SHARE', [id]); },
    blockingRequests: limit => exec.executeRaw<BlockingRequestRow>(BLOCKING_REQUESTS_SQL, [limit]),
    recoveringTopologyChanges: () => exec.executeRaw<RecoveringTopologyRow>(RECOVERING_TOPOLOGY_SQL),
    releaseEffects: which => exec.executeRaw<ReleaseEffectRow>(which === 'failed' ? FAILED_EFFECTS_SQL : BLOCKING_EFFECTS_SQL),
    async hasRecoveringEffect() { return (await exec.executeRaw('SELECT id FROM persistence_effects WHERE recovery IS NOT NULL LIMIT 1')).length > 0; },
    liveLeases: () => exec.executeRaw<LiveLeaseRow>(LIVE_LEASES_SQL, [PAGE_EMBEDDING_LEASE_PREFIX]),
    liveWorktreeRoots: () => exec.executeRaw<WorktreeRootRow>(LIVE_WORKTREE_ROOTS_SQL),
    claimRoots: () => exec.executeRaw<ClaimRootRow>(CLAIM_ROOTS_SQL),
    async boundSourceIds() {
      return (await exec.executeRaw<{ id: string }>('SELECT source_id AS id FROM persistence_source_bindings ORDER BY source_id COLLATE "C"')).map(row => row.id);
    },
    sourceBindingCount: () => count('SELECT COUNT(*)::int AS n FROM persistence_source_bindings'),
    async liveBoundSourceCount() { return Number((await exec.executeRaw<{ count: number }>(LIVE_BOUND_SOURCES_SQL))[0]?.count ?? 0); },
    writerProtocolCount: () => count('SELECT COUNT(*)::int AS n FROM persistence_writer_protocols'),
    configuredSources: lock => exec.executeRaw<ReleaseSourceRow>(lock ? SOURCES_FOR_UPDATE_SQL : SOURCES_SQL),
    async ownerHostBinding(worktreeId, hostId) {
      const [row] = await exec.executeRaw<{ local_path: string; coordination_path: string }>(
        'SELECT local_path,coordination_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid', [worktreeId, hostId]);
      return row ?? null;
    },
    async sourceLocalPaths() {
      return (await exec.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE local_path IS NOT NULL')).map(row => row.local_path);
    },
    async hostBindingRoots() {
      return (await exec.executeRaw<{ local_path: string }>('SELECT local_path FROM persistence_host_bindings')).map(row => row.local_path);
    },
    async setBrainEnabled(enabled) {
      const [row] = await exec.executeRaw<{ mode_epoch: string }>(enabled ? ENABLE_SQL : DISABLE_SQL);
      return row.mode_epoch;
    },
    async releaseBindings(worktreeIds) {
      if (worktreeIds === null) {
        await exec.executeRaw("UPDATE persistence_worktrees SET state='retired' WHERE state<>'retired'");
        await exec.executeRaw('DELETE FROM persistence_source_bindings');
        await exec.executeRaw('DELETE FROM persistence_host_bindings');
        return;
      }
      await exec.executeRaw("UPDATE persistence_worktrees SET state='retired' WHERE id=ANY($1::uuid[]) AND state<>'retired'", [worktreeIds]);
      await exec.executeRaw('DELETE FROM persistence_source_bindings');
      await exec.executeRaw('DELETE FROM persistence_host_bindings WHERE worktree_id=ANY($1::uuid[])', [worktreeIds]);
    },
    async auditPages(sourceId, after, limit) {
      const rows = await exec.executeRaw<AuditPageRow>(AUDIT_PAGES_SQL, [sourceId, after, limit]);
      return rows.map(row => ({ ...row, bytes: row.bytes === null ? null : Number(row.bytes) }));
    },
  };
}

/** `writerReleaseStore()` on PGLite and Postgres. */
export async function writerReleaseStore(exec: RawSql): Promise<WriterReleaseStore> {
  return sqlWriterReleaseStore(exec);
}

/** `addPersistenceCounters(key, delta)` on PGLite and Postgres: one UPDATE; an absent column adds 0. */
export async function addPersistenceCounters(exec: RawSql, key: string, delta: Partial<Record<CounterColumn, number>>): Promise<void> {
  await exec.executeRaw(ADD_COUNTERS_SQL, [key, delta.lifetime_ids ?? 0, delta.terminal_bytes ?? 0, delta.outstanding_count ?? 0,
    delta.intent_bytes ?? 0, delta.recovery_bytes ?? 0]);
}
