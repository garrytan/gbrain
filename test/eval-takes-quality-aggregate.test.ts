/**
 * takes-quality-eval/aggregate — verdict logic tests.
 *
 * Covers the 4 verdict branches plus the codex review #5 strict-required-dim
 * regression guard. The cross-modal-eval v1 pattern took the union of
 * whatever-parsed dimensions; this v0.32 aggregator demands ALL 5 declared
 * dims per contributing model.
 */
import { describe, test, expect } from 'bun:test';
import { aggregate, type SlotResult } from '../src/core/takes-quality-eval/aggregate.ts';
import { RUBRIC_DIMENSIONS } from '../src/core/takes-quality-eval/rubric.ts';
import type { ParsedModelResult } from '../src/core/eval-shared/json-repair.ts';

function fullScores(values: Partial<Record<typeof RUBRIC_DIMENSIONS[number], number>>): ParsedModelResult {
  const scores: ParsedModelResult['scores'] = {};
  for (const dim of RUBRIC_DIMENSIONS) {
    const score = values[dim] ?? 7;
    scores[dim] = { score };
  }
  return { scores, improvements: [] };
}

function ok(modelId: string, parsed: ParsedModelResult): SlotResult {
  return { ok: true, modelId, parsed };
}
function fail(modelId: string, error: string): SlotResult {
  return { ok: false, modelId, error };
}

describe('aggregate — happy paths', () => {
  test('all 3 models complete + every dim mean ≥ 7 → PASS', () => {
    const r = aggregate({
      slots: [ok('a', fullScores({})), ok('b', fullScores({})), ok('c', fullScores({}))],
    });
    expect(r.verdict).toBe('pass');
    expect(r.successes).toBe(3);
    expect(r.failures).toBe(0);
    expect(r.overall).toBeGreaterThanOrEqual(7);
  });

  test('PASS includes every declared dim in scores', () => {
    const r = aggregate({
      slots: [ok('a', fullScores({})), ok('b', fullScores({}))],
    });
    expect(r.verdict).toBe('pass');
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(r.dimensions[dim]).toBeDefined();
    }
  });

  test('overall is mean of dim means', () => {
    const r = aggregate({
      slots: [
        ok('a', fullScores({ accuracy: 8, attribution: 8, weight_calibration: 8, kind_classification: 8, signal_density: 8 })),
        ok('b', fullScores({ accuracy: 8, attribution: 8, weight_calibration: 8, kind_classification: 8, signal_density: 8 })),
      ],
    });
    expect(r.overall).toBe(8.0);
  });
});

describe('aggregate — FAIL branches', () => {
  test('one dim mean < 7 → FAIL', () => {
    const r = aggregate({
      slots: [
        ok('a', fullScores({ accuracy: 5 })),
        ok('b', fullScores({ accuracy: 6 })),
      ],
    });
    expect(r.verdict).toBe('fail');
    expect(r.dimensions.accuracy.failReason).toBe('mean_below_7');
  });

  test('one dim min < 5 (even with mean >= 7) → FAIL', () => {
    const r = aggregate({
      slots: [
        ok('a', fullScores({ accuracy: 9 })),
        ok('b', fullScores({ accuracy: 9 })),
        ok('c', fullScores({ accuracy: 4 })),
      ],
    });
    expect(r.verdict).toBe('fail');
    expect(r.dimensions.accuracy.failReason).toBe('min_below_5');
  });

  test('FAIL message names the failing dim + threshold', () => {
    const r = aggregate({
      slots: [ok('a', fullScores({ attribution: 5 })), ok('b', fullScores({ attribution: 5 }))],
    });
    expect(r.verdictMessage).toContain('attribution');
    expect(r.verdictMessage).toContain('mean=5');
  });
});

