/**
 * Per-page spend ledgers (wave-b spec 8.3, PR 4 lane 4b): embeddings reserve on page_embedding_budget under
 * `embed.max_usd_per_page`; each paid derivation family (facts, synopsis) reserves on its own page_derivation_spend
 * row under `derive.max_usd_per_page`; meterPaidCall books what the provider reported.
 *
 * 1. Protects: each family has its own cap and the embedding cap counts embeddings only; a reservation over what a cap
 *    leaves refuses before the (fake) provider call and reserves nothing; a failed call releases its reservation; a new
 *    embedding model resets the embedding ledger only, never derivation spend or an in-flight derivation reservation;
 *    concurrent reservations never overspend a cap; a settle after its reservation was folded as stale books nothing;
 *    a metered call books the provider-reported cost of every attempt (a throw after the answer included), the
 *    reservation for an unpriced model, the worst case of every attempt the provider may have billed (a timeout, an
 *    abort, a reset, partial or wrapped usage, a 5xx, a proxy's 499 or 504, each entry of a retry wrapper) so a run of
 *    them stops at the cap, and nothing when the provider was never called or definitively refused the attempt (a 4xx
 *    on the attempt itself, no usage); a metered call turns the SDK's hidden retries off; concurrent metered calls under one
 *    --max-usd tracker count each other's in-flight attempts; the estimate honors
 *    pricing.overrides and covers every attempt of a facts extraction.
 * 2. Fails when: derivation spend starves embeddings, an embedding switch forgives or drops derivation spend, a refusal
 *    runs the call, a race overspends, a folded grant is booked twice, or booking ignores what the provider reported.
 * PGLite always; Postgres too when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PAGE_EMBED_CAP_KEY, estimateChatCallUsd, estimateFactsExtractionUsd, meterPaidCall, planPageEmbedding, reservePageSpend, spendGrant,
  type PageSpendSignature } from '../src/core/page-embedding-budget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../src/core/page-spend.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests, __setGenerateTextTransportForTests, chat, configureGateway, resetGateway, withBudgetTracker, type ChatResult } from '../src/core/ai/gateway.ts';
import { embedBatch } from '../src/core/embedding.ts';
import { reservationCostUsd } from '../src/core/budget/reservation-cost.ts';
import { BudgetExhausted, BudgetTracker, parsePricingOverrides } from '../src/core/budget/budget-tracker.ts';
import { estimateChatInputTokens } from '../src/core/ai/chat-input-estimate.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: Array<{ name: string; engine: BrainEngine }> = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({});
  await lite.initSchema();
  engines.push({ name: 'pglite', engine: lite });
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push({ name: 'postgres', engine: pg.engine });
    closePostgres = pg.close;
  }
  for (const { engine } of engines) { await engine.setConfig(PAGE_EMBED_CAP_KEY, '1'); await engine.setConfig(PAGE_DERIVATION_CAP_KEY, '1'); }
}, 120_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  for (const { name, engine } of engines) if (name === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

/** A stored page row standing in for a segmented page of `bytes` (the ledgers read only its id and shape). */
async function segmentedPage(engine: BrainEngine, bytes = 40 * 1024 * 1024) {
  const slug = `conversations/spend-${randomUUID().slice(0, 8)}`;
  await engine.putPage(slug, { type: 'conversation', title: 'Spend probe', compiled_truth: 'body' });
  const [row] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'", [slug]);
  return { id: Number(row!.id), body_storage: 'segmented' as const, body_bytes: bytes };
}

async function embedLedger(engine: BrainEngine, pageId: number) {
  const [row] = await engine.executeRaw<{ spent_usd: number; reserved_usd: number; embedding_signature: string | null }>(
    'SELECT spent_usd, reserved_usd, embedding_signature FROM page_embedding_budget WHERE page_id = $1', [pageId]);
  return row ? { spent: Number(row.spent_usd), reserved: Number(row.reserved_usd), signature: row.embedding_signature } : null;
}

async function familyLedger(engine: BrainEngine, pageId: number, family: string) {
  const [row] = await engine.executeRaw<{ spent_usd: number; reserved_usd: number }>(
    'SELECT spent_usd, reserved_usd FROM page_derivation_spend WHERE page_id = $1 AND family = $2', [pageId, family]);
  return row ? { spent: Number(row.spent_usd), reserved: Number(row.reserved_usd) } : null;
}

