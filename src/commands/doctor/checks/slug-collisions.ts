/**
 * slug_collisions doctor check (A3): files in a source checkout that map to
 * the same page slug (`notes/Foo Bar.md` and `notes/foo-bar.md`, or two
 * spellings that differ only by case). Sync imports only one of them and
 * skips the other with a stderr warning, so the loser never reaches the brain.
 *
 * Read-only. Walks each live source's local checkout with the sync walker (no
 * file reads) and groups the paths by the slug the importer would give them.
 * Sources without a local checkout are skipped.
 */

import { existsSync } from 'fs';
import { relative } from 'path';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { collectSyncableFiles } from '../../import.ts';
import { resolveSlugForPath, type SyncStrategy } from '../../../core/sync.ts';
import { isImageFilePath } from '../../../core/import-file.ts';

export async function slugCollisionsCheck(engine: BrainEngine): Promise<Check> {
  try {
    const sources = await engine.executeRaw<{ id: string; local_path: string | null; config: { strategy?: SyncStrategy } | null }>(
      `SELECT id, local_path, config FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL ORDER BY id`);
    const groups: Array<{ source: string; slug: string; paths: string[]; indexed?: string }> = [];
    let walked = 0;
    for (const source of sources) {
      if (!source.local_path || !existsSync(source.local_path)) continue;
      walked++;
      const bySlug = new Map<string, string[]>();
      for (const file of collectSyncableFiles(source.local_path, { strategy: source.config?.strategy ?? 'markdown' })) {
        const rel = relative(source.local_path, file).replace(/\\/g, '/');
        const slug = isImageFilePath(rel) ? rel.toLowerCase() : resolveSlugForPath(rel);
        bySlug.set(slug, [...(bySlug.get(slug) ?? []), rel]);
      }
      for (const [slug, paths] of bySlug) {
        if (paths.length < 2) continue;
        const [owner] = await engine.executeRaw<{ source_path: string }>(
          'SELECT source_path FROM pages WHERE source_id = $1 AND source_path = ANY($2::text[]) AND deleted_at IS NULL LIMIT 1', [source.id, paths]);
        groups.push({ source: source.id, slug, paths, indexed: owner?.source_path });
      }
    }
    if (groups.length === 0) {
      return { name: 'slug_collisions', status: 'ok', message: `No slug collisions across ${walked} source checkout(s).` };
    }
    const eg = groups.slice(0, 5).map(g => `${g.source}:${g.slug} <- ${g.paths.join(' | ')}${g.indexed ? ` (indexed: ${g.indexed})` : ''}`).join('; ');
    return {
      name: 'slug_collisions',
      status: 'warn',
      message: `${groups.length} slug collision(s): two or more files map to one page, and only one is indexed. ` +
        `Rename all but one file in each group, then sync. ${eg}`,
    };
  } catch (e) {
    return { name: 'slug_collisions', status: 'warn', message: `slug collision scan skipped: ${e instanceof Error ? e.message : String(e)}` };
  }
}
