/**
 * Module-singleton lifecycle races in `src/core/db.ts` and
 * `src/core/postgres-engine.ts` (#1471, #1745), driven DB-free: the pools
 * dial a local TCP endpoint that accepts connections and never answers the
 * Postgres handshake, so each `SELECT 1` stays pending until the test makes
 * the endpoint answer with a FATAL error. That holds a connect "in flight"
 * for as long as a case needs.
 *
 * The live owner/borrower lifecycle against real Postgres is owned by
 * test/e2e/postgres-engine-disconnect-idempotency.test.ts,
 * test/e2e/db-singleton-shared-recovery.test.ts and
 * test/e2e/postgres-reconnect-singleton.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type AddressInfo, type Socket } from 'net';
import * as db from '../src/core/db.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

function fatal(): Buffer {
  const body = Buffer.from('SFATAL\0C57P01\0Mtest endpoint refused\0\0');
  const head = Buffer.alloc(5);
  head.write('E', 0);
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

async function openEndpoint() {
  const held: Socket[] = [];
  let refusing = false;
  let dials = 0;
  const server = createServer(socket => {
    dials++;
    held.push(socket);
    socket.on('data', () => { if (refusing) socket.end(fatal()); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `postgres://user@127.0.0.1:${(server.address() as AddressInfo).port}/gbrain`,
    dials: () => dials,
    refuse() { refusing = true; for (const socket of held.splice(0)) socket.end(fatal()); },
    hold() { refusing = false; },
    close() { server.close(); },
  };
}

let endpoint: Awaited<ReturnType<typeof openEndpoint>>;
let url: string;
let pending: Promise<unknown>[] = [];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const settle = <T>(p: Promise<T>) => { const s = p.catch(e => e); pending.push(s); return s; };
const within = <T>(p: Promise<T>, ms = 500) => Promise.race([p.then(() => 'resolved'), sleep(ms).then(() => 'pending')]);

async function dialedAfterSettling(): Promise<number> {
  await sleep(150);
  return endpoint.dials();
}

beforeEach(async () => {
  endpoint = await openEndpoint();
  url = endpoint.url;
});

afterEach(async () => {
  endpoint.refuse();
  await Promise.all(pending);
  pending = [];
  await db.disconnect();
  endpoint.close();
});

describe('module-singleton ownership under concurrent connects', () => {
  test('an engine that joins an in-flight create is a borrower: one pool is dialed and its disconnect leaves it', async () => {
    const owner = new PostgresEngine();
    const borrower = new PostgresEngine();

    settle(owner.connect({ database_url: url }));
    const borrowerConnect = settle(borrower.connect({ database_url: url }));

    expect(await within(borrowerConnect)).toBe('resolved');
    const pool = db.getConnection();
    await borrower.disconnect();

    expect(db.getConnection()).toBe(pool);
    expect(await dialedAfterSettling()).toBe(1);
  });
});

describe('db.disconnect()', () => {
  test('detaches the singleton before awaiting end(), so a concurrent connect builds a fresh pool', async () => {
    settle(db.connect({ database_url: url }));
    const closing = db.getConnection();
    let endStarted!: () => void;
    const started = new Promise<void>(resolve => { endStarted = resolve; });
    let finishEnd!: () => void;
    Object.assign(closing, { end: () => { endStarted(); return new Promise<void>(resolve => { finishEnd = resolve; }); } });

    const disconnecting = db.disconnect();
    try {
      await started;
      const reconnect = settle(db.connect({ database_url: url }));

      expect(db.getConnection()).not.toBe(closing);
      expect(await within(reconnect, 50)).toBe('pending');
    } finally {
      finishEnd();
      await disconnecting;
    }
  });
});

describe('instance-pool reconnect()', () => {
  test('a reconnect during a running rebuild returns at once, and the next one after it settles rebuilds again', async () => {
    const engine = new PostgresEngine();
    const livePool = { end: async () => {} };
    Object.assign(engine as unknown as Record<string, unknown>, {
      _savedConfig: { database_url: url, poolSize: 1 },
      _connectionStyle: 'instance',
      _sql: livePool,
    });

    const first = settle(engine.reconnect());
    expect(await within(engine.reconnect())).toBe('resolved');
    expect(await dialedAfterSettling()).toBe(1);

    endpoint.refuse();
    expect(await first).toBeInstanceOf(Error);
    endpoint.hold();

    settle(engine.reconnect());
    expect(await dialedAfterSettling()).toBe(2);
  });
});
