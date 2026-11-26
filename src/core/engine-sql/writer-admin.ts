/**
 * Writer administration's store work (`gbrain sources writer claim|lock|unlock|transfer prepare|cancel`).
 *
 * - `readWriterAdminState` is the writer topology a reviewed `--expected-state` binds to: one jsonb document over the
 *   brain row, the sources, the fallback repo path, the worktrees, the bindings, the host bindings and the legacy cycle
 *   locks. persistence/admin-intent.ts hashes its text. Source ids and lock ids sort in byte order (`COLLATE "C"`), so
 *   the digest does not depend on the server's locale.
 * - `writerAdminTransaction` (over `BrainEngine.writerAdminStore`) runs the operator lock (persistence/admin-lock.ts) and transfer prepare,
 *   accept and cancel (persistence/ownership.ts) through a store, so the checks and the error texts stay in those files and a Rust brain
 *   hands them the same store over its own records (src/core/rust-engine/store-members/writer-admin.ts).
 * - `readWorktreeManifest` is the prepared manifest an accept reads before its transaction, to hash the successor in the
 *   scope the owner recorded.
 * - `sqlContentReceiptStore` is the content-receipt half of the store (shared-skills/receipt-root.ts), for a caller
 *   that holds a SQL transaction but no writer-admin store (`sources set-path`).
 */
import type { BrainEngine } from '../engine.ts';
import { PAGE_EMBEDDING_LEASE_PREFIX } from '../page-embedding-lease.ts';
import { assertWriterAdminState } from '../persistence/admin-intent.ts';
import { WRITER_ADMIN_LOCK_KEY } from '../persistence/admin-contract.ts';
import { assertWriterAdminUnlocked } from '../persistence/admin-lock.ts';
import type { StoredWorktreeManifest } from '../persistence/worktree-manifest.ts';
import type { HostBindingInsert } from './worktree-claim.ts';

export interface WriterAdminStateOptions {
  /**
   * Lock the brain row and the topology tables (SHARE ROW EXCLUSIVE) before the read, so the state cannot change
   * before the transaction commits. Only inside a transaction. A Rust brain runs one write transaction at a time and
   * ignores it.
   */
  lock?: boolean;
}

/** A worktree's owner, epoch (as text), state and prepared manifest, read for update. */
export interface WriterAdminWorktreeRow { owner_host_id: string | null; owner_epoch: string; state: string; manifest: StoredWorktreeManifest | null }

/** One content receipt a rebind may move: the source's binding, its root on the host, the brain id and the receipt config row. */
export interface ContentReceiptRow { source_id: string; incarnation: string; relative_path: string; local_path: string; brain_id: string; key: string; value: string }

/** What `rebindContentReceipts` (shared-skills/receipt-root.ts) reads and writes; every call runs in the caller's transaction. */
export interface ContentReceiptStore {
  /**
   * The receipt rows of the sources bound to `worktreeIds` (only `sourceIds` when given) at their current, unarchived
   * incarnation, with `hostId`'s binding root; source ids in byte order.
   */
  contentReceiptRows(worktreeIds: string[], hostId: string, sourceIds?: string[]): Promise<ContentReceiptRow[]>;
  /** Sets config `key` to `value` only while it still holds `expected`. */
  swapConfigValue(key: string, value: string, expected: string): Promise<void>;
}

/** The store a writer-administration body works through; every call runs in the body's one transaction. */
export interface WriterAdminStore extends ContentReceiptStore {
  /** Locks the brain row (FOR UPDATE): serializes lock and unlock with every claim, activation and transfer. */
  lockBrain(): Promise<void>;
  /** The reviewed `--expected-state` check, under the topology lock; a no-op when `expected` is undefined. */
  assertAdminState(expected: string | undefined): Promise<void>;
  /** Refuses `writer_admin_locked` while the operator lock is set. */
  assertAdminUnlocked(): Promise<void>;
  /** The stored operator-lock config value; null when unset. */
  adminLockValue(): Promise<string | null>;
  setAdminLockValue(value: string): Promise<void>;
  /** The first worktree (by id) with a prepared transfer nobody accepted; null when none. */
  preparedTransferWorktree(): Promise<string | null>;
  /** The database clock as `YYYY-MM-DDTHH:MM:SS.mmmZ`. */
  now(): Promise<string>;
  /** The worktree row, locked for the transfer; null when it is missing. */
  lockWorktree(id: string): Promise<WriterAdminWorktreeRow | null>;
  /** Whether a write request or a mirror effect of the worktree is still publishing or recovering. */
  publicationPending(worktreeId: string): Promise<boolean>;
  /** The persistence brain id; null when the brain row is missing. */
  brainId(): Promise<string | null>;
  /** The worktree's bound, unarchived sources that have a last imported commit, by source id (#10260: the Git history a self-transfer checks before it re-creates a lost ownership reservation). */
  syncedSources(worktreeId: string): Promise<Array<{ source: string; path: string; commit: string }>>;
  /** Records a prepared transfer: state `draining`, the manifest with `prepared_at` set to now. */
  markWorktreeDraining(id: string, manifest: object): Promise<void>;
  /** Cancels a prepared transfer: state `active`, no manifest. */
  reactivateWorktree(id: string): Promise<void>;
  /** Records the accepting host's paths for the worktree, replacing the paths it had (its Git durability is kept). */
  upsertHostBinding(row: Omit<HostBindingInsert, 'gitDurability'>): Promise<void>;
  /** Accepts a transfer: `hostId` owns the worktree at the next epoch, `active`, heartbeat now; the manifest is kept. */
  acceptWorktreeOwner(id: string, hostId: string): Promise<void>;
}

