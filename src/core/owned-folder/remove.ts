/**
 * Removing an owned-folder source (GST-3022): one function, run by deleteSourceRow, so the CLI, MCP `sources_remove`,
 * cycle expiry and the purge all take it. It removes every file this source committed under `.gbrain-owned/<id>/`
 * in one commit under the checkout's commit lock, with the writer's blob checks: a file it cannot prove it wrote (edited
 * or added by hand, or reached through a symlink) is kept and named. A failure (a busy lock, a refused commit) throws,
 * so the source row stays and the next attempt (the next cycle, for expiry) tries again. The remote's history still
 * holds what was pushed. `keep` (`--keep-storage`) leaves the files.
 */
import { existsSync, lstatSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import type { ConnectorKind } from '../persistence/connector-kinds.ts';
import { defaultCheckout } from './destination.ts';
import { isOwnedFolderKind, OWNED_FOLDER_ROOT, ownedFolderRel } from './paths.ts';
import { adoptRedactions, commitOwnedBatch, OWNER_FILE, readOwnedState, README_FILE, writeOwnedState, type OwnedFolderState } from './writer.ts';

type Exec = Pick<BrainEngine, 'executeRaw' | 'readSourceIncarnation'> & Partial<Pick<BrainEngine, 'getConfig'>>;

export interface OwnedRemoval { files: number; removed: number; kept: string[]; sha: string | null; kept_storage: boolean }

/** The source's incarnation and config through the typed source read, so a removal of any other kind of source needs no raw SQL. */
async function ownedSource(engine: Exec, sourceId: string) {
  const src = await engine.readSourceIncarnation(sourceId);
  if (!src) return null;
  const config = src.config as Record<string, unknown> | null;
  return isOwnedFolderKind(config) ? { incarnation: String(src.incarnation), config } : null;
}

async function ownedRecord(engine: Exec, sourceId: string) {
  const src = await ownedSource(engine, sourceId);
  if (!src) return null;
  const kind = src.config!.kind as ConnectorKind;
  const owned = await readOwnedState(engine, sourceId, src.incarnation, kind);
  if (!owned || !Object.keys(owned.files).length) return null;
  return { owned, kind };
}

/**
 * Removes the source's folder (removeOwnedFolder), then runs `deleteRow`, both under the source's sync lock, so a
 * sync of an owned-folder source that is still reading Messages cannot commit day files after the folder and the row
 * are gone, even during a first import that has recorded nothing yet. A busy lock refuses with nothing removed. Any
 * other kind of source takes no lock. An apple-contacts source first retires the rows it wrote on person pages, and a
 * row it cannot retire throws with the row kept.
 */
export async function removeOwnedFolderThen<T>(engine: BrainEngine, sourceId: string, opts: { keep?: boolean }, deleteRow: () => Promise<T>): Promise<T> {
  const work = async () => {
    await (await import('../apple-contacts/person-facts.ts')).retirePersonFactsBeforeRemove(engine, sourceId);
    await removeOwnedFolder(engine, sourceId, opts);
    return deleteRow();
  };
  if (!(await ownedSource(engine, sourceId))) return work();
  const { syncLockId, tryAcquireDbLock } = await import('../db-lock.ts');
  const lock = await tryAcquireDbLock(engine, syncLockId(sourceId));
  if (!lock) {
    throw opError('lock_busy', `A sync of source ${sourceId} is running, so nothing was removed: it could still commit day files to ${ownedFolderRel(sourceId)}/.`,
      `Wait for the sync to finish, then run gbrain sources remove ${sourceId} again.`);
  }
  try { return await work(); } finally { await lock.release(); }
}

/** Removes the directories left empty under `dir`, bottom-up, never following a symlink. */
function pruneEmptyDirs(dir: string): void {
  let st;
  try { st = lstatSync(dir); } catch { return; }
  if (!st.isDirectory()) return;
  for (const name of readdirSync(dir)) pruneEmptyDirs(join(dir, name));
  try { if (!readdirSync(dir).length) rmdirSync(dir); } catch { /* kept */ }
}

const dayFiles = (owned: OwnedFolderState) => Object.keys(owned.files).filter(p => p !== OWNER_FILE && p !== README_FILE).length;

/** How many day files a removal of this source would take out of its folder (0 for any other source). */
export async function previewOwnedRemoval(engine: Exec, sourceId: string): Promise<number> {
  const record = await ownedRecord(engine, sourceId);
  return record ? dayFiles(record.owned) : 0;
}

/**
 * A page write through the page door (put_page, edit_page, append_page, delete_page, restore_page, tags, timeline,
 * takes, links) into a source whose pages are files in its owned folder is refused: the next sync would put the
 * Messages version back, so the change would not last. A repo-less or database-only source of the same kind is
 * unchanged. The sync itself writes through import, not this door.
 */
export async function assertOwnedPagesUnchanged(engine: Exec, sourceId: string, operation: string): Promise<void> {
  if (!(await previewOwnedRemoval(engine, sourceId))) return;
  throw new OperationError('owned_folder_conflict',
    `Source ${sourceId} keeps its pages as files in ${ownedFolderRel(sourceId)}/, written from Messages on this Mac, so ${operation} would not last and nothing was written.`,
    `Change the conversation in Messages and run gbrain sync --source ${sourceId}, or stop the source with gbrain sources remove ${sourceId}.`,
    'docs/guides/apple-setup.md#where-the-pages-live');
}

export async function removeOwnedFolder(engine: Exec, sourceId: string, opts: { keep?: boolean } = {}): Promise<OwnedRemoval | null> {
  const record = await ownedRecord(engine, sourceId);
  if (!record) return null;
  const rel = ownedFolderRel(sourceId);
  const files = dayFiles(record.owned);
  if (opts.keep) {
    const notice = '[gbrain notice owned_folder_kept]';
    process.stderr.write(`${notice} ${sourceId}: gbrain sources remove --keep-storage leaves its ${files} day file(s) in ${rel}/; nothing will update or remove them.\n`);
    return { files, removed: 0, kept: Object.keys(record.owned.files), sha: null, kept_storage: true };
  }
  const checkout = await defaultCheckout(engine);
  const root = 'root' in checkout ? checkout.root : null;
  if (!root || !existsSync(join(root, rel, OWNER_FILE))) {
    process.stderr.write(`[gbrain notice owned_folder_kept] ${sourceId}: ${rel}/ is not where it was written (${'reason' in checkout ? checkout.detail : 'no OWNER.json'}), so gbrain removed no file there.\n`);
    return { files, removed: 0, kept: [], sha: null, kept_storage: false };
  }
  adoptRedactions(root, rel, record.owned);
  const batch = commitOwnedBatch({ root, rel, sourceId, kind: record.kind, incarnation: record.owned.incarnation, pushUrls: record.owned.push_urls,
    writes: new Map(), removes: Object.keys(record.owned.files),
    message: `${record.kind}(${sourceId}): remove the source's ${files} chat-day file(s) from ${rel}` }, record.owned);
  const kept = Object.keys(batch.held);
  const remaining = Object.fromEntries(Object.entries(record.owned.files).filter(([p]) => !batch.removed.includes(p)));
  await writeOwnedState(engine, sourceId, record.kind, { ...record.owned, files: remaining });
  pruneEmptyDirs(join(root, rel));
  try { const top = join(root, OWNED_FOLDER_ROOT); if (!readdirSync(top).length) rmdirSync(top); } catch { /* a folder something else holds stays */ }
  process.stderr.write(`[gbrain notice owned_folder_removed] ${sourceId}: removed ${batch.removed.length} file(s) from ${rel}/${batch.sha ? ` in commit ${batch.sha.slice(0, 12)}` : ''}; the remote's history still holds what was pushed.${
    kept.length ? ` Kept ${kept.length} file(s) gbrain cannot prove it wrote: ${kept.map(p => `${rel}/${p}`).join(', ')}.` : ''}\n`);
  return { files, removed: batch.removed.length, kept, sha: batch.sha, kept_storage: false };
}
