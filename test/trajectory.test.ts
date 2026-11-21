import { describe, expect, test } from 'bun:test';
import type { TrajectoryPoint } from '../src/core/engine.ts';
import {
  DEFAULT_REGRESSION_THRESHOLD,
  detectRegressions,
} from '../src/core/trajectory.ts';
import * as trajectory from '../src/core/trajectory.ts';

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

// A drop on a lower-is-better metric (churn, burn, cost ...) is an improvement; a rise of at least the
// threshold is the regression. Every other metric keeps the rule that a drop is the regression.
describe('detectRegressions — lower-is-better metrics', () => {
  function series(metric: string, unit: string, a: number, b: number): TrajectoryPoint[] {
    return [
      { ...point({ id: 1, metric, value: a, date: '2026-01-01' }), unit },
      { ...point({ id: 2, metric, value: b, date: '2026-02-01' }), unit },
    ];
  }

  test('falling churn 5 -> 3 pct is not a regression', () => {
    expect(detectRegressions(series('churn', 'pct', 5, 3))).toEqual([]);
    expect(detectRegressions(series('churn_rate', 'pct', 5, 3))).toEqual([]);
  });

  test('falling burn 200000 -> 150000 USD is not a regression', () => {
    expect(detectRegressions(series('burn', 'USD', 200000, 150000))).toEqual([]);
    expect(detectRegressions(series('burn_rate', 'USD', 200000, 150000))).toEqual([]);
    expect(detectRegressions(series('cac', 'USD', 900, 600))).toEqual([]);
  });

  test('rising burn 150000 -> 200000 USD is a regression with a positive delta and direction up', () => {
    const regs = detectRegressions(series('burn', 'USD', 150000, 200000));
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({
      metric: 'burn', from_value: 150000, to_value: 200000, from_date: '2026-01-01', to_date: '2026-02-01', direction: 'up',
    });
    expect(regs[0].delta_pct).toBeCloseTo(1 / 3, 6);
  });

  test('rising churn 3 -> 5 pct is a regression, direction up', () => {
    const regs = detectRegressions(series('churn', 'pct', 3, 5));
    expect(regs).toHaveLength(1);
    expect(regs[0].direction).toBe('up');
    expect(regs[0].delta_pct).toBeCloseTo(2 / 3, 6);
  });

  test('a rise under the threshold on a lower-is-better metric is not a regression; at the threshold it is', () => {
    expect(detectRegressions(series('burn', 'USD', 200000, 210000))).toEqual([]);
    expect(detectRegressions(series('burn', 'USD', 200000, 220000), 0.10)).toHaveLength(1);
  });

  // Passes on the old code too: it guards the old rule for every other metric.
  test('falling ARR 200000 -> 150000 USD is still a regression; rising ARR is not', () => {
    const regs = detectRegressions(series('arr', 'USD', 200000, 150000));
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ metric: 'arr', from_value: 200000, to_value: 150000 });
    expect(regs[0].delta_pct).toBeCloseTo(-0.25, 6);
    expect(detectRegressions(series('arr', 'USD', 150000, 200000))).toEqual([]);
  });

  test('every regression says which way the metric moved: down for ARR, up for burn', () => {
    expect(detectRegressions(series('arr', 'USD', 200000, 150000))[0].direction).toBe('down');
    expect(detectRegressions(series('burn', 'USD', 150000, 200000))[0].direction).toBe('up');
  });

  test('a lower-is-better metric stored as a negative outflow compares magnitudes (abs denominator)', () => {
    // burn -150 is a burn of 150: -150 -> -100 is a cut (no regression), -100 -> -150 is a 50% rise.
    expect(detectRegressions(series('burn', 'USD', -150, -100))).toEqual([]);
    const regs = detectRegressions(series('burn', 'USD', -100, -150));
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ metric: 'burn', direction: 'up' });
    expect(regs[0].delta_pct).toBeCloseTo(0.5, 6);
  });

  test('a signed loss deepening from -50000 to -100000 is a regression, a shrinking one is not', () => {
    const regs = detectRegressions(series('net_loss', 'USD', -50000, -100000));
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ metric: 'net_loss', from_value: -50000, to_value: -100000, direction: 'up' });
    expect(regs[0].delta_pct).toBeCloseTo(1, 6);
    expect(detectRegressions(series('net_loss', 'USD', -100000, -50000))).toEqual([]);
    // A positive loss figure still reads as before.
    expect(detectRegressions(series('net_loss', 'USD', 50000, 100000))).toHaveLength(1);
    expect(detectRegressions(series('net_loss', 'USD', 100000, 50000))).toEqual([]);
  });

  test('a signed loss that crosses zero into a profit is an improvement, not a rise', () => {
    expect(detectRegressions(series('net_loss', 'USD', -50000, 100000))).toEqual([]);
    expect(detectRegressions(series('net_loss', 'USD', -50000, 0))).toEqual([]);
    expect(detectRegressions(series('burn', 'USD', -150, 50))).toEqual([]);
  });

  test('the sign convention is picked once per series: net_loss -50000 -> 100000 -> -50000 flags the return to a loss', () => {
    const pts = [-50000, 100000, -50000].map((value, i) => ({
      ...point({ id: i + 1, metric: 'net_loss', value, date: `2026-0${i + 1}-01` }), unit: 'USD',
    }));
    const regs = detectRegressions(pts);
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ metric: 'net_loss', from_value: 100000, to_value: -50000, from_date: '2026-02-01', to_date: '2026-03-01', direction: 'up' });
    expect(regs[0].delta_pct).toBeCloseTo(1.5, 6);
  });

  test('a signed series that keeps growing into profit raises no flag at any step', () => {
    const pts = [-50000, 100000, 200000].map((value, i) => ({
      ...point({ id: i + 1, metric: 'net_loss', value, date: `2026-0${i + 1}-01` }), unit: 'USD',
    }));
    expect(detectRegressions(pts)).toEqual([]);
  });

  test('a series that starts positive keeps the plain convention even if a later value is negative', () => {
    const pts = [50000, -20000, -60000].map((value, i) => ({
      ...point({ id: i + 1, metric: 'net_loss', value, date: `2026-0${i + 1}-01` }), unit: 'USD',
    }));
    // plain: 50000 -> -20000 is a fall (fine), -20000 -> -60000 is a fall (fine)
    expect(detectRegressions(pts)).toEqual([]);
  });

  test('each series (metric, unit, period) picks its own convention', () => {
    const pts = [
      { ...point({ id: 1, metric: 'net_loss', value: -50000, date: '2026-01-01' }), unit: 'USD' },
      { ...point({ id: 2, metric: 'net_loss', value: 50000, date: '2026-01-01' }), unit: 'EUR' },
      { ...point({ id: 3, metric: 'net_loss', value: -100000, date: '2026-02-01' }), unit: 'USD' },
      { ...point({ id: 4, metric: 'net_loss', value: 100000, date: '2026-02-01' }), unit: 'EUR' },
    ];
    const regs = detectRegressions(pts);
    expect(regs.map(r => r.to_value).sort((a, b) => a - b)).toEqual([-100000, 100000]);
  });

  test('a rise of exactly the threshold is flagged whatever the float rounding (0.05 -> 0.055 churn)', () => {
    // (0.055 - 0.05) / 0.05 is 0.09999999999999995 in floating point.
    expect(detectRegressions(series('churn', 'pct', 0.05, 0.055))).toHaveLength(1);
    expect(detectRegressions(series('churn', 'pct', 5, 5.5))).toHaveLength(1);
    // A drop of exactly the threshold on an ordinary metric is flagged the same way from either side.
    expect(detectRegressions(series('arr', 'USD', 0.05, 0.045))).toHaveLength(1);
    expect(detectRegressions(series('arr', 'USD', 0.1, 0.09))).toHaveLength(1);
    // Just under the threshold is still not a regression.
    expect(detectRegressions(series('churn', 'pct', 0.05, 0.0549))).toEqual([]);
  });

  test('debt_service_coverage_ratio is higher-is-better: a fall is the regression, a rise is not', () => {
    const regs = detectRegressions(series('debt_service_coverage_ratio', 'ratio', 2, 1));
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ metric: 'debt_service_coverage_ratio', direction: 'down' });
    expect(detectRegressions(series('debt_service_coverage_ratio', 'ratio', 1, 2))).toEqual([]);
  });
});

