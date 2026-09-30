import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { digest } from './digest.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { adoptTransferredRootStamp, assertNoPhysicalRootOverlap, assertPhysicalRoot, physicalRootError,
  readPhysicalRootReservation, readPhysicalRootStamp, restorePhysicalRootReservation,
  type PhysicalRootReservation, type PhysicalRootStamp } from './physical-root-record.ts';

type Identity = Pick<PhysicalRootReservation, 'brainId' | 'worktreeId' | 'hostId' | 'coordinationPath'>;
export interface PhysicalRootRecovery {
  hostId: string;
  before: { reservation: PhysicalRootReservation | null; stamp: PhysicalRootStamp | null };
  reservation: PhysicalRootReservation;
  stamp: PhysicalRootStamp;
}

export function inspectPhysicalRootRecovery(root: string, identity: Identity & { token?: string }): PhysicalRootRecovery {
  if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) throw physicalRootError();
  const rel = relative(root, identity.coordinationPath);
  if (canonicalFilesystemPath(identity.coordinationPath) !== identity.coordinationPath
    || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) throw physicalRootError();
  const reservation = readPhysicalRootReservation(root), stamp = readPhysicalRootStamp(root), info = statSync(root, { bigint: true });
  if (!info.isDirectory()) throw physicalRootError();
  if (reservation && (reservation.brainId !== identity.brainId || reservation.worktreeId !== identity.worktreeId
    || reservation.coordinationPath !== identity.coordinationPath)) throw physicalRootError();
  if (stamp && (stamp.brainId !== identity.brainId || stamp.worktreeId !== identity.worktreeId || stamp.root !== root
    || reservation && stamp.token !== reservation.token || stamp.inode !== info.ino.toString() || stamp.birth !== info.birthtimeNs.toString())) throw physicalRootError();
  if (!stamp && reservation && (reservation.initialInode !== info.ino.toString() || reservation.initialBirth !== info.birthtimeNs.toString())) throw physicalRootError();
  assertNoPhysicalRootOverlap(root);
  const target: PhysicalRootReservation = reservation ?? { version: 1, ...identity, root, token: stamp?.token ?? identity.token ?? randomUUID(),
    initialDevice: info.dev.toString(), initialInode: info.ino.toString(), initialBirth: info.birthtimeNs.toString() };
  return { hostId: identity.hostId, before: { reservation, stamp }, reservation: target, stamp: { version: 1, token: target.token,
    brainId: target.brainId, worktreeId: target.worktreeId, root, device: info.dev.toString(), inode: info.ino.toString(), birth: info.birthtimeNs.toString() } };
}

export function repairPhysicalRoot(root: string, recovery: PhysicalRootRecovery,
  identity: Omit<Identity, 'brainId'>, dryRun = false): void {
  const target = recovery.reservation;
  if (target.root !== root || target.worktreeId !== identity.worktreeId || recovery.hostId !== identity.hostId
    || target.coordinationPath !== identity.coordinationPath) throw physicalRootError();
  const current = inspectPhysicalRootRecovery(root, { ...target, hostId: identity.hostId });
  const same = (a: unknown, b: unknown) => digest(a) === digest(b);
  if (!same(current.stamp, recovery.stamp)
    || !same(current.before.reservation, recovery.before.reservation) && !same(current.before.reservation, target)
    || !same(current.before.stamp, recovery.before.stamp) && !same(current.before.stamp, recovery.stamp)) throw physicalRootError('Physical identity changed after transfer preparation; inspect the retained recovery state.');
  if (dryRun) return;
  restorePhysicalRootReservation(target);
  if (!same(readPhysicalRootReservation(root), target)) throw physicalRootError();
  adoptTransferredRootStamp(root, target, target.token);
  assertPhysicalRoot(root, identity);
}
