/**
 * scorer.ts — pure scoring for the takes-bootstrap classifier eval (H1 /
 * TODOS TODO-E). No I/O, no gateway imports: unit-testable keyless.
 *
 * Contract (test-gap plan, CEO Finding 6): a fixture whose model output was
 * malformed/unparseable counts as a FAILURE (`malformed`), never a skip — a
 * skip would silently shrink the denominator.
 *
 * Graduation (SCORER_VERSION 1): per-kind precision >= 0.80 AND per-kind
 * recall >= 0.70 (kinds with zero expected instances are exempt from recall),
 * zero malformed cases, forbid-violations = 0. Autopilot tier for
 * takes-bootstrap stays manual_only until a LIVE run passes this bar
 * (TODOS.md TODO-E); loosening the bar is a reviewer-visible edit here.
 */

export const SCORER_VERSION = 1;
export const GRADUATION = { minPrecision: 0.8, minRecall: 0.7 } as const;

export type TakeKindLabel = 'fact' | 'take' | 'bet' | 'hunch';

export interface CorpusCase {
  id: string;
  category: string;
  page: { slug: string; type: string; title: string; body: string };
  expected: Array<{ claim_re: string; kind: TakeKindLabel; weight_min: number; weight_max: number }>;
  forbid: string[];
  notes: string;
}

export interface CasePrediction {
  id: string;
  /** null = the classifier produced no parseable output for this case. */
  claims: Array<{ claim: string; kind: string; weight: number }> | null;
}

export interface KindScore {
  kind: TakeKindLabel;
  expected: number;
  matched: number;      // expected instances matched by >=1 prediction (recall numerator)
  predicted: number;
  precise: number;      // predictions that satisfy >=1 expected (precision numerator)
  precision: number;    // 1 when predicted === 0
  recall: number;       // 1 when expected === 0
}

export interface ScoreReport {
  scorer_version: number;
  cases: number;
  malformed: string[];          // case ids with claims === null — FAILURES
  forbid_violations: Array<{ id: string; forbid_re: string; claim: string }>;
  by_kind: KindScore[];
  overall: { precision: number; recall: number; f1: number };
  graduated: boolean;
  failures: string[];           // human-readable reasons graduation failed
}

const KINDS: TakeKindLabel[] = ['fact', 'take', 'bet', 'hunch'];

export function scoreCorpus(corpus: CorpusCase[], predictions: CasePrediction[]): ScoreReport {
  const predById = new Map(predictions.map(p => [p.id, p]));
  const malformed: string[] = [];
  const forbidViolations: ScoreReport['forbid_violations'] = [];
  const tally = new Map<TakeKindLabel, { expected: number; matched: number; predicted: number; precise: number }>(
    KINDS.map(k => [k, { expected: 0, matched: 0, predicted: 0, precise: 0 }]),
  );

  for (const c of corpus) {
    const pred = predById.get(c.id);
    // Missing prediction row OR null claims = malformed = FAILURE, never skip.
    if (!pred || pred.claims === null) {
      malformed.push(c.id);
      for (const e of c.expected) tally.get(e.kind)!.expected += 1; // still owed
      continue;
    }
    const claims = pred.claims;

    for (const forbidRe of c.forbid) {
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- the pattern comes from the COMMITTED corpus (evals/takes-bootstrap/corpus.jsonl, reviewed in PRs and validated by test/eval-takes-bootstrap.test.ts's regex-compiles check), never from runtime user input; the eval harness is an offline instrument
      const re = new RegExp(forbidRe, 'i');
      for (const cl of claims) {
        if (re.test(cl.claim)) forbidViolations.push({ id: c.id, forbid_re: forbidRe, claim: cl.claim });
      }
    }

    for (const e of c.expected) {
      const t = tally.get(e.kind)!;
      t.expected += 1;
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- corpus-committed pattern, same rationale as the forbid loop above
      const re = new RegExp(e.claim_re, 'i');
      const hit = claims.some(cl =>
        cl.kind === e.kind && re.test(cl.claim) && cl.weight >= e.weight_min && cl.weight <= e.weight_max,
      );
      if (hit) t.matched += 1;
    }

    for (const cl of claims) {
      const kind = (KINDS as string[]).includes(cl.kind) ? (cl.kind as TakeKindLabel) : null;
      if (!kind) continue; // parseClaimsJson already filters; unknown kinds count nowhere
      const t = tally.get(kind)!;
      t.predicted += 1;
      // Precision credit: matches any expected of the same kind by regex
      // (weight range NOT required for precision — a right claim with an
      // off-range weight is a recall miss, not a hallucination).
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- corpus-committed pattern, same rationale as the forbid loop above
      const ok = c.expected.some(e => e.kind === kind && new RegExp(e.claim_re, 'i').test(cl.claim));
      if (ok) t.precise += 1;
    }
  }

  const byKind: KindScore[] = KINDS.map(kind => {
    const t = tally.get(kind)!;
    return {
      kind, ...t,
      precision: t.predicted === 0 ? 1 : t.precise / t.predicted,
      recall: t.expected === 0 ? 1 : t.matched / t.expected,
    };
  });

  const totals = byKind.reduce(
    (a, k) => ({ expected: a.expected + k.expected, matched: a.matched + k.matched, predicted: a.predicted + k.predicted, precise: a.precise + k.precise }),
    { expected: 0, matched: 0, predicted: 0, precise: 0 },
  );
  const precision = totals.predicted === 0 ? 1 : totals.precise / totals.predicted;
  const recall = totals.expected === 0 ? 1 : totals.matched / totals.expected;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const failures: string[] = [];
  if (malformed.length > 0) failures.push(`${malformed.length} malformed case(s): ${malformed.slice(0, 5).join(', ')}${malformed.length > 5 ? ', …' : ''}`);
  if (forbidViolations.length > 0) failures.push(`${forbidViolations.length} forbid violation(s) (attribution/injection leaks)`);
  for (const k of byKind) {
    if (k.predicted > 0 && k.precision < GRADUATION.minPrecision) failures.push(`${k.kind} precision ${k.precision.toFixed(3)} < ${GRADUATION.minPrecision}`);
    if (k.expected > 0 && k.recall < GRADUATION.minRecall) failures.push(`${k.kind} recall ${k.recall.toFixed(3)} < ${GRADUATION.minRecall}`);
  }

  return {
    scorer_version: SCORER_VERSION,
    cases: corpus.length,
    malformed,
    forbid_violations: forbidViolations,
    by_kind: byKind,
    overall: { precision, recall, f1 },
    graduated: failures.length === 0,
    failures,
  };
}
