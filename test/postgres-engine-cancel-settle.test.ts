/**
 * #6278: a cancelled statement that never settles is discarded client-side.
 *
 * Through a transaction-mode pooler (Supavisor :6543) the cancel request a
 * signalled `executeRaw` sends may never reach the backend, which then sits
 * in `ClientRead` forever: no server timeout applies, `cancel()` resolves
 * without ending the statement, and the awaiting caller (the consumer's
 * `expired_claims` phase in the live report) parks on a promise that never
 * settles. `runUnsafe` now discards the reserved connection once the
 * statement is still unsettled `GBRAIN_CANCEL_SETTLE_MS` after the cancel,
 * so the promise rejects (CONNECTION_DESTROYED) and the caller moves on.
 *
 * Hermetic: Object.create(PostgresEngine.prototype) with a fake pool whose
 * reserved `unsafe()` never settles unless discarded. Fails before the fix:
 * the awaited promise never settles and the test times out.
 */
import { describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { CheckoutGauge } from '../src/core/pool-gauge.ts';
import { withEnv } from './helpers/with-env.ts';

interface Statement extends Promise<unknown[]> { cancel: () => Promise<void> }

function hangingPool(log: string[], opts: { cancelEndsStatement: boolean }) {
  let reject: ((error: unknown) => void) | undefined;
  const pool = {
    options: { max: 10 },
    unsafe: async () => [],
    reserve: async () => ({
      unsafe: (sql: string) => {
        log.push(`unsafe:${sql}`);
        const statement = new Promise<unknown[]>((_, rej) => { reject = rej; }) as Statement;
        statement.cancel = async () => {
          log.push('cancel');
          if (opts.cancelEndsStatement) reject?.(Object.assign(new Error('canceling statement due to user request'), { code: '57014' }));
        };
        return statement;
      },
      discard: () => { log.push('discard'); reject?.(Object.assign(new Error('write CONNECTION_DESTROYED'), { code: 'CONNECTION_DESTROYED' })); },
      release: () => log.push('release'),
    }),
  };
  return pool;
}

function makeEngine(pool: unknown): PostgresEngine {
  const engine = Object.create(PostgresEngine.prototype) as PostgresEngine;
  Object.defineProperty(engine, 'sql', { get: () => pool });
  Object.defineProperty(engine, '_sql', { value: pool, writable: true });
  Object.defineProperty(engine, 'checkoutGauge', { value: new CheckoutGauge(), writable: true });
  Object.defineProperty(engine, 'connectionManager', { value: { peekReadPool: () => pool, isDualPoolActive: () => false } });
  return engine;
}

const run = (engine: PostgresEngine, signal: AbortSignal) =>
  (engine as unknown as { runUnsafe: (conn: unknown, sql: string, params: unknown[] | undefined, opts: { signal: AbortSignal }) => Promise<unknown[]> })
    .runUnsafe((engine as unknown as { sql: unknown }).sql, 'WITH expired AS (SELECT 1) UPDATE persistence_requests SET state=state', [], { signal });

describe('#6278: a cancelled statement the pooler never ends settles client-side', () => {

  test('cancel resolves, the statement stays unsettled, the connection is discarded at the settle window and the caller gets CONNECTION_DESTROYED', async () => {
    await withEnv({ GBRAIN_CANCEL_SETTLE_MS: '150' }, async () => {
      const log: string[] = [];
      const engine = makeEngine(hangingPool(log, { cancelEndsStatement: false }));
      const abort = new AbortController();
      const started = performance.now();
      const pending = run(engine, abort.signal);
      setTimeout(() => abort.abort({ code: 'deadline_exceeded' }), 20);
      const error = await pending.then(() => null, e => e as { code?: string });
      const elapsed = performance.now() - started;
      expect(error?.code).toBe('CONNECTION_DESTROYED');
      expect(log).toEqual(['unsafe:WITH expired AS (SELECT 1) UPDATE persistence_requests SET state=state', 'cancel', 'discard', 'release']);
      // Settled within the window plus scheduling slack, not at the test timeout.
      expect(elapsed).toBeLessThan(1_500);
      expect(elapsed).toBeGreaterThanOrEqual(150);
    });
  });

  test('a cancel the server honours ends the statement with 57014 before the settle window; nothing is discarded', async () => {
    await withEnv({ GBRAIN_CANCEL_SETTLE_MS: '2000' }, async () => {
      const log: string[] = [];
      const engine = makeEngine(hangingPool(log, { cancelEndsStatement: true }));
      const abort = new AbortController();
      const started = performance.now();
      const pending = run(engine, abort.signal);
      setTimeout(() => abort.abort({ code: 'deadline_exceeded' }), 20);
      const error = await pending.then(() => null, e => e as { code?: string });
      expect(error?.code).toBe('57014');
      expect(log).toEqual(['unsafe:WITH expired AS (SELECT 1) UPDATE persistence_requests SET state=state', 'cancel', 'release']);
      expect(performance.now() - started).toBeLessThan(1_000);
    });
  });

  test('a statement that finishes before the settle window never arms a discard', async () => {
    await withEnv({ GBRAIN_CANCEL_SETTLE_MS: '150' }, async () => {
      const log: string[] = [];
      const pool = hangingPool(log, { cancelEndsStatement: false });
      let resolveStatement: ((rows: unknown[]) => void) | undefined;
      const reserved = await pool.reserve();
      pool.reserve = async () => ({ ...reserved, unsafe: (sql: string) => {
        log.push(`unsafe:${sql}`);
        const statement = new Promise<unknown[]>(res => { resolveStatement = res; }) as Statement;
        statement.cancel = async () => { log.push('cancel'); };
        return statement;
      } });
      const engine = makeEngine(pool);
      const abort = new AbortController();
      const pending = run(engine, abort.signal);
      setTimeout(() => { abort.abort({ code: 'deadline_exceeded' }); resolveStatement?.([{ ok: 1 }]); }, 20);
      expect(await pending).toEqual([{ ok: 1 }]);
      await Bun.sleep(250);
      expect(log.filter(entry => entry === 'discard')).toEqual([]);
    });
  });
});
