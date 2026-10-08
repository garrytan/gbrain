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
 */
import type { BrainEngine } from '../engine.ts';
import type { ClaimPhaseClock } from './claim-phase.ts';
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
