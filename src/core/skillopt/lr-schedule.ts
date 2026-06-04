/**
 * SkillOpt LR (learning-rate) schedules.
 *
 * The LR controls the max number of edits per step. Cosine is the default
 * per the SkillOpt paper's ablation (slightly better than linear or constant).
 *
 * All schedules return an INTEGER >= 1 (we always allow at least one edit
 * per step; otherwise the optimizer can never make progress).
 *
 * Pure functions — no side effects, no I/O, fully unit-testable.
 *
 *   LR schedule shapes (visualized for base=4, totalSteps=10):
 *
 *     cosine:   4 4 3 3 3 2 2 2 1 1    (smooth high→low decay)
 *     linear:   4 3 3 3 2 2 2 1 1 1    (monotone descent)
 *     constant: 4 4 4 4 4 4 4 4 4 4    (no decay)
 *
 *   The cosine curve peaks early (more aggressive when the skill is the most
 *   unrefined) and tapers (fewer edits as the skill converges).
 */

/** Floor of all schedules; the LR can never drop below 1. */
const MIN_LR = 1;

/**
 * Cosine-decay schedule. Peaks at `base` for t=1; decays to ~1 by totalSteps.
 *
 * Formula: `0.5 * base * (1 + cos((t-1) * pi / (totalSteps-1)))` rounded
 * up, then clamped to [MIN_LR, base].
 */
export function cosineLr(base: number, t: number, totalSteps: number): number {
  if (base < MIN_LR) return MIN_LR;
  if (totalSteps <= 1) return base;
  const tClamped = Math.max(1, Math.min(t, totalSteps));
  const phase = ((tClamped - 1) * Math.PI) / (totalSteps - 1);
  const raw = 0.5 * base * (1 + Math.cos(phase));
  return Math.max(MIN_LR, Math.min(base, Math.ceil(raw)));
}

/**
 * Linear-decay schedule. Starts at `base` for t=1; ends at MIN_LR for
 * t=totalSteps. Monotonically non-increasing.
 *
 * Formula: `base - (base - MIN_LR) * (t-1) / (totalSteps-1)` rounded up.
 */
export function linearLr(base: number, t: number, totalSteps: number): number {
  if (base < MIN_LR) return MIN_LR;
  if (totalSteps <= 1) return base;
  const tClamped = Math.max(1, Math.min(t, totalSteps));
  const raw = base - ((base - MIN_LR) * (tClamped - 1)) / (totalSteps - 1);
  return Math.max(MIN_LR, Math.min(base, Math.ceil(raw)));
}

/**
 * Constant schedule. Returns `base` every step (clamped to MIN_LR).
 */
export function constantLr(base: number, _t: number, _totalSteps: number): number {
  return Math.max(MIN_LR, base);
}

/** Type alias for the function signature shared by all three schedules. */
export type LrScheduleFn = (base: number, t: number, totalSteps: number) => number;

/** Resolve a schedule name to its function. */
export function resolveLrSchedule(name: 'cosine' | 'linear' | 'constant'): LrScheduleFn {
  switch (name) {
    case 'cosine': return cosineLr;
    case 'linear': return linearLr;
    case 'constant': return constantLr;
  }
}
