/**
 * v0.35.4 — `gbrain founder scorecard` CLI (T7) tests.
 *
 * Pins:
 *   - Pure compute fn: each of the four rollup fields produces correct math.
 *   - JSON envelope has schema_version: 1 + every required field (R5).
 *   - G2: empty entity (no facts, no takes) returns a valid empty rollup
 *         with no NaN / nulls in numeric slots.
 *   - Red flags fire for regressions + high drift + missed predictions.
 */

import { describe, test, expect } from 'bun:test';
import { computeFounderScorecard } from '../src/commands/founder-scorecard.ts';
import type { TrajectoryPoint, Take } from '../src/core/engine.ts';

function pt(args: {
  id: number;
  metric: string;
  value: number;
  date: string;
  emb?: Float32Array | null;
}): TrajectoryPoint {
  return {
    fact_id: args.id,
    valid_from: new Date(args.date),
    metric: args.metric,
    value: args.value,
    unit: 'USD',
    period: 'monthly',
    text: `${args.metric} = ${args.value}`,
    source_session: null,
    source_markdown_slug: null,
    embedding: args.emb ?? null,
  };
}

function take(args: {
  id: number;
  claim: string;
  resolved_outcome: boolean | null;
}): Take {
  return {
    id: args.id,
    page_id: 1,
    page_slug: 'companies/acme-example',
    row_num: args.id,
    claim: args.claim,
    kind: 'fact',
    holder: 'self',
    weight: 0.9,
    since_date: '2026-01-15',
    until_date: null,
    source: 'test',
    active: true,
    resolved_at: args.resolved_outcome === null ? null : '2026-06-01',
    resolved_outcome: args.resolved_outcome,
    resolved_value: null,
    resolved_unit: null,
    resolved_source: null,
    resolved_outcome_label: null,
    resolved_by: null,
    superseded_by: null,
    embedded_at: null,
    created_at: '2026-01-15',
    updated_at: '2026-01-15',
  } as unknown as Take;
}

describe('computeFounderScorecard — JSON envelope (R5)', () => {
  test('empty inputs → valid empty rollup, schema_version: 1, no NaN (G2)', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/empty',
      windowSince: '2025-05-17',
      windowUntil: '2026-05-17',
      points: [],
      takes: [],
    });
    expect(sc.schema_version).toBe(1);
    expect(sc.entity_slug).toBe('companies/empty');
    expect(sc.window.since).toBe('2025-05-17');
    expect(sc.window.until).toBe('2026-05-17');
    expect(sc.claim_accuracy.predicted).toBe(0);
    expect(sc.claim_accuracy.accurate).toBe(0);
    expect(sc.claim_accuracy.pct).toBeNull();
    expect(sc.consistency.score).toBeNull();
    expect(sc.consistency.metric_changes).toBe(0);
    expect(sc.consistency.typed_facts).toBe(0);
    expect(sc.growth_trajectory).toEqual([]);
    expect(sc.red_flags).toEqual([]);
    // No NaN slipped into numeric slots.
    expect(Number.isNaN(sc.claim_accuracy.predicted)).toBe(false);
    expect(Number.isNaN(sc.consistency.metric_changes)).toBe(false);
  });
});

describe('computeFounderScorecard — claim_accuracy', () => {
  test('3 takes, 1 accurate, 1 missed, 1 unresolved → 1/2 = 50% over RESOLVED only', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/acme-example',
      windowSince: null, windowUntil: null,
      points: [],
      takes: [
        take({ id: 1, claim: 'will hit $1M ARR', resolved_outcome: true  }),
        take({ id: 2, claim: 'will close X',     resolved_outcome: false }),
        take({ id: 3, claim: 'might do Y',       resolved_outcome: null  }),
      ],
    });
    expect(sc.claim_accuracy.predicted).toBe(2);
    expect(sc.claim_accuracy.accurate).toBe(1);
    expect(sc.claim_accuracy.pct).toBeCloseTo(0.5, 3);
  });
});

