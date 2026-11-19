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
import { connectorDbCursorKey, readConnectorDbCursor, writeConnectorDbCursor } from '../connectors/db-cursor.ts';
import { connectorIdentity } from '../persistence/connector-identity.ts';
import type { ConnectorKind } from '../persistence/connector-kinds.ts';
import { defaultCheckout } from './destination.ts';
import { isOwnedFolderKind, OWNED_FOLDER_ROOT, ownedFolderRel } from './paths.ts';
import { commitOwnedBatch, OWNER_FILE, README_FILE, type OwnedFolderState } from './writer.ts';

type Exec = Pick<BrainEngine, 'executeRaw'> & Partial<Pick<BrainEngine, 'getConfig'>>;

export interface OwnedRemoval { files: number; removed: number; kept: string[]; sha: string | null; kept_storage: boolean }

async function ownedRecord(engine: Exec, sourceId: string) {
  const [src] = await engine.executeRaw<{ incarnation: string; local_path: string | null; config: Record<string, unknown> | null }>(
    'SELECT incarnation::text AS incarnation, local_path, config FROM sources WHERE id=$1', [sourceId]);
  if (!src || !isOwnedFolderKind(src.config)) return null;
  const key = connectorDbCursorKey(sourceId, src.incarnation, connectorIdentity(src.config!.kind as ConnectorKind, src.config!, src.local_path));
  const state = ((await readConnectorDbCursor(engine, key)).state ?? {}) as Record<string, unknown> & { owned?: OwnedFolderState };
  const owned = state.owned?.incarnation === src.incarnation ? state.owned : undefined;
  if (!owned || !Object.keys(owned.files).length) return null;
  return { key, state, owned, kind: String(src.config!.kind) };
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

export async function removeOwnedFolder(engine: Exec, sourceId: string, opts: { keep?: boolean } = {}): Promise<OwnedRemoval | null> {
  const record = await ownedRecord(engine, sourceId);
  if (!record) return null;
  const rel = ownedFolderRel(sourceId);
  const files = dayFiles(record.owned);
  if (opts.keep) {
    process.stderr.write(`[gbrain notice owned_folder_kept] ${sourceId}: --keep-storage leaves its ${files} day file(s) in ${rel}/; nothing will update or remove them.\n`);
    return { files, removed: 0, kept: Object.keys(record.owned.files), sha: null, kept_storage: true };
  }
  const checkout = await defaultCheckout(engine);
  const root = 'root' in checkout ? checkout.root : null;
  if (!root || !existsSync(join(root, rel, OWNER_FILE))) {
    process.stderr.write(`[gbrain notice owned_folder_kept] ${sourceId}: ${rel}/ is not where it was written (${'reason' in checkout ? checkout.detail : 'no OWNER.json'}), so gbrain removed no file there.\n`);
    return { files, removed: 0, kept: [], sha: null, kept_storage: false };
  }
  const batch = commitOwnedBatch({ root, rel, sourceId, kind: record.kind, incarnation: record.owned.incarnation, pushUrls: record.owned.push_urls,
    writes: new Map(), removes: Object.keys(record.owned.files),
    message: `${record.kind}(${sourceId}): remove the source's ${files} chat-day file(s) from ${rel}` }, record.owned);
  const kept = Object.keys(batch.held);
  const remaining = Object.fromEntries(Object.entries(record.owned.files).filter(([p]) => !batch.removed.includes(p)));
  await writeConnectorDbCursor(engine, record.key, { ...record.state, owned: { ...record.owned, files: remaining } });
  pruneEmptyDirs(join(root, rel));
  try { const top = join(root, OWNED_FOLDER_ROOT); if (!readdirSync(top).length) rmdirSync(top); } catch { /* a folder something else holds stays */ }
  process.stderr.write(`[gbrain notice owned_folder_removed] ${sourceId}: removed ${batch.removed.length} file(s) from ${rel}/${batch.sha ? ` in commit ${batch.sha.slice(0, 12)}` : ''}; the remote's history still holds what was pushed.${
    kept.length ? ` Kept ${kept.length} file(s) gbrain cannot prove it wrote: ${kept.map(p => `${rel}/${p}`).join(', ')}.` : ''}\n`);
  return { files, removed: batch.removed.length, kept, sha: batch.sha, kept_storage: false };
}
