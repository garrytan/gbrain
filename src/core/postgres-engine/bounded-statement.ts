/**
 * #6278: `executeRaw` with `timeoutMs` on Postgres. The session's
 * `statement_timeout` is a startup parameter a transaction-mode pooler drops,
 * so a preparation read outside the publication transaction had no
 * server-side bound and a relation lock held elsewhere pinned its connection
 * for as long as the lock lasted. A reserved connection runs `BEGIN; SET LOCAL
 * statement_timeout` (`BEGIN READ WRITE`, #7183), the statement and `COMMIT` as one pipelined round trip:
 * the pooler pins the transaction to one server connection, `SET LOCAL` ends
 * with it, and a statement past the bound ends server-side with 57014 (a lock
 * wait counts toward it). `COMMIT` after a failed statement is a rollback,
 * never an error of its own. `signal` covers only the wait for a free
 * connection (a saturated pool must not hold the bound off); the statement
 * itself ends at the bound, never by a cancel request. With `deadlineAt` the
 * bound is the time left after the connection was reserved (#6696 B1).
 *
 * `jitOff` adds `SET LOCAL jit = off` to the same envelope (see
 * jit-off-statement.ts). Without `timeoutMs` there is no bound, and a
 * signalled statement runs through `run` (the engine's `runUnsafe`), so
 * `signal` still cancels it in flight as it would a plain `executeRaw`; its
 * `COMMIT` follows the statement instead of riding in the same round trip.
 */
import type postgres from '#postgres';
import { reserveWithCancellation } from './cancellation.ts';
import { READ_WRITE_BEGIN } from './read-write-transactions.ts';
import type { CheckoutGauge } from '../pool-gauge.ts';

type Sql = ReturnType<typeof postgres>;
export type RunStatement = <T>(conn: Sql, sql: string, params: unknown[] | undefined, opts: { signal?: AbortSignal; prepare?: boolean }) => Promise<T[]>;

// engine-sql-ok: transaction control around a caller's statement (BEGIN / SET LOCAL statement_timeout / SET LOCAL jit / COMMIT), no storage-domain SQL
export async function runBoundedStatement<T>(conn: Sql, sql: string, params: unknown[] | undefined,
  opts: { timeoutMs?: number; deadlineAt?: number; signal?: AbortSignal; jitOff?: boolean; prepare?: boolean }, onReserved: () => void, run?: RunStatement): Promise<T[]> {
  const reserved = opts.signal ? await reserveWithCancellation(reserve => conn.reserve(reserve), opts.signal) : await conn.reserve();
  onReserved();
  const settings = opts.jitOff ? ['SET LOCAL jit = off'] : [];
  if (opts.timeoutMs !== undefined) {
    // #6696 B1: an absolute deadline is re-read after the pool wait, so time spent waiting for a connection is not granted again.
    const ms = Math.max(1, Math.ceil(opts.deadlineAt !== undefined ? Math.min(opts.timeoutMs, opts.deadlineAt - Date.now()) : opts.timeoutMs));
    settings.push(`SET LOCAL statement_timeout = ${ms}`);
  }
  try {
    const open = reserved.unsafe([READ_WRITE_BEGIN, ...settings].join('; ')).simple().execute();
    // A cancellable statement is issued through `run`, which awaits the query and so enqueues it a microtask
    // later than `execute()` would: COMMIT then waits for it to settle instead of being pipelined ahead of it.
    const cancellable = opts.timeoutMs === undefined && opts.signal && run;
    const read = cancellable
      ? (async () => run<T>(reserved as unknown as Sql, sql, params, { signal: opts.signal, prepare: opts.prepare }))()
      : reserved.unsafe(sql, params as Parameters<typeof reserved.unsafe>[1], { prepare: opts.prepare ?? true }).execute();
    const commit = () => reserved.unsafe('COMMIT').execute();
    const close = cancellable ? read.then(commit, commit) : commit();
    const settled = await Promise.allSettled([open, read, close]);
    for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason;
    return (settled[1] as PromiseFulfilledResult<unknown>).value as T[];
  } finally {
    reserved.release();
  }
}

/**
 * #6318: an engine read issued for a bounded preparation (read-deadline.ts) that would otherwise run on the shared pool
 * in autocommit. It runs on one reserved connection as `BEGIN READ ONLY; SET LOCAL statement_timeout = <time left>`
 * (one simple statement), the read's own statements and `COMMIT`, pipelined: the server ends a read still waiting on
 * a lock at the deadline (57014), through a transaction-mode pooler, and the answer returns without waiting for
 * COMMIT's round trip. A failed read leaves the transaction aborted, and COMMIT then rolls it back.
 */
// engine-sql-ok: transaction control around a caller's read (BEGIN READ ONLY / SET LOCAL statement_timeout / COMMIT), no storage-domain SQL
export async function runDeadlineRead<T>(conn: Sql, deadlineAt: number, run: (tx: Sql) => Promise<T>, gauge: CheckoutGauge): Promise<T> {
  gauge.acquire('reserved');
  const reserved = await conn.reserve().catch(error => { gauge.release('reserved'); throw error; });
  gauge.checkedOut();
  const ms = Math.max(1, Math.ceil(deadlineAt - Date.now()));
  const opened = reserved.unsafe(`BEGIN READ ONLY; SET LOCAL statement_timeout = ${ms}`).simple().execute().then(() => undefined, (error: unknown) => error);
  try {
    const result = await run(reserved as unknown as Sql);
    const failed = await opened;
    if (failed) throw failed;
    return result;
  } finally {
    void reserved.unsafe('COMMIT').execute().then(() => undefined, () => undefined).finally(() => { reserved.release(); gauge.release('reserved'); });
  }
}

