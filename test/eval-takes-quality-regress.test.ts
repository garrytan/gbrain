/**
 * takes-quality-eval/regress — pure compareReceipts logic.
 */
import { describe, test, expect } from 'bun:test';
import { compareReceipts } from '../src/core/takes-quality-eval/regress.ts';
import type { TakesQualityReceipt } from '../src/core/takes-quality-eval/receipt.ts';

function receipt(opts: {
  overall?: number;
  accuracy?: number;
  attribution?: number;
  corpus_sha8?: string;
  prompt_sha8?: string;
  models_sha8?: string;
  rubric_sha8?: string;
}): TakesQualityReceipt {
  return {
    schema_version: 1,
    ts: '2026-05-09T22:00:00Z',
    rubric_version: 'v1.0',
    rubric_sha8: opts.rubric_sha8 ?? 'rrrr0001',
    corpus: {
      source: 'db', n_takes: 100, slug_prefix: null,
      corpus_sha8: opts.corpus_sha8 ?? 'cccc0001',
    },
    prompt_sha8: opts.prompt_sha8 ?? 'pppp0001',
    models_sha8: opts.models_sha8 ?? 'mmmm0001',
    models: ['openai:gpt-4o'],
    cycles_run: 1,
    successes_per_cycle: [1],
    verdict: 'pass',
    scores: {
      accuracy: { mean: opts.accuracy ?? 7.5, min: 7, max: 8, scores: [], per_model: {} },
      attribution: { mean: opts.attribution ?? 7.5, min: 7, max: 8, scores: [], per_model: {} },
    },
    overall_score: opts.overall ?? 7.5,
    cost_usd: 0.5,
  };
}

describe('compareReceipts — happy paths', () => {
  test('current = prior → no regression', () => {
    const r = receipt({});
    const d = compareReceipts(r, r);
    expect(d.regressed).toBe(false);
    expect(d.overall_delta).toBe(0);
    expect(d.summary).toContain('OK');
  });

  test('current better → no regression', () => {
    const prior = receipt({ overall: 7.0, accuracy: 7.0 });
    const current = receipt({ overall: 7.8, accuracy: 8.0 });
    const d = compareReceipts(current, prior);
    expect(d.regressed).toBe(false);
    expect(d.overall_delta).toBeCloseTo(0.8, 5);
  });
});

describe('compareReceipts — regression detection', () => {
  test('overall drop past threshold → regression', () => {
    const prior = receipt({ overall: 7.5 });
    const current = receipt({ overall: 6.0 });
    const d = compareReceipts(current, prior, { threshold: 0.5 });
    expect(d.regressed).toBe(true);
    expect(d.summary).toContain('REGRESSION');
  });

  test('one dim drop past threshold → regression', () => {
    const prior = receipt({ accuracy: 8.0 });
    const current = receipt({ accuracy: 6.0 });
    const d = compareReceipts(current, prior, { threshold: 0.5 });
    expect(d.regressed).toBe(true);
    expect(d.summary).toContain('accuracy');
  });

  test('drop within threshold → no regression', () => {
    const prior = receipt({ overall: 7.5 });
    const current = receipt({ overall: 7.3 });
    const d = compareReceipts(current, prior, { threshold: 0.5 });
    expect(d.regressed).toBe(false);
  });

  test('threshold honored from opts', () => {
    const prior = receipt({ accuracy: 8.0 });
    const current = receipt({ accuracy: 7.6 });
    expect(compareReceipts(current, prior, { threshold: 0.5 }).regressed).toBe(false);
    expect(compareReceipts(current, prior, { threshold: 0.3 }).regressed).toBe(true);
  });
});

describe('compareReceipts — input drift detection', () => {
  test('different corpus_sha8 → inputs_differ + diff entry', () => {
    const prior = receipt({ corpus_sha8: 'A' });
    const current = receipt({ corpus_sha8: 'B' });
    const d = compareReceipts(current, prior);
    expect(d.inputs_differ).toBe(true);
    expect(d.input_diffs?.[0]).toContain('corpus_sha8');
  });

  test('different rubric_sha8 surfaces in diff (codex #3)', () => {
    const prior = receipt({ rubric_sha8: 'X' });
    const current = receipt({ rubric_sha8: 'Y' });
    const d = compareReceipts(current, prior);
    expect(d.inputs_differ).toBe(true);
    expect(d.input_diffs?.some(s => s.includes('rubric_sha8'))).toBe(true);
  });

  test('input diff alone does NOT mark regressed (informational)', () => {
    const prior = receipt({ corpus_sha8: 'A' });
    const current = receipt({ corpus_sha8: 'B' });
    const d = compareReceipts(current, prior);
    // Informational only: no quality drop, just inputs differ.
    expect(d.regressed).toBe(false);
    expect(d.inputs_differ).toBe(true);
  });
});
