import { describe, expect, test } from 'bun:test';
import {
  computeEmotionalWeight,
  HIGH_EMOTION_TAGS,
  DEFAULT_USER_HOLDER,
} from '../src/core/cycle/emotional-weight.ts';

describe('computeEmotionalWeight', () => {
  test('empty inputs return 0', () => {
    expect(computeEmotionalWeight({ tags: [], takes: [] })).toBe(0);
  });

  test('high-emotion tag alone gives 0.5', () => {
    const w = computeEmotionalWeight({ tags: ['wedding'], takes: [] });
    expect(w).toBeCloseTo(0.5, 5);
  });

  test('tag matching is case-insensitive', () => {
    const w = computeEmotionalWeight({ tags: ['WEDDING'], takes: [] });
    expect(w).toBeCloseTo(0.5, 5);
  });

  test('non-emotion tag gives no boost', () => {
    const w = computeEmotionalWeight({ tags: ['hardware', 'product'], takes: [] });
    expect(w).toBe(0);
  });

  test('multiple high-emotion tags do not stack (cap at 0.5)', () => {
    const w = computeEmotionalWeight({ tags: ['family', 'wedding', 'love'], takes: [] });
    expect(w).toBeCloseTo(0.5, 5);
  });

  test('takes-only: density caps at 0.3 with 3+ takes', () => {
    const takes = Array.from({ length: 5 }, () => ({
      holder: 'other',
      weight: 0,
      kind: 'fact',
      active: true,
    }));
    // density = min(5*0.1, 0.3) = 0.3; avg-weight = 0; holder-ratio = 0 (none match user).
    expect(computeEmotionalWeight({ tags: [], takes })).toBeCloseTo(0.3, 5);
  });

  test('takes-only: avg-weight contribution scales 0..0.1', () => {
    const takes = [
      { holder: 'other', weight: 1.0, kind: 'take', active: true },
    ];
    // density = 0.1; avg-weight = 1.0 * 0.1 = 0.1; holder-ratio = 0.
    expect(computeEmotionalWeight({ tags: [], takes })).toBeCloseTo(0.2, 5);
  });

  test('user-holder takes give the 0.1 ratio bump', () => {
    const takes = [
      { holder: DEFAULT_USER_HOLDER, weight: 0, kind: 'take', active: true },
    ];
    // density = 0.1; avg-weight = 0; holder-ratio = 1.0 * 0.1 = 0.1.
    expect(computeEmotionalWeight({ tags: [], takes })).toBeCloseTo(0.2, 5);
  });

  test('user-holder ratio is mixed-holder aware', () => {
    const takes = [
      { holder: DEFAULT_USER_HOLDER, weight: 0, kind: 'take', active: true },
      { holder: 'other', weight: 0, kind: 'take', active: true },
    ];
    // 1 of 2 active takes = 0.5 ratio * 0.1 = 0.05; density = 0.2; avg = 0.
    expect(computeEmotionalWeight({ tags: [], takes })).toBeCloseTo(0.25, 5);
  });

  test('inactive takes are excluded from density + ratio + avg', () => {
    const takes = [
      { holder: DEFAULT_USER_HOLDER, weight: 1, kind: 'take', active: false },
      { holder: DEFAULT_USER_HOLDER, weight: 1, kind: 'take', active: false },
    ];
    expect(computeEmotionalWeight({ tags: [], takes })).toBe(0);
  });

  test('output is bounded to [0..1]', () => {
    // High-emotion tag + max takes + max weights + all-user-holder = 0.5+0.3+0.1+0.1 = 1.0
    const takes = Array.from({ length: 10 }, () => ({
      holder: DEFAULT_USER_HOLDER,
      weight: 1.0,
      kind: 'take',
      active: true,
    }));
    const w = computeEmotionalWeight({ tags: ['wedding'], takes });
    expect(w).toBeCloseTo(1.0, 5);
    expect(w).toBeLessThanOrEqual(1);
  });

  test('over-1 take weights are clamped before averaging', () => {
    // weight=2.0 should clamp to 1.0 in the avg path.
    const takes = [
      { holder: 'other', weight: 2.0, kind: 'take', active: true },
    ];
    expect(computeEmotionalWeight({ tags: [], takes })).toBeCloseTo(0.2, 5);
  });

  test('custom highEmotionTags override default', () => {
    const customTags: ReadonlySet<string> = new Set(['hardware-failure']);
    const w = computeEmotionalWeight(
      { tags: ['hardware-failure'], takes: [] },
      { highEmotionTags: customTags },
    );
    expect(w).toBeCloseTo(0.5, 5);
    // Default seed list still excludes hardware-failure so without override:
    expect(computeEmotionalWeight({ tags: ['hardware-failure'], takes: [] })).toBe(0);
  });

  test('HIGH_EMOTION_TAGS includes the v1 seed list', () => {
    expect(HIGH_EMOTION_TAGS.has('wedding')).toBe(true);
    expect(HIGH_EMOTION_TAGS.has('family')).toBe(true);
    expect(HIGH_EMOTION_TAGS.has('mental-health')).toBe(true);
  });
});
