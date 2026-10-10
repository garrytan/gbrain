/**
 * SCOPE_CHUNKS_SQL on a real engine (PGLite): a scope of at most
 * SCOPE_CHUNK_SAMPLE_PAGES pages is counted exactly (soft-deleted pages
 * excluded), a larger one through its hash-stride sample lands near the true
 * count, and the engine's loader routes a source of long pages on that count
 * where the page share would have undercounted it (once the background count
 * lands; the first search routes on the share). No embeddings are needed:
 * routing reads only pages, chunks and planner statistics.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  buildVectorSearchStatement,
  PAGE_SOURCE_STATS_SQL,
  SCOPE_CHUNK_SAMPLE_PAGES,
  SCOPE_CHUNKS_SQL,
  SCOPE_SCAN_FIRST_MAX_CHUNKS,
  sourceScope,
  type PageSourceStats,
  type ScopeChunkCount,
  type VectorScope,
} from '../../src/core/search/vector-statement.ts';
import type { SearchOpts } from '../../src/core/types.ts';

const column = { name: 'embedding', type: 'vector' as const, dimensions: 1536, embeddingModel: 'test:scope-chunks' };
/** Source, pages, chunks per page; `notes` pages interleave with `sessions` pages by id. */
const SOURCES: Array<[string, number, number]> = [['notes', 6_000, 2], ['sessions', 1_000, 28], ['tiny', 60, 3]];

let engine: PGLiteEngine;

async function trueChunks(ids: string[]): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
    WHERE p.source_id = ANY($1::text[]) AND p.deleted_at IS NULL`, [ids]);
  return Number(row!.n);
}

async function counted(ids: string[]): Promise<ScopeChunkCount> {
  const [row] = await engine.executeRaw<ScopeChunkCount>(SCOPE_CHUNKS_SQL, [ids]);
  return row!;
}

describe('SCOPE_CHUNKS_SQL', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO sources (id, name) SELECT s, s FROM unnest($1::text[]) s ON CONFLICT (id) DO NOTHING`, [SOURCES.map(([id]) => id)]);
    // Interleave notes and sessions ids (every 7th page is a session) so a plain id stride would alias.
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, deleted_at)
      SELECT 'p-' || i, CASE WHEN i % 7 = 0 THEN 'sessions' ELSE 'notes' END, 'note', 'P' || i, 'body',
        CASE WHEN i % 97 = 0 THEN now() END
      FROM generate_series(1, 7000) i`);
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, deleted_at)
      SELECT 't-' || i, 'tiny', 'note', 'T' || i, 'body', CASE WHEN i = 1 THEN now() END FROM generate_series(1, 60) i`);
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source)
      SELECT p.id, ci, 'c', 'compiled_truth' FROM pages p
      CROSS JOIN LATERAL generate_series(0, CASE p.source_id WHEN 'sessions' THEN 27 WHEN 'tiny' THEN 2 ELSE 1 END) ci`);
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw('ANALYZE content_chunks');
  }, 120_000);

  afterAll(async () => {
    await engine?.disconnect();
  });

  test('a scope of at most SCOPE_CHUNK_SAMPLE_PAGES pages is counted exactly, without soft-deleted pages', async () => {
    const row = await counted(['tiny']);
    expect(Number(row.pages)).toBe(59);
    expect(Number(row.sampled)).toBe(59);
    expect(Number(row.sample_chunks)).toBe(await trueChunks(['tiny']));
  });

  test('a larger scope samples about SCOPE_CHUNK_SAMPLE_PAGES pages and lands within 5% of the true count', async () => {
    for (const ids of [['sessions'], ['notes'], ['sessions', 'tiny']]) {
      const row = await counted(ids);
      const truth = await trueChunks(ids);
      expect(Number(row.sampled)).toBeGreaterThan(SCOPE_CHUNK_SAMPLE_PAGES * 0.5);
      expect(Number(row.sampled)).toBeLessThan(SCOPE_CHUNK_SAMPLE_PAGES * 2.5);
      const estimate = (Number(row.pages) * Number(row.sample_chunks)) / Number(row.sampled);
      expect(Math.abs(estimate - truth) / truth).toBeLessThan(0.05);
    }
  });

  test('the engine routes a source of long pages on its counted chunks, not its page share', async () => {
    const opts: SearchOpts = { embeddingColumn: column, sourceId: 'sessions' };
    const [stats] = await engine.executeRaw<PageSourceStats>(PAGE_SOURCE_STATS_SQL);
    const byShare = sourceScope(stats, opts)!;
    const loader = (engine as unknown as { vectorScope: (o?: SearchOpts) => Promise<VectorScope | undefined> }).vectorScope;
    expect(await loader(opts)).toEqual(byShare);
    let routed = await loader(opts);
    for (let i = 0; i < 50 && routed!.chunks === byShare.chunks; i++) routed = (await Bun.sleep(20), await loader(opts));
    const truth = await trueChunks(['sessions']);
    expect(byShare.chunks!).toBeLessThan(SCOPE_SCAN_FIRST_MAX_CHUNKS);
    expect(Math.abs(routed!.chunks! - truth) / truth).toBeLessThan(0.05);
    expect(routed!.chunks!).toBeGreaterThan(SCOPE_SCAN_FIRST_MAX_CHUNKS);
    const stmt = (scope: VectorScope) => buildVectorSearchStatement({ dialect: 'pglite', embedding: new Float32Array(1536), limit: 20, offset: 0, opts, scope });
    expect([!!stmt(byShare).indexWalkSql, !!stmt(byShare).scopeScanSql]).toEqual([false, true]);
    expect([!!stmt(routed!).indexWalkSql, !!stmt(routed!).scopeScanSql]).toEqual([true, true]);
  });
});
