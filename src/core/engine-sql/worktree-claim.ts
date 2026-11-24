/**
 * The unmanaged writer claim's store work (`claimWorktreeBinding` over `BrainEngine.worktreeClaimStore`, Rust engine lane 9, option A):
 * one transaction that locks the brain row, then hands the claim (persistence/ownership.ts `claimWorktree`) a store for
 * the source lock, the writer-admin checks, the binding reads and the three binding inserts. The reads are the claim's
 * statements; the inserts name every column with the column defaults the claim relied on, so PGLite and Postgres keep
 * the same rows. What the rows mean (which claim is a transfer, which
 * root overlaps, the physical-root files) stays with the claim. A Rust brain hands it the same store over its own
 * binding records (src/core/rust-engine/store-members/worktree-claim.ts).
 */
import type { BrainEngine } from '../engine.ts';
import { assertWriterAdminState } from '../persistence/admin-intent.ts';
import { assertWriterAdminUnlocked } from '../persistence/admin-lock.ts';
import type { WorktreeBinding } from './write-misc.ts';

/** A source as the claim locks it; null when the source is not registered. */
export interface ClaimSourceRow { incarnation: string; archived: boolean }
/** One of a host's worktrees, with its owner: what the claim checks a new root against for overlap. */
export interface HostWorktreeRow { worktree_id: string; local_path: string; coordination_path: string; owner_host_id: string | null }
/** A worktree's owner and state; what `claimPhysicalRoot` checks before it records a root. */
export interface ClaimWorktreeRow { owner_host_id: string | null; state: string }
/** A worktree's paths on one host. */
export interface ClaimHostBindingRow { local_path: string; coordination_path: string }

/** `persistence_worktrees` columns; the left-out ones take the column defaults (owner_epoch 0, generation 1, active). */
export interface WorktreeInsert {
  id: string; ownerHostId: string | null; ownerEpoch?: number; topologyGeneration?: number;
  state?: 'active' | 'draining' | 'recovering'; manifest?: Record<string, unknown> | null;
}
export interface HostBindingInsert { worktreeId: string; hostId: string; localPath: string; coordinationPath: string; gitDurability?: 'enabled' | 'disabled' | null }
export interface SourceBindingInsert { sourceId: string; incarnation: string; worktreeId: string; relativePath: string; topologyGeneration?: number }

/** The store a claim body works through; every call runs in the claim's one transaction. */
export interface WorktreeClaimStore {
  /** The writer-admin state check (`--expected-state`); a no-op when `expected` is undefined. */
  assertAdminState(expected: string | undefined): Promise<void>;
  /** Refuses `writer_admin_locked` while the operator lock is set. */
  assertAdminUnlocked(): Promise<void>;
  /** The source row, locked for the claim; null when it is not registered. */
  lockSource(sourceId: string): Promise<ClaimSourceRow | null>;
  /** The source's binding as host `hostId` sees it (`getWorktreeBinding`). */
  binding(sourceId: string, hostId: string | null): Promise<WorktreeBinding | null>;
  /** Every worktree host `hostId` binds, with its owner. */
  hostWorktrees(hostId: string): Promise<HostWorktreeRow[]>;
  /** The persistence brain id; null when the brain row is missing. */
  brainId(): Promise<string | null>;
  worktree(id: string): Promise<ClaimWorktreeRow | null>;
  hostBinding(worktreeId: string, hostId: string): Promise<ClaimHostBindingRow | null>;
  insertWorktree(row: WorktreeInsert): Promise<void>;
  insertHostBinding(row: HostBindingInsert): Promise<void>;
  insertSourceBinding(row: SourceBindingInsert): Promise<void>;
}

/** The claim body: the store and the transaction-bound engine (for the reads the claim shares with other callers). */
export type WorktreeClaimBody<T> = (store: WorktreeClaimStore, tx: BrainEngine) => Promise<T>;

/** The SQL store over a transaction-bound engine. */
export function sqlWorktreeClaimStore(tx: BrainEngine): WorktreeClaimStore {
  return {
    assertAdminState: expected => assertWriterAdminState(tx, expected),
    assertAdminUnlocked: () => assertWriterAdminUnlocked(tx),
    async lockSource(sourceId) {
      const [row] = await tx.executeRaw<ClaimSourceRow>('SELECT incarnation,archived FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
      return row ?? null;
    },
    binding: (sourceId, hostId) => tx.getWorktreeBinding(sourceId, hostId),
    hostWorktrees: hostId => tx.executeRaw<HostWorktreeRow>(
      `SELECT h.*,w.owner_host_id FROM persistence_host_bindings h JOIN persistence_worktrees w ON w.id=h.worktree_id WHERE h.host_id=$1::uuid`, [hostId]),
    async brainId() {
      const [brain] = await tx.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1');
      return brain?.brain_id ?? null;
    },
    async worktree(id) {
      const [row] = await tx.executeRaw<ClaimWorktreeRow>('SELECT owner_host_id,state FROM persistence_worktrees WHERE id=$1::uuid', [id]);
      return row ?? null;
    },
    async hostBinding(worktreeId, hostId) {
      const [row] = await tx.executeRaw<ClaimHostBindingRow>(
        'SELECT local_path,coordination_path FROM persistence_host_bindings WHERE worktree_id=$1::uuid AND host_id=$2::uuid', [worktreeId, hostId]);
      return row ?? null;
    },
    async insertWorktree(row) {
      await tx.executeRaw(`INSERT INTO persistence_worktrees(id,owner_host_id,owner_epoch,topology_generation,state,manifest)
        VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::text::jsonb)`, [row.id, row.ownerHostId, row.ownerEpoch ?? 0, row.topologyGeneration ?? 1,
        row.state ?? 'active', row.manifest == null ? null : JSON.stringify(row.manifest)]);
    },
    async insertHostBinding(row) {
      await tx.executeRaw(`INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path,git_durability)
        VALUES($1::uuid,$2::uuid,$3,$4,$5)`, [row.worktreeId, row.hostId, row.localPath, row.coordinationPath, row.gitDurability ?? null]);
    },
    async insertSourceBinding(row) {
      await tx.executeRaw(`INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id,relative_path,topology_generation)
        VALUES($1,$2::uuid,$3::uuid,$4,$5)`, [row.sourceId, row.incarnation, row.worktreeId, row.relativePath, row.topologyGeneration ?? 1]);
    },
  };
}

/** `worktreeClaimStore()` on PGLite and Postgres, called on a transaction: a synchronous commit, the brain row locked, then the store. */
export async function worktreeClaimStore(tx: BrainEngine): Promise<WorktreeClaimStore> {
  await tx.executeRaw("SELECT set_config('synchronous_commit','on',true)");
  await tx.executeRaw('SELECT singleton FROM persistence_brain WHERE singleton=1 FOR UPDATE');
  return sqlWorktreeClaimStore(tx);
}

/**
 * Runs the claim body in one `engine.transaction` with the transaction's claim store. The transaction starts on
 * `engine` itself, so a wrapper of `engine` (a test proxy, a recording engine) sees it.
 */
export function claimWorktreeBinding<T>(engine: BrainEngine, body: WorktreeClaimBody<T>): Promise<T> {
  return engine.transaction(async tx => body(await tx.worktreeClaimStore(), tx));
}
