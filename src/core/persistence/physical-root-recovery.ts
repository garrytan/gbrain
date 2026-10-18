import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { digest } from './digest.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { adoptTransferredRootStamp, assertNoPhysicalRootOverlap, assertPhysicalRoot, physicalRootError,
  readPhysicalRootReservation, readPhysicalRootStamp, replacePhysicalRootReservation, restorePhysicalRootReservation,
  type PhysicalRootReservation, type PhysicalRootStamp } from './physical-root-record.ts';

type Identity = Pick<PhysicalRootReservation, 'brainId' | 'worktreeId' | 'hostId' | 'coordinationPath'>;
export interface PhysicalRootRecovery {
  hostId: string;
  before: { reservation: PhysicalRootReservation | null; stamp: PhysicalRootStamp | null };
  reservation: PhysicalRootReservation;
  stamp: PhysicalRootStamp;
  /** #5914: prepared with `--confirm-relocated-root`; the inode and birth comparisons were waived and accept must repeat the flag. */
  relocated?: true;
}

/**
 * `relocated` (#5914, `--confirm-relocated-root`) waives only the inode and
 * birth-time comparisons of a directory recreated at the same path. It needs
 * the outside-root reservation (a copied in-root stamp alone is never
 * authority) and every other field to agree; the returned reservation carries
 * the live directory identity so the repair re-stamps from it.
 */
export function inspectPhysicalRootRecovery(root: string, identity: Identity & { token?: string }, opts: { relocated?: boolean } = {}): PhysicalRootRecovery {
  if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) throw physicalRootError();
  const rel = relative(root, identity.coordinationPath);
  if (canonicalFilesystemPath(identity.coordinationPath) !== identity.coordinationPath
    || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) throw physicalRootError();
  const reservation = readPhysicalRootReservation(root), stamp = readPhysicalRootStamp(root), info = statSync(root, { bigint: true });
  if (!info.isDirectory()) throw physicalRootError();
  if (opts.relocated && !reservation) throw physicalRootError('No ownership reservation exists beside this checkout, so the relocation cannot be confirmed; a copied stamp alone is not authority.');
  if (reservation && (reservation.brainId !== identity.brainId || reservation.worktreeId !== identity.worktreeId
    || reservation.coordinationPath !== identity.coordinationPath)) throw physicalRootError();
  const sameDirectory = (inode: string, birth: string) => opts.relocated || inode === info.ino.toString() && birth === info.birthtimeNs.toString();
  if (stamp && (stamp.brainId !== identity.brainId || stamp.worktreeId !== identity.worktreeId || stamp.root !== root
    || reservation && stamp.token !== reservation.token || !sameDirectory(stamp.inode, stamp.birth))) throw physicalRootError();
  if (!stamp && reservation && !sameDirectory(reservation.initialInode ?? '', reservation.initialBirth ?? '')) throw physicalRootError();
  assertNoPhysicalRootOverlap(root);
  const live = { initialDevice: info.dev.toString(), initialInode: info.ino.toString(), initialBirth: info.birthtimeNs.toString() };
  const target: PhysicalRootReservation = reservation ? opts.relocated ? { ...reservation, ...live } : reservation
    : { version: 1, ...identity, root, token: stamp?.token ?? identity.token ?? randomUUID(), ...live };
  return { hostId: identity.hostId, before: { reservation, stamp }, reservation: target, stamp: { version: 1, token: target.token,
    brainId: target.brainId, worktreeId: target.worktreeId, root, device: info.dev.toString(), inode: info.ino.toString(), birth: info.birthtimeNs.toString() },
    ...(opts.relocated ? { relocated: true as const } : {}) };
}

export function repairPhysicalRoot(root: string, recovery: PhysicalRootRecovery,
  identity: Omit<Identity, 'brainId'>, dryRun = false): void {
  const target = recovery.reservation;
  if (target.root !== root || target.worktreeId !== identity.worktreeId || recovery.hostId !== identity.hostId
    || target.coordinationPath !== identity.coordinationPath) throw physicalRootError();
  const current = inspectPhysicalRootRecovery(root, { ...target, hostId: identity.hostId }, { relocated: recovery.relocated === true });
  const same = (a: unknown, b: unknown) => digest(a) === digest(b);
  if (!same(current.stamp, recovery.stamp)
    || !same(current.before.reservation, recovery.before.reservation) && !same(current.before.reservation, target)
    || !same(current.before.stamp, recovery.before.stamp) && !same(current.before.stamp, recovery.stamp)) throw physicalRootError('Physical identity changed after transfer preparation; inspect the retained recovery state.');
  if (dryRun) return;
  if (recovery.relocated && recovery.before.reservation) replacePhysicalRootReservation(root, recovery.before.reservation, target);
  else restorePhysicalRootReservation(target);
  if (!same(readPhysicalRootReservation(root), target)) throw physicalRootError();
  adoptTransferredRootStamp(root, target, target.token);
  assertPhysicalRoot(root, identity);
}
