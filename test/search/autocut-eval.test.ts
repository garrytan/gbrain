/**
 * v0.42.3.0 — autocut precision/recall eval gate (in-repo, hermetic).
 *
 * This is the D2 precondition for default-ON, runnable in CI without the
 * sibling gbrain-evals repo and without any API key. It measures the EXACT
 * claim default-ON rests on: does cutting at the rerank-score cliff lift
 * precision WITHOUT regressing recall — especially on enumeration queries?
 *
 * WHAT IT MODELS (and what it does NOT): autocut cuts on cross-encoder
 * rerank scores. This gate feeds applyAutocut labeled qrels fixtures whose
 * per-candidate `rerank_score` follows realistic cross-encoder distributions
 * (clean cliffs for single-answer queries, a high cluster + cliff for
 * enumeration, flat curves for ambiguous breadth, and an adversarial case
 * where the reranker mis-scores a relevant doc below a cliff). It measures
 * the precision/recall tradeoff of the CUT DECISION on those distributions.
 * It does NOT claim that ZeroEntropy's live scores look like these fixtures
 * on a specific brain — that empirical confirmation is the optional
 * gbrain-evals PrecisionMemBench run. What this gate DOES guarantee, in CI:
 *  - autocut lifts mean precision well above the no-autocut baseline,
 *  - it does NOT regress recall below a floor,
 *  - it NEVER regresses recall on enumeration/flat queries (structural:
 *    a flat curve has no cliff, so autocut declines → identical recall).
 *
 * The gate fails (correctly) if someone over-tunes autocut (e.g. drops
 * jumpRatio so low it cuts into clusters) or if the cut math regresses.
 * Floors are env-overridable so an intentional ranking change edits the
 * threshold with a documented reason.
 */

import { describe, expect, test } from 'bun:test';
import { applyAutocut, DEFAULT_AUTOCUT } from '../../src/core/search/autocut.ts';

type Candidate = { rerank_score: number; relevant: boolean };
type EvalQuery = {
  id: string;
  kind: 'single' | 'cluster' | 'enumeration' | 'adversarial';
  /** Candidates in reranked (descending-score) order. */
  candidates: Candidate[];
};

const scoreOf = (c: Candidate) => c.rerank_score;
const LIMIT = 10; // mirrors a typical returned-set cap; doesn't bind these lists

// Realistic cross-encoder distributions. Proportions reflect the empirical
// reality return-policy.ts cites: rank-1 is correct in ~94% of single-answer
// cases, so clean cliffs dominate and adversarial mis-scores are rare.
const FIXTURE: EvalQuery[] = [
  // 5 single-answer queries with a clean cliff after the one right answer.
  ...Array.from({ length: 5 }, (_, i): EvalQuery => ({
    id: `single-${i}`,
    kind: 'single',
    candidates: [
      { rerank_score: 0.95, relevant: true },
      { rerank_score: 0.30, relevant: false },
      { rerank_score: 0.25, relevant: false },
      { rerank_score: 0.20, relevant: false },
      { rerank_score: 0.15, relevant: false },
      { rerank_score: 0.10, relevant: false },
      { rerank_score: 0.08, relevant: false },
      { rerank_score: 0.05, relevant: false },
    ],
  })),
  // 2 cluster queries: a tight relevant cluster, then a cliff to noise.
  ...Array.from({ length: 2 }, (_, i): EvalQuery => ({
    id: `cluster-${i}`,
    kind: 'cluster',
    candidates: [
      { rerank_score: 0.90, relevant: true },
      { rerank_score: 0.88, relevant: true },
      { rerank_score: 0.85, relevant: true },
      { rerank_score: 0.25, relevant: false },
      { rerank_score: 0.20, relevant: false },
      { rerank_score: 0.15, relevant: false },
      { rerank_score: 0.10, relevant: false },
    ],
  })),
  // 2 enumeration/broad queries: flat curve, many relevant, NO cliff.
  // Autocut must DECLINE here — this is the recall-regression risk D2 gates.
  ...Array.from({ length: 2 }, (_, i): EvalQuery => ({
    id: `enumeration-${i}`,
    kind: 'enumeration',
    candidates: [
      { rerank_score: 0.60, relevant: true },
      { rerank_score: 0.58, relevant: true },
      { rerank_score: 0.56, relevant: true },
      { rerank_score: 0.54, relevant: true },
      { rerank_score: 0.52, relevant: true },
      { rerank_score: 0.50, relevant: false },
      { rerank_score: 0.48, relevant: false },
    ],
  })),
  // 1 adversarial query: the reranker mis-scores a relevant doc BELOW an
  // early cliff. Autocut will drop it — this models reranker error, the only
  // way autocut can hurt recall. Kept rare to match real distributions.
  {
    id: 'adversarial-0',
    kind: 'adversarial',
    candidates: [
      { rerank_score: 0.90, relevant: true },
      { rerank_score: 0.50, relevant: true }, // relevant but mis-scored below the cliff
      { rerank_score: 0.48, relevant: false },
      { rerank_score: 0.46, relevant: false },
      { rerank_score: 0.20, relevant: false },
    ],
  },
];

