/**
 * The shadow follower's journal bookkeeping exemption (src/shadow/follow.ts JOURNAL_BOOKKEEPING_MEMBERS) trusts a census of what each
 * member sends (JOURNAL_MEMBER_STATEMENTS, src/shadow/write-capture.ts) and trusts `onCheckout` to send nothing at all. This test calls
 * the REAL engine members, the PGLite delegates and PostgresEngine.onCheckout, with a seam that records every statement they send.
 *
 * Protects: a journal member's engine delegate sends only the statements the census names, so every table it writes is one the
 * follower publishes for it (persistence_counters, persistence_requests, config, persistence_effects; the lock members write none);
 * onCheckout registers a pool listener and sends no statement, and its unsubscribe function removes the listener.
 * Regression it catches: a delegate (or onCheckout) that gains a statement the census does not list, for example an UPDATE of pages,
 * while the follower keeps publishing the old relations and no longer sees that write.
 * Postgres twin (the Postgres delegates): test/e2e/shadow-journal-bookkeeping-delegates.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { JOURNAL_BOOKKEEPING_MEMBERS } from '../src/shadow/follow.ts';
import { MEMBERS, assertWithinCensus, recordingEngine, runDelegates, type Recorded } from './helpers/shadow-journal-delegates.ts';

describe('PGLite delegates of the journal bookkeeping members', () => {
  let engine: PGLiteEngine;
  let ran: Awaited<ReturnType<typeof runDelegates>>;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    ran = await runDelegates('pglite', engine);
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });

  test('the cases cover exactly the listed members', () => {
    expect([...JOURNAL_BOOKKEEPING_MEMBERS].sort()).toEqual([...MEMBERS].sort());
    expect([...ran.keys()].sort()).toEqual([...MEMBERS].sort());
  });

  for (const member of MEMBERS) {
    test(`${member} sends only the statements its census names, and writes only the tables the follower publishes for it`, () => {
      const calls = ran.get(member)!;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      assertWithinCensus(member, calls.map((c) => c.statements));
    });
  }

  test('the recorder sees a statement a delegate adds, and the census check rejects it', async () => {
    const extra = recordingEngine('pglite', engine);
    await extra.engine.executeRaw('UPDATE pages SET title = title WHERE false');
    await extra.engine.completeEffectRow({ id: '999999999', token: null, outcomeJson: '{}' });
    expect(extra.statements.map((s) => s.sql)[0]).toBe('UPDATE pages SET title = title WHERE false');
    const sent = ran.get('completeEffectRow')!.map((c) => c.statements);
    expect(() => assertWithinCensus('completeEffectRow', [...sent, extra.statements])).toThrow();
  });
});

describe('PostgresEngine.onCheckout', () => {
  /** An engine with no database whose pool handle refuses every use and notes it: a statement or any touch of the pool is recorded. */
  function sealed() {
    const engine = new PostgresEngine();
    const touched: Recorded[] = [];
    const refuse = (what: string, params?: unknown): never => { touched.push({ sql: what, params }); throw new Error(`database used: ${what}`); };
    const pool = new Proxy(function pool() {}, {
      apply: (_t, _this, args) => refuse(`tagged:${String(args[0])}`, args.slice(1)),
      get: (_t, key) => (key === 'unsafe' ? (sql: string, params?: unknown) => refuse(sql, params) : refuse(`property:${String(key)}`)),
    });
    (engine as unknown as { _sql: unknown })._sql = pool;
    return { engine, touched, gauge: (engine as unknown as { checkoutGauge: { checkedOut(): void } }).checkoutGauge };
  }
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

  test('sends no statement and touches no connection; the listener is registered and the unsubscribe removes it', async () => {
    const { engine, touched, gauge } = sealed();
    let first = 0, second = 0;
    let thrown: unknown;
    let stopFirst = () => {}, stopSecond = () => {};
    try {
      stopFirst = engine.onCheckout(() => { first += 1; });
      stopSecond = engine.onCheckout(() => { second += 1; });
    } catch (error) { thrown = error; }
    await settle();
    expect(touched).toEqual([]);
    expect(thrown).toBeUndefined();

    gauge.checkedOut();
    expect([first, second]).toEqual([1, 1]);
    stopFirst();
    gauge.checkedOut();
    expect([first, second]).toEqual([1, 2]);
    stopSecond();
    gauge.checkedOut();
    expect([first, second]).toEqual([1, 2]);
    stopFirst(); // a second call is harmless
    await settle();
    expect(touched).toEqual([]);
  });
});
