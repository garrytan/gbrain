import { localHostId } from './identity.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import type { SqlEngine } from './model.ts';
import { canonicalFilesystemPath, managedRootMarkerFor, recordManagedRoots, registeredManagedRootRecords, type ManagedRootRecord } from './root-registry.ts';

interface FileCapability { roots: string[]; active: boolean; }
const active = new AsyncLocalStorage<FileCapability>();
const managedRoots = new Map<string, Map<string, string | undefined>>();
const datastorePaths = new WeakMap<SqlEngine, string>();
export function managedFilesystemDatastorePath(engine: SqlEngine): string | undefined { return datastorePaths.get(engine); }
/** Record the selected engine path, never a guessed default from ambient config. */
export async function registerManagedFilesystemEngine(engine: SqlEngine, databasePath?: string): Promise<void> {
  if (!databasePath) return;
  datastorePaths.set(engine, databasePath);
  const [table] = await engine.executeRaw<{ present: boolean }>("SELECT to_regclass('persistence_brain') IS NOT NULL AS present");
  if (table?.present) await refreshManagedFilesystemRoots(engine, databasePath);
}
function encloses(root: string, path: string): boolean {
  const rel = relative(canonicalFilesystemPath(root), canonicalFilesystemPath(path));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
export async function refreshManagedFilesystemRoots(engine: SqlEngine, databasePath = datastorePaths.get(engine), signal?: AbortSignal): Promise<void> {
  // Mode and epoch come from one snapshot, so roots are never recorded under the epoch of a concurrent deactivation.
  const [brain] = await engine.executeRaw<{ brain_id: string; enabled: boolean; mode_epoch: string | null }>(
    "SELECT brain_id,enabled,to_jsonb(persistence_brain)->>'mode_epoch' AS mode_epoch FROM persistence_brain WHERE singleton=1", undefined, { signal });
  if (!brain) return;
  const roots = brain.enabled ? await engine.executeRaw<ManagedRootRecord>(`SELECT DISTINCT ON (local_path) * FROM (
      SELECT h.local_path,s.source_id,s.source_incarnation,s.worktree_id,s.topology_generation
      FROM persistence_host_bindings h JOIN persistence_source_bindings s ON s.worktree_id=h.worktree_id WHERE h.host_id=$1::uuid
      UNION SELECT local_path,id,incarnation,NULL,NULL FROM sources WHERE local_path IS NOT NULL
      ) roots ORDER BY local_path,worktree_id NULLS LAST,source_id,source_incarnation,topology_generation`, [localHostId()], { signal }) : [];
  signal?.throwIfAborted();
  if (brain.enabled && databasePath) roots.push({ local_path: databasePath });
  if (brain.enabled) recordManagedRoots(brain.brain_id, roots, brain.mode_epoch == null ? undefined : Number(brain.mode_epoch));
  managedRoots.set(brain.brain_id, new Map(roots.map(row => [resolve(row.local_path), row.source_id])));
}
export function hasFilesystemPublication(path: string): boolean {
  const held = active.getStore();
  return held?.active === true && held.roots.some(root => encloses(root, path));
}
export interface ManagedFilesystemRoot { root: string; sourceId?: string; evidence: string }
/** The managed canonical worktree the path is inside (or encloses), with the evidence that marks it. */
export function managedFilesystemRootFor(path: string): ManagedFilesystemRoot | null {
  const related = (root: string) => encloses(root, path) || encloses(path, root);
  const known = [...registeredManagedRootRecords().map(record => ({ root: record.root, sourceId: record.source_id, evidence: 'managed-root registry' })),
    ...[...managedRoots.values()].flatMap(roots => [...roots].map(([root, sourceId]) => ({ root, sourceId, evidence: 'source binding' })))];
  const marker = managedRootMarkerFor(path);
  if (marker) {
    const sourceId = known.find(entry => entry.sourceId && canonicalFilesystemPath(entry.root) === marker.root)?.sourceId;
    return { root: marker.root, evidence: marker.marker, ...(sourceId ? { sourceId } : {}) };
  }
  const match = known.find(entry => related(entry.root));
  return match ? { root: match.root, evidence: match.evidence, ...(match.sourceId ? { sourceId: match.sourceId } : {}) } : null;
}
/** True when the path is inside (or encloses) a managed canonical worktree. */
export function isManagedFilesystemPath(path: string): boolean {
  return managedFilesystemRootFor(path) !== null;
}
export function assertManagedFilesystemWrite(path: string): void {
  const managed = managedFilesystemRootFor(path);
  if (!managed || hasFilesystemPublication(path)) return;
  // #5279: name the root, its source and the evidence, so a stray ownership file is findable.
  const error = new OperationError('writer_coordinator_required',
    `This path belongs to the managed canonical worktree ${managed.root}${managed.sourceId ? ` (source ${managed.sourceId})` : ''}.`,
    'Submit the change through the persistence coordinator; check the root with gbrain sources writer status.');
  error.detail = `root=${managed.root} source=${managed.sourceId ?? 'unknown'} evidence=${managed.evidence}`;
  throw error;
}
/** Invalidate inherited async contexts before the owner releases the kernel lock. */
export async function withFilesystemPublication<T>(roots: string[], fn: () => Promise<T>): Promise<T> {
  const context = { roots: roots.map(root => resolve(root)), active: true };
  return active.run(context, async () => { try { return await fn(); } finally { context.active = false; } });
}
export async function assertLegacyFilesystemWriter(engine: SqlEngine, path: string): Promise<void> {
  await refreshManagedFilesystemRoots(engine);
  assertManagedFilesystemWrite(path);
}
