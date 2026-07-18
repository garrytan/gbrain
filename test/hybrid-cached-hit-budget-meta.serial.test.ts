/**
 * Cache-HIT budget-meta provenance — companion to the miss-path fix.
 *
 * With a per-call tokenBudget, the miss path stores an already-budgeted
 * result set; a subsequent HIT re-applies the same budget to that trimmed
 * payload (a structural no-op: tokenBudget is folded into knobsHash, so a
 * hit only ever serves a lookup with the identical resolved budget as the
 * write) — and pre-fix published that no-op pass's meta, reporting
 * dropped=0 while the miss that produced the very same result set reported
 * the real cut. This file drives a real store→hit roundtrip (mocked
 * `embedQuery` for a deterministic vector, real PGLite SemanticQueryCache)
 * and pins that the hit's token_budget matches the miss's.
 *
 * Serial: mock.module + gateway/global-env mutation (isolation guard R2).
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
  // Hermetic config home so the developer's real ~/.gbrain/config.json
  // can't leak an embedding_model that flips the cache consult to
  // 'disabled' via isCacheSafe.
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-hit-budget-meta-'));
  process.env.GBRAIN_HOME = tmpHome;

  // Pin the gateway to a 1536d provider BEFORE initSchema so the
  // query_cache.embedding column is sized for the mock vectors. The fake
  // key is never used — embedQuery is mocked above.
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Three keyword-findable pages, ~200 tokens each, mixed types so dedup's
  // type-diversity layer keeps all of them. putPage never chunks —
  // searchKeyword joins content_chunks, so chunks are explicit.
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

describe('cache HIT — token_budget provenance', () => {
  test('hit reports the same cut the miss reported, not the no-op re-application', async () => {
    // Miss: budget 250 keeps ~1 of 3 rows (~209 tokens each); the meta
    // carries the real cut from the inner enforcement.
    let missMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const missResults = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      tokenBudget: 250,
      onMeta: (m) => { missMeta = m; },
    });
    expect(missResults.length).toBeGreaterThan(0);
    expect(missMeta?.cache?.status).toBe('miss');
    expect(missMeta?.token_budget?.budget).toBe(250);
    const missDropped = missMeta?.token_budget?.dropped;
    expect(missDropped).toBeGreaterThan(0);

    await awaitPendingSearchCacheWrites();

    // Hit: identical query + knobs (tokenBudget is part of knobsHash, so
    // this is the ONLY kind of lookup the stored row can serve). The
    // published budget record must match the miss's — pre-fix it was the
    // outer no-op pass's meta with dropped=0.
    let hitMeta: import('../src/core/types.ts').HybridSearchMeta | undefined;
    const hitResults = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      tokenBudget: 250,
      onMeta: (m) => { hitMeta = m; },
    });
    expect(hitMeta?.cache?.status).toBe('hit');
    expect(hitResults.length).toBe(missResults.length);
    expect(hitMeta?.token_budget?.budget).toBe(250);
    expect(hitMeta?.token_budget?.dropped).toBe(missDropped);
    expect(hitMeta?.token_budget?.kept).toBe(missMeta?.token_budget?.kept);
  });
});
