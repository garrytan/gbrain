import type { BrainEngine } from '../engine.ts';
import type { PageKey } from './types.ts';

/** Page-before-tag ordering matches canonical writers and avoids trigger inversions. */
export async function mutatePageTag(engine: BrainEngine, key: PageKey, tag: string, add: boolean): Promise<void> {
  await engine.transaction(async tx => {
    await tx.lockPageKeys([key]);
    if (add) {
      const rows = await tx.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [key.sourceId, key.slug]);
      if (!rows.length) throw new Error(`addTag failed: page "${key.slug}" (source=${key.sourceId}) not found`);
      await tx.executeRaw('INSERT INTO tags(page_id,tag) VALUES ($1,$2) ON CONFLICT DO NOTHING', [rows[0].id, tag]);
    } else {
      await tx.executeRaw('DELETE FROM tags WHERE page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2) AND tag=$3', [key.sourceId, key.slug, tag]);
    }
  });
}
