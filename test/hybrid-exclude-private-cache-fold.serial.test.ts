/**
 * #4352 follow-up — excludePrivate searches CACHE (posture folded into
 * knobsHash), they no longer skip the semantic query cache.
 *
 * #4352 originally shipped a wholesale `privateFiltered || ` skipCache term —
 * but excludePrivate=true is the DEFAULT for every remote MCP caller, so the
 * skip disabled the cache for exactly the highest-volume beneficiaries
 * (~50% cost savings lost). The v=23 fold (xp=) restores caching while
 * keeping the postures contamination-proof. Pins:
 *   1. a remote-default (excludePrivate=true) run reports 'miss' then 'hit'
 *      on repeat — never 'disabled' — and never surfaces a private page,
 *   2. a trusted (private-included) write is never served to a
 *      private-excluding read (distinct knobs_hash rows),
 *   3. a private-excluding write is never served to a trusted read.
 *
 * Serial: mock.module + gateway/global-env mutation (same harness shape as
 * test/hybrid-types-cache-skip.serial.test.ts).
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
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-private-cache-fold-'));
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

  const fixtures: Array<[string, string, Record<string, unknown>]> = [
    ['notes/world-widget', 'Widget World', { visibility: 'world' }],
    ['notes/private-widget', 'Widget Private', { visibility: 'private' }],
  ];
  for (const [slug, title, frontmatter] of fixtures) {
    const truth = `${title} is a builder.`;
    await engine.putPage(slug, { type: 'concept', title, frontmatter, compiled_truth: truth });
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

describe('#4352 follow-up — excludePrivate folds into the cache key instead of skipping', () => {
  test('a remote-default run gets miss then hit (never disabled) and never a private page', async () => {
    // 1. First excludePrivate run: cache MISS (not 'disabled' — the pre-fix
    //    wholesale skip is the regression this pins), filtered results.
    let firstMeta: HybridSearchMeta | undefined;
    const first = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      excludePrivate: true,
      onMeta: (m) => { firstMeta = m; },
    });
    expect(firstMeta?.cache?.status).toBe('miss');
    expect(first.map((r) => r.slug)).toEqual(['notes/world-widget']);
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(1);

    // 2. Repeat run under the SAME posture: HIT, still filtered.
    let repeatMeta: HybridSearchMeta | undefined;
    const repeat = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      excludePrivate: true,
      onMeta: (m) => { repeatMeta = m; },
    });
    expect(repeatMeta?.cache?.status).toBe('hit');
    expect(repeat.map((r) => r.slug)).toEqual(['notes/world-widget']);
  });

  test('a trusted (private-included) write is never served to an excludePrivate read', async () => {
    // 1. Trusted miss-run stores a row containing BOTH pages.
    let trustedMeta: HybridSearchMeta | undefined;
    const trusted = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      onMeta: (m) => { trustedMeta = m; },
    });
    expect(trustedMeta?.cache?.status).toBe('miss');
    expect(trusted.map((r) => r.slug).sort()).toEqual(['notes/private-widget', 'notes/world-widget']);
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(1);

    // 2. Same query, remote posture: identical embedding — pre-fold this
    //    would have HIT the trusted row and leaked the private page. Must
    //    MISS onto its own key instead (fresh, filtered query).
    let remoteMeta: HybridSearchMeta | undefined;
    const remote = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      excludePrivate: true,
      onMeta: (m) => { remoteMeta = m; },
    });
    expect(remoteMeta?.cache?.status).toBe('miss');
    expect(remote.map((r) => r.slug)).toEqual(['notes/world-widget']);

    // 3. The remote run stores its OWN row — two distinct knobs_hash rows.
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(2);
  });

  test('an excludePrivate write is never served to a trusted read (no hidden pages)', async () => {
    let remoteMeta: HybridSearchMeta | undefined;
    await hybridSearchCached(engine, 'builder', {
      limit: 10,
      excludePrivate: true,
      onMeta: (m) => { remoteMeta = m; },
    });
    expect(remoteMeta?.cache?.status).toBe('miss');
    await awaitPendingSearchCacheWrites();
    expect((await engine.executeRaw('SELECT id FROM query_cache')).length).toBe(1);

    // A trusted read of the same query must NOT be served the filtered row —
    // it is entitled to the private page.
    let trustedMeta: HybridSearchMeta | undefined;
    const trusted = await hybridSearchCached(engine, 'builder', {
      limit: 10,
      onMeta: (m) => { trustedMeta = m; },
    });
    expect(trustedMeta?.cache?.status).toBe('miss');
    expect(trusted.map((r) => r.slug).sort()).toEqual(['notes/private-widget', 'notes/world-widget']);
  });
});