describe('computeFounderScorecard — consistency + growth_trajectory', () => {
  test('3-point stable trajectory → 0 changes, score 1.0, growth direction matches latest delta', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/stable',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'mrr', value: 100, date: '2026-01-15' }),
        pt({ id: 2, metric: 'mrr', value: 101, date: '2026-04-12' }),
        pt({ id: 3, metric: 'mrr', value: 102, date: '2026-07-08' }),
      ],
      takes: [],
    });
    // 1% deltas are below the 5% change threshold.
    expect(sc.consistency.metric_changes).toBe(0);
    expect(sc.consistency.typed_facts).toBe(3);
    expect(sc.consistency.score).toBeCloseTo(1.0, 3);
    expect(sc.growth_trajectory.length).toBe(1);
    expect(sc.growth_trajectory[0].metric).toBe('mrr');
    // 101 → 102 = 0.99% delta < 1% threshold → 'flat'.
    expect(sc.growth_trajectory[0].direction).toBe('flat');
  });

  test('trajectory with one big drop → 1 change, score 0.667, direction down', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/declining',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'mrr', value: 200000, date: '2026-04-12' }),
        pt({ id: 2, metric: 'mrr', value: 150000, date: '2026-07-08' }),
        pt({ id: 3, metric: 'mrr', value: 150500, date: '2026-09-01' }),
      ],
      takes: [],
    });
    expect(sc.consistency.metric_changes).toBe(1);
    expect(sc.consistency.typed_facts).toBe(3);
    expect(sc.consistency.score).toBeCloseTo(1 - 1 / 3, 3);
    expect(sc.growth_trajectory[0].direction).toBe('flat'); // last delta is tiny
  });

  test('multiple metrics: each gets its own growth entry, alphabetically ordered', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/multi',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'mrr', value: 100, date: '2026-01-15' }),
        pt({ id: 2, metric: 'arr', value: 1200, date: '2026-01-15' }),
        pt({ id: 3, metric: 'mrr', value: 130, date: '2026-04-12' }),
        pt({ id: 4, metric: 'arr', value: 1500, date: '2026-04-12' }),
      ],
      takes: [],
    });
    expect(sc.growth_trajectory.map(g => g.metric)).toEqual(['arr', 'mrr']);
    expect(sc.growth_trajectory[0].direction).toBe('up');  // arr +25%
    expect(sc.growth_trajectory[1].direction).toBe('up');  // mrr +30%
  });
});

describe('computeFounderScorecard — red_flags', () => {
  test('regression fires a red flag', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/regression',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'mrr', value: 200000, date: '2026-04-12' }),
        pt({ id: 2, metric: 'mrr', value: 150000, date: '2026-07-08' }),
      ],
      takes: [],
    });
    const reg = sc.red_flags.find(f => f.kind === 'regression');
    expect(reg).toBeDefined();
    expect(reg!.metric).toBe('mrr');
    expect(reg!.text).toContain('25.0%');
  });

  test('missed predictions surface as red flags', () => {
    const sc = computeFounderScorecard({
      entitySlug: 'companies/missed',
      windowSince: null, windowUntil: null,
      points: [],
      takes: [
        take({ id: 1, claim: 'predicted X by June, did not hit it', resolved_outcome: false }),
      ],
    });
    const missed = sc.red_flags.find(f => f.kind === 'missed_prediction');
    expect(missed).toBeDefined();
    expect(missed!.text).toContain('did not hit it');
  });

  test('high drift score (>=0.5) fires a narrative_drift flag', () => {
    function v(i: number): Float32Array {
      const a = new Float32Array(8);
      a[i % 8] = 1.0;
      return a;
    }
    const sc = computeFounderScorecard({
      entitySlug: 'companies/drift',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'mrr', value: 100, date: '2026-01-15', emb: v(0) }),
        pt({ id: 2, metric: 'mrr', value: 101, date: '2026-04-12', emb: v(3) }),
        pt({ id: 3, metric: 'mrr', value: 102, date: '2026-07-08', emb: v(6) }),
      ],
      takes: [],
    });
    const drift = sc.red_flags.find(f => f.kind === 'narrative_drift');
    expect(drift).toBeDefined();
  });

  test('clean trajectory + accurate takes + low drift = zero red flags', () => {
    function v(): Float32Array {
      const a = new Float32Array(8);
      a[0] = 1.0;
      return a;
    }
    const sc = computeFounderScorecard({
      entitySlug: 'companies/clean',
      windowSince: null, windowUntil: null,
      points: [
        pt({ id: 1, metric: 'mrr', value: 100, date: '2026-01-15', emb: v() }),
        pt({ id: 2, metric: 'mrr', value: 110, date: '2026-04-12', emb: v() }),
        pt({ id: 3, metric: 'mrr', value: 120, date: '2026-07-08', emb: v() }),
      ],
      takes: [
        take({ id: 1, claim: 'accurate prediction', resolved_outcome: true }),
      ],
    });
    expect(sc.red_flags).toEqual([]);
  });
});
