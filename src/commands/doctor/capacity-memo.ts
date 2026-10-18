/**
 * #6803 C4: one capacity forecast per doctor run, shared by persistence_capacity
 * and persistence_request_growth (it used to run twice, each a whole-table read).
 * It reads under the run's overall deadline, not the deadline of the entry that
 * started it, so an entry that runs out of time mid-forecast does not cancel it
 * for a later entry. A forecast the deadline refused or cancelled is dropped
 * from the memo and marks the waiting entry expired, so a later entry reads it
 * again or reports unknown, never a counter-only verdict. Outside a doctor run
 * (no run memo) it reads directly.
 */
import { readCapacityForecast, type CapacityForecast } from '../../core/persistence/capacity-forecast.ts';
import type { JournalLimits, SqlEngine } from '../../core/persistence/model.ts';
import { currentStatementDeadline, deadlineBoundEngine, deadlineFailure, withStatementDeadline } from '../../core/statement-deadline.ts';

const KEY = 'capacity_forecast';

export function doctorCapacityForecast(engine: SqlEngine & { kind?: string }, opts: { limits: JournalLimits }): Promise<CapacityForecast> {
  const scope = currentStatementDeadline();
  const memo = scope?.memo;
  if (!scope || !memo) return readCapacityForecast(engine, opts);
  let shared = memo.get(KEY) as Promise<CapacityForecast> | undefined;
  if (!shared) {
    const created: Promise<CapacityForecast> = withStatementDeadline({ startedAt: Date.now(), deadlineAt: scope.runDeadlineAt ?? null, expired: false, memo },
      () => readCapacityForecast(deadlineBoundEngine(engine), opts));
    created.catch((error: unknown) => { if (deadlineFailure(error) && memo.get(KEY) === created) memo.delete(KEY); });
    memo.set(KEY, created);
    shared = created;
  }
  return shared.catch((error: unknown) => {
    if (deadlineFailure(error)) scope.expired = true;
    throw error;
  });
}

/** A check's `.catch` for the forecast: no forecast (null) on an ordinary failure; a deadline failure propagates, so the check is unknown. */
export function forecastOrNull(error: unknown): null {
  if (deadlineFailure(error)) throw error;
  return null;
}
