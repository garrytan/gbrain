/**
 * #9540 follow-up (reported and first fixed in #9624). While PostgreSQL shuts down it refuses new connections with
 * SQLSTATE 57P03 ("the database system is shutting down"), and once a TCP server has stopped a connect fails with
 * ECONNREFUSED. Neither was a lost connection to the worker's claim loop, which rethrew and exited. Both errors here are
 * the real ones postgres.js raises: 57P03 from a wire peer that refuses startup the way a shutting-down server does,
 * ECONNREFUSED from a port nothing listens on.
 */
import { afterAll, expect, test } from 'bun:test';
import { createServer } from 'net';
import postgres from '#postgres';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isRetryableConnError, isServerRefusingConnections } from '../src/core/retry-matcher.ts';

const refusing = createServer(socket => {
  socket.on('error', () => {});
  socket.once('data', () => {
    const fields = Buffer.from('SFATAL\0C57P03\0Mthe database system is shutting down\0\0');
    const head = Buffer.alloc(5);
    head.write('E', 0);
    head.writeInt32BE(fields.length + 4, 1);
    socket.end(Buffer.concat([head, fields]));
  });
});
await new Promise<void>(resolve => refusing.listen(0, '127.0.0.1', resolve));
afterAll(() => new Promise(resolve => refusing.close(resolve)));

async function driverError(port: number): Promise<unknown> {
  const sql = postgres({ host: '127.0.0.1', port, user: 'u', database: 'd', ssl: false, max: 1, fetch_types: false, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select 1`;
    throw new Error('expected the connect to fail');
  } catch (error) {
    return error;
  } finally {
    await sql.end({ timeout: 0 });
  }
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function pollAfterClaimError(error: unknown): Promise<string[]> {
  const events: string[] = [];
  const engine = {
    kind: 'postgres',
    executeRaw: async (sql: string) => {
      if (sql.trim() === 'SELECT 1') return [];
      if (sql.includes('SELECT id, submission_authority FROM minion_jobs') && sql.includes('submission_authority IS DISTINCT FROM')) return [];
      throw new Error('Unexpected SQL in worker refusal fixture');
    },
    reconnect: async () => { events.push('reconnect'); },
  } as unknown as BrainEngine;
  const worker = new MinionWorker(engine, { pollInterval: 1, stalledInterval: 60_000, healthCheckInterval: 0 });
  worker.register('noop', async () => ({}));
  let claims = 0;
  (worker as unknown as { queue: Record<string, unknown> }).queue = {
    ensureSchema: async () => {},
    hasOverdueWatchdogSuspect: async () => false,
    promoteDelayed: async () => [],
    claim: async () => {
      claims += 1;
      events.push('claim');
      if (claims === 1) throw error;
      worker.stop();
      return null;
    },
    handleStalled: async () => ({ requeued: [], dead: [] }),
    handleTimeouts: async () => [],
    handleWallClockTimeouts: async () => [],
  };
  const origError = console.error;
  console.error = () => {};
  try {
    await worker.start();
  } finally {
    console.error = origError;
  }
  return events;
}

test('a server that is shutting down (57P03) or has stopped (ECONNREFUSED) is recognised; other refusals are not', async () => {
  const shuttingDown = await driverError((refusing.address() as { port: number }).port);
  const stopped = await driverError(await freePort());
  expect(shuttingDown).toMatchObject({ code: '57P03' });
  expect(stopped).toMatchObject({ code: 'ECONNREFUSED', syscall: 'connect' });
  for (const error of [shuttingDown, stopped]) {
    expect(isServerRefusingConnections(error)).toBe(true);
    expect(isRetryableConnError(error)).toBe(false);
  }
  expect(isServerRefusingConnections(Object.assign(new Error('permission denied for table minion_jobs'), { code: '42501' }))).toBe(false);
  expect(isServerRefusingConnections(Object.assign(new Error('connect ECONNREFUSED /tmp/agent.sock'), { code: 'ECONNREFUSED', syscall: 'write' }))).toBe(false);
});

test('the worker reconnects and keeps polling when a claim meets a server that is shutting down or stopped', async () => {
  for (const error of [await driverError((refusing.address() as { port: number }).port), await driverError(await freePort())]) {
    expect(await pollAfterClaimError(error)).toEqual(['claim', 'reconnect', 'claim']);
  }
});
