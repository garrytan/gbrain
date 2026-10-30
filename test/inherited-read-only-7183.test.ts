/**
 * #7183: a write the server refuses as read-only (SQLSTATE 25006) is named `connection_inherited_read_only` in the write
 * receipt, the sync fault table, item failures and the agent envelope, and the engine's transaction and autocommit seams
 * declare read-write. The end-to-end probe through a read-only server connection is
 * test/e2e/pooler-inherited-read-only-7183.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { cliRenderContext, toAgentError } from '../src/core/agent-output.ts';
import { classifyItemFailure } from '../src/core/item-failure.ts';
import { databaseRefusal } from '../src/core/persistence/publication-failure.ts';
import { classifySyncFault } from '../src/core/persistence/sync-fault-class.ts';
import { isWriteErrorCode } from '../src/core/persistence/types.ts';
import { reservedTransactions } from '../src/core/postgres-engine/reserved-transactions.ts';
import {
  beginReadWrite, isReadOnlyTransactionError, readWriteTransactions, READ_WRITE_BEGIN, retryReadOnlyAutocommit,
} from '../src/core/postgres-engine/read-write-transactions.ts';

const readOnly = (statement = 'INSERT') => Object.assign(new Error(`cannot execute ${statement} in a read-only transaction`), { code: '25006' });

/** A pool double: `begin(options, fn)` records its options and runs `fn` on a transaction handle. */
function fakePool(opts: { beginError?: unknown } = {}) {
  const begins: string[] = [];
  const raw: unknown[] = [];
  const tx = { tag: 'tx' };
  const pool = {
    reserve: () => { throw new Error('unused'); },
    begin: async (options: unknown, fn?: (tx: unknown) => Promise<unknown>) => {
      const run = typeof options === 'function' ? options as (tx: unknown) => Promise<unknown> : fn!;
      begins.push(typeof options === 'string' ? options : '');
      raw.push(options);
      if (opts.beginError && typeof options === 'string') throw opts.beginError;
      return run(tx);
    },
  };
  return { pool: pool as never, begins, raw, tx };
}

describe('#7183 read-write transaction seams', () => {
  test('beginReadWrite opens BEGIN READ WRITE on a pool', async () => {
    const { pool, begins, tx } = fakePool();
    expect(await beginReadWrite(pool, async handle => handle)).toBe(tx as never);
    expect(begins).toEqual(['read write']);
  });

  test('a hot standby that refuses read-write mode at BEGIN gets the plain transaction (reads keep working)', async () => {
    const refusal = Object.assign(new Error('cannot set transaction read-write mode during recovery'), { code: '0A000' });
    const { pool, begins } = fakePool({ beginError: refusal });
    expect(await beginReadWrite(pool, async () => 'read')).toBe('read');
    expect(begins).toEqual(['read write', '']);
  });

  test('a pipelined-first transaction (GBRA-156 `{ first }`) keeps its first-statement test and opens READ WRITE', async () => {
    const { pool, raw, tx } = fakePool();
    const first = (text: string) => text.startsWith('select');
    const begin = readWriteTransactions(pool).begin as unknown as (options: unknown, fn: (handle: unknown) => Promise<unknown>) => Promise<unknown>;
    expect(await begin({ first }, async handle => handle)).toBe(tx);
    expect(raw).toEqual([{ first, mode: 'read write' }]);
  });

  test('a transaction or reserved handle is not wrapped (a savepoint keeps its parent transaction)', () => {
    const handle = { begin: () => undefined } as never;
    expect(readWriteTransactions(handle)).toBe(handle);
  });

  test('an autocommit statement refused with 25006 runs once more inside BEGIN READ WRITE', async () => {
    const { pool, begins, tx } = fakePool();
    const seen: unknown[] = [];
    const rows = await retryReadOnlyAutocommit(pool, async conn => {
      seen.push(conn);
      if (conn === pool) throw readOnly();
      return ['row'];
    });
    expect(rows).toEqual(['row']);
    expect(seen).toEqual([pool, tx]);
    expect(begins).toEqual(['read write']);
  });

  test('no retry for other errors, inside a transaction, or for a statement that cannot run in a transaction block', async () => {
    const { pool, begins } = fakePool();
    await expect(retryReadOnlyAutocommit(pool, async () => { throw Object.assign(new Error('dup'), { code: '23505' }); })).rejects.toMatchObject({ code: '23505' });
    const handle = { begin: () => undefined } as never;
    await expect(retryReadOnlyAutocommit(handle, async () => { throw readOnly(); })).rejects.toMatchObject({ code: '25006' });
    expect(begins).toEqual([]);
    const original = readOnly('CREATE INDEX');
    await expect(retryReadOnlyAutocommit(pool, async conn => {
      throw conn === pool ? original : Object.assign(new Error('CREATE INDEX CONCURRENTLY cannot run inside a transaction block'), { code: '25001' });
    })).rejects.toBe(original);
  });

  test('a reserved connection transaction opens with BEGIN READ WRITE', async () => {
    const sent: string[] = [];
    const reserved = {
      unsafe: (text: string) => {
        sent.push(text);
        const done = Promise.resolve(Object.assign([], { command: text === 'commit' ? 'COMMIT' : 'BEGIN' }));
        return Object.assign(done, { execute: () => done });
      },
      discard: () => undefined,
    };
    await reservedTransactions(reserved as never).begin(async () => 'ok');
    expect(sent).toEqual([READ_WRITE_BEGIN, 'commit']);
  });
});

describe('#7183 connection_inherited_read_only classification', () => {
  test('the write receipt names it, not storage_error', () => {
    const failure = databaseRefusal(readOnly());
    expect(failure).toMatchObject({ code: 'connection_inherited_read_only', detail: { origin: 'database', sqlstate: '25006' } });
    expect(failure!.message).toContain('read-only');
    expect(isWriteErrorCode('connection_inherited_read_only')).toBe(true);
  });

  test('a sync item failure stops the run with the classified code', () => {
    expect(classifyItemFailure(readOnly('SELECT FOR SHARE'))).toMatchObject({ code: 'connection_inherited_read_only', scope: 'run' });
  });

  test('sync status names it systemic and needing the database operator', () => {
    const fault = classifySyncFault({ code: 'connection_inherited_read_only' });
    expect(fault).toMatchObject({ class: 'systemic', safe_actions: ['none'], needs_human: true });
    expect(fault.human_reason).toContain('default_transaction_read_only');
  });

  test('a raw 25006 becomes a typed envelope, not internal_error', () => {
    expect(isReadOnlyTransactionError(readOnly())).toBe(true);
    const env = toAgentError(readOnly(), { transport: 'cli', command: 'sync', render: cliRenderContext() });
    expect(env).toMatchObject({ code: 'connection_inherited_read_only', class: 'host_only', retryable: false });
    expect(env.suggestion).toContain('pooler');
    expect(env.fix?.argv).toEqual(['gbrain', 'doctor', '--json']);
  });
});