/** The body: the store and the transaction-bound engine (for the reads it shares with other callers). */
export type WriterAdminBody<T> = (store: WriterAdminStore, tx: BrainEngine) => Promise<T>;

type RawSql = Pick<BrainEngine, 'executeRaw'>;

const WRITER_ADMIN_STATE_SQL = `SELECT jsonb_build_object(
    'brain', (SELECT jsonb_build_object('id',brain_id,'enabled',enabled,
      'skill_bundles_enabled',to_jsonb(persistence_brain)->'skill_bundles_enabled',
      'writer_protocol_floor',to_jsonb(persistence_brain)->'writer_protocol_floor',
      'mode_epoch',to_jsonb(persistence_brain)->'mode_epoch') FROM persistence_brain WHERE singleton=1),
    'sources', (SELECT jsonb_agg(jsonb_build_array(id,incarnation,archived,local_path,config->>'kind') ORDER BY id COLLATE "C") FROM sources),
    'fallback', (SELECT value FROM config WHERE key='sync.repo_path'),
    'worktrees', (SELECT jsonb_agg(jsonb_build_array(id,owner_host_id,owner_epoch::text,topology_generation::text,state,manifest) ORDER BY id) FROM persistence_worktrees),
    'bindings', (SELECT jsonb_agg(jsonb_build_array(source_id,source_incarnation,worktree_id,relative_path,topology_generation::text) ORDER BY source_id COLLATE "C") FROM persistence_source_bindings),
    'hosts', (SELECT jsonb_agg(jsonb_build_array(worktree_id,host_id,local_path,coordination_path,git_durability) ORDER BY worktree_id,host_id) FROM persistence_host_bindings),
    'legacy_locks', (SELECT jsonb_agg(jsonb_build_array(id,holder_pid,holder_host,acquisition_token,acquired_at) ORDER BY id COLLATE "C") FROM gbrain_cycle_locks
      WHERE NOT starts_with(id, $1))
  )::text AS state`;

/** The worktree's recorded manifest; null when it has none or the worktree is missing. */
export async function readWorktreeManifest(engine: RawSql, worktreeId: string): Promise<StoredWorktreeManifest | null> {
  const [row] = await engine.executeRaw<{ manifest: StoredWorktreeManifest | null }>('SELECT manifest FROM persistence_worktrees WHERE id=$1::uuid', [worktreeId]);
  return row?.manifest ?? null;
}

/** The content-receipt store over a transaction-bound engine. */
export function sqlContentReceiptStore(tx: RawSql): ContentReceiptStore {
  return {
    contentReceiptRows: (worktreeIds, hostId, sourceIds) => tx.executeRaw<ContentReceiptRow>(
      `SELECT b.source_id,b.source_incarnation::text AS incarnation,b.relative_path,h.local_path,p.brain_id,c.key,c.value
         FROM persistence_source_bindings b
         JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation AND NOT s.archived
         JOIN persistence_host_bindings h ON h.worktree_id=b.worktree_id AND h.host_id=$2::uuid
         JOIN persistence_brain p ON p.singleton=1
         JOIN config c ON c.key='shared_skills.content.v1.'||b.source_id||'.'||b.source_incarnation::text
        WHERE b.worktree_id=ANY($1::uuid[]) AND ($3::text[] IS NULL OR b.source_id=ANY($3::text[])) ORDER BY b.source_id COLLATE "C"`,
      [worktreeIds, hostId, sourceIds ?? null]),
    async swapConfigValue(key, value, expected) {
      await tx.executeRaw('UPDATE config SET value=$2 WHERE key=$1 AND value=$3', [key, value, expected]);
    },
  };
}

