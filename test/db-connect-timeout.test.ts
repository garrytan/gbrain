/**
 * `?connect_timeout=N` in `database_url` reaches postgres.js at every
 * postgres() call site.
 *
 * postgres.js gives an explicit option precedence over the URL query
 * (`parseOptions`: `k in o ? o[k] : k in query ? ...`), so the bare
 * `connect_timeout: 10` each pool passed silently discarded the URL's value:
 * a brain whose URL asked for 30s still gave up at 10s with
 * `write CONNECT_TIMEOUT`.
 *
 * DB-free. The resolver cases are pure. The wiring cases build REAL pools that
 * dial a local TCP endpoint which accepts connections and never answers the
 * Postgres handshake (the seam test/postgres-engine-singleton-lifecycle.test.ts
 * uses), so a connect stays in flight until the endpoint refuses it or the
 * connect timer fires.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createServer, type AddressInfo, type Socket } from 'net';
import * as db from '../src/core/db.ts';
import { ConnectionManager } from '../src/core/connection-manager.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const BASE = 'postgres://user:secret@db.example.test:5432/gbrain';

describe('resolveConnectTimeoutSeconds', () => {
  test('a URL without the parameter keeps the 10s default', () => {
    expect(db.resolveConnectTimeoutSeconds(BASE)).toBe(10);
    expect(db.resolveConnectTimeoutSeconds(`${BASE}?sslmode=require`)).toBe(10);
  });

  test('a positive integer in the URL wins, beside other parameters and on either scheme', () => {
    expect(db.resolveConnectTimeoutSeconds(`${BASE}?sslmode=require&connect_timeout=30`)).toBe(30);
    expect(db.resolveConnectTimeoutSeconds(`${BASE}?connect_timeout=45&prepare=false`)).toBe(45);
    expect(db.resolveConnectTimeoutSeconds('postgresql://u:p@h:6543/d?connect_timeout=3')).toBe(3);
  });

  test.each([
    ['0', 'postgres.js reads 0 as no connect timer at all'],
    ['-5', 'not a duration'],
    ['2.5', 'libpq defines the parameter in whole seconds'],
    ['abc', 'not a number'],
    ['', 'empty'],
  ])('connect_timeout=%p falls back to the default (%s)', (raw) => {
    expect(db.resolveConnectTimeoutSeconds(`${BASE}?connect_timeout=${raw}`)).toBe(10);
  });

  test('an unparseable URL falls back to the default', () => {
    expect(db.resolveConnectTimeoutSeconds('not a url')).toBe(10);
  });
});

function fatal(): Buffer {
  const body = Buffer.from('SFATAL\0C57P01\0Mtest endpoint refused\0\0');
  const head = Buffer.alloc(5);
  head.write('E', 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

async function openSilentEndpoint() {
  const held: Socket[] = [];
  let refusing = false;
  const server = createServer(socket => {
    held.push(socket);
    socket.on('data', () => { if (refusing && !socket.writableEnded) socket.end(fatal()); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `postgres://user@127.0.0.1:${(server.address() as AddressInfo).port}/gbrain`,
    refuse() { refusing = true; for (const socket of held.splice(0)) socket.end(fatal()); },
    close() { server.close(); },
  };
}

const connectTimeoutOf = (pool: unknown) =>
  (pool as { options: { connect_timeout: unknown } }).options.connect_timeout;

let endpoint: Awaited<ReturnType<typeof openSilentEndpoint>>;
let pending: Promise<unknown>[] = [];
let cleanups: (() => Promise<void>)[] = [];
const settle = <T>(p: Promise<T>) => { const s = p.catch(e => e); pending.push(s); return s; };

beforeEach(async () => {
  endpoint = await openSilentEndpoint();
});

afterEach(async () => {
  endpoint.refuse();
  await Promise.all(pending);
  pending = [];
  for (const cleanup of cleanups.splice(0)) await cleanup();
  await db.disconnect();
  endpoint.close();
});

describe('the URL connect_timeout reaches every pool', () => {
  test('module singleton (db.connect)', async () => {
    settle(db.connect({ database_url: `${endpoint.url}?connect_timeout=37` }));
    expect(connectTimeoutOf(db.getConnection())).toBe(37);
  });

  test('engine instance pool (the per-worker pool import and sync open)', async () => {
    const engine = new PostgresEngine();
    cleanups.push(() => engine.disconnect());
    settle(engine.connect({ database_url: `${endpoint.url}?connect_timeout=37`, poolSize: 1 }));
    expect(connectTimeoutOf(engine.sql)).toBe(37);
  });

  test('ConnectionManager read pool, and the 10s default when the URL has none', async () => {
    const tuned = await new ConnectionManager({ url: `${endpoint.url}?connect_timeout=37` }).getReadPool();
    const plain = await new ConnectionManager({ url: endpoint.url }).getReadPool();
    cleanups.push(() => db.endPoolBounded(tuned), () => db.endPoolBounded(plain));
    expect(connectTimeoutOf(tuned)).toBe(37);
    expect(connectTimeoutOf(plain)).toBe(10);
  });

  test('ConnectionManager direct pool gives up at the URL value, not at 10s', async () => {
    const errors: string[] = [];
    const errSpy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.join(' ')); });
    const cm = new ConnectionManager({
      url: 'postgresql://user@127.0.0.1:5/never-connected',
      directUrl: `${endpoint.url}?connect_timeout=1`,
    });
    cleanups.push(() => cm.disconnect());
    try {
      const started = Date.now();
      // The direct probe never completes; its connect timer is the only way out,
      // and the unreachable-direct fallback then hands back the read pool.
      await cm.ddl();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(cm.isKillSwitchActive()).toBe(true);
      expect(errors.join('\n')).toContain('CONNECT_TIMEOUT');
    } finally {
      errSpy.mockRestore();
    }
  });
});
