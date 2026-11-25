import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { SqlEngine } from './model.ts';
import type { WriterAdminStore } from '../engine-sql/writer-admin.ts';
import { repairWedgedReservation, resolveCoordinationLock } from './coordination-lock.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { requireManagedPersistence } from '../rust-engine/errors.ts';
import type { OperationError } from '../ops/contract.ts';
import { ownershipReservationMissingError } from './owner-marker.ts';
import { adoptTransferredRootStamp, assertNoPhysicalRootOverlap, assertPhysicalRoot, assertPhysicalRootStamp, describeMovedPhysicalRoot, lostReservationStamp, PHYSICAL_ROOT_MARKER, physicalRootDeviceChange, physicalRootError,
  physicalRootMovedError, physicalRootMovedRefusal, readPhysicalRootReservation, readPhysicalRootStamp, reservePhysicalRootRecord, restampPhysicalRootDevice, samePhysicalBirth, writePhysicalRootStamp,
  type MovedPhysicalRoot, type PhysicalRootReservation } from './physical-root-record.ts';

export { assertPhysicalRoot, isPhysicalRootMetadata, readPhysicalRootReservation } from './physical-root-record.ts';
export interface PhysicalRootClaim { hostId: string; worktreeId?: string; coordinationPath?: string; }
/**
 * The database facts a root claim checks: the brain id, a worktree's owner and state, and its host binding. The
 * default reads them with SQL on `tx`; the unmanaged claim passes its claim store (engine-sql/worktree-claim.ts), so a
 * Rust brain answers them from its binding records.
 */
export interface PhysicalRootFacts {
  brainId(): Promise<string | null>;
  worktree(id: string): Promise<{ owner_host_id: string | null; state: string } | null>;
  hostBinding(worktreeId: string, hostId: string): Promise<{ local_path: string; coordination_path: string } | null>;
}
function sqlPhysicalRootFacts(tx: SqlEngine): PhysicalRootFacts {
  // The facts come from the topology store (engine-sql/topology-store.ts), so a Rust brain answers them from its records.
  const store = () => (tx as unknown as Pick<BrainEngine, 'topologyStore'>).topologyStore();
  return {
    brainId: async () => (await store()).brainId(),
    worktree: async id => (await store()).worktreeOwner(id),
    hostBinding: async (worktreeId, hostId) => (await store()).hostBinding(worktreeId, hostId),
  };
}
async function brainIdentity(facts: Pick<PhysicalRootFacts, 'brainId'>): Promise<string> {
  const brainId = await facts.brainId();
  if (!brainId) throw physicalRootError();
  return brainId;
}
/**
 * Caller holds the brain/topology transaction guard. The private shared-path
 * reservation is a veto, never database ownership authority. It is deliberately
 * retained after a transaction rollback or process death.
 */
export async function reservePhysicalRoot(tx: SqlEngine, path: string, opts: PhysicalRootClaim,
  facts: PhysicalRootFacts = sqlPhysicalRootFacts(tx)): Promise<PhysicalRootReservation> {
  const root = canonicalFilesystemPath(path), brainId = await brainIdentity(facts);
  await repairWedgedReservation(facts, root, opts.hostId);
  const previous = readPhysicalRootReservation(root);
  const worktreeId = opts.worktreeId ?? previous?.worktreeId ?? randomUUID();
  const coordinationPath = opts.coordinationPath ?? resolveCoordinationLock(root, worktreeId, { reservation: previous?.coordinationPath }, opts.hostId).path;
  // A copied marker without its original sibling reservation is not a new root; a moved checkout is named, path-free (#8625).
  // #10260: a stamp that still identifies this exact directory lost only its reservation, which the plain self-transfer re-creates.
  if (!previous && existsSync(join(root, PHYSICAL_ROOT_MARKER))) throw await movedPhysicalRoot(tx, root, opts.hostId) ? physicalRootMovedError()
    : lostReservationStamp(root, { brainId }) ? ownershipReservationMissingError() : physicalRootError();
  const reservation = previous ?? reservePhysicalRootRecord(root, { brainId, worktreeId, hostId: opts.hostId, coordinationPath });
  if (reservation.brainId !== brainId || reservation.worktreeId !== worktreeId || reservation.coordinationPath !== coordinationPath) throw physicalRootError();
  const owner = await facts.worktree(worktreeId);
  if (owner ? owner.owner_host_id !== opts.hostId : reservation.hostId !== opts.hostId) throw physicalRootError('Another host owns or has prepared this physical checkout.');
  assertNoPhysicalRootOverlap(root);
  return reservation;
}
/**
 * #8625: the file evidence of a moved checkout at `path`, accepted only when this brain recorded it: the stamp's brain,
 * its worktree owned by `hostId`, and that worktree's host binding still at the recorded root. Read-only.
 */
