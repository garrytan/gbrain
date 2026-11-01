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

/** B1.3 — a harness rollout hook refused a batch over its shared budget. */
export const SKILLOPT_HOOK_BUDGET_EXHAUSTED = 'skillopt_hook_budget_exhausted';
/** B1.3 — a harness rollout hook failed (already retried by the caller), or returned a malformed batch. */
export const SKILLOPT_HOOK_INFRA_ERROR = 'skillopt_hook_infra_error';

export function isSkilloptMustAbort(err: unknown): boolean {
  if (isMustAbortError(err) || isAIInvocationPolicyError(err)) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return [SKILLOPT_RUNTIME_EXCEEDED, SKILLOPT_HOOK_BUDGET_EXHAUSTED, SKILLOPT_HOOK_INFRA_ERROR, 'SIGINT'].some((tag) => msg.includes(tag));
}
