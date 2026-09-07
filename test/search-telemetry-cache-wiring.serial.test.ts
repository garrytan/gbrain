/**
 * Production-wrapper regression coverage with semantic response caching disabled.
 * Fresh reads must retain filtering, metadata and telemetry guarantees; legacy
 * cache implementation behavior is covered by the direct cache-class suites.
 * Serial because embedding and gateway configuration are process-global.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';

/** Deterministic 1536d unit vector — same for every call, so an identical
 * query's second consult matches its first write at cosine 1.0. */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

// Pluggable behavior so individual tests can simulate an embed-provider
// failure (the 'disabled'-via-catch flavor). null → deterministic vector.
let embedBehavior: (() => Promise<Float32Array>) | null = null;

// Mock the embedding seam BEFORE importing hybrid.ts so both the cache-lookup
// embed and the inner vector-arm embed resolve without a provider call. Spread
// the real module so every other export stays live.
mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => (embedBehavior ? embedBehavior() : fixedEmbedding()),
  embedQuery: async () => (embedBehavior ? embedBehavior() : fixedEmbedding()),
}));

// Import AFTER mocking.
const { hybridSearch, hybridSearchCached, awaitPendingSearchCacheWrites, _resetPendingSearchCacheWritesForTests } =
  await import('../src/core/search/hybrid.ts');
const { getTelemetryWriter, _resetTelemetryWriterForTest } = await import('../src/core/search/telemetry.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;

interface Counters {
  c: number;
  hit: number;
  miss: number;
  rank1: number;
  results: number;
  tokens: number;
}

/** Flush the writer and read the summed counters back from the table. */
async function readCounters(): Promise<Counters> {
  await getTelemetryWriter().flush();
  const rows = await engine.executeRaw<Counters>(
    `SELECT COALESCE(SUM(count), 0)::int        AS c,
            COALESCE(SUM(cache_hit), 0)::int    AS hit,
            COALESCE(SUM(cache_miss), 0)::int   AS miss,
            COALESCE(SUM(count_rank1), 0)::int  AS rank1,
            COALESCE(SUM(sum_results), 0)::int  AS results,
            COALESCE(SUM(sum_tokens), 0)::int   AS tokens
       FROM search_telemetry`,
  );
  return rows[0];
}

beforeAll(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cache-telemetry-'));
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

  await engine.putPage('alice-foo', {
    type: 'person',
    title: 'Alice Foo',
    compiled_truth: 'Alice Foo is a builder who ships search telemetry fixtures.',
  });
  await engine.upsertChunks('alice-foo', [
    { chunk_index: 0, chunk_text: 'Alice Foo is a builder who ships search telemetry fixtures.', chunk_source: 'compiled_truth' },
  ]);
  await engine.putPage('bob-bar', {
    type: 'person',
    title: 'Bob Bar',
    compiled_truth: 'Bob Bar is a builder who reviews cache wiring fixtures.',
  });
  await engine.upsertChunks('bob-bar', [
    { chunk_index: 0, chunk_text: 'Bob Bar is a builder who reviews cache wiring fixtures.', chunk_source: 'compiled_truth' },
  ]);
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

beforeEach(async () => {
  embedBehavior = null;
  _resetTelemetryWriterForTest();
  _resetPendingSearchCacheWritesForTests();
  await engine.executeRaw('DELETE FROM search_telemetry');
  await engine.executeRaw('DELETE FROM query_cache');
});

describe('hybridSearchCached — telemetry carries the cache outcome', () => {
  test('repeated fresh reads each record results and rank-1 without cache hit or miss counts', async () => {
    const first = await hybridSearchCached(engine, 'alice telemetry fixtures', { limit: 5 });
    expect(first.length).toBeGreaterThan(0);
    await awaitPendingSearchCacheWrites();

    const cacheRows = await engine.executeRaw<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM query_cache',
    );
    expect(cacheRows[0].n).toBe(0);

    const afterFirst = await readCounters();
    expect(afterFirst.c).toBe(1);
    expect(afterFirst.miss).toBe(0);
    expect(afterFirst.hit).toBe(0);
    expect(afterFirst.rank1).toBe(1);
    expect(afterFirst.results).toBeGreaterThan(0);

    let meta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const second = await hybridSearchCached(engine, 'alice telemetry fixtures', {
      limit: 5,
      onMeta: (m) => { meta = m; },
    });
    expect(meta?.cache?.status).toBe('disabled');
    expect(second.length).toBeGreaterThan(0);

    const afterSecond = await readCounters();
    expect(afterSecond.c).toBe(2);
    expect(afterSecond.miss).toBe(0);
    expect(afterSecond.hit).toBe(0);
    expect(afterSecond.rank1).toBe(2);
    expect(afterSecond.results).toBeGreaterThan(afterFirst.results);
    expect(afterSecond.tokens - afterFirst.tokens).toBe(afterFirst.tokens);
  });

  test('embedding failure keeps keyword fallback and records once without cache counters', async () => {
    embedBehavior = async () => { throw new Error('embed provider down'); };
    const results = await hybridSearchCached(engine, 'bob cache wiring', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);

    const counters = await readCounters();
    expect(counters.c).toBe(1);
    expect(counters.hit).toBe(0);
    expect(counters.miss).toBe(0);
    expect(counters.rank1).toBe(1);
  });

  test('consult skipped (useCache:false): recorded once, neither counter', async () => {
    const results = await hybridSearchCached(engine, 'bob cache wiring', { limit: 5, useCache: false });
    expect(results.length).toBeGreaterThan(0);

    const counters = await readCounters();
    expect(counters.c).toBe(1);
    expect(counters.hit).toBe(0);
    expect(counters.miss).toBe(0);
    expect(counters.rank1).toBe(1);
    expect(counters.results).toBeGreaterThan(0);
  });
});

describe('bare hybridSearch — direct callers unchanged', () => {
  test('records once with no cache classification', async () => {
    let meta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const results = await hybridSearch(engine, 'bob cache wiring', {
      limit: 5,
      onMeta: (m) => { meta = m; },
    });
    expect(results.length).toBeGreaterThan(0);
    expect(meta?.cache).toBeUndefined();

    const counters = await readCounters();
    expect(counters.c).toBe(1);
    expect(counters.hit).toBe(0);
    expect(counters.miss).toBe(0);
  });
});
