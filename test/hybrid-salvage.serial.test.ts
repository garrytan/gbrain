/**
 * WP2/T3 (ENG-15) — allSettled salvage regression suite.
 *
 * Pins the three salvage branches of the embed fan-out plus the vector-arm
 * fan-out and the ENG-7 kill switch, via the mock.module embedding pattern
 * (seeded from test/hybrid-meta.serial.test.ts +
 * test/hybrid-cached-hit-budget-meta.serial.test.ts):
 *
 *   A. one variant embed fails → original survives; `expansion_partial`
 *   B. ORIGINAL embed fails, variants ok → variant lists salvaged, cosine
 *      re-score SKIPPED; `expansion_partial` + `rescore_skipped`
 *   C. all embeds fail → keyword-only; `embed_unavailable`/`embed_timeout`
 *   D. every searchVector arm throws → keyword-only; `vector_arm_failed`
 *   E. GBRAIN_SEARCH_SALVAGE=off restores all-or-nothing (one variant
 *      failure abandons every embedding)
 *
 * Also pins the clean-run contract: degraded === [] (D3 "empty degraded =
 * clean miss") and retrieved_count present on every path.
 *
 * Serial: mock.module + gateway/global-env mutation (isolation guard R2).
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';
import type { HybridSearchMeta } from '../src/core/types.ts';

/** Deterministic 1536d unit vector. */
function fixedEmbedding(): Float32Array {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(1 + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
}

// Marker-driven per-query failure so one allSettled fan-out can mix
// fulfilled and rejected slots. Mock BEFORE importing hybrid.ts.
mock.module('../src/core/embedding.ts', () => ({
  ...realEmbedding,
  embed: async () => fixedEmbedding(),
  embedQuery: async (text: string) => {
    if (String(text).includes('EMBEDTIMEOUT')) {
      throw Object.assign(new Error('mock embed deadline'), { name: 'TimeoutError' });
    }
    if (String(text).includes('EMBEDFAIL')) throw new Error('mock embed provider failure');
    return fixedEmbedding();
  },
}));

// Import AFTER mocking.
const { hybridSearch } = await import('../src/core/search/hybrid.ts');
const { configureGateway, resetGateway } = await import('../src/core/ai/gateway.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;
const savedSalvage = process.env.GBRAIN_SEARCH_SALVAGE;

beforeAll(async () => {
  // Hermetic config home so the developer's real ~/.gbrain/config.json
  // can't leak an embedding_model that changes column resolution.
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-salvage-'));
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
    const truth = `${title} is a builder working on search salvage.`;
    await engine.putPage(slug, { type, title, compiled_truth: truth });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
    ]);
  }
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  if (savedSalvage === undefined) delete process.env.GBRAIN_SEARCH_SALVAGE;
  else process.env.GBRAIN_SEARCH_SALVAGE = savedSalvage;
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
  delete process.env.GBRAIN_SEARCH_SALVAGE;
});

async function run(
  query: string,
  opts: Parameters<typeof hybridSearch>[2] = {},
): Promise<{ results: Awaited<ReturnType<typeof hybridSearch>>; meta: HybridSearchMeta }> {
  let meta: HybridSearchMeta | undefined;
  const results = await hybridSearch(engine, query, {
    ...opts,
    onMeta: (m) => { meta = m; },
  });
  if (!meta) throw new Error('onMeta never fired');
  return { results, meta };
}

const stages = (meta: HybridSearchMeta): string[] => (meta.degraded ?? []).map((d) => d.stage);

describe('clean run — empty degraded = clean (D3)', () => {
  test('no failures → degraded [] and retrieved_count present', async () => {
    const { meta } = await run('builder', { limit: 5 });
    expect(meta.vector_enabled).toBe(true);
    expect(meta.degraded).toEqual([]);
    expect(typeof meta.retrieved_count).toBe('number');
  });
});

