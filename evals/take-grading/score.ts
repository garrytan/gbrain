/**
 * Pure grading and summaries for the W6 take-grading eval.
 *
 * A verdict is **applied** when the production auto-resolve rule would apply
 * it: not `unresolvable` and confidence at or above the threshold
 * (`GRADE_TAKES_AUTO_RESOLVE_THRESHOLD`, 0.95). An applied verdict is
 * **wrong** when it differs from the gold label; on a gold-`unresolvable`
 * fixture every applied verdict is wrong. The decision rule bounds the wrong
 * share of applied verdicts with a one-sided 95% Clopper-Pearson interval.
 */
import type { Fixture, Gold, SetName, Split } from './cases.ts';

export type Verdict = Gold;

export interface ResultRow {
  model: string;
  split: Split;
  id: string;
  set: SetName;
  cls: string;
  rule: boolean;
  gold: Gold;
  world_truth: 'correct' | 'incorrect' | null;
  verdict: Verdict | null;
  confidence: number | null;
  /** `parse` (unparseable answer, production retries next cycle) or `unavailable` (provider error after retries). */
  failure: 'parse' | 'unavailable' | null;
  applied: boolean;
  wrong: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  usd: number;
  latency_ms: number;
  reasoning: string | null;
  attempts: number;
  /** The raw answer, kept only for a parse failure. */
  answer_text?: string | null;
}

export const MAX_WRONG_UPPER = 0.01;

export function grade(f: Pick<Fixture, 'gold'>, verdict: Verdict | null, confidence: number | null, threshold: number): { applied: boolean; wrong: boolean } {
  const applied = verdict !== null && verdict !== 'unresolvable' && confidence !== null && confidence >= threshold;
  return { applied, wrong: applied && verdict !== f.gold };
}

function lnChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let s = 0;
  for (let i = 0; i <= k; i++) s += Math.exp(lnChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, s);
}

/** One-sided Clopper-Pearson upper bound on a rate with k events in n trials. */
export function cpUpper(k: number, n: number, alpha = 0.05): number {
  if (n === 0) return 1;
  if (k >= n) return 1;
  let lo = k / n, hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) > alpha) lo = mid; else hi = mid;
  }
  return hi;
}

export interface ModelSummary {
  model: string;
  split: Split;
  rows: number;
  rule_rows: number;
  applied: number;
  wrong: number;
  wrong_upper: number;
  qualifies: boolean;
  /** Applied and right over resolvable gold (correct or incorrect) fixtures in the rule. */
  coverage: number;
  /** Not applied over gold-unresolvable fixtures in the rule. */
  abstention: number;
  no_answer: number;
  usd: number;
  usd_per_call: number;
  latency_p50_ms: number;
  latency_p95_ms: number;
  by_set: Record<string, { n: number; applied: number; wrong: number; verdicts: Record<string, number> }>;
  wrong_ids: string[];
  /** Exploratory: applied verdicts on `world_counterfactual` that match the real outcome over the brain's. */
  world_leak: { n: number; applied: number; follows_world: number };
  /** Exploratory: verdicts on `partial` fixtures. */
  partial: Record<string, number>;
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

export function summarize(rows: ResultRow[]): ModelSummary[] {
  const groups = new Map<string, ResultRow[]>();
  for (const r of rows) {
    const key = `${r.model}\u0000${r.split}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: ModelSummary[] = [];
  for (const group of groups.values()) {
    const ruled = group.filter(r => r.rule);
    const applied = ruled.filter(r => r.applied);
    const wrong = applied.filter(r => r.wrong);
    const resolvable = ruled.filter(r => r.gold === 'correct' || r.gold === 'incorrect');
    const unresolvable = ruled.filter(r => r.gold === 'unresolvable');
    const by_set: ModelSummary['by_set'] = {};
    for (const r of group) {
      const s = (by_set[r.set] ??= { n: 0, applied: 0, wrong: 0, verdicts: {} });
      s.n++;
      if (r.applied) s.applied++;
      if (r.wrong) s.wrong++;
      const v = r.verdict ?? `no_answer:${r.failure}`;
      s.verdicts[v] = (s.verdicts[v] ?? 0) + 1;
    }
    const world = group.filter(r => r.set === 'world_counterfactual');
    const partial: Record<string, number> = {};
    for (const r of group.filter(r => r.set === 'partial')) partial[r.verdict ?? 'no_answer'] = (partial[r.verdict ?? 'no_answer'] ?? 0) + 1;
    const usd = group.reduce((s, r) => s + r.usd, 0);
    const upper = cpUpper(wrong.length, applied.length);
    out.push({
      model: group[0]!.model,
      split: group[0]!.split,
      rows: group.length,
      rule_rows: ruled.length,
      applied: applied.length,
      wrong: wrong.length,
      wrong_upper: upper,
      qualifies: applied.length > 0 && upper <= MAX_WRONG_UPPER,
      coverage: resolvable.length ? resolvable.filter(r => r.applied && !r.wrong).length / resolvable.length : 0,
      abstention: unresolvable.length ? unresolvable.filter(r => !r.applied).length / unresolvable.length : 0,
      no_answer: group.filter(r => r.verdict === null).length,
      usd,
      usd_per_call: group.length ? usd / group.length : 0,
      latency_p50_ms: quantile(group.map(r => r.latency_ms), 0.5),
      latency_p95_ms: quantile(group.map(r => r.latency_ms), 0.95),
      by_set,
      wrong_ids: wrong.map(r => r.id),
      world_leak: { n: world.length, applied: world.filter(r => r.applied).length, follows_world: world.filter(r => r.applied && r.verdict === r.world_truth).length },
      partial,
    });
  }
  return out;
}

/** Qualifying models first, by coverage; ties to the cheaper model. */
export function rank(summaries: ModelSummary[]): ModelSummary[] {
  return [...summaries].sort((a, b) => Number(b.qualifies) - Number(a.qualifies) || b.coverage - a.coverage || a.usd_per_call - b.usd_per_call);
}

