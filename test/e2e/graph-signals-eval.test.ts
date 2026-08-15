/**
 * v0.40.4.0 — Eval gates for graph_signals default-on (T10, D13=A).
 *
 * Three load-bearing gates against longmemeval-mini fixture:
 *
 *   Gate 1 (QUALITY): paired-bootstrap p>=0.05 in the WRONG direction
 *     (signals-on significantly worse than off) → fail. Plus a hard
 *     5pt absolute floor on recall@5 drop as the sanity catch.
 *
 *   Gate 2 (CHANGE-MAGNITUDE): Jaccard@5 >= 0.5 + top-1 stability
 *     >= 0.7. These are NOT quality metrics (codex outside-voice #18 +
 *     #4 caught the framing); their purpose is regression-magnitude
 *     detection — if results overlap less than 50%, the change is too
 *     large and needs human review before shipping default-on.
 *
 *   Gate 3 (HARD ABSOLUTE FLOOR): recall@5 must NOT drop by more than
 *     5 absolute points (catastrophic regression catch).
 *
 * Hermetic via in-memory PGLite seeded from the fixture. No API keys.
 * Skips gracefully when the fixture is missing.
 *
 * Paired bootstrap implementation: 10,000 resamples (D13=A spec).
 * Per-question observation is binary (recall@5 hit/miss); paired
 * pairing is on the same question id across on/off branches. Test
 * statistic: mean(on) - mean(off). p-value is the two-tailed
 * proportion of resamples where the resampled delta is on the
 * opposite side of the observed delta.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  createBenchmarkBrain,
  resetTables,
} from '../../src/eval/longmemeval/harness.ts';
import { haystackToPages, type LongMemEvalQuestion } from '../../src/eval/longmemeval/adapter.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import type { PGLiteEngine } from '../../src/core/pglite-engine.ts';

const FIXTURE_PATH = join(import.meta.dir, '..', 'fixtures', 'longmemeval-mini.jsonl');
const TOP_K = 5;

let engine: PGLiteEngine;

beforeAll(async () => {
  if (!existsSync(FIXTURE_PATH)) return;  // skipped at describe level
  engine = await createBenchmarkBrain();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

// ---------------------------------------------------------------------------
// Run one question with graph_signals on or off; return recall@k hit + top-k
// session IDs (for Jaccard + top-1 stability metrics).
// ---------------------------------------------------------------------------

interface QuestionResult {
  question_id: string;
  hit: boolean;
  session_ids: string[];   // ordered top-K
}

async function runQuestion(
  q: LongMemEvalQuestion,
  graphSignalsOn: boolean,
): Promise<QuestionResult> {
  await resetTables(engine);
  const pages = haystackToPages(q);
  for (const p of pages) {
    await importFromContent(engine, p.slug, p.content, { noEmbed: true });
  }
  // Keyword-only path is most stable on tiny fixtures with no embedder.
  // Use hybridSearch which honors per-call graph_signals override
  // (v0.40.4 — typed field on SearchOpts, threaded into perCall in
  // hybrid.ts via resolveSearchMode chain).
  const results = await hybridSearch(engine, q.question, {
    limit: TOP_K,
    expansion: false,
    graph_signals: graphSignalsOn,
  });
  const sessionIds = uniqSessionIds(results);
  const gt = new Set(q.answer_session_ids ?? []);
  const hit = sessionIds.some(s => gt.has(s));
  return { question_id: q.question_id, hit, session_ids: sessionIds };
}

function uniqSessionIds(results: any[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    // slug is `chat/<session_id>` per adapter.ts.
    const sid = (r.slug ?? '').replace(/^chat\//, '');
    if (sid && !seen.has(sid)) {
      seen.add(sid);
      out.push(sid);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Paired bootstrap (D13=A). Bernoulli observations per question; pairing on
// question_id between on/off branches. Returns two-tailed p-value for the
// null hypothesis "no difference."
// ---------------------------------------------------------------------------

export function pairedBootstrapPValue(
  pairs: Array<{ on: number; off: number }>,  // observed Bernoulli (0/1) per question
  resamples = 10_000,
  rng: () => number = Math.random,
): { pValue: number; observedDelta: number; ci95: [number, number] } {
  const n = pairs.length;
  if (n === 0) return { pValue: 1.0, observedDelta: 0, ci95: [0, 0] };

  const observedDelta = pairs.reduce((s, p) => s + (p.on - p.off), 0) / n;

  // Center the distribution under the null (subtract observed mean to
  // simulate "no real effect"). This is the conventional pairing-aware
  // bootstrap-shift approach for binary outcomes.
  const centered = pairs.map(p => (p.on - p.off) - observedDelta);

  const resampledDeltas: number[] = new Array(resamples);
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n);
      sum += centered[idx];
    }
    resampledDeltas[i] = sum / n;
  }

  // Two-tailed p-value: proportion of resampled |delta| >= observed |delta|.
  const abs = Math.abs(observedDelta);
  let extreme = 0;
  for (const d of resampledDeltas) {
    if (Math.abs(d) >= abs) extreme++;
  }
  const pValue = extreme / resamples;

  // 95% CI on the bootstrap (uncentered) for the observed delta.
  const rawDeltas = pairs.map(p => p.on - p.off);
  const sorted = [...rawDeltas].sort((a, b) => a - b);
  const lowIdx = Math.max(0, Math.floor(0.025 * sorted.length));
  const highIdx = Math.min(sorted.length - 1, Math.ceil(0.975 * sorted.length));
  return {
    pValue,
    observedDelta,
    ci95: [sorted[lowIdx] ?? 0, sorted[highIdx] ?? 0],
  };
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let intersect = 0;
  for (const x of sa) if (sb.has(x)) intersect++;
  const union = sa.size + sb.size - intersect;
  return union === 0 ? 1.0 : intersect / union;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

const fixtureExists = existsSync(FIXTURE_PATH);
const describeFn = fixtureExists ? describe : describe.skip;

describeFn('v0.40.4 — graph_signals eval gates (longmemeval-mini A/B)', () => {
  let questions: LongMemEvalQuestion[];
  let onResults: QuestionResult[];
  let offResults: QuestionResult[];

  beforeAll(async () => {
    if (!fixtureExists) return;
    const raw = readFileSync(FIXTURE_PATH, 'utf8');
    questions = raw.trim().split('\n').map(l => JSON.parse(l));

    // Run each question twice: off, then on. resetTables between runs is
    // handled inside runQuestion.
    offResults = [];
    onResults = [];
    for (const q of questions) {
      offResults.push(await runQuestion(q, false));
      onResults.push(await runQuestion(q, true));
    }
  });

  test('Gate 0: fixture loaded with >=3 questions (sanity)', () => {
    expect(questions.length).toBeGreaterThanOrEqual(3);
  });

  test('Gate 1 (QUALITY): no statistically significant regression in wrong direction', () => {
    // Build paired observations. recall@5 hit = 1 if any retrieved session
    // matches ground truth.
    const pairs = onResults.map((r, i) => ({
      on: r.hit ? 1 : 0,
      off: offResults[i].hit ? 1 : 0,
    }));

    // Deterministic RNG for stable test runs. Linear-congruential.
    let seed = 0xDEADBEEF;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xFFFFFFFF;
    };

    const result = pairedBootstrapPValue(pairs, 10_000, rng);
    // If signals-on is significantly WORSE (delta < 0) AND p < 0.05, fail.
    // If p >= 0.05 either direction OR delta >= 0, pass.
    if (result.pValue < 0.05 && result.observedDelta < 0) {
      throw new Error(
        `Gate 1 FAILED: graph_signals on is significantly worse than off ` +
        `(delta=${result.observedDelta.toFixed(3)}, p=${result.pValue.toFixed(3)}, ` +
        `n=${pairs.length}). Recall@5 dropped meaningfully.`,
      );
    }
    // Log the observed delta for posterity (informational, not assertion).
    if (process.env.GBRAIN_EVAL_VERBOSE) {
      console.log(`Gate 1: observedDelta=${result.observedDelta.toFixed(3)}, p=${result.pValue.toFixed(3)}`);
    }
    expect(true).toBe(true);  // gate passed
  });

  test('Gate 2a (CHANGE-MAGNITUDE): mean Jaccard@5 >= 0.5', () => {
    const jaccards = onResults.map((r, i) => jaccard(r.session_ids, offResults[i].session_ids));
    const mean = jaccards.reduce((s, x) => s + x, 0) / jaccards.length;
    expect(mean).toBeGreaterThanOrEqual(0.5);
  });

  test('Gate 2b (CHANGE-MAGNITUDE): top-1 stability >= 0.7', () => {
    let stable = 0;
    for (let i = 0; i < onResults.length; i++) {
      const onTop = onResults[i].session_ids[0];
      const offTop = offResults[i].session_ids[0];
      if (onTop && offTop && onTop === offTop) stable++;
    }
    const rate = stable / onResults.length;
    expect(rate).toBeGreaterThanOrEqual(0.7);
  });

  test('Gate 3 (HARD ABSOLUTE FLOOR): recall@5 drop <= 5pt', () => {
    const onRecall = onResults.filter(r => r.hit).length / onResults.length;
    const offRecall = offResults.filter(r => r.hit).length / offResults.length;
    const dropPts = (offRecall - onRecall) * 100;
    expect(dropPts).toBeLessThanOrEqual(5);
  });
});

// Always-on tests for the pure bootstrap function — these run even
// without the fixture so the helper has coverage.
describe('pairedBootstrapPValue — pure-function tests', () => {
  test('empty input → p=1.0 (no information)', () => {
    const r = pairedBootstrapPValue([], 100);
    expect(r.pValue).toBe(1.0);
    expect(r.observedDelta).toBe(0);
  });

  test('all pairs equal → delta=0, p large', () => {
    const pairs = Array(50).fill(0).map(() => ({ on: 1, off: 1 }));
    const r = pairedBootstrapPValue(pairs, 1000);
    expect(r.observedDelta).toBe(0);
    expect(r.pValue).toBeGreaterThan(0.5);  // null is true; p should be large
  });

  test('strong positive effect (on always wins) → small p, positive delta', () => {
    const pairs = Array(30).fill(0).map(() => ({ on: 1, off: 0 }));
    let seed = 42;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xFFFFFFFF;
    };
    const r = pairedBootstrapPValue(pairs, 5000, rng);
    expect(r.observedDelta).toBe(1.0);
    expect(r.pValue).toBeLessThan(0.01);
  });

  test('strong negative effect (off always wins) → small p, negative delta', () => {
    const pairs = Array(30).fill(0).map(() => ({ on: 0, off: 1 }));
    let seed = 42;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xFFFFFFFF;
    };
    const r = pairedBootstrapPValue(pairs, 5000, rng);
    expect(r.observedDelta).toBe(-1.0);
    expect(r.pValue).toBeLessThan(0.01);
  });

  test('determinism: same seed → same p-value', () => {
    const pairs = Array(20).fill(0).map((_, i) => ({ on: i % 3 === 0 ? 1 : 0, off: i % 4 === 0 ? 1 : 0 }));
    let s1 = 12345;
    const r1 = pairedBootstrapPValue(pairs, 1000, () => { s1 = (s1 * 1664525 + 1013904223) >>> 0; return s1 / 0xFFFFFFFF; });
    let s2 = 12345;
    const r2 = pairedBootstrapPValue(pairs, 1000, () => { s2 = (s2 * 1664525 + 1013904223) >>> 0; return s2 / 0xFFFFFFFF; });
    expect(r1.pValue).toBe(r2.pValue);
    expect(r1.observedDelta).toBe(r2.observedDelta);
  });
});
