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
 * Seams: the deterministic `queryEmbedFn` and a stub `rerankerFn`; PGLite
 * always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, type RerankInput, type RerankResult } from '../../src/core/ai/gateway.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { basisEmbedding } from '../../src/eval/deterministic-embed.ts';
import type { HybridSearchMeta, SearchResult } from '../../src/core/types.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const DIM = 1536;

/** Unit vector with cosine `cos` to basis `dim` and 0 to every other fixture dim. */
function leaning(cos: number, dim: number, privateDim: number): Float32Array {
  const e = new Float32Array(DIM);
  e[dim] = cos;
  e[privateDim] = Math.sqrt(1 - cos * cos);
  return e;
}

const QUERY_DIM: Record<string, number> = {
  'orbital period of the gold probe': 12,
  'tidal locking near twins': 13,
  'Acme Widget': 14,
  'the hall': 15,
  'hall of light': 16,
  'notes/gold-probe': 12,
  'magnetar spin rate': 17,
};

const EXPECTED: Record<string, { grade: 'strong' | 'not_strong'; reason: string; would_skip: boolean; skip_blocked?: string }> = {
  'orbital period of the gold probe': { grade: 'strong', reason: 'high_vector_match', would_skip: true },
  'tidal locking near twins': { grade: 'not_strong', reason: 'gap_below_min', would_skip: false },
  'Acme Widget': { grade: 'strong', reason: 'exact_lookup', would_skip: false, skip_blocked: 'shadow_only_reason' },
  'the hall': { grade: 'not_strong', reason: 'identity_ambiguous', would_skip: false },
  'hall of light': { grade: 'strong', reason: 'alias_hit', would_skip: false, skip_blocked: 'shadow_only_reason' },
  'notes/gold-probe': { grade: 'strong', reason: 'exact_lookup', would_skip: false, skip_blocked: 'shadow_only_reason' },
  'magnetar spin rate': { grade: 'not_strong', reason: 'below_trust_floor', would_skip: false },
};

async function seed(engine: BrainEngine): Promise<void> {
  const page = async (slug: string, title: string, chunks: Array<[string, Float32Array]>) => {
    await engine.putPage(slug, { type: 'note', title, compiled_truth: chunks.map(([t]) => t).join('\n\n') });
    await installFixtureChunks(engine, slug, chunks.map(([text, embedding], i) => ({
      chunk_index: i, chunk_text: text, chunk_source: 'compiled_truth' as const, embedding, token_count: 12,
    })));
  };
  await page('notes/gold-probe', 'Gold Probe', [['the orbital period of the gold probe is ninety minutes', basisEmbedding(12, DIM)]]);
  await page('notes/decoy-one', 'Decoy One', [['an orbital period table for other probes', leaning(0.6, 12, 700)]]);
  await page('notes/decoy-two', 'Decoy Two', [['gold mining notes, unrelated probe', leaning(0.5, 12, 701)]]);
  await page('notes/twin-a', 'Twin A', [
    ['tidal locking near twins: the inner pair', leaning(0.95, 13, 702)],
    ['tidal locking near twins: the second half', leaning(0.94, 13, 703)],
  ]);
  await page('notes/twin-b', 'Twin B', [['tidal locking near twins: the outer pair', leaning(0.93, 13, 704)]]);
  await page('companies/acme-widget', 'Acme Widget', [
    ['acme widget makes small brass gears', leaning(0.3, 14, 705)],
    ['acme widget was founded in a garage', leaning(0.31, 14, 706)],
  ]);
  await page('notes/acme-widget-review', 'Acme Widget Review', [['a review of the acme widget gearbox', leaning(0.5, 14, 707)]]);
  await page('places/the-hall', 'The Great Hall', [['the hall seats four hundred', leaning(0.4, 15, 708)]]);
  await page('places/other-hall', 'Other Hall', [['the other hall is closed on mondays', leaning(0.3, 15, 709)]]);
  await page('projects/mingtang', 'Mingtang', [['the mingtang ritual building', leaning(0.2, 16, 710)]]);
  await page('notes/magnetar', 'Magnetar Notes', [['magnetar spin rate measurements', basisEmbedding(17, DIM)]]);
  await page('notes/magnetar-other', 'Pulsar Notes', [['pulsar spin rate measurements', leaning(0.3, 17, 711)]]);
  await engine.setPageAliases('places/the-hall', 'default', ['the hall']);
  await engine.setPageAliases('places/other-hall', 'default', ['the hall']);
  await engine.setPageAliases('projects/mingtang', 'default', ['hall of light']);
  await engine.executeRaw("UPDATE pages SET trust_tier = 'external_untrusted' WHERE source_id = 'default' AND slug = 'notes/magnetar'");
}

interface Run { results: SearchResult[]; meta: HybridSearchMeta; payloads: RerankInput[]; aliasReads: number; pageReads: number }

async function run(engine: BrainEngine, query: string, rerankGate: 'off' | 'shadow'): Promise<Run> {
  const payloads: RerankInput[] = [];
  let aliasReads = 0;
  let pageReads = 0;
  const counted = new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'resolveAliases') return (...args: unknown[]) => { aliasReads++; return (value as Function).apply(target, args); };
      if (prop === 'getPage') return (...args: unknown[]) => { pageReads++; return (value as Function).apply(target, args); };
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let meta: HybridSearchMeta | undefined;
  const results = await hybridSearch(counted, query, {
    limit: 10,
    autocut: false,
    rerankGate,
    queryEmbedFn: () => basisEmbedding(QUERY_DIM[query], DIM),
    onMeta: (m) => { meta = m; },
    reranker: {
      enabled: true, topNIn: 30, topNOut: null,
      // Reverse the fused order so a skipped or reordered input would show.
      rerankerFn: async (input: RerankInput): Promise<RerankResult[]> => {
        payloads.push(structuredClone({ query: input.query, documents: input.documents }) as RerankInput);
        return input.documents.map((_, i) => ({ index: input.documents.length - 1 - i, relevanceScore: 1 - i * 0.05 }));
      },
    },
  });
  return { results, meta: meta!, payloads, aliasReads, pageReads };
}

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
