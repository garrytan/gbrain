/**
 * `withTransactionAbort` / `transactionAborted` (postgres-engine/transaction-abort.ts)
 * and the PGLite side of `transaction(fn, { signal })`, no Postgres needed.
 *
 * Protects: an abort discards the attached handle whether it lands before or
 * after `begin()` produced it; a rejection after an abort becomes an
 * `AbortError` carrying the signal's reason and the original error as
 * `cause`; a rejection without an abort passes through untouched; the abort
 * listener is removed either way; no signal means no wrapping. On PGLite an
 * already-aborted signal rejects before the transaction opens and a
 * mid-flight abort is ignored (one in-process connection cannot interrupt a
 * statement), so the transaction commits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { transactionAborted, withTransactionAbort } from '../src/core/postgres-engine/transaction-abort.ts';

describe('withTransactionAbort', () => {
  test('an abort after the handle is attached discards it and the rejection becomes an AbortError with cause', async () => {
    const ac = new AbortController();
    let discards = 0;
    const handle = { discard: () => { discards++; } };
    const driverError = Object.assign(new Error('Connection was discarded'), { code: 'CONNECTION_CLOSED' });
    const run = withTransactionAbort(ac.signal, async attach => {
      attach(handle);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      throw driverError;
    });
    setTimeout(() => ac.abort(new Error('deadline')), 5);
    const error = await run.then(() => null, (e: Error & { cause?: unknown }) => e);
    expect(discards).toBe(1);
    expect(error?.name).toBe('AbortError');
    expect(error?.message).toBe('deadline');
    expect(error?.cause).toBe(driverError);
  });

  test('an abort that lands before the handle exists is applied as soon as it is attached', async () => {
    const ac = new AbortController();
    let discards = 0;
    const run = withTransactionAbort(ac.signal, async attach => {
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      attach({ discard: () => { discards++; } });
      throw new Error('closed');
    });
    ac.abort();
    const error = await run.then(() => null, (e: Error) => e);
    expect(discards).toBe(1);
    expect(error?.name).toBe('AbortError');
    expect(error?.message).toBe((ac.signal.reason as Error).message);
  });

  test('a rejection without an abort passes through and the listener is removed', async () => {
    const ac = new AbortController();
    const boom = new Error('boom');
    let discards = 0;
    const error = await withTransactionAbort(ac.signal, async attach => {
      attach({ discard: () => { discards++; } });
      throw boom;
    }).then(() => null, (e: Error) => e);
    expect(error).toBe(boom);
    ac.abort();
    expect(discards).toBe(0);
  });

  test('a result without an abort passes through, and a later abort discards nothing', async () => {
    const ac = new AbortController();
    let discards = 0;
    const value = await withTransactionAbort(ac.signal, async attach => {
      attach({ discard: () => { discards++; } });
      return 42;
    });
    expect(value).toBe(42);
    ac.abort();
    expect(discards).toBe(0);
  });

  test('no signal means run as is', async () => {
    expect(await withTransactionAbort(undefined, async () => 'plain')).toBe('plain');
  });

  test('transactionAborted carries a non-Error reason as the default message', () => {
    const ac = new AbortController();
    ac.abort('string reason');
    const error = transactionAborted(ac.signal);
    expect(error.name).toBe('AbortError');
    expect(error.message).toBe('transaction aborted');
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe('PGLite transaction(fn, { signal })', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.executeRaw('CREATE TABLE t_tx_abort (x int)');
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('an already-aborted signal rejects before the transaction opens', async () => {
    const ac = new AbortController();
    ac.abort();
    let entered = false;
    const error = await engine.transaction(async () => { entered = true; }, { signal: ac.signal }).then(() => null, (e: Error) => e);
    expect(error?.name).toBe('AbortError');
    expect(entered).toBe(false);
    expect(await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM t_tx_abort')).toEqual([{ n: 0 }]);
  });

  test('a mid-flight abort is ignored and the transaction commits', async () => {
    const ac = new AbortController();
    const result = await engine.transaction(async tx => {
      await tx.executeRaw('INSERT INTO t_tx_abort VALUES (1)');
      ac.abort();
      await tx.executeRaw('INSERT INTO t_tx_abort VALUES (2)');
      return 'committed';
    }, { signal: ac.signal });
    expect(result).toBe('committed');
    expect(await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM t_tx_abort')).toEqual([{ n: 2 }]);
  });
});
