/**
 * `engine.transaction(fn, { signal })` on Postgres (GBRA-76, for the
 * publication deadline in #6288 / #6352): aborting the signal discards the
 * transaction's connection, so the transaction rejects, every `finally` on
 * the way out runs, and the server rolls the transaction back instead of
 * leaving it open or committing it.
 *
 * Protects: a mid-flight abort rejects with an `AbortError` whose `cause` is
 * the driver's `CONNECTION_CLOSED`, the callback's `finally` runs, nothing the
 * transaction wrote is visible (checked again after the in-flight statement
 * would have finished), the pool serves the next caller and the tx gauge is
 * released; an already-aborted signal rejects before `BEGIN` is sent; an abort
 * after `COMMIT` changes nothing; `transactionDirect` behaves the same.
 * Regression that fails it on master: the option is ignored, so the
 * transaction runs to completion and commits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
const table = `t_tx_abort_${Math.random().toString(36).slice(2)}`;
let engine: PostgresEngine;

type Settled = { value: unknown } | { name: string; message: string; cause?: unknown } | { hung: true };

function settle(p: Promise<unknown>, ms = 4000): Promise<Settled> {
  return Promise.race([
    p.then(value => ({ value }), (e: Error & { cause?: unknown }) => ({ name: e.name, message: e.message, cause: e.cause })),
    new Promise<Settled>(resolve => setTimeout(() => resolve({ hung: true }), ms)),
  ]);
}

async function count(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]!.n;
}

describe.skipIf(!url)('engine.transaction(fn, { signal }) on Postgres', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: url!, poolSize: 2 });
    await engine.executeRaw(`CREATE TABLE ${table} (x int)`);
  });
  afterAll(async () => {
    await engine.executeRaw(`DROP TABLE IF EXISTS ${table}`).catch(() => {});
    await engine.disconnect();
  });

  for (const method of ['transaction', 'transactionDirect'] as const) {
    test(`${method}: a mid-flight abort rejects with AbortError, runs the callback's finally, commits nothing and frees the pool`, async () => {
      const ac = new AbortController();
      let finallyRan = false;
      const tx = settle(engine[method](async tx => {
        try {
          await tx.executeRaw(`INSERT INTO ${table} VALUES (1)`);
          await tx.executeRaw('SELECT pg_sleep(1.5)');
          await tx.executeRaw(`INSERT INTO ${table} VALUES (2)`);
        } finally {
          finallyRan = true;
        }
      }, { signal: ac.signal }));
      setTimeout(() => ac.abort(new Error('publication ceiling reached')), 200);
      const outcome = await tx;
      expect(outcome).toMatchObject({ name: 'AbortError', message: 'publication ceiling reached' });
      expect((outcome as { cause?: { code?: string } }).cause?.code).toBe('CONNECTION_CLOSED');
      expect(finallyRan).toBe(true);
      expect(await count()).toBe(0);
      expect(engine.getPoolDiagnostics()?.tracked.tx).toBe(0);
      await new Promise(resolve => setTimeout(resolve, 1600));
      expect(await count()).toBe(0);
      expect(await engine.executeRaw<{ x: number }>('SELECT 1 AS x')).toEqual([{ x: 1 }]);
    }, 15000);
  }

  test('an already-aborted signal rejects before BEGIN is sent', async () => {
    const ac = new AbortController();
    ac.abort();
    const before = engine.getPoolDiagnostics()?.pool?.completed;
    let entered = false;
    const outcome = await settle(engine.transaction(async () => { entered = true; }, { signal: ac.signal }));
    expect(outcome).toMatchObject({ name: 'AbortError' });
    expect(entered).toBe(false);
    expect(engine.getPoolDiagnostics()?.pool?.completed).toBe(before);
    expect(engine.getPoolDiagnostics()?.tracked.tx).toBe(0);
  });

  test('an abort after COMMIT changes nothing', async () => {
    const ac = new AbortController();
    const result = await engine.transaction(async tx => {
      await tx.executeRaw(`INSERT INTO ${table} VALUES (3)`);
      return 'done';
    }, { signal: ac.signal });
    ac.abort();
    expect(result).toBe('done');
    expect(await count()).toBe(1);
    expect(await engine.executeRaw<{ x: number }>('SELECT 1 AS x')).toEqual([{ x: 1 }]);
    await engine.executeRaw(`DELETE FROM ${table}`);
  });

  test('without a signal the transaction is unchanged', async () => {
    await engine.transaction(async tx => { await tx.executeRaw(`INSERT INTO ${table} VALUES (4)`); });
    expect(await count()).toBe(1);
    await engine.executeRaw(`DELETE FROM ${table}`);
  });
});
