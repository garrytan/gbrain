/**
 * v0.34 pre-w0 — unit tests for the code-retrieval eval harness.
 *
 * Pure-function metrics + loader + gate logic. No engine, no API, no fixture
 * files outside the questions.json checked in alongside the harness.
 */

import { describe, test, expect } from 'bun:test';
import {
  precisionAtK,
  recallAtK,
  top1StabilityRate,
  normalizeRetrieved,
  expandExpectedToRelevantSet,
  isFileRelevant,
  loadQuestions,
  evaluateGate,
  DEFAULT_GATE,
  type EvalRunReport,
  type QuestionResult,
} from '../src/eval/code-retrieval/harness.ts';

describe('precisionAtK', () => {
  test('returns 0 for empty retrieved set', () => {
    expect(precisionAtK([], new Set(['a']), 5)).toBe(0);
  });

  test('returns 1.0 when all top-k are relevant', () => {
    expect(precisionAtK(['a', 'b', 'c'], new Set(['a', 'b', 'c']), 5)).toBe(1);
  });

  test('returns 0 when zero top-k are relevant', () => {
    expect(precisionAtK(['x', 'y'], new Set(['a', 'b']), 5)).toBe(0);
  });

  test('respects the k cutoff (only top-k considered)', () => {
    // top-3 retrieved = ['a','b','c']; relevant = {'a','d'} → 1/3
    expect(precisionAtK(['a', 'b', 'c', 'd', 'e'], new Set(['a', 'd']), 3)).toBeCloseTo(1 / 3);
  });

  test('k larger than retrieved length uses retrieved length', () => {
    // retrieved length 2, k=5 → divide by 2
    expect(precisionAtK(['a', 'b'], new Set(['a']), 5)).toBeCloseTo(1 / 2);
  });
});

describe('recallAtK', () => {
  test('returns 1.0 when relevant is empty (degenerate)', () => {
    expect(recallAtK(['a', 'b'], new Set(), 5)).toBe(1);
  });

  test('returns 1.0 when all relevant are in top-k', () => {
    expect(recallAtK(['a', 'b', 'c'], new Set(['a', 'b']), 5)).toBe(1);
  });

  test('returns 0 when none of relevant are in top-k', () => {
    expect(recallAtK(['x', 'y', 'z'], new Set(['a', 'b']), 5)).toBe(0);
  });

  test('returns half when 1/2 relevant in top-k', () => {
    expect(recallAtK(['a', 'x'], new Set(['a', 'b']), 5)).toBeCloseTo(1 / 2);
  });

  test('respects the k cutoff', () => {
    // top-2 = ['x','y']; relevant = {'a','b'} → recall=0; the third would be 'a' but k=2
    expect(recallAtK(['x', 'y', 'a', 'b'], new Set(['a', 'b']), 2)).toBe(0);
  });
});

describe('top1StabilityRate', () => {
  test('returns 0 for empty runs', () => {
    expect(top1StabilityRate([], [])).toBe(0);
  });

  test('returns 1.0 when all top-1s match', () => {
    const run1 = makeResults([{ id: 'q1', top_1: 'a' }, { id: 'q2', top_1: 'b' }]);
    const run2 = makeResults([{ id: 'q1', top_1: 'a' }, { id: 'q2', top_1: 'b' }]);
    expect(top1StabilityRate(run1, run2)).toBe(1);
  });

  test('returns 0 when no top-1s match', () => {
    const run1 = makeResults([{ id: 'q1', top_1: 'a' }]);
    const run2 = makeResults([{ id: 'q1', top_1: 'x' }]);
    expect(top1StabilityRate(run1, run2)).toBe(0);
  });

  test('ignores questions only in one run', () => {
    const run1 = makeResults([{ id: 'q1', top_1: 'a' }, { id: 'q2', top_1: 'b' }]);
    const run2 = makeResults([{ id: 'q1', top_1: 'a' }]); // missing q2
    // Only q1 is comparable; stable = 1/1 = 1
    expect(top1StabilityRate(run1, run2)).toBe(1);
  });

  test('null top_1 in one run counts as non-stable when other is non-null', () => {
    const run1 = makeResults([{ id: 'q1', top_1: 'a' }]);
    const run2 = makeResults([{ id: 'q1', top_1: null }]);
    expect(top1StabilityRate(run1, run2)).toBe(0);
  });
});

