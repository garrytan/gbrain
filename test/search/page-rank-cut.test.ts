/**
 * W5 — `search.page_rank_cut: whole_pages` (the default, factor 1.5): with
 * `return_unit: "page"` and a caller budget, delivery stops adding page
 * candidates once their whole delivered pages fill `factor x budget`, and
 * ranking lifts the mode's chunk-token cut so it cannot stop earlier.
 *
 * Protects: explicit `off` leaves query/search/recall exactly on the old path
 * (no cut, the mode cut kept); on, small pages fill at least 95% of the budget
 * (even under conservative's 4000-token mode cut) and large pages are
 * delivered whole, a few of them, like the old 0.40 ratio; a page call
 * without a budget and a chunk-unit call never engage it;
 * `delivery.page_rank_cut` reports mode, factor, caller budget, target,
 * applied cost, candidates and kept.
 * Forced probe: the fixed-ratio path (a 0.40 x budget chunk-token cut, which
 * is what `search.page_rank_budget_ratio` folded into `search.tokenBudget`)
 * under-fills the small-page fixture.
 * Seams: query/search run keyword-only (embeddings off), so no model call;
 * recall's hybrid page arm runs on a fixture embed transport.
 * PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { cutWholePages, liftModeCut, PAGE_RANK_CUT_FACTOR_KEY, PAGE_RANK_CUT_KEY, resolvePageRankCut } from '../../src/core/search/page-rank-cut.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';
import { resolveSearchMode } from '../../src/core/search/mode.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const op = (name: string) => operations.find(o => o.name === name)!;
const SMALL = 'orchard apple picking';
const LARGE = 'garden tomato harvest';
const BUDGET = 8000;

describe('page rank cut: the mode cut is lifted only for a cut', () => {
  test('liftModeCut', () => {
    const conservative = resolveSearchMode({ mode: 'conservative' });
    expect(conservative.tokenBudget).toBe(4000);
    expect(liftModeCut(conservative, undefined)).toBe(conservative);
    expect(liftModeCut(conservative, { mode: 'whole_pages', factor: 1, caller_budget: BUDGET }).tokenBudget).toBeUndefined();
  });

  test('cutWholePages: whole pages up to the target; the crossing page only if its floor fits what is left', () => {
    const cut = { mode: 'whole_pages' as const, factor: 1, caller_budget: 1000 };
    const pages = (...ws: Array<[number, number]>) => ws.map(([w, f], i) => ({ i, w, f }));
    const run = (ps: Array<{ i: number; w: number; f: number }>, budget = 1000, c = cut) =>
      cutWholePages(ps, budget, c, p => p.w, p => p.f);
    expect(run(pages([400, 50], [400, 50], [400, 150], [100, 10])).kept.map(p => p.i)).toEqual([0, 1, 2]);
    expect(run(pages([400, 50], [400, 50], [400, 250], [100, 10])).kept.map(p => p.i)).toEqual([0, 1]);
    expect(run(pages([500, 50], [500, 50], [100, 10])).meta).toEqual({ ...cut, target: 1000, applied_cost: 1000, candidates: 3, kept: 2 });
    expect(run(pages([3000, 400], [100, 10])).kept.map(p => p.i)).toEqual([0]);
    expect(run(pages([400, 50], [400, 50], [400, 250]), 1000, { ...cut, factor: 1.5 }).meta).toMatchObject({ target: 1500, applied_cost: 1200, kept: 3 });
  });
});

for (const backend of testBackends()) {
  describe(`${backend}: whole-page cut through query, search and recall`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void> = async () => {};
    let meta: Record<string, any> | null = null;
    let embeddingDisabled = true;
    const ctx = () => ({ engine, config: { engine: backend, embedding_disabled: embeddingDisabled }, remote: false, sourceId: 'default', dryRun: false,
      logger: { info() {}, warn() {}, error() {} },
      emitResponseMeta: (k: string, v: unknown) => { if (k === 'retrieval') meta = v as Record<string, any>; } }) as unknown as OperationContext;
    const call = async (name: string, params: Record<string, unknown>) => {
      meta = null;
      const out = await op(name).handler(ctx(), { expand: false, ...params });
      return { out: out as any, meta: meta as Record<string, any> | null };
    };
    const page = (query: string, extra: Record<string, unknown> = {}) =>
      call('query', { query, return_unit: 'page', token_budget: BUDGET, limit: 50, mode: 'tokenmax', ...extra });
    const slugs = (rows: Array<{ slug: string }>) => rows.map(r => r.slug);
    const set = async (key: string, value: string | null) => {
      if (value === null) await engine.unsetConfig(key);
      else await engine.setConfig(key, value);
    };
    const cutMode = (value: string | null) => set(PAGE_RANK_CUT_KEY, value);

    beforeAll(async () => {
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
      // Small pages (BEAM-like): about 250 tokens, one chunk each.
      for (let i = 0; i < 48; i++) {
        await submitPageMutation(ctx(), { operation: 'put_page', params: { slug: `notes/orchard-${i}`,
          content: `---\ntype: note\ntitle: Orchard note ${i}\n---\nThe orchard apple picking note ${i}. ` + 'We walked the rows and filled crates with ripe fruit before noon. '.repeat(14) } });
      }
      // Large pages (sessions): about 3,000 tokens, many chunks each.
      for (let i = 0; i < 12; i++) {
        const paras = Array.from({ length: 12 }, (_, k) => `Day ${k} of session ${i}: the garden tomato harvest went on. ` + 'We picked, sorted and stored the vines while talking through the plan. '.repeat(16));
        await submitPageMutation(ctx(), { operation: 'put_page', params: { slug: `sessions/garden-${i}`,
          content: `---\ntype: note\ntitle: Garden session ${i}\n---\n` + paras.join('\n\n') } });
      }
    }, 300_000);

    afterAll(async () => {
      resetGateway();
      await disposePersistenceConsumer(engine);
      await close();
    });

    test('whole_pages at factor 1.5 is the default; only `off` turns it off', async () => {
      for (const v of [null, '', 'whole_pages', 'whole-page', 'true']) {
        await cutMode(v);
        expect(await resolvePageRankCut(engine, BUDGET)).toEqual({ mode: 'whole_pages', factor: 1.5, caller_budget: BUDGET });
      }
      for (const v of ['off', ' OFF ']) {
        await cutMode(v);
        expect(await resolvePageRankCut(engine, BUDGET)).toBeUndefined();
      }
      await cutMode(null);
      for (const bad of [null, '', 'big', '0', '-1', 'Infinity']) {
        await set(PAGE_RANK_CUT_FACTOR_KEY, bad);
        expect(await resolvePageRankCut(engine, BUDGET)).toEqual({ mode: 'whole_pages', factor: 1.5, caller_budget: BUDGET });
      }
      await set(PAGE_RANK_CUT_FACTOR_KEY, '1.25');
      expect(await resolvePageRankCut(engine, BUDGET)).toEqual({ mode: 'whole_pages', factor: 1.25, caller_budget: BUDGET });
      await set(PAGE_RANK_CUT_FACTOR_KEY, null);
    });

    test('explicit off is the old path: no cut, the mode cut kept, whatever the spelling', async () => {
      await cutMode('off');
      const base = await page(SMALL);
      expect(base.meta!.delivery.page_rank_cut).toBeUndefined();
      const conservative = await page(SMALL, { mode: 'conservative' });
      expect(conservative.meta!.token_budget.budget).toBe(4000);
      expect(conservative.meta!.delivery.page_rank_cut).toBeUndefined();
      for (const v of ['OFF', ' off ']) {
        await cutMode(v);
        const again = await page(SMALL);
        expect(slugs(again.out)).toEqual(slugs(base.out));
        expect(again.meta!.delivery).toEqual(base.meta!.delivery);
        expect(again.meta!.token_budget).toEqual(base.meta!.token_budget);
      }
      await cutMode(null);
      expect((await page(SMALL)).meta!.delivery.page_rank_cut).toMatchObject({ mode: 'whole_pages', factor: 1.5 });
    });

    test('small pages fill at least 95% of the budget; the fixed 0.40 ratio under-fills (forced probe)', async () => {
      await cutMode('off');
      // The old ratio folded min(mode cut, 0.40 x budget) into search.tokenBudget, a chunk-token cut.
      await set('search.tokenBudget', String(0.4 * BUDGET));
      const ratio = await page(SMALL);
      await set('search.tokenBudget', null);
      expect(ratio.meta!.delivery.budget_used).toBeLessThan(0.6 * BUDGET);

      await cutMode(null);
      await set(PAGE_RANK_CUT_FACTOR_KEY, '1');
      const on = await page(SMALL);
      await set(PAGE_RANK_CUT_FACTOR_KEY, null);
      const cut = on.meta!.delivery.page_rank_cut;
      expect(cut).toMatchObject({ mode: 'whole_pages', factor: 1, caller_budget: BUDGET, target: BUDGET });
      expect(on.meta!.delivery.budget_used).toBeGreaterThanOrEqual(0.95 * BUDGET);
      expect(on.meta!.delivery.budget_used).toBeLessThanOrEqual(BUDGET);
      expect(cut.kept).toBe(on.meta!.delivery.blocks);
      expect(cut.candidates).toBeGreaterThan(cut.kept);
      expect(cut.applied_cost).toBeGreaterThanOrEqual(0.95 * BUDGET);
      expect(on.out.every((r: any) => r.delivered.truncated === false)).toBe(true);
      // The default factor (1.5) hands delivery pages worth 12,000 tokens; delivery still fills and holds the 8,000 budget.
      const dflt = await page(SMALL);
      expect(dflt.meta!.delivery.page_rank_cut).toMatchObject({ factor: 1.5, target: 1.5 * BUDGET });
      expect(dflt.meta!.delivery.budget_used).toBeGreaterThanOrEqual(0.95 * BUDGET);
      expect(dflt.meta!.delivery.budget_used).toBeLessThanOrEqual(BUDGET);
    });

    test('the mode cut never under-fills: conservative (4000) still fills small pages', async () => {
      await cutMode('off');
      const off = await page(SMALL, { mode: 'conservative' });
      expect(off.meta!.token_budget.budget).toBe(4000);
      expect(off.meta!.delivery.budget_used).toBeLessThan(0.6 * BUDGET);
      await cutMode(null);
      const on = await page(SMALL, { mode: 'conservative' });
      expect(on.meta!.token_budget).toBeUndefined();
      expect(on.meta!.delivery.budget_used).toBeGreaterThanOrEqual(0.95 * BUDGET);
    });

    test('large pages: the same whole pages the 0.40 ratio delivered, without its slivers', async () => {
      await cutMode('off');
      await set('search.tokenBudget', String(0.4 * BUDGET));
      const ratio = await page(LARGE);
      await set('search.tokenBudget', null);
      await cutMode(null);
      await set(PAGE_RANK_CUT_FACTOR_KEY, '1');
      const on = await page(LARGE);
      await set(PAGE_RANK_CUT_FACTOR_KEY, null);
      const cut = on.meta!.delivery.page_rank_cut;
      expect(cut.kept).toBeLessThanOrEqual(4);
      const whole = (rows: any[]) => rows.filter((r) => r.delivered.truncated === false).map((r) => r.slug);
      expect(whole(on.out)).toEqual(whole(ratio.out));
      expect(cut.kept).toBeLessThanOrEqual(ratio.meta!.delivery.blocks);
      expect(on.out.slice(0, -1).every((r: any) => r.delivered.truncated === false)).toBe(true);
      expect(on.meta!.delivery.budget_used).toBeGreaterThanOrEqual(0.9 * BUDGET);
      expect(slugs(on.out)).toEqual(slugs(ratio.out).slice(0, on.out.length));
    });

    test('factor scales the target', async () => {
      await cutMode(null);
      await set(PAGE_RANK_CUT_FACTOR_KEY, '0.5');
      const half = await page(SMALL);
      await set(PAGE_RANK_CUT_FACTOR_KEY, null);
      const full = await page(SMALL);
      expect(half.meta!.delivery.page_rank_cut).toMatchObject({ factor: 0.5, target: BUDGET / 2 });
      expect(full.meta!.delivery.page_rank_cut).toMatchObject({ factor: 1.5, target: 1.5 * BUDGET });
      expect(half.meta!.delivery.page_rank_cut.kept).toBeLessThan(full.meta!.delivery.page_rank_cut.kept);
    });

    test('no caller budget, or the chunk unit, is unchanged', async () => {
      await cutMode('off');
      const pageOff = await call('query', { query: SMALL, return_unit: 'page', limit: 50, mode: 'conservative' });
      const chunkOff = await call('query', { query: SMALL, token_budget: 3000, limit: 50, mode: 'conservative' });
      await cutMode(null);
      const pageOn = await call('query', { query: SMALL, return_unit: 'page', limit: 50, mode: 'conservative' });
      const chunkOn = await call('query', { query: SMALL, token_budget: 3000, limit: 50, mode: 'conservative' });
      expect(pageOn.meta!.delivery.page_rank_cut).toBeUndefined();
      expect(slugs(pageOn.out)).toEqual(slugs(pageOff.out));
      expect(pageOn.meta!.token_budget).toEqual(pageOff.meta!.token_budget);
      expect(slugs(chunkOn.out)).toEqual(slugs(chunkOff.out));
      expect(chunkOn.meta!.token_budget).toEqual(chunkOff.meta!.token_budget);
      expect(chunkOn.meta!.delivery?.page_rank_cut).toBeUndefined();
    });

    test('search and recall page paths take the same cut', async () => {
      await cutMode(null);
      const s = await call('search', { query: SMALL, return_unit: 'page', token_budget: BUDGET, limit: 50, mode: 'tokenmax' });
      expect(s.meta!.delivery.page_rank_cut).toMatchObject({ mode: 'whole_pages', caller_budget: BUDGET });
      expect(s.meta!.delivery.budget_used).toBeGreaterThanOrEqual(0.95 * BUDGET);
      embeddingDisabled = false;
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { OPENAI_API_KEY: 'fixture-key' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) =>
        ({ embeddings: values.map(() => [1, ...Array(LEGACY_EMBEDDING_CONFIG.embedding_dimensions - 1).fill(0)]) })) as never);
      try {
        const r = await call('recall', { query: SMALL, return_unit: 'page', budget_tokens: 2000, limit: 50 });
        expect(r.out.search_degraded).toBeUndefined();
        expect(r.out.delivery.page_rank_cut).toMatchObject({ mode: 'whole_pages', caller_budget: 2000 });
        await cutMode('off');
        const rOff = await call('recall', { query: SMALL, return_unit: 'page', budget_tokens: 2000, limit: 50 });
        expect(rOff.out.delivery.page_rank_cut).toBeUndefined();
      } finally {
        await cutMode(null);
        embeddingDisabled = true;
        __setEmbedTransportForTests(null);
        resetGateway();
      }
    });
  });
}
