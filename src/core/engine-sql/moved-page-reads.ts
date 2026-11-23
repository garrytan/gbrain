/**
 * The page reads of the moved-pages verdict (`readMovedPage`, src/core/persistence/moved-pages.ts) and of
 * `gbrain repair moved-pages`' apply recheck (src/core/repair/moved-pages.ts). Both SQL engines delegate here; the Rust
 * store serves the same members (rust/crates/gbrain-store/src/moved_page_reads.rs). The verdict's page-access
 * comparison reads the privacy predicate and stays in the verdict (a named refusal on an engine without raw SQL).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** A live page with its revision and recorded path. */
export interface MovedPageRow { id: number; slug: string; revision: string; source_path: string | null }

const row = (r: { id: number | string; slug: string; revision: string; source_path: string | null }): MovedPageRow =>
  ({ id: Number(r.id), slug: r.slug, revision: String(r.revision), source_path: r.source_path });

/** The live pages of the source (but `excludeId`) whose recorded path is one of `paths`, by id. */
export async function listLivePagesBySourcePaths(raw: Raw, sourceId: string, excludeId: number, paths: readonly string[]): Promise<MovedPageRow[]> {
  const rows = await raw.executeRaw<MovedPageRow>(`SELECT id, slug, knowledge_revision::text AS revision, source_path
    FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id<>$2 AND source_path=ANY($3::text[]) ORDER BY id`, [sourceId, excludeId, [...paths]]);
  return rows.map(row);
}

/** At most five live pages of the source (but `excludeId`) whose recorded path is `name` or ends in `/name`, by slug. */
export async function listLivePagesByFileName(raw: Raw, sourceId: string, excludeId: number, name: string): Promise<Array<{ slug: string; source_path: string }>> {
  return raw.executeRaw<{ slug: string; source_path: string }>(`SELECT slug, source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id<>$2
      AND source_path IS NOT NULL AND (source_path=$3 OR right(source_path, length($3) + 1)='/' || $3) ORDER BY slug COLLATE "C" LIMIT 5`, [sourceId, excludeId, name]);
}

/** At most five other live pages of the source whose frontmatter `id` is page `pageId`'s, by slug; none when it has none. */
export async function listLivePagesSharingFrontmatterId(raw: Raw, sourceId: string, pageId: number): Promise<string[]> {
  const [own] = await raw.executeRaw<{ id: string | null }>('SELECT frontmatter->>\'id\' AS id FROM pages WHERE id=$1', [pageId]);
  if (!own?.id) return [];
  const rows = await raw.executeRaw<{ slug: string }>(`SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND id<>$2 AND frontmatter->>'id'=$3 ORDER BY slug COLLATE "C" LIMIT 5`,
    [sourceId, pageId, own.id]);
  return rows.map(r => r.slug);
}

/** Whether the page or one of its versions is stored in segments. */
export async function hasSegmentedHistory(raw: Raw, pageId: number): Promise<boolean> {
  const [storage] = await raw.executeRaw<{ segmented: boolean }>(`SELECT EXISTS (SELECT 1 FROM pages WHERE id=$1 AND body_storage<>'inline')
    OR EXISTS (SELECT 1 FROM page_versions WHERE page_id=$1 AND body_storage<>'inline') AS segmented`, [pageId]);
  return storage?.segmented === true;
}

/** The named live pages of the source with their revision and recorded path. */
export async function readLivePagesByIds(raw: Raw, sourceId: string, ids: readonly number[]): Promise<MovedPageRow[]> {
  const rows = await raw.executeRaw<MovedPageRow>(`SELECT id, slug, knowledge_revision::text AS revision, source_path FROM pages
    WHERE source_id=$1 AND id=ANY($2::int[]) AND deleted_at IS NULL`, [sourceId, [...ids]]);
  return rows.map(row);
}
