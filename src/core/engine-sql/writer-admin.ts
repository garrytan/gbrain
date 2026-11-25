
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
  /** Records a prepared transfer: state `draining`, the manifest with `prepared_at` set to now. */
  markWorktreeDraining(id: string, manifest: object): Promise<void>;
  /** Cancels a prepared transfer: state `active`, no manifest. */
  reactivateWorktree(id: string): Promise<void>;
  /** Records the accepting host's paths for the worktree, replacing the paths it had (its Git durability is kept). */
  upsertHostBinding(row: Omit<HostBindingInsert, 'gitDurability'>): Promise<void>;
  /** Accepts a transfer: `hostId` owns the worktree at the next epoch, `active`, heartbeat now; the manifest is kept. */
  acceptWorktreeOwner(id: string, hostId: string): Promise<void>;
}

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
