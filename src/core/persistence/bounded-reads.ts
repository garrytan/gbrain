/**
 * #6278 (plan item 1.4): a preparation read that can wait on a relation lock
 * ends at the budget on the server, not only in this process.
 *
 * Preparation reads run outside the publication transaction, and through a
 * transaction-mode pooler the session's `statement_timeout` startup parameter
 * is dropped, so an `ACCESS EXCLUSIVE` lock on `pages` held in another
 * session pinned the member's statement, and its connection, for as long as
 * the lock lasted: the budget released the claim, but the statement kept
 * running as a zombie and the root stayed blocked until the hard ceiling.
 * `boundedReads` wraps the preparer's engine so every unmemoized raw
 * statement runs with `executeRaw`'s `timeoutMs` set to the time the clock
 * has left (`deadlineAt`), a transaction-local `statement_timeout` that holds
 * through the pooler. A statement the server ends for it (57014 statement
 * timeout, or a 55P03 lock timeout a shorter session `lock_timeout` raised)
 * surfaces as the member's own `preparation_deadline`, so the consumer
 * releases the claim charged instead of writing a `storage_error` receipt or
 * an uncounted `database_contention` release.
 *
 * The memo rule stands: a read `preparationReads` answers once for a whole
 * group never takes one member's bound or signal (group-publish.ts drops
 * them), and a statement that already carries a caller's signal keeps the
 * foreground path's cancellation instead of the bound. Engine helpers that bypass `executeRaw`
 * (`readPageSnapshot` and the import pipeline) stay under the consumer's race
 * and the ceiling. Without a deadline (switch off, a clock from an older
 * caller) or on PGLite (one in-process connection, no other session to wait
 * on) the engine is returned as it is.
 *
 * #6317 (C1): the same wrapper records each statement's label on the clock
 * (`recordClaimSql`) before issuing it, so the claim stamp's `last_sql` names
 * the read a parked preparation is waiting on.
 */
import type { BrainEngine, ReservedConnection } from '../engine.ts';
import { PoolCapacityError } from '../pool-budget.ts';
import { recordClaimSql, type ClaimPhaseClock } from './claim-phase.ts';
import { registerEngineView, viewedEngine } from './switches.ts';

/** The SQLSTATEs a bounded read ends with when its server-side bound passes. */
const DEADLINE_SQLSTATES = new Set(['57014', '55P03']);

/** The error a bounded read rejects with at its bound; `code` is what `preparationAbortReason` reads. */
export class PreparationDeadlineError extends Error {
  readonly code = 'preparation_deadline';
  constructor(readonly step: string | null, readonly sqlstate: string, cause: unknown) {
    super(`The preparation read${step ? ` at step ${step}` : ''} did not finish within its budget (the server ended it, SQLSTATE ${sqlstate}).`, { cause });
    this.name = 'PreparationDeadlineError';
  }
}

/** Whether `error` is the client ending a round-trip the pooler never completed (`runUnsafe`'s settle discard). */
export function isConnectionEnd(error: unknown): error is { code: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'CONNECTION_DESTROYED' || code === 'CONNECTION_CLOSED';
}

/** Whether `error` is the server ending a statement at a timeout (ours, or a shorter session one). */
export function isStatementTimeout(error: unknown): error is { code: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && DEADLINE_SQLSTATES.has(code);
}

