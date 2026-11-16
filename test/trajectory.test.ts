import { describe, expect, test } from 'bun:test';
import type { TrajectoryPoint } from '../src/core/engine.ts';
import {
  DEFAULT_REGRESSION_THRESHOLD,
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
    valid_until: null,
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

function observed(id: number, value: number, date: string, unit: string | null, period: string | null): TrajectoryPoint {
  return { ...point({ id, metric: 'mrr', value, date }), unit, period };
}

describe('detectRegressions', () => {
  test('#8547: a point without a valid date is left out, not looped on', () => {
    const regs = detectRegressions([
      observed(1, 50000, '2026-01-01', 'USD', 'monthly'),
      { ...observed(2, 1, '2026-01-15', 'USD', 'monthly'), valid_from: new Date('infinity') },
      observed(3, 40000, '2026-02-01', 'USD', 'monthly'),
    ], DEFAULT_REGRESSION_THRESHOLD);
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ from_value: 50000, to_value: 40000 });
  });

  test('#8547: compares only points with the same unit and period', () => {
    expect(detectRegressions([
      observed(1, 600000, '2026-01-01', 'USD', 'annual'),
      observed(2, 50000, '2026-02-01', 'USD', 'monthly'),
    ], DEFAULT_REGRESSION_THRESHOLD)).toEqual([]);
    expect(detectRegressions([
      observed(1, 50000, '2026-01-01', 'USD', 'monthly'),
      observed(2, 40000, '2026-02-01', 'EUR', 'monthly'),
    ], DEFAULT_REGRESSION_THRESHOLD)).toEqual([]);
    const regs = detectRegressions([
      observed(1, 50000, '2026-01-01', 'USD', 'monthly'),
      observed(2, 600000, '2026-01-15', 'USD', 'annual'),
      observed(3, 40000, '2026-02-01', 'USD', 'monthly'),
    ], DEFAULT_REGRESSION_THRESHOLD);
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ from_value: 50000, to_value: 40000, from_date: '2026-01-01', to_date: '2026-02-01' });
  });

  test('#8547: two values at the same valid_from are not a regression; the chain bridges that date', () => {
    expect(detectRegressions([
      observed(1, 50000, '2026-02-01', 'USD', 'monthly'),
      observed(2, 30000, '2026-02-01', 'USD', 'monthly'),
    ], DEFAULT_REGRESSION_THRESHOLD)).toEqual([]);
    const bridged = detectRegressions([
      observed(1, 90000, '2026-01-01', 'USD', 'monthly'),
      observed(2, 50000, '2026-02-01', 'USD', 'monthly'),
      observed(3, 30000, '2026-02-01', 'USD', 'monthly'),
      observed(4, 20000, '2026-03-01', 'USD', 'monthly'),
    ], DEFAULT_REGRESSION_THRESHOLD);
    expect(bridged).toHaveLength(1);
    expect(bridged[0]).toMatchObject({ from_value: 90000, to_value: 20000, from_date: '2026-01-01', to_date: '2026-03-01' });
    expect(detectRegressions([
      observed(1, 50000, '2026-01-01', 'USD', 'monthly'),
      observed(2, 40000, '2026-02-01', 'USD', 'monthly'),
      observed(3, 40000, '2026-02-01', 'USD', 'monthly'),
    ], DEFAULT_REGRESSION_THRESHOLD)).toHaveLength(1);
  });

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
