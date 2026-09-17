import type { BrainEngine } from '../engine.ts';
import type { PageVersion } from '../types.ts';

/** Version the same canonical view an API reader receives, including withdrawals. */
export async function createPageVersion(engine: BrainEngine, slug: string, sourceId: string): Promise<PageVersion> {
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const snapshot = await tx.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    if (!snapshot) throw new Error(`createVersion failed: page "${slug}" (source=${sourceId}) not found`);
    const { page, tags, revision } = snapshot;
    const rows = await tx.executeRaw<PageVersion>(`INSERT INTO page_versions
      (page_id,compiled_truth,frontmatter,knowledge_revision,timeline,title,type,tags,is_deleted)
      VALUES ($1,$2,$3::text::jsonb,$4::uuid,$5,$6,$7,$8::text::jsonb,$9) RETURNING *`,
    [page.id, page.compiled_truth, JSON.stringify(page.frontmatter), revision, page.timeline, page.title, page.type, JSON.stringify(tags), page.deleted_at != null]);
    return { ...rows[0], snapshot_at: new Date(rows[0].snapshot_at) };
  });
}
