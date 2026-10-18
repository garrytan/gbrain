/**
 * [R13] (PR #5347) drain-integration pins — an embedder's single-input
 * over-length 400 on a model with NO declared cap must make the drains SPLIT
 * the page (deterministically, at once) instead of re-sending the same
 * doomed chunk every pass; an unrelated 400 must leave every stored chunk
 * byte-identical.
 *
 * test/embed-overlength-heal.test.ts covers the helper; these tests seed a
 * REAL PGLite page and run the actual drains against a fake embedder that
 * rejects any input over a hidden limit the way a hosted encoder does:
 *   - `runEmbedCore({stale})` → embedAllStale (src/commands/embed.ts)
 *   - `embedStaleForSource`   (src/core/embed-stale.ts)
 *
 * Serial: uses mock.module and the gateway's embedding model
 * (module-registry quarantine per docs/TESTING.md).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';

const HIDDEN_LIMIT = 500;
let embedBatchTexts: string[] = [];
let rejection: 'overlength' | 'unrelated' = 'overlength';

function fakeEmbed(texts: string[]): Float32Array[] {
  embedBatchTexts.push(...texts);
  for (const t of texts) {
    if (estimateEmbedTokens(t) > HIDDEN_LIMIT) {
      const message = rejection === 'overlength'
        ? `Input length ${estimateEmbedTokens(t)} exceeds maximum allowed token size ${HIDDEN_LIMIT}`
        : 'Incorrect API key provided';
      throw Object.assign(new Error(message), { status: 400 });
    }
  }
  return texts.map(() => { const v = new Float32Array(768); v[0] = 9; return v; });
}

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => fakeEmbed(texts),
  currentEmbeddingSignature: () => null,
  embedMultimodal: async (inputs: unknown[]) => inputs.map(() => new Float32Array(512)),
}));

const { runEmbedCore, _resetEmbedQuarantineForTest } = await import('../src/commands/embed.ts');
const { embedStaleForSource } = await import('../src/core/embed-stale.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { resetPgliteState } = await import('./helpers/reset-pglite.ts');
const { estimateEmbedTokens, DEFAULT_MAX_CHUNK_TOKENS } = await import('../src/core/chunkers/token-estimate.ts');
const { __setEmbedTransportForTests, configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { resolveMaxChunkTokens, learnedChunkCap, _resetLearnedChunkCapsForTest } = await import('../src/core/embedding-input-limit.ts');
const { _resetOverLengthHealForTest, MIN_USEFUL_CHUNK_TOKENS } = await import('../src/core/embed-overlength-heal.ts');
const { installFixtureChunks } = await import('./helpers/page-projection.ts');
import type { ChunkInput } from '../src/core/types.ts';

__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as never));

/** No recipe declaration and no GBRAIN_MAX_CHUNK_TOKENS: the case this fix exists for. */
const UNDECLARED_MODEL = 'ollama:nomic-embed-text';
const EXPECTED_CAP = Math.floor(HIDDEN_LIMIT * 0.6); // 300
const SIBLING_TEXT = 'short sibling that already has a vector';
const OVERSIZED =
  'The quarterly operating review covers hiring plans, infrastructure spend, customer renewals ' +
  'and the product roadmap for the next two quarters in considerable detail. '.repeat(60);

let engine: InstanceType<typeof PGLiteEngine>;
const priorChunkTokens = process.env.GBRAIN_MAX_CHUNK_TOKENS;

beforeAll(async () => {
  delete process.env.GBRAIN_MAX_CHUNK_TOKENS;
  resetGateway();
  configureGateway({ embedding_model: UNDECLARED_MODEL, embedding_dimensions: 768, env: {} });
  expect(resolveMaxChunkTokens()).toBe(DEFAULT_MAX_CHUNK_TOKENS);
  // Between the hidden limit and the default cap: the stored row fits OUR cap and fails THEIRS.
  expect(estimateEmbedTokens(OVERSIZED)).toBeGreaterThan(HIDDEN_LIMIT);
  expect(estimateEmbedTokens(OVERSIZED)).toBeLessThanOrEqual(DEFAULT_MAX_CHUNK_TOKENS);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  if (priorChunkTokens === undefined) delete process.env.GBRAIN_MAX_CHUNK_TOKENS;
  else process.env.GBRAIN_MAX_CHUNK_TOKENS = priorChunkTokens;
  __setEmbedTransportForTests(null);
  _resetLearnedChunkCapsForTest();
  _resetOverLengthHealForTest();
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  embedBatchTexts = [];
  rejection = 'overlength';
  _resetLearnedChunkCapsForTest();
  _resetOverLengthHealForTest();
  _resetEmbedQuarantineForTest();
  process.env.GBRAIN_EMBED_CONCURRENCY = '1';
});

