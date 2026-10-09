/**
 * #6278: `executeRaw` with `timeoutMs` on Postgres. The session's
 * `statement_timeout` is a startup parameter a transaction-mode pooler drops,
 * so a preparation read outside the publication transaction had no
 * server-side bound and a relation lock held elsewhere pinned its connection
 * for as long as the lock lasted. A reserved connection runs `BEGIN; SET LOCAL
 * statement_timeout`, the statement and `COMMIT` as one pipelined round trip:
 * the pooler pins the transaction to one server connection, `SET LOCAL` ends
 * with it, and a statement past the bound ends server-side with 57014 (a lock
 * wait counts toward it). `COMMIT` after a failed statement is a rollback,
 * never an error of its own. `signal` covers only the wait for a free
 * connection (a saturated pool must not hold the bound off); the statement
 * itself ends at the bound, never by a cancel request.
 */
import type postgres from '#postgres';
import { reserveWithCancellation } from './cancellation.ts';

// engine-sql-ok: transaction control around a caller's statement (BEGIN / SET LOCAL statement_timeout / COMMIT), no storage-domain SQL
export async function runBoundedStatement<T>(conn: ReturnType<typeof postgres>, sql: string, params: unknown[] | undefined,
  opts: { timeoutMs: number; signal?: AbortSignal }, onReserved: () => void): Promise<T[]> {
  const ms = Math.max(1, Math.ceil(opts.timeoutMs));
  const reserved = opts.signal ? await reserveWithCancellation(reserve => conn.reserve(reserve), opts.signal) : await conn.reserve();
  onReserved();
  try {
    const open = reserved.unsafe(`BEGIN; SET LOCAL statement_timeout = ${ms}`).simple().execute();
    const read = reserved.unsafe(sql, params as Parameters<typeof reserved.unsafe>[1], { prepare: true }).execute();
    const close = reserved.unsafe('COMMIT').execute();
    const settled = await Promise.allSettled([open, read, close]);
    for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason;
    return (settled[1] as PromiseFulfilledResult<unknown>).value as T[];
  } finally {
    reserved.release();
  }
}
