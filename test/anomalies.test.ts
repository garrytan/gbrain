import { describe, expect, test } from 'bun:test';
import {
  meanStddev,
  computeAnomaliesFromBuckets,
  type CohortDayRow,
  type CohortTodayRow,
} from '../src/core/cycle/anomaly.ts';

describe('meanStddev', () => {
  test('empty returns (0, 0)', () => {
    expect(meanStddev([])).toEqual({ mean: 0, stddev: 0 });
  });

  test('single sample returns mean=value, stddev=0', () => {
    expect(meanStddev([7])).toEqual({ mean: 7, stddev: 0 });
  });

  test('all-equal returns stddev=0', () => {
    const r = meanStddev([3, 3, 3, 3]);
    expect(r.mean).toBe(3);
    expect(r.stddev).toBe(0);
  });

  test('sample stddev (n-1 denominator)', () => {
    // stddev of [2,4,4,4,5,5,7,9] with sample-stddev = 2.0
    const r = meanStddev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(r.mean).toBe(5);
    expect(r.stddev).toBeCloseTo(2.138, 2);
  });
});

describe('computeAnomaliesFromBuckets', () => {
  function densify(values: number[], cohort_value: string, kind: 'tag' | 'type' = 'tag'): CohortDayRow[] {
    return values.map((count, i) => ({
      cohort_kind: kind,
      cohort_value,
      day: `2026-04-${String(i + 1).padStart(2, '0')}`,
      count,
    }));
  }

  test('clear anomaly: 7-touch day on a 0..1 baseline triggers tag cohort', () => {
    const baseline: CohortDayRow[] = densify([0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 'wedding');
    const today: CohortTodayRow[] = [
      { cohort_kind: 'tag', cohort_value: 'wedding', count: 7, page_slugs: ['p1','p2','p3','p4','p5','p6','p7'] },
    ];
    const r = computeAnomaliesFromBuckets(baseline, today, 3.0);
    expect(r.length).toBe(1);
    expect(r[0].cohort_value).toBe('wedding');
    expect(r[0].count).toBe(7);
    expect(r[0].sigma_observed).toBeGreaterThan(3);
  });

  test('zero-stddev baseline + count > mean+1 triggers fallback (no NaN)', () => {
    // baseline is all 1s (stddev=0), today is 5 → count > mean+1 → anomaly
    const baseline: CohortDayRow[] = densify(Array.from({length: 10}, () => 1), 'work');
    const today: CohortTodayRow[] = [
      { cohort_kind: 'tag', cohort_value: 'work', count: 5, page_slugs: ['a','b','c','d','e'] },
    ];
    const r = computeAnomaliesFromBuckets(baseline, today, 3.0);
    expect(r.length).toBe(1);
    expect(r[0].baseline_stddev).toBe(0);
    expect(Number.isFinite(r[0].sigma_observed)).toBe(true);
    expect(r[0].sigma_observed).toBe(4); // 5 - 1
  });

  test('zero-stddev baseline + count <= mean+1 does not fire', () => {
    const baseline: CohortDayRow[] = densify(Array.from({length: 10}, () => 1), 'work');
    const today: CohortTodayRow[] = [
      { cohort_kind: 'tag', cohort_value: 'work', count: 2, page_slugs: ['a','b'] },
    ];
    expect(computeAnomaliesFromBuckets(baseline, today, 3.0)).toEqual([]);
  });

  test('non-anomalous current count returns empty', () => {
    const baseline: CohortDayRow[] = densify([5, 4, 6, 5, 4, 5, 6, 5, 4, 6], 'daily');
    const today: CohortTodayRow[] = [
      { cohort_kind: 'tag', cohort_value: 'daily', count: 6, page_slugs: ['a'] },
    ];
    expect(computeAnomaliesFromBuckets(baseline, today, 3.0)).toEqual([]);
  });

  test('brand-new cohort (no baseline) requires count >= 2', () => {
    // No baseline rows for "newtag"; today.count=2 → mean=0, stddev=0, threshold=mean+1=1, 2>1 ✓
    const today: CohortTodayRow[] = [
      { cohort_kind: 'tag', cohort_value: 'newtag', count: 2, page_slugs: ['a','b'] },
      { cohort_kind: 'tag', cohort_value: 'singleton', count: 1, page_slugs: ['x'] },
    ];
    const r = computeAnomaliesFromBuckets([], today, 3.0);
    expect(r.length).toBe(1);
    expect(r[0].cohort_value).toBe('newtag');
  });

  test('top results sorted by sigma_observed desc', () => {
    const baseline: CohortDayRow[] = [
      ...densify([0,0,0,0,0,0,0,0,0,0], 'low'),
      ...densify([2,2,2,2,2,2,2,2,2,2], 'medium'),
    ];
    const today: CohortTodayRow[] = [
      { cohort_kind: 'tag', cohort_value: 'low', count: 3, page_slugs: ['a','b','c'] },
      { cohort_kind: 'tag', cohort_value: 'medium', count: 4, page_slugs: ['x','y','z','w'] },
    ];
    const r = computeAnomaliesFromBuckets(baseline, today, 0.5);
    // both should fire; "low" has bigger sigma_observed (mean=0) so it's first.
    expect(r[0].cohort_value).toBe('low');
  });

  test('limit caps result count', () => {
    const today: CohortTodayRow[] = Array.from({length: 50}, (_, i) => ({
      cohort_kind: 'tag' as const,
      cohort_value: `tag${i}`,
      count: 5,
      page_slugs: [`p${i}`],
    }));
    const r = computeAnomaliesFromBuckets([], today, 3.0, 10);
    expect(r.length).toBe(10);
  });

  test('page_slugs are capped at 50 per cohort', () => {
    const slugs = Array.from({length: 100}, (_, i) => `p${i}`);
    const today: CohortTodayRow[] = [
      { cohort_kind: 'tag', cohort_value: 'huge', count: 100, page_slugs: slugs },
    ];
    const r = computeAnomaliesFromBuckets([], today, 3.0);
    expect(r[0].page_slugs.length).toBe(50);
  });

  test('cohort_kind=tag and =type are tracked independently', () => {
    // Same name "wedding" as both a tag and a type — should not collide.
    const baseline: CohortDayRow[] = [
      ...densify([0,0,0,0,0], 'wedding', 'tag'),
      ...densify([5,5,5,5,5], 'wedding', 'type'),
    ];
    const today: CohortTodayRow[] = [
      { cohort_kind: 'tag', cohort_value: 'wedding', count: 7, page_slugs: ['t1'] },
      { cohort_kind: 'type', cohort_value: 'wedding', count: 7, page_slugs: ['t2'] },
    ];
    const r = computeAnomaliesFromBuckets(baseline, today, 0.5);
    // Tag cohort should fire (mean=0); type cohort might or might not depending on stddev.
    const tagEntry = r.find(x => x.cohort_kind === 'tag');
    expect(tagEntry).toBeDefined();
    expect(tagEntry!.baseline_mean).toBe(0);
  });
});