function precisionRecall(kept: Candidate[], totalRelevant: number): { p: number; r: number } {
  const relevantKept = kept.filter((c) => c.relevant).length;
  const p = kept.length === 0 ? 0 : relevantKept / kept.length;
  const r = totalRelevant === 0 ? 1 : relevantKept / totalRelevant;
  return { p, r };
}

function evalQuery(q: EvalQuery, autocutOn: boolean) {
  const totalRelevant = q.candidates.filter((c) => c.relevant).length;
  const pool = autocutOn
    ? applyAutocut(q.candidates, scoreOf, { ...DEFAULT_AUTOCUT }).kept
    : q.candidates;
  const kept = pool.slice(0, LIMIT);
  return precisionRecall(kept, totalRelevant);
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function envFloor(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

describe('autocut eval gate (D2 — precision lift without recall regression)', () => {
  const off = FIXTURE.map((q) => evalQuery(q, false));
  const on = FIXTURE.map((q) => evalQuery(q, true));

  const precisionOff = mean(off.map((x) => x.p));
  const precisionOn = mean(on.map((x) => x.p));
  const recallOff = mean(off.map((x) => x.r));
  const recallOn = mean(on.map((x) => x.r));

  // Surface the numbers (the CHANGELOG/eval record reads these).
  // eslint-disable-next-line no-console
  console.error(
    `[autocut-eval] precision ${precisionOff.toFixed(3)} → ${precisionOn.toFixed(3)} ` +
      `(+${(precisionOn - precisionOff).toFixed(3)}) | recall ${recallOff.toFixed(3)} → ` +
      `${recallOn.toFixed(3)} (${(recallOn - recallOff).toFixed(3)})`,
  );

  // Floors are env-overridable (document the reason in the commit when you move them).
  const LIFT_FLOOR = envFloor('GBRAIN_AUTOCUT_EVAL_PRECISION_LIFT_FLOOR', 0.15);
  const RECALL_FLOOR = envFloor('GBRAIN_AUTOCUT_EVAL_RECALL_FLOOR', 0.9);
  const RECALL_REGRESSION_TOLERANCE = envFloor('GBRAIN_AUTOCUT_EVAL_RECALL_TOLERANCE', 0.1);

  test('autocut lifts mean precision well above baseline', () => {
    expect(precisionOn - precisionOff).toBeGreaterThanOrEqual(LIFT_FLOOR);
  });

  test('autocut keeps mean recall above the floor', () => {
    expect(recallOn).toBeGreaterThanOrEqual(RECALL_FLOOR);
  });

  test('recall regression is bounded', () => {
    expect(recallOff - recallOn).toBeLessThanOrEqual(RECALL_REGRESSION_TOLERANCE);
  });

  test('ZERO recall regression on enumeration/flat queries (the D2 core concern)', () => {
    // Where recall matters most — broad enumeration with no cliff — autocut
    // must decline and return the full set, so recall is identical on/off.
    const enums = FIXTURE.filter((q) => q.kind === 'enumeration');
    expect(enums.length).toBeGreaterThan(0);
    for (const q of enums) {
      const offR = evalQuery(q, false).r;
      const onR = evalQuery(q, true).r;
      expect(onR).toBe(offR);
    }
  });

  test('single-answer queries: precision goes to 1.0 with recall preserved', () => {
    const singles = FIXTURE.filter((q) => q.kind === 'single');
    for (const q of singles) {
      const onPR = evalQuery(q, true);
      expect(onPR.p).toBe(1); // only the right answer returned
      expect(onPR.r).toBe(1); // and it IS the right answer
    }
  });

  test('cluster queries: the whole relevant cluster survives (no over-cut)', () => {
    const clusters = FIXTURE.filter((q) => q.kind === 'cluster');
    for (const q of clusters) {
      // recall stays 1.0 — autocut cuts AFTER the cluster, not into it.
      expect(evalQuery(q, true).r).toBe(1);
    }
  });
});