export async function movedPhysicalRoot(tx: SqlEngine, path: string, hostId: string | null):
  Promise<(MovedPhysicalRoot & { members: Array<{ sourceId: string; relativePath: string }> }) | null> {
  const moved = describeMovedPhysicalRoot(canonicalFilesystemPath(path));
  if (!moved || !hostId) return null;
  requireManagedPersistence(tx, 'movedPhysicalRoot', 'it reads the managed worktree and source bindings a moved checkout belongs to');
  const store = await (tx as unknown as Pick<BrainEngine, 'topologyStore'>).topologyStore();
  const row = await store.movedRootRow(moved.worktreeId, hostId);
  if (row?.brain_id !== moved.brainId || row.owner_host_id !== hostId || row.local_path !== moved.recorded) return null;
  const members = await store.worktreeMembers(moved.worktreeId);
  return { ...moved, members: members.map(member => ({ sourceId: member.source_id, relativePath: member.relative_path })) };
}
/** #8625: the full moved-checkout refusal for a trusted local caller (paths, worktree, exit); null when `root` is no moved checkout of this host, or not of `recorded`. */
export async function movedPhysicalRootRefusal(tx: SqlEngine, root: string, exit: { sourceId: string; operation: 'add' | 'claim' | 'rebind' }, hostId: string | null,
  recorded?: string): Promise<OperationError | null> {
  const moved = await movedPhysicalRoot(tx, root, hostId);
  if (!moved || recorded !== undefined && moved.recorded !== recorded) return null;
  return physicalRootMovedRefusal(moved, { ...exit, members: moved.members });
}
/** Existing bindings require their stamp; only a never-committed original claim may finish creating it. */
export async function claimPhysicalRoot(tx: SqlEngine, path: string, opts: PhysicalRootClaim,
  facts: PhysicalRootFacts = sqlPhysicalRootFacts(tx)): Promise<PhysicalRootReservation> {
  const reservation = await reservePhysicalRoot(tx, path, opts, facts);
  const owner = await facts.worktree(reservation.worktreeId);
  if (owner && owner.state !== 'active') throw physicalRootError('Finish the prepared transfer or recovery before claiming this root.');
  const bound = await facts.hostBinding(reservation.worktreeId, opts.hostId);
  if (bound) {
    if (bound.local_path !== reservation.root || bound.coordination_path !== reservation.coordinationPath) throw physicalRootError('This worktree was rebound to a different checkout.');
    assertPhysicalRoot(reservation.root, reservation);
  }
  else {
    const info = statSync(reservation.root, { bigint: true });
    if (reservation.initialDevice !== info.dev.toString() || reservation.initialInode !== info.ino.toString() || !samePhysicalBirth(reservation.initialBirth, info.birthtimeNs)) throw physicalRootError();
    writePhysicalRootStamp(reservation.root, reservation);
  }
  return reservation;
}
/**
 * Only durable directory-swap recovery may stamp a different inode. The caller
 * has verified the canonical manifest and holds the stable outside-root lock.
 * Moving this stage to target preserves the stamp and immutable reservation.
 */
