import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import { gitChildEnv } from '../git-env.ts';
import { flushDirectory } from '../fs-durable.ts';
import { digest, sha256 } from './digest.ts';
import { canonicalFilesystemPath } from './root-registry.ts';
import { OWNERSHIP_MARKER_GLOBS, PHYSICAL_ROOT_MARKER } from './root-metadata.ts';

export { OWNERSHIP_MARKER_GLOBS, PHYSICAL_ROOT_MARKER, isPhysicalRootMetadata } from './root-metadata.ts';
const RESERVATION_PREFIX = '.gbrain-owner-';
/**
 * Appends the marker globs to the exclude file of every Git checkout holding
 * `directories` (resolved with `git rev-parse --git-path`, so a linked
 * worktree writes its shared file). Idempotent; a repository-local file, never
 * committed; a missing trailing newline is repaired first. Best effort: an
 * unreadable checkout or a read-only git dir leaves the stamp in place and the
 * push deny list as the backstop.
 */
export function excludeOwnershipMarkers(directories: readonly string[]): void {
  const written = new Set<string>();
  for (const directory of directories) {
    let exclude: string;
    try {
      if (!statSync(directory).isDirectory()) continue;
      const path = execFileSync('git', ['-C', directory, 'rev-parse', '--git-path', 'info/exclude'],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env: gitChildEnv() }).toString().trim();
      if (!path) continue;
      exclude = resolve(directory, path);
    } catch { continue; }
    if (written.has(exclude)) continue;
    written.add(exclude);
    try {
      mkdirSync(dirname(exclude), { recursive: true });
      const body = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
      const present = new Set(body.split('\n').map(line => line.trim()));
      const missing = OWNERSHIP_MARKER_GLOBS.filter(glob => !present.has(glob));
      if (!missing.length) continue;
      appendFileSync(exclude, `${body.length && !body.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
    } catch { /* best effort; the push deny list refuses a tracked marker */ }
  }
}
export interface PhysicalRootReservation {
  version: 1; token: string; brainId: string; worktreeId: string; hostId: string;
  root: string; coordinationPath: string; initialDevice: string | null; initialInode: string | null; initialBirth: string | null;
}
export interface PhysicalRootStamp { version: 1; token: string; brainId: string; worktreeId: string; root: string; device: string; inode: string; birth: string; }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
export function physicalRootError(message = 'The physical checkout identity changed or belongs to another owner.'): OperationError {
  return new OperationError('recovery_required', message, 'Use verified writer transfer or source recovery; do not remove ownership markers to claim this path.');
}
export function physicalRootReservationPath(root: string): string {
  return join(dirname(root), `${RESERVATION_PREFIX}${sha256(root)}.json`);
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
  return readReservationRecord(canonicalFilesystemPath(path));
}
/** #5914: the reservation written for `recorded` as it was recorded, even when that path now resolves elsewhere through a symlink. */
export function readRecordedPhysicalRootReservation(recorded: string): PhysicalRootReservation | null {
  return readReservationRecord(recorded);
}
function readReservationRecord(root: string): PhysicalRootReservation | null {
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
export function readPhysicalRootStamp(root: string): PhysicalRootStamp | null {
  const value = readPrivate(join(root, PHYSICAL_ROOT_MARKER)) as PhysicalRootStamp | null;
  if (value && (value.version !== 1 || ![value.token,value.brainId,value.worktreeId].every(uuid)
    || typeof value.root !== 'string' || !isAbsolute(value.root)
    || ![value.device,value.inode,value.birth].every(part => typeof part === 'string' && /^\d+$/.test(part)))) throw physicalRootError();
  return value;
}
export function restorePhysicalRootReservation(value: PhysicalRootReservation): void {
  createPrivate(physicalRootReservationPath(value.root), value);
}
export function reservePhysicalRootRecord(root: string, identity: Omit<PhysicalRootReservation, 'version' | 'token' | 'root' | 'initialDevice' | 'initialInode' | 'initialBirth'>): PhysicalRootReservation {
  const info = existsSync(root) ? statSync(root, { bigint: true }) : null;
  if (info && !info.isDirectory()) throw physicalRootError('The canonical checkout path is not a directory.');
  const value: PhysicalRootReservation = { version: 1, token: randomUUID(), root, ...identity,
    initialDevice: info?.dev.toString() ?? null, initialInode: info?.ino.toString() ?? null, initialBirth: info?.birthtimeNs.toString() ?? null };
  createPrivate(physicalRootReservationPath(root), value);
  return readPhysicalRootReservation(root)!;
}
/**
 * Every contender reserves before this scan, so racing ancestor/child claims cannot both succeed.
 * A subdirectory removed while the scan runs (git gc pruning loose objects) holds no reservation.
 */
export function assertNoPhysicalRootOverlap(root: string): void {
  for (let parent = dirname(root); parent !== root; parent = dirname(parent)) {
    if (readPhysicalRootReservation(parent) || existsSync(join(parent, PHYSICAL_ROOT_MARKER))) throw physicalRootError('This path lies inside another reserved canonical root.');
    if (parent === dirname(parent)) break;
  }
  if (!existsSync(root)) return;
  const visit = (directory: string) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (directory !== root && (code === 'ENOENT' || code === 'ENOTDIR')) return;
      throw error;
    }
    for (const entry of entries) {
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
  excludeOwnershipMarkers([directory, reservation.root, dirname(reservation.root)]);
}
/** directory may be a verified staging directory; its stamp always names the final root. */
export function assertPhysicalRootStamp(directory: string, reservation: PhysicalRootReservation): void {
  const value = readPrivate(join(directory, PHYSICAL_ROOT_MARKER)) as PhysicalRootStamp | null;
  const info = statSync(directory, { bigint: true });
  if (!value || value.version !== 1 || value.token !== reservation.token || value.brainId !== reservation.brainId || value.worktreeId !== reservation.worktreeId
    || value.root !== reservation.root || value.inode !== info.ino.toString() || value.birth !== info.birthtimeNs.toString()) throw physicalRootError();
  if (value.device !== info.dev.toString()) {
    if (typeof value.device === 'string' && /^\d+$/.test(value.device)) {
      const error = physicalRootError('The filesystem device identifier changed while the other checkout identity fields still match. Inspect writer status and use deliberate self-transfer to re-stamp this same root.');
      error.detail = 'physical_root_device_changed';
      throw error;
    }
    throw physicalRootError();
  }
}
/**
 * #5604: macOS may give the same checkout a new st_dev after a reboot. The
 * owner token binds the stamp, so a change is device-only when the stamp still
 * names this reservation, root, inode and a non-zero birth time. Filesystems
 * that report no birth time (some Linux mounts) keep the refusal.
 */
export function physicalRootDeviceChange(stamp: PhysicalRootStamp, reservation: Pick<PhysicalRootReservation, 'token' | 'brainId' | 'worktreeId' | 'root'>,
  info: { dev: bigint; ino: bigint; birthtimeNs: bigint }): { from: string; to: string } | null {
  if (stamp.token !== reservation.token || stamp.brainId !== reservation.brainId || stamp.worktreeId !== reservation.worktreeId
    || stamp.root !== reservation.root || stamp.inode !== info.ino.toString() || stamp.birth !== info.birthtimeNs.toString()
    || info.birthtimeNs === 0n || stamp.device === info.dev.toString()) return null;
  return { from: stamp.device, to: info.dev.toString() };
}
function replacePrivate(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    created = createPrivate(temporary, value);
    if (!created || digest(readPrivate(temporary)) !== digest(value)) throw physicalRootError('The re-stamped ownership record contains unexpected bytes.');
    renameSync(temporary, path); created = false; flushDirectory(dirname(path));
  } finally { if (created) try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
/**
 * #5914: compare-and-swap of the outside-root reservation for a deliberate
 * relocation (recreated directory, moved checkout). The caller holds the
 * outside-root native lock and verified database ownership. A reservation
 * already equal to `next` is a no-op; one that matches neither `expected` nor
 * `next` was changed by someone else and refuses with detail `stale_record`.
 */
export function replacePhysicalRootReservation(root: string, expected: PhysicalRootReservation, next: PhysicalRootReservation): void {
  if (next.root !== root || expected.root !== root || next.token !== expected.token || next.worktreeId !== expected.worktreeId || next.brainId !== expected.brainId) throw physicalRootError();
  const current = readPhysicalRootReservation(root);
  if (current && digest(current) === digest(next)) return;
  if (!current || digest(current) !== digest(expected)) {
    const error = physicalRootError('The ownership reservation changed since this relocation was prepared; prepare it again from a fresh writer status.');
    error.detail = 'stale_record';
    throw error;
  }
  replacePrivate(physicalRootReservationPath(root), next);
  if (digest(readPhysicalRootReservation(root)) !== digest(next)) throw physicalRootError('The re-stamped ownership reservation contains unexpected bytes.');
}
/** Caller holds the outside-root native lock and verified database ownership; only the device fields change. */
export function restampPhysicalRootDevice(root: string, reservation: PhysicalRootReservation, stamp: PhysicalRootStamp, change: { from: string; to: string }): void {
  if (reservation.initialDevice === change.from) replacePrivate(physicalRootReservationPath(root), { ...reservation, initialDevice: change.to });
  replacePrivate(join(root, PHYSICAL_ROOT_MARKER), { ...stamp, device: change.to });
  assertPhysicalRootStamp(root, readPhysicalRootReservation(root)!);
}
/** Explicit verified transfer may adopt a copied stamp of this same logical worktree. */
export function adoptTransferredRootStamp(directory: string, reservation: PhysicalRootReservation, temporaryToken: string = randomUUID()): void {
  const path = join(directory, PHYSICAL_ROOT_MARKER);
  const previous = readPrivate(path) as PhysicalRootStamp | null;
  if (previous && (previous.brainId !== reservation.brainId || previous.worktreeId !== reservation.worktreeId)) throw physicalRootError();
  if (previous) {
    try { assertPhysicalRootStamp(directory, reservation); return; } catch {}
  }
  const info = statSync(directory, { bigint: true });
  const stamp: PhysicalRootStamp = { version: 1, token: reservation.token, brainId: reservation.brainId, worktreeId: reservation.worktreeId,
    root: reservation.root, device: info.dev.toString(), inode: info.ino.toString(), birth: info.birthtimeNs.toString() };
  const temporary = `${path}.${temporaryToken}.tmp`;
  let created = false;
  try {
    created = createPrivate(temporary, stamp);
    if (digest(readPrivate(temporary)) !== digest(stamp)) throw physicalRootError('The prepared ownership stamp contains unexpected bytes.');
    renameSync(temporary, path); flushDirectory(directory);
  } finally { if (created) try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  assertPhysicalRootStamp(directory, reservation);
  excludeOwnershipMarkers([directory, reservation.root, dirname(reservation.root)]);
}
/**
 * #5914: the identity check a release that publishes nothing needs. The
 * outside-root reservation must name this worktree (and coordination path),
 * and a stamp, when one is readable, must carry the reservation's token; the
 * inode and birth time of a recreated directory are not compared. Callers
 * hold the native lock.
 */
export function assertPhysicalRootReservation(path: string, identity: { worktreeId: string; coordinationPath?: string | null }): void {
  try {
    const reservation = readPhysicalRootReservation(path);
    if (!reservation || reservation.worktreeId !== identity.worktreeId || identity.coordinationPath && reservation.coordinationPath !== identity.coordinationPath) throw physicalRootError();
    const stamp = existsSync(path) ? readPhysicalRootStamp(path) : null;
    if (stamp && (stamp.token !== reservation.token || stamp.worktreeId !== reservation.worktreeId || stamp.brainId !== reservation.brainId)) throw physicalRootError();
  } catch (error) { if (error instanceof OperationError) throw error; throw physicalRootError(); }
}
/**
 * #5914 (P1.3c): the recorded root now resolves through a symlink to `target`.
 * Verifies the moved checkout is this same worktree (reservation under the old
 * name and stamp inside the real directory agree on token, brainId and
 * worktreeId; the stamp names the old root) and returns both records.
 */
export function inspectRelocatedPhysicalRoot(recorded: string, target: string, identity: { worktreeId: string; coordinationPath?: string | null }):
  { reservation: PhysicalRootReservation; stamp: PhysicalRootStamp } {
  try {
    if (recorded === target || realpathSync(recorded) !== target || realpathSync(target) !== target) throw physicalRootError();
    const reservation = readRecordedPhysicalRootReservation(recorded), stamp = readPhysicalRootStamp(target);
    if (!reservation || !stamp || reservation.worktreeId !== identity.worktreeId || identity.coordinationPath && reservation.coordinationPath !== identity.coordinationPath
      || stamp.token !== reservation.token || stamp.worktreeId !== reservation.worktreeId || stamp.brainId !== reservation.brainId || stamp.root !== recorded) throw physicalRootError();
    return { reservation, stamp };
  } catch (error) { if (error instanceof OperationError) throw error; throw physicalRootError(); }
}
/**
 * #5914 (P1.3c): moves the ownership records of a verified relocation to the
 * real directory: the reservation is written under the new `sha256(root)`
 * name, the stamp is rewritten to name the new root from the live directory,
 * then the old reservation is removed. Caller holds the native lock and the
 * topology transaction; `inspectRelocatedPhysicalRoot` ran first.
 */
export function relocatePhysicalRoot(recorded: string, target: string, records: { reservation: PhysicalRootReservation; stamp: PhysicalRootStamp }): PhysicalRootReservation {
  const info = statSync(target, { bigint: true });
  const reservation: PhysicalRootReservation = { ...records.reservation, root: target,
    initialDevice: info.dev.toString(), initialInode: info.ino.toString(), initialBirth: info.birthtimeNs.toString() };
  const existing = readPhysicalRootReservation(target);
  if (existing && digest(existing) !== digest(reservation)) throw physicalRootError('Another reservation already names the relocated directory.');
  if (!existing && !createPrivate(physicalRootReservationPath(target), reservation)) throw physicalRootError();
  replacePrivate(join(target, PHYSICAL_ROOT_MARKER), { ...records.stamp, root: target, device: info.dev.toString(), inode: info.ino.toString(), birth: info.birthtimeNs.toString() });
  assertPhysicalRootStamp(target, reservation);
  try { unlinkSync(physicalRootReservationPath(recorded)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  flushDirectory(dirname(physicalRootReservationPath(recorded)));
  excludeOwnershipMarkers([target, dirname(target)]);
  return reservation;
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