/** The writer topology as jsonb text. A page embedding lease is per-page vector work, not writer topology, so it is left out. */
export async function readWriterAdminState(engine: RawSql, opts: WriterAdminStateOptions = {}): Promise<string> {
  if (opts.lock) {
    await engine.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
    await engine.executeRaw('LOCK TABLE sources, config, persistence_worktrees, persistence_source_bindings, persistence_host_bindings, gbrain_cycle_locks IN SHARE ROW EXCLUSIVE MODE');
  }
  const [row] = await engine.executeRaw<{ state: string }>(WRITER_ADMIN_STATE_SQL, [PAGE_EMBEDDING_LEASE_PREFIX]);
  return row.state;
}

/** The SQL store over a transaction-bound engine. */
export function sqlWriterAdminStore(tx: BrainEngine): WriterAdminStore {
  return {
    ...sqlContentReceiptStore(tx),
    async lockBrain() { await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE'); },
    assertAdminState: expected => assertWriterAdminState(tx, expected),
    assertAdminUnlocked: () => assertWriterAdminUnlocked(tx),
    async adminLockValue() {
      const [row] = await tx.executeRaw<{ value: string }>('SELECT value FROM config WHERE key=$1', [WRITER_ADMIN_LOCK_KEY]);
      return row?.value ?? null;
    },
    async setAdminLockValue(value) {
      await tx.executeRaw(`INSERT INTO config(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [WRITER_ADMIN_LOCK_KEY, value]);
    },
    async preparedTransferWorktree() {
      const [row] = await tx.executeRaw<{ id: string }>(`SELECT w.id FROM persistence_worktrees w
        WHERE w.state='draining' AND w.manifest IS NOT NULL ORDER BY w.id LIMIT 1`);
      return row?.id ?? null;
    },
    async now() {
      const [row] = await tx.executeRaw<{ at: string }>(`SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`);
      return row.at;
    },
    async lockWorktree(id) {
      const [row] = await tx.executeRaw<WriterAdminWorktreeRow>('SELECT owner_host_id,owner_epoch::text AS owner_epoch,state,manifest FROM persistence_worktrees WHERE id=$1::uuid FOR UPDATE', [id]);
      return row ?? null;
    },
    async publicationPending(worktreeId) {
      const pending = await tx.executeRaw(`SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND
        (state IN ('running','recovering') OR recovery IS NOT NULL) LIMIT 1`, [worktreeId]);
      if (pending.length) return true;
      const mirrors = await tx.executeRaw('SELECT id FROM persistence_effects WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1', [worktreeId]);
      return mirrors.length > 0;
    },
    async brainId() {
      const [brain] = await tx.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
      return brain?.brain_id ?? null;
    },
    async syncedSources(worktreeId) {
      const [row] = await tx.executeRaw<{ synced: Array<{ source: string; path: string; commit: string }> | null }>(`SELECT (SELECT json_agg(json_build_object('source',s.id,'path',b.relative_path,'commit',s.last_commit) ORDER BY s.id)
        FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation WHERE b.worktree_id=$1::uuid AND s.last_commit IS NOT NULL AND NOT s.archived) AS synced`, [worktreeId]);
      return row?.synced ?? [];
    },
    async markWorktreeDraining(id, manifest) {
      await tx.executeRaw(`UPDATE persistence_worktrees SET state='draining',manifest=$2::text::jsonb||jsonb_build_object('prepared_at',now()) WHERE id=$1::uuid`,
        [id, JSON.stringify(manifest)]);
    },
    async reactivateWorktree(id) {
      await tx.executeRaw(`UPDATE persistence_worktrees SET state='active',manifest=NULL WHERE id=$1::uuid`, [id]);
    },
    async upsertHostBinding(row) {
      await tx.executeRaw(`INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path)
        VALUES($1::uuid,$2::uuid,$3,$4) ON CONFLICT(worktree_id,host_id) DO UPDATE SET local_path=EXCLUDED.local_path,coordination_path=EXCLUDED.coordination_path`,
        [row.worktreeId, row.hostId, row.localPath, row.coordinationPath]);
    },
    async acceptWorktreeOwner(id, hostId) {
      await tx.executeRaw(`UPDATE persistence_worktrees SET owner_host_id=$2::uuid,owner_epoch=owner_epoch+1,state='active',heartbeat_at=now() WHERE id=$1::uuid`, [id, hostId]);
    },
  };
}

/** `writerAdminStore()` on PGLite and Postgres, called on a transaction: durable commit, then the store. */
export async function writerAdminStore(tx: BrainEngine): Promise<WriterAdminStore> {
  await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
  return sqlWriterAdminStore(tx);
}

/**
 * Runs `body` in one `engine.transaction` with the transaction's writer-admin store; the body takes the locks it needs
 * through the store. The transaction starts on `engine` itself, so a wrapper of `engine` sees it.
 */
export function writerAdminTransaction<T>(engine: BrainEngine, body: WriterAdminBody<T>): Promise<T> {
  return engine.transaction(async tx => body(await tx.writerAdminStore(), tx));
}
