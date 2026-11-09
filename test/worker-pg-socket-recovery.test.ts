import { describe, expect, test } from 'bun:test';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function missingSocket(): Error {
  return Object.assign(new Error('connect ENOENT /tmp/pg/.s.PGSQL.55479'), { code: 'ENOENT', syscall: 'connect' });
}
function fixture() {
  const events: string[] = [];
  const engine = {
    kind: 'postgres',
    executeRaw: async (sql: string) => {
      if (sql.trim() === 'SELECT 1' || (sql.includes('SELECT id, submission_authority FROM minion_jobs') && sql.includes('submission_authority IS DISTINCT FROM'))) return [];
      throw new Error('Unexpected SQL');
    },
    reconnect: async () => { events.push('reconnect'); },
  } as unknown as BrainEngine;
  const worker = new MinionWorker(engine, { pollInterval: 1, stalledInterval: 60_000, healthCheckInterval: 0 });
  worker.register('noop', async () => ({}));
  const queue = {
    ensureSchema: async () => {}, promoteDelayed: async (): Promise<unknown[]> => [],
    claim: async (): Promise<null> => { worker.stop(); return null; },
    handleStalled: async () => ({ requeued: [], dead: [] }),
    handleTimeouts: async () => [], handleWallClockTimeouts: async () => [],
  };
  (worker as unknown as {queue: typeof queue}).queue = queue;
  return { worker, queue, events };
}

describe('worker PostgreSQL outage recovery', () => {
  test('reconnects after missing socket during delayed promotion', async () => {
    const {worker, queue, events} = fixture();
    queue.promoteDelayed = async () => { events.push('promote'); throw missingSocket(); };
    queue.claim = async () => { events.push('claim'); worker.stop(); return null; };
    await worker.start();
    expect(events).toEqual(['promote', 'reconnect', 'claim']);
  });
  test('on missing socket while claiming, reconnects then claims on a later poll', async () => {
    const {worker, queue, events} = fixture();
    queue.claim = async () => { events.push('claim'); if (events.filter(x => x === 'claim').length === 1) throw missingSocket(); worker.stop(); return null; };
    await worker.start();
    expect(events).toEqual(['claim', 'reconnect', 'claim']);
  });
  test('handles PostgreSQL shutdown during claim on the same next-poll path', async () => {
    const { worker, queue, events } = fixture();
    queue.claim = async () => {
      events.push('claim');
      if (events.length === 1) {
        throw Object.assign(new Error('the database system is shutting down'), { code: '57P03' });
      }
      worker.stop();
      return null;
    };
    await worker.start();
    expect(events).toEqual(['claim', 'reconnect', 'claim']);
  });
  test('does not tear down the pool while an evicted handler is still settling', async () => {
    const { worker, queue, events } = fixture();
    const executions = (worker as unknown as { executions: Map<string, unknown> }).executions;
    let polls = 0;
    queue.promoteDelayed = async () => {
      polls++;
      if (polls === 1) {
        executions.set('evicted-handler', {});
        throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
      }
      executions.clear();
      return [];
    };
    queue.claim = async () => {
      if (polls === 2) worker.stop();
      return null;
    };
    await worker.start();
    expect(polls).toBe(2);
    expect(events).toEqual([]);
  });
  test('ordinary missing files still propagate out of claim', async () => {
    const {worker, queue, events} = fixture();
    queue.claim = async () => { throw Object.assign(new Error('open ENOENT /tmp/missing-file'), {code:'ENOENT'}); };
    await expect(worker.start()).rejects.toThrow('open ENOENT');
    expect(events).toEqual([]);
  });
  test('statement and lock timeouts remain non-retryable even with connection text', async () => {
    for (const code of ['57014', '55P03']) {
      const { worker, queue, events } = fixture();
      queue.claim = async () => {
        throw Object.assign(new Error('terminating connection due to administrator command'), { code });
      };
      await expect(worker.start()).rejects.toThrow('administrator command');
      expect(events).toEqual([]);
    }
  });
  test('missing syscall, unrelated sockets and non-Postgres remain non-retryable', async () => {
    const cases = [
      { error: Object.assign(new Error('connect ENOENT /tmp/pg/.s.PGSQL.55479'), { code: 'ENOENT' }), kind: 'postgres' },
      { error: Object.assign(new Error('connect ENOENT /tmp/other.sock'), { code: 'ENOENT', syscall: 'connect' }), kind: 'postgres' },
      { error: Object.assign(new Error('open ENOENT /tmp/pg/.s.PGSQL.55479'), { code: 'ENOENT', syscall: 'open' }), kind: 'postgres' },
      { error: missingSocket(), kind: 'pglite' },
      { error: Object.assign(new Error('wrapped connection error'), {cause: missingSocket()}), kind: 'postgres' },
    ];
    for (const c of cases) {
      const {worker, queue, events} = fixture();
      (worker as unknown as {engine: {kind: string}}).engine.kind = c.kind;
      queue.claim = async () => { throw c.error; };
      await expect(worker.start()).rejects.toThrow(c.error.message);
      expect(events).toEqual([]);
    }
  });

  test('a wrapped or ambiguous error after a possible claim does not get the new socket retry', async () => {
    const {worker, queue, events} = fixture();
    let calls = 0;
    queue.claim = async () => {
      calls++;
      const err = Object.assign(new Error('connect ENOENT /tmp/pg/.s.PGSQL.55479'), {code: 'ENOENT'});
      throw err; // no syscall: execution stage cannot be proven
    };
    await expect(worker.start()).rejects.toThrow('ENOENT');
    expect(calls).toBe(1);
    expect(events).toEqual([]);
  });

});