// A name that holds a lower-is-better word AND a good-news word (saving, recovered, reduction ...) is about
// the good thing going up, so it follows the ordinary rule: a drop is the regression, a rise is not.
describe('detectRegressions — savings and recovery metrics are not lower-is-better', () => {
  function series(metric: string, a: number, b: number): TrajectoryPoint[] {
    return [
      point({ id: 1, metric, value: a, date: '2026-01-01' }),
      point({ id: 2, metric, value: b, date: '2026-02-01' }),
    ];
  }

  test('a rise in cost_savings is not a regression', () => {
    expect(detectRegressions(series('cost_savings', 100000, 150000))).toEqual([]);
  });

  test('a rise in revenue_loss_recovered is not a regression', () => {
    expect(detectRegressions(series('revenue_loss_recovered', 40000, 60000))).toEqual([]);
  });

  test('a falling cost_savings IS a regression under the ordinary rule, direction down', () => {
    const regs = detectRegressions(series('cost_savings', 150000, 100000));
    expect(regs).toHaveLength(1);
    expect(regs[0]).toMatchObject({ metric: 'cost_savings', from_value: 150000, to_value: 100000, direction: 'down' });
    expect(regs[0].delta_pct).toBeCloseTo(-1 / 3, 6);
  });

  test('a plain cost still regresses on a rise, so only the exception words narrow the rule', () => {
    expect(detectRegressions(series('cost', 100000, 150000))).toHaveLength(1);
    expect(detectRegressions(series('revenue_loss', 40000, 60000))).toHaveLength(1);
  });
});

