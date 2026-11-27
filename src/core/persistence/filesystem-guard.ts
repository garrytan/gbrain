import { hostIdFor } from './identity.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { OperationError } from '../ops/contract.ts';
import type { BrainEngine } from '../engine.ts';
import type { SqlEngine } from './model.ts';
import { readManagedMode, readPersistenceBrain } from './managed-mode.ts';
import { viewedEngine } from './switches.ts';
import { canonicalFilesystemPath, checkoutGitMetadata, managedRootMarkerFor, recordManagedRoots, registeredManagedRootRecords, type ManagedRootRecord } from './root-registry.ts';

interface FileCapability { roots: string[]; active: boolean; }
const active = new AsyncLocalStorage<FileCapability>();
const managedRoots = new Map<string, Map<string, string | undefined>>();
const datastorePaths = new WeakMap<SqlEngine, string>();
/** What recording the managed roots reads: the persistence brain row, the table probe and the root bindings. */
export type RootsEngine = SqlEngine & Pick<BrainEngine, 'hasPersistenceTable' | 'listManagedRootBindings'>;
/** The path is recorded on the engine that connected; a read-through view (the shadow wrapper) asks for the engine it reads through. */
export function managedFilesystemDatastorePath(engine: SqlEngine): string | undefined { return datastorePaths.get(viewedEngine(engine)); }
/** Record the selected engine path, never a guessed default from ambient config. */
export async function registerManagedFilesystemEngine(engine: RootsEngine, databasePath?: string): Promise<void> {
  if (!databasePath) return;
  datastorePaths.set(engine, databasePath);
  if (await engine.hasPersistenceTable('persistence_brain')) await refreshManagedFilesystemRoots(engine, databasePath);
}
function encloses(root: string, path: string): boolean {
  const rel = relative(canonicalFilesystemPath(root), canonicalFilesystemPath(path));
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}
export async function refreshManagedFilesystemRoots(engine: RootsEngine, databasePath = datastorePaths.get(viewedEngine(engine)), signal?: AbortSignal): Promise<void> {
  // Mode and epoch come from one snapshot, so roots are never recorded under the epoch of a concurrent deactivation.
  const brain = await readPersistenceBrain(engine, { signal });
  if (!brain.enabled) { managedRoots.set(brain.brain_id, new Map()); return; }
  // Rows are deduplicated by filesystem identity in recordManagedRoots, never by the stored spelling (#7203).
  // The stored nulls stay nulls: recordManagedRoots reads a null and an absent field alike.
  const rows = await engine.listManagedRootBindings(hostIdFor(engine), signal ? { signal } : undefined) as ManagedRootRecord[];
  signal?.throwIfAborted();
  // #7630: a relative local_path (a legacy ".") names whatever directory gbrain runs from; it is never a managed root.
  const owned = rows.filter(row => isAbsolute(row.local_path));
  if (databasePath) owned.push({ local_path: databasePath, datastore: true });
  const roots = recordManagedRoots(brain.brain_id, owned, brain.mode_epoch == null ? undefined : Number(brain.mode_epoch));
  managedRoots.set(brain.brain_id, new Map(roots.map(row => [row.local_path, row.source_id])));
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
    staleEnclosingMarker(managed)
      ? `The evidence is ${managed.evidence}, which an older gbrain wrote in a Git directory that only encloses a managed root (#7988, #9430); gbrain no longer writes it there. `
        + 'Deactivation removes it: preview with gbrain sources writer deactivate --dry-run --json, run the printed command after the user agrees, then activate again.'
      : 'Submit the change through the persistence coordinator; check the root with gbrain sources writer status.');
  error.detail = `root=${managed.root} source=${managed.sourceId ?? 'unknown'} evidence=${managed.evidence}`;
  throw error;
}
/** #7988: a Git-metadata marker whose checkout encloses registered roots but tracks none of them. */
export function staleEnclosingMarker(managed: ManagedFilesystemRoot): boolean {
  if (basename(managed.evidence) !== 'gbrain-managed.json') return false;
  const roots = registeredManagedRootRecords().map(record => record.root).filter(root => root !== managed.root && encloses(managed.root, root));
  return roots.length > 0 && roots.every(root => checkoutGitMetadata(root) !== dirname(managed.evidence));
}
/** Invalidate inherited async contexts before the owner releases the kernel lock. */
export async function withFilesystemPublication<T>(roots: string[], fn: () => Promise<T>): Promise<T> {
  const context = { roots: roots.map(root => resolve(root)), active: true };
  return active.run(context, async () => { try { return await fn(); } finally { context.active = false; } });
}
export async function assertLegacyFilesystemWriter(engine: RootsEngine, path: string): Promise<void> {
  await refreshManagedFilesystemRoots(engine);
  assertManagedFilesystemWrite(path);
}
/**
 * #5362/#6785: the legacy fence writer's refusal for a source's checkout,
 * checked before a lane pays for extraction (a claimed but not activated
 * canonical worktree refuses every fence write with writer_coordinator_required).
 * A managed brain writes through the coordinator and is never refused here.
 */
export async function assertSourceLegacyWriter(engine: RootsEngine, sourceId: string): Promise<void> {
  if (await readManagedMode(engine)) return;
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [sourceId]);
  if (source?.local_path) await assertLegacyFilesystemWriter(engine, source.local_path);
}
