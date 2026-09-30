/**
 * Cycle phase containment (fix wave 3, CEO E2 / Eng E-D15).
 *
 * A phase whose runner throws (for example a managed-brain refusal) returns a
 * `fail` phase result carrying the typed error, so later phases in the same
 * job still run; the job's status still reports the failure. Containment
 * never swallows cancellation, a lost cycle lease or budget exhaustion: those
 * stop the job exactly as before. A contained failure after paid model calls
 * is recorded for doctor's dream_paid_loop check.
 */
import type { BrainEngine } from '../engine.ts';
import type { CyclePhase, PhaseResult } from '../cycle.ts';
import { LockStolenError } from '../db-lock.ts';
import { BudgetExhausted } from '../budget/budget-tracker.ts';
import { withChatCallMeter } from '../ai/chat-usage.ts';
import { recordContainedPaidFailure } from './dream-breaker.ts';

/** Errors that must stop the whole job instead of failing one phase. */
export function isUncontainedPhaseError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof LockStolenError || error instanceof BudgetExhausted) return true;
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'AbortError' || name === 'LockStolenError' || name === 'BudgetExhausted';
}

export interface PhaseContainment {
  engine: BrainEngine | null;
  sourceId: string;
  signal?: AbortSignal;
}

/**
 * Time one phase runner and contain its failure. Returns the same
 * `{ result, duration_ms }` shape as the plain timer.
 */
export async function timeContainedPhase<T extends PhaseResult>(containment: PhaseContainment, phase: CyclePhase,
  fn: () => Promise<T>): Promise<{ result: T | PhaseResult; duration_ms: number }> {
  const start = performance.now();
  const meter = { calls: 0 };
  try {
    const result = await withChatCallMeter(meter, fn);
    return { result, duration_ms: Math.round(performance.now() - start) };
  } catch (error) {
    if (isUncontainedPhaseError(error, containment.signal)) throw error;
    const err = error instanceof Error ? error : new Error(String(error));
    const rawCode = (err as { code?: unknown }).code;
    const code = typeof rawCode === 'string' ? rawCode : 'UNKNOWN';
    let paidLoopRecorded = false;
    if (meter.calls > 0 && containment.engine) {
      try { await recordContainedPaidFailure(containment.engine, phase, containment.sourceId); paidLoopRecorded = true; }
      catch (recordError) {
        console.warn(`[cycle] could not record the contained ${phase} failure for dream_paid_loop: ${recordError instanceof Error ? recordError.message : String(recordError)}`);
      }
    }
    console.error(`[cycle] phase '${phase}' failed and was contained; later phases still run: ${err.message}`);
    return {
      result: {
        phase,
        status: 'fail',
        duration_ms: 0,
        summary: `${phase} failed: ${err.message.slice(0, 200)}`,
        details: { contained: true, paid_model_calls: meter.calls, paid_loop_recorded: paidLoopRecorded },
        error: { class: err.name || 'Error', code, message: err.message.slice(0, 200) },
      },
      duration_ms: Math.round(performance.now() - start),
    };
  }
}
