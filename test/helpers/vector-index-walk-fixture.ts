/**
 * The vector index walk fixture (8-dim): three sources (one archived), five
 * page types, pages hidden by the private-page rule, quarantined and
 * soft-deleted pages, stale chunk hashes, three chunks per page, and a `tiny`
 * source with 2% of pages. Shared by test/search/vector-index-walk.test.ts
 * (PGLite) and test/e2e/vector-index-walk-plan-postgres.test.ts.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

export const MODEL = 'test:vector-index-walk';
export const DIM = 8;
export const column = { name: 'embedding', type: 'vector' as const, dimensions: DIM, embeddingModel: MODEL };
export const PAGES = 600;

export function vec(seed: number): Float32Array {
  return Float32Array.from({ length: DIM }, (_, d) => Math.sin(seed * (d + 1) * 0.37 + d));
}

export async function seedVectorWalkFixture(engine: Pick<BrainEngine, 'executeRaw'>): Promise<void> {
  await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
  await engine.executeRaw(`ALTER TABLE content_chunks ALTER COLUMN embedding TYPE vector(${DIM})`);
  await engine.executeRaw('CREATE INDEX idx_chunks_embedding ON content_chunks USING hnsw (embedding vector_cosine_ops)');
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('side', 'side'), ('gone', 'gone'), ('tiny', 'tiny') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'gone'`);
  // Page i sits in block i / 20, which sets its source; inside a block,
  // offsets 0-3 are hidden from remote readers by four private-page rules
  // (offset 3 is `derived_from` offset 0 of the same block and source).
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, knowledge_revision, text_projection_revision, chunker_version, deleted_at)
    SELECT 'notes/n-' || i,
      CASE WHEN (i / 20) % 5 = 0 THEN 'side' WHEN (i / 20) % 7 = 3 THEN 'gone' ELSE 'default' END,
      CASE WHEN i % 20 = 1 THEN 'atom' WHEN i % 20 = 2 THEN 'concept' ELSE (ARRAY['note', 'person', 'company', 'meeting', 'note'])[1 + i % 5] END,
      'Note ' || i, 'body',
      CASE WHEN i % 20 = 0 THEN '{"visibility": "private"}'::jsonb
        WHEN i % 20 = 2 THEN '{"synthesized_by": "dream"}'::jsonb
        WHEN i % 20 = 3 THEN jsonb_build_object('derived_from', 'notes/n-' || (i - 3))
        WHEN i % 31 = 0 THEN '{"quarantine": {"reason": "junk_pattern"}}'::jsonb
        ELSE '{}'::jsonb END,
      '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 4,
      CASE WHEN i % 37 = 0 THEN now() END
    FROM generate_series(0, ${PAGES - 1}) i`);
  await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, frontmatter, knowledge_revision, text_projection_revision, chunker_version)
    SELECT 'tiny/n-' || i, 'tiny', 'note', 'Tiny ' || i, 'body', '{}'::jsonb,
      '00000000-0000-4000-8000-000000000001'::uuid, '00000000-0000-4000-8000-000000000001'::uuid, 4
    FROM generate_series(1004, 1015) i`);
  const pages = await engine.executeRaw<{ id: number; slug: string }>(`SELECT id, slug FROM pages ORDER BY id`);
  const ids: number[] = [], idx: number[] = [], texts: string[] = [], hashes: (string | null)[] = [], vectors: string[] = [];
  for (const page of pages) {
    const n = Number(page.slug.split('-').at(-1));
    for (let c = 0; c < 3; c++) {
      ids.push(page.id); idx.push(c);
      texts.push(`chunk ${n} ${c}`);
      hashes.push(n % 13 === 0 && c === 0 ? 'stale-hash' : null);
      vectors.push(`[${Array.from(vec(n * 3 + c)).join(',')}]`);
    }
  }
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, embedded_text_hash, embedding)
    SELECT u.page_id, u.ci, u.t, 'compiled_truth', $6, COALESCE(u.h, md5(u.t)), u.v::vector
    FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::text[]) AS u(page_id, ci, t, h, v)`, [ids, idx, texts, hashes, vectors, MODEL]);
  await engine.executeRaw('ANALYZE');
}

export type PlanNode = { 'Node Type': string; 'Index Name'?: string; 'Relation Name'?: string; 'Join Filter'?: string; 'Actual Loops'?: number; Plans?: PlanNode[] };
export const planNodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(planNodes)];