describe('normalizeRetrieved', () => {
  test('dedupes while preserving order', () => {
    expect(normalizeRetrieved(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  test('drops empty strings', () => {
    expect(normalizeRetrieved(['a', '', 'b'])).toEqual(['a', 'b']);
  });
});

describe('expandExpectedToRelevantSet / isFileRelevant', () => {
  test('exact file match', () => {
    const exp = expandExpectedToRelevantSet(['src/foo.ts', 'src/bar.ts']);
    expect(isFileRelevant('src/foo.ts', exp)).toBe(true);
    expect(isFileRelevant('src/baz.ts', exp)).toBe(false);
  });

  test('directory prefix match (trailing slash)', () => {
    const exp = expandExpectedToRelevantSet(['src/core/']);
    expect(isFileRelevant('src/core/foo.ts', exp)).toBe(true);
    expect(isFileRelevant('src/core/sub/bar.ts', exp)).toBe(true);
    expect(isFileRelevant('src/other.ts', exp)).toBe(false);
  });

  test('mixed exact + directory expected', () => {
    const exp = expandExpectedToRelevantSet(['src/foo.ts', 'src/core/']);
    expect(isFileRelevant('src/foo.ts', exp)).toBe(true);
    expect(isFileRelevant('src/core/bar.ts', exp)).toBe(true);
    expect(isFileRelevant('src/other.ts', exp)).toBe(false);
  });
});

describe('loadQuestions', () => {
  test('parses the v0.34 baseline questions.json', () => {
    const file = loadQuestions('src/eval/code-retrieval/questions.json');
    expect(file.version).toBe(1);
    expect(file.corpus).toBe('gbrain');
    expect(file.questions.length).toBeGreaterThanOrEqual(12);
    for (const q of file.questions) {
      expect(q.id).toBeDefined();
      expect(q.kind).toMatch(/^(callers|callees|definition|references|blast_radius|execution_flow|cluster_membership)$/);
      expect(q.query.length).toBeGreaterThan(0);
      expect(q.symbol.length).toBeGreaterThan(0);
      expect(Array.isArray(q.expected_files)).toBe(true);
      expect(q.expected_min_recall).toBeGreaterThanOrEqual(0);
      expect(q.expected_min_recall).toBeLessThanOrEqual(1);
    }
  });

  test('throws on missing file', () => {
    expect(() => loadQuestions('/tmp/does-not-exist-XXXX.json')).toThrow(/not found/);
  });
});

describe('evaluateGate', () => {
  test('PASS when precision delta clears bar AND enough cleared bar', () => {
    const baseline = makeReport('baseline', 0.4, 0.5, 20); // 20 questions, 50% answered
    const withCI = makeReport('with-code-intel', 0.55, 0.85, 20); // +15pp precision, 85% answered
    const gate = evaluateGate(baseline, withCI, {
      required_precision_delta_pp: 10,
      required_top_1_stability_delta: 0.15,
      min_questions_cleared: 15,
    });
    expect(gate.passed).toBe(true);
    expect(gate.precision_delta_pp).toBeCloseTo(15, 5);
  });

  test('FAIL when not enough questions cleared bar (despite precision delta)', () => {
    const baseline = makeReport('baseline', 0.4, 0.5, 30);
    const withCI = makeReport('with-code-intel', 0.6, 0.4, 30); // good precision, fewer answered
    const gate = evaluateGate(baseline, withCI, {
      required_precision_delta_pp: 10,
      required_top_1_stability_delta: 0.15,
      min_questions_cleared: 15,
    });
    expect(gate.passed).toBe(false);
    expect(gate.summary).toContain('only ');
  });

  test('PASS via answered_rate delta even when precision delta is below bar', () => {
    const baseline = makeReport('baseline', 0.4, 0.5, 30);
    const withCI = makeReport('with-code-intel', 0.45, 0.7, 30); // +5pp precision (fail) but +20pp answered (pass)
    const gate = evaluateGate(baseline, withCI, {
      required_precision_delta_pp: 10,
      required_top_1_stability_delta: 0.15,
      min_questions_cleared: 15,
    });
    expect(gate.passed).toBe(true);
  });

  test('default opts match constants', () => {
    expect(DEFAULT_GATE.required_precision_delta_pp).toBe(10);
    expect(DEFAULT_GATE.required_top_1_stability_delta).toBe(0.15);
    expect(DEFAULT_GATE.min_questions_cleared).toBe(15);
  });
});

// ─── helpers ──────────────────────────────────────────────────────────

function makeResults(items: Array<{ id: string; top_1: string | null }>): QuestionResult[] {
  return items.map((it) => ({
    id: it.id,
    kind: 'callers' as const,
    retrieved_files: it.top_1 ? [it.top_1] : [],
    top_1: it.top_1,
    precision_at_k: it.top_1 ? 1 : 0,
    recall_at_k: it.top_1 ? 1 : 0,
    answered: !!it.top_1,
    latency_ms: 1,
  }));
}

function makeReport(
  mode: 'baseline' | 'with-code-intel',
  meanPrecision: number,
  answeredRate: number,
  totalQuestions: number,
): EvalRunReport {
  const answeredCount = Math.round(answeredRate * totalQuestions);
  const questions: QuestionResult[] = [];
  for (let i = 0; i < totalQuestions; i++) {
    questions.push({
      id: `q${i}`,
      kind: 'callers' as const,
      retrieved_files: ['fakefile.ts'],
      top_1: 'fakefile.ts',
      precision_at_k: meanPrecision,
      recall_at_k: 0.5,
      answered: i < answeredCount,
      latency_ms: 1,
    });
  }
  return {
    mode,
    schema_version: 1,
    corpus: 'fake',
    k: 5,
    questions,
    mean_precision_at_k: meanPrecision,
    answered_rate: answeredRate,
    total_latency_ms: totalQuestions,
    captured_at: '2026-05-10T00:00:00Z',
    commit: 'abc1234',
  };
}