/** One fake paid call under a reservation: the call runs only on a grant, and books its reservation. */
async function paidStep(engine: BrainEngine, page: Awaited<ReturnType<typeof segmentedPage>>, signature: PageSpendSignature, usd: number,
  calls: { n: number }, fail = false) {
  const decision = await reservePageSpend(engine, page, signature, usd);
  if (decision.kind === 'refused') return decision;
  await spendGrant(decision.kind === 'grant' ? decision.grant : undefined, async () => {
    calls.n++;
    if (fail) throw new Error('provider failed');
  }).catch(error => { if (!fail) throw error; });
  return decision;
}

const HAIKU = 'anthropic:claude-haiku-4-5';
const answer = (input: number, output: number): ChatResult => ({ text: 'ok', blocks: [], stopReason: 'end', model: HAIKU, providerId: 'anthropic',
  usage: { input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_creation_tokens: 0 } });

describe('per-page spend ledgers', () => {
  test('each derivation family has its own cap and the embedding cap counts embeddings only; a refusal books nothing', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const calls = { n: 0 };
      expect((await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.6, calls)).kind, name).toBe('grant');
      const refused = await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.5, calls);
      expect(refused, name).toEqual({ kind: 'refused', reason: 'cap_reached', capUsd: 1, spentUsd: 0.6, reservedUsd: 0, estimateUsd: 0.5 });
      expect(calls.n, name).toBe(1);
      expect((await paidStep(engine, page, 'embedding:openai:text-embedding-3-large:1536', 1, calls)).kind, name).toBe('grant');
      expect((await paidStep(engine, page, 'synopsis:anthropic:claude-haiku-5-5', 0.9, calls)).kind, name).toBe('grant');
      expect(calls.n, name).toBe(3);
      expect({ facts: await familyLedger(engine, page.id, 'facts'),
        synopsis: await familyLedger(engine, page.id, 'synopsis'), embedding: await embedLedger(engine, page.id) }, name).toEqual({
        facts: { spent: 0.6, reserved: 0 }, synopsis: { spent: 0.9, reserved: 0 },
        embedding: { spent: 1, reserved: 0, signature: 'openai:text-embedding-3-large:1536' } });
    }
  });

  test('an open reservation counts against its family cap until it settles; a failed call releases it', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const first = await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.7);
      expect(first.kind, name).toBe('grant');
      expect((await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.4)).kind, name).toBe('refused');
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0, reserved: 0.7 });
      if (first.kind === 'grant') await first.grant.settle({ ok: false });
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0, reserved: 0 });
      const calls = { n: 0 };
      expect((await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.4, calls, true)).kind, name).toBe('grant');
      expect(calls.n, name).toBe(1);
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0, reserved: 0 });
    }
  });

  test('a new embedding model resets the embedding ledger only; derivation spend and an open derivation reservation stay', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const calls = { n: 0 };
      await paidStep(engine, page, 'embedding:openai:text-embedding-3-large:1536', 0.5, calls);
      await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.5, calls);
      const open = await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.25);
      expect((await paidStep(engine, page, 'embedding:voyage:voyage-4:1024', 0.3, calls)).kind, name).toBe('grant');
      expect({ embedding: await embedLedger(engine, page.id), facts: await familyLedger(engine, page.id, 'facts') }, name)
        .toEqual({ embedding: { spent: 0.3, reserved: 0, signature: 'voyage:voyage-4:1024' }, facts: { spent: 0.5, reserved: 0.25 } });
      // A facts model change keeps the family's spend: 0.5 spent + 0.25 open + 0.3 is over the cap.
      expect((await paidStep(engine, page, 'facts:openai:gpt-6-luna', 0.3, calls)).kind, name).toBe('refused');
      if (open.kind === 'grant') await open.grant.settle({ ok: true });
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0.75, reserved: 0 });
      expect(calls.n, name).toBe(3);
    }
  });

  test('a small inline page is unmetered and leaves no ledger row', async () => {
    for (const { name, engine } of engines) {
      const page = { id: (await segmentedPage(engine)).id, body_storage: 'inline' as const, compiled_truth: 'short', timeline: '' };
      expect(await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 50), name).toEqual({ kind: 'unmetered' });
      expect({ embedding: await embedLedger(engine, page.id), facts: await familyLedger(engine, page.id, 'facts') }, name).toEqual({ embedding: null, facts: null });
    }
  });

  test('the embedding planner is not limited by derivation spend', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const calls = { n: 0 };
      await paidStep(engine, page, 'facts:anthropic:claude-haiku-5-5', 1, calls);
      const stale = [{ chunk_index: 0, chunk_text: 'alpha '.repeat(200) }, { chunk_index: 1, chunk_text: 'beta '.repeat(200) }];
      const decision = await planPageEmbedding(engine, page, stale, { signature: 'openai:text-embedding-3-large:1536', approvedCapUsd: 0 });
      expect(decision.kind, name).toBe('grant');
      if (decision.kind !== 'grant') continue;
      expect({ granted: decision.grant.chunkIndexes.size, deferred: decision.grant.deferred }, name).toEqual({ granted: 2, deferred: 0 });
      await decision.grant.settle({ ok: true });
    }
  });

  test('concurrent reservations on one family never overspend its cap', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const decisions = await Promise.all(Array.from({ length: 10 }, () => reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.3)));
      const grants = decisions.filter(d => d.kind === 'grant');
      expect({ grants: grants.length, refused: decisions.filter(d => d.kind === 'refused').length }, name).toEqual({ grants: 3, refused: 7 });
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0, reserved: expect.closeTo(0.9, 9) });
      await Promise.all(grants.map(d => d.kind === 'grant' ? d.grant.settle({ ok: true }) : null));
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: expect.closeTo(0.9, 9), reserved: 0 });
    }
  });

  test('a settle after its reservation was folded into spent as stale changes nothing; the newer reservation is untouched', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      // The ledger is aged by rewriting its times; the 2 ms let the clock (1 ms resolution on PGLite) pass A's reservation time as an hour would.
      const age = async () => { await new Promise(resolve => setTimeout(resolve, 2)); await engine.executeRaw("UPDATE page_derivation_spend SET reserved_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' WHERE page_id = $1", [page.id]); };
      const a = await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.25);
      await age();
      const b = await reservePageSpend(engine, page, 'facts:anthropic:claude-haiku-5-5', 0.125);
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0.25, reserved: 0.125 });
      if (a.kind !== 'grant' || b.kind !== 'grant') throw new Error(name + ': expected two grants');
      await a.grant.settle({ ok: true });
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0.25, reserved: 0.125 });
      await a.grant.settle({ ok: false });
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0.25, reserved: 0.125 });
      await b.grant.settle({ ok: true });
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0.375, reserved: 0 });
    }
  });

  test('an embedding grant folded by a later embedding reservation is not booked twice', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const stale = [{ chunk_index: 0, chunk_text: 'alpha '.repeat(2000) }];
      const a = await planPageEmbedding(engine, page, stale, { signature: 'openai:text-embedding-3-large:1536', approvedCapUsd: 1 });
      if (a.kind !== 'grant' || a.grant.reservedUsd <= 0) throw new Error(name + ': expected an embedding grant with a reservation');
      await new Promise(resolve => setTimeout(resolve, 2));
      await engine.executeRaw("UPDATE page_embedding_budget SET reserved_at = now() - interval '2 hours', updated_at = now() - interval '2 hours' WHERE page_id = $1", [page.id]);
      const b = await reservePageSpend(engine, page, 'embedding:openai:text-embedding-3-large:1536', 0.125);
      if (b.kind !== 'grant') throw new Error(name + ': expected an embedding grant');
      const folded = await embedLedger(engine, page.id);
      await a.grant.settle({ ok: true });
      expect(await embedLedger(engine, page.id), name).toEqual(folded);
      expect(folded, name).toEqual({ spent: a.grant.reservedUsd, reserved: 0.125, signature: 'openai:text-embedding-3-large:1536' });
    }
  });

  test('a new embedding model replaces the ledger: the old model\'s open grant settles into nothing', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const a = await reservePageSpend(engine, page, 'embedding:openai:text-embedding-3-large:1536', 0.25);
      const b = await reservePageSpend(engine, page, 'embedding:voyage:voyage-4:1024', 0.125);
      if (a.kind !== 'grant' || b.kind !== 'grant') throw new Error(name + ': expected two grants');
      await a.grant.settle({ ok: true });
      expect(await embedLedger(engine, page.id), name).toEqual({ spent: 0, reserved: 0.125, signature: 'voyage:voyage-4:1024' });
      await b.grant.settle({ ok: true });
      expect(await embedLedger(engine, page.id), name).toEqual({ spent: 0.125, reserved: 0, signature: 'voyage:voyage-4:1024' });
    }
  });

  test('meterPaidCall books what the provider reported for every attempt, a throw after the answer included', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const answers = [answer(1000, 200), answer(3000, 400)];
      __setChatTransportForTests(async () => answers.shift()!);
      const ask = () => chat({ model: HAIKU, messages: [{ role: 'user', content: 'window' }], maxTokens: 500 });
      const out = await meterPaidCall(engine, page, `facts:${HAIKU}`, 0.2, async () => { await ask(); await ask(); return 'done'; });
      const cost = reservationCostUsd(HAIKU, 'chat', 1000, 200)! + reservationCostUsd(HAIKU, 'chat', 3000, 400)!;
      expect({ out, ledger: await familyLedger(engine, page.id, 'facts') }, name).toEqual({ out: { value: 'done' }, ledger: { spent: expect.closeTo(cost, 12), reserved: 0 } });
      __setChatTransportForTests(async () => answer(2000, 100));
      await expect(meterPaidCall(engine, page, `facts:${HAIKU}`, 0.2, async () => { await ask(); throw new Error('parse failed after the answer'); }), name).rejects.toThrow('parse failed');
      const after = cost + reservationCostUsd(HAIKU, 'chat', 2000, 100)!;
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: expect.closeTo(after, 12), reserved: 0 });
      await expect(meterPaidCall(engine, page, `facts:${HAIKU}`, 0.2, async () => { throw new Error('failed before any call'); }), name).rejects.toThrow('before any call');
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: expect.closeTo(after, 12), reserved: 0 });
      __setChatTransportForTests(async () => ({ ...answer(10, 10), model: 'test:unpriced-model' }));
      await meterPaidCall(engine, page, 'synopsis:test:unpriced-model', 0.05, () => chat({ model: 'test:unpriced-model', messages: [{ role: 'user', content: 'w' }], maxTokens: 50 }));
      expect(await familyLedger(engine, page.id, 'synopsis'), name).toEqual({ spent: 0.05, reserved: 0 });
      __setChatTransportForTests(null);
    }
  });

  test('meterPaidCall books nothing for an attempt the provider rejected before answering (a rate limit), and the answered attempts beside it', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const ask = () => chat({ model: HAIKU, messages: [{ role: 'user', content: 'window' }], maxTokens: 500 });
      let rejected = 0;
      __setChatTransportForTests(async () => {
        if (rejected++ === 0) throw Object.assign(new Error('fixture rate limit'), { status: 429 });
        return answer(1000, 200);
      });
      const out = await meterPaidCall(engine, page, `synopsis:${HAIKU}`, 0.2, async () => { await ask().catch(() => null); await ask(); return 'done'; });
      expect({ out, ledger: await familyLedger(engine, page.id, 'synopsis') }, name)
        .toEqual({ out: { value: 'done' }, ledger: { spent: expect.closeTo(reservationCostUsd(HAIKU, 'chat', 1000, 200)!, 12), reserved: 0 } });
      __setChatTransportForTests(async () => { throw Object.assign(new Error('fixture rate limit'), { status: 429 }); });
      await meterPaidCall(engine, page, `facts:${HAIKU}`, 0.2, () => ask().catch(() => null));
      expect(await familyLedger(engine, page.id, 'facts'), name).toEqual({ spent: 0, reserved: 0 });
      __setChatTransportForTests(null);
    }
  });

  test('meterPaidCall books every attempt the provider may have billed (a timeout, an abort, a reset, partial or wrapped usage, a 5xx, a 499 or 504, each entry of a retry wrapper) and nothing for one it definitively refused (a 4xx on the attempt itself, no usage)', async () => {
    const status = (code: number, message = `http ${code}`) => Object.assign(new Error(message), { status: code });
    const reset = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const retry = (...errors: Error[]) => Object.assign(new Error(`Failed after ${errors.length} attempts.`), { name: 'AI_RetryError', reason: 'maxRetriesExceeded', errors, lastError: errors.at(-1) });
    const failures: Array<[string, Error]> = [
      ['timeout', Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' })],
      ['abort', Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })],
      ['reset', reset()],
      ['partial', Object.assign(new Error('stream interrupted'), { usage: { input_tokens: 1000 } })],
      ['wrapped usage', Object.assign(status(400), { cause: { usage: { input_tokens: 1000, output_tokens: 300 } } })],
      ['status only on a cause', Object.assign(new Error('wrapped'), { cause: status(401) })],
      ['500', status(500)], ['504', status(504)], ['529', status(529)], ['499', status(499)], ['408', status(408)],
      ['401', status(401)], ['429', status(429)], ['400', status(400)],
      ['retry reset, reset, 500', retry(reset(), reset(), status(500))],
      ['retry 408, 408, 529', retry(status(408), status(408), status(529))],
      ['retry 429, 429, 500', retry(status(429), status(429), status(500))],
      ['retry 429, 429, 429', retry(status(429), status(429), status(429))],
    ];
    const worst = reservationCostUsd(HAIKU, 'chat', estimateChatInputTokens({ messages: [{ content: 'window' }] }), 500)!;
    const expected: Record<string, number> = {
      timeout: worst, abort: worst, reset: worst, partial: reservationCostUsd(HAIKU, 'chat', 1000, 500)!,
      'wrapped usage': reservationCostUsd(HAIKU, 'chat', 1000, 300)!, 'status only on a cause': worst,
      500: worst, 504: worst, 529: worst, 499: worst, 408: worst, 401: 0, 429: 0, 400: 0,
      'retry reset, reset, 500': 3 * worst, 'retry 408, 408, 529': 3 * worst, 'retry 429, 429, 500': worst, 'retry 429, 429, 429': 0,
    };
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const ask = () => chat({ model: HAIKU, messages: [{ role: 'user', content: 'window' }], maxTokens: 500 });
      const booked: Record<string, number> = {};
      const recorded: Record<string, boolean> = {};
      for (const [kind, error] of failures) {
        const before = (await familyLedger(engine, page.id, 'facts'))?.spent ?? 0;
        const parent = new BudgetTracker({ label: 'probe', auditPath: '/dev/null' });
        __setChatTransportForTests(async () => { throw error; });
        const out = await withBudgetTracker(parent, () => meterPaidCall(engine, page, `facts:${HAIKU}`, 0.2, () => ask().catch(() => 'failed')));
        expect(out, name).toEqual({ value: 'failed' });
        booked[kind] = (await familyLedger(engine, page.id, 'facts'))!.spent - before;
        recorded[kind] = parent.totalSpent > 0;
      }
      __setChatTransportForTests(null);
      expect(Object.fromEntries(Object.entries(booked).map(([k, v]) => [k, Number(v.toFixed(12))])), name)
        .toEqual(Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, Number(v.toFixed(12))])));
      // The caller's tracker still counts every failure at its pessimistic estimate (its caps are unchanged).
      expect(Object.values(recorded).every(Boolean), name).toBe(true);
      expect((await familyLedger(engine, page.id, 'facts'))!.reserved, name).toBe(0);
    }
  });

  test('a metered call runs with the provider SDK\'s hidden retries off; an unmetered call keeps the SDK default', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      configureGateway({ env: { OPENAI_API_KEY: 'sk-fake' } });
      const seen: unknown[] = [];
      __setGenerateTextTransportForTests((async (args: { maxRetries?: number }) => {
        seen.push('maxRetries' in args ? args.maxRetries : 'default');
        return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 1 } };
      }) as never);
      try {
        const ask = () => chat({ model: 'openai:gpt-4o', messages: [{ role: 'user', content: 'window' }], maxTokens: 50 });
        await meterPaidCall(engine, page, 'facts:openai:gpt-4o', 0.2, ask);
        await ask();
      } finally {
        __setGenerateTextTransportForTests(null);
        resetGateway();
      }
      expect(seen, name).toEqual([0, 'default']);
    }
  });

  test('an embed inside a metered call (the synopsis step\'s embedBatch) runs with the SDK\'s hidden retries off too; an unmetered embed keeps the default', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 4, env: { OPENAI_API_KEY: 'sk-fake' } });
      const seen: unknown[] = [];
      __setEmbedTransportForTests((async (args: { values: string[]; maxRetries?: number }) => {
        seen.push('maxRetries' in args ? args.maxRetries : 'default');
        return { embeddings: args.values.map(() => [1, 0, 0, 0]), usage: { tokens: args.values.length } };
      }) as never);
      try {
        await meterPaidCall(engine, page, 'synopsis:openai:gpt-4o', 0.2, () => embedBatch(['chunk one', 'chunk two']));
        await embedBatch(['chunk three']);
      } finally {
        __setEmbedTransportForTests(null);
        resetGateway();
      }
      expect(seen, name).toEqual([0, 'default']);
    }
  });

  test('failed attempts the provider may have billed are booked, so a run of them stops at the family cap: timeouts, retry-wrapped 408s and a 529, wrapped usage', async () => {
    const worst = reservationCostUsd(HAIKU, 'chat', estimateChatInputTokens({ messages: [{ content: 'window' }] }), 500)!;
    const status = (code: number) => Object.assign(new Error(`http ${code}`), { status: code });
    const kinds: Array<[string, () => Error, number]> = [
      ['timeout', () => Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }), worst],
      ['retry 408, 408, 529', () => { const errors = [status(408), status(408), status(529)]; return Object.assign(new Error('Failed after 3 attempts.'), { name: 'AI_RetryError', errors, lastError: errors[2] }); }, 3 * worst],
      ['wrapped usage', () => Object.assign(status(400), { cause: { usage: { input_tokens: 1000, output_tokens: 300 } } }), reservationCostUsd(HAIKU, 'chat', 1000, 300)!],
    ];
    for (const { name, engine } of engines) {
      for (const [kind, failure, cost] of kinds) {
        const page = await segmentedPage(engine);
        const ask = () => chat({ model: HAIKU, messages: [{ role: 'user', content: 'window' }], maxTokens: 500 });
        const cap = 0.0513;
        await engine.setConfig(PAGE_DERIVATION_CAP_KEY, String(cap));
        let calls = 0;
        __setChatTransportForTests(async () => { calls++; throw failure(); });
        let steps = 0;
        let refused = false;
        try {
          while (!refused && steps < 50) {
            steps++;
            refused = 'refused' in await meterPaidCall(engine, page, `facts:${HAIKU}`, 0.01, () => ask().catch(() => null));
          }
        } finally {
          __setChatTransportForTests(null);
          await engine.setConfig(PAGE_DERIVATION_CAP_KEY, '1');
        }
        const allowed = Math.floor((cap - 0.01) / cost) + 1;
        expect({ kind, refused, calls, steps, spent: Number((await familyLedger(engine, page.id, 'facts'))!.spent.toFixed(12)) }, name)
          .toEqual({ kind, refused: true, calls: allowed, steps: allowed + 1, spent: Number((allowed * cost).toFixed(12)) });
      }
    }
  });

  test('concurrent metered calls under one --max-usd tracker count each other\'s in-flight attempts', async () => {
    for (const { name, engine } of engines) {
      const page = await segmentedPage(engine);
      const big = () => chat({ model: HAIKU, messages: [{ role: 'user', content: 'window' }], maxTokens: 100_000 });
      const projected = reservationCostUsd(HAIKU, 'chat', estimateChatInputTokens({ messages: [{ content: 'window' }] }), 100_000)!;
      const parent = new BudgetTracker({ label: 'workers', maxCostUsd: projected * 1.5, auditPath: '/dev/null' });
      let calls = 0;
      let entered!: () => void;
      const inFlight = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      __setChatTransportForTests(async () => {
        calls++;
        entered();
        if (calls === 1) await gate;
        return answer(1000, 200);
      });
      try {
        const first = withBudgetTracker(parent, () => meterPaidCall(engine, page, `facts:${HAIKU}`, 0.2, big));
        await inFlight;
        const second = await withBudgetTracker(parent, () => meterPaidCall(engine, page, `synopsis:${HAIKU}`, 0.2, big))
          .then(() => 'ran', (error: unknown) => (error instanceof BudgetExhausted ? 'refused by --max-usd' : String(error)));
        release();
        expect({ second, first: await first }, name).toEqual({ second: 'refused by --max-usd', first: { value: answer(1000, 200) } });
      } finally {
        release();
        __setChatTransportForTests(null);
      }
      expect({ calls, spent: parent.totalSpent }, name).toEqual({ calls: 1, spent: expect.closeTo(reservationCostUsd(HAIKU, 'chat', 1000, 200)!, 12) });
    }
  });

  test('the estimate honors pricing.overrides and a facts extraction reserves its call and both retries', () => {
    const base = estimateChatCallUsd(HAIKU, 4000, 1000);
    const overrides = parsePricingOverrides(JSON.stringify({ [HAIKU]: { input: 10, output: 100 } }));
    expect(estimateChatCallUsd(HAIKU, 4000, 1000, overrides)).toBeCloseTo(((4000 / 4 + 1500) * 10 + 1000 * 100) / 1_000_000, 12);
    expect(estimateChatCallUsd(HAIKU, 4000, 1000, overrides)).toBeGreaterThan(base);
    expect(estimateFactsExtractionUsd(HAIKU, 4000, 1000)).toBeCloseTo(base + 2 * estimateChatCallUsd(HAIKU, 4000, 2000), 12);
  });
});
