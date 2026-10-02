/**
 * #5409: a per-source read-only mirror (`sources.config.mirror_read_only`,
 * default false, set by `gbrain sources mirror-readonly|mirror-writable`).
 * The source's Git remote is authoritative: managed publication never writes
 * a file into its checkout. Sync imports canonical metadata database-only, and
 * a page write into the source is stored database-only (`storage:
 * "database_only"` on the receipt), so `git pull --ff-only` keeps working.
 * A page created that way (no recorded file) carries
 * `pages.database_only_reason='mirror_read_only'` and stays database-only
 * after `mirror-writable`, as an unbound-source page does (#5254).
 */
import type { SqlEngine } from './model.ts';

/** `lock`: inside a publication, hold the source row so a concurrent mode change waits for this write. */
export async function sourceMirrorReadOnly(engine: SqlEngine, sourceId: string, lock = false): Promise<boolean> {
  const [row] = await engine.executeRaw<{ read_only: boolean }>(
    `SELECT COALESCE(config->>'mirror_read_only','false')='true' AS read_only FROM sources WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [sourceId]);
  return row?.read_only === true;
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
