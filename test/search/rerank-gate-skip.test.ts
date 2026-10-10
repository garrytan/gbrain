/**
 * W3 stage 2 — `search.reranker.gate: on` through hybridSearch: a
 * `would_skip` grade skips the cross-encoder; every other grade reranks
 * exactly as `off` does.
 *
 * Protects: a skip makes no provider call, keeps fused order through the
 * reranker's own topNOut slice, stamps `rerank_gate.skipped` with
 * `provider_called: false`, adds nothing to `degraded[]` and prints
 * "rerank skipped (gate: …)" on --explain; a not-strong grade and the
 * shadow-only strengths (exact lookup, alias) rerank with payloads and
 * results identical to `off`; an active System One rerank slot blocks the
 * skip.
 * Fails when: the skip calls the provider, reorders or over-returns rows,
 * lands in degraded[], or skips on a reason outside RERANK_GATE_SKIP_REASONS
 * or with the decide slot on.
 * Seams: test/helpers/rerank-gate-fixture.ts (deterministic embedder, stub
 * reverse-order reranker); PGLite always, Postgres when DATABASE_URL is set.
 * The relational rerank pin and autocut under a skip are pinned in
 * test/search/relational-rerank-pin-hybrid.serial.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { formatResultsExplain } from '../../src/core/search/explain-formatter.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { prepareRerankGate } from '../../src/core/search/hybrid/rerank-gate.ts';
import type { HybridRequest } from '../../src/core/search/hybrid/request.ts';
import { resolveSearchMode } from '../../src/core/search/mode.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { DIM, EXPECTED, QUERY_DIM, run, seed } from '../helpers/rerank-gate-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';

const STRONG = 'orbital period of the gold probe';
const rows = (rs: SearchResult[]) => JSON.stringify(rs.map((r) => ({ slug: r.slug, chunk_id: r.chunk_id, score: r.score, rerank_score: r.rerank_score ?? null })));

for (const backend of testBackends()) {
  describe(`${backend}: rerank gate on`, () => {
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
      const skips = EXPECTED[query].would_skip;
      test(`${query}: ${skips ? 'skips the reranker and keeps fused order' : 'reranks exactly as off'}`, async () => {
        const on = await run(engine, query, 'on');
        const off = await run(engine, query, 'off');
        expect(on.meta.rerank_gate).toMatchObject({ mode: 'on', eligible: true, ...EXPECTED[query] });
        expect((on.meta.degraded ?? []).filter((d) => d.stage.startsWith('rerank'))).toEqual([]);
        if (skips) {
          const fused = await run(engine, query, 'off', { rerankerEnabled: false });
          expect(on.payloads).toHaveLength(0);
          expect(on.meta.rerank_gate).toMatchObject({ skipped: true, provider_called: false });
          expect(rows(on.results)).toBe(rows(fused.results));
          expect(rows(on.results)).not.toBe(rows(off.results));
        } else {
          expect(on.meta.rerank_gate?.skipped).toBeUndefined();
          expect(on.meta.rerank_gate?.provider_called).toBe(true);
          expect(on.payloads).toEqual(off.payloads);
          expect(JSON.stringify(on.results)).toBe(JSON.stringify(off.results));
        }
      });
    }

    test('a skip applies the reranker topNOut slice', async () => {
      const fused = await run(engine, STRONG, 'off', { rerankerEnabled: false });
      const on = await run(engine, STRONG, 'on', { topNOut: 2 });
      const off = await run(engine, STRONG, 'off', { topNOut: 2 });
      expect(fused.results.length).toBeGreaterThan(2);
      expect(off.results).toHaveLength(2);
      expect(on.results).toHaveLength(2);
      expect(on.payloads).toHaveLength(0);
      expect(rows(on.results)).toBe(rows(fused.results.slice(0, 2)));
    });

    test('--explain names the skip and lists no degradation', async () => {
      const on = await run(engine, STRONG, 'on');
      const explain = formatResultsExplain(on.results, on.meta);
      expect(explain).toContain('rerank skipped (gate: high_vector_match)');
      expect(explain).not.toContain('degraded');
    });

    test('an active System One rerank slot blocks the skip', async () => {
      let deduped: SearchResult[] = [];
      await hybridSearch(engine, STRONG, {
        limit: 10, rerankGate: 'off', queryEmbedFn: () => basisEmbedding(QUERY_DIM[STRONG], DIM),
        reranker: { enabled: false, topNIn: 30, topNOut: null },
        onRerankPool: (_pool, d) => { deduped = d.map((r) => ({ ...r })); },
      });
      expect(deduped.length).toBeGreaterThan(1);
      const grade = (effective: 'off' | 'shadow' | 'on') => prepareRerankGate({
        engine, query: STRONG, opts: {}, aliasHopOpts: {},
        resolvedMode: resolveSearchMode({ mode: 'balanced', perCall: { reranker_gate: 'on' } }),
        decide: { policies: { rerank: { effective } } },
      } as unknown as HybridRequest, { deduped, rerankerOpts: { enabled: true, topNIn: 30 }, egressDenied: false, exactLookupOpts: {}, multimodal: false });
      expect((await grade('off')).meta).toMatchObject({ reason: 'high_vector_match', would_skip: true });
      for (const effective of ['shadow', 'on'] as const) {
        expect((await grade(effective)).meta).toMatchObject({ reason: 'high_vector_match', would_skip: false, skip_blocked: 'decide_rerank_slot' });
      }
    });
  });
}
