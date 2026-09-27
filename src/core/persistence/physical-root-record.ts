import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import { sha256 } from './digest.ts';
import { canonicalFilesystemPath } from './root-registry.ts';

export const PHYSICAL_ROOT_MARKER = '.gbrain-owner.json';
const RESERVATION_PREFIX = '.gbrain-owner-';
export interface PhysicalRootReservation {
  version: 1; token: string; brainId: string; worktreeId: string; hostId: string;
  root: string; coordinationPath: string; initialDevice: string | null; initialInode: string | null; initialBirth: string | null;
}
interface PhysicalRootStamp { version: 1; token: string; brainId: string; worktreeId: string; root: string; device: string; inode: string; birth: string; }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
export function physicalRootError(message = 'The physical checkout identity changed or belongs to another owner.'): OperationError {
  return new OperationError('recovery_required', message, 'Use verified writer transfer or source recovery; do not remove ownership markers to claim this path.');
}
export function isPhysicalRootMetadata(name: string): boolean {
  return name === PHYSICAL_ROOT_MARKER || /^\.gbrain-owner-[a-f0-9]{64}\.json$/.test(name);
}
export function physicalRootReservationPath(root: string): string {
  return join(dirname(root), `${RESERVATION_PREFIX}${sha256(root)}.json`);
}
function flushDirectory(path: string): void {
  let fd: number | undefined;
  try { fd = openSync(path, 'r'); fsyncSync(fd); }
  catch (error) { if (!(process.platform === 'win32' && ['EISDIR','EPERM','EINVAL','ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? ''))) throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function readPrivate(path: string): unknown | null {
  let fd: number | undefined;
  try {
    if (lstatSync(path).isSymbolicLink()) throw physicalRootError();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 16_384 || process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw physicalRootError();
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    if (!value || typeof value !== 'object') throw physicalRootError();
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw physicalRootError('The private physical-checkout identity cannot be verified.');
  } finally { if (fd !== undefined) closeSync(fd); }
}
/** Never rename over another claimant. A torn reservation remains a refusal. */
function createPrivate(path: string, value: unknown): boolean {
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw physicalRootError('Cannot reserve the physical checkout privately.'); }
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
  flushDirectory(dirname(path));
  return true;
}
export function readPhysicalRootReservation(path: string): PhysicalRootReservation | null {
  const root = canonicalFilesystemPath(path);
  const value = readPrivate(physicalRootReservationPath(root)) as PhysicalRootReservation | null;
  if (value === null) return null;
  if (value.version !== 1 || ![value.token,value.brainId,value.worktreeId,value.hostId].every(uuid)
    || value.root !== root || typeof value.coordinationPath !== 'string' || !isAbsolute(value.coordinationPath) || value.coordinationPath.includes('\0')
    || ![value.initialDevice,value.initialInode,value.initialBirth].every(part => part === null || typeof part === 'string' && /^\d+$/.test(part))) throw physicalRootError();
  const lockRelative = relative(root, value.coordinationPath);
  if (canonicalFilesystemPath(value.coordinationPath) !== value.coordinationPath
    || !isAbsolute(lockRelative) && lockRelative !== '..' && !lockRelative.startsWith(`..${sep}`)) throw physicalRootError('The stable coordination lock must live outside the canonical checkout.');
  return value;
}
export function reservePhysicalRootRecord(root: string, identity: Omit<PhysicalRootReservation, 'version' | 'token' | 'root' | 'initialDevice' | 'initialInode' | 'initialBirth'>): PhysicalRootReservation {
  const info = existsSync(root) ? statSync(root, { bigint: true }) : null;
  if (info && !info.isDirectory()) throw physicalRootError('The canonical checkout path is not a directory.');
  const value: PhysicalRootReservation = { version: 1, token: randomUUID(), root, ...identity,
    initialDevice: info?.dev.toString() ?? null, initialInode: info?.ino.toString() ?? null, initialBirth: info?.birthtimeNs.toString() ?? null };
  createPrivate(physicalRootReservationPath(root), value);
  return readPhysicalRootReservation(root)!;
}
/** Every contender reserves before this scan, so racing ancestor/child claims cannot both succeed. */
export function assertNoPhysicalRootOverlap(root: string): void {
  for (let parent = dirname(root); parent !== root; parent = dirname(parent)) {
    if (readPhysicalRootReservation(parent) || existsSync(join(parent, PHYSICAL_ROOT_MARKER))) throw physicalRootError('This path lies inside another reserved canonical root.');
    if (parent === dirname(parent)) break;
  }
  if (!existsSync(root)) return;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(RESERVATION_PREFIX) && entry.name.endsWith('.json') || directory !== root && entry.name === PHYSICAL_ROOT_MARKER) {
        throw physicalRootError('This root contains another reserved canonical root.');
      }
      if (entry.isDirectory()) visit(join(directory, entry.name));
    }
  };
  visit(root);
}
export function writePhysicalRootStamp(directory: string, reservation: PhysicalRootReservation): void {
  const info = statSync(directory, { bigint: true });
  if (!info.isDirectory()) throw physicalRootError();
  const stamp: PhysicalRootStamp = { version: 1, token: reservation.token, brainId: reservation.brainId, worktreeId: reservation.worktreeId,
    root: reservation.root, device: info.dev.toString(), inode: info.ino.toString(), birth: info.birthtimeNs.toString() };
  createPrivate(join(directory, PHYSICAL_ROOT_MARKER), stamp);
  assertPhysicalRootStamp(directory, reservation);
}
/** directory may be a verified staging directory; its stamp always names the final root. */
export function assertPhysicalRootStamp(directory: string, reservation: PhysicalRootReservation): void {
  const value = readPrivate(join(directory, PHYSICAL_ROOT_MARKER)) as PhysicalRootStamp | null;
  const info = statSync(directory, { bigint: true });
  if (!value || value.version !== 1 || value.token !== reservation.token || value.brainId !== reservation.brainId || value.worktreeId !== reservation.worktreeId
    || value.root !== reservation.root || value.device !== info.dev.toString() || value.inode !== info.ino.toString() || value.birth !== info.birthtimeNs.toString()) throw physicalRootError();
}
/** Explicit verified transfer may adopt a copied stamp of this same logical worktree. */
export function adoptTransferredRootStamp(directory: string, reservation: PhysicalRootReservation): void {
  const path = join(directory, PHYSICAL_ROOT_MARKER);
  const previous = readPrivate(path) as PhysicalRootStamp | null;
  if (previous && (previous.brainId !== reservation.brainId || previous.worktreeId !== reservation.worktreeId)) throw physicalRootError();
  if (!previous) { writePhysicalRootStamp(directory, reservation); return; }
  try { assertPhysicalRootStamp(directory, reservation); return; } catch { /* verified transfer installs the new local inode stamp */ }
  const info = statSync(directory, { bigint: true });
  const stamp: PhysicalRootStamp = { version: 1, token: reservation.token, brainId: reservation.brainId, worktreeId: reservation.worktreeId,
    root: reservation.root, device: info.dev.toString(), inode: info.ino.toString(), birth: info.birthtimeNs.toString() };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { createPrivate(temporary, stamp); renameSync(temporary, path); flushDirectory(directory); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  assertPhysicalRootStamp(directory, reservation);
}
export function assertPhysicalRoot(path: string, identity: { worktreeId: string; coordinationPath?: string | null }): void {
  try {
    const root = realpathSync(path);
    if (root !== path || lstatSync(path).isSymbolicLink()) throw physicalRootError();
    const reservation = readPhysicalRootReservation(root);
    if (!reservation || reservation.worktreeId !== identity.worktreeId || identity.coordinationPath && reservation.coordinationPath !== identity.coordinationPath) throw physicalRootError();
    assertPhysicalRootStamp(root, reservation);
  } catch (error) { if (error instanceof OperationError) throw error; throw physicalRootError(); }
}