/** The engine a preparer reads through: raw statements bounded by the clock's remaining budget, everything else untouched. */
export function boundedReads(engine: BrainEngine, clock: ClaimPhaseClock | undefined): BrainEngine {
  const deadlineAt = clock?.deadlineAt;
  if (deadlineAt === undefined || engine.kind !== 'postgres') return engine;
  return registerEngineView(new Proxy(engine, { get(target, key) {
    if (key === 'executeRaw') return async (sql: string, params?: unknown[], opts?: { signal?: AbortSignal; timeoutMs?: number }) => {
      recordClaimSql(clock, sql);
      if (opts?.signal) return target.executeRaw(sql, params, opts);
      try {
        // The clock's signal ends only the wait for a free connection (a saturated pool); the statement itself ends at the bound.
        return await target.executeRaw(sql, params, { ...opts, timeoutMs: Math.max(1, deadlineAt - Date.now()), ...(clock!.signal ? { signal: clock!.signal } : {}) });
      } catch (error) {
        // A connection the engine discarded after the budget's cancel (a pooler that never completed the round-trip) is the deadline too.
        const discarded = isConnectionEnd(error) && (clock!.signal?.aborted || Date.now() >= deadlineAt);
        if (!isStatementTimeout(error) && !discarded) throw error;
        if (clock!.signal?.aborted) throw clock!.signal.reason;
        throw new PreparationDeadlineError(clock!.step, (error as { code: string }).code, error);
      }
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } }), viewedEngine(engine));
}

/** How far a session statement's bound may differ from its own before the session sets `statement_timeout` again. */
export const BOUNDED_SESSION_SLACK_MS = 25;
/**
 * GBRA-75 wave 9: runs `fn` with a view of `engine` whose bounded raw reads (`executeRaw` with `timeoutMs`, which
 * `boundedReads` issues) share one transaction on one reserved ordinary-pool connection: `BEGIN` and
 * `SET LOCAL statement_timeout` once, then each read, then `COMMIT` when `fn` settles, instead of a
 * `BEGIN; SET LOCAL; read; COMMIT` per read. The bound stays per statement and server-side: before a read whose own
 * bound differs from the one in force by more than BOUNDED_SESSION_SLACK_MS, the session sets it again in the same
 * pipeline, so a statement waiting on a relation lock still ends on the server at its budget (within the slack).
 * A read that fails ends the transaction (a rollback); reads the failure aborted (25P02) run again in a new one,
 * so each read sees the outcome it would have alone. A read issued after `fn` settled, by a preparation the
 * caller abandoned, takes the per-read path. Unbounded statements and everything else go to `engine`. On PGLite,
 * or when the pool has no long-hold capacity left, `fn` gets `engine` itself; inside a session (a waiver run's,
 * sync-run.ts `waiveRun`), `fn` joins it.
 */
export async function withBoundedReadSession<T>(engine: BrainEngine, fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
  if (engine.kind !== 'postgres' || sessionViews.has(engine)) return fn(engine);
  let started = false;
  try {
    return await engine.withReservedConnection(async conn => {
      started = true;
      const session = new BoundedReadSession(conn, engine);
      try { return await fn(session.view); } finally { await session.close(); }
    }, { route: 'ordinary' });
  } catch (error) {
    if (!started && error instanceof PoolCapacityError) return fn(engine);
    throw error;
  }
}

/** Views a session hands out: a screen run inside a waiver run's session joins it instead of opening its own. */
const sessionViews = new WeakSet<object>();
class BoundedReadSession {
  readonly view: BrainEngine;
  private open = false;
  private closed = false;
  private generation = 0;
  private boundMs = 0;
  constructor(private readonly conn: ReservedConnection, private readonly engine: BrainEngine) {
    this.view = registerEngineView(new Proxy(engine, { get: (target, key) => {
      if (key === 'executeRaw') return (sql: string, params?: unknown[], opts?: { signal?: AbortSignal; timeoutMs?: number }) =>
        opts?.timeoutMs === undefined ? target.executeRaw(sql, params, opts) : this.run(sql, params, opts.timeoutMs, 0);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }), viewedEngine(engine));
    sessionViews.add(this.view);
  }

  private async run<T>(sql: string, params: unknown[] | undefined, timeoutMs: number, retries: number): Promise<T[]> {
    if (this.closed || retries > 2) return this.engine.executeRaw<T>(sql, params, { timeoutMs });
    const ms = Math.max(1, Math.ceil(timeoutMs));
    const generation = this.generation;
    const steps: Promise<unknown>[] = [];
    if (!this.open) {
      this.open = true;
      steps.push(this.conn.executeRaw('BEGIN'));
      steps.push(this.conn.executeRaw(`SET LOCAL statement_timeout = ${ms}`));
      this.boundMs = ms;
    } else if (Math.abs(this.boundMs - ms) > BOUNDED_SESSION_SLACK_MS) {
      steps.push(this.conn.executeRaw(`SET LOCAL statement_timeout = ${ms}`));
      this.boundMs = ms;
    }
    const read = this.conn.executeRaw<T>(sql, params, { prepare: true });
    const settled = await Promise.allSettled([...steps, read]);
    const failed = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (!failed) return (settled[settled.length - 1] as PromiseFulfilledResult<T[]>).value;
    if (this.generation === generation) {
      this.generation++;
      this.open = false;
      void this.conn.executeRaw('ROLLBACK').catch(() => {});
    }
    if (isConnectionEnd(failed.reason)) this.closed = true;
    else if ((failed.reason as { code?: unknown } | null)?.code === '25P02') return this.run(sql, params, timeoutMs, retries + 1);
    throw failed.reason;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (!this.open) return;
    this.open = false;
    await this.conn.executeRaw('COMMIT').catch(() => {});
  }
}
