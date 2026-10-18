/**
 * LHF wave 2 item 3: the text-space cosine re-score runs in SQL and keeps
 * the JavaScript rules. Every case runs the SQL path on a real engine and the
 * JavaScript path (the same engine with the SQL statement failing) and
 * compares them: hydrated zero-norm and dimension-mismatched vectors score 0,
 * absent and invisible chunks stay unhydrated (cosine 0 in the blend), the
 * all-missing set comes back untouched, halfvec reads as its exact float4
 * values, the image space keeps the JavaScript path, and rows near the 0.8
 * evidence floor agree within tolerance. Measured differences are printed.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { cosineReScore, cosineSimilarity } from '../../src/core/search/cosine-rescore.ts';
import { _resetWarnOnceForTests } from '../../src/core/utils.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const COSINE_TOLERANCE = 5e-6;
const SCORE_TOLERANCE = 2e-6;
const SLUGS = ['notes/random-a', 'notes/random-b', 'notes/near-floor', 'notes/zero', 'notes/missing', 'notes/deleted', 'notes/image'] as const;

function vectors(dims: number) {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const random = () => Float32Array.from({ length: dims }, rand);
  const query = random();
  const qNorm = Math.hypot(...query);
  const orth = random();
  const dot = orth.reduce((s, x, i) => s + x * query[i]!, 0);
  for (let i = 0; i < dims; i++) orth[i] = orth[i]! - dot * query[i]! / (qNorm * qNorm);
  const oNorm = Math.hypot(...orth);
  const nearFloor = Float32Array.from({ length: dims }, (_, i) => 0.8 * query[i]! / qNorm + 0.6 * orth[i]! / oNorm);
  return { query, a: random(), b: random(), nearFloor, zero: new Float32Array(dims) };
}

const literal = (v: Float32Array) => `[${Array.from(v).join(',')}]`;
const failingSql = (engine: BrainEngine): BrainEngine => Object.assign(Object.create(engine), {
  executeRaw: async () => { throw Object.assign(new Error('forced'), { code: 'XX000' }); },
}) as BrainEngine;

for (const kind of testBackends()) {
  describe(`cosine re-score in SQL keeps the JavaScript rules (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let ids: Record<string, number>;
    let v: ReturnType<typeof vectors>;
    let imageVector: Float32Array;
    const diffs = { cosine: 0, score: 0 };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const slug of SLUGS) {
        await importFromContent(engine, slug, serializeMarkdown({}, `${slug} body text`, '', { type: 'note', title: slug, tags: [] }), { noEmbed: true, forceRechunk: true });
      }
      const rows = await engine.executeRaw<{ slug: string; id: number }>(`SELECT p.slug, cc.id FROM content_chunks cc JOIN pages p ON p.id = cc.page_id`);
      ids = Object.fromEntries(rows.map(r => [r.slug, Number(r.id)]));
      const [{ dims }] = await engine.executeRaw<{ dims: number }>(
        `SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`);
      v = vectors(Number(dims));
      const [{ dims: imageDims }] = await engine.executeRaw<{ dims: number }>(
        `SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding_image'`);
      imageVector = vectors(Number(imageDims)).a;
      await engine.executeRaw(`ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_half halfvec(${Number(dims)})`);
      const set = async (slug: string, vec: Float32Array) => engine.executeRaw(
        `UPDATE content_chunks SET embedding = $1::vector, embedding_half = $1::vector::halfvec WHERE id = $2`, [literal(vec), ids[slug]]);
      await set('notes/random-a', v.a);
      await set('notes/random-b', v.b);
      await set('notes/near-floor', v.nearFloor);
      await set('notes/zero', v.zero);
      await set('notes/deleted', v.a);
      await set('notes/image', v.b);
      await engine.executeRaw(`UPDATE content_chunks SET embedding_image = $1::vector WHERE id = $2`, [literal(imageVector), ids['notes/image']]);
      await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/deleted'`);
    }, 120_000);
    afterAll(async () => {
      console.log(`[cosine-rescore-sql ${kind}] max |SQL - JS|: cosine ${diffs.cosine.toExponential(2)}, score ${diffs.score.toExponential(2)}`);
      await close?.();
    });

    const rows = (slugs: readonly string[], modality?: Record<string, 'image'>): SearchResult[] => slugs.map((slug, i) => ({
      slug, page_id: i + 1, title: slug, type: 'note', chunk_text: slug, chunk_source: 'compiled_truth',
      chunk_id: ids[slug] ?? null, chunk_index: 0, score: 1 - i * 0.05, stale: false, ...(modality?.[slug] ? { modality: modality[slug] } : {}),
    } as SearchResult));

    async function both(input: SearchResult[], query: Float32Array, column = 'embedding', imageSpace?: { queryEmbedding: Float32Array; column: string }) {
      let fellBack = false;
      const sql = await cosineReScore(engine, input, query, column, imageSpace, false, () => { fellBack = true; });
      expect(fellBack).toBe(false);
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      const js = await cosineReScore(failingSql(engine), input, query, column, imageSpace);
      warn.mockRestore();
      expect(sql.map(r => r.slug).sort()).toEqual(js.map(r => r.slug).sort());
      for (const r of sql) {
        const j = js.find(x => x.slug === r.slug)!;
        const dc = Math.abs((r.cosine ?? 0) - (j.cosine ?? 0)), ds = Math.abs(r.score - j.score);
        diffs.cosine = Math.max(diffs.cosine, dc); diffs.score = Math.max(diffs.score, ds);
        expect(dc).toBeLessThanOrEqual(COSINE_TOLERANCE);
        expect(ds).toBeLessThanOrEqual(SCORE_TOLERANCE);
      }
      for (let i = 0; i < sql.length; i++) {
        if (sql[i]!.slug !== js[i]!.slug) expect(Math.abs(sql[i]!.score - js[i]!.score)).toBeLessThanOrEqual(SCORE_TOLERANCE);
      }
      return { sql, js };
    }

    test('random, zero-norm, missing and invisible chunks', async () => {
      const { sql } = await both(rows(['notes/random-a', 'notes/random-b', 'notes/zero', 'notes/missing', 'notes/deleted']), v.query);
      const by = Object.fromEntries(sql.map(r => [r.slug, r]));
      expect(by['notes/random-a']!.cosine).toBeCloseTo(cosineSimilarity(v.query, v.a), 5);
      expect(by['notes/zero']!.cosine).toBe(0);
      expect(by['notes/missing']!.cosine).toBe(0);
      expect(by['notes/deleted']!.cosine).toBe(0);
    });

    test('the all-missing set and a chunkless row come back untouched', async () => {
      const input = [...rows(['notes/missing', 'notes/deleted']), { ...rows(['notes/random-a'])[0]!, chunk_id: null } as unknown as SearchResult];
      expect(await cosineReScore(engine, input, v.query)).toBe(input);
    });

    test('a query of other dimensions or zero norm scores every hydrated row 0', async () => {
      for (const query of [v.query.slice(1), new Float32Array(v.query.length)]) {
        const { sql } = await both(rows(['notes/random-a', 'notes/near-floor', 'notes/missing']), query);
        expect(sql.every(r => r.cosine === 0)).toBe(true);
        expect(sql.map(r => r.slug)).toEqual(['notes/random-a', 'notes/near-floor', 'notes/missing']);
      }
    });

    test('a halfvec column reads its exact float4 values', async () => {
      await both(rows(['notes/random-a', 'notes/random-b', 'notes/near-floor', 'notes/zero', 'notes/missing']), v.query, 'embedding_half');
    });

    test('the image space keeps the JavaScript path beside SQL text rows', async () => {
      const { sql } = await both(rows(['notes/random-a', 'notes/image'], { 'notes/image': 'image' }), v.query, 'embedding', { queryEmbedding: imageVector, column: 'embedding_image' });
      expect(sql.find(r => r.slug === 'notes/image')!.cosine).toBeCloseTo(1, 6);
    });

    test('rows at the 0.8 evidence floor agree within tolerance', async () => {
      const { sql, js } = await both(rows(['notes/near-floor', 'notes/random-a']), v.query);
      const s = sql.find(r => r.slug === 'notes/near-floor')!.cosine!, j = js.find(r => r.slug === 'notes/near-floor')!.cosine!;
      expect(Math.abs(s - 0.8)).toBeLessThan(1e-5);
      if ((s >= 0.8) !== (j >= 0.8)) console.log(`[cosine-rescore-sql ${kind}] 0.8 floor flip within tolerance: SQL ${s} JS ${j}`);
    });

    test('a failed statement falls back to JavaScript, warns once with the SQLSTATE and reports it', async () => {
      _resetWarnOnceForTests();
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      let fallbacks = 0;
      const input = rows(['notes/random-a', 'notes/random-b']);
      const first = await cosineReScore(failingSql(engine), input, v.query, 'embedding', undefined, false, () => { fallbacks++; });
      await cosineReScore(failingSql(engine), input, v.query, 'embedding', undefined, false, () => { fallbacks++; });
      const messages = warn.mock.calls.map(c => String(c[0]));
      warn.mockRestore();
      expect(fallbacks).toBe(2);
      expect(messages.filter(m => m.includes('cosine re-score in SQL failed'))).toEqual([expect.stringContaining('SQLSTATE XX000')]);
      expect(first.find(r => r.slug === 'notes/random-a')!.cosine).toBeCloseTo(cosineSimilarity(v.query, v.a), 6);
    });
  });
}
