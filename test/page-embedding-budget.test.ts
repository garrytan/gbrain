/**
 * Large pages (Wave A, T3/T16/T51): the per-page embedding spend cap. A page
 * above the inline threshold is metered as a whole: each run gets the newest
 * stale chunks that fit the page's remaining budget, spend accumulates in
 * page_embedding_budget, a held page waits for an explicit approval, and a
 * sampled junk hit holds the page before any provider call.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { PAGE_INLINE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { estimateCostFromChars } from '../src/core/embedding-pricing.ts';
import { holdPageEmbedding, meterPageBatch, planPageEmbedding, spendGrant, PAGE_EMBED_CAP_KEY } from '../src/core/page-embedding-budget.ts';

const UNPRICED_RATE = 0.13;
const CHUNK_CHARS = 35_000;
const chunkCost = estimateCostFromChars(CHUNK_CHARS, UNPRICED_RATE);
const chunks = Array.from({ length: 5 }, (_, i) => ({ chunk_index: i, chunk_text: `${i}`.padEnd(CHUNK_CHARS, ' alice-example met acme-example') }));

for (const kind of testBackends()) {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close: closePostgres } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { if (closePostgres) await closePostgres(); else await engine.disconnect(); });
  beforeEach(async () => { if (kind === 'pglite') await resetPgliteState(engine as PGLiteEngine); });

  async function page(slug: string, bytes: number) {
    const body = 'Notes from the acme-example weekly sync with alice-example. '.repeat(Math.ceil(bytes / 60)).slice(0, bytes);
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body });
    const stored = await engine.getPage(slug);
    return { id: stored!.id, slug, compiled_truth: body, timeline: '' };
  }

  async function ledger(pageId: number) {
    const [row] = await engine.executeRaw<{ state: string; reason: string | null; spent_usd: number; reserved_usd: number }>(
      'SELECT state, reason, spent_usd::float8 AS spent_usd, reserved_usd::float8 AS reserved_usd FROM page_embedding_budget WHERE page_id = $1', [pageId]);
    return row;
  }

  describe(`per-page embedding budget (${kind})`, () => {
    test('a page at or under the inline threshold is not metered', async () => {
      const small = await page('notes/small', 4096);
      expect(await planPageEmbedding(engine, small, chunks, { signature: null })).toEqual({ kind: 'unmetered' });
      expect(await ledger(small.id)).toBeUndefined();
    });

    test('a large page gets its newest chunks that fit the cap, and spend accumulates across runs', async () => {
      await engine.setConfig(PAGE_EMBED_CAP_KEY, String(chunkCost * 2.5));
      const large = await page('chats/large', PAGE_INLINE_MAX_BYTES + 4096);
      const first = await planPageEmbedding(engine, large, chunks, { signature: null });
      if (first.kind !== 'grant') throw new Error(`expected a grant, got ${first.kind}`);
      expect([...first.grant.chunkIndexes].sort()).toEqual([3, 4]);
      expect(first.grant.deferred).toBe(3);
      expect((await ledger(large.id)).state).toBe('capped');
      expect((await ledger(large.id)).reserved_usd).toBeCloseTo(chunkCost * 2, 9);
      await first.grant.settle({ ok: true });
      expect((await ledger(large.id)).spent_usd).toBeCloseTo(chunkCost * 2, 9);
      expect((await ledger(large.id)).reserved_usd).toBe(0);

      const second = await planPageEmbedding(engine, large, chunks.slice(0, 3), { signature: null });
      if (second.kind !== 'grant') throw new Error(`expected a grant, got ${second.kind}`);
      expect(second.grant.chunkIndexes.size).toBe(0);
      expect(second.grant.deferred).toBe(3);
    });

    test('a failed provider call releases its reservation instead of booking it', async () => {
      await engine.setConfig(PAGE_EMBED_CAP_KEY, String(chunkCost * 10));
      const large = await page('chats/flaky', PAGE_INLINE_MAX_BYTES + 4096);
      const decision = await planPageEmbedding(engine, large, chunks, { signature: null });
      if (decision.kind !== 'grant') throw new Error(`expected a grant, got ${decision.kind}`);
      await expect(spendGrant(decision.grant, async () => { throw new Error('provider down'); })).rejects.toThrow('provider down');
      expect(await ledger(large.id)).toMatchObject({ state: 'open', spent_usd: 0, reserved_usd: 0 });
    });

    test('a held page waits for approval; an approval lifts the hold and raises the cap', async () => {
      await engine.setConfig(PAGE_EMBED_CAP_KEY, '0');
      const large = await page('chats/held', PAGE_INLINE_MAX_BYTES + 4096);
      await holdPageEmbedding(engine, large.id, 'upgrade_backfill');
      expect(await planPageEmbedding(engine, large, chunks, { signature: null })).toEqual({ kind: 'held', reason: 'upgrade_backfill' });
      expect(await meterPageBatch(engine, large, chunks, { signature: null })).toBeNull();

      const approved = await planPageEmbedding(engine, large, chunks, { signature: null, approvedCapUsd: chunkCost * 5.5 });
      if (approved.kind !== 'grant') throw new Error(`expected a grant, got ${approved.kind}`);
      expect(approved.grant.chunkIndexes.size).toBe(5);
      expect(approved.grant.deferred).toBe(0);
      expect((await ledger(large.id)).state).toBe('open');
    });

    test('a sampled junk hit holds the page before any provider call', async () => {
      const markup = '<div class="x"><span style="a:b"></span></div>'.repeat(Math.ceil((PAGE_INLINE_MAX_BYTES + 4096) / 46));
      await engine.putPage('chats/junk', { type: 'note', title: 'junk', compiled_truth: markup });
      const stored = await engine.getPage('chats/junk');
      const decision = await planPageEmbedding(engine, { id: stored!.id, compiled_truth: markup }, chunks, { signature: null });
      expect(decision.kind).toBe('held');
      expect((await ledger(stored!.id)).state).toBe('held');
    });

    test('meterPageBatch narrows a large batch to its grant and settles an empty grant', async () => {
      await engine.setConfig(PAGE_EMBED_CAP_KEY, String(chunkCost * 1.5));
      const large = await page('chats/meter', PAGE_INLINE_MAX_BYTES + 4096);
      const metered = await meterPageBatch(engine, large, chunks, { signature: null });
      expect(metered?.chunks.map(c => c.chunk_index)).toEqual([4]);
      await spendGrant(metered!.grant, async () => 'ok');
      expect(await meterPageBatch(engine, large, chunks.slice(0, 4), { signature: null })).toBeNull();
      expect((await ledger(large.id)).reserved_usd).toBe(0);

      const small = await page('notes/meter-small', 4096);
      expect((await meterPageBatch(engine, small, chunks, { signature: null }))?.chunks).toHaveLength(5);
    });
  });
}
