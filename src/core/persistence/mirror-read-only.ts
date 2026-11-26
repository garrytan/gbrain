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
import type { BrainEngine } from '../engine.ts';
import type { SqlEngine } from './model.ts';
import { urlCloneReadOnly } from '../url-clone.ts';

/** `lock`: inside a publication, hold the source row so a concurrent mode change waits for this write. */
export async function sourceMirrorReadOnly(engine: SqlEngine, sourceId: string, lock = false): Promise<boolean> {
  const row = await (engine as unknown as Pick<BrainEngine, 'readSourceState'>).readSourceState(sourceId, lock ? { lock: 'share' } : undefined);
  if (!row) return false;
  return String(row.config.mirror_read_only) === 'true' || await urlCloneReadOnly(engine, sourceId, row);
}

/**
 * Why the source's checkout is never written, or null: `mirror_read_only` (the flag) or `url_clone` (#6946). #7098: the
 * legacy disk writers (write-through, fact fences, timeline, forget, unfenced facts) skip on it as managed publication does.
 */
export async function readOnlyCheckout(engine: SqlEngine, sourceId: string): Promise<'mirror_read_only' | 'url_clone' | null> {
  const row = await (engine as unknown as Pick<BrainEngine, 'readSourceState'>).readSourceState(sourceId);
  if (!row) return null;
  if (String(row.config.mirror_read_only) === 'true') return 'mirror_read_only';
  return await urlCloneReadOnly(engine, sourceId, row) ? 'url_clone' : null;
}

/** Marks a page this publication stored database-only because its source is a read-only mirror and it has no recorded file. */
export async function classifyMirrorPage(tx: SqlEngine, row: { source_id: string; slug: string }): Promise<void> {
  await tx.executeRaw(`UPDATE pages SET database_only_reason='mirror_read_only'
    WHERE source_id=$1 AND slug=$2 AND database_only_reason IS NULL AND NULLIF(source_path,'') IS NULL`, [row.source_id, row.slug]);
}

/** Why the page is stored database-only, or null: the typed write-guard read (engine-sql/write-guards.ts), served on every engine. */
export async function readPageDatabaseOnlyReason(engine: SqlEngine, sourceId: string, slug: string): Promise<string | null> {
  return (engine as unknown as Pick<BrainEngine, 'readPageDatabaseOnlyReason'>).readPageDatabaseOnlyReason(sourceId, slug);
}

export async function isMirrorOnlyPage(engine: SqlEngine, sourceId: string, slug: string): Promise<boolean> {
  return await readPageDatabaseOnlyReason(engine, sourceId, slug) === 'mirror_read_only';
}

/** GBRA-133 (#7931): a `mirror_read_only` page with no recorded file whose source is no longer a read-only mirror. */
export async function staleMirrorPage(engine: SqlEngine, sourceId: string, page: { slug: string; source_path?: string | null }): Promise<boolean> {
  return !page.source_path && await isMirrorOnlyPage(engine, sourceId, page.slug) && !await sourceMirrorReadOnly(engine, sourceId);
}
