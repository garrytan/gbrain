/**
 * GBRA-133 wave 3: `sync.apply_held_deletions` (default `false`; per source `sync.apply_held_deletions.source.<id>`). A
 * managed pass holds a live page whose file a commit deleted when nothing proves the page still holds what the file held
 * (no import record or attestation of its revision: sync-classify.ts `delete_drift`, state `file_gone`), and
 * `gbrain repair file-drift --held --provenance deleted_by_commit` is how a person resolves it. With the switch on, the pass
 * deletes such a page itself, and only when every one of these holds:
 *
 * - the newest commit of HEAD's history that deleted the file is known (`deleted_by_commit`, sync-origin-evidence.ts);
 * - the page, at the revision the level read, equals the file's last committed bytes (the blob that commit's first parent
 *   held), by the canonical comparison the coordinator applies before it replaces a file (`fileMatchesSnapshot`);
 * - the page's revision is file-backed by the test `repair ghost-pages` applies (#7382, `ghostFileBacked`), so a page
 *   written in the database after its file last held it is never deleted, even with equal content.
 *
 * The deletion is an ordinary `managed_sync_delete`: a soft delete with the restore window every sync delete has, under
 * the mass-delete valve and the #7130 caps, leaving a tombstone the automatic purge holds. Its request carries
 * `heldDeletion` (the deleting commit and the blob compared), which is the page's receipt. A page the proof refuses stays
 * held, and its hold records the refusal at that page revision (`held_deletion`), so a later pass screens it again only
 * after the page changes. A pass screens at most `PASS_HELD_DELETION_MAX` paths.
 */
import { promisify } from 'node:util';
import type { BrainEngine } from '../engine.ts';
import { execFile } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { ghostFileBacked } from '../repair/ghost-pages.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';
import { fileMatchesSnapshot } from './page-prepare.ts';
import type { ManagedSyncContext } from './sync-discovery.ts';
import { readBlobs } from './sync-git-stream.ts';
import { readGitSourceHolds } from './sync-holds.ts';
import { sourceDbOnlyVerdict } from './source-storage.ts';
import { readDeletionProvenance } from './sync-origin-evidence.ts';
import { levelReuseAllowed, SYNC_LEVEL_REUSE_KEY } from './sync-tree-reuse.ts';
import type { ShadowLevel, ShadowPath } from './sync-pass.ts';

const execFileAsync = promisify(execFile);

export const SYNC_APPLY_HELD_DELETIONS_KEY = 'sync.apply_held_deletions';
/** Held deletions one pass screens (git and database reads per path). */
export const PASS_HELD_DELETION_MAX = 200;
const BLOB_MAX_BYTES = 8 * 1024 * 1024;

/** The deleting commit and the blob the page was compared with: the receipt a held deletion's request carries. */
export interface HeldDeletionProof { commit: string; blob_oid: string }
/** Why the proof refused a held deletion. `provenance_unknown` and `blob_unreadable` are not recorded, so the next pass tries again. */
export type HeldDeletionRefusal = 'not_deleted_by_commit' | 'provenance_unknown' | 'blob_unreadable' | 'content_differs' | 'database_ahead_of_file' | 'page_changed';
const TRANSIENT: ReadonlySet<HeldDeletionRefusal> = new Set(['provenance_unknown', 'blob_unreadable']);

export interface HeldDeletionState { screened: Set<string>; applied: number; refused: number }
export const newHeldDeletionState = (): HeldDeletionState => ({ screened: new Set(), applied: 0, refused: 0 });

/**
 * The pass's config switches in one statement, read once per pass: `sync.apply_held_deletions` (the per-source key wins over
 * the brain-wide one; only `true` turns it on) and `sync.level_reuse` (sync-tree-reuse.ts; on unless turned off).
 */
