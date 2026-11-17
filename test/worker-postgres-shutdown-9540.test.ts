import { describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Exercise the real polling loop; only the queue/engine I/O is scripted. A claim
// failure must return to the next tick, never repeat an uncertain claim inline.
async function poll(error: unknown, busy: false | 'running' | 'settling' = false, legacy = false, site: 'claim' | 'promote' = 'claim') {
  const events: string[] = [];
  const engine = {
    kind: 'postgres',
    executeRaw: async (sql: string) => {
      if (sql.trim() === 'SELECT 1' || sql.includes('SELECT id, submission_authority FROM minion_jobs')) return [];
      throw new Error('Unexpected SQL in shutdown fixture');
    },
    reconnect: async () => { events.push('reconnect'); },
  } as unknown as BrainEngine;
  const worker = new MinionWorker(engine, { pollInterval: 1, stalledInterval: 60_000, healthCheckInterval: 0 });
  worker.register('noop', async () => ({ ok: true }));
  // executions outlives the scheduling slot when a handler is being settled.
  const internals = worker as unknown as { queue: unknown; executions: Map<string, unknown> };
  if (busy) internals.executions.set('owned', { stopped: busy === 'settling' });
  let claims = 0;
  let promotions = 0;
  internals.queue = {
    ensureSchema: async () => {},
    hasOverdueWatchdogSuspect: async () => false,
    promoteDelayed: async () => {
      if (site === 'promote' && ++promotions === 1) { events.push('promote'); throw error; }
      return [];
    },
    claim: async () => {
      events.push('claim');
      if (++claims === 1 && site === 'claim') throw error;
      if (busy && !legacy && claims === 2) {
        internals.executions.clear();
        throw error;
      }
      worker.stop();
      return null;
    },
    handleStalled: async () => ({ requeued: [], dead: [] }),
    handleTimeouts: async () => [],
    handleWallClockTimeouts: async () => [],
  };
  try { await worker.start(); } finally { worker.stop(); internals.executions.clear(); }
  return events;
}

const shutdown = (code: string) => Object.assign(new Error('database unavailable'), { code });
const missingSocket = () => Object.assign(new Error('connect ENOENT /synthetic/.s.PGSQL.5432'), {
  code: 'ENOENT', syscall: 'connect', address: '/synthetic/.s.PGSQL.5432',
});

describe('#9540 worker PostgreSQL shutdown recovery', () => {
  for (const code of ['57P01', '57P02', '57P03']) test(`claim survives PostgreSQL ${code} and retries on the next tick`, async () => {
    expect(await poll(shutdown(code))).toEqual(['claim', 'reconnect', 'claim']);
  });

  for (const error of [shutdown('57P02'), missingSocket()]) test(`promotion recovers before claiming (${error.code})`, async () => {
    expect(await poll(error, false, false, 'promote')).toEqual(['promote', 'reconnect', 'claim']);
  });

  test.skipIf(process.platform === 'win32')('the real postgres driver missing-socket error does not terminate the poll loop', async () => {
    const sql = postgres({ host: `/gbrain-missing-socket-${crypto.randomUUID()}`, database: 'gbrain_test', username: 'postgres', connect_timeout: 1 });
    let error: unknown;
    try { await sql`SELECT 1`; } catch (caught) { error = caught; } finally { await sql.end({ timeout: 0 }); }
    expect(error).toMatchObject({ code: 'ENOENT', syscall: 'connect' });
    expect(await poll(error)).toEqual(['claim', 'reconnect', 'claim']);
  });

  for (const state of ['running', 'settling'] as const) for (const error of [shutdown('57P01'), missingSocket()]) test(`does not replace the pool while an owned execution is ${state} (${error.code})`, async () => {
    expect(await poll(error, state)).toEqual(['claim', 'claim', 'reconnect', 'claim']);
  });

  test('existing connection-error recovery is unchanged', async () => {
    expect(await poll(shutdown('CONNECTION_ENDED'), 'running', true)).toEqual(['claim', 'reconnect', 'claim']);
  });

  for (const error of [
    Object.assign(new Error('missing input'), { code: 'ENOENT', syscall: 'open', path: '/synthetic/.s.PGSQL.5432' }),
    Object.assign(new Error('missing ordinary socket'), { code: 'ENOENT', syscall: 'connect', address: '/synthetic/worker.sock' }),
    Object.assign(new Error('unverified missing socket'), { code: 'ENOENT', address: '/synthetic/.s.PGSQL.5432' }),
    shutdown('57014'), shutdown('55P03'), shutdown('42601'),
  ]) test(`unrelated failure still rejects (${error.message}/${error.code})`, async () => {
    await expect(poll(error)).rejects.toBe(error);
  });
});
