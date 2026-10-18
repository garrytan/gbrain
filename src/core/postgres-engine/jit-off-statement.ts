/**
 * `executeRaw(sql, params, { jitOff: true })` on Postgres (LHF wave 2 item 1).
 *
 * Some short reads outside the search transactions (the typed-search type
 * check) cost more than `jit_above_cost`, and Postgres then compiles them
 * with LLVM on every call: half a second of compilation for a sub-millisecond
 * read. The wrapper costs round trips, so it runs only where it pays:
 *
 * - Outside a transaction, the server's `jit` setting is read once per pool.
 *   With JIT off the statement runs exactly as a plain `executeRaw`; with JIT
 *   on it runs in the pipelined envelope of bounded-statement.ts (`BEGIN; SET
 *   LOCAL jit = off`, the statement, `COMMIT` in one round trip), which keeps
 *   `timeoutMs`/`deadlineAt`, the reservation's abort signal and the checkout
 *   gauge.
 * - Inside a caller's transaction the caller's own value is read, and when
 *   it is on, `SET LOCAL jit = off`, the statement and the restore of the
 *   caller's value are pipelined (a signalled statement's restore follows it). A failed statement aborts the caller's
 *   transaction as a plain `executeRaw` would, so nothing is left to restore.
 *
 * `SET LOCAL` never leaks past the transaction, so a transaction-mode pooler
 * never hands a JIT-off session to another client. PGLite has no JIT
 * provider and ignores the option.
 */
import type postgres from '#postgres';
import { runBoundedStatement, type RunStatement } from './bounded-statement.ts';

type Sql = ReturnType<typeof postgres>;

const serverJit = new WeakMap<object, Promise<boolean>>();

/** Whether a statement on this pool needs the JIT-off envelope; a failed read counts as on, since the envelope is always correct. */
// engine-sql-ok: jit is a Postgres server setting; PGLite has no JIT provider
export function needsJitOff(pool: Sql, nested: boolean): Promise<boolean> {
  if (nested) return Promise.resolve(true);
  let known = serverJit.get(pool);
  if (!known) {
    known = pool.unsafe(`SELECT current_setting('jit') AS jit`).then(rows => (rows[0] as { jit?: string } | undefined)?.jit !== 'off');
    serverJit.set(pool, known);
    known.catch(() => { if (serverJit.get(pool) === known) serverJit.delete(pool); });
  }
  return known.catch(() => true);
}

// engine-sql-ok: jit is a Postgres server setting; PGLite has no JIT provider
export async function runJitOffStatement<T>(conn: Sql, nested: boolean, sql: string, params: unknown[] | undefined,
  opts: { signal?: AbortSignal; timeoutMs?: number; deadlineAt?: number; prepare?: boolean }, run: RunStatement, onReserved: () => void): Promise<T[]> {
  if (!nested) return runBoundedStatement<T>(conn, sql, params, { ...opts, jitOff: true }, onReserved, run);
  const [current] = await conn.unsafe(`SELECT current_setting('jit') AS jit`) as unknown as Array<{ jit: string }>;
  if (current?.jit === 'off') return run<T>(conn, sql, params, { signal: opts.signal, prepare: opts.prepare });
  const set = conn.unsafe('SET LOCAL jit = off').execute();
  // As in bounded-statement.ts: a signalled statement goes through `run`, which enqueues it a microtask late, so the restore waits for it.
  const read = opts.signal
    ? (async () => run<T>(conn, sql, params, { signal: opts.signal, prepare: opts.prepare }))()
    : conn.unsafe(sql, params as Parameters<typeof conn.unsafe>[1], { prepare: opts.prepare ?? true }).execute() as unknown as Promise<T[]>;
  const reset = () => conn.unsafe(`SELECT set_config('jit', $1, true)`, [current!.jit]).execute();
  const restore = opts.signal ? read.then(reset, reset) : reset();
  const settled = await Promise.allSettled([set, read, restore]);
  for (const outcome of settled) if (outcome.status === 'rejected') throw outcome.reason;
  return (settled[1] as PromiseFulfilledResult<T[]>).value;
}
