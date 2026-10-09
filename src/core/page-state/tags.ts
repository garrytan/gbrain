import type { BrainEngine } from '../engine.ts';
import type { PageKey } from './types.ts';

/** Page-before-tag ordering matches canonical writers and avoids trigger inversions. */
export async function mutatePageTag(engine: BrainEngine, key: PageKey, tag: string, add: boolean, tagSource?: 'frontmatter'): Promise<void> {
  await engine.transaction(async tx => {
    await tx.lockPageKeys([key]);
    if (add) {
      const rows = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [key.sourceId, key.slug]);
      if (!rows.length) throw new Error(`addTag failed: page "${key.slug}" (source=${key.sourceId}) not found`);
      // A14: an explicit add claims the tag, so no import deletes it; the
      // importer's frontmatter claim only adopts an unclaimed legacy row.
      await tx.executeRaw(tagSource === 'frontmatter'
        ? `INSERT INTO tags(page_id,tag,tag_source) VALUES ($1,$2,'frontmatter')
            ON CONFLICT (page_id,tag) DO UPDATE SET tag_source = 'frontmatter' WHERE tags.tag_source IS NULL`
        : `INSERT INTO tags(page_id,tag,tag_source) VALUES ($1,$2,'added')
            ON CONFLICT (page_id,tag) DO UPDATE SET tag_source = 'added'`, [rows[0].id, tag]);
    } else {
      await tx.executeRaw('DELETE FROM tags WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2) AND tag=$3', [key.sourceId, key.slug, tag]);
    }
  });
}

/**
 * #5984: addTag for many tags of one page the caller wrote in this transaction
 * (its id from that write, its page guard held): one statement with the same
 * claim rules (an explicit add claims the tag; a frontmatter claim only adopts
 * an unclaimed legacy row).
 */
export async function addPageTags(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, tags: readonly string[], tagSource?: 'frontmatter'): Promise<void> {
  if (!tags.length) return;
  await engine.executeRaw(tagSource === 'frontmatter'
    ? `INSERT INTO tags(page_id,tag,tag_source) SELECT $1,t,'frontmatter' FROM (SELECT DISTINCT unnest($2::text[]) AS t) u
        ON CONFLICT (page_id,tag) DO UPDATE SET tag_source = 'frontmatter' WHERE tags.tag_source IS NULL`
    : `INSERT INTO tags(page_id,tag,tag_source) SELECT $1,t,'added' FROM (SELECT DISTINCT unnest($2::text[]) AS t) u
        ON CONFLICT (page_id,tag) DO UPDATE SET tag_source = 'added'`, [pageId, [...tags]]);
}
