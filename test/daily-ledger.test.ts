/**
 * #6188 durable daily USD ledger (`src/core/budget/daily-ledger.ts`).
 *
 * Protects: the daily spend cap for paid repairs is a real ceiling across
 * processes. Reserve is one conditional upsert against the cap; settle records
 * the actual cost once, on the reservation's own UTC day, overruns included;
 * an expired hold is released and an expired dispatch is charged its reserved
 * maximum; a new UTC day starts fresh; a ledger error means no paid call; an
 * unpriced model is metered at the highest canonical chat rate under a
 * default cap and refused under a user cap; the ledger never replaces the
 * caller's ambient BudgetTracker.
 * Fails when: reserve checks then writes in two steps (concurrent reservers
 * pass the cap), settle double-counts or charges today's row, reclaim drops a
 * dispatched reservation for free, or meteredCall calls without a reservation.
 * Seams: an injected clock; PGLite always, Postgres through
 * test/e2e/daily-ledger-postgres.test.ts (separate sessions for concurrency).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { CANONICAL_PRICING } from '../src/core/model-pricing.ts';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { getCurrentBudgetTracker, withBudgetTracker } from '../src/core/ai/gateway.ts';
import {
  chatCallUsd, dailyLedger, estimateChatCallUsd, ledgerUsd, meteredCall, unpricedChatCeiling,
  type LedgerKey, type ReserveResult,
} from '../src/core/budget/daily-ledger.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();

function clock(iso: string) {
  let t = Date.parse(iso);
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; }, set: (next: string) => { t = Date.parse(next); } };
}
const freshKey = (): LedgerKey => ({ scope: 'llm_repair', resolver: `test-${randomUUID()}` });
const id = (r: ReserveResult) => { if (!r.ok) throw new Error(`expected a reservation, got ${r.reason}`); return r.reservation.id; };
const statusOf = async (engine: BrainEngine, reservation: string) =>
  (await engine.executeRaw<{ status: string }>('SELECT status FROM budget_reservations WHERE reservation_id = $1', [reservation]))[0]?.status;

for (const backend of backends) {
  describe(`${backend}: daily ledger`, () => {
    let engine: BrainEngine;
    let sessions: BrainEngine[] = [];
    let close: () => Promise<void> = async () => {};

    beforeAll(async () => {
      if (backend === 'pglite') {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        sessions = [pglite];
        close = () => pglite.disconnect();
        return;
      }
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = pg.engine;
      const extra = await Promise.all(Array.from({ length: 4 }, async () => {
        const session = new PostgresEngine();
        await session.connect({ database_url: pg.databaseUrl, poolSize: 2 });
        return session;
      }));
      sessions = [pg.engine, ...extra];
      close = async () => { for (const session of extra) await session.disconnect(); await pg.close(); };
    }, 120_000);

    afterAll(async () => { await close(); });

    test('reserve admits estimates up to the cap and refuses the next one with its totals and reset time', async () => {
      const ledger = dailyLedger(engine, freshKey(), clock('2026-10-06T12:00:00Z'));
      expect((await ledger.reserve(0.02, { capUsd: 0.05 })).ok).toBe(true);
      expect((await ledger.reserve(0.02, { capUsd: 0.05 })).ok).toBe(true);
      expect(await ledger.reserve(0.02, { capUsd: 0.05 })).toEqual({ ok: false, reason: 'budget_exhausted', day: '2026-10-06', estimateUsd: 0.02,
        capUsd: 0.05, committedUsd: 0, reservedUsd: 0.04, resetsAt: '2026-10-07T00:00:00.000Z' });
      expect((await ledger.reserve(0.01, { capUsd: 0.05 })).ok).toBe(true);
      expect(await ledger.readDay()).toEqual({ day: '2026-10-06', reservedUsd: 0.05, committedUsd: 0, capUsd: 0.05 });
      const zero = dailyLedger(engine, freshKey(), clock('2026-10-06T12:00:00Z'));
      expect(await zero.reserve(0.0001, { capUsd: 0 })).toMatchObject({ ok: false, reason: 'budget_exhausted', capUsd: 0 });
    });

    test('settle records the actual cost once on the reservation\'s UTC day, and records an overrun', async () => {
      const c = clock('2026-10-06T23:59:50Z');
      const ledger = dailyLedger(engine, freshKey(), c);
      const late = id(await ledger.reserve(0.03, { capUsd: 0.1 }));
      expect(await ledger.dispatch(late)).toBe(true);
      c.set('2026-10-07T00:00:10Z');
      expect(await ledger.settle(late, 0.012)).toEqual({ settled: true, day: '2026-10-06', actualUsd: 0.012, overrunUsd: 0, prior: 'dispatched' });
      expect(await ledger.settle(late, 0.012)).toEqual({ settled: false, reason: 'already_settled', prior: 'settled' });
      expect(await ledger.readDay('2026-10-06')).toMatchObject({ reservedUsd: 0, committedUsd: 0.012 });
      expect(await ledger.readDay('2026-10-07')).toEqual({ day: '2026-10-07', reservedUsd: 0, committedUsd: 0, capUsd: null });

      const over = id(await ledger.reserve(0.01, { capUsd: 0.1 }));
      await ledger.dispatch(over);
      expect(await ledger.settle(over, 0.095)).toEqual({ settled: true, day: '2026-10-07', actualUsd: 0.095, overrunUsd: 0.085, prior: 'dispatched' });
      expect(await statusOf(engine, over)).toBe('overrun');
      expect(await ledger.readDay()).toMatchObject({ reservedUsd: 0, committedUsd: 0.095 });
      expect(await ledger.reserve(0.01, { capUsd: 0.1 })).toMatchObject({ ok: false, reason: 'budget_exhausted', committedUsd: 0.095 });
      expect(await ledger.settle(randomUUID(), 0)).toEqual({ settled: false, reason: 'unknown_reservation' });
    });

    test('release returns an undispatched hold; a dispatched reservation must settle', async () => {
      const ledger = dailyLedger(engine, freshKey(), clock('2026-10-06T12:00:00Z'));
      const held = id(await ledger.reserve(0.04, { capUsd: 0.05 }));
      expect(await ledger.release(held)).toBe(true);
      expect(await ledger.release(held)).toBe(false);
      expect(await ledger.readDay()).toMatchObject({ reservedUsd: 0, committedUsd: 0 });
      const sent = id(await ledger.reserve(0.04, { capUsd: 0.05 }));
      await ledger.dispatch(sent);
      expect(await ledger.release(sent)).toBe(false);
      expect(await ledger.readDay()).toMatchObject({ reservedUsd: 0.04 });
    });

    test('expired reservations are reclaimed before a reserve: a hold is released, a dispatch is charged its reserved maximum', async () => {
      const c = clock('2026-10-06T12:00:00Z');
      const ledger = dailyLedger(engine, freshKey(), c);
      const held = id(await ledger.reserve(0.02, { capUsd: 0.1, ttlMs: 60_000 }));
      const sent = id(await ledger.reserve(0.03, { capUsd: 0.1, ttlMs: 60_000 }));
      expect(await ledger.dispatch(sent)).toBe(true);
      c.advance(61_000);
      expect(await ledger.dispatch(held)).toBe(false);
      expect((await ledger.reserve(0.01, { capUsd: 0.1 })).ok).toBe(true);
      expect(await ledger.readDay()).toMatchObject({ reservedUsd: 0.01, committedUsd: 0.03 });
      expect([await statusOf(engine, held), await statusOf(engine, sent)]).toEqual(['released', 'settled_uncertain']);
      expect(await ledger.reclaimExpired()).toEqual({ released: 0, settledUncertain: 0 });
      // A settle that arrives after reclaim still records the real cost.
      expect(await ledger.settle(sent, 0.01)).toMatchObject({ settled: true, prior: 'settled_uncertain' });
      expect(await ledger.settle(held, 0.005)).toMatchObject({ settled: true, prior: 'released' });
      expect(await ledger.readDay()).toMatchObject({ reservedUsd: 0.01, committedUsd: 0.015 });
    });

    test('a new UTC day starts a fresh ledger row', async () => {
      const c = clock('2026-10-06T23:00:00Z');
      const ledger = dailyLedger(engine, freshKey(), c);
      const spent = id(await ledger.reserve(0.05, { capUsd: 0.05 }));
      await ledger.dispatch(spent);
      await ledger.settle(spent, 0.05);
      expect(await ledger.reserve(0.01, { capUsd: 0.05 })).toMatchObject({ ok: false, reason: 'budget_exhausted', resetsAt: '2026-10-07T00:00:00.000Z' });
      c.set('2026-10-07T00:00:00Z');
      expect(await ledger.reserve(0.05, { capUsd: 0.05 })).toMatchObject({ ok: true, reservation: { day: '2026-10-07' } });
      expect(await ledger.readDay('2026-10-06')).toMatchObject({ committedUsd: 0.05 });
    });

    test('meteredCall calls only under a dispatched reservation and settles actual cost, or the estimate when the call throws', async () => {
      const ledger = dailyLedger(engine, freshKey(), clock('2026-10-06T12:00:00Z'));
      const ok = await meteredCall(ledger, { estimateUsd: 0.02, capUsd: 0.05 }, async () => ({ value: 'answer', actualUsd: 0.007 }));
      expect(ok).toMatchObject({ ok: true, value: 'answer', settle: { settled: true, actualUsd: 0.007 } });
      await expect(meteredCall(ledger, { estimateUsd: 0.02, capUsd: 0.05 }, async () => { throw new Error('socket hang up'); })).rejects.toThrow('socket hang up');
      expect(await ledger.readDay()).toMatchObject({ reservedUsd: 0, committedUsd: 0.027 });
      let calls = 0;
      expect(await meteredCall(ledger, { estimateUsd: 0.03, capUsd: 0.05 }, async () => { calls++; return { value: 1, actualUsd: 0 }; }))
        .toMatchObject({ ok: false, reason: 'budget_exhausted' });
      expect(await meteredCall(ledger, { estimateUsd: 0.01, capUsd: 0.05, ttlMs: 0 }, async () => { calls++; return { value: 1, actualUsd: 0 }; }))
        .toMatchObject({ ok: false, reason: 'ledger_unavailable', stage: 'dispatch' });
      expect(calls).toBe(0);
      expect(await ledger.readDay()).toMatchObject({ reservedUsd: 0, committedUsd: 0.027 });
    });

    test('the ledger keeps the caller\'s ambient BudgetTracker (doctor --remediate composition)', async () => {
      const ledger = dailyLedger(engine, freshKey(), clock('2026-10-06T12:00:00Z'));
      const outer = new BudgetTracker({ label: 'doctor.remediate', maxCostUsd: 1 });
      const seen: { tracker?: BudgetTracker | null } = {};
      await withBudgetTracker(outer, () => meteredCall(ledger, { estimateUsd: 0.01, capUsd: 1 }, async () => {
        seen.tracker = getCurrentBudgetTracker();
        return { value: null, actualUsd: 0.001 };
      }));
      expect(seen.tracker).toBe(outer);
    });

    test('concurrent reservers across sessions never pass the cap, and concurrent settles count once', async () => {
      const key = freshKey();
      const c = clock('2026-10-06T12:00:00Z');
      const ledgers = sessions.map(session => dailyLedger(session, key, c));
      const results = await Promise.all(Array.from({ length: 40 }, (_, i) => ledgers[i % ledgers.length]!.reserve(0.01, { capUsd: 0.25 })));
      expect(results.filter(r => r.ok)).toHaveLength(25);
      expect(results.filter(r => !r.ok).every(r => !r.ok && r.reason === 'budget_exhausted')).toBe(true);
      expect(await ledgers[0]!.readDay()).toMatchObject({ reservedUsd: 0.25, committedUsd: 0 });
      const [held] = await engine.executeRaw<{ n: number; total: string }>(
        "SELECT count(*)::int AS n, sum(estimate_usd)::text AS total FROM budget_reservations WHERE resolver_id = $1 AND status = 'held'", [key.resolver]);
      expect([Number(held!.n), Number(held!.total)]).toEqual([25, 0.25]);

      const target = id(results.find(r => r.ok)!);
      await ledgers[0]!.dispatch(target);
      const settles = await Promise.all(ledgers.flatMap(l => [l.settle(target, 0.004), l.settle(target, 0.004)]));
      expect(settles.filter(s => s.settled)).toHaveLength(1);
      expect(await ledgers[0]!.readDay()).toMatchObject({ reservedUsd: 0.24, committedUsd: 0.004 });
    }, 60_000);
  });
}

if (backends.includes('pglite')) {
  describe('daily ledger without a database', () => {
    test('a ledger error means no paid call', async () => {
      const broken = { executeRaw: async () => { throw new Error('connection refused'); } } as unknown as BrainEngine;
      const ledger = dailyLedger(broken, freshKey(), clock('2026-10-06T12:00:00Z'));
      expect(await ledger.reserve(0.01, { capUsd: 1 })).toEqual({ ok: false, reason: 'ledger_unavailable', day: '2026-10-06' });
      expect(await ledger.dispatch(randomUUID())).toBe(false);
      expect(await ledger.release(randomUUID())).toBe(false);
      expect(await ledger.settle(randomUUID(), 0.01)).toEqual({ settled: false, reason: 'ledger_unavailable' });
      let calls = 0;
      expect(await meteredCall(ledger, { estimateUsd: 0.01, capUsd: 1 }, async () => { calls++; return { value: 1, actualUsd: 0 }; }))
        .toMatchObject({ ok: false, reason: 'ledger_unavailable' });
      expect(calls).toBe(0);
    });

    test('amounts round to the ledger precision: spend up, caps down', () => {
      expect([ledgerUsd(0.0007), ledgerUsd(0.00001), ledgerUsd(0.12345), ledgerUsd(1.00009, 'down'), ledgerUsd(0.05, 'down')])
        .toEqual(['0.0007', '0.0001', '0.1235', '1.0000', '0.0500']);
      expect(() => ledgerUsd(Number.NaN)).toThrow(RangeError);
      expect(() => ledgerUsd(-0.01)).toThrow(RangeError);
    });

    test('an unpriced model is metered at the highest canonical chat rate under a default cap and refused under a user cap', () => {
      const ceiling = unpricedChatCeiling();
      const rows = Object.values(CANONICAL_PRICING);
      expect(rows.every(r => r.input <= ceiling.input && r.output <= ceiling.output)).toBe(true);
      expect(rows.some(r => r.input === ceiling.input) && rows.some(r => r.output === ceiling.output)).toBe(true);

      const call = { model: 'acme-example:frontier-next', inputTokens: 2_000, maxOutputTokens: 1_000 };
      const ceilingUsd = (2_000 * ceiling.input + 1_000 * ceiling.output) / 1_000_000;
      expect(estimateChatCallUsd({ ...call, capSource: 'default' })).toEqual({ ok: true, quote: { usd: ceilingUsd, estimated: true, source: 'ceiling' } });
      const refused = estimateChatCallUsd({ ...call, capSource: 'user' });
      expect(refused).toMatchObject({ ok: false, reason: 'no_pricing', guidance: { code: 'no_pricing', model: call.model, kind: 'chat' } });
      expect(!refused.ok && refused.guidance.register_command).toStartWith('gbrain pricing set acme-example:frontier-next');
      expect(chatCallUsd(call.model, { inputTokens: 2_000, outputTokens: 1_000 })).toEqual({ usd: ceilingUsd, estimated: true, source: 'ceiling' });

      expect(estimateChatCallUsd({ model: 'anthropic:claude-sonnet-5-5', inputTokens: 2_000, maxOutputTokens: 1_000, capSource: 'user' }))
        .toEqual({ ok: true, quote: { usd: (2_000 * 2 + 1_000 * 10) / 1_000_000, estimated: false, source: 'table' } });
      const overrides = { 'acme-example:frontier-next': { input: 1, output: 2 } };
      expect(estimateChatCallUsd({ ...call, overrides, capSource: 'user' }))
        .toEqual({ ok: true, quote: { usd: (2_000 * 1 + 1_000 * 2) / 1_000_000, estimated: false, source: 'override' } });
      expect(estimateChatCallUsd({ model: 'ollama:llama3', inputTokens: 2_000, maxOutputTokens: 1_000, capSource: 'user' }))
        .toEqual({ ok: true, quote: { usd: 0, estimated: false, source: 'table' } });
    });
  });
}
