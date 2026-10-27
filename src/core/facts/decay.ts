/**
 * v0.31 Hot Memory — confidence decay helper.
 *
 * Single source of truth for the per-kind halflife table. The MCP
 * `_meta.brain_hot_memory` injector and recall's CLI JSON call
 * `effectiveConfidence(fact, now)`; recall's `question` ranking calls
 * `recallConfidence` (decay with a trust floor). Tests pin the table values.
 *
 * Half-lives chosen empirically (per /plan-eng-review halflife-defaults call):
 *   event       7 days  — lunch on Tuesday is meaningless after Tuesday
 *   commitment  90 days — promises hold longer; explicit valid_until overrides
 *   preference  90 days — "doesn't drink coffee" stays useful for a quarter
 *   belief      365 days — opinions decay slow but not infinite
 *   fact        365 days — most factual rows; same as belief by default
 *   idea        365 days — articulated frames/theses age like beliefs
 *
 * Formula: confidence × exp(-age_days / halflife_days). Clamped to [0, 1].
 * If valid_until is set and we're past it, decay returns 0 regardless.
 */

import type { FactRow, FactKind } from '../engine.ts';
import type { TrustTier } from '../trust/tier.ts';

/**
 * Halflife in days per fact kind. Exported as a const so tests can pin
 * the exact table.
 */
export const HALFLIFE_DAYS: Record<FactKind, number> = {
  event: 7,
  commitment: 90,
  preference: 90,
  belief: 365,
  fact: 365,
  idea: 365,
};

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Compute effective confidence for a fact at a given moment.
 *
 *   - If the fact is expired (`expired_at` in the past), returns 0.
 *   - If `valid_until` is set and `now` is past it, returns 0.
 *   - Otherwise: `confidence × exp(-age_days / halflife_days)` clamped to [0,1].
 *
 * Pure function. No side effects. No I/O.
 */
export function effectiveConfidence(fact: FactRow, now: Date = new Date()): number {
  if (fact.expired_at && fact.expired_at.getTime() <= now.getTime()) return 0;
  if (fact.valid_until && fact.valid_until.getTime() <= now.getTime()) return 0;

  const ageMs = now.getTime() - fact.valid_from.getTime();
  if (ageMs < 0) return clamp01(fact.confidence);

  const ageDays = ageMs / MS_PER_DAY;
  const halflife = HALFLIFE_DAYS[fact.kind];
  // exp(-age/halflife) — at age=halflife returns ~0.368.
  const decayed = fact.confidence * Math.exp(-ageDays / halflife);
  return clamp01(decayed);
}

/**
 * #2941: recall `question` ranking weights each admitted fact by how much it
 * deserves to be believed now (`recall.confidence_weighting`, default off).
 * Trust is a floor, not a multiplier: rows the owner stands behind
 * (confirmed, or the owner's own notes) never lose weight to age, so fresh
 * agent-written or external text cannot outrank an older confirmed fact.
 * Every other tier decays from `valid_from` (git-durable on repo brains, a
 * database column on repo-less ones) and carries its tier weight. A
 * writer-dated `fact` row ("founded in 2010") is historical and still true,
 * so it does not decay. Expired or lapsed rows (`include_expired`) weigh 0.
 */
export const TRUST_RECALL_FLOOR: Readonly<Record<TrustTier, number>> = Object.freeze({
  user_confirmed: 1, operator_curated: 1, tool_observed: 0, agent_written: 0, unknown: 0, external_untrusted: 0,
});
export const TRUST_RECALL_WEIGHT: Readonly<Record<TrustTier, number>> = Object.freeze({
  user_confirmed: 1, operator_curated: 1, tool_observed: 0.9, agent_written: 0.8, unknown: 0.8, external_untrusted: 0.6,
});

export type RecallConfidenceFact = Pick<FactRow, 'kind' | 'confidence' | 'valid_from' | 'valid_until' | 'expired_at' | 'trust_tier'>;

/** The [0, 1] belief weight of a fact for recall ranking at `now`; `dated` means the writer supplied `valid_from`. */
export function recallConfidence(fact: RecallConfidenceFact, dated: boolean, now: Date = new Date()): number {
  if (fact.expired_at && fact.expired_at.getTime() <= now.getTime()) return 0;
  if (fact.valid_until && fact.valid_until.getTime() <= now.getTime()) return 0;
  const tier = fact.trust_tier ?? 'unknown';
  const decayed = dated && fact.kind === 'fact' ? clamp01(fact.confidence) : effectiveConfidence(fact as FactRow, now);
  return Math.max(TRUST_RECALL_FLOOR[tier], decayed * TRUST_RECALL_WEIGHT[tier]);
}

/** The ranking multiplier: at most halves a fact's score, so weighting reorders facts and never hides one. */
export const confidenceFactor = (weight: number): number => 0.5 + 0.5 * clamp01(weight);

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}
