import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

describe('short control transactions and resident shutdown', () => {
  test.each([true, false])('direct transaction uses the configured route (dual=%s) and never escapes a nested transaction', async dual => {
    const calls: string[] = [];
    function session(name: string): any {
      return Object.assign(() => Promise.resolve([]), {
        unsafe: async () => { calls.push(`${name}:query`); return []; },
        savepoint: async (fn: (tx: any) => Promise<unknown>) => { calls.push(`${name}:savepoint`); return fn(session(name)); },
      });
    }
    function pool(name: string): any {
      return Object.assign(session(name), {
        begin: async (fn: (tx: any) => Promise<unknown>) => { calls.push(`${name}:begin`); return fn(session(name)); },
      });
    }
    const engine = new PostgresEngine(), read = pool('read'), direct = pool('direct');
    Object.assign(engine, { _sql: read, connectionManager: {
      isDualPoolActive: () => dual, peekReadPool: () => read, ddl: async () => direct,
    } });
    await engine.transactionDirect(async tx => {
      await tx.executeRawDirect('SELECT 1');
      await tx.transactionDirect(async nested => { await nested.executeRaw('SELECT 2'); });
    });
    const route = dual ? 'direct' : 'read';
    expect(calls).toEqual([`${route}:begin`, `${route}:query`, `${route}:savepoint`, `${route}:query`]);
    calls.length = 0;
    await engine.transaction(async tx => { await tx.executeRaw('SELECT 3'); });
    expect(calls).toEqual(['read:begin', 'read:query']);
  });

  test('Postgres pool shutdown waits for its mandatory resident consumer', async () => {
    let stopped = false, ended = false, enter!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const engine = new PostgresEngine();
    Object.assign(engine, { _connectionStyle: 'instance', _sql: {
      end: async () => { expect(stopped).toBe(true); ended = true; },
    } });
    const unregister = engine.registerBeforeDisconnect(async () => { enter(); await gate; stopped = true; });
    const closing = engine.disconnect();
    await entered;
    expect(ended).toBe(false);
    finish(); await closing; unregister();
    expect(ended).toBe(true);
  });
});
