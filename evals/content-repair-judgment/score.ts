/**
 * Scoring for the content-repair judgment eval (#6377, plan section 4).
 * Pure functions.
 *
 * Each result row holds the model's coded verdict for one fixture pair in
 * one run (or the failure class when it gave none). `grade` reads it against
 * the fixture's expected set:
 * - `best`: the correct answer (`merge_into` with the right canonical on a
 *   true duplicate, `remove_slug` on a stray or adversarial pair,
 *   `needs_human` on an ambiguous pair).
 * - `acceptable`: safe but costs a repair (`needs_human` anywhere it is not
 *   best).
 * - `hard_failure`: an answer that would damage the brain: `remove_slug` on
 *   a true duplicate (a second page for one thing), `merge_into` on a stray
 *   or adversarial pair (two things become one) or into the wrong canonical.
 * - `guess`: `merge_into` or `remove_slug` on an ambiguous pair; reported,
 *   outside the rule.
 * - `no_answer`: no usable verdict (malformed, truncated, refused,
 *   unavailable); the hold stays, so it is safe, and it is reported apart.
 *
 * Preregistered (PREREGISTRATION.md): a model qualifies with zero hard
 * failures over its runs and at least 80% `merge_into` with the right
 * canonical over true-duplicate pair runs. Ranking: qualifying models first,
 * by true-duplicate accuracy, ties to the cheaper model (USD per pair run).
 */
import { quantile, wilson } from '../fence-repair-tier3/score.ts';
import type { Answer, Fixture } from './generate-fixtures.ts';

export const SCORER_VERSION = 1;

export type Verdict = { action: 'remove_slug' } | { action: 'merge_into'; canonical: string } | { action: 'needs_human' };
export type Grade = 'best' | 'acceptable' | 'guess' | 'hard_failure' | 'no_answer';

export interface ResultRow {
  model: string;
  run: number;
  id: string;
  set: Fixture['set'];
  cls: Fixture['cls'];
  tags: string[];
  verdict: Verdict | null;
  /** The failure class when there is no verdict (`llm_malformed`, `llm_truncated`, `llm_refused`, `llm_empty`, `llm_unavailable`). */
  failure: string | null;
  grade: Grade;
  input_tokens: number | null;
  output_tokens: number | null;
  usd: number;
  latency_ms: number;
  stop: string | null;
  text: string | null;
  attempts: number;
}

export function grade(f: Pick<Fixture, 'set' | 'canonical' | 'expected'>, verdict: Verdict | null): Grade {
  if (!verdict) return 'no_answer';
  if (verdict.action === 'merge_into' && f.set === 'true_duplicate') return verdict.canonical === f.canonical ? 'best' : 'hard_failure';
  const answer: Answer = verdict.action;
  if (f.expected.hard.includes(answer)) return 'hard_failure';
  if (f.expected.best.includes(answer)) return 'best';
  if (f.expected.acceptable.includes(answer)) return 'acceptable';
  return 'guess';
}

interface SetCounts { n: number; by_action: Record<Answer | 'none', number>; best: number; acceptable: number; hard_failures: number; guesses: number; no_answer: number }

export interface ModelSummary {
  model: string;
  runs: number;
  n: number;
  hard_failures: number;
  /** Fixture id → how many of its runs were hard failures. */
  hard_failure_ids: Record<string, number>;
  true_duplicate: SetCounts & { merge_canonical: number; accuracy: number; accuracy_ci: [number, number] | null; wrong_canonical: number; per_run_accuracy: number[] };
  stray_slug: SetCounts;
  adversarial: SetCounts;
  ambiguous: SetCounts;
  /** `needs_human` answers over every pair run. */
  needs_human_rate: number;
  no_answer: { n: number; by_failure: Record<string, number> };
  cost: { usd_total: number; usd_per_pair: number; input_tokens: number; output_tokens: number };
  latency_ms: { p50: number | null; p95: number | null };
}

