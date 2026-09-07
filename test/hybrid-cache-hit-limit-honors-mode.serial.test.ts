/**
 * Repeated fresh-search behavior while semantic response caching is disabled.
 * Keeps the mode-limit, pagination and budget guarantees independent of cache
 * availability. Serial because embedding/gateway mocks are process-global.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';

/** Deterministic 1536d unit vector — identical for every call, so the
 * second consult matches the first write at cosine 1.0. */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

// Mock BEFORE importing hybrid.ts (spread keeps every other export live).
mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async () => fixedEmbedding(),
}));

// Import AFTER mocking.
const { hybridSearchCached, awaitPendingSearchCacheWrites } =
  await import('../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

const PAGE_TYPES = ['note', 'company', 'person', 'decision', 'concept', 'idea'];
const PAGE_COUNT = 60; // > tokenmax searchLimit (50), so every mode's cap — not the pool — drives the count.
const KEYWORD = 'gbrain4356widget';

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cache-hit-limit-'));
  process.env.GBRAIN_HOME = tmpHome;

  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  for (let i = 0; i < PAGE_COUNT; i++) {
    const type = PAGE_TYPES[i % PAGE_TYPES.length];
    const slug = `widgets/${type}-${i}`;
    const truth = `${KEYWORD} entry number ${i}, a ${type} about widgets.`;
    await engine.putPage(slug, { type, title: `Widget ${i}`, compiled_truth: truth });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
    ]);
  }
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('fresh repeated reads honor the resolved mode', () => {
  test('balanced mode, limit omitted: repeated reads return the same count (searchLimit=25), not clipped to 20', async () => {
    let firstMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const firstResults = await hybridSearchCached(engine, KEYWORD, {
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { firstMeta = m; },
    });
    expect(firstMeta?.cache?.status).toBe('disabled');
    expect(firstResults.length).toBe(25);

    await awaitPendingSearchCacheWrites();

    let repeatMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const repeatResults = await hybridSearchCached(engine, KEYWORD, {
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { repeatMeta = m; },
    });
    expect(repeatMeta?.cache?.status).toBe('disabled');
    expect(repeatResults.length).toBe(firstResults.length);
    expect(repeatResults.length).toBe(25);
  });

  test('conservative mode, limit omitted: repeated reads match (searchLimit=10, both below the old flat 20)', async () => {
    let firstMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const firstResults = await hybridSearchCached(engine, KEYWORD, {
      mode: 'conservative',
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { firstMeta = m; },
    });
    expect(firstMeta?.cache?.status).toBe('disabled');
    expect(firstResults.length).toBe(10);

    await awaitPendingSearchCacheWrites();

    let repeatMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const repeatResults = await hybridSearchCached(engine, KEYWORD, {
      mode: 'conservative',
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { repeatMeta = m; },
    });
    expect(repeatMeta?.cache?.status).toBe('disabled');
    expect(repeatResults.length).toBe(firstResults.length);
  });

  test('tokenmax mode, limit omitted: repeated reads return searchLimit=50 (above the old flat 20)', async () => {
    let firstMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const firstResults = await hybridSearchCached(engine, KEYWORD, {
      mode: 'tokenmax',
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { firstMeta = m; },
    });
    expect(firstMeta?.cache?.status).toBe('disabled');
    expect(firstResults.length).toBe(50);

    await awaitPendingSearchCacheWrites();

    let repeatMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const repeatResults = await hybridSearchCached(engine, KEYWORD, {
      mode: 'tokenmax',
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { repeatMeta = m; },
    });
    expect(repeatMeta?.cache?.status).toBe('disabled');
    expect(repeatResults.length).toBe(firstResults.length);
    expect(repeatResults.length).toBe(50);
  });

  test('explicit numeric limits survive repeated fresh reads', async () => {
    await hybridSearchCached(engine, KEYWORD, { limit: 3, autocut: false, relationalRetrieval: false });
    await awaitPendingSearchCacheWrites();

    let repeatMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const repeatResults = await hybridSearchCached(engine, KEYWORD, {
      limit: 3,
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { repeatMeta = m; },
    });
    expect(repeatMeta?.cache?.status).toBe('disabled');
    expect(repeatResults.length).toBe(3);
  });

  test('positive offsets preserve result counts across repeated fresh reads', async () => {
    let firstMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const firstResults = await hybridSearchCached(engine, KEYWORD, {
      limit: 9,
      offset: 2,
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { firstMeta = m; },
    });
    expect(firstMeta?.cache?.status).toBe('disabled');
    expect(firstResults.length).toBe(9);

    await awaitPendingSearchCacheWrites();

    let repeatMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const repeatResults = await hybridSearchCached(engine, KEYWORD, {
      limit: 9,
      offset: 2,
      autocut: false,
      relationalRetrieval: false,
      onMeta: (m) => { repeatMeta = m; },
    });
    expect(repeatMeta?.cache?.status).toBe('disabled');
    expect(repeatResults.length).toBe(9);
  });

});
