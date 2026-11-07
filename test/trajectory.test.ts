import { describe, expect, test } from 'bun:test';
import type { TrajectoryPoint } from '../src/core/engine.ts';
import {
  DEFAULT_REGRESSION_THRESHOLD,
  comparableTrajectoryPairs,
  detectRegressions,
} from '../src/core/trajectory.ts';

function point(args: {
  id: number;
  metric?: string;
  value: number;
  date: string;
}): TrajectoryPoint {
  return {
    fact_id: args.id,
    valid_from: new Date(args.date),
    metric: args.metric ?? 'net_income',
    value: args.value,
    unit: 'USD',
    period: 'monthly',
    event_type: null,
    text: `${args.metric ?? 'net_income'} = ${args.value}`,
    source_session: null,
    source_markdown_slug: null,
    embedding: null,
  };
}

describe('detectRegressions', () => {
  test('keeps existing positive-valued drop behavior', () => {
    const regs = detectRegressions([
      point({ id: 1, metric: 'mrr', value: 200000, date: '2026-01-01' }),
      point({ id: 2, metric: 'mrr', value: 150000, date: '2026-02-01' }),
    ], DEFAULT_REGRESSION_THRESHOLD);

    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({
      metric: 'mrr',
      from_value: 200000,
      to_value: 150000,
    });
    expect(regs[0].delta_pct).toBeCloseTo(-0.25, 4);
  });

  test('does not flag a negative-valued metric improving toward zero', () => {
    const regs = detectRegressions([
      point({ id: 1, value: -1000, date: '2026-01-01' }),
      point({ id: 2, value: -500, date: '2026-02-01' }),
    ], DEFAULT_REGRESSION_THRESHOLD);

    expect(regs).toEqual([]);
  });

  test('flags a negative-valued metric worsening away from zero', () => {
    const regs = detectRegressions([
      point({ id: 1, value: -500, date: '2026-01-01' }),
      point({ id: 2, value: -1000, date: '2026-02-01' }),
    ], DEFAULT_REGRESSION_THRESHOLD);

    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({
      metric: 'net_income',
      from_value: -500,
      to_value: -1000,
      from_date: '2026-01-01',
      to_date: '2026-02-01',
    });
    expect(regs[0].delta_pct).toBeCloseTo(-1.0, 4);
  });
});

describe('comparable observations', () => {
  const p = (id: number, value: number, date: string, extra: Partial<TrajectoryPoint> = {}): TrajectoryPoint =>
    ({ ...point({ id, value, date }), ...extra });

  test('same-time conflicting values are two observations of one moment, not a decline', () => {
    expect(detectRegressions([p(1, 9000, '2026-01-01'), p(2, 900, '2026-01-01')])).toEqual([]);
  });

  test('a same-time conflict breaks the chain on both sides and is never bridged', () => {
    expect(detectRegressions([
      p(1, 1000, '2026-01-01'),
      p(2, 500, '2026-02-01'), p(3, 50, '2026-02-01'),
      p(4, 40, '2026-03-01'), p(5, 30, '2026-04-01'),
    ])).toEqual([{ metric: 'net_income', from_value: 40, from_date: '2026-03-01', to_value: 30, to_date: '2026-04-01', delta_pct: -0.25 }]);
  });

  test('same-time corroboration counts once and keeps a genuine later decline', () => {
    const rows = [p(1, 100, '2026-01-01'), p(2, 100, '2026-01-01'), p(3, 80, '2026-02-01')];
    expect(comparableTrajectoryPairs(rows).map(([a, b]) => [a.fact_id, b.fact_id])).toEqual([[1, 3]]);
    expect(detectRegressions(rows)).toHaveLength(1);
  });

  test('different or missing units and periods are never assumed equivalent', () => {
    for (const extra of [{ unit: 'EUR' }, { unit: null }, { period: 'annual' }, { period: null }]) {
      expect(detectRegressions([p(1, 1000, '2026-01-01'), p(2, 100, '2026-02-01', extra)])).toEqual([]);
    }
  });

  test('interleaved series keep their own chronological changes', () => {
    const rows = [p(1, 100, '2026-01-01'), p(2, 5, '2026-02-01', { unit: 'EUR' }),
      p(3, 80, '2026-03-01'), p(4, 4, '2026-04-01', { unit: 'EUR' })];
    expect(detectRegressions(rows).map(r => [r.from_value, r.to_value])).toEqual([[100, 80], [5, 4]]);
  });

  test('invalid dates and reverse-time input never produce a regression', () => {
    expect(detectRegressions([p(1, 100, '2026-02-01'), p(2, 10, '2026-01-01')])).toEqual([]);
    expect(detectRegressions([p(1, 100, 'invalid'), p(2, 10, '2026-01-01')])).toEqual([]);
  });
});
