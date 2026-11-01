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
 * never an error of its own. `signal` also bounds the client-side envelope:
 * abort cancels pending queries and discards their exclusive connection,
 * without waiting for an unresponsive pooler to confirm cancellation. This
 * is not proof of server-side rollback. With `deadlineAt` the
 * bound is the time left after the connection was reserved (#6696 B1).
 *
 * `jitOff` adds `SET LOCAL jit = off` to the same envelope (see
 * jit-off-statement.ts). Without `timeoutMs` there is no bound, and a
 * signalled statement runs through `run` (the engine's `runUnsafe`), so
 * `signal` still cancels it in flight as it would a plain `executeRaw`; its
 * `COMMIT` follows the statement instead of riding in the same round trip.
 */
import type postgres from '#postgres';
import { hasPostgresCancellationCapability, postgresCancellationUnavailable, reserveWithCancellation } from './cancellation.ts';
import { READ_WRITE_BEGIN } from './read-write-transactions.ts';

type Sql = ReturnType<typeof postgres>;
export type RunStatement = <T>(conn: Sql, sql: string, params: unknown[] | undefined, opts: { signal?: AbortSignal; prepare?: boolean }) => Promise<T[]>;

// engine-sql-ok: transaction control around a caller's statement (BEGIN / SET LOCAL statement_timeout / SET LOCAL jit / COMMIT), no storage-domain SQL
export async function runBoundedStatement<T>(conn: Sql, sql: string, params: unknown[] | undefined,
  opts: { timeoutMs?: number; deadlineAt?: number; signal?: AbortSignal; jitOff?: boolean; prepare?: boolean }, onReserved: () => void, run?: RunStatement): Promise<T[]> {
  const reserved = opts.signal ? await reserveWithCancellation(reserve => conn.reserve(reserve), opts.signal) : await conn.reserve();
  let discarded = false;
  const pending = new Set<Promise<unknown> & { cancel?: () => Promise<unknown> }>();
  const signal = opts.timeoutMs !== undefined ? opts.signal : undefined;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    rejectAbort(signal?.reason ?? new DOMException('aborted', 'AbortError'));
    if (!pending.size || discarded) return;
    // Do not await cancellation: a swallowed CancelRequest is the failure
    // being bounded. Never put this socket back into the reusable pool.
    discarded = true;
    for (const query of pending) {
      try { query.cancel?.().catch(() => {}); } catch { /* discard still owns cleanup */ }
    }
    reserved.discard();
  };
  const track = <P extends Promise<unknown>>(query: P): P => {
    pending.add(query);
    query.then(() => pending.delete(query), () => pending.delete(query));
    return query;
  };
  const settings = opts.jitOff ? ['SET LOCAL jit = off'] : [];
  if (opts.timeoutMs !== undefined) {
    // #6696 B1: an absolute deadline is re-read after the pool wait, so time spent waiting for a connection is not granted again.
    const ms = Math.max(1, Math.ceil(opts.deadlineAt !== undefined ? Math.min(opts.timeoutMs, opts.deadlineAt - Date.now()) : opts.timeoutMs));
    settings.push(`SET LOCAL statement_timeout = ${ms}`);
  }
  try {
    onReserved();
    if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError');
    if (signal && !hasPostgresCancellationCapability(reserved)) throw postgresCancellationUnavailable();
    signal?.addEventListener('abort', onAbort, { once: true });
    const open = track(reserved.unsafe([READ_WRITE_BEGIN, ...settings].join('; ')).simple().execute());
    // A cancellable statement is issued through `run`, which awaits the query and so enqueues it a microtask
    // later than `execute()` would: COMMIT then waits for it to settle instead of being pipelined ahead of it.
    const cancellable = opts.timeoutMs === undefined && opts.signal && run;
    const read = track(cancellable
      ? (async () => run<T>(reserved as unknown as Sql, sql, params, { signal: opts.signal, prepare: opts.prepare }))()
      : reserved.unsafe(sql, params as Parameters<typeof reserved.unsafe>[1], { prepare: opts.prepare ?? true }).execute());
    const commit = () => track(reserved.unsafe('COMMIT').execute());
    const close = cancellable ? read.then(commit, commit) : commit();
    const envelope = Promise.allSettled([open, read, close]);
    const settled = await (signal ? Promise.race([envelope, aborted]) : envelope);
    for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason;
    return (settled[1] as PromiseFulfilledResult<unknown>).value as T[];
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!discarded) reserved.release();
  }
}
