/**
 * Read-back checks for segmented pages (Wave B lane 1d tests): the live body
 * reconstructed from the manifest with the `contentHash` of that page, the
 * chunk rows readers can see, and a stand-in for a finished embedding pass.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { chunkGenerationFilter } from '../../src/core/search/safe-chunks.ts';
import { contentHash } from '../../src/core/utils.ts';

export interface SegmentedPageRow { id: number; body_storage: string; body_generation: number; content_hash: string; title: string; type: string;
  frontmatter: Record<string, unknown>; knowledge_revision: string; text_projection_revision: string | null }

export async function segmentedPageRow(engine: BrainEngine, slug: string, sourceId = 'default'): Promise<SegmentedPageRow> {
  const [row] = await engine.executeRaw<SegmentedPageRow>(`SELECT id, body_storage, body_generation, content_hash, title, type, frontmatter,
    knowledge_revision::text AS knowledge_revision, text_projection_revision::text AS text_projection_revision FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, slug]);
  if (!row) throw new Error(`page ${slug} not found`);
  return { ...row, id: Number(row.id), body_generation: Number(row.body_generation) };
}

/** The live body from the manifest, and `contentHash` of the page it makes (the stored hash must equal it). */
export async function reconstructedPage(engine: BrainEngine, slug: string, sourceId = 'default') {
  const page = await segmentedPageRow(engine, slug, sourceId);
  const body = await materializeSegmentedBody(engine, page.id, sourceId);
  const tags = (await engine.executeRaw<{ tag: string }>('SELECT tag FROM tags WHERE page_id=$1 ORDER BY tag', [page.id])).map(row => row.tag);
  return { page, body, hash: contentHash({ title: page.title, type: page.type, compiled_truth: body.compiled_truth, timeline: body.timeline, frontmatter: page.frontmatter, tags }) };
}

/** Chunk rows of the live body (chunkGenerationFilter: not retired, not staged past the page's generation). */
export async function visibleChunks(engine: BrainEngine, pageId: number): Promise<Array<{ occurrence_id: number | null; embedded: boolean }>> {
  const rows = await engine.executeRaw<{ occurrence_id: number | string | null; embedded: boolean }>(`SELECT c.occurrence_id, c.embedding IS NOT NULL AS embedded
    FROM content_chunks c JOIN pages p ON p.id=c.page_id
    WHERE c.page_id=$1 AND ${chunkGenerationFilter('p', 'c')}`, [pageId]);
  return rows.map(row => ({ occurrence_id: row.occurrence_id === null ? null : Number(row.occurrence_id), embedded: row.embedded }));
}

/** Give every chunk row of the page a constant vector, as a completed embedding pass would. */
export async function fakeEmbedPage(engine: BrainEngine, pageId: number): Promise<void> {
  const [column] = await engine.executeRaw<{ type: string }>(`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
    WHERE attrelid='content_chunks'::regclass AND attname='embedding'`);
  const dims = Number(/\((\d+)\)/.exec(column?.type ?? '')?.[1]);
  if (!dims) throw new Error(`content_chunks.embedding has no dimension: ${column?.type}`);
  await engine.executeRaw('UPDATE content_chunks SET embedding = array_fill(0.01::float4, ARRAY[$2::int])::vector WHERE page_id=$1', [pageId, dims]);
}
