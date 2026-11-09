/**
 * #8651: `runDeadlineRead` (postgres-engine/bounded-statement.ts), the reserved read-only transaction a bounded
 * preparation's engine reads run in. Its deadline covers the wait for a pool connection, a read whose deadline passed is
 * never sent, and a trailing COMMIT that never settles gives back its connection and gauge slot. The real pool-wait case
 * is test/e2e/persistence-preparation-pool-wait-postgres.test.ts.
 */
import { expect, test } from 'bun:test';
import type postgres from '#postgres';
import { runDeadlineRead } from '../src/core/postgres-engine/bounded-statement.ts';
import { CheckoutGauge } from '../src/core/pool-gauge.ts';

type Sql = ReturnType<typeof postgres>;
const never = () => new Promise<never>(() => {});

function pool(opts: { reserve?: (owner: unknown) => Promise<unknown>; commit?: () => Promise<unknown> } = {}) {
  const sent: string[] = [];
  const counts = { reserves: 0, releases: 0, discards: 0 };
  const owner = {
    release: () => { counts.releases++; },
    discard: () => { counts.discards++; },
    unsafe: (sql: string) => {
      sent.push(sql);
      const query = { simple: () => query, execute: () => sql === 'COMMIT' && opts.commit ? opts.commit() : Promise.resolve([]) };
      return query;
    },
  };
  const conn = { reserve: () => { counts.reserves++; return opts.reserve ? opts.reserve(owner) : Promise.resolve(owner); } } as unknown as Sql;
  return { conn, sent, counts, gauge: new CheckoutGauge() };
}

test('a read whose deadline already passed is refused before it reserves a connection', async () => {
  const p = pool();
  let ran = 0;
  const outcome = await runDeadlineRead(p.conn, Date.now() - 1, async () => { ran++; }, p.gauge, 50).catch(error => error);
  expect(outcome).toMatchObject({ code: 'read_deadline' });
  expect(ran).toBe(0);
  expect(p.counts.reserves).toBe(0);
  expect(p.gauge.snapshot().reserved).toBe(0);
});

test('a connection that arrives after the deadline is handed back without BEGIN or the read', async () => {
  const late = Promise.withResolvers<void>();
  const p = pool({ reserve: async owner => { await late.promise; return owner; } });
  let ran = 0;
  const fallback = setTimeout(() => late.resolve(), 1_500);
  const started = Date.now();
  const outcome = await runDeadlineRead(p.conn, Date.now() + 40, async () => { ran++; }, p.gauge, 50).catch(error => error);
  const settledAfter = Date.now() - started;
  clearTimeout(fallback);
  late.resolve();
  await Bun.sleep(10);
  expect(outcome).toMatchObject({ code: 'read_deadline' });
  expect(settledAfter).toBeLessThan(1_000);
  expect(ran).toBe(0);
  expect(p.sent).toEqual([]);
  expect(p.counts).toMatchObject({ releases: 1, discards: 0 });
  expect(p.gauge.snapshot().reserved).toBe(0);
});

test('a trailing COMMIT that never settles has its connection discarded and its gauge slot returned', async () => {
  const p = pool({ commit: never });
  const answer = await runDeadlineRead(p.conn, Date.now() + 30, async () => 'answer', p.gauge, 50);
  expect(answer).toBe('answer');
  await Bun.sleep(150);
  expect(p.sent.at(-1)).toBe('COMMIT');
  expect(p.counts).toMatchObject({ releases: 1, discards: 1 });
  expect(p.gauge.snapshot().reserved).toBe(0);
});

test('a COMMIT that settles releases the connection and never discards it', async () => {
  const p = pool();
  expect(await runDeadlineRead(p.conn, Date.now() + 30, async () => 'answer', p.gauge, 50)).toBe('answer');
  await Bun.sleep(150);
  expect(p.counts).toMatchObject({ reserves: 1, releases: 1, discards: 0 });
  expect(p.gauge.snapshot().reserved).toBe(0);
});
