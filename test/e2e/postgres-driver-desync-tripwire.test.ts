/**
 * Vendored driver (vendor/postgres): a statement's answer (rows, completion, parse/bind acknowledgement, a
 * statement error) that arrives when no statement is waiting for one means every later answer on that connection
 * would be read for the wrong query. The connection is retired, everything queued on it fails with
 * CONNECTION_DESYNC, `ondesync` reports the message type, connection id and last statement, and the pool
 * reconnects. Notices, notifications and parameter changes legitimately arrive with no statement and never trip it.
 */
import { describe, expect, test } from 'bun:test';
import net from 'node:net';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { poolHealthOptions } from '../../src/core/db.ts';
import { PoolIncidentCounter } from '../../src/core/pool-gauge.ts';

const databaseUrl = process.env.DATABASE_URL;
type Desync = { message: string; connection: number; statement: string };

/** A CommandComplete ('C') for a statement nobody sent: the shape a desynced pipeline delivers. */
const strayCommandComplete = () => {
  const tag = Buffer.from('SELECT 1\0');
  const head = Buffer.alloc(5);
  head.write('C', 0);
  head.writeInt32BE(tag.length + 4, 1);
  return Buffer.concat([head, tag]);
};

describe.skipIf(!databaseUrl)('vendored driver: the desync tripwire', () => {
  test('an answer with no statement waiting retires the connection, reports once, and the pool reconnects', async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    const url = new URL(databaseUrl!);
    const sockets: net.Socket[] = [];
    const desyncs: Desync[] = [];
    const sql = postgres(databaseUrl!, {
      max: 1, onnotice: () => {}, ondesync: (info: Desync) => desyncs.push(info),
      socket: () => { const s = net.connect(Number(url.port || 5432), url.hostname); sockets.push(s); return s; },
    } as postgres.Options<Record<string, never>>);
    try {
      expect([...await sql.unsafe('SELECT $1::int AS n', [1])] as unknown[]).toEqual([{ n: 1 }]);
      const reserved = await sql.reserve();
      const slow = reserved.unsafe('SELECT pg_sleep(0.3) AS slept').execute();
      const queued = reserved.unsafe('SELECT 2 AS n').execute();
      await new Promise(resolve => setTimeout(resolve, 50));
      reserved.release();
      const outcomes = await Promise.allSettled([slow, queued]);
      expect(outcomes.map(o => o.status)).toEqual(['fulfilled', 'fulfilled']);
      sockets[0]!.emit('data', strayCommandComplete());
      expect(desyncs).toEqual([{ message: 'C', connection: expect.any(Number), statement: 'SELECT 2 AS n' }]);
      const pipelined = await Promise.allSettled([sql.unsafe('SELECT 3 AS n'), sql.unsafe('SELECT 4 AS n')]);
      expect(pipelined.every(o => o.status === 'fulfilled')).toBe(true);
      expect(sockets.length).toBe(2);
      expect(desyncs).toHaveLength(1);
    } finally {
      await sql.end({ timeout: 1 });
    }
  }, 30_000);

  test('a reserved connection that desyncs refuses every later statement with a typed connection error', async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    const url = new URL(databaseUrl!);
    const sockets: net.Socket[] = [];
    const desyncs: Desync[] = [];
    const sql = postgres(databaseUrl!, {
      max: 1, onnotice: () => {}, ondesync: (info: Desync) => desyncs.push(info),
      socket: () => { const s = net.connect(Number(url.port || 5432), url.hostname); sockets.push(s); return s; },
    } as postgres.Options<Record<string, never>>);
    try {
      const reserved = await sql.reserve();
      expect([...await reserved.unsafe('SELECT 5 AS n')] as unknown[]).toEqual([{ n: 5 }]);
      sockets[0]!.emit('data', strayCommandComplete());
      expect(desyncs).toEqual([{ message: 'C', connection: expect.any(Number), statement: 'SELECT 5 AS n' }]);
      const after = await reserved.unsafe('SELECT 6 AS n').then(() => 'resolved', (e: { code?: string }) => e.code);
      expect(after).toMatch(/^CONNECTION_(DESYNC|DESTROYED)$/);
      reserved.release();
      expect([...await sql.unsafe('SELECT 7 AS n')] as unknown[]).toEqual([{ n: 7 }]);
      expect(sockets.length).toBe(2);
    } finally {
      await sql.end({ timeout: 1 });
    }
  }, 30_000);

  test('LISTEN/NOTIFY, server notices and parameter changes never trip it', async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    const desyncs: Desync[] = [];
    const notices: string[] = [];
    const sql = postgres(databaseUrl!, { max: 2, onnotice: n => notices.push(String(n.message)), ondesync: (info: Desync) => desyncs.push(info) } as postgres.Options<Record<string, never>>);
    const channel = `driver_desync_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
    try {
      const received: string[] = [];
      const { unlisten } = await sql.listen(channel, payload => { received.push(payload); });
      for (let i = 0; i < 5; i++) await sql.notify(channel, `p${i}`);
      const deadline = Date.now() + 5_000;
      while (received.length < 5 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      expect(received).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
      await sql.unsafe("DO $$ BEGIN RAISE NOTICE 'driver desync notice'; END $$");
      await sql.unsafe("SET application_name = 'driver-desync-probe'");
      expect([...await sql.unsafe('SELECT 8 AS n')] as unknown[]).toEqual([{ n: 8 }]);
      await unlisten();
      expect(notices).toContain('driver desync notice');
      expect(desyncs).toEqual([]);
    } finally {
      await sql.end({ timeout: 1 });
    }
  }, 30_000);

  test("gbrain's pool hooks log one pg_connection_desync line per trip, by keyword and table, with no SQL text or parameters", async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    const url = new URL(databaseUrl!);
    const sockets: net.Socket[] = [];
    const counter = new PoolIncidentCounter();
    const sql = postgres(databaseUrl!, {
      max: 1, onnotice: () => {}, ...poolHealthOptions(counter.hooks('direct'), undefined),
      socket: () => { const s = net.connect(Number(url.port || 5432), url.hostname); sockets.push(s); return s; },
    } as postgres.Options<Record<string, never>>);
    const warn = console.warn;
    const lines: string[] = [];
    console.warn = (line: string) => { lines.push(String(line)); };
    try {
      await sql.unsafe("SELECT relname FROM pg_class WHERE relname = $1 AND 'literal-text' <> ''", ['param-value']);
      sockets[0]!.emit('data', strayCommandComplete());
      expect([...await sql.unsafe('SELECT 9 AS n')] as unknown[]).toEqual([{ n: 9 }]);
    } finally {
      console.warn = warn;
      await sql.end({ timeout: 1 });
    }
    const desync = lines.filter(l => l.includes('pg_connection_desync'));
    expect(desync).toHaveLength(1);
    expect(desync[0]).toMatch(/^\[gbrain\] warn code=pg_connection_desync pool=direct message=C connection=\d+ sql=SELECT_pg_class /);
    expect(desync[0]).not.toContain('literal-text');
    expect(desync[0]).not.toContain('param-value');
    expect(desync[0]).not.toContain('relname');
    expect(counter.desyncCount).toBe(1);
  }, 30_000);
});
