/**
 * Writer activation, deactivation and the pre-activation claim release (BrainEngine writerReleaseStore and
 * addPersistenceCounters; SQL in engine-sql/writer-release.ts), served from the store's brain-mode, binding, request,
 * effect, topology, source and cycle-lock records.
 *
 * - `writerReleaseStore` returns the same narrow store the SQL engines return. Each read is one
 *   `writerReleaseRows({ kind, ... })` call (gbrain-store `persistence::ReleaseRead`) with the rows of the SQL it
 *   replaces. `begin`, `shareBrain`, `lockWorktreesAndSources`, `lockCycleLocks` and `shareWorktree` change nothing:
 *   the store commits durably and runs one write transaction at a time. `writerProtocolCount` is 0: no writer protocol
 *   registration exists on this engine. `ownerHostBinding` is the claim's host-binding read.
 * - `setBrainEnabled` moves the stored brain mode (gbrain-store `persistence::worktrees::release`), which
 *   `readWriterAdminState`, `readManagedModeRows`, `readLedgerSource` and `readSyncDispatchRow` report.
 * - `auditPages` reads the page records; slugs sort by byte, the store keeps no `database_only_reason` (always null),
 *   and the frontmatter size counts its compact JSON text (only the audit's 5 MB skip reads it).
 * - `addPersistenceCounters` adds to one existing counter row; a missing row changes nothing, and a column that would go
 *   below zero refuses as the CHECK does.
 *
 * What each member answers and why: rust/docs/store/persistence.md ("Writer release").
 */
import type { CounterColumn, WriterReleaseStore } from '../../engine-sql/writer-release.ts';
import { WRITER_ADMIN_LOCK_KEY } from '../../persistence/admin-contract.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';

const MEMBER = 'writerReleaseStore';

/** The stored brain mode: `enabled` and `mode_epoch` (text) of the persistence brain row. */
export async function readBrainMode(brain: StoreBrain, member: string): Promise<{ enabled: boolean; mode_epoch: string }> {
  return storeCall({ member }, () => brain.writerReleaseRows({ kind: 'brain_mode' }));
}

function rustWriterReleaseStore(brain: StoreBrain): WriterReleaseStore {
  const call = <T>(run: () => Promise<T>): Promise<T> => storeCall({ member: MEMBER }, run);
  const rows = <T>(kind: string, args: Record<string, unknown> = {}): Promise<T> =>
    call<T>(() => brain.writerReleaseRows({ kind, ...args }));
  const none = async () => {};
  return {
    begin: none,
    adminLockValue: () => call<string | null>(() => brain.getConfig(WRITER_ADMIN_LOCK_KEY)),
    shareBrain: none,
    lockWorktreesAndSources: none,
    lockCycleLocks: none,
    shareWorktree: none,
    blockingRequests: limit => rows('blocking_requests', { limit }),
    recoveringTopologyChanges: () => rows('recovering_topology_changes'),
    releaseEffects: which => rows('release_effects', { which }),
    hasRecoveringEffect: () => rows('has_recovering_effect'),
    liveLeases: () => rows('live_leases'),
    liveWorktreeRoots: () => rows('live_worktree_roots'),
    claimRoots: () => rows('claim_roots'),
    boundSourceIds: () => rows('bound_source_ids'),
    sourceBindingCount: () => rows('source_binding_count'),
    liveBoundSourceCount: () => rows('live_bound_source_count'),
    writerProtocolCount: async () => 0,
    configuredSources: () => rows('configured_sources'),
    ownerHostBinding: (worktreeId, hostId) => call(() => brain.readHostBinding(worktreeId, hostId)),
    sourceLocalPaths: () => rows('source_local_paths'),
    hostBindingRoots: () => rows('host_binding_roots'),
    setBrainEnabled: enabled => call<string>(() => brain.setBrainEnabled(enabled)),
    async releaseBindings(worktreeIds) { await call(() => brain.releaseWorktreeBindings(worktreeIds === null ? null : [...worktreeIds])); },
    auditPages: (sourceId, after, limit) => rows('audit_pages', { sourceId, after, limit }),
  };
}

/** `writerReleaseStore()`: the release store over this engine's store handle; called on a transaction, every call runs in it. */
export const writerReleaseStore = async function writerReleaseStore(this: RustEngine, brain: StoreBrain): Promise<WriterReleaseStore> {
  return rustWriterReleaseStore(brain);
};

/** `addPersistenceCounters(key, delta)`. */
export const addPersistenceCounters = async function addPersistenceCounters(
  this: RustEngine, brain: StoreBrain, key: string, delta: Partial<Record<CounterColumn, number>>,
): Promise<void> {
  await storeCall({ member: 'addPersistenceCounters' }, () => brain.addPersistenceCounters(key, { ...delta }));
};
