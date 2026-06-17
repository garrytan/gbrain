import { describe, expect, test } from 'bun:test';

import { aggregate } from '../src/core/cross-modal-eval/aggregate.ts';
import type { SlotResult } from '../src/core/cross-modal-eval/aggregate.ts';

function ok(model: string, scores: Record<string, number>, improvements: string[] = []): SlotResult {
  return {
    ok: true,
    modelId: model,
    parsed: {
      scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { score: v }])),
      improvements,
    },
  };
}

function err(model: string, message = 'fetch failed'): SlotResult {
  return { ok: false, modelId: model, error: message };
}

describe('cross-modal-eval/aggregate', () => {
  test('all 3 succeeded, all dims >=7 -> PASS', () => {
    const out = aggregate({
      slots: [
        ok('openai:gpt-4o', { goal: 9, depth: 8 }),
        ok('anthropic:claude-opus-4-7', { goal: 8, depth: 7 }),
        ok('google:gemini-1.5-pro', { goal: 8, depth: 8 }),
      ],
    });
    expect(out.verdict).toBe('pass');
    expect(out.successes).toBe(3);
    expect(out.failures).toBe(0);
    expect(out.dimensions.goal!.mean).toBeGreaterThanOrEqual(7);
    expect(out.dimensions.depth!.mean).toBeGreaterThanOrEqual(7);
    expect(out.dimensions.goal!.failReason).toBeUndefined();
    expect(out.overall).toBeGreaterThan(7);
  });

  test('one dim mean below 7 -> FAIL with mean_below_7', () => {
    const out = aggregate({
      slots: [
        ok('openai:gpt-4o', { goal: 9, depth: 6 }),
        ok('anthropic:claude-opus-4-7', { goal: 8, depth: 6 }),
        ok('google:gemini-1.5-pro', { goal: 8, depth: 6 }),
      ],
    });
    expect(out.verdict).toBe('fail');
    expect(out.dimensions.depth!.failReason).toBe('mean_below_7');
    expect(out.dimensions.goal!.failReason).toBeUndefined();
    expect(out.verdictMessage).toContain('depth');
  });

  test('mean >=7 but one model scored <5 -> FAIL with min_below_5 (Q2 score-floor)', () => {
    // [9, 8, 4] — mean = 7.0 ✓, but min = 4 → must FAIL per spec.
    const out = aggregate({
      slots: [
        ok('openai:gpt-4o', { goal: 9 }),
        ok('anthropic:claude-opus-4-7', { goal: 8 }),
        ok('google:gemini-1.5-pro', { goal: 4 }),
      ],
    });
    expect(out.verdict).toBe('fail');
    expect(out.dimensions.goal!.mean).toBeCloseTo(7.0, 1);
    expect(out.dimensions.goal!.min).toBe(4);
    expect(out.dimensions.goal!.failReason).toBe('min_below_5');
  });

  test('2 of 3 succeeded -> verdict is computable', () => {
    const out = aggregate({
      slots: [
        ok('openai:gpt-4o', { goal: 8 }),
        ok('anthropic:claude-opus-4-7', { goal: 9 }),
        err('google:gemini-1.5-pro', 'rate limited'),
      ],
    });
    expect(out.verdict).toBe('pass');
    expect(out.successes).toBe(2);
    expect(out.failures).toBe(1);
    expect(out.errors).toEqual([{ modelId: 'google:gemini-1.5-pro', error: 'rate limited' }]);
  });

  test('1 of 3 succeeded -> INCONCLUSIVE (Q3=A)', () => {
    const out = aggregate({
      slots: [
        ok('openai:gpt-4o', { goal: 9 }),
        err('anthropic:claude-opus-4-7', 'auth failed'),
        err('google:gemini-1.5-pro', 'rate limited'),
      ],
    });
    expect(out.verdict).toBe('inconclusive');
    expect(out.successes).toBe(1);
    expect(out.overall).toBeUndefined();
    expect(out.verdictMessage).toContain('INCONCLUSIVE');
  });

  test('0 of 3 succeeded -> INCONCLUSIVE (regression guard for empty-array .every() === true)', () => {
    const out = aggregate({
      slots: [
        err('openai:gpt-4o'),
        err('anthropic:claude-opus-4-7'),
        err('google:gemini-1.5-pro'),
      ],
    });
    // The original v1 .mjs script returned PASS here because Object.values({}).every(...) === true.
    // The fix: aggregate must require >=2 successes BEFORE evaluating dim means.
    expect(out.verdict).toBe('inconclusive');
    expect(out.successes).toBe(0);
    expect(out.failures).toBe(3);
    expect(out.errors).toHaveLength(3);
  });

  test('improvement dedup by 40-char prefix (case-insensitive)', () => {
    // Dedup is `first-40-chars(lowercased, whitespace-collapsed)`. To trigger
    // dedup, the first 40 chars must match — including any leading numeric
    // prefix. Two entries below match across slots after lowercasing.
    const out = aggregate({
      slots: [
        ok('a:m', { goal: 8 }, [
          'Add concrete examples to the introduction section',
          'Tighten the closing paragraph',
        ]),
        ok('b:m', { goal: 8 }, [
          'add concrete examples to the introduction SECTION', // dup of first by 40-char prefix
          'Add citations',
        ]),
      ],
    });
    // Three uniques after dedup: "Add concrete examples...", "Tighten...", "Add citations".
    expect(out.topImprovements).toHaveLength(3);
    expect(out.topImprovements[0]).toContain('Add concrete examples');
  });

  test('top improvements capped at 10', () => {
    const many = Array.from({ length: 30 }, (_, i) => `${i}. unique improvement number ${i}`);
    const out = aggregate({
      slots: [
        ok('a:m', { goal: 8 }, many.slice(0, 15)),
        ok('b:m', { goal: 8 }, many.slice(15)),
      ],
    });
    expect(out.topImprovements.length).toBeLessThanOrEqual(10);
  });
});
