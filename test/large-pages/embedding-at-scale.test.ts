/**
 * Wave C 1F: embedding at scale (spec §6.2; T-E13, T-E14, T-DX9).
 *
 * 1. Protects: a full embed of a segmented page reads each chunk row a bounded number of times (the listed-row
 *    recheck, not a page-wide rescan per batch); the backfill embeds a conversation page newest first (on Postgres
 *    through an embed-page job); a holder killed between the provider's response and the install, or during the
 *    call, never has a row sent twice (the stored vectors install, an uncertain batch waits for approval, its spend
 *    counts as uncertain); two pages competing for the source's last batch allowance never both proceed; a capped
 *    page embeds an append under the tail allowance and stops at it, and 0 or off turn it off; the status lines;
 *    on Postgres, `embed <slug> --background --max-usd N` carries the slug and the approval into the job, which
 *    hands the segmented page to an embed-page job with the approval.
 * 2. Fails when: the recheck rescans every vector-less row per batch, the order is oldest first, a crash replays a
 *    provider call or reports an uncertain page complete, the ledger lets both pages through, the tail allowance
 *    ignores its cap or its off switch, or the background payload drops the slug or the approval.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. A counting embedder stands in for the provider; no
 *    paid call is made.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { embedSegmentedPage, readSegmentedEmbedPage, type SegmentedEmbedPage } from '../../src/core/page-body/segmented-embedding.ts';
import { embedStaleForSource } from '../../src/core/embed-stale.ts';
import {
  PAGE_TAIL_USD_KEY, SOURCE_SPEND_CAP_KEY, SourceSpendCapped, embedProgressLine, embeddingBatchProbe, readEmbedProgress, readEmbedProgressView,
  readSourceEmbedProgress, sourceEmbedProgressLine, sourceSpend24h, withBatchReserved, withSourceSpendLedger,
} from '../../src/core/embedding-ledger.ts';
import { invokeAI, sdkInvocationUsage, type AIInvocation } from '../../src/core/ai/invocation-guard.ts';
import { _setRateLimitFloorsForTests } from '../../src/core/embed-retry.ts';
import { makeEmbedBackfillHandler } from '../../src/core/minions/handlers/embed-backfill.ts';
import { estimatePageEmbedUsd, PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { estimateCostFromChars } from '../../src/core/embedding-pricing.ts';
import { UNPRICED_RATE_PER_MTOK } from '../../src/core/held-embedding-action.ts';
import { PAGE_INLINE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { pageEmbeddingLeaseId } from '../../src/core/page-embedding-lease.ts';
import { makeEmbedPageHandler } from '../../src/core/minions/handlers/embed-page.ts';
import { makeEmbedHandler } from '../../src/core/minions/handlers/embed.ts';
import { runEmbed } from '../../src/commands/embed.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentPage, unitVector, type FixtureOccurrence } from '../helpers/segmented-chunks-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';

const ROW = (i: number) => `Row ${i}: herons wade in the marsh at dawn while the reeds bend, `.padEnd(300, 'and the tide turns slowly. ');
const ROW_USD = estimateCostFromChars(ROW(0).length, UNPRICED_RATE_PER_MTOK);
const rowOf = (text: string) => Number(/Row (\d+):/.exec(text)?.[1] ?? -1);
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const hang = () => new Promise<never>(() => {});
const EMBED_CALL: AIInvocation = { operation: 'gateway.embed', kind: 'embedding', model: 'openai:text-embedding-3-large', maxInputTokens: 100_000, maxOutputTokens: 0 };
/** An error shaped like a provider reset after the request was sent (the outcome is unknown). */
const reset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
const jobCtx = (id: number, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ id, data, attempts_made: 0, signal: new AbortController().signal, deadlineAtMs: null, updateProgress: async () => {}, ...extra }) as never;

