// src/core/onboard/render.ts
// v0.41.18.0 (T12). Stable JSON envelope + human renderer for
// `gbrain onboard`. Library-shaped — no console.* / process.exit; CLI
// shell calls these and pipes results to its own output.

import type { RemediationStep } from '../remediation-step.ts';
import type { RemediationPlan } from '../remediation/types.ts';
import type {
  OnboardRecommendation,
  OnboardReport,
} from './types.ts';

/**
 * Translate a RemediationStep into an OnboardRecommendation. Layers the
 * apply_policy + prompt_text + migration_id metadata.
 *
 * Rules of thumb for apply_policy:
 *   - protected job (LLM-bearing) → 'prompt_required' or 'manual_only'
 *     based on job name (takes-bootstrap stays manual_only per A12).
 *   - non-protected (regex, SQL, etc.) → 'auto_apply'.
 */
/**
 * v0.42 (D17): jobs that stay manual_only — autopilot will NOT surface
 * these as auto-apply candidates; user must explicitly run
 * `gbrain onboard --auto-with-prompt` or submit the handler directly.
 *
 * Membership criteria: one-time consenting decisions OR LLM-bearing
 * handlers without a mature eval. Adding a new entry here is a load-
 * bearing choice — confirm the apply_policy posture before commit.
 */
const MANUAL_ONLY_PROTECTED_JOBS: ReadonlySet<string> = new Set([
  // v0.41.18.0 (A12, A24): takes-bootstrap classifier stays manual_only
  // until v0.42.1 lands the 100+-case eval.
  'extract-takes-from-pages',
  // v0.42 (D17): pack-upgrade migration. Taxonomy change is a one-time
  // consenting user decision; autopilot must not auto-flip the schema pack.
  'unify-types',
]);

export function toOnboardRecommendation(step: RemediationStep): OnboardRecommendation {
  let apply_policy: OnboardRecommendation['apply_policy'] = 'auto_apply';
  if (step.protected) {
    // Manual-only allowlist takes precedence; everything else protected
    // is prompt_required (needs --yes but can run via --auto --yes).
    apply_policy = MANUAL_ONLY_PROTECTED_JOBS.has(step.job) ? 'manual_only' : 'prompt_required';
  }
  return {
    ...step,
    apply_policy,
    prompt_text: step.rationale,
    migration_id: step.id,
  };
}

/**
 * Build the stable JSON envelope from a remediation plan. brainId, when
 * available, identifies the brain across runs (consumed by --history
 * cross-runtime joins).
 */
export function buildOnboardReport(
  plan: RemediationPlan,
  opts?: { brainId?: string; history?: OnboardReport['history'] },
): OnboardReport {
  const recs = plan.plan.map(toOnboardRecommendation);
  const summary = {
    total: recs.length,
    auto_eligible: recs.filter((r) => r.apply_policy === 'auto_apply').length,
    prompt_required: recs.filter((r) => r.apply_policy === 'prompt_required').length,
    manual_only: recs.filter((r) => r.apply_policy === 'manual_only').length,
    est_total_usd: plan.est_total_usd_cost,
  };
  return {
    schema_version: 1,
    brain_id: opts?.brainId,
    recommendations: recs,
    summary,
    history: opts?.history,
  };
}

/**
 * Human-readable render (returns string; CLI prints to stdout). Designed
 * for stderr/stdout segregation: the CLI shell prints this on stdout,
 * progress + errors on stderr. Echoes the AskUserQuestion-style
 * "Recommendation + WHY" framing the CEO/Eng review settled on.
 */
export function renderHuman(report: OnboardReport): string {
  const lines: string[] = [];
  lines.push(`Brain onboarding: ${report.summary.total} recommendation(s) found`);
  if (report.summary.total === 0) {
    lines.push('  Brain is at target — nothing to do.');
    return lines.join('\n');
  }
  lines.push(
    `  ${report.summary.auto_eligible} auto-eligible | ` +
    `${report.summary.prompt_required} prompt-required | ` +
    `${report.summary.manual_only} manual-only`,
  );
  if (report.summary.est_total_usd > 0) {
    lines.push(`  Total estimated cost: $${report.summary.est_total_usd.toFixed(2)}`);
  }
  lines.push('');
  for (const r of report.recommendations) {
    const sev = `[${r.severity}]`;
    const policy = r.apply_policy === 'auto_apply' ? '(auto)'
      : r.apply_policy === 'prompt_required' ? '(prompt)'
      : '(manual)';
    const cost = (r.est_usd_cost ?? 0) > 0 ? ` ~$${(r.est_usd_cost ?? 0).toFixed(2)}` : '';
    lines.push(`  ${sev} ${policy} ${r.job}${cost}`);
    lines.push(`    why: ${r.prompt_text ?? r.rationale}`);
  }
  if (report.history && report.history.length > 0) {
    lines.push('');
    lines.push('Recent impact (last 10):');
    for (const h of report.history.slice(0, 10)) {
      const delta = h.delta !== null ? (h.delta > 0 ? `+${h.delta}` : String(h.delta)) : '?';
      lines.push(
        `  ${h.applied_at}  ${h.remediation_id}  ${h.metric_name}: ` +
        `${h.metric_before ?? '?'} → ${h.metric_after ?? '?'} (${delta})`,
      );
    }
  }
  return lines.join('\n');
}
