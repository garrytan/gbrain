/**
 * Large pages (Wave A, T3/T16): the CLI embed paths meter a large page under
 * `embed.max_usd_per_page`. `gbrain embed --all` and `--stale` send the
 * provider only the newest chunks that fit the page's remaining budget and
 * leave the page unstamped (partially embedded, keyword-searchable); a held
 * page sends nothing until `--slugs <slug> --max-usd N` approves it. The
 * shared sweep (sync, cycle, minion) and the phase-end closure meter the same way.
 *
 * Serial: uses mock.module (module-registry quarantine per docs/TESTING.md).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';

let embedded: string[] = [];
mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    embedded.push(...texts);
    return texts.map(() => new Float32Array(1536).fill(0.1));
  },
  currentEmbeddingSignature: () => null,
  embedMultimodal: async (inputs: unknown[]) => inputs.map(() => new Float32Array(512)),
}));

const { runEmbedCore } = await import('../src/commands/embed.ts');
const { embedStaleForSource, embedStalePages } = await import('../src/core/embed-stale.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { resetPgliteState } = await import('./helpers/reset-pglite.ts');
const { installFixtureChunks } = await import('./helpers/page-projection.ts');
const { __setEmbedTransportForTests } = await import('../src/core/ai/gateway.ts');
const { PAGE_INLINE_MAX_BYTES } = await import('../src/core/page-size-policy.ts');
const { estimateCostFromChars } = await import('../src/core/embedding-pricing.ts');
const { holdPageEmbedding, PAGE_EMBED_CAP_KEY } = await import('../src/core/page-embedding-budget.ts');
import type { ChunkInput } from '../src/core/types.ts';

__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as never));

const CHUNK_CHARS = 7_000;
const chunkCost = estimateCostFromChars(CHUNK_CHARS, 0.13);
const texts = Array.from({ length: 5 }, (_, i) => `chunk ${i} `.padEnd(CHUNK_CHARS, 'alice-example met acme-example. '));
let engine: InstanceType<typeof PGLiteEngine>;

beforeAll(async () => {
  process.env.GBRAIN_EMBED_CONCURRENCY = '1';
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);
afterAll(async () => {
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
  __setEmbedTransportForTests(null);
  await engine.disconnect();
});
beforeEach(async () => {
  await resetPgliteState(engine);
  embedded = [];
});

async function seedLargePage(slug: string): Promise<number> {
  const body = 'Weekly notes from acme-example with alice-example. '.repeat(Math.ceil((PAGE_INLINE_MAX_BYTES + 4096) / 51));
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body });
  const chunks: ChunkInput[] = texts.map((chunk_text, chunk_index) => ({ chunk_index, chunk_text, chunk_source: 'compiled_truth', token_count: 2000 }));
  await installFixtureChunks(engine, slug, chunks);
  return (await engine.getPage(slug))!.id;
}

async function vectorIndexes(slug: string): Promise<number[]> {
  const chunks = await engine.getChunks(slug, { includeEmbedding: true });
  return chunks.filter(c => c.embedding_is_null === false).map(c => c.chunk_index).sort();
}

describe('CLI embed paths meter large pages', () => {
  test('--all embeds only the newest chunks that fit the per-page cap', async () => {
    await engine.setConfig(PAGE_EMBED_CAP_KEY, String(chunkCost * 2.5));
    await seedLargePage('chats/all');
    const result = await runEmbedCore(engine, { all: true, quiet: true });
    expect(embedded.map(t => t.slice(0, 8)).sort()).toEqual(['chunk 3 ', 'chunk 4 ']);
    expect(await vectorIndexes('chats/all')).toEqual([3, 4]);
    expect(result.embedded).toBe(2);
  });

  test('--stale embeds only the newest chunks that fit, and a second run spends nothing more', async () => {
    await engine.setConfig(PAGE_EMBED_CAP_KEY, String(chunkCost * 2.5));
    await seedLargePage('chats/stale');
    await runEmbedCore(engine, { stale: true, quiet: true });
    expect(await vectorIndexes('chats/stale')).toEqual([3, 4]);
    embedded = [];
    await runEmbedCore(engine, { stale: true, quiet: true });
    expect(embedded).toEqual([]);
  });

  test('a held page sends nothing until --slugs with --max-usd approves it', async () => {
    await engine.setConfig(PAGE_EMBED_CAP_KEY, '0');
    const pageId = await seedLargePage('chats/held');
    await holdPageEmbedding(engine, pageId, 'upgrade_backfill');
    await runEmbedCore(engine, { all: true, quiet: true });
    await runEmbedCore(engine, { slugs: ['chats/held'], quiet: true });
    expect(embedded).toEqual([]);
    await runEmbedCore(engine, { slugs: ['chats/held'], quiet: true, approvedPageCapUsd: chunkCost * 6 });
    expect(embedded).toHaveLength(5);
    expect(await vectorIndexes('chats/held')).toEqual([0, 1, 2, 3, 4]);
  });

  test('the shared stale sweep and the phase-end closure embed only what fits', async () => {
    await engine.setConfig(PAGE_EMBED_CAP_KEY, String(chunkCost * 2.5));
    await seedLargePage('chats/sweep');
    await embedStaleForSource(engine, 'default', { embedFn: async (batch: string[]) => { embedded.push(...batch); return batch.map(() => new Float32Array(1536).fill(0.1)); } });
    expect(await vectorIndexes('chats/sweep')).toEqual([3, 4]);

    await seedLargePage('chats/closure');
    embedded = [];
    await embedStalePages(engine, ['chats/closure'], 'default', { embedFn: async (batch: string[]) => { embedded.push(...batch); return batch.map(() => new Float32Array(1536).fill(0.1)); } });
    expect(embedded.map(t => t.slice(0, 8)).sort()).toEqual(['chunk 3 ', 'chunk 4 ']);
    expect(await vectorIndexes('chats/closure')).toEqual([3, 4]);
  });
});
