/**
 * BrainEngine parity — the daily budget ledger's writes (engine-sql/budget-ledger-writes.ts): reclaim, reserve, dispatch,
 * settle and release, the paid-call protocol of budget/daily-ledger.ts that the fence and slug-conflict repairs' model
 * tier runs.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a reservation is held only while the day stays within its cap; a held, unexpired one dispatches once; a
 *    settle moves its estimate from reserved to the actual committed amount and reports the prior status, a second settle
 *    reports it already settled; a release frees a held estimate; an expired held reservation is reclaimed as released and
 *    an expired dispatched one settles at its estimate. The day read (`readBudgetLedgerDay`) sees exactly what the writes
 *    left, and answers null for a day or a resolver with no row. Equal on PGLite, Postgres (DATABASE_URL) and the Rust
 *    store's ledger (gbrain-store budget_ledger.rs).
 *  - Regression: the writes were raw SQL in the ledger, so the Rust engine refused them, and its day read always
 *    answered null, so a paid call on a Rust brain got ledger_unavailable.
 *  - Why existing coverage misses it: test/budget-daily-ledger*.test.ts runs on PGLite only.
 *  - Seam: none. Typed members for the writes; the day totals through the ledger's own read.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { dailyLedger } from '../../src/core/budget/daily-ledger.ts';

const { parityTest } = parityArms(testBackends());

const KEY = { scope: 'llm_repair', resolver: 'parity' };
const DAY = '2026-11-21';
const AT = '2026-11-21T10:00:00.000Z';
const LATER = '2026-11-21T10:05:00.000Z';
const EXPIRES = '2026-11-21T10:10:00.000Z';
const PAST = '2026-11-21T11:00:00.000Z';

describe('engine parity: the daily budget ledger writes', () => {
  parityTest('a reservation holds within the cap, dispatches, settles once, releases and reclaims the same way', {
    methods: ['reserveBudgetReservation', 'dispatchBudgetReservation', 'settleBudgetReservation', 'releaseBudgetReservation', 'reclaimBudgetReservations'],
    timeout: 60_000,
  }, async (engine) => {
    const spec = (id: string, estimate: string) => ({ day: DAY, estimate, cap: '1.0000', id, at: AT, expiresAt: EXPIRES });
    const held = await engine.reserveBudgetReservation(KEY, spec('r1', '0.4000'));
    const second = await engine.reserveBudgetReservation(KEY, spec('r2', '0.3000'));
    const overCap = await engine.reserveBudgetReservation(KEY, spec('r3', '0.5000'));
    const dispatched = await engine.dispatchBudgetReservation(KEY, 'r1', LATER);
    const again = await engine.dispatchBudgetReservation(KEY, 'r1', LATER);
    const settled = await engine.settleBudgetReservation(KEY, 'r1', '0.4500');
    const settledAgain = await engine.settleBudgetReservation(KEY, 'r1', '0.4500');
    const unknown = await engine.settleBudgetReservation(KEY, 'nope', '0.1000');
    const released = await engine.releaseBudgetReservation(KEY, 'r2');
    const releasedAgain = await engine.releaseBudgetReservation(KEY, 'r2');
    await engine.reserveBudgetReservation(KEY, spec('r4', '0.1000'));
    await engine.reserveBudgetReservation(KEY, spec('r5', '0.1000'));
    await engine.dispatchBudgetReservation(KEY, 'r5', LATER);
    const reclaimed = await engine.reclaimBudgetReservations(KEY, PAST);
    const day = await dailyLedger(engine, KEY).readDay(DAY);
    const answers = { held, second, overCap, dispatched, again, settled, settledAgain, unknown, released, releasedAgain, reclaimed, day };
    expect(answers).toEqual({
      held: true, second: true, overCap: false, dispatched: true, again: false,
      settled: { prior: 'dispatched', estimate: '0.4000', day: DAY, current: 'dispatched' },
      settledAgain: { prior: null, estimate: null, day: null, current: 'overrun' },
      unknown: { prior: null, estimate: null, day: null, current: null },
      released: true, releasedAgain: false, reclaimed: { released: 1, uncertain: 1 },
      day: { day: DAY, reservedUsd: 0, committedUsd: 0.55, capUsd: 1 },
    });
    return answers;
  });

  parityTest('the day read sees what the ledger writes left, and nothing for another day or resolver', {
    methods: ['reserveBudgetReservation', 'dispatchBudgetReservation', 'settleBudgetReservation', 'readBudgetLedgerDay'],
    timeout: 60_000,
  }, async (engine) => {
    const empty = await engine.readBudgetLedgerDay(KEY.scope, KEY.resolver, DAY);
    await engine.reserveBudgetReservation(KEY, { day: DAY, estimate: '0.2500', cap: '2.0000', id: 'd1', at: AT, expiresAt: EXPIRES });
    const held = await engine.readBudgetLedgerDay(KEY.scope, KEY.resolver, DAY);
    await engine.dispatchBudgetReservation(KEY, 'd1', LATER);
    await engine.settleBudgetReservation(KEY, 'd1', '0.1250');
    const settled = await engine.readBudgetLedgerDay(KEY.scope, KEY.resolver, DAY);
    const otherDay = await engine.readBudgetLedgerDay(KEY.scope, KEY.resolver, '2026-11-22');
    const otherResolver = await engine.readBudgetLedgerDay(KEY.scope, 'someone-else', DAY);
    const answers = { empty, held, settled, otherDay, otherResolver };
    expect(answers).toEqual({
      empty: null,
      held: { reserved: '0.2500', committed: '0.0000', cap: '2.0000' },
      settled: { reserved: '0.0000', committed: '0.1250', cap: '2.0000' },
      otherDay: null, otherResolver: null,
    });
    return answers;
  });
});

