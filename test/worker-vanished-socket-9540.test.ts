/**
 * #9540: after PostgreSQL shuts down, its local Unix socket file is gone and the driver's next connect fails with
 * `connect ENOENT <dir>/.s.PGSQL.<port>`. The worker's claim must treat that as a lost connection (reconnect, retry on
 * the next tick) instead of rethrowing it and exiting. The error is the real one postgres.js raises for a socket
 * directory with no server in it.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import postgres from '#postgres';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isRetryableConnError, isVanishedSocketError } from '../src/core/retry-matcher.ts';

const socketDir = mkdtempSync(join(tmpdir(), 'gbrain-no-pg-'));
afterAll(() => rmSync(socketDir, { recursive: true, force: true }));

async function vanishedSocketError(): Promise<unknown> {
  const sql = postgres({ host: socketDir, database: 'brain', max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    await sql`select 1`;
    throw new Error('expected the connect to fail');
  } catch (error) {
    return error;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

test('a connect to a vanished Unix socket is recognised; a missing file is not, and first connects still fail fast', async () => {
  const error = await vanishedSocketError();
  expect(error).toMatchObject({ code: 'ENOENT', syscall: 'connect' });
  expect(isVanishedSocketError(error)).toBe(true);
  expect(isRetryableConnError(error)).toBe(false);
  expect(isVanishedSocketError(Object.assign(new Error("ENOENT: no such file or directory, open 'notes/a.md'"), { code: 'ENOENT', syscall: 'open' }))).toBe(false);
});

test('the worker reconnects and keeps polling when a claim finds the socket gone', async () => {
  const error = await vanishedSocketError();
  const events: string[] = [];
  const engine = {
    kind: 'postgres',
    executeRaw: async (sql: string) => {
      if (sql.trim() === 'SELECT 1') return [];
      if (sql.includes('SELECT id, submission_authority FROM minion_jobs') && sql.includes('submission_authority IS DISTINCT FROM')) return [];
      throw new Error('Unexpected SQL in worker socket fixture');
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
  expect(events).toEqual(['claim', 'reconnect', 'claim']);
});