async function seedPage(slug: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nseeded` });
  const siblingVec = new Float32Array(768);
  siblingVec[0] = 0.5;
  const chunks: ChunkInput[] = [
    { chunk_index: 0, chunk_text: SIBLING_TEXT, chunk_source: 'compiled_truth', token_count: 8, embedding: siblingVec },
    { chunk_index: 1, chunk_text: OVERSIZED, chunk_source: 'compiled_truth', token_count: 600, embedding: undefined },
  ];
  await installFixtureChunks(engine, slug, chunks);
}

async function assertSplitAtLearnedCap(slug: string): Promise<void> {
  // The observable first: the stored oversized row was split in the failing pass itself.
  const after = await engine.getChunks(slug, { includeEmbedding: true });
  expect(after.length).toBeGreaterThan(2);
  expect(learnedChunkCap(UNDECLARED_MODEL)).toBe(EXPECTED_CAP);
  expect(resolveMaxChunkTokens()).toBe(EXPECTED_CAP);
  for (const c of after) expect(estimateEmbedTokens(c.chunk_text)).toBeLessThanOrEqual(EXPECTED_CAP);
  expect(after.map(c => c.chunk_text).join('')).toContain('product roadmap');
  const sibling = after.find(c => c.chunk_index === 0)!;
  expect(sibling.chunk_text).toBe(SIBLING_TEXT);
  expect(sibling.embedding_is_null).toBe(false);
  expect(EXPECTED_CAP).toBeGreaterThanOrEqual(MIN_USEFUL_CHUNK_TOKENS);
}

describe('[R13]: an over-length rejection on an undeclared model splits the page', () => {
  test('runEmbedCore({stale}): the failing pass reports the failure, learns the cap and splits; the next pass embeds every piece', async () => {
    await seedPage('notes/overlength-cli');

    const first = await runEmbedCore(engine, { stale: true, quiet: true });
    expect(first.failures).toBe(1);
    expect(embedBatchTexts).toContain(OVERSIZED);
    await assertSplitAtLearnedCap('notes/overlength-cli');

    embedBatchTexts = [];
    const second = await runEmbedCore(engine, { stale: true, quiet: true });
    expect(second.failures).toBe(0);
    expect(second.embedded).toBeGreaterThanOrEqual(2);
    expect(embedBatchTexts).not.toContain(OVERSIZED);
    for (const t of embedBatchTexts) expect(estimateEmbedTokens(t)).toBeLessThanOrEqual(HIDDEN_LIMIT);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('embedStaleForSource: same split through the shared drain', async () => {
    await seedPage('notes/overlength-source');
    const first = await embedStaleForSource(engine, 'default', { embedFn: async (texts) => fakeEmbed(texts) });
    expect(first.failures).toBe(1);
    await assertSplitAtLearnedCap('notes/overlength-source');

    const second = await embedStaleForSource(engine, 'default', { embedFn: async (texts) => fakeEmbed(texts) });
    expect(second.failures ?? 0).toBe(0);
    expect(second.embedded).toBeGreaterThanOrEqual(2);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('a later page in the same process is healed BEFORE its embed call at the learned cap (no second 400)', async () => {
    await seedPage('notes/overlength-first');
    await runEmbedCore(engine, { stale: true, quiet: true });
    expect(learnedChunkCap(UNDECLARED_MODEL)).toBe(EXPECTED_CAP);

    await seedPage('notes/overlength-later');
    embedBatchTexts = [];
    const result = await runEmbedCore(engine, { stale: true, quiet: true });
    expect(result.failures).toBe(0);
    expect(embedBatchTexts).not.toContain(OVERSIZED);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('an unrelated 400 never rewrites a chunk and learns nothing', async () => {
    rejection = 'unrelated';
    await seedPage('notes/overlength-unrelated');
    const before = await engine.getChunks('notes/overlength-unrelated', { includeEmbedding: true });

    const result = await runEmbedCore(engine, { stale: true, quiet: true });
    expect(result.failures).toBe(1);
    expect(result.failure_samples[0]).toContain('Incorrect API key');
    const after = await engine.getChunks('notes/overlength-unrelated', { includeEmbedding: true });
    expect(after.map(c => [c.id, c.chunk_index, c.chunk_text, c.embedding_is_null]))
      .toEqual(before.map(c => [c.id, c.chunk_index, c.chunk_text, c.embedding_is_null]));
    expect(learnedChunkCap(UNDECLARED_MODEL)).toBeUndefined();
    expect(resolveMaxChunkTokens()).toBe(DEFAULT_MAX_CHUNK_TOKENS);
  });
});
