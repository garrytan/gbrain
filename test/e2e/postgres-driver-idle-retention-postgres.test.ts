/**
 * An idle pooled connection keeps nothing from its last statement. Stock postgres.js left its receive buffer as an
 * empty view over the last message it joined from several socket reads, so a large row's DataRow (twice the row's bytes
 * for a bytea, which arrives as hex) stayed allocated until the connection's next read; and the desync tripwire kept the
 * last query, whose promise holds its result rows. A pool hands statements out in turn, so each connection held one.
 *
 * A connection that closed under a statement also kept that statement (and its parameters) as the last one written.
 *
 * Regression that fails it on the base driver: after a 4 MiB bytea read whose result is dropped, the heap holds the
 * 8 MiB DataRow (receive buffer) and the 4 MiB decoded row (tripwire); either one alone is over the 2 MiB bound. After
 * a statement with a 4 MiB parameter whose backend is terminated, the closed connection holds the parameter.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
const MB = 1024 * 1024;
const ROW = 4 * MB;
const opened: Array<{ end: (o?: { timeout?: number }) => Promise<void> }> = [];
afterEach(async () => { while (opened.length) await opened.pop()!.end({ timeout: 1 }).catch(() => {}); });

function heap(): number {
  Bun.gc(true);
  return process.memoryUsage().heapUsed;
}

describe.skipIf(!url)('vendored driver retention after a large row', () => {
  test('a connection keeps neither the receive buffer nor the rows of its last statement', async () => {
    assertSafeE2eDatabaseUrl(url!);
    const sql = postgres(url!, { max: 1, onnotice: () => {} });
    opened.push(sql);
    await sql.unsafe('SELECT 1');
    const base = heap();
    const read = async () => {
      const [row] = await sql.unsafe("SELECT decode(repeat('ab', $1::int), 'hex') AS body", [ROW]) as unknown as Array<{ body: Uint8Array }>;
      return row!.body.length;
    };
    expect(await read()).toBe(ROW);
    await new Promise(resolve => setTimeout(resolve, 0));
    const held = heap() - base;
    console.log('[postgres-driver-retention] held ' + (held / MB).toFixed(2) + ' MiB after a ' + ROW / MB + ' MiB bytea row');
    expect(held).toBeLessThan(ROW / 2);
  });

  test('a connection that closed under a statement keeps neither the statement nor its parameters', async () => {
    assertSafeE2eDatabaseUrl(url!);
    const sql = postgres(url!, { max: 1, onnotice: () => {} });
    const admin = postgres(url!, { max: 1, onnotice: () => {} });
    opened.push(sql, admin);
    const [{ pid }] = await sql.unsafe('SELECT pg_backend_pid() AS pid') as unknown as Array<{ pid: number }>;
    const base = heap();
    const settled = Promise.resolve(sql.unsafe('SELECT pg_sleep(30), length($1::bytea)', [Buffer.alloc(ROW, 1)]))
      .then(() => 'resolved', (e: { code?: string }) => e.code ?? 'error');
    await new Promise(resolve => setTimeout(resolve, 500));
    await admin.unsafe('SELECT pg_terminate_backend($1)', [pid]);
    expect(await settled).not.toBe('resolved');
    await new Promise(resolve => setTimeout(resolve, 0));
    const held = heap() - base;
    console.log('[postgres-driver-retention] held ' + (held / MB).toFixed(2) + ' MiB after a closed statement with a ' + ROW / MB + ' MiB parameter');
    expect(held).toBeLessThan(ROW / 2);
  });
});
