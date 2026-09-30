/**
 * SkillOpt must-abort classification.
 *
 * Budget exhaustion (BudgetExhausted, tagged BUDGET_EXHAUSTED), AI spend-policy
 * refusals, the run's wall-clock deadline and SIGINT are never per-call noise: every optimizer,
 * judge, held-out and bootstrap call site rethrows them before converting any
 * other error into a reflect error, a judge score of 0 or a skipped row, so the
 * run ends `aborted` with its real reason instead of a fabricated measurement.
 */

import { isAIInvocationPolicyError } from '../ai/invocation-guard.ts';
import { isMustAbortError } from '../worker-pool.ts';

/** #4119 — the runtime-deadline breach error, shared with validate-gate + orchestrator. */
export const SKILLOPT_RUNTIME_EXCEEDED = 'skillopt_runtime_exceeded';

export function isSkilloptMustAbort(err: unknown): boolean {
  if (isMustAbortError(err) || isAIInvocationPolicyError(err)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(SKILLOPT_RUNTIME_EXCEEDED) || msg.includes('SIGINT');
}
