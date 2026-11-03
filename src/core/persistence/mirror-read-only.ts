/**
 * #5409: a per-source read-only mirror (`sources.config.mirror_read_only`,
 * default false, set by `gbrain sources mirror-readonly|mirror-writable`).
 * The source's Git remote is authoritative: managed publication never writes
 * a file into its checkout. Sync imports canonical metadata database-only, and
 * a page write into the source is stored database-only (`storage:
 * "database_only"` on the receipt), so `git pull --ff-only` keeps working.
 * A page created that way (no recorded file) carries
 * `pages.database_only_reason='mirror_read_only'` and stays database-only
 * after `mirror-writable`, as an unbound-source page does (#5254). GBRA-133
 * (#7931): once its source is writable again (`mirror-writable`, managed
 * persistence activated, an owned clone no longer owned) the stamp is stale:
 * reconcile and `repair file-drift` compare the page with the file at its
 * slug path, as they do an unbound-source page, and the apply that records
 * that origin clears the stamp.
 *
 * #6946: on an unmanaged brain a clone gbrain owns (`sources add --url`,
 * url-clone.ts) is read-only the same way without the flag, because gbrain
 * pulls it with `git pull --ff-only` on every sync.
 */
import type { SqlEngine } from './model.ts';
import { urlCloneReadOnly } from '../url-clone.ts';

/** `lock`: inside a publication, hold the source row so a concurrent mode change waits for this write. */
export async function sourceMirrorReadOnly(engine: SqlEngine, sourceId: string, lock = false): Promise<boolean> {
  const [row] = await engine.executeRaw<{ read_only: boolean; local_path: string | null; config: unknown }>(
    `SELECT COALESCE(config->>'mirror_read_only','false')='true' AS read_only, local_path, config FROM sources WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [sourceId]);
  if (!row) return false;
  return row.read_only === true || await urlCloneReadOnly(engine, sourceId, row);
}

/** Marks a page this publication stored database-only because its source is a read-only mirror and it has no recorded file. */
export async function classifyMirrorPage(tx: SqlEngine, row: { source_id: string; slug: string }): Promise<void> {
  await tx.executeRaw(`UPDATE pages SET database_only_reason='mirror_read_only'
    WHERE source_id=$1 AND slug=$2 AND database_only_reason IS NULL AND NULLIF(source_path,'') IS NULL`, [row.source_id, row.slug]);
}

export async function isMirrorOnlyPage(engine: SqlEngine, sourceId: string, slug: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ database_only_reason: string | null }>(
    'SELECT database_only_reason FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return row?.database_only_reason === 'mirror_read_only';
}

/** GBRA-133 (#7931): a `mirror_read_only` page with no recorded file whose source is no longer a read-only mirror. */
export async function staleMirrorPage(engine: SqlEngine, sourceId: string, page: { slug: string; source_path?: string | null }): Promise<boolean> {
  return !page.source_path && await isMirrorOnlyPage(engine, sourceId, page.slug) && !await sourceMirrorReadOnly(engine, sourceId);
}