export async function preparePhysicalRootReplacement(tx: SqlEngine, stage: string, target: string,
  opts: Required<PhysicalRootClaim>): Promise<void> {
  const reservation = await reservePhysicalRoot(tx, target, opts);
  const owner = await (await (tx as unknown as Pick<BrainEngine, 'topologyStore'>).topologyStore()).worktreeOwner(opts.worktreeId);
  if (owner?.owner_host_id !== opts.hostId || owner.state !== 'recovering') throw physicalRootError('A directory replacement requires durable source recovery.');
  if (existsSync(target)) assertPhysicalRoot(target, opts);
  writePhysicalRootStamp(stage, reservation);
  assertPhysicalRootStamp(stage, reservation);
}
/** Called only after the draining epoch and complete successor manifest were verified under SQL/native guards. */
/** A transfer accept's root claim, through the accept's writer-admin store (engine-sql/writer-admin.ts). */
export async function preparePhysicalRootTransfer(store: Pick<WriterAdminStore, 'brainId' | 'lockWorktree'>, path: string,
  opts: Required<PhysicalRootClaim> & { expectedEpoch: string }): Promise<void> {
  const owner = await store.lockWorktree(opts.worktreeId);
  if (owner?.state !== 'draining' || String(owner.owner_epoch) !== opts.expectedEpoch) throw physicalRootError();
  const root = canonicalFilesystemPath(path), brainId = await brainIdentity(store);
  const reservation = readPhysicalRootReservation(root) ?? reservePhysicalRootRecord(root,
    { brainId, worktreeId: opts.worktreeId, hostId: opts.hostId, coordinationPath: opts.coordinationPath });
  if (reservation.brainId !== brainId || reservation.worktreeId !== opts.worktreeId || reservation.coordinationPath !== opts.coordinationPath) throw physicalRootError();
  assertNoPhysicalRootOverlap(root);
  adoptTransferredRootStamp(root, reservation);
}

type DeviceChange = { from: string; to: string };
function restampRecovery(recovery: Record<string, any> | undefined, change: DeviceChange): boolean {
  let changed = false;
  for (const [record, field] of [[recovery?.before?.reservation, 'initialDevice'], [recovery?.before?.stamp, 'device'],
    [recovery?.reservation, 'initialDevice'], [recovery?.stamp, 'device']] as const) {
    if (record?.[field] === change.from) { record[field] = change.to; changed = true; }
  }
  return changed;
}
/**
 * #5604: re-stamp every persisted device copy (ownership stamp, reservation,
 * recorded self-transfer and retained topology staging identity) when only the
 * filesystem device id changed. The caller holds the outside-root native lock;
 * database ownership is verified in the same transaction that rewrites the
 * database copies, and the files are rewritten after it commits.
 */
export async function restampPhysicalRoot(engine: BrainEngine, binding: { worktree_id: string; local_path: string | null; coordination_path: string | null },
  hostId: string): Promise<DeviceChange | null> {
  const root = binding.local_path;
  if (!root || !binding.coordination_path || realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) return null;
  const reservation = readPhysicalRootReservation(root), stamp = readPhysicalRootStamp(root);
  if (!reservation || !stamp || reservation.worktreeId !== binding.worktree_id || reservation.coordinationPath !== binding.coordination_path) return null;
  const change = physicalRootDeviceChange(stamp, reservation, statSync(root, { bigint: true }));
  if (!change) return null;
  const applied = await engine.transaction(async tx => {
    const store = await tx.topologyStore();
    await store.synchronousCommit();
    const owner = await store.lockWorktreeManifest(binding.worktree_id);
    const brainId = await store.brainId();
    const bound = await store.hostBinding(binding.worktree_id, hostId);
    if (!owner || owner.owner_host_id !== hostId || brainId !== stamp.brainId
      || bound?.local_path !== root || bound.coordination_path !== binding.coordination_path) return false;
    const manifest = owner.manifest;
    if (manifest && restampRecovery(manifest.self_transfer, change)) {
      await store.setWorktreeManifest(binding.worktree_id, manifest);
    }
    const topology = await store.lockRecoveringChanges(binding.worktree_id);
    for (const row of topology) {
      const identity = row.recovery?.stageIdentity, stage = row.recovery?.stage;
      if (identity?.device !== change.from || typeof stage !== 'string' || !existsSync(stage)) continue;
      const info = lstatSync(stage, { bigint: true });
      if (!info.isDirectory() || info.ino.toString() !== identity.inode || info.birthtimeNs.toString() !== identity.birthNs || info.dev.toString() !== change.to) continue;
      identity.device = change.to;
      await store.restampChangeRecovery(row.id, row.recovery!);
    }
    return true;
  });
  if (!applied) return null;
  // Database copies commit first; each update is conditional on the old device, so
  // a crash before the files are rewritten leaves a device-only change that the next
  // locked acquisition re-stamps again.
  restampPhysicalRootDevice(root, reservation, stamp, change);
  process.stderr.write(`[persistence] physical root ${root} filesystem device id changed ${change.from} -> ${change.to}; inode, birth time and owner token matched, so every persisted copy was re-stamped.\n`);
  return change;
}
