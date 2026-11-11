/**
 * #8811: `sumStaleChunkChars` (engine-sql/chunks.ts), the sync cost gate's and the migration plan's stale-text total.
 * With a signature it sums the stale predicate's two disjoint halves (an unembedded chunk, or an embedded chunk of a
 * page whose signature drifted) apart, so each can use its own index. This pins the totals for every option the
 * callers pass over a mix of matching, drifted, unsigned and embed_skip pages, on PGLite and on Postgres when
 * DATABASE_URL is set. Each chunk's text length is a distinct power of two, so a total names exactly the chunks it
 * counted: a chunk summed twice or missed changes it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const CURRENT = 'example:model-current:dims';
const OLD = 'example:model-old:dims';

const PAGES: Array<{ slug: string; source: string; signature: string | null; skip?: boolean; embedded: number[]; unembedded: number[] }> = [
  { slug: 'notes/current', source: 'default', signature: CURRENT, embedded: [1, 2], unembedded: [4] },
  { slug: 'notes/drifted', source: 'default', signature: OLD, embedded: [8, 16], unembedded: [32] },
  { slug: 'notes/unsigned', source: 'default', signature: null, embedded: [64], unembedded: [128] },
  { slug: 'notes/skipped', source: 'default', signature: OLD, skip: true, embedded: [256], unembedded: [512] },
  { slug: 'notes/elsewhere', source: 'source-b', signature: OLD, embedded: [1024], unembedded: [2048] },
];

for (const kind of testBackends()) {
  describe(`sumStaleChunkChars totals (${kind}, #8811)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      } else {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      }
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('source-b', 'source-b', '{}') ON CONFLICT (id) DO NOTHING`);
      const [{ dim }] = await engine.executeRaw<{ dim: number }>(
        `SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`);
      for (const page of PAGES) {
        await engine.putPage(page.slug, { type: 'note', title: page.slug, compiled_truth: `# ${page.slug}` }, { sourceId: page.source });
        const lengths = [...page.embedded, ...page.unembedded];
        await engine.upsertChunks(page.slug, lengths.map((n, i) => ({ chunk_index: i, chunk_text: 'x'.repeat(n), chunk_source: 'compiled_truth' as const, token_count: 1 })), { sourceId: page.source });
        await engine.executeRaw(
          `UPDATE content_chunks SET embedding = ('[' || array_to_string(array_fill(0.01::real, ARRAY[$1::int]), ',') || ']')::vector
            WHERE page_id = (SELECT id FROM pages WHERE slug = $2 AND source_id = $3) AND length(chunk_text) = ANY($4::int[])`,
          [Number(dim), page.slug, page.source, page.embedded]);
        await engine.executeRaw(`UPDATE pages SET embedding_signature = $1, frontmatter = CASE WHEN $2 THEN '{"embed_skip": true}'::jsonb ELSE frontmatter END
            WHERE slug = $3 AND source_id = $4`, [page.signature, page.skip === true, page.slug, page.source]);
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('without a signature only unembedded chunks count', async () => {
      expect(await engine.sumStaleChunkChars()).toBe(4 + 32 + 128 + 2048);
      expect(await engine.sumStaleChunkChars({ sourceId: 'default' })).toBe(4 + 32 + 128);
    });

    test('a signature adds embedded chunks of drifted pages once, never unsigned or embed_skip pages', async () => {
      expect(await engine.sumStaleChunkChars({ signature: CURRENT })).toBe(4 + 32 + 128 + 2048 + 8 + 16 + 1024);
      expect(await engine.sumStaleChunkChars({ signature: CURRENT, sourceId: 'source-b' })).toBe(2048 + 1024);
    });

    test('includeNullSignature also counts embedded chunks of unsigned pages', async () => {
      expect(await engine.sumStaleChunkChars({ signature: CURRENT, includeNullSignature: true })).toBe(4 + 32 + 128 + 2048 + 8 + 16 + 1024 + 64);
      expect(await engine.sumStaleChunkChars({ signature: CURRENT, includeNullSignature: true, sourceId: 'default' })).toBe(4 + 32 + 128 + 8 + 16 + 64);
    });

    test('countStaleChunks counts the same chunks the totals name', async () => {
      const rows = await engine.executeRaw<{ n: number }>(`SELECT length(chunk_text) AS n FROM content_chunks`);
      expect(rows.length).toBe(PAGES.reduce((sum, page) => sum + page.embedded.length + page.unembedded.length, 0));
      expect(await engine.countStaleChunks({ signature: CURRENT })).toBe(7);
      expect(await engine.countStaleChunks({ signature: CURRENT, includeNullSignature: true })).toBe(8);
    });
  });
}