describe('isLowerIsBetter', () => {
  const yes = (m: string) => expect(trajectory.isLowerIsBetter(m), m).toBe(true);
  const no = (m: string) => expect(trajectory.isLowerIsBetter(m), m).toBe(false);

  test('the exact names burn_rate, churn_rate, cac, burn and churn', () => {
    for (const m of ['burn_rate', 'churn_rate', 'cac', 'burn', 'churn']) yes(m);
    expect(trajectory.LOWER_IS_BETTER.metrics).toEqual(['burn_rate', 'churn_rate', 'cac', 'burn', 'churn']);
    expect(trajectory.LOWER_IS_BETTER.words).toEqual(
      ['cost', 'costs', 'expense', 'expenses', 'loss', 'losses', 'latency', 'payback', 'debt', 'debts']);
  });

  test('a metric containing the whole word cost, expense, loss, latency, payback or debt', () => {
    for (const m of ['cost', 'cloud_cost', 'cost_of_goods', 'expense', 'opex_expense', 'net_loss', 'loss_rate',
      'p95_latency', 'payback', 'cac_payback', 'debt', 'debt_total']) yes(m);
  });

  test('the plain plurals costs, expenses, losses and debts', () => {
    for (const m of ['costs', 'cloud_costs', 'expenses', 'losses', 'q1_losses', 'debts']) yes(m);
  });

  test('words are split on underscores, hyphens, spaces and other non-alphanumerics, then lowercased', () => {
    for (const m of ['Cloud-Costs', 'cloud costs', 'P95.Latency', 'NET LOSS', 'cac/payback', 'Burn', ' churn ', 'BURN_RATE',
      'burn-rate', 'burn rate']) yes(m);
  });

  test('a word that only contains a candidate is not lower-is-better (lossless, costco, debtor ...)', () => {
    for (const m of ['lossless', 'costco', 'debtor', 'costly', 'glossary', 'accost', 'burnout', 'burn_out_score', 'churned',
      'churn_rate_target', 'latencyz', 'paybacks']) no(m);
  });

  test('a ratio name stays higher-is-better even with cost or loss inside (benefit_cost_ratio, loss_ratio ...)', () => {
    for (const m of ['benefit_cost_ratio', 'revenue_to_cost_ratio', 'cash_to_debt_ratio', 'loss_ratio', 'cost_ratio',
      'gross_margin_to_expense_ratio', 'Benefit-Cost-Ratio', 'benefit cost ratio']) no(m);
    for (const m of ['cost_ratios', 'loss_ratios']) no(m);
    // Only the whole token `ratio` or `ratios` excepts a name, never a substring: `cost_migration` has no such token.
    for (const m of ['cost_migration', 'loss_operations', 'cost_gyration']) yes(m);
    for (const m of ['burn_rate', 'churn_rate', 'cac', 'burn', 'churn']) yes(m);
  });

  test('a name that also holds saving, savings, saved, recovered, recovery, reduction, reduced, avoided or coverage is not lower-is-better', () => {
    for (const m of ['cost_savings', 'revenue_loss_recovered', 'cost_saving', 'costs_saved', 'loss_recovery', 'cost_reduction',
      'expense_reduced', 'losses_avoided', 'debt_reduction', 'debt_service_coverage_ratio', 'interest_coverage_debt', 'Cost-Savings', 'cloud cost recovered', 'latency_reduction_ms']) no(m);
    expect(trajectory.LOWER_IS_BETTER.exceptWords).toEqual(
      ['saving', 'savings', 'saved', 'recovered', 'recovery', 'reduction', 'reduced', 'avoided', 'coverage', 'ratio', 'ratios']);
  });

  test('the exception words do not touch the exact names or a name with no lower-is-better word', () => {
    for (const m of ['burn_rate', 'churn_rate', 'cac', 'burn', 'churn']) yes(m);
    for (const m of ['savings', 'recovered', 'reduction']) no(m);
  });

  test('every other metric keeps the old rule', () => {
    for (const m of ['mrr', 'arr', 'revenue', 'net_income', 'team_size', 'headcount', 'runway', 'cash', 'gross_margin', 'ltv']) no(m);
  });
});
