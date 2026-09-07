/**
 * Production-wrapper regression coverage with semantic response caching disabled.
 * Fresh reads must retain filtering, metadata and telemetry guarantees; legacy
 * cache implementation behavior is covered by the direct cache-class suites.
 * Serial because embedding and gateway configuration are process-global.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';

/** Deterministic 1536d unit vector so consults match writes at cosine 1.0. */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async () => fixedEmbedding(),
}));

const { hybridSearchCached, awaitPendingSearchCacheWrites } =
  await import('../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

setDefaultTimeout(30_000);

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-adaptive-cache-plane-'));
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

  const fixtures: Array<[string, string, string]> = [
    ['alice-foo', 'Alice Foo', 'person'],
    ['bob-bar', 'Bob Bar', 'company'],
  ];
  for (const [slug, title, type] of fixtures) {
    const truth = `${title} is a builder.`;
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

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM query_cache');
});

describe('adaptive return remains fresh during cache containment', () => {
  test('adaptive-on calls return stable results without writing cache rows', async () => {
    let firstMeta: HybridSearchMeta | undefined;
    const first = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      adaptiveReturn: true,
      onMeta: (m) => { firstMeta = m; },
    });
    expect(firstMeta?.cache?.status).toBe('disabled');
    expect(first.length).toBeGreaterThan(0);
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(0);

    let repeatMeta: HybridSearchMeta | undefined;
    const second = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      adaptiveReturn: true,
      onMeta: (m) => { repeatMeta = m; },
    });
    expect(repeatMeta?.cache?.status).toBe('disabled');
    expect(second.map((r) => r.slug).sort()).toEqual(first.map((r) => r.slug).sort());
  });

  test('switching adaptive return off leaves the cache empty', async () => {
    await hybridSearchCached(engine, 'builder', { limit: 10, adaptiveReturn: true });
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(0);

    let offMeta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'builder', {
      limit: 10,
      onMeta: (m) => { offMeta = m; },
    });
    expect(offMeta?.cache?.status).toBe('disabled');
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(0);
  });
});

describe('per-call dedup remains fresh during cache containment', () => {
  test('default and dedupOpts reads both leave the cache empty', async () => {
    await hybridSearchCached(engine, 'builder', { limit: 10 });
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(0);

    let dedupMeta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'builder', {
      limit: 10,
      dedupOpts: { maxPerPage: 1 },
      onMeta: (m) => { dedupMeta = m; },
    });
    expect(dedupMeta?.cache?.status).toBe('disabled');

    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(0);
  });
});
