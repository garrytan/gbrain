/**
 * The vendored driver counts a statement's rows as they arrive and resets the count at CommandComplete. A statement
 * that streamed rows and then failed (a runtime error after its first rows, or a cancel or timeout while it was still
 * producing them) never reaches CommandComplete, so the count stayed behind and the next statement on that connection
 * stored its rows after that many empty slots: a one-row read came back as `[empty, row]`.
 *
 * gbrain's strict readers refuse such a result. A managed connector sync's first read of `persistence_brain` threw
 * `storage_error` ("requires exactly one known boolean persistence state") before the sweep started (the
 * `persistence-connector-retry` flake), and before those readers were strict the same read came back as
 * `enabled = false` (#6482). The driver now resets the count at every ReadyForQuery.
 *
 * Regression that fails it on the base driver: each follower reads back more rows than it returned, with empty
 * leading slots.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
const opened: Array<{ end: (o?: { timeout?: number }) => Promise<void> }> = [];
afterEach(async () => { while (opened.length) await opened.pop()!.end({ timeout: 1 }).catch(() => {}); });

function pool() {
  assertSafeE2eDatabaseUrl(url!);
  const sql = postgres(url!, { max: 1, onnotice: () => {} });
  opened.push(sql);
  return sql;
}
const code = (query: PromiseLike<unknown>) => Promise.resolve(query).then(() => 'resolved', (e: { code?: string }) => e.code ?? 'error');

describe.skipIf(!url)('vendored driver row count after a statement that failed mid-stream', () => {
  test('a runtime error after the first rows leaves the next statement its own rows', async () => {
    const sql = pool();
    expect(await code(sql.unsafe('SELECT g, 1 / (g - 3) AS v FROM generate_series(1, 5) g'))).toBe('22012');
    expect(Array.from(await sql.unsafe('SELECT true AS enabled') as Iterable<unknown>)).toEqual([{ enabled: true }]);
  });

  test('a statement cancelled while it was still producing rows leaves the next statement its own rows', async () => {
    const sql = pool();
    const running = sql.unsafe('SELECT g, pg_sleep(CASE WHEN g = 2 THEN 30 ELSE 0 END) FROM generate_series(1, 2) g');
    const settled = code(running);
    await new Promise(resolve => setTimeout(resolve, 500));
    running.cancel();
    expect(await settled).toBe('57014');
    expect(Array.from(await sql.unsafe('SELECT true AS enabled') as Iterable<unknown>)).toEqual([{ enabled: true }]);
  });

  test('a statement pipelined behind one that fails mid-stream gets exactly its own rows', async () => {
    const sql = pool();
    const failing = code(sql.unsafe('SELECT g, 1 / (g - 3) AS v FROM generate_series(1, 5) g'));
    const follower = sql.unsafe('SELECT 1 AS n UNION ALL SELECT 2');
    expect(await failing).toBe('22012');
    expect(Array.from(await follower as Iterable<unknown>)).toEqual([{ n: 1 }, { n: 2 }]);
  });
});
