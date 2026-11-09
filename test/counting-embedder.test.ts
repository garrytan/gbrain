/**
 * The counting embedder test helper (test/helpers/counting-embedder.ts; Wave C finding ceo-r3-native-6).
 *
 * 1. Protects: the helper returns full-size vectors (the dimensions the brain's embedding column declares, not a stub
 *    length), the same unit vector for the same text and a different one for different text, exact counts of provider
 *    calls, inputs and tokens, and no network call; and a real page embedded through the normal embed path
 *    (`runEmbedCore`, the stale sweep) stores one distinct full-size unit vector per chunk, one provider input each.
 * 2. Fails when: the helper is missing, a vector is shorter than the column, vectors change between calls, counts
 *    drift from the inputs, or the embed path stores vectors other than the helper's.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { embed } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { countingVector, installCountingEmbedder, type CountingEmbedder } from './helpers/counting-embedder.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const declaredDims = async (engine: BrainEngine) => {
  const [column] = await engine.executeRaw<{ type: string }>(`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
    WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`);
  return Number(/\((\d+)\)/.exec(column!.type)![1]);
};

for (const kind of testBackends()) describe(`counting embedder (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  let embedder: CountingEmbedder | undefined;

  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close(); });
  afterEach(() => { embedder?.restore(); embedder = undefined; });

  test('full-size, deterministic unit vectors and exact counts, with no network call', async () => {
    const dims = await declaredDims(engine);
    const fetches: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => { fetches.push(String(input)); throw new Error('no network'); }) as unknown as typeof fetch;
    try {
      embedder = await installCountingEmbedder(engine);
      expect(embedder.dims).toBe(dims);
      expect(dims).toBeGreaterThan(256);
      const texts = ['alpha planning notes for acme-example', 'beta', 'alpha planning notes for acme-example', 'a longer gamma paragraph '.repeat(20)];
      const first = await embed(texts);
      const second = await embed([texts[1]!]);
      expect(first.map(v => v.length)).toEqual(texts.map(() => dims));
      expect(Array.from(first[0]!)).toEqual(Array.from(first[2]!));
      expect(Array.from(first[0]!)).not.toEqual(Array.from(first[1]!));
      expect(Array.from(second[0]!)).toEqual(Array.from(first[1]!));
      for (const [i, text] of texts.entries()) expect(Array.from(first[i]!)).toEqual(Array.from(Float32Array.from(countingVector(text, dims))));
      expect(Math.hypot(...first[3]!)).toBeCloseTo(1, 5);
      expect({ calls: embedder.calls, inputs: embedder.inputs, tokens: embedder.tokens })
        .toEqual({ calls: 2, inputs: 5, tokens: [...texts, texts[1]!].reduce((sum, text) => sum + Math.ceil(text.length / 4), 0) });
      expect(fetches).toEqual([]);
    } finally { globalThis.fetch = realFetch; }
  }, 60_000);

  test('a real page embedded through the normal embed path stores one distinct full-size unit vector per chunk, one input each', async () => {
    embedder = await installCountingEmbedder(engine);
    const body = Array.from({ length: 40 }, (_, i) => `## Week ${i}\n\nPlanning notes ${i} from acme-example with alice-example: ${'roadmap pricing hiring metrics '.repeat(30)}\n`).join('\n');
    await importFromContent(engine, 'notes/counting-embedder', `---\ntitle: Counting embedder\ntype: note\n---\n\n${body}`, { sourceId: 'default', noEmbed: true });
    await runEmbedCore(engine, { stale: true, quiet: true });
    const rows = await engine.executeRaw<{ dims: number; vector: string }>(`SELECT vector_dims(c.embedding) AS dims, c.embedding::text AS vector
      FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = 'notes/counting-embedder' ORDER BY c.chunk_index`);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map(row => Number(row.dims))).toEqual(rows.map(() => embedder!.dims));
    expect(embedder.inputs).toBe(rows.length);
    expect(embedder.calls).toBeGreaterThanOrEqual(1);
    expect(embedder.tokens).toBeGreaterThan(rows.length);
    expect(new Set(rows.map(row => row.vector)).size).toBe(rows.length);
    for (const row of rows) expect(Math.hypot(...row.vector.replace(/^\[|\]$/g, '').split(',').map(Number))).toBeCloseTo(1, 4);
  }, 120_000);
});