for (const kind of testBackends()) {
  describe(`embedding at scale (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let sent: string[] = [];
    let occurrenceBase = 1000;
    const embedFn = async (texts: string[]) => {
      sent.push(...texts);
      const v = Float32Array.from(await unitVector(engine, 3));
      return texts.map(() => v);
    };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterAll(async () => { resetGateway(); await close?.(); });
    beforeEach(async () => {
      for (const table of ['pages', 'page_segment_texts', 'page_embedding_budget', 'embedding_spend', 'embedding_batches', 'minion_jobs']) {
        await engine.executeRaw(`DELETE FROM ${table}`);
      }
      await engine.executeRaw("DELETE FROM gbrain_cycle_locks WHERE id LIKE 'embed-page:%'");
      await engine.executeRaw('DELETE FROM config WHERE key = ANY($1::text[])', [[PAGE_EMBED_CAP_KEY, PAGE_TAIL_USD_KEY, SOURCE_SPEND_CAP_KEY]]);
      sent = [];
    });
    afterEach(() => { embeddingBatchProbe.beforeCall = undefined; embeddingBatchProbe.afterReturned = undefined; });

    /** A segmented page of `rows` rows in occurrences of five (the last `append` rows in a generation-2 occurrence). */
    async function seed(slug: string, rows: number, opts: { type?: string; large?: boolean; embedded?: number; append?: number } = {}) {
      const occurrences: FixtureOccurrence[] = [];
      const appendFrom = rows - (opts.append ?? 0);
      for (let start = 0; start < rows; start += 5) {
        const end = Math.min(start + 5, start < appendFrom ? appendFrom : rows);
        occurrences.push({ id: occurrenceBase++, byteStart: start * 300, genFrom: start < appendFrom ? 1 : 2,
          chunks: Array.from({ length: end - start }, (_, k) => ({ text: ROW(start + k), ...(start + k < (opts.embedded ?? 0) ? { vector: 1 } : {}) })) });
        if (end !== start + 5 && end < rows) start = end - 5;
      }
      const fixture = await segmentPage(engine, slug, { generation: opts.append ? 2 : 1, occurrences, type: opts.type ?? 'conversation',
        ...(opts.large ? { bodyBytes: PAGE_INLINE_MAX_BYTES + 1 } : {}) });
      return { ...fixture, page: (await readSegmentedEmbedPage(engine, { id: fixture.pageId }))!, occurrences };
    }
    const vectored = async (pageId: number) => Number((await engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM content_chunks WHERE page_id = $1 AND embedding IS NOT NULL', [pageId]))[0]!.n);
    const killHolder = (pageId: number) => engine.executeRaw(
      "UPDATE gbrain_cycle_locks SET ttl_expires_at = now() - interval '1 minute' WHERE id = $1", [pageEmbeddingLeaseId(pageId)]);
    async function until(check: () => Promise<boolean> | boolean) {
      for (let i = 0; i < 500 && !(await check()); i++) await settle();
      expect(await check()).toBe(true);
    }

    test('a full embed reads each chunk row a bounded number of times, not every vector-less row per batch', async () => {
      const { page } = await seed('chats/linear-read', 200, { type: 'note' });
      let read = 0;
      const counted = new Proxy(engine, {
        get(target, key) {
          if (key === 'executeRaw') {
            return async (sql: string, params?: unknown[]) => {
              const rows = await target.executeRaw(sql, params);
              if (/content_chunks/.test(sql)) read += rows.length;
              return rows;
            };
          }
          const value = (target as never)[key] as unknown;
          return typeof value === 'function' ? (value as Function).bind(target) : value;
        },
      }) as BrainEngine;
      const done = await embedSegmentedPage(counted, page, { embedFn, batchRows: 10 });
      expect(done).toMatchObject({ complete: true, embedded: 200 });
      expect(sent.length).toBe(200);
      // Each batch lists its rows and re-checks only those (spec §6.1): a few reads per row. A page-wide recheck per
      // batch reads 200 + 190 + ... + 10 = 2,100 rows in the recheck alone.
      expect(read).toBeLessThanOrEqual(4 * 200);
    });

    test('the backfill embeds a conversation page newest first, through an embed-page job when a worker runs', async () => {
      const { page } = await seed('chats/newest-first', 30);
      const swept = await embedStaleForSource(engine, 'default', { embedFn, batchSize: 100, delegateSegmented: true });
      if (kind === 'postgres') {
        expect(swept.delegatedPages).toBe(1);
        expect(sent).toEqual([]);
        const jobs = await engine.executeRaw<{ id: number; data: Record<string, unknown> }>("SELECT id, data FROM minion_jobs WHERE name = 'embed-page'");
        expect(jobs.map(job => job.data.pageId)).toEqual([page.id]);
        const result = await makeEmbedPageHandler(engine, { embedFn })({ id: Number(jobs[0]!.id), data: jobs[0]!.data, attempts_made: 0,
          signal: new AbortController().signal, deadlineAtMs: null, updateProgress: async () => {} } as never);
        expect(result).toMatchObject({ status: 'complete', embedded: 30 });
      } else {
        expect(swept.delegatedPages).toBeUndefined();
      }
      const order = sent.map(rowOf);
      expect(order).toEqual([...order].sort((a, b) => b - a));
      expect(order[0]).toBe(29);
      expect(await vectored(page.id)).toBe(30);
    });

    test('a holder killed between the provider response and the install: the next run installs the stored vectors, no row is sent twice', async () => {
      const { page } = await seed('chats/killed-after-response', 50);
      let returned = 0;
      embeddingBatchProbe.afterReturned = () => (++returned === 4 ? hang() : undefined);
      void embedSegmentedPage(engine, page, { embedFn, batchRows: 5 });
      await until(() => returned === 4);
      const atKill = (await readEmbedProgress(engine, page.id))!;
      expect(atKill.embedded_rows).toBe(15);
      expect((await engine.executeRaw<{ state: string }>('SELECT state FROM embedding_batches WHERE page_id = $1', [page.id])).map(r => r.state)).toEqual(['returned']);
      expect(await vectored(page.id)).toBe(15);
      embeddingBatchProbe.afterReturned = undefined;
      await killHolder(page.id);

      const resumed = await embedSegmentedPage(engine, page, { embedFn, batchRows: 5 });
      expect(resumed.complete).toBe(true);
      expect(await vectored(page.id)).toBe(50);
      expect(sent.length).toBe(50);
      expect(new Set(sent).size).toBe(50);
      expect(await engine.executeRaw('SELECT batch_id FROM embedding_batches WHERE page_id = $1', [page.id])).toEqual([]);
      const done = (await readEmbedProgress(engine, page.id))!;
      expect(done).toMatchObject({ state: 'complete', embedded_rows: 50, live_rows: 50 });
      expect(done.embedded_rows).toBeGreaterThanOrEqual(atKill.embedded_rows);
      const view = (await readEmbedProgressView(engine, page.id))!;
      expect(embedProgressLine(view)).toContain('50 of 50 chunks embedded');
      expect(embedProgressLine(view)).toContain('newest first');
      expect(embedProgressLine(view)).toContain('tail allowance $0.00 of $0.25 today');
    });

    test('a holder killed during its provider call: the batch turns uncertain and its rows wait for approval, never sent twice unasked', async () => {
      const { page } = await seed('chats/killed-in-call', 50);
      let calls = 0;
      const dying = async (texts: string[]) => (++calls === 4 ? (sent.push(...texts), hang()) : embedFn(texts));
      void embedSegmentedPage(engine, page, { embedFn: dying, batchRows: 5 });
      await until(() => calls === 4);
      expect(sent.length).toBe(20);
      expect((await engine.executeRaw<{ state: string }>('SELECT state FROM embedding_batches WHERE page_id = $1', [page.id])).map(r => r.state)).toEqual(['calling']);
      await killHolder(page.id);

      const resumed = await embedSegmentedPage(engine, page, { embedFn, batchRows: 5 });
      expect(resumed).toMatchObject({ complete: false, stopped: 'uncertain', embedded: 30 });
      expect(sent.length).toBe(50);
      expect(new Set(sent).size).toBe(50);
      expect(await vectored(page.id)).toBe(45);
      expect((await readEmbedProgress(engine, page.id))!.state).toBe('uncertain');
      const spend = await sourceSpend24h(engine, 'default');
      expect(spend.uncertain_usd).toBeGreaterThan(0);

      const again = await embedSegmentedPage(engine, page, { embedFn, batchRows: 5 });
      expect(again).toMatchObject({ complete: false, stopped: 'uncertain', embedded: 0 });
      expect(sent.length).toBe(50);

      const approved = await embedSegmentedPage(engine, page, { embedFn, batchRows: 5, approvedCapUsd: 1 });
      expect(approved).toMatchObject({ complete: true, embedded: 5 });
      expect(sent.length).toBe(55);
      expect(await vectored(page.id)).toBe(50);
    });

    test('two pages competing for the source\'s last batch allowance: one proceeds, the other stops source_capped', async () => {
      const a = await seed('chats/compete-a', 5);
      const b = await seed('chats/compete-b', 5);
      const batchUsd = estimatePageEmbedUsd(5 * ROW(0).length, undefined);
      await engine.setConfig(SOURCE_SPEND_CAP_KEY, '1');
      await engine.executeRaw("INSERT INTO embedding_spend (batch_id, source_id, page_id, kind, usd, state) VALUES ('job:seed', 'default', NULL, 'job', $1, 'settled')",
        [1 - 1.5 * batchUsd]);
      const results = await Promise.all([a.page, b.page].map(page => embedSegmentedPage(engine, page, { embedFn })));
      expect(results.map(r => r.complete ? 'complete' : r.stopped).sort()).toEqual(['complete', 'source_capped']);
      expect(sent.length).toBe(5);
      expect((await sourceSpend24h(engine, 'default')).total_usd).toBeLessThanOrEqual(1 + 1e-9);
      const line = sourceEmbedProgressLine('default', (await readSourceEmbedProgress(engine, 'default'))!);
      expect(line).toContain('of $1.00');
    });

    test('a call that fails after it was sent turns its batch uncertain at once: a retry inside the call is refused, nothing resends it unasked', async () => {
      const { page } = await seed('chats/sent-then-reset', 10);
      let provider = 0;
      // A retrying embedder (embedBatchWithBackoff's shape): the reset attempt, then a second attempt that would answer.
      const retrying = async (texts: string[]) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await invokeAI(EMBED_CALL, async () => {
              provider++;
              sent.push(...texts);
              if (attempt === 0) throw reset();
              return texts.map(() => Float32Array.from([1, 0, 0]));
            }, () => null, () => null);
          } catch (error) {
            if (attempt > 0 || (error as { code?: string }).code !== 'ECONNRESET') throw error;
          }
        }
      };
      await expect(embedSegmentedPage(engine, page, { embedFn: retrying, batchRows: 5 })).rejects.toThrow(/billed without an answer/);
      expect(provider).toBe(1);
      expect((await engine.executeRaw<{ state: string }>('SELECT state FROM embedding_batches WHERE page_id = $1', [page.id])).map(r => r.state)).toEqual(['uncertain']);
      expect((await sourceSpend24h(engine, 'default')).uncertain_usd).toBeGreaterThan(0);
      sent = [];
      const next = await embedSegmentedPage(engine, page, { embedFn, batchRows: 5 });
      expect(next).toMatchObject({ complete: false, stopped: 'uncertain', embedded: 5 });
      expect(sent.map(rowOf).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    });

    test('a call the provider refused unbilled releases its batch, and a rate-limited call is retried under the same batch', async () => {
      const { page } = await seed('chats/refused-unbilled', 5);
      const refusing = (texts: string[]) => invokeAI(EMBED_CALL, async () => { sent.push(...texts); throw Object.assign(new Error('bad request'), { status: 400 }); },
        () => null, () => ({ inputTokens: 0, outputTokens: 0 }));
      await expect(embedSegmentedPage(engine, page, { embedFn: refusing, batchRows: 5 })).rejects.toThrow('bad request');
      expect(await engine.executeRaw('SELECT batch_id FROM embedding_batches WHERE page_id = $1', [page.id])).toEqual([]);
      expect((await sourceSpend24h(engine, 'default')).total_usd).toBe(0);

      _setRateLimitFloorsForTests([1]);
      try {
        let calls = 0;
        const limited = (texts: string[]) => invokeAI(EMBED_CALL, async () => {
          if (++calls === 1) throw Object.assign(new Error('Rate limit reached, try again in 1ms'), { status: 429 });
          return embedFn(texts);
        }, () => null, () => null);
        sent = [];
        expect(await embedSegmentedPage(engine, page, { embedFn: limited, batchRows: 5 })).toMatchObject({ complete: true, embedded: 5 });
        expect(calls).toBe(2);
        expect(sent.length).toBe(5);
      } finally {
        _setRateLimitFloorsForTests(null);
      }
    });

    test('an approval raises the cap once per approval identity: a reclaimed embed-page job (attempts_made still 0) never raises it again', async () => {
      const { page } = await seed('chats/approval-once', 20, { large: true });
      await engine.executeRaw("INSERT INTO page_embedding_budget (page_id, state, reason, spent_usd, cap_usd) VALUES ($1, 'capped', 'cap_reached', 2, 2)", [page.id]);
      const job = jobCtx(4242, { pageId: page.id, approvedCapUsd: 3.5 * ROW_USD, approvalId: 'embed-job:77' });
      const first = await makeEmbedPageHandler(engine, { embedFn })(job);
      expect(first).toMatchObject({ status: 'capped', embedded: 3 });
      const reclaimed = await makeEmbedPageHandler(engine, { embedFn })(job);
      expect(reclaimed).toMatchObject({ status: 'capped', embedded: 0 });
      expect(sent.length).toBe(3);
      // A new approval (another embed job) raises it again.
      const fresh = await makeEmbedPageHandler(engine, { embedFn })(jobCtx(4243, { pageId: page.id, approvedCapUsd: 2.5 * ROW_USD, approvalId: 'embed-job:78' }));
      expect(fresh).toMatchObject({ embedded: 2 });
    });

    test('an inline backfill call reserves its maximum in the source ledger before it is sent: one row per attempt, refused past the cap', async () => {
      await engine.setConfig(SOURCE_SPEND_CAP_KEY, '1');
      let provider = 0;
      const answered = () => invokeAI(EMBED_CALL, async () => { provider++; return { usage: { tokens: 1000 } }; }, sdkInvocationUsage);
      await withSourceSpendLedger(engine, { sourceId: 'default', jobId: 9 }, async () => { await answered(); await answered(); });
      const rows = await engine.executeRaw<{ batch_id: string; usd: number; state: string }>("SELECT batch_id, usd, state FROM embedding_spend WHERE kind = 'job' ORDER BY at");
      expect(rows.length).toBe(2);
      expect(new Set(rows.map(r => r.batch_id)).size).toBe(2);
      expect(rows.every(r => r.state === 'settled' && r.batch_id.startsWith('job:9:'))).toBe(true);
      expect(Number(rows[0]!.usd)).toBeCloseTo(1000 * 0.13 / 1e6, 9);

      // A worker killed mid-call leaves its maximum reserved, counted in the 24-hour total.
      void withSourceSpendLedger(engine, { sourceId: 'default', jobId: 10 }, () => invokeAI(EMBED_CALL, hang, sdkInvocationUsage));
      await until(async () => (await sourceSpend24h(engine, 'default')).reserved_usd > 0);
      expect((await sourceSpend24h(engine, 'default')).reserved_usd).toBeCloseTo(0.026, 9);

      // A segmented batch's call is booked on its batch, never twice.
      await withSourceSpendLedger(engine, { sourceId: 'default', jobId: 11 }, () => withBatchReserved(answered));
      expect((await engine.executeRaw("SELECT 1 FROM embedding_spend WHERE batch_id LIKE 'job:11:%'")).length).toBe(0);

      // 0.026 reserved by the killed call, a little settled, 0.96 more: the next call's 0.026 maximum would pass $1.
      await engine.executeRaw("INSERT INTO embedding_spend (batch_id, source_id, page_id, kind, usd, state) VALUES ('job:seed', 'default', NULL, 'job', 0.96, 'settled')");
      const before = provider;
      let refused: SourceSpendCapped | null = null;
      await expect(withSourceSpendLedger(engine, { sourceId: 'default', jobId: 12, onRefused: r => { refused = r; } }, answered)).rejects.toBeInstanceOf(SourceSpendCapped);
      expect(provider).toBe(before);
      expect(refused).not.toBeNull();
      expect((await sourceSpend24h(engine, 'default')).total_usd).toBeLessThanOrEqual(1 + 1e-9);
    });

    test('the embed-backfill job runs its drain under the source ledger and stops source_spend_capped when the cap refuses a call', async () => {
      await engine.setConfig(SOURCE_SPEND_CAP_KEY, '1');
      const drain = async (_engine: BrainEngine, _source: string, opts: { signal?: AbortSignal }) => {
        try { await invokeAI(EMBED_CALL, async () => ({ usage: { tokens: 1000 } }), sdkInvocationUsage); } catch { /* the drain logs a failed key and moves on */ }
        return { embedded: 1, chunksProcessed: 1, pagesProcessed: 1, invalidated: 0, done: true, aborted: opts.signal?.aborted === true, remaining: 0 } as never;
      };
      const handler = makeEmbedBackfillHandler(engine, { runStale: drain as never });
      expect(await handler(jobCtx(501, { sourceId: 'default' }))).toMatchObject({ status: 'success' });
      expect((await engine.executeRaw("SELECT 1 FROM embedding_spend WHERE batch_id LIKE 'job:501:%' AND state = 'settled'")).length).toBe(1);
      await engine.executeRaw("INSERT INTO embedding_spend (batch_id, source_id, page_id, kind, usd, state) VALUES ('job:seed', 'default', NULL, 'job', 0.99, 'settled')");
      expect(await handler(jobCtx(502, { sourceId: 'default' }))).toMatchObject({ status: 'budget_exhausted', reason: 'source_spend_capped', budgetCapUsd: 1 });
    });

    test('a capped page embeds a new append under the tail allowance and stops at it; 0 and off turn the allowance off', async () => {
      const { page, occurrences } = await seed('chats/tail', 16, { large: true, embedded: 10, append: 6 });
      await engine.executeRaw("INSERT INTO page_embedding_budget (page_id, state, reason, spent_usd, cap_usd) VALUES ($1, 'capped', 'cap_reached', 2, 2)", [page.id]);
      const appended = occurrences.filter(o => o.genFrom === 2).map(o => o.id);
      const tail = (p: SegmentedEmbedPage) => embedSegmentedPage(engine, p, { embedFn, occurrenceIds: appended, tail: true });

      for (const off of ['0', 'off']) {
        await engine.setConfig(PAGE_TAIL_USD_KEY, off);
        expect((await tail(page)).embedded).toBe(0);
      }
      expect(sent).toEqual([]);

      await engine.setConfig(PAGE_TAIL_USD_KEY, String(2.5 * ROW_USD));
      const first = await tail(page);
      expect(first).toMatchObject({ embedded: 2, complete: false, stopped: 'budget' });
      expect(sent.map(rowOf)).toEqual([15, 14]);
      const [booked] = await engine.executeRaw<{ usd: number }>("SELECT sum(usd) AS usd FROM embedding_spend WHERE page_id = $1 AND kind = 'tail'", [page.id]);
      expect(Number(booked!.usd)).toBeLessThanOrEqual(2.5 * ROW_USD + 1e-12);
      expect((await tail(page)).embedded).toBe(0);
      expect(sent.length).toBe(2);
      const spend = await sourceSpend24h(engine, 'default');
      expect(spend.tail_usd).toBeCloseTo(2 * ROW_USD, 12);
      expect(sourceEmbedProgressLine('default', (await readSourceEmbedProgress(engine, 'default'))!)).toContain('tail allowance $0.00 spent today');
    });

    if (kind === 'postgres') {
      test('embed <slug> --background --max-usd N carries the slug and the approval; the job hands the page to embed-page with it and its spend authorization', async () => {
        const { page } = await seed('chats/background-approval', 10, { large: true });
        await engine.executeRaw("INSERT INTO page_embedding_budget (page_id, state, reason, spent_usd, cap_usd) VALUES ($1, 'capped', 'cap_reached', 2, 2)", [page.id]);
        configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
        await runEmbed(engine, ['chats/background-approval', '--background', '--max-usd', '0.5']);
        const [job] = await engine.executeRaw<{ id: number; data: Record<string, unknown> }>("SELECT id, data FROM minion_jobs WHERE name = 'embed'");
        expect(job!.data).toMatchObject({ slug: 'chats/background-approval', approvedPageCapUsd: 0.5 });
        const record = { version: 1, kind: 'authorized', group_id: crypto.randomUUID(), cap_usd: 0.5, cap_source: 'user', via: 'max_usd', command: 'embed',
          consented_effects: ['paid'], authorized_at: new Date().toISOString() };
        const spend = { spend: { record, budget_key: `group:${record.group_id}` } };
        const result = await makeEmbedHandler(engine)(jobCtx(Number(job!.id), job!.data, spend));
        expect((result as { embed_page_jobs?: number[] }).embed_page_jobs).toHaveLength(1);
        const slices = async () => engine.executeRaw<{ id: number; data: Record<string, unknown>; spend_authorization: { group_id?: string } | string | null }>(
          "SELECT id, data, spend_authorization FROM minion_jobs WHERE name = 'embed-page' ORDER BY id");
        const group = (row: { spend_authorization: { group_id?: string } | string | null }) =>
          (typeof row.spend_authorization === 'string' ? JSON.parse(row.spend_authorization) : row.spend_authorization)?.group_id ?? null;
        const [slice] = await slices();
        expect(slice!.data).toMatchObject({ pageId: page.id, approvedCapUsd: 0.5, approvalId: `embed-job:${job!.id}` });
        // The slice meters against the command's --max-usd group, not under no ceiling at all.
        expect(group(slice!)).toBe(record.group_id);
        // A re-run of the same job (a retry, or a reclaim that leaves attempts_made at 0) queues no second slice.
        for (const attempts_made of [0, 1]) {
          const again = await makeEmbedHandler(engine)(jobCtx(Number(job!.id), job!.data, { ...spend, attempts_made }));
          expect((again as { embed_page_jobs?: number[] }).embed_page_jobs).toEqual([Number(slice!.id)]);
        }
        expect((await slices()).length).toBe(1);
        // A slice that ends queues its continuation under the same group, with no approval.
        const sliced = await makeEmbedPageHandler(engine, { embedFn })(jobCtx(Number(slice!.id), slice!.data, { ...spend, deadlineAtMs: Date.now() - 1 }));
        expect(sliced).toMatchObject({ status: 'continued' });
        const [, continuation] = await slices();
        expect(continuation!.data.approvedCapUsd).toBeUndefined();
        expect(group(continuation!)).toBe(record.group_id);
        expect(sent).toEqual([]);
      });
    }
  });
}
