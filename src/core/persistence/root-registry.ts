import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { configDir } from '../config.ts';
import { OperationError } from '../ops/contract.ts';

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
function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try { fd = openSync(directory, 'r'); fsyncSync(fd); }
  catch (error) {
    if (!(process.platform === 'win32' && ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? ''))) throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function writePrivateRecord(file: string, value: string): void {
  if (existsSync(file) && readFileSync(file, 'utf8') === value) { chmodSync(file, 0o600); return; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, file); syncDirectory(dirname(file)); }
  finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
function markerExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new OperationError('writer_coordinator_required', 'Managed-root marker cannot be inspected.');
  }
}
function pathWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function gitMarkerCoversPath(marker: string, root: string, path: string): boolean {
  // A v1 marker has no owner or complete scope evidence. Only an explicitly
  // attested v2 marker can narrow an enclosing Git repository's refusal.
  try {
    const value = JSON.parse(readFileSync(marker, 'utf8'));
    if (value.version !== 2 || value.managed !== true || !/^[a-f0-9-]{36}$/i.test(value.brain_id)
      || typeof value.owner_home !== 'string' || !isAbsolute(value.owner_home)
      || canonicalFilesystemPath(value.owner_home) !== value.owner_home
      || !Array.isArray(value.scope_roots) || !value.scope_roots.length) return true;
    const roots: string[] = value.scope_roots;
    if (roots.some(entry => typeof entry !== 'string' || !isAbsolute(entry)
      || canonicalFilesystemPath(entry) !== entry || !pathWithin(root, entry))) return true;
    const ownerDirectory = join(value.owner_home, '.gbrain', 'persistence', 'managed-roots');
    const records = registeredManagedRootRecords(ownerDirectory).filter(record => pathWithin(root, record.root));
    if (!records.some(record => record.brainId === value.brain_id)) return true;
    if (records.some(record => !roots.some(entry => pathWithin(entry, record.root))
      && !markerExists(join(record.root, '.gbrain-managed')))) return true;
    return roots.some(entry => pathWithin(entry, path) || pathWithin(path, entry));
  } catch { return true; }
}
/** Shared refusal marker helps installations with separate homes. It NEVER grants ownership. */
export function hasManagedRootMarker(path: string): boolean {
  let current = canonicalFilesystemPath(path);
  const target = current;
  for (;;) {
    // A prepared claim is already a durable refusal, including when its target
    // directory does not yet exist. Ownership still requires SQL/native proof.
    const reservation = join(dirname(current), `.gbrain-owner-${createHash('sha256').update(current).digest('hex')}.json`);
    if (markerExists(reservation)) return true;
    if (existsSync(current) && statSync(current).isDirectory()) {
      // Git metadata may live outside the worktree behind a .git file or
      // symlink. Its own marker fences direct writes to that directory too.
      if (markerExists(join(current, 'gbrain-managed.json'))) return true;
      if (markerExists(join(current, '.gbrain-owner.json'))) return true;
      const metadata = gitMetadataDirectory(current);
      if (markerExists(join(current, '.gbrain-managed'))) return true;
      if (metadata) {
        const marker = join(metadata, 'gbrain-managed.json');
        if (markerExists(marker) && (target === canonicalFilesystemPath(join(current, '.git'))
          || gitMarkerCoversPath(marker, current, target))) return true;
      }
    }
    const parent = dirname(current);
    if (parent === current) return false;
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
export function recordManagedRoots(brainId: string, records: ManagedRootRecord[]): void {
  if (!/^[a-f0-9-]{36}$/i.test(brainId)) throw new OperationError('storage_error', 'Invalid managed-root brain identity.');
  if (!records.length) return;
  const directory = registryDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  for (const record of records) {
    const root = canonicalFilesystemPath(record.local_path);
    const key = createHash('sha256').update(root).digest('hex');
    const file = join(directory, `${brainId}.${key}.json`);
    const value = JSON.stringify({ version: 1, brain_id: brainId, root, ...record, local_path: root,
      ...(record.topology_generation != null ? { topology_generation: String(record.topology_generation) } : {}) });
    if (existsSync(root) && statSync(root).isDirectory()) {
      const metadata = gitMetadataDirectory(root);
      const marker = metadata ? join(metadata, 'gbrain-managed.json') : join(root, '.gbrain-managed');
      if (!existsSync(marker)) {
        writePrivateRecord(marker, JSON.stringify(metadata
          ? { version: 2, managed: true, brain_id: brainId, owner_home: canonicalFilesystemPath(dirname(configDir())), scope_roots: [root] }
          : { version: 1, managed: true, brain_id: brainId }));
      } else if (metadata) {
        // Widen refusal before publishing a newly registered Git root. Never
        // auto-upgrade an unverifiable v1 marker.
        try {
          const value = JSON.parse(readFileSync(marker, 'utf8'));
          if (value.version === 2 && value.managed === true && Array.isArray(value.scope_roots)
            && !value.scope_roots.includes(root)) {
            writePrivateRecord(marker, JSON.stringify({ ...value, scope_roots: [...value.scope_roots, root] }));
          }
        } catch { /* Malformed markers remain broad refusal evidence. */ }
      }
    }
    writePrivateRecord(file, value);
  }
  syncDirectory(directory);
}
/** Explicit, operator-attested migration only; never called by refresh/connect. */
export function attestLegacyGitMarkerScope(input: {
  gitRoot: string; ownerHome: string; brainId: string; expectedRoots: string[];
}): { marker: string; backup: string; roots: string[] } {
  const root = canonicalFilesystemPath(input.gitRoot);
  const ownerHome = canonicalFilesystemPath(input.ownerHome);
  if (root !== input.gitRoot || ownerHome !== input.ownerHome || !/^[a-f0-9-]{36}$/i.test(input.brainId))
    throw new OperationError('storage_error', 'Canonical Git root, owner home, and brain ID are required.');
  const metadata = gitMetadataDirectory(root);
  if (!metadata) throw new OperationError('storage_error', 'Git metadata is required for marker attestation.');
  const marker = join(metadata, 'gbrain-managed.json');
  const original = readFileSync(marker, 'utf8');
  let value: { version?: unknown; managed?: unknown; brain_id?: unknown };
  try { value = JSON.parse(original); }
  catch { throw new OperationError('storage_error', 'Only a readable v1 Git marker can be attested.'); }
  if (value.version !== 1 || value.managed !== true || value.brain_id !== input.brainId)
    throw new OperationError('storage_error', 'The v1 marker brain identity does not match the attestation.');
  const records = registeredManagedRootRecords(join(ownerHome, '.gbrain', 'persistence', 'managed-roots'))
    .filter(record => pathWithin(root, record.root));
  if (!records.some(record => record.brainId === input.brainId))
    throw new OperationError('storage_error', 'The owner registry has no matching Git-root scope.');
  const roots = [...new Set(records.map(record => record.root))].sort();
  if (!Array.isArray(input.expectedRoots) || input.expectedRoots.some(path => typeof path !== 'string'
    || !isAbsolute(path) || canonicalFilesystemPath(path) !== path || !pathWithin(root, path))
    || JSON.stringify([...new Set(input.expectedRoots)].sort()) !== JSON.stringify(roots))
    throw new OperationError('storage_error', 'Expected roots must exactly match the owner registry, including stale roots.');
  const backup = `${marker}.v1-backup-${randomUUID()}`;
  writePrivateRecord(backup, original);
  writePrivateRecord(marker, JSON.stringify({ version: 2, managed: true, brain_id: input.brainId,
    owner_home: ownerHome, scope_roots: roots }));
  return { marker, backup, roots };
}
/** Retain brain identity for v2 scope validation and explicit attestation. */
function registeredManagedRootRecords(directory = registryDirectory()): { root: string; brainId: string }[] {
  let files: string[];
  try { files = readdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const roots: { root: string; brainId: string }[] = [];
  for (const file of files.filter(file => file.endsWith('.json'))) {
    try {
      const value = JSON.parse(readFileSync(join(directory, file), 'utf8'));
      if (value.version !== 1 || typeof value.root !== 'string' || !isAbsolute(value.root)
        || !/^[a-f0-9-]{36}$/i.test(value.brain_id)) throw new Error('invalid record');
      roots.push({ root: canonicalFilesystemPath(value.root), brainId: value.brain_id });
    } catch {
      throw new OperationError('writer_coordinator_required', 'Managed-root ownership records are unreadable.',
        'Repair the local persistence registry through writer administration before running filesystem maintenance.');
    }
  }
  return roots;
}
/** Available before connect, including while another process owns local PGLite. */
export function registeredManagedRoots(): string[] {
  return registeredManagedRootRecords().map(record => record.root);
}
