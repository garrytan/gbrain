/**
 * Protects: a `connect_timeout` written into a pool's URL is the timer that
 * pool connects under, for all four postgres() pools (module singleton,
 * PostgresEngine instance pool, ConnectionManager read and direct pools).
 *
 * Regression it catches: a call site passing a fixed `connect_timeout`
 * again. postgres.js lets an explicit option beat the URL query, so the URL
 * value silently stops mattering and a slow-to-wake server fails at 10s.
 *
 * Why not covered elsewhere: test/db-pool-max-lifetime.test.ts pins a
 * different option and reads no URL.
 *
 * DB-free. Pools dial a local "tarpit" that accepts TCP and never speaks the
 * Postgres protocol, so a connect can only end by its own timer or by the
 * test closing the socket. Postgres-side coverage:
 * test/e2e/db-connect-timeout.test.ts.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createServer, type AddressInfo, type Server, type Socket } from 'net';
import * as db from '../src/core/db.ts';
import { ConnectionManager } from '../src/core/connection-manager.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const CREDENTIALED = 'postgres://reader:hunter2@pg.example.invalid:5432/brain';
const TIMER_CEILING_S = 2147483;

describe('resolveUrlConnectTimeout', () => {
  test.each([
    ['no query at all', CREDENTIALED, 10],
    ['other parameters only', `${CREDENTIALED}?sslmode=require&application_name=x`, 10],
    ['a plain value', `${CREDENTIALED}?connect_timeout=30`, 30],
    ['a value among other parameters', `${CREDENTIALED}?sslmode=require&connect_timeout=45&prepare=false`, 45],
    ['the postgresql scheme', 'postgresql://reader@pg.example.invalid/brain?connect_timeout=4', 4],
    ['a multi-host URL', 'postgres://reader@pg-a.example.invalid:5432,pg-b.example.invalid:5433/brain?connect_timeout=12', 12],
    ['surrounding blanks', `${CREDENTIALED}?connect_timeout=%2020%20`, 20],
    ['a value past the runtime timer limit is capped', `${CREDENTIALED}?connect_timeout=99999999`, TIMER_CEILING_S],
    ['exactly the timer limit', `${CREDENTIALED}?connect_timeout=${TIMER_CEILING_S}`, TIMER_CEILING_S],
  ])('%s', (_label, url, expected) => {
    expect(db.resolveUrlConnectTimeout(url)).toBe(expected);
  });

  test.each([
    ['zero (postgres.js would arm no timer)', '0'],
    ['negative', '-3'],
    ['fractional', '1.5'],
    ['exponent notation', '3e1'],
    ['hex', '0x1e'],
    ['words', 'soon'],
    ['empty', ''],
  ])('%s keeps the 10s fallback', (_label, raw) => {
    expect(db.resolveUrlConnectTimeout(`${CREDENTIALED}?connect_timeout=${raw}`)).toBe(10);
  });

  test('text outside the query is never read as the parameter', () => {
    expect(db.resolveUrlConnectTimeout('postgres://reader:connect_timeout%3D3@pg.example.invalid/brain')).toBe(10);
    expect(db.resolveUrlConnectTimeout(`${CREDENTIALED}#connect_timeout=3`)).toBe(10);
    expect(db.resolveUrlConnectTimeout(`${CREDENTIALED}?sslmode=disable#connect_timeout=3`)).toBe(10);
    expect(db.resolveUrlConnectTimeout('definitely not a url')).toBe(10);
  });
});

interface Tarpit { url: string; shut(): Promise<void> }

async function openTarpit(): Promise<Tarpit> {
  const sockets = new Set<Socket>();
  const server: Server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `postgres://tarpit@127.0.0.1:${port}/brain`,
    async shut() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

const timerOf = (pool: unknown): unknown => (pool as { options: Record<string, unknown> }).options.connect_timeout;
const outcomeWithin = (work: Promise<unknown>, ms: number) =>
  Promise.race([
    work.then(() => 'resolved', (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`),
    new Promise<string>(resolve => setTimeout(resolve, ms, 'still waiting')),
  ]);

let tarpit: Tarpit;
let inFlight: Promise<unknown>[];
let teardown: (() => Promise<unknown>)[];
let stderr: ReturnType<typeof spyOn<Console, 'error'>>;
const track = <T>(work: Promise<T>): Promise<T> => { inFlight.push(work.catch(() => undefined)); return work; };

beforeEach(async () => {
  tarpit = await openTarpit();
  inFlight = [];
  teardown = [];
  stderr = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await tarpit.shut();
  for (const step of teardown.reverse()) await step();
  await db.disconnect();
  await Promise.all(inFlight);
  stderr.mockRestore();
});

describe('each pool connects under its own URL timer', () => {
  test('module singleton: a 1s URL timer ends the connect with CONNECT_TIMEOUT', async () => {
    const started = Date.now();
    const outcome = await outcomeWithin(track(db.connect({ database_url: `${tarpit.url}?connect_timeout=1` })), 6_000);
    expect(outcome).toContain('CONNECT_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(6_000);
  });

  test('module singleton without the parameter is still waiting when the 1s case has long given up', async () => {
    const outcome = await outcomeWithin(track(db.connect({ database_url: tarpit.url })), 2_500);
    expect(outcome).toBe('still waiting');
    expect(timerOf(db.getConnection())).toBe(10);
  });

  test('PostgresEngine instance pool', async () => {
    const engine = new PostgresEngine();
    teardown.push(() => engine.disconnect());
    track(engine.connect({ database_url: `${tarpit.url}?connect_timeout=41`, poolSize: 1 }));
    expect(timerOf(engine.sql)).toBe(41);
  });

  test('ConnectionManager read pool takes its URL value; a bare URL keeps 10s', async () => {
    const tuned = new ConnectionManager({ url: `${tarpit.url}?connect_timeout=41` });
    const bare = new ConnectionManager({ url: tarpit.url });
    teardown.push(() => tuned.disconnect(), () => bare.disconnect());
    expect(timerOf(await tuned.getReadPool())).toBe(41);
    expect(timerOf(await bare.getReadPool())).toBe(10);
  });

  test('ConnectionManager direct pool gives up on its own URL timer and falls back to the read pool', async () => {
    const cm = new ConnectionManager({
      url: `${tarpit.url}?connect_timeout=41`,
      directUrl: `${tarpit.url}?connect_timeout=1`,
    });
    teardown.push(() => cm.disconnect());
    const started = Date.now();
    const pool = await track(cm.ddl());
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(cm.isKillSwitchActive()).toBe(true);
    expect(timerOf(pool)).toBe(41);
    expect(stderr.mock.calls.flat().join(' ')).toContain('CONNECT_TIMEOUT');
  });

  test('the read pool\'s short timer does not leak into the direct pool', async () => {
    const cm = new ConnectionManager({
      url: `${tarpit.url}?connect_timeout=1`,
      directUrl: tarpit.url,
    });
    teardown.push(() => cm.disconnect());
    expect(timerOf(await cm.getReadPool())).toBe(1);
    expect(await outcomeWithin(track(cm.ddl()), 2_500)).toBe('still waiting');
  });
});
