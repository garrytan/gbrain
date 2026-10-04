import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { configDir } from '../config.ts';
import { flushDirectory } from '../fs-durable.ts';
import { opError, OperationError } from '../ops/contract.ts';

export interface ManagedRootRecord {
  local_path: string;
  source_id?: string;
  source_incarnation?: string;
  worktree_id?: string;
  topology_generation?: string | number;
}
function registryDirectory(): string { return join(configDir(), 'persistence', 'managed-roots'); }
function gitMetadataDirectory(root: string): string | null {
  const git = join(root, '.git');
  if (!existsSync(git)) return null;
  if (statSync(git).isDirectory()) return git;
  const match = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(git, 'utf8'));
  return match ? resolve(root, match[1]) : null;
}
function enclosingGitMetadata(root: string): string | null {
  let current = root;
  for (;;) {
    const metadata = gitMetadataDirectory(current);
    if (metadata) return metadata;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
/** An idle refresh must not touch inode metadata, so chmod only when the mode differs (#5297). */
function ensureMode(path: string, mode: number): void {
  if ((statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
}
/** Returns whether the record changed; a changed record is already durable with its directory entry. */
function writePrivateRecord(file: string, value: string): boolean {
  if (existsSync(file) && readFileSync(file, 'utf8') === value) { ensureMode(file, 0o600); return false; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, file); flushDirectory(dirname(file)); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  return true;
}
function markerExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw opError('writer_coordinator_required', 'Managed-root marker cannot be inspected.',
      `gbrain could not read ${path} (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}), so it cannot tell whether this checkout is managed and refuses the write. Fix the path's permissions for this user, then run the command again.`);
  }
}
/** Shared refusal marker helps installations with separate homes. It NEVER grants ownership. */
export function hasManagedRootMarker(path: string): boolean {
  return managedRootMarkerFor(path) !== null;
}
/** The nearest ownership marker covering `path`: the root it marks and the marker file that proves it. */
export function managedRootMarkerFor(path: string): { root: string; marker: string } | null {
  let current = canonicalFilesystemPath(path);
  for (;;) {
    // A prepared claim is already a durable refusal, including when its target
    // directory does not yet exist. Ownership still requires SQL/native proof.
    const reservation = join(dirname(current), `.gbrain-owner-${createHash('sha256').update(current).digest('hex')}.json`);
    if (markerExists(reservation)) return { root: current, marker: reservation };
    if (existsSync(current) && statSync(current).isDirectory()) {
      for (const marker of [join(current, '.gbrain-owner.json'), join(current, '.gbrain-managed')]) {
        if (markerExists(marker)) return { root: current, marker };
      }
      const metadata = gitMetadataDirectory(current);
      if (metadata && markerExists(join(metadata, 'gbrain-managed.json'))) return { root: current, marker: join(metadata, 'gbrain-managed.json') };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
/** Resolve existing ancestors too, so an alias to a managed tree cannot bypass the fence. */
export function canonicalFilesystemPath(path: string): string {
  return resolveFilesystemPath(path, realpathSync);
}
export function nativeFilesystemPath(path: string): string {
  return resolveFilesystemPath(path, realpathSync.native);
}
function resolveFilesystemPath(path: string, realpath: (path: string) => string): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return resolve(realpath(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current)); current = parent;
    }
  }
}
/**
 * One private immutable path identity per brain/root; topology metadata can be
 * refreshed but stale roots stay fenced until an explicit verified drain clears
 * them. Per-root files prevent independent registration from dropping siblings.
 */
export function recordManagedRoots(brainId: string, records: ManagedRootRecord[], modeEpoch?: number): void {
  if (!/^[a-f0-9-]{36}$/i.test(brainId)) {
    throw opError('storage_error', 'Invalid managed-root brain identity.',
      'The managed-root registry was given a brain identity that is not a UUID, so nothing was recorded. This is an internal fault: run gbrain doctor --json and report it to the user.');
  }
  if (!records.length) return;
  const directory = registryDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 }); ensureMode(directory, 0o700);
  let changed = false;
  for (const record of records) {
    const root = canonicalFilesystemPath(record.local_path);
    const key = createHash('sha256').update(root).digest('hex');
    const file = join(directory, `${brainId}.${key}.json`);
    const value = JSON.stringify({ version: 1, brain_id: brainId, root, ...record, local_path: root,
      ...(record.topology_generation != null ? { topology_generation: String(record.topology_generation) } : {}),
      ...(modeEpoch !== undefined ? { mode_epoch: modeEpoch } : {}) });
    changed = writePrivateRecord(file, value) || changed;
    if (existsSync(root) && statSync(root).isDirectory()) {
      const metadata = enclosingGitMetadata(root);
      const marker = metadata ? join(metadata, 'gbrain-managed.json') : join(root, '.gbrain-managed');
      if (!existsSync(marker)) writePrivateRecord(marker, JSON.stringify({ version: 1, managed: true, brain_id: brainId, ...(modeEpoch !== undefined ? { mode_epoch: modeEpoch } : {}) }));
    }
  }
  if (changed) flushDirectory(directory);
}
/** Available before connect, including while another process owns local PGLite. */
export function registeredManagedRoots(): string[] {
  return registeredManagedRootRecords().map(record => record.root);
}
/** The registry records with the source each root was recorded for (when the binding named one). */
export function registeredManagedRootRecords(): Array<{ root: string; source_id?: string }> {
  const directory = registryDirectory();
  let files: string[];
  try { files = readdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records: Array<{ root: string; source_id?: string }> = [];
  for (const file of files.filter(file => file.endsWith('.json'))) {
    try {
      const value = JSON.parse(readFileSync(join(directory, file), 'utf8'));
      if (value.version !== 1 || typeof value.root !== 'string' || !isAbsolute(value.root)) throw new Error('invalid record');
      records.push({ root: canonicalFilesystemPath(value.root), ...(typeof value.source_id === 'string' ? { source_id: value.source_id } : {}) });
    } catch {
      throw new OperationError('writer_coordinator_required', 'Managed-root ownership records are unreadable.',
        'Repair the local persistence registry through writer administration before running filesystem maintenance.');
    }
  }
  return records;
}
