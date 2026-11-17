/**
 * #8155: `runBoundedStatement` with `timeoutMs` and a `signal`. An abort after the connection was reserved, while
 * the statement is stalled on a socket or pooler that stopped answering, ends the call and discards the reserved
 * connection instead of leaving it reserved until the driver answers.
 */
import { expect, test } from 'bun:test';
import type postgres from '#postgres';
import { runBoundedStatement } from '../src/core/postgres-engine/bounded-statement.ts';

type Sql = ReturnType<typeof postgres>;

function stalledPool() {
  const counts = { releases: 0, discards: 0, cancels: 0 };
  const pending: Array<(error: Error) => void> = [];
  const owner = {
    release: () => { counts.releases++; },
    discard: () => {
      counts.discards++;
      for (const reject of pending.splice(0)) reject(Object.assign(new Error('Connection was discarded'), { code: 'CONNECTION_CLOSED' }));
    },
    unsafe: (sql: string) => {
      const query = {
        simple: () => query,
        execute: () => sql.startsWith('select')
          ? Object.assign(new Promise<never>((_, reject) => { pending.push(reject); }), { cancel: () => { counts.cancels++; } })
          : Promise.resolve([]),
      };
      return query;
    },
  };
  const conn = { reserve: async () => owner } as unknown as Sql;
  return { conn, counts };
}

test('an abort after reservation ends a stalled bounded statement and discards its connection', async () => {
  const p = stalledPool();
  const controller = new AbortController();
  const call = runBoundedStatement(p.conn, 'select pg_sleep(60)', [], { timeoutMs: 60_000, signal: controller.signal }, () => {});
  setTimeout(() => controller.abort(), 20);
  const outcome = await Promise.race([call.then(() => 'resolved', error => error), Bun.sleep(1_000).then(() => 'still pending')]);
  expect(outcome).toMatchObject({ name: 'AbortError' });
  expect(p.counts).toEqual({ releases: 0, discards: 1, cancels: 1 });
});

test('a bounded statement that settles before any abort releases its connection', async () => {
  const counts = { releases: 0, discards: 0 };
  const owner = {
    release: () => { counts.releases++; },
    discard: () => { counts.discards++; },
    unsafe: () => { const query = { simple: () => query, execute: () => Promise.resolve([{ ok: 1 }]) }; return query; },
  };
  const controller = new AbortController();
  const rows = await runBoundedStatement({ reserve: async () => owner } as unknown as Sql, 'select 1 as ok', [], { timeoutMs: 1_000, signal: controller.signal }, () => {});
  controller.abort();
  expect(rows).toEqual([{ ok: 1 }]);
  expect(counts).toEqual({ releases: 1, discards: 0 });
});
