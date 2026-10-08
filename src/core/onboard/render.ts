// src/core/onboard/render.ts
// v0.41.18.0 (T12). Stable JSON envelope + human renderer for
// `gbrain onboard`. Library-shaped — no console.* / process.exit; CLI
// shell calls these and pipes results to its own output.

import type { RemediationStep } from '../remediation-step.ts';
import type { RemediationPlan } from '../remediation/types.ts';
import { isManualOnlyStep } from '../remediation/manual-only.ts';
import type {
  OnboardRecommendation,
  OnboardReport,
} from './types.ts';

/**
 * Translate a RemediationStep into an OnboardRecommendation. Layers the
 * apply_policy + prompt_text + migration_id metadata.
 *
 * apply_policy: a manual-only job (`isManualOnlyStep`, decided by job name,
 * the same predicate the runner enforces) is 'manual_only'; any other
 * protected job is 'prompt_required'; everything else is 'auto_apply'.
 */
export function toOnboardRecommendation(step: RemediationStep): OnboardRecommendation {
  const apply_policy: OnboardRecommendation['apply_policy'] = isManualOnlyStep(step) ? 'manual_only'
    : step.protected ? 'prompt_required' : 'auto_apply';
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
