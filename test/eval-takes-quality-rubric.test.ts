/**
 * takes-quality-eval/rubric — rubric definition + sha contract.
 */
import { describe, test, expect } from 'bun:test';
import {
  RUBRIC_VERSION,
  RUBRIC_DIMENSIONS,
  RUBRIC_DIMENSION_DEFS,
  PASS_MEAN_THRESHOLD,
  PASS_FLOOR_THRESHOLD,
  MIN_SUCCESSES_FOR_VERDICT,
  rubricSha8,
  renderJudgePrompt,
} from '../src/core/takes-quality-eval/rubric.ts';

describe('RUBRIC_VERSION + RUBRIC_DIMENSIONS shape', () => {
  test('RUBRIC_VERSION is a versioned string', () => {
    expect(RUBRIC_VERSION).toMatch(/^v\d+\.\d+$/);
  });

  test('exactly 5 declared dimensions', () => {
    expect(RUBRIC_DIMENSIONS).toHaveLength(5);
  });

  test('every dim has a definition', () => {
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(RUBRIC_DIMENSION_DEFS[dim]).toBeDefined();
      expect(RUBRIC_DIMENSION_DEFS[dim].description.length).toBeGreaterThan(20);
      expect(RUBRIC_DIMENSION_DEFS[dim].rubric_1_to_10.length).toBeGreaterThan(20);
    }
  });

  test('dim names match plan + docs (codex review #5 strict-required-dim contract)', () => {
    expect(RUBRIC_DIMENSIONS).toEqual([
      'accuracy',
      'attribution',
      'weight_calibration',
      'kind_classification',
      'signal_density',
    ]);
  });

  test('thresholds are documented constants', () => {
    expect(PASS_MEAN_THRESHOLD).toBe(7);
    expect(PASS_FLOOR_THRESHOLD).toBe(5);
    expect(MIN_SUCCESSES_FOR_VERDICT).toBe(2);
  });
});

describe('rubricSha8 — stable fingerprint (codex review #3)', () => {
  test('deterministic: same inputs → same sha', () => {
    expect(rubricSha8()).toBe(rubricSha8());
  });

  test('output is 8 hex chars', () => {
    expect(rubricSha8()).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('renderJudgePrompt', () => {
  test('returns prompt + sha8', () => {
    const r = renderJudgePrompt('- take 1\n- take 2');
    expect(r.prompt).toContain('5 dimensions');
    expect(r.prompt).toContain('accuracy');
    expect(r.sha8).toMatch(/^[0-9a-f]{8}$/);
  });

  test('embeds the takes text into the prompt', () => {
    const r = renderJudgePrompt('UNIQUE_MARKER_xyz123');
    expect(r.prompt).toContain('UNIQUE_MARKER_xyz123');
  });

  test('different takes text → different prompt sha', () => {
    const a = renderJudgePrompt('- take A');
    const b = renderJudgePrompt('- take B');
    expect(a.sha8).not.toBe(b.sha8);
  });

  test('same takes text → same prompt sha (deterministic)', () => {
    const a = renderJudgePrompt('- same');
    const b = renderJudgePrompt('- same');
    expect(a.sha8).toBe(b.sha8);
  });

  test('prompt requires all 5 declared dims (codex review #5)', () => {
    const r = renderJudgePrompt('takes go here');
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(r.prompt).toContain(dim);
    }
    expect(r.prompt).toContain('Missing dimensions disqualify');
  });
});
