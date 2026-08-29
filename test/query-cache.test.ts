/**
 * v0.32.x search-lite \u2014 semantic query cache.
 *
 * PGLite-backed test. Confirms:
 *   - migration v51 creates the query_cache table
 *   - store + lookup roundtrip with EXACT same embedding \u2192 hit
 *   - lookup with a similar embedding (cosine > 0.92) \u2192 hit
 *   - lookup with a far embedding \u2192 miss
 *   - TTL expiration: a stale row is skipped at read time
 *   - clear / prune / stats work as advertised
 *   - source_id isolation: brain A's cache doesn't leak to brain B
 *   - disabled cache is a pure no-op
 *
 * Uses synthetic Float32Array embeddings so the test doesn't depend on
 * any external embedding provider.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SemanticQueryCache, cacheRowId, cacheTextGuard } from '../src/core/search/query-cache.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { SearchResult, HybridSearchMeta } from '../src/core/types.ts';

let engine: PGLiteEngine;

// Build a stable, normalized embedding. PGLite ships pgvector with 1536-dim
// support (the default); a smaller test dim won't match the column. We
// truncate / pad to 1536 to match the migration's resolved dim.
const DIM = 1536;

function makeEmbedding(seed: number, dim = DIM): Float32Array {
  const e = new Float32Array(dim);
  // Simple deterministic generator with a unique fingerprint per seed
  // so similar seeds produce similar (cosine > 0.95) vectors and distinct
  // seeds produce orthogonal-ish ones.
  for (let i = 0; i < dim; i++) {
    e[i] = Math.sin(seed * 0.001 + i * 0.01);
  }
  // L2-normalize so cosine = dot product.
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += e[i] * e[i];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < dim; i++) e[i] /= mag;
  return e;
}

function makeOrthogonalEmbedding(seed: number, dim = DIM): Float32Array {
  // Use a totally different basis so cosine is near-zero.
  const e = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    e[i] = Math.cos(seed * 13.7 + i * 0.97);
  }
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += e[i] * e[i];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < dim; i++) e[i] /= mag;
  return e;
}

function makeResult(slug: string): SearchResult {
  return {
    slug,
    page_id: 1,
    title: `Title for ${slug}`,
    type: 'concept',
    chunk_text: `chunk text for ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 1.0,
    stale: false,
  };
}

const META: HybridSearchMeta = {
  vector_enabled: true,
  detail_resolved: 'medium',
  expansion_applied: false,
  intent: 'general',
};

beforeAll(async () => {
  // v0.36.2.0: DEFAULT_EMBEDDING_DIMENSIONS flipped to 1280 (ZE Matryoshka).
  // This test hardcodes DIM=1536 in its embeddings. If another test file in
  // the same shard configured the gateway before us, initSchema() would size
  // query_cache.embedding at vector(1280) and every insert below would fail
  // with "expected 1280 dimensions, not 1536". Pin the gateway to 1536d
  // explicitly so this file is hermetic regardless of cross-file state.
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
});

beforeEach(async () => {
  // Wipe the cache between tests so ordering doesn't matter.
  await engine.executeRaw(`DELETE FROM query_cache`);
});

describe('migration v51 \u2014 query_cache table exists', () => {
  test('table is present and has expected columns', async () => {
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'query_cache'`,
    );
    const names = rows.map(r => r.column_name);
    expect(names).toContain('id');
    expect(names).toContain('query_text');
    expect(names).toContain('source_id');
    expect(names).toContain('embedding');
    expect(names).toContain('results');
    expect(names).toContain('meta');
    expect(names).toContain('ttl_seconds');
    expect(names).toContain('created_at');
    expect(names).toContain('hit_count');
  });
});

describe('cacheRowId', () => {
  test('is deterministic across same input', () => {
    expect(cacheRowId('hello', 'default')).toBe(cacheRowId('hello', 'default'));
  });
  test('differs across source_id', () => {
    expect(cacheRowId('hello', 'a')).not.toBe(cacheRowId('hello', 'b'));
  });
});

describe('SemanticQueryCache \u2014 store + lookup', () => {
  test('roundtrip: exact embedding match returns a hit', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(1);
    const results = [makeResult('a'), makeResult('b')];

    await cache.store('what is foo', emb, results, META);
    const hit = await cache.lookup(emb);

    expect(hit.hit).toBe(true);
    expect(hit.results).toHaveLength(2);
    expect(hit.results?.[0].slug).toBe('a');
    expect(hit.similarity).toBeGreaterThan(0.99);
  });

  test('similar embedding (cosine > 0.92) is a hit', async () => {
    const cache = new SemanticQueryCache(engine);
    const base = makeEmbedding(100);

    // Construct a near-neighbor: tweak a few dims so cosine stays > 0.92.
    const near = new Float32Array(base);
    for (let i = 0; i < 10; i++) near[i] += 0.005;
    // Re-normalize.
    let mag = 0;
    for (let i = 0; i < DIM; i++) mag += near[i] * near[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < DIM; i++) near[i] /= mag;

    await cache.store('what is foo', base, [makeResult('a')], META);
    const hit = await cache.lookup(near);

    expect(hit.hit).toBe(true);
    expect(hit.similarity).toBeGreaterThan(0.92);
  });

  test('orthogonal embedding is a miss', async () => {
    const cache = new SemanticQueryCache(engine);
    const a = makeEmbedding(1);
    const b = makeOrthogonalEmbedding(2);
    await cache.store('q1', a, [makeResult('a')], META);
    const hit = await cache.lookup(b);
    expect(hit.hit).toBe(false);
  });
});

describe('SemanticQueryCache \u2014 TTL', () => {
  test('stale row (past TTL) is not returned', async () => {
    const cache = new SemanticQueryCache(engine, { ttlSeconds: 1 });
    const emb = makeEmbedding(42);
    await cache.store('q', emb, [makeResult('a')], META, { ttlSeconds: 1 });

    // Manually rewind created_at to simulate expiration.
    await engine.executeRaw(
      `UPDATE query_cache SET created_at = now() - interval '10 seconds'`,
    );
    const hit = await cache.lookup(emb);
    expect(hit.hit).toBe(false);
  });
});

describe('SemanticQueryCache \u2014 source isolation', () => {
  test('different source_id cannot read each other\u2019s rows', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(7);
    await cache.store('q', emb, [makeResult('a')], META, { sourceId: 'src-A' });
    const hitB = await cache.lookup(emb, { sourceId: 'src-B' });
    expect(hitB.hit).toBe(false);
    const hitA = await cache.lookup(emb, { sourceId: 'src-A' });
    expect(hitA.hit).toBe(true);
  });
});

describe('SemanticQueryCache \u2014 management', () => {
  test('clear() wipes all rows', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(9);
    await cache.store('q1', emb, [makeResult('a')], META);
    await cache.store('q2', makeEmbedding(10), [makeResult('b')], META);
    const removed = await cache.clear();
    expect(removed).toBeGreaterThanOrEqual(2);
    const stats = await cache.stats();
    expect(stats.total_rows).toBe(0);
  });

  test('prune() deletes only stale rows', async () => {
    const cache = new SemanticQueryCache(engine);
    await cache.store('fresh', makeEmbedding(11), [makeResult('a')], META);
    await cache.store('stale', makeEmbedding(12), [makeResult('b')], META, { ttlSeconds: 1 });
    await engine.executeRaw(
      `UPDATE query_cache SET created_at = now() - interval '10 seconds' WHERE query_text = 'stale'`,
    );
    const removed = await cache.prune();
    expect(removed).toBe(1);
    const stats = await cache.stats();
    expect(stats.total_rows).toBe(1);
    expect(stats.fresh_rows).toBe(1);
  });

  test('stats() reports fresh / stale / total / hit counters', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(13);
    await cache.store('q', emb, [makeResult('a')], META);
    await cache.lookup(emb);  // bump hit
    // Hit bump is async/fire-and-forget; give it a moment to land.
    await new Promise(r => setTimeout(r, 50));
    const stats = await cache.stats();
    expect(stats.total_rows).toBe(1);
    expect(stats.fresh_rows).toBe(1);
    expect(stats.stale_rows).toBe(0);
    expect(stats.total_hits).toBeGreaterThanOrEqual(1);
  });
});

describe('cacheTextGuard (#1469)', () => {
  test('verbatim equality after NFKC / case / whitespace normalization', () => {
    expect(cacheTextGuard('what is foo', 'what is foo')).toBe(true);
    expect(cacheTextGuard('What  is\tFoo ', 'what is foo')).toBe(true);
    // NFKC folds full-width Latin to half-width.
    expect(cacheTextGuard('\uff57\uff48\uff41\uff54 \uff49\uff53 \uff46\uff4f\uff4f', 'what is foo')).toBe(true);
  });

  test('unrelated queries fail the guard', () => {
    expect(cacheTextGuard('quarterly revenue projections', 'kimchi fried rice recipe')).toBe(false);
  });

  test('near-paraphrase passes via char-bigram Dice >= 0.5', () => {
    expect(cacheTextGuard('what is the foo bar', 'what is foo bar')).toBe(true);
  });

  test('distinct Korean queries fail the guard (CJK-safe, no token boundary needed)', () => {
    expect(cacheTextGuard('\uae40\uce58 \ub9cc\ub4dc\ub294 \ubc29\ubc95', '\uc11c\uc6b8 \ub0a0\uc528 \uc608\ubcf4')).toBe(false);
  });

  test('near-identical Korean queries pass the guard', () => {
    // "how to make kimchi" vs the shorter "\ubc95" form \u2014 high bigram overlap.
    expect(cacheTextGuard('\uae40\uce58 \ub9cc\ub4dc\ub294 \ubc29\ubc95', '\uae40\uce58 \ub9cc\ub4dc\ub294 \ubc95')).toBe(true);
  });

  test('degenerate short strings: equality only, no spurious Dice pass', () => {
    expect(cacheTextGuard('a', 'a')).toBe(true);
    expect(cacheTextGuard('a', 'b')).toBe(false);
    expect(cacheTextGuard('', '')).toBe(true);
    expect(cacheTextGuard('', 'foo')).toBe(false);
  });
});

describe('SemanticQueryCache \u2014 text guard on lookup (#1469)', () => {
  test('degenerate embedding space: unrelated query text is a MISS even at cosine ~1.0', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(200);
    await cache.store('quarterly revenue projections', emb, [makeResult('finance')], META);
    // Same (collapsed) embedding, totally different query \u2014 must NOT be served.
    const hit = await cache.lookup(emb, { queryText: 'kimchi fried rice recipe' });
    expect(hit.hit).toBe(false);
  });

  test('verbatim query text is a hit through the guard', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(201);
    await cache.store('quarterly revenue projections', emb, [makeResult('finance')], META);
    const hit = await cache.lookup(emb, { queryText: 'Quarterly  Revenue Projections' });
    expect(hit.hit).toBe(true);
    expect(hit.results?.[0].slug).toBe('finance');
  });

  test('paraphrase (bigram Dice >= 0.5) is a hit', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(202);
    await cache.store('what is foo bar', emb, [makeResult('foobar')], META);
    const hit = await cache.lookup(emb, { queryText: 'what is the foo bar' });
    expect(hit.hit).toBe(true);
    expect(hit.results?.[0].slug).toBe('foobar');
  });

  test('legacy path: no queryText preserves pre-guard behavior', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(203);
    await cache.store('some cached query', emb, [makeResult('legacy')], META);
    const hit = await cache.lookup(emb);
    expect(hit.hit).toBe(true);
    expect(hit.results?.[0].slug).toBe('legacy');
  });

  test('Korean distinct queries do not collapse; guard scans past the closest candidate', async () => {
    const cache = new SemanticQueryCache(engine);
    const embA = makeEmbedding(300);
    // Near-neighbor for the second row: cosine > 0.92 vs embA but strictly
    // farther than embA itself, so the WRONG row sorts first.
    const embB = new Float32Array(embA);
    for (let i = 0; i < 10; i++) embB[i] += 0.005;
    let mag = 0;
    for (let i = 0; i < DIM; i++) mag += embB[i] * embB[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < DIM; i++) embB[i] /= mag;

    // "Seoul weather forecast" (closest to lookup emb) vs "how to make kimchi".
    await cache.store('\uc11c\uc6b8 \ub0a0\uc528 \uc608\ubcf4', embA, [makeResult('weather')], META);
    await cache.store('\uae40\uce58 \ub9cc\ub4dc\ub294 \ubc29\ubc95', embB, [makeResult('kimchi')], META);

    // Lookup with the kimchi TEXT but an embedding closest to the weather row:
    // the guard must skip the closer non-matching candidate and serve kimchi.
    const hit = await cache.lookup(embA, { queryText: '\uae40\uce58 \ub9cc\ub4dc\ub294 \ubc29\ubc95' });
    expect(hit.hit).toBe(true);
    expect(hit.results?.[0].slug).toBe('kimchi');

    // A third, unrelated Korean query matches NEITHER cached text \u2192 miss.
    const miss = await cache.lookup(embA, { queryText: '\uc8fc\uc2dd \uc2dc\uc7a5 \ubd84\uc11d' });
    expect(miss.hit).toBe(false);
  });
});

describe('SemanticQueryCache \u2014 disabled', () => {
  test('disabled cache is a pure no-op on lookup', async () => {
    const cache = new SemanticQueryCache(engine, { enabled: false });
    const emb = makeEmbedding(99);
    await cache.store('q', emb, [makeResult('a')], META);
    // Even after a store call, lookup must miss because enabled=false.
    const hit = await cache.lookup(emb);
    expect(hit.hit).toBe(false);
  });
});

/**
 * Wrap the real engine so every executeRaw SQL string is recorded (and
 * optionally intercepted) while all other methods delegate untouched.
 */
