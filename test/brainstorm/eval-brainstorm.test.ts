/**
 * v0.37.0 — `gbrain eval brainstorm` pure-function tests (D3 + codex r2 #11).
 *
 * The orchestrator + judge themselves are exercised in E2E with a real
 * brain; here we pin the eval math (grounding rate + verdict computation +
 * threshold semantics) since those are what gate the eval suite.
 */

import { describe, test, expect } from 'bun:test';
import {
  computeGroundingRate,
  computeVerdict,
  DEFAULT_BRAINSTORM_THRESHOLDS,
  readBrainstormEvalFixture,
  type PerFixtureResult,
} from '../../src/commands/eval-brainstorm.ts';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('computeGroundingRate', () => {
  const real = new Set(['wiki/vc/alice', 'wiki/biology/bee', 'wiki/hardware/asic']);

  test('100% grounding when every idea cites a real slug', () => {
    const ideas = [
      { close_slug: 'wiki/vc/alice', far_slug: 'wiki/biology/bee' },
      { close_slug: 'wiki/biology/bee', far_slug: 'wiki/hardware/asic' },
    ];
    expect(computeGroundingRate(ideas, real)).toBe(1.0);
  });

  test('50% grounding when half cite hallucinated slugs', () => {
    const ideas = [
      { close_slug: 'wiki/vc/alice', far_slug: 'wiki/biology/bee' },
      { close_slug: 'wiki/fake/no-such-page', far_slug: 'wiki/also-fake' },
    ];
    expect(computeGroundingRate(ideas, real)).toBe(0.5);
  });

  test('one-real-citation counts as grounded (close OR far real)', () => {
    const ideas = [
      { close_slug: 'wiki/vc/alice', far_slug: 'wiki/hallucinated' },
    ];
    expect(computeGroundingRate(ideas, real)).toBe(1.0);
  });

  test('0% grounding when all slugs are hallucinated', () => {
    const ideas = [
      { close_slug: 'wiki/fake/one', far_slug: 'wiki/fake/two' },
    ];
    expect(computeGroundingRate(ideas, real)).toBe(0);
  });

  test('empty ideas array → 0 (no division by zero)', () => {
    expect(computeGroundingRate([], real)).toBe(0);
  });
});

function mkFixture(partial: Partial<PerFixtureResult>): PerFixtureResult {
  return {
    question: 'test',
    pass_count: 5,
    total_ideas: 5,
    mean_distance: 0.5,
    mean_usefulness: 4.0,
    grounding_rate: 1.0,
    short_of_target: false,
    cost_usd: 0.10,
    judge_failed: false,
    ...partial,
  };
}

describe('computeVerdict', () => {
  test('pass when all three axes clear', () => {
    const res = computeVerdict(
      [
        mkFixture({ mean_distance: 0.5, mean_usefulness: 4.0, grounding_rate: 1.0 }),
        mkFixture({ mean_distance: 0.6, mean_usefulness: 4.2, grounding_rate: 1.0 }),
      ],
      DEFAULT_BRAINSTORM_THRESHOLDS,
    );
    expect(res.verdict).toBe('pass');
  });

  test('fail when distance below threshold', () => {
    const res = computeVerdict(
      [
        mkFixture({ mean_distance: 0.2, mean_usefulness: 4.0, grounding_rate: 1.0 }),
        mkFixture({ mean_distance: 0.25, mean_usefulness: 4.0, grounding_rate: 1.0 }),
      ],
      DEFAULT_BRAINSTORM_THRESHOLDS,
    );
    expect(res.verdict).toBe('fail');
    expect(res.reasons.some((r) => r.includes('distance'))).toBe(true);
  });

  test('fail when usefulness below threshold (codex r2 #11 — distance alone is gameable)', () => {
    const res = computeVerdict(
      [
        mkFixture({ mean_distance: 0.6, mean_usefulness: 2.5, grounding_rate: 1.0 }),
        mkFixture({ mean_distance: 0.6, mean_usefulness: 2.8, grounding_rate: 1.0 }),
      ],
      DEFAULT_BRAINSTORM_THRESHOLDS,
    );
    expect(res.verdict).toBe('fail');
    expect(res.reasons.some((r) => r.includes('usefulness'))).toBe(true);
  });

  test('fail when grounding below 1.0 (every idea must cite a real slug)', () => {
    const res = computeVerdict(
      [
        mkFixture({ mean_distance: 0.6, mean_usefulness: 4.0, grounding_rate: 0.7 }),
        mkFixture({ mean_distance: 0.6, mean_usefulness: 4.0, grounding_rate: 0.9 }),
      ],
      DEFAULT_BRAINSTORM_THRESHOLDS,
    );
    expect(res.verdict).toBe('fail');
    expect(res.reasons.some((r) => r.includes('grounding'))).toBe(true);
  });

  test('inconclusive when <2 fixtures usable', () => {
    const res = computeVerdict(
      [mkFixture({ pass_count: 5 })],
      DEFAULT_BRAINSTORM_THRESHOLDS,
    );
    expect(res.verdict).toBe('inconclusive');
  });

  test('inconclusive when all fixtures have judge_failed', () => {
    const res = computeVerdict(
      [
        mkFixture({ judge_failed: true }),
        mkFixture({ judge_failed: true }),
      ],
      DEFAULT_BRAINSTORM_THRESHOLDS,
    );
    expect(res.verdict).toBe('inconclusive');
  });

  test('threshold overrides honored', () => {
    const res = computeVerdict(
      [
        mkFixture({ mean_distance: 0.3, mean_usefulness: 4.0, grounding_rate: 1.0 }),
        mkFixture({ mean_distance: 0.35, mean_usefulness: 4.0, grounding_rate: 1.0 }),
      ],
      { distance_min: 0.25, usefulness_min: 3.5, grounding_min: 1.0 },
    );
    expect(res.verdict).toBe('pass');
  });
});

describe('readBrainstormEvalFixture', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'gbrain-eval-brainstorm-'));

  test('parses valid JSONL with one question per line', () => {
    const f = join(tmpDir, 'good.jsonl');
    writeFileSync(f, [
      '{"question": "why is X"}',
      '{"question": "what about Y"}',
      '',
      '{"question": "and Z"}',
    ].join('\n'));
    const out = readBrainstormEvalFixture(f);
    expect(out.length).toBe(3);
    expect(out[0].question).toBe('why is X');
    expect(out[2].question).toBe('and Z');
  });

  test('skips malformed JSON lines', () => {
    const f = join(tmpDir, 'mixed.jsonl');
    writeFileSync(f, [
      '{"question": "good one"}',
      'not json at all',
      '{"question": "another good"}',
      '{"no_question_field": "skipped"}',
    ].join('\n'));
    const out = readBrainstormEvalFixture(f);
    expect(out.length).toBe(2);
    expect(out.map((f) => f.question)).toEqual(['good one', 'another good']);
  });

  test('honors expected_far_prefixes when present', () => {
    const f = join(tmpDir, 'prefixes.jsonl');
    writeFileSync(f, JSON.stringify({
      question: 'cross-pollinate this',
      expected_far_prefixes: ['wiki/biology', 'wiki/hardware'],
    }));
    const out = readBrainstormEvalFixture(f);
    expect(out[0].expected_far_prefixes).toEqual(['wiki/biology', 'wiki/hardware']);
  });

  test('throws on missing file', () => {
    expect(() => readBrainstormEvalFixture('/no/such/path.jsonl')).toThrow(/not found/);
  });

  // Cleanup at end
  test('_cleanup_', () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