function setCounts(rows: readonly ResultRow[]): SetCounts {
  const by_action: SetCounts['by_action'] = { merge_into: 0, remove_slug: 0, needs_human: 0, none: 0 };
  for (const r of rows) by_action[r.verdict?.action ?? 'none']++;
  const count = (g: Grade) => rows.filter(r => r.grade === g).length;
  return { n: rows.length, by_action, best: count('best'), acceptable: count('acceptable'), hard_failures: count('hard_failure'), guesses: count('guess'), no_answer: count('no_answer') };
}

export function summarize(rows: readonly ResultRow[]): ModelSummary[] {
  const models = [...new Set(rows.map(r => r.model))];
  return models.map(model => {
    const mine = rows.filter(r => r.model === model);
    const runs = [...new Set(mine.map(r => r.run))].sort((a, b) => a - b);
    const td = mine.filter(r => r.set === 'true_duplicate');
    const mergeCanonical = td.filter(r => r.grade === 'best').length;
    const hardIds: Record<string, number> = {};
    for (const r of mine.filter(r => r.grade === 'hard_failure')) hardIds[r.id] = (hardIds[r.id] ?? 0) + 1;
    const byFailure: Record<string, number> = {};
    for (const r of mine.filter(r => r.grade === 'no_answer')) byFailure[r.failure ?? 'unknown'] = (byFailure[r.failure ?? 'unknown'] ?? 0) + 1;
    const usd = mine.reduce((s, r) => s + r.usd, 0);
    return {
      model, runs: runs.length, n: mine.length,
      hard_failures: Object.values(hardIds).reduce((s, k) => s + k, 0), hard_failure_ids: hardIds,
      true_duplicate: { ...setCounts(td), merge_canonical: mergeCanonical, accuracy: td.length ? mergeCanonical / td.length : 0, accuracy_ci: wilson(mergeCanonical, td.length),
        wrong_canonical: td.filter(r => r.verdict?.action === 'merge_into' && r.grade === 'hard_failure').length,
        per_run_accuracy: runs.map(run => { const x = td.filter(r => r.run === run); return x.length ? x.filter(r => r.grade === 'best').length / x.length : 0; }) },
      stray_slug: setCounts(mine.filter(r => r.set === 'stray_slug')),
      adversarial: setCounts(mine.filter(r => r.set === 'adversarial')),
      ambiguous: setCounts(mine.filter(r => r.set === 'ambiguous')),
      needs_human_rate: mine.length ? mine.filter(r => r.verdict?.action === 'needs_human').length / mine.length : 0,
      no_answer: { n: mine.filter(r => r.grade === 'no_answer').length, by_failure: byFailure },
      cost: { usd_total: usd, usd_per_pair: mine.length ? usd / mine.length : 0, input_tokens: mine.reduce((s, r) => s + (r.input_tokens ?? 0), 0), output_tokens: mine.reduce((s, r) => s + (r.output_tokens ?? 0), 0) },
      latency_ms: { p50: quantile(mine.map(r => r.latency_ms), 0.5), p95: quantile(mine.map(r => r.latency_ms), 0.95) },
    };
  });
}

/** The preregistered decision rule for one model's summary. */
export const DECISION = { maxHardFailures: 0, minTrueDuplicateAccuracy: 0.8 } as const;
export function meetsRule(s: ModelSummary): boolean {
  return s.hard_failures <= DECISION.maxHardFailures && s.true_duplicate.accuracy >= DECISION.minTrueDuplicateAccuracy;
}

/** Qualifying models first; within a group by true-duplicate accuracy, ties (equal accuracy) to the cheaper model. */
export function rank(summaries: readonly ModelSummary[]): ModelSummary[] {
  return [...summaries].sort((a, b) => Number(meetsRule(b)) - Number(meetsRule(a)) || b.true_duplicate.accuracy - a.true_duplicate.accuracy || a.cost.usd_per_pair - b.cost.usd_per_pair);
}
