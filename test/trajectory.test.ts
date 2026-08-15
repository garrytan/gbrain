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
