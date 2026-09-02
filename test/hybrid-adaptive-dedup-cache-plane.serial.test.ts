/**
 * 2026-08 fix wave (E5b) — cache-plane behavior flips in hybridSearchCached.
 *
 * Two changes moved in opposite directions and neither had an integration pin
 * (only the knobs-hash key-divergence was unit-pinned in search-mode.test.ts):
 *   1. adaptive-on calls now CACHE — the gate params + resolved intent class
 *      fold into knobsHash v=27, so the old blanket skip is gone. A regression
 *      that quietly re-adds the skip erases the wave's cost win; a regression
 *      that drops the hash fold is cross-config contamination.
 *   2. per-call dedupOpts now SKIPS the cache — it is result-affecting
 *      (maxPerPage/cosine overrides) but not part of the hash, so a
 *      maxPerPage:1 caller must never be served a stored default-cap row
 *      (same contamination class as #3985 types and #3442 dates).
 *
 * Serial: mock.module + gateway/global-env mutation (harness shape copied
 * from test/hybrid-types-cache-skip.serial.test.ts).
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

describe('E5b — adaptive-on calls now cache (skip removed, hash-folded instead)', () => {
  test('adaptive-on miss STORES a row; the identical adaptive-on lookup HITS it', async () => {
    let missMeta: HybridSearchMeta | undefined;
    const first = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      adaptiveReturn: true,
      onMeta: (m) => { missMeta = m; },
    });
    // Pre-wave this was 'disabled' (blanket adaptive skip). Now it runs the
    // cache plane: miss + store.
    expect(missMeta?.cache?.status).toBe('miss');
    expect(first.length).toBeGreaterThan(0);
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(1);

    let hitMeta: HybridSearchMeta | undefined;
    const second = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      adaptiveReturn: true,
      onMeta: (m) => { hitMeta = m; },
    });
    expect(hitMeta?.cache?.status).toBe('hit');
    expect(second.map((r) => r.slug).sort()).toEqual(first.map((r) => r.slug).sort());
  });

  test('an adaptive-on row is NEVER served to an adaptive-off lookup (v=27 key divergence, end to end)', async () => {
    await hybridSearchCached(engine, 'builder', { limit: 10, adaptiveReturn: true });
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(1);

    let offMeta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'builder', {
      limit: 10,
      onMeta: (m) => { offMeta = m; },
    });
    // Same query, same embedding (cosine 1.0) — only knobsHash separates
    // them. A 'hit' here means the ar=/ari= fold regressed out of the key.
    expect(offMeta?.cache?.status).toBe('miss');
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(2);
  });
});

describe('E5b adjunct — per-call dedupOpts skips the cache (not hash-folded)', () => {
  test('a stored default-cap row is never served to a dedupOpts read (and the dedupOpts run stores nothing)', async () => {
    // 1. Plain miss-run stores a row.
    await hybridSearchCached(engine, 'builder', { limit: 10 });
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(1);

    // 2. Same query WITH per-call dedupOpts: identical embedding + knobs
    //    would have HIT the stored row — must bypass instead.
    let dedupMeta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'builder', {
      limit: 10,
      dedupOpts: { maxPerPage: 1 },
      onMeta: (m) => { dedupMeta = m; },
    });
    expect(dedupMeta?.cache?.status).toBe('disabled');

    // 3. The dedupOpts run must not have stored anything either — a
    //    maxPerPage:1 result set served to a default-cap lookup is the
    //    reverse contamination.
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(1);
  });
});