function spyExecuteRaw(
  onCall: (sql: string, params?: unknown[]) => Promise<void> | void,
): PGLiteEngine {
  return new Proxy(engine, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === 'executeRaw' && typeof v === 'function') {
        return async (sql: string, params?: unknown[], o?: { signal?: AbortSignal }) => {
          await onCall(sql, params);
          return v.call(target, sql, params, o);
        };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as unknown as PGLiteEngine;
}

describe('SemanticQueryCache \u2014 light candidates, winner-only payload fetch (D2)', () => {
  test('lookup ships ONE heavy payload: candidate select carries no results/meta; winner fetched by id', async () => {
    // Three near-identical embeddings so the candidate query returns
    // multiple rows within the 0.92 threshold \u2014 pre-D2, all of their
    // results/meta JSONB payloads shipped just to keep one.
    const cache = new SemanticQueryCache(engine);
    const winnerEmb = makeEmbedding(4200);
    await cache.store('who is alice-example', winnerEmb, [makeResult('people/alice-example')], META);
    await cache.store('who is alice example', makeEmbedding(4201), [makeResult('people/alice-two')], META);
    await cache.store('who was alice-example', makeEmbedding(4202), [makeResult('people/alice-three')], META);

    const calls: string[] = [];
    const spyCache = new SemanticQueryCache(spyExecuteRaw((sql) => void calls.push(sql)));
    const hit = await spyCache.lookup(winnerEmb, { queryText: 'who is alice-example' });

    expect(hit.hit).toBe(true);
    expect(hit.results?.[0]?.slug).toBe('people/alice-example');
    expect(hit.meta?.intent).toBe('general');

    const selects = calls.filter((q) => q.trimStart().toUpperCase().startsWith('SELECT'));
    expect(selects.length).toBe(2);
    // Candidate query is LIGHT: id/query_text/distance/age only.
    expect(selects[0]).toContain('qc.id, qc.query_text');
    expect(selects[0]).not.toContain('qc.results');
    expect(selects[0]).not.toContain('qc.meta');
    // Exactly one heavy fetch, keyed by the winner's id.
    expect(selects[1]).toContain('SELECT results, meta FROM query_cache WHERE id = $1');
  });

  test('winner row deleted between the two statements is a miss, not a throw', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(4300);
    await cache.store('race window query', emb, [makeResult('race/window')], META);

    // Simulate a concurrent prune/clear landing between the candidate
    // select and the payload fetch: delete the winner right before its
    // by-id payload query executes.
    const racing = new SemanticQueryCache(
      spyExecuteRaw(async (sql, params) => {
        if (sql.includes('SELECT results, meta FROM query_cache')) {
          await engine.executeRaw(`DELETE FROM query_cache WHERE id = $1`, [params![0]]);
        }
      }),
    );
    const res = await racing.lookup(emb, { queryText: 'race window query' });
    expect(res.hit).toBe(false);
  });
});
