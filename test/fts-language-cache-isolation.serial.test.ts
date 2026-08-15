/**
 * GBRAIN_FTS_LANGUAGE must isolate query_cache rows.
 *
 * getFtsLanguage() reaches both sides of the lexical arms — the
 * `update_page_search_vector` / `update_chunk_search_vector` triggers that
 * build the tsvector, and the `websearch_to_tsquery(<lang>, …)` inside
 * searchKeyword / searchTitles / searchKeywordChunks on BOTH engines — but it
 * only applied at DB-query build time, i.e. on a cache MISS. So the
 * documented language-switch procedure
 * (`GBRAIN_FTS_LANGUAGE=… gbrain reindex-search-vector --yes`) left every
 * pre-switch cache row reachable: the freshly retokenized index was silently
 * bypassed for up to cache.ttl_seconds.
 *
 * This drives the real production path (`hybridSearchCached` over a PGLite
 * brain) rather than the hash in isolation: a run under `english` populates a
 * row from an english-stemmed index, then the same query under a different
 * configuration must NOT be served that row. The fixture makes the difference
 * observable — "builders" stems to "builder" under english and matches the
 * seeded pages; under `simple` it stays "builders" and matches nothing, so a
 * stale hit is a visibly wrong answer, not just a wrong key.
 *
 * Serial: mock.module + process.env mutation (isolation guards R1 + R2).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realEmbedding from '../src/core/embedding.ts';

/** Deterministic 1536d unit vector — identical for every call, so a cache
 * consult matches a prior write at cosine 1.0 whenever the knobs hash
 * agrees. That isolates the assertion to the key, not the similarity gate. */
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
const { resetFtsLanguageCache } = await import('../src/core/fts-language.ts');

type Meta = import('../src/core/types.ts').HybridSearchMeta;

let engine: InstanceType<typeof PGLiteEngine>;
let tmpHome: string;
const savedGbrainHome = process.env.GBRAIN_HOME;
const savedFtsLanguage = process.env.GBRAIN_FTS_LANGUAGE;

/** Pin the process FTS language (undefined = unset → the 'english' default).
 * getFtsLanguage() memoizes, so the cache is reset on every change. */
function setFtsLanguage(language: string | undefined): void {
  if (language === undefined) delete process.env.GBRAIN_FTS_LANGUAGE;
  else process.env.GBRAIN_FTS_LANGUAGE = language;
  resetFtsLanguageCache();
}

/** One cached search; returns the results plus the published cache status. */
async function search(query: string): Promise<{
  results: Awaited<ReturnType<typeof hybridSearchCached>>;
  status: NonNullable<Meta['cache']>['status'] | undefined;
}> {
  let meta: Meta | undefined;
  const results = await hybridSearchCached(engine, query, {
    limit: 10,
    onMeta: (m) => { meta = m; },
  });
  await awaitPendingSearchCacheWrites();
  return { results, status: meta?.cache?.status };
}

beforeAll(async () => {
  // Hermetic config home so a developer's real ~/.gbrain/config.json can't
  // leak an embedding_model that flips the consult to 'disabled' via
  // isCacheSafe (same rationale as hybrid-cached-hit-budget-meta).
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-fts-cache-key-'));
  process.env.GBRAIN_HOME = tmpHome;

  // The brain is built and indexed under the default language, exactly like
  // an install that has not run a language switch yet.
  setFtsLanguage(undefined);

  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Keyword-findable pages. putPage never chunks and searchKeyword joins
  // content_chunks, so the chunks are explicit. The chunk trigger stamps
  // search_vector with the language in force at initSchema time (english).
  const fixtures: Array<[string, string, string]> = [
    ['alice-foo', 'Alice Foo', 'person'],
    ['bob-bar', 'Bob Bar', 'company'],
    ['carol-baz', 'Carol Baz', 'note'],
  ];
  for (const [slug, title, type] of fixtures) {
    const truth = `${title} is a builder. ${'x'.repeat(400)}`;
    await engine.putPage(slug, { type, title, compiled_truth: truth });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
    ]);
  }
});

afterAll(async () => {
  if (savedGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedGbrainHome;
  if (savedFtsLanguage === undefined) delete process.env.GBRAIN_FTS_LANGUAGE;
  else process.env.GBRAIN_FTS_LANGUAGE = savedFtsLanguage;
  resetFtsLanguageCache();
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('query_cache isolation across an FTS language switch', () => {
  test('an english-tokenized row is not served to a differently configured process', async () => {
    // 1. Default (english) install: 'builders' stems to 'builder' and finds
    //    the seeded pages. The row lands in query_cache.
    setFtsLanguage(undefined);
    const englishRun = await search('builders');
    expect(englishRun.status).toBe('miss');
    expect(englishRun.results.length).toBeGreaterThan(0);

    // Same process, same language → the row is reachable (the cache still
    // works; this pins that the fix isolates rather than disables).
    const englishRepeat = await search('builders');
    expect(englishRepeat.status).toBe('hit');
    expect(englishRepeat.results.length).toBe(englishRun.results.length);

    // 2. Operator switches the language. Only the query side moves here (the
    //    seeded search_vector stays english-stemmed), which is what makes the
    //    divergence observable in-process: 'builders' no longer reaches
    //    'builder', so this process cannot reproduce the english answer from
    //    the index it is now querying. A real switch also retokenizes the
    //    write side via `reindex-search-vector`; either way the cached rows
    //    describe a corpus view the new configuration does not have.
    setFtsLanguage('simple');
    const switched = await search('builders');

    // Pre-fix this was a HIT serving englishRun.results (3 pages).
    expect(switched.status).toBe('miss');
    expect(switched.results.length).toBeLessThan(englishRun.results.length);

    // 3. Switching back reaches the original row, not a rebuilt one — the
    //    two languages occupy distinct rows rather than overwriting.
    setFtsLanguage(undefined);
    const back = await search('builders');
    expect(back.status).toBe('hit');
    expect(back.results.map((r) => r.slug)).toEqual(englishRun.results.map((r) => r.slug));
  });
});
