/**
 * GBRA-156: one search or query op holds at most SEARCH_CONNECTION_LIMIT (4)
 * pooled connections at once. The op starts its independent reads together to
 * save round trips; the per-op budget (src/core/search/connection-budget.ts)
 * keeps a burst of searches from each taking the whole read pool.
 *
 * Connections are counted at the wire: every engine connection goes through
 * an in-process proxy that adds a few milliseconds each way (so overlapping
 * reads actually overlap) and marks a connection busy from the first byte the
 * client sends until Postgres answers ReadyForQuery with status idle. A
 * connection inside a transaction (status T) stays busy, so a read
 * transaction counts until its COMMIT settles.
 *
 * Regression that fails it: without the budget, ten concurrent reads hold ten
 * connections and a search holds more than four.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, connect as netConnect, type Server, type Socket } from 'node:net';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { SEARCH_CONNECTION_LIMIT, withSearchConnectionBudget } from '../../src/core/search/connection-budget.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { seedPage } from '../helpers/keyword-paging-fixture.ts';

const DELAY_MS = 4;
const POOL_SIZE = 10;

function busyProxy(target: URL) {
  const busy = new Set<number>();
  let peak = 0, ids = 0;
  const server: Server = createServer((client: Socket) => {
    const id = ++ids;
    const upstream = netConnect(Number(target.port || 5432), target.hostname);
    let started = false, carry = Buffer.alloc(0);
    client.on('data', (chunk: Buffer) => {
      if (started) { busy.add(id); peak = Math.max(peak, busy.size); }
      started = true;
      setTimeout(() => upstream.write(chunk), DELAY_MS);
    });
    upstream.on('data', (chunk: Buffer) => {
      let buf = Buffer.concat([carry, chunk]);
      while (buf.length >= 5) {
        const length = buf.readInt32BE(1);
        if (buf.length < length + 1) break;
        if (buf[0] === 0x5a && buf[5] === 0x49) setTimeout(() => busy.delete(id), DELAY_MS);
        buf = buf.subarray(length + 1);
      }
      carry = buf;
      setTimeout(() => client.write(chunk), DELAY_MS);
    });
    const end = () => { busy.delete(id); client.destroy(); upstream.destroy(); };
    client.on('close', end); upstream.on('close', end);
    client.on('error', () => undefined); upstream.on('error', () => undefined);
  });
  return {
    server,
    listen: () => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))),
    reset() { peak = busy.size; },
    get peak() { return peak; },
  };
}

const run = process.env.DATABASE_URL ? describe : describe.skip;
let close: () => Promise<void> = async () => {};
let engine: PostgresEngine;
let proxy: ReturnType<typeof busyProxy>;

run('per-search connection budget on Postgres', () => {
  beforeAll(async () => {
    const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    for (let i = 0; i < 12; i++) await seedPage(isolated.engine, `notes/orbital-ledger-${i}`, `Orbital ledger entry ${i}: the quasar survey moved to week ${i}.`, { title: `Orbital Ledger ${i}` });
    await isolated.engine.disconnect();
    proxy = busyProxy(new URL(isolated.databaseUrl));
    const port = await proxy.listen();
    const url = new URL(isolated.databaseUrl);
    url.hostname = '127.0.0.1'; url.port = String(port);
    engine = new PostgresEngine();
    await engine.connect({ database_url: url.toString(), poolSize: POOL_SIZE });
    close = async () => { await engine.disconnect(); proxy.server.close(); await isolated.close(); };
    await Promise.all(Array.from({ length: POOL_SIZE }, () => engine.executeRaw('SELECT 1')));
  }, 300_000);

  afterAll(async () => { await close(); });

  const reads = () => Array.from({ length: POOL_SIZE }, (_, i) => i % 2
    ? engine.executeRaw('SELECT pg_sleep(0.05)')
    : engine.transaction(async tx => { await tx.executeRaw('SELECT pg_sleep(0.05)'); await tx.executeRaw('SELECT 1'); }));

  test('outside a budget, concurrent reads use the whole pool', async () => {
    proxy.reset();
    await Promise.all(reads());
    expect(proxy.peak).toBe(POOL_SIZE);
  });

  test('inside a budget, the same reads hold at most the limit', async () => {
    proxy.reset();
    await withSearchConnectionBudget(() => Promise.all(reads()));
    expect(SEARCH_CONNECTION_LIMIT).toBe(4);
    expect(proxy.peak).toBe(SEARCH_CONNECTION_LIMIT);
  });

  for (const op of ['search', 'query'] as const) {
    test(`a ${op} op holds at most 4 connections at once`, async () => {
      await dispatchToolCall(engine, op, { query: 'quasar survey' }, { remote: false });
      proxy.reset();
      const result = await dispatchToolCall(engine, op, { query: 'quasar survey' }, { remote: false });
      expect(result.isError, JSON.stringify(result).slice(0, 2000)).toBeFalsy();
      expect(JSON.stringify(result)).toContain('orbital-ledger');
      console.log(`[connection-budget] ${op} peak ${proxy.peak}`);
      expect(proxy.peak).toBeGreaterThan(1);
      expect(proxy.peak).toBeLessThanOrEqual(4);
    }, 60_000);
  }
});
