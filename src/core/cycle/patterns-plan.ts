/**
 * #6177: size an in-cycle dream patterns run to the cycle budget.
 *
 * A patterns child at the 100-reflection cap can need about 30 minutes; an
 * in-cycle run with less budget spent tokens and was killed. The phase records
 * each child's cost in the DB-only state key `dream.patterns.last_run`
 * (`{duration_ms, reflections, at, outcome, budget_skips}`; not a user
 * setting: `config set` refuses it and `config unset` resets it), and
 * `planPatternsRun` sizes the next in-cycle run from it before any spend.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import type { PhaseResult } from '../cycle.ts';

export const PATTERNS_LAST_RUN_KEY = 'dream.patterns.last_run';
/** Reflections a first in-cycle run submits with no history (or min_evidence, if larger). */
export const PATTERNS_FIRST_BATCH = 25;
/** Margin over the recorded milliseconds per reflection. */
const MARGIN = 1.25;
/** Consecutive budget skips after which the next cycle probes. */
const PROBE_AFTER_SKIPS = 3;
/** A record older than this no longer predicts cost; the next cycle probes. */
const STALE_MS = 7 * 86_400_000;

export interface PatternsLastRun {
  duration_ms: number;
  /** Reflections the child was given. */
  reflections: number;
  /** ISO time the child ended. */
  at: string;
  /** `timeout` = the child was still running at its budget, so duration is a lower bound. */
  outcome: 'completed' | 'timeout' | 'failed';
  /** In-cycle runs skipped for budget since this child. */
  budget_skips: number;
}

export type PatternsPlan =
  | { kind: 'submit'; n: number; basis: 'full' | 'first_batch' | 'history' | 'probe' }
  | { kind: 'skip'; reason: 'budget_below_recent_runtime'; n: number };

/**
 * Pure. `budgetMs` null = a direct run with no cycle deadline: full size.
 * With history, n = budget / (ms per reflection × 1.25); a timed-out run is a
 * lower bound on cost, so the next submission is also at most half of it.
 * With no usable history (none, or a failed child), a conservative first
 * batch. Three budget skips or a week-old record decay to a min_evidence
 * probe, so the planner cannot skip forever. Below min_evidence it skips.
 */
export function planPatternsRun(input: { budgetMs: number | null; lastRun: PatternsLastRun | null; reflections: number;
  minEvidence: number; nowMs: number }): PatternsPlan {
  const { budgetMs, lastRun, reflections, minEvidence } = input;
  if (budgetMs === null) return { kind: 'submit', n: reflections, basis: 'full' };
  if (!lastRun || lastRun.outcome === 'failed' || lastRun.reflections <= 0) {
    return { kind: 'submit', n: Math.min(reflections, Math.max(PATTERNS_FIRST_BATCH, minEvidence)), basis: 'first_batch' };
  }
  const age = input.nowMs - Date.parse(lastRun.at);
  if (lastRun.budget_skips >= PROBE_AFTER_SKIPS || !(age <= STALE_MS)) {
    return { kind: 'submit', n: Math.min(reflections, minEvidence), basis: 'probe' };
  }
  const msPerReflection = Math.max(1, lastRun.duration_ms / lastRun.reflections) * MARGIN;
  let n = Math.min(reflections, Math.floor(budgetMs / msPerReflection));
  if (lastRun.outcome === 'timeout') n = Math.min(n, Math.floor(lastRun.reflections / 2));
  return n < minEvidence ? { kind: 'skip', reason: 'budget_below_recent_runtime', n } : { kind: 'submit', n, basis: 'history' };
}

/** The recorded last run, or null when unset or unreadable. */
export async function readPatternsLastRun(engine: BrainEngine): Promise<PatternsLastRun | null> {
  try {
    const value = JSON.parse((await engine.getConfig(PATTERNS_LAST_RUN_KEY)) ?? '') as Partial<PatternsLastRun>;
    if (typeof value.duration_ms !== 'number' || typeof value.reflections !== 'number' || typeof value.at !== 'string') return null;
    const outcome = value.outcome === 'completed' || value.outcome === 'timeout' ? value.outcome : 'failed';
    return { duration_ms: value.duration_ms, reflections: value.reflections, at: value.at, outcome, budget_skips: Number(value.budget_skips) || 0 };
  } catch {
    return null;
  }
}

/** Record a child's cost; any end other than completed or timeout is `failed`. */
export async function recordPatternsLastRun(engine: BrainEngine, run: { duration_ms: number; reflections: number; outcome: string }): Promise<void> {
  const outcome: PatternsLastRun['outcome'] = run.outcome === 'completed' || run.outcome === 'timeout' ? run.outcome : 'failed';
  const record: PatternsLastRun = { duration_ms: run.duration_ms, reflections: run.reflections, at: new Date().toISOString(), outcome, budget_skips: 0 };
  await engine.setConfig(PATTERNS_LAST_RUN_KEY, JSON.stringify(record)).catch(() => undefined);
}

export async function recordPatternsBudgetSkip(engine: BrainEngine, lastRun: PatternsLastRun): Promise<void> {
  await engine.setConfig(PATTERNS_LAST_RUN_KEY, JSON.stringify({ ...lastRun, budget_skips: lastRun.budget_skips + 1 })).catch(() => undefined);
}

/** The skip's next step: a direct run has no cycle deadline, so it is not sized, and records last_run when it ends. */
export function patternsBudgetSkipFix(): Action {
  return {
    argv: ['gbrain', 'dream', '--phase', 'patterns'], consent: ['paid'], actor: 'agent', requires_exclusive: false,
    why: 'A direct run is not limited by the cycle budget and records its cost for the next cycle. It is a paid model run, so ask the user first. To forget the recorded cost instead: gbrain config unset dream.patterns.last_run',
    docs: 'docs/guides/dream-patterns.md#budget-sizing',
  };
}

/**
 * The phase's sizing step: plan from the recorded last run, or the budget
 * skip result (the skip is counted toward the probe, nothing is submitted).
 */
export async function sizePatternsRun(engine: BrainEngine, input: { budgetMs: number | null; reflections: number; minEvidence: number }):
  Promise<{ kind: 'submit'; plan: Extract<PatternsPlan, { kind: 'submit' }> } | { kind: 'skip'; result: PhaseResult }> {
  const lastRun = await readPatternsLastRun(engine);
  const plan = planPatternsRun({ ...input, lastRun, nowMs: Date.now() });
  if (plan.kind === 'submit') return { kind: 'submit', plan };
  if (lastRun) await recordPatternsBudgetSkip(engine, lastRun);
  const budgetMs = input.budgetMs ?? 0;
  return { kind: 'skip', result: { phase: 'patterns', status: 'skipped', duration_ms: 0,
    summary: `patterns: the ${Math.round(budgetMs / 1000)}s cycle budget fits ${plan.n} of ${input.reflections} reflections ` +
      `at the recorded runtime (need ≥${input.minEvidence}); nothing was submitted. Run it outside the cycle: gbrain dream --phase patterns`,
    details: { reason: 'insufficient_cycle_budget', cause: plan.reason, reflections_selected: input.reflections,
      reflections_submitted: 0, reflections_fit: plan.n, budget_ms: budgetMs, last_run: lastRun,
      fix: patternsBudgetSkipFix(), reset_command: `gbrain config unset ${PATTERNS_LAST_RUN_KEY}` } } };
}