export async function readPassSwitches(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<{ heldDeletions: boolean; levelReuse: boolean }> {
  const own = `${SYNC_APPLY_HELD_DELETIONS_KEY}.source.${sourceId}`;
  const rows = await engine.executeRaw<{ key: string; value: string | null }>('SELECT key, value FROM config WHERE key = ANY($1::text[])', [[own, SYNC_APPLY_HELD_DELETIONS_KEY, SYNC_LEVEL_REUSE_KEY]]);
  const value = (key: string) => rows.find(row => row.key === key)?.value;
  return { heldDeletions: (value(own) ?? value(SYNC_APPLY_HELD_DELETIONS_KEY))?.trim().toLowerCase() === 'true', levelReuse: levelReuseAllowed(value(SYNC_LEVEL_REUSE_KEY)) };
}

/**
 * Settles the round's held committed deletions the proof accepts as deletes (`heldDeletion` on the result) and marks
 * the ones it refuses (`heldDeletionRefused`), turning a settled hold back into a `delete_drift` so the pass records the
 * refusal on it. The pass reads the switch once (`readPassSwitches`) and calls this only while it is on.
 */
export async function applyHeldDeletions(engine: BrainEngine, level: ShadowLevel, context: ManagedSyncContext, state: HeldDeletionState): Promise<void> {
  const holdPath = (entry: ShadowPath) => level.scope ? entry.path.slice(level.scope.length + 1) : entry.path;
  const page = (entry: ShadowPath) => entry.slug !== null && entry.pageId !== null && entry.revision !== null && entry.state.page?.live === true;
  const fresh = level.paths.filter(entry => entry.result.cls === 'delete_drift' && entry.result.state === 'file_gone' && !entry.result.uncommitted && !entry.result.settled && !entry.result.inFlight && page(entry));
  const resting = level.paths.filter(entry => entry.result.cls === 'held' && entry.result.settled && entry.state.level === null && !entry.state.present && page(entry));
  let held: ShadowPath[] = [];
  if (resting.length) {
    const holds = new Map((await readGitSourceHolds(engine, { sourceIds: [level.sourceId] })).flatMap(source => source.incarnation === level.incarnation ? source.holds : []).map(hold => [hold.path, hold]));
    held = resting.filter(entry => {
      const hold = holds.get(holdPath(entry));
      return hold?.code === 'file_drift' && hold.meta.state === 'file_gone' && !hold.meta.reason && hold.meta.held_deletion?.page_revision !== entry.revision;
    });
  }
  const batch = [...fresh, ...held].filter(entry => !state.screened.has(entry.path) && sourceDbOnlyVerdict(level.root, entry.slug!) === false).slice(0, Math.max(0, PASS_HELD_DELETION_MAX - state.screened.size));
  if (!batch.length) return;
  for (const entry of batch) state.screened.add(entry.path);
  const verdicts = await proveHeldDeletions(engine, level, context, batch, holdPath);
  for (const entry of batch) {
    const verdict = verdicts.get(entry.path)!;
    if ('commit' in verdict) {
      state.applied++;
      entry.result = { ...entry.result, cls: 'delete', settled: false, inFlight: false, action: 'delete', classAction: 'owner', heldDeletion: verdict };
      continue;
    }
    state.refused++;
    entry.result = { ...entry.result, cls: 'delete_drift', settled: false, inFlight: false, action: 'hold', classAction: 'repair', side: 'deleted', state: 'file_gone',
      ...(TRANSIENT.has(verdict.refused) ? {} : { heldDeletionRefused: verdict.refused }) };
  }
}

async function proveHeldDeletions(engine: BrainEngine, level: ShadowLevel, context: ManagedSyncContext, batch: ShadowPath[], holdPath: (entry: ShadowPath) => string):
  Promise<Map<string, HeldDeletionProof | { refused: HeldDeletionRefusal }>> {
  const verdicts = new Map<string, HeldDeletionProof | { refused: HeldDeletionRefusal }>();
  const provenance = await readDeletionProvenance(level.gitRoot, batch.map(entry => entry.path));
  const parents = new Map<string, { commit: string; oid: string | null }>();
  for (const entry of batch) {
    const found = provenance.get(entry.path);
    if (found?.kind !== 'deleted_by_commit') { verdicts.set(entry.path, { refused: !found || found.kind === 'unknown' ? 'provenance_unknown' : 'not_deleted_by_commit' }); continue; }
    parents.set(entry.path, { commit: found.commit, oid: await lastCommittedBlob(level.gitRoot, found.commit, entry.path) });
  }
  const blobs = await readBlobs(level.gitRoot, [...new Set([...parents.values()].flatMap(parent => parent.oid ? [parent.oid] : []))], BLOB_MAX_BYTES).catch(() => new Map<string, Buffer>());
  const activePack = (await loadActivePackForEngine(engine, { remote: false, sourceId: level.sourceId }).catch(() => null))?.manifest;
  const owner = { host_id: context.binding.owner_host_id ?? '', worktree_id: context.binding.worktree_id, owner_epoch: String(context.binding.owner_epoch), source_incarnation: level.incarnation };
  for (const entry of batch) {
    const parent = parents.get(entry.path);
    if (!parent) continue;
    const bytes = parent.oid ? blobs.get(parent.oid) : undefined;
    if (!bytes) { verdicts.set(entry.path, { refused: 'blob_unreadable' }); continue; }
    const snapshot = await engine.readPageSnapshot(entry.slug!, { sourceId: level.sourceId });
    if (!snapshot || snapshot.revision !== entry.revision || Number(snapshot.page.id) !== entry.pageId) { verdicts.set(entry.path, { refused: 'page_changed' }); continue; }
    const sourcePath = level.slugMode === 'source-root' ? holdPath(entry) : entry.path;
    const same = await fileMatchesSnapshot(engine, entry.slug!, bytes.toString('utf8'), snapshot, sourcePath, activePack).catch(() => false);
    if (!same) { verdicts.set(entry.path, { refused: 'content_differs' }); continue; }
    const backed = await ghostFileBacked(engine, { source_id: level.sourceId, slug: entry.slug!, path: holdPath(entry), revision: entry.revision!, page_id: entry.pageId! }, owner);
    verdicts.set(entry.path, backed ? { commit: parent.commit, blob_oid: parent.oid! } : { refused: 'database_ahead_of_file' });
  }
  return verdicts;
}

/** The blob `path` held in the deleting commit's first parent: the file's last committed bytes. */
async function lastCommittedBlob(gitRoot: string, commit: string, path: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', gitRoot, 'rev-parse', '--verify', '--quiet', `${commit}^1:${path}`], { env: gitChildEnv(), encoding: 'utf8', timeout: 60_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