describe('branch A — one variant embed fails, original survives', () => {
  test('expansion_partial (variant_embed_failed); vector still ran', async () => {
    const { results, meta } = await run('builder', {
      limit: 5,
      expansion: true,
      expandFn: async () => ['builder', 'EMBEDFAIL variant query'],
    });
    expect(meta.vector_enabled).toBe(true);
    expect(meta.expansion_applied).toBe(true);
    expect(stages(meta)).toContain('expansion_partial');
    expect(meta.degraded!.find((d) => d.stage === 'expansion_partial')?.reason)
      .toBe('variant_embed_failed');
    expect(stages(meta)).not.toContain('rescore_skipped');
    expect(stages(meta)).not.toContain('embed_unavailable');
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('branch B — ORIGINAL embed fails, variants ok', () => {
  test('variant lists salvaged; cosine re-score skipped; both stages emitted', async () => {
    const { results, meta } = await run('EMBEDFAIL builder original', {
      limit: 5,
      expansion: true,
      expandFn: async (q) => [q, 'builder salvage variant'],
    });
    // Vector RAN (via the surviving variant embeds) — the pre-wave behavior
    // was a silent keyword-only fallback.
    expect(meta.vector_enabled).toBe(true);
    expect(stages(meta)).toContain('expansion_partial');
    expect(meta.degraded!.find((d) => d.stage === 'expansion_partial')?.reason)
      .toBe('original_embed_failed');
    expect(stages(meta)).toContain('rescore_skipped');
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('branch C — all embeds fail', () => {
  test('keyword-only + embed_unavailable (provider error class)', async () => {
    const { results, meta } = await run('EMBEDFAIL builder', { limit: 5, expansion: false });
    expect(meta.vector_enabled).toBe(false);
    expect(stages(meta)).toContain('embed_unavailable');
    expect(meta.degraded!.find((d) => d.stage === 'embed_unavailable')?.reason)
      .toBe('provider_error');
    // Keyword arm still carried the response (orFallback recall).
    expect(results.length).toBeGreaterThan(0);
  });

  test('all-timeout failures classify as embed_timeout', async () => {
    const { meta } = await run('EMBEDTIMEOUT builder', { limit: 5, expansion: false });
    expect(meta.vector_enabled).toBe(false);
    expect(stages(meta)).toContain('embed_timeout');
    expect(meta.degraded!.find((d) => d.stage === 'embed_timeout')?.reason).toBe('timeout');
  });

  test('reasons are enumerated codes — raw exception text never rides the meta (D6)', async () => {
    const { meta } = await run('EMBEDFAIL builder', { limit: 5, expansion: false });
    const serialized = JSON.stringify(meta.degraded);
    expect(serialized).not.toContain('mock embed provider failure');
  });
});

describe('branch D — searchVector arm failure', () => {
  test('every vector arm throws → keyword fallback + vector_arm_failed', async () => {
    const origSearchVector = engine.searchVector.bind(engine);
    (engine as unknown as { searchVector: unknown }).searchVector =
      async () => { throw new Error('mock searchVector failure'); };
    try {
      const { results, meta } = await run('builder', { limit: 5 });
      expect(meta.vector_enabled).toBe(false);
      expect(stages(meta)).toContain('vector_arm_failed');
      expect(results.length).toBeGreaterThan(0);
    } finally {
      (engine as unknown as { searchVector: unknown }).searchVector = origSearchVector;
    }
  });
});

describe('ENG-7 kill switch — GBRAIN_SEARCH_SALVAGE=off', () => {
  test('one variant failure abandons ALL embeddings (all-or-nothing restored)', async () => {
    process.env.GBRAIN_SEARCH_SALVAGE = 'off';
    const { results, meta } = await run('builder', {
      limit: 5,
      expansion: true,
      expandFn: async () => ['builder', 'EMBEDFAIL variant query'],
    });
    // Pre-wave semantics: Promise.all rejects, keyword-only fallback.
    expect(meta.vector_enabled).toBe(false);
    expect(stages(meta)).toContain('embed_unavailable');
    expect(stages(meta)).not.toContain('expansion_partial');
    expect(results.length).toBeGreaterThan(0);
  });
});
