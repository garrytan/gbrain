// src/core/remediation/plan.ts
// v0.41.18.0 (A1, codex finding #2). Extracted from doctor.ts:runRemediationPlan
// so onboard + MCP run_onboard call the same library without parsing argv
// or invoking console.* / process.exit.

import type { BrainEngine } from '../engine.ts';
import {
  computeRecommendations,
  classifyChecks,
  maxReachableScore,
} from '../brain-score-recommendations.ts';
import { loadRecommendationContext } from './context.ts';
import type { RemediationPlan, RemediationPlanOpts } from './types.ts';

/**
 * Synthetic check list for classification. computeRecommendations operates
 * on BrainHealth + context alone; we don't need full doctor output, just
 * the check names the recommendations care about. Same five names doctor
 * has used since v0.36.4.0; do not extend without also updating
 * brain-score-recommendations.ts.
 */
export const SYNTHETIC_CHECK_NAMES = [
  'brain_score',
  'sync_freshness',
  'missing_embeddings',
  'dead_links',
  'orphan_pages',
] as const;

/**
 * Pure read: compute the dependency-ordered Remediation plan to drive
 * brain to opts.targetScore (default 90). Never enqueues, never mutates.
 *
 * Consumed by:
 *   - gbrain doctor --remediation-plan (renders human/JSON in CLI shell)
 *   - gbrain onboard --check (reframes as onboarding language)
 *   - MCP run_onboard (admin scope, returns plan as JSON envelope)
 */
export async function computeRemediationPlan(
  engine: BrainEngine,
  opts: RemediationPlanOpts = {},
): Promise<RemediationPlan> {
  const targetScore = opts.targetScore ?? 90;

  // Cheap path (D7) — don't run slow doctor checks for the plan surface.
  // The recommendation generator works from BrainHealth + context alone.
  const health = await engine.getHealth();
  const ctx = await loadRecommendationContext(engine);
  const recs = computeRecommendations(health, ctx, opts.extraRemediations ?? []);
  const syntheticChecks = SYNTHETIC_CHECK_NAMES.map((name) => ({
    name,
    status: 'ok' as const,
  }));
  const classifications = classifyChecks(syntheticChecks, ctx);
  const ceiling = maxReachableScore(health, classifications);

  const filteredRecs = recs.filter((r) => r.status === 'remediable');
  const estTotalSeconds = filteredRecs.reduce((sum, r) => sum + r.est_seconds, 0);
  const estTotalUsd = filteredRecs.reduce((sum, r) => sum + (r.est_usd_cost ?? 0), 0);

  const blocked = classifications
    .filter((c) => c.status === 'blocked')
    .map((c) => ({ check: c.check, reason: c.reason ?? 'prerequisite missing' }));

  return {
    schema_version: 2,
    brain_score_current: health.brain_score,
    brain_score_target: targetScore,
    max_reachable_score: ceiling,
    target_unreachable: targetScore > ceiling,
    plan: filteredRecs.map((r, i) => ({ step: i + 1, ...r })),
    est_total_seconds: estTotalSeconds,
    est_total_usd_cost: Number(estTotalUsd.toFixed(2)),
    blocked,
  };
}
