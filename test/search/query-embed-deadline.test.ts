/**
 * v0.42.20.0 (Fix 3, #1775) — query-embed deadline unit tests.
 *
 * The regression: `search`/`query` default to cheap-hybrid, which embeds the
 * query. A stalled embedding provider made the embed `await` never settle, so
 * the handler never reached the keyword fallback and the CLI force-exited at 10s
 * with no output. `embedQueryBounded` bounds the embed so it THROWS on timeout
 * → the caller's existing try/catch falls back to keyword.
 *
 * These tests prove the bound fires even when the transport IGNORES the
 * abortSignal (the Promise.race guarantee — codex #3: abortSignal alone is
 * insufficient against a wedged provider), and that a shared/elapsed deadline
 * makes a second embed fail FAST (worst case ~one timeout, not two).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { embedQueryBounded, makeQueryEmbedDeadline } from '../../src/core/search/hybrid.ts';

describe('embedQueryBounded — query-embed deadline', () => {
  beforeEach(() => {
    resetGateway();
    configureGateway({
      embedding_model: 'voyage:voyage-4-large',
      embedding_dimensions: 1024,
      env: { VOYAGE_API_KEY: 'voyage-fake' },
    });
  });
  afterEach(() => {
    __setEmbedTransportForTests(null);
    resetGateway();
  });

  test('rejects within the budget when the transport hangs (ignores abort)', async () => {
    // Transport never resolves AND ignores the abort signal — only the
    // Promise.race deadline can save us.
    __setEmbedTransportForTests(() => new Promise(() => { /* hang forever */ }));
    const dl = makeQueryEmbedDeadline(200);
    const start = Date.now();
    let threw = false;
    try {
      await embedQueryBounded('locker code', undefined, dl);
    } catch (e) {
      threw = true;
      expect(String((e as Error).message)).toContain('deadline');
    }
    const elapsed = Date.now() - start;
    expect(threw).toBe(true);
    // The 200ms deadline is floored to MIN_QUERY_EMBED_BUDGET_MS (2s) — the bound
    // still fires (not infinite hang), comfortably under the 10s CLI force-exit.
    expect(elapsed).toBeLessThan(3000);
  });

  test('an already-elapsed shared deadline is floored, not fresh-6s (codex floor)', async () => {
    __setEmbedTransportForTests(() => new Promise(() => { /* hang forever */ }));
    // Simulate the inner embed reusing a deadline the cache-lookup already spent.
    const dl = { signal: AbortSignal.timeout(1), deadlineAt: Date.now() - 5 };
    const start = Date.now();
    let threw = false;
    try {
      await embedQueryBounded('q', undefined, dl);
    } catch {
      threw = true;
    }
    const elapsed = Date.now() - start;
    expect(threw).toBe(true);
    // Floored to MIN_QUERY_EMBED_BUDGET_MS (2s) — NOT a fresh 6s (would blow the
    // cached-path total past the 10s force-exit) and NOT ~0 (would starve a
    // healthy inner embed). So: rejects after ~2s, comfortably under 6s.
    expect(elapsed).toBeGreaterThanOrEqual(1800);
    expect(elapsed).toBeLessThan(3500);
  });

  test('resolves with the embedding when the transport returns in time', async () => {
    const vec = Array.from({ length: 1024 }, () => 0.1);
    __setEmbedTransportForTests(async () => ({ embeddings: [vec], usage: { tokens: 1 } }) as any);
    const dl = makeQueryEmbedDeadline(2000);
    const out = await embedQueryBounded('q', undefined, dl);
    expect(out).toBeInstanceOf(Float32Array);
    expect(out.length).toBe(1024);
  });
});

/**
 * #2028 — a degraded hybrid search must NAME why the vector arm didn't run.
 * Pre-fix the embed catch was bare, so an embed timeout/error emitted only
 * `vector_enabled: false` — indistinguishable from "no provider configured",
 * which let a dead vector arm go unnoticed (empty results for CJK content).
 */
describe('hybridSearch meta.degraded_reason (#2028)', () => {
  let engine: import('../../src/core/pglite-engine.ts').PGLiteEngine;

  beforeEach(async () => {
    resetGateway();
    if (!engine) {
      const { PGLiteEngine } = await import('../../src/core/pglite-engine.ts');
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      await engine.putPage('notes/hello', {
        type: 'note' as any,
        title: 'hello',
        compiled_truth: 'hello world content',
        timeline: '',
        frontmatter: {},
      });
    }
  });
  afterEach(async () => {
    __setEmbedTransportForTests(null);
    resetGateway();
  });

  test('embed timeout → degraded_reason: embed_timeout', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-fake' },
    });
    __setEmbedTransportForTests(() => new Promise(() => { /* hang forever */ }));
    const { hybridSearch } = await import('../../src/core/search/hybrid.ts');
    let meta: import('../../src/core/types.ts').HybridSearchMeta | undefined;
    await hybridSearch(engine, 'hello world', {
      onMeta: (m) => { meta = m; },
      // Already-elapsed shared deadline → the floored ~2s bound fires fast.
      _queryEmbedDeadline: { signal: AbortSignal.timeout(1), deadlineAt: Date.now() - 5 },
    });
    expect(meta?.vector_enabled).toBe(false);
    expect(meta?.degraded_reason).toBe('embed_timeout');
  }, 15000);

  test('embed error → degraded_reason: embed_error', async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-small',
      embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-fake' },
    });
    __setEmbedTransportForTests(() => Promise.reject(new Error('provider 500')));
    const { hybridSearch } = await import('../../src/core/search/hybrid.ts');
    let meta: import('../../src/core/types.ts').HybridSearchMeta | undefined;
    await hybridSearch(engine, 'hello world', { onMeta: (m) => { meta = m; } });
    expect(meta?.vector_enabled).toBe(false);
    expect(meta?.degraded_reason).toBe('embed_error');
  }, 15000);

  test('no embedding provider → degraded_reason: no_embedding_provider', async () => {
    // resetGateway in beforeEach left the gateway unconfigured.
    const { hybridSearch } = await import('../../src/core/search/hybrid.ts');
    let meta: import('../../src/core/types.ts').HybridSearchMeta | undefined;
    await hybridSearch(engine, 'hello world', { onMeta: (m) => { meta = m; } });
    expect(meta?.vector_enabled).toBe(false);
    expect(meta?.degraded_reason).toBe('no_embedding_provider');
  }, 15000);
});
