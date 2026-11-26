/**
 * `getConfig` on Postgres retries its read after a dropped pooler connection (#1603). Master checked the request
 * signal inside every attempt, so a request that aborted during the reconnect and backoff sent no second statement.
 * The typed config read (`configRead`) must keep that: the abort check runs before each attempt, not only once.
 *
 * Protects:
 * - a request that aborts after the first attempt fails with a connection error rejects with its AbortError and
 *   sends exactly one statement (no retry after the abort);
 * - a request that is never aborted still retries the dropped read and returns the value.
 * Fails when `configRead` checks the request signal only before the first attempt.
 * No database: the engine runs on the recording fake.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { withRequestSignal } from '../src/core/request-signal.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

function connReset(): Error {
  return Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
}

function droppingEngine(onDrop: () => void) {
  let calls = 0;
  const fake = makeFakeSql(() => {
    calls += 1;
    if (calls === 1) { onDrop(); return connReset(); }
    return [{ value: 'ok' }];
  });
  const engine = new PostgresEngine();
  Object.assign(engine as unknown as Record<string, unknown>, {
    _sql: fake.sql,
    _bulkRetryOptsCache: { maxRetries: 2, delayMs: 1, delayMaxMs: 1 },
    reconnect: async () => {},
  });
  return { fake, engine };
}

test('getConfig sends no retry after the request aborts during a dropped read', async () => {
  const controller = new AbortController();
  const { fake, engine } = droppingEngine(() => controller.abort(new Error('client went away')));
  const error = await withRequestSignal(controller.signal, () => engine.getConfig('example.key')).then(() => null, (e: unknown) => e);
  expect((error as Error | null)?.name).toBe('AbortError');
  expect(fake.statements()).toHaveLength(1);
});

test('getConfig outside an aborted request still retries a dropped read', async () => {
  const { fake, engine } = droppingEngine(() => {});
  expect(await engine.getConfig('example.key')).toBe('ok');
  expect(fake.statements()).toHaveLength(2);
});
