
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
