/**
 * W3 — `search.reranker.gate: shadow` through hybridSearch: the gate grades
 * the deduped candidates before the cross-encoder and stamps
 * `meta.rerank_gate`, and nothing else changes.
 *
 * Protects: shadow results are byte-identical to off (rows, scores, order),
 * the reranker receives identical payloads, and the identity tiers are read
 * once (the gate's lookups are reused at the post-rerank position) — across
 * a strong vector match, a δ miss with several chunks of rank-1's page, a
 * full-title identity page with two chunks, an alias collision, a single
 * alias, a slug lookup and an external_untrusted rank-1.
 * Fails when: the gate's lookups mutate or reorder candidates (the alias hop
 * and exact-lookup tier mutate scores and inject rows), a lookup runs twice,
 * the grade reads the wrong rank-1 or page, or off starts stamping meta.
 * Seams: the deterministic `queryEmbedFn` and a stub `rerankerFn`
 * (test/helpers/rerank-gate-fixture.ts); PGLite always, Postgres when
 * DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, type RerankInput } from '../../src/core/ai/gateway.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { DIM, EXPECTED, run, seed } from '../helpers/rerank-gate-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';

for (const backend of testBackends()) {
  describe(`${backend}: rerank gate shadow`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void> = async () => {};

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIM, env: {} });
      if (backend === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      } else {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
      }
      await seed(engine);
    }, 120_000);

    afterAll(async () => {
      resetGateway();
      await close();
    });

    for (const query of Object.keys(EXPECTED)) {
      test(`${query}: shadow is identical to off and grades ${EXPECTED[query].reason}`, async () => {
        const off = await run(engine, query, 'off');
        const shadow = await run(engine, query, 'shadow');
        expect(off.results.length).toBeGreaterThan(1);
        expect(off.payloads).toHaveLength(1);
        expect(shadow.payloads).toEqual(off.payloads);
        expect(JSON.stringify(shadow.results)).toBe(JSON.stringify(off.results));
        expect(shadow.aliasReads).toBe(off.aliasReads);
        expect(shadow.pageReads).toBe(off.pageReads);
        expect(off.meta.rerank_gate).toBeUndefined();
        expect(shadow.meta.rerank_gate).toMatchObject({
          mode: 'shadow', eligible: true, provider_called: true, candidates: expect.any(Number), ...EXPECTED[query],
        });
        if (!EXPECTED[query].skip_blocked) expect(shadow.meta.rerank_gate?.skip_blocked).toBeUndefined();
      });
    }

    test('several chunks of the identity page collapse identically under both settings', async () => {
      const shadow = await run(engine, 'Acme Widget', 'shadow');
      expect(shadow.results[0].slug).toBe('companies/acme-widget');
      expect(shadow.results.filter((r) => r.slug === 'companies/acme-widget')).toHaveLength(1);
    });

    test('the strong vector grade reports rank-1 cosine and its gap over the best other page', async () => {
      const gate = (await run(engine, 'orbital period of the gold probe', 'shadow')).meta.rerank_gate!;
      expect(gate.top_cosine).toBeCloseTo(1, 5);
      expect(gate.gap).toBeCloseTo(0.4, 5);
      const twins = (await run(engine, 'tidal locking near twins', 'shadow')).meta.rerank_gate!;
      expect(twins.gap).toBeCloseTo(0.02, 5);
    });

    test('a disabled reranker is not eligible and is not graded', async () => {
      let meta: HybridSearchMeta | undefined;
      await hybridSearch(engine, 'orbital period of the gold probe', {
        limit: 10, rerankGate: 'shadow', queryEmbedFn: () => basisEmbedding(12, DIM), onMeta: (m) => { meta = m; },
        reranker: { enabled: false, topNIn: 30, topNOut: null },
      });
      expect(meta!.rerank_gate).toEqual({ mode: 'shadow', eligible: false, ineligible_reason: 'reranker_off', candidates: expect.any(Number), would_skip: false, provider_called: false });
    });

    test('the config key turns shadow on without a per-call override', async () => {
      await engine.setConfig('search.reranker.gate', 'shadow');
      try {
        let meta: HybridSearchMeta | undefined;
        await hybridSearch(engine, 'orbital period of the gold probe', {
          limit: 10, queryEmbedFn: () => basisEmbedding(12, DIM), onMeta: (m) => { meta = m; },
          reranker: { enabled: true, topNIn: 30, topNOut: null, rerankerFn: async (i: RerankInput) => i.documents.map((_, index) => ({ index, relevanceScore: 1 })) },
        });
        expect(meta!.rerank_gate?.reason).toBe('high_vector_match');
        meta = undefined;
        await hybridSearch(engine, 'orbital period of the gold probe', {
          limit: 10, rerankGate: 'off', queryEmbedFn: () => basisEmbedding(12, DIM), onMeta: (m) => { meta = m; },
          reranker: { enabled: true, topNIn: 30, topNOut: null, rerankerFn: async (i: RerankInput) => i.documents.map((_, index) => ({ index, relevanceScore: 1 })) },
        });
        expect(meta!.rerank_gate).toBeUndefined();
      } finally {
        await engine.unsetConfig?.('search.reranker.gate');
        await engine.setConfig('search.reranker.gate', 'off');
      }
    });
  });
}
