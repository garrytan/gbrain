// src/core/remediation/manual-only.ts
// The manual-only remediation policy: jobs an automatic run (onboard --auto,
// doctor --remediate, MCP run_onboard, autopilot) never submits. Kept
// dependency-light so the runner, the onboard renderer and autopilot's policy
// module share one predicate without importing each other.

import type { Action } from '../agent-output.ts';
import type { RemediationStep } from '../remediation-step.ts';

/**
 * Membership is a one-time consenting decision or an LLM-bearing handler
 * without a mature eval. `paid` marks the handler's model spend even when a
 * producer omits a cost estimate.
 */
const MANUAL_ONLY_JOBS: ReadonlyMap<string, { paid: boolean }> = new Map([
  // Takes bootstrap: per-page model classifier over concept/atom/lore pages.
  ['extract-takes-from-pages', { paid: true }],
  // Pack upgrade: retypes pages and switches the active schema pack.
  ['unify-types', { paid: false }],
]);

/** Decided by job name, so a producer that forgets `protected: true` still fails closed. */
export function isManualOnlyStep(step: Pick<RemediationStep, 'job'>): boolean {
  return MANUAL_ONLY_JOBS.has(step.job);
}

/** The user's own command for a skipped manual-only step. */
export function manualOnlyFix(step: Pick<RemediationStep, 'job' | 'params' | 'est_usd_cost'>): Action {
  const paid = (step.est_usd_cost ?? 0) > 0 || MANUAL_ONLY_JOBS.get(step.job)?.paid === true;
  const cost = (step.est_usd_cost ?? 0) > 0 ? ` (estimated $${(step.est_usd_cost ?? 0).toFixed(2)})` : '';
  return {
    argv: ['gbrain', 'jobs', 'submit', step.job, ...(Object.keys(step.params).length ? ['--params', JSON.stringify(step.params)] : []), '--follow'],
    consent: paid ? ['paid'] : [],
    actor: 'user',
    why: `${step.job} is manual-only: automatic runs never submit it, so it runs only when the user submits it${paid ? `; it calls the model provider and costs money${cost}` : ''}.`,
    user_message: `The ${step.job} step was not run automatically. Review it (gbrain onboard --check), then run the command yourself if you want it.`,
    verify: { argv: ['gbrain', 'doctor', '--only', 'brain_score', '--json'] },
    requires_exclusive: false,
  };
}
