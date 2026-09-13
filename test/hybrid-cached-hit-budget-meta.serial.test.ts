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

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-hit-budget-meta-'));
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

  const longText = 'x'.repeat(800);
  const fixtures: Array<[string, string, string]> = [
    ['alice-foo', 'Alice Foo', 'person'],
    ['bob-bar', 'Bob Bar', 'company'],
    ['carol-baz', 'Carol Baz', 'note'],
  ];
  for (const [slug, title, type] of fixtures) {
    const truth = `${title} is a builder. ${longText}`;
    await engine.putPage(slug, { type, title, compiled_truth: truth });
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

describe('fresh repeated reads preserve token-budget provenance', () => {
  test('repeated reads report the original inner budget cut', async () => {
    let firstMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const firstResults = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      tokenBudget: 250,
      onMeta: (m) => { firstMeta = m; },
    });
    expect(firstResults.length).toBeGreaterThan(0);
    expect(firstMeta?.cache?.status).toBe('disabled');
    expect(firstMeta?.token_budget?.budget).toBe(250);
    const firstDropped = firstMeta?.token_budget?.dropped;
    expect(firstDropped).toBeGreaterThan(0);

    await awaitPendingSearchCacheWrites();

    let repeatMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const repeatResults = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      tokenBudget: 250,
      onMeta: (m) => { repeatMeta = m; },
    });
    expect(repeatMeta?.cache?.status).toBe('disabled');
    expect(repeatResults.length).toBe(firstResults.length);
    expect(repeatMeta?.token_budget?.budget).toBe(250);
    expect(repeatMeta?.token_budget?.dropped).toBe(firstDropped);
    expect(repeatMeta?.token_budget?.kept).toBe(firstMeta?.token_budget?.kept);
  });
});
