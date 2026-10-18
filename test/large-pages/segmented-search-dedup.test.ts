/**
 * Wave B PR 2 (spec 7.5): search keeps up to six passages from one segmented
 * page when they are far apart.
 *
 * 1. Protects: hybridSearch (the fused path and the keyword-only path) hands
 *    dedup the occurrence positions of a segmented page's hits, so three
 *    regions more than 1 MiB apart keep two hits each, and an inline page in
 *    the same result set keeps two.
 * 2. Fails when: a search path calls dedupResults without the regions (the
 *    segmented page is capped at two like an inline page).
 * 3. Seams: the engine's search arms are replaced by fixed lists of real
 *    chunk rows (one vector arm via queryEmbedFn, or the keyword arm with
 *    embeddings opted out); dedup, segmentRegions and the post-fusion
 *    stages run for real.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { mulberry32 } from '../helpers/seeded-random.ts';
import { importSegmented, pageContent } from '../helpers/segmented-privacy-fixture.ts';

const WORDS = ['zzregionone', 'zzregiontwo', 'zzregionthree'];

/** About `bytes` of prose whose words rarely repeat, so no two chunks are near-duplicates for dedup's text layer. */
function varied(r: () => number, bytes: number): string {
  const lines: string[] = [];
  for (let size = 0; size < bytes;) {
    const line = Array.from({ length: 12 }, () => Math.floor(r() * 36 ** 6).toString(36)).join(' ') + '.';
    lines.push(r() < 0.1 ? `${line}\n` : line);
    size += line.length + 1;
  }
  return `${lines.join('\n')}\n`;
}

for (const kind of testBackends()) {
  describe(`search dedup regions of a segmented page (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let rows: SearchResult[];

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.setConfig('search.reranker.enabled', 'false');
      const r = mulberry32(503);
      await importSegmented(engine, 'chat/regions-example', pageContent(WORDS.map(w => `${varied(r, 1_200_000)}\n${w} opens this region\n`).join('')));
      await engine.setConfig('pages.segmented_storage', 'off');
      await importFromContent(engine, 'notes/inline-example', pageContent(Array.from({ length: 40 }, (_, i) => `## Part ${i}\n\nzzinline passage ${i} ${varied(r, 2_000)}`).join('\n')), { sourceId: 'default', noEmbed: true });
      const select = `SELECT p.slug, p.id AS page_id, p.title, p.type, p.source_id, cc.id AS chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source
        FROM content_chunks cc JOIN pages p ON p.id = cc.page_id`;
      const segmented: SearchResult[] = [];
      for (const word of WORDS) {
        const [hit] = await engine.executeRaw<SearchResult>(`${select} WHERE p.slug='chat/regions-example' AND cc.chunk_text LIKE $1 ORDER BY cc.chunk_index LIMIT 1`, [`%${word}%`]);
        const [next] = await engine.executeRaw<SearchResult>(`${select} WHERE p.slug='chat/regions-example' AND cc.chunk_index < $1 ORDER BY cc.chunk_index DESC LIMIT 1`, [hit!.chunk_index]);
        segmented.push(hit!, next!);
      }
      const inline = await engine.executeRaw<SearchResult>(`${select} WHERE p.slug='notes/inline-example' ORDER BY cc.chunk_index LIMIT 4`);
      rows = [...segmented, ...inline].map((row, i) => ({ ...row, page_id: Number(row.page_id), chunk_id: Number(row.chunk_id), score: 1 - i * 0.01, stale: false }));
    }, 300_000);

    afterAll(async () => { await close(); });

    const perPage = (results: SearchResult[]) => ({
      segmented: results.filter(r => r.slug === 'chat/regions-example').length,
      inline: results.filter(r => r.slug === 'notes/inline-example').length,
    });

    test('the fused path keeps two hits in each far region and two of the inline page', async () => {
      const searchVector = engine.searchVector;
      const searchKeyword = engine.searchKeyword;
      engine.searchVector = async () => rows.map(r => ({ ...r }));
      engine.searchKeyword = async () => [];
      try {
        const results = await hybridSearch(engine, 'regions', { expansion: false, limit: 20, queryEmbedFn: () => Float32Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0) });
        expect(perPage(results)).toEqual({ segmented: 6, inline: 2 });
      } finally {
        engine.searchVector = searchVector;
        engine.searchKeyword = searchKeyword;
      }
    }, 120_000);

    test('the keyword-only path keeps them too', async () => {
      const searchKeyword = engine.searchKeyword;
      engine.searchKeyword = async () => rows.map(r => ({ ...r }));
      try {
        const results = await hybridSearch(engine, 'regions', { expansion: false, limit: 20, _embeddingOptedOut: true });
        expect(perPage(results)).toEqual({ segmented: 6, inline: 2 });
      } finally {
        engine.searchKeyword = searchKeyword;
      }
    }, 120_000);
  });
}
