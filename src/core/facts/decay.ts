/**
 * v0.31 Hot Memory — confidence decay helper.
 *
 * Single source of truth for the per-kind halflife table. Recall, supersession
 * audit, facts_health, and the MCP `_meta.brain_hot_memory` injector all call
 * `effectiveConfidence(fact, now)`. Tests pin the table values.
 *
 * Half-lives chosen empirically (per /plan-eng-review halflife-defaults call):
 *   event       7 days  — lunch on Tuesday is meaningless after Tuesday
 *   commitment  90 days — promises hold longer; explicit valid_until overrides
 *   preference  90 days — "doesn't drink coffee" stays useful for a quarter
 *   belief      365 days — opinions decay slow but not infinite
 *   fact        365 days — most factual rows; same as belief by default
 *
 * Formula: confidence × exp(-age_days / halflife_days). Clamped to [0, 1].
 * If valid_until is set and we're past it, decay returns 0 regardless.
 */

import type { FactRow, FactKind } from '../engine.ts';

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

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}