describe('aggregate — INCONCLUSIVE branches', () => {
  test('< 2 models contribute → INCONCLUSIVE', () => {
    const r = aggregate({
      slots: [
        ok('a', fullScores({})),
        fail('b', 'timeout'),
        fail('c', 'parse_failed'),
      ],
    });
    expect(r.verdict).toBe('inconclusive');
    expect(r.successes).toBe(1);
    expect(r.failures).toBe(2);
  });

  test('all 3 models failed → INCONCLUSIVE (not silent PASS — cross-modal v1 regression guard)', () => {
    const r = aggregate({
      slots: [fail('a', 'x'), fail('b', 'y'), fail('c', 'z')],
    });
    expect(r.verdict).toBe('inconclusive');
    expect(r.dimensions).toEqual({});
    expect(r.overall).toBeUndefined();
  });
});

describe('aggregate — codex review #5: strict required-dim enforcement', () => {
  test('model missing one dim → contribution dropped, treated as failure', () => {
    const partial: ParsedModelResult = {
      scores: {
        accuracy: { score: 9 },
        attribution: { score: 9 },
        // weight_calibration MISSING
        kind_classification: { score: 9 },
        signal_density: { score: 9 },
      },
      improvements: [],
    };
    const r = aggregate({
      slots: [
        ok('a', fullScores({})),
        ok('b', fullScores({})),
        ok('c', partial),
      ],
    });
    // Model c is dropped; the verdict is now over 2 of 3.
    expect(r.successes).toBe(2);
    expect(r.failures).toBe(1);
    expect(r.errors[0].error).toContain('missing dim');
    expect(r.errors[0].error).toContain('weight_calibration');
  });

  test('two models missing dims → only 1 contributing → INCONCLUSIVE', () => {
    const partial1: ParsedModelResult = {
      scores: { accuracy: { score: 9 } }, // 4 missing
      improvements: [],
    };
    const partial2: ParsedModelResult = {
      scores: { attribution: { score: 9 } }, // 4 missing
      improvements: [],
    };
    const r = aggregate({
      slots: [
        ok('a', fullScores({})),
        ok('b', partial1),
        ok('c', partial2),
      ],
    });
    expect(r.verdict).toBe('inconclusive');
    expect(r.successes).toBe(1);
    expect(r.failures).toBe(2);
  });

  test('regression guard: empty scores object would have been silent PASS in v1', () => {
    // Before the strict required-dim check, an empty scores object would
    // pass `dimRolls.every(...)` vacuously (true for empty arrays). The
    // hasAllRequiredDims gate now drops it explicitly.
    const empty: ParsedModelResult = { scores: {}, improvements: [] };
    const r = aggregate({
      slots: [ok('a', empty), ok('b', empty)],
    });
    expect(r.verdict).toBe('inconclusive');
    expect(r.successes).toBe(0);
  });

  test('NaN score in a dim → dropped (not silently treated as 0)', () => {
    const nanScores: ParsedModelResult = {
      scores: {
        accuracy: { score: NaN },
        attribution: { score: 9 },
        weight_calibration: { score: 9 },
        kind_classification: { score: 9 },
        signal_density: { score: 9 },
      },
      improvements: [],
    };
    const r = aggregate({
      slots: [ok('a', fullScores({})), ok('b', fullScores({})), ok('c', nanScores)],
    });
    // Model c is dropped due to non-finite score.
    expect(r.successes).toBe(2);
  });
});

describe('aggregate — improvements deduplication', () => {
  test('deduplicates improvements across contributing models', () => {
    const withImps = (imps: string[]): ParsedModelResult => ({
      ...fullScores({}),
      improvements: imps,
    });
    const r = aggregate({
      slots: [
        ok('a', withImps(['Calibrate weights more carefully', 'Skip Twitter handles'])),
        ok('b', withImps(['Calibrate weights more carefully', 'Add more sources'])),
      ],
    });
    // 'Calibrate weights more carefully' appears once after dedup.
    const matches = r.topImprovements.filter(s => s.startsWith('Calibrate'));
    expect(matches).toHaveLength(1);
  });
});
