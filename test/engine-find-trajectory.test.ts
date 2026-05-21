/**
 * v0.35.4 — BrainEngine.findTrajectory (T4) + trajectory.ts derived
 * metrics tests.
 *
 * Pins:
 *   - Chronological ordering by (valid_from ASC, fact_id ASC) — R3.
 *   - Source scoping (scalar + federated array, D-CDX-6).
 *   - Visibility filter for remote callers (D-CDX-1) — R6.
 *   - Metric filter narrows results to a single canonical name.
 *   - since/until window honored.
 *   - Regression detection per locked threshold (D-ENG-2).
 *   - Drift score returns null when <3 embedded points (G3).
 *   - Empty entity returns {points: [], regressions: [], drift_score: null} (G1).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  detectRegressions,
  computeDriftScore,
  computeTrajectoryStats,
  DEFAULT_REGRESSION_THRESHOLD,
} from '../src/core/trajectory.ts';
import type { TrajectoryPoint } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM facts WHERE entity_slug LIKE 'traj-%'`);
  await engine.executeRaw(`DELETE FROM sources WHERE id LIKE 'traj-%'`);
});

function vecForMetric(metric: string, offset: number): string {
  // Deterministic per-metric/offset embedding: each metric gets a
  // unit-vector in a different "direction" of the embedding space, with
  // a small perturbation per offset so consecutive same-metric facts
  // are very-similar-but-not-identical (drift score lands between 0 and
  // some small value).
  const a = new Float32Array(1536);
  const idx = (metric.charCodeAt(0) + offset) % 1536;
  a[idx] = 1.0;
  a[(idx + 1) % 1536] = 0.05 * offset;  // tiny drift between consecutive
  return '[' + Array.from(a).join(',') + ']';
}

async function insertTyped(args: {
  source_id?: string;
  entity_slug: string;
  metric: string;
  value: number;
  unit?: string;
  period?: string;
  valid_from: Date;
  visibility?: 'private' | 'world';
  offset?: number;
  text?: string;
}): Promise<number> {
  const sid = args.source_id ?? 'default';
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`,
    [sid],
  );
  const r = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from,
                        claim_metric, claim_value, claim_unit, claim_period,
                        visibility, embedding, embedded_at)
     VALUES ($1, $2, $3, 'fact', 'test', $4::timestamptz,
             $5, $6, $7, $8,
             $9, $10::vector, $4::timestamptz)
     RETURNING id`,
    [
      sid, args.entity_slug, args.text ?? `${args.metric} ${args.value}`,
      args.valid_from.toISOString(),
      args.metric, args.value, args.unit ?? null, args.period ?? null,
      args.visibility ?? 'private',
      vecForMetric(args.metric, args.offset ?? 0),
    ],
  );
  return r[0].id;
}

describe('findTrajectory — chronological ordering (R3)', () => {
  test('returns points in (valid_from ASC, id ASC) order regardless of insert order', async () => {
    // Insert out of order. Engine must re-order.
    const idJul = await insertTyped({ entity_slug: 'traj-order', metric: 'mrr', value: 150000, valid_from: new Date('2026-07-08') });
    const idJan = await insertTyped({ entity_slug: 'traj-order', metric: 'mrr', value: 50000,  valid_from: new Date('2026-01-15') });
    const idApr = await insertTyped({ entity_slug: 'traj-order', metric: 'mrr', value: 200000, valid_from: new Date('2026-04-12') });

    const points = await engine.findTrajectory({ entitySlug: 'traj-order' });
    expect(points.map(p => p.fact_id)).toEqual([idJan, idApr, idJul]);
    expect(points[0].valid_from.toISOString().slice(0, 10)).toBe('2026-01-15');
    expect(points[2].valid_from.toISOString().slice(0, 10)).toBe('2026-07-08');
  });
});

describe('findTrajectory — source scoping (D-CDX-6)', () => {
  test('scalar sourceId returns only that source', async () => {
    await insertTyped({ source_id: 'traj-src-A', entity_slug: 'traj-srcscope', metric: 'mrr', value: 50000, valid_from: new Date('2026-01-15') });
    await insertTyped({ source_id: 'traj-src-B', entity_slug: 'traj-srcscope', metric: 'mrr', value: 99999, valid_from: new Date('2026-01-15') });

    const pointsA = await engine.findTrajectory({ entitySlug: 'traj-srcscope', sourceId: 'traj-src-A' });
    expect(pointsA.length).toBe(1);
    expect(pointsA[0].value).toBe(50000);

    const pointsB = await engine.findTrajectory({ entitySlug: 'traj-srcscope', sourceId: 'traj-src-B' });
    expect(pointsB.length).toBe(1);
    expect(pointsB[0].value).toBe(99999);
  });

  test('federated sourceIds returns union across the array', async () => {
    await insertTyped({ source_id: 'traj-src-A', entity_slug: 'traj-fed', metric: 'mrr', value: 50000, valid_from: new Date('2026-01-15') });
    await insertTyped({ source_id: 'traj-src-B', entity_slug: 'traj-fed', metric: 'mrr', value: 99999, valid_from: new Date('2026-04-12') });
    await insertTyped({ source_id: 'traj-src-C', entity_slug: 'traj-fed', metric: 'mrr', value: 11111, valid_from: new Date('2026-07-08') });

    const points = await engine.findTrajectory({
      entitySlug: 'traj-fed',
      sourceIds: ['traj-src-A', 'traj-src-B'],
    });
    // Two of three sources visible, in chronological order.
    expect(points.length).toBe(2);
    expect(points.map(p => p.value)).toEqual([50000, 99999]);
  });
});

describe('findTrajectory — visibility filter (D-CDX-1 / R6)', () => {
  test('remote=true returns ONLY world-visibility points', async () => {
    await insertTyped({ entity_slug: 'traj-vis', metric: 'mrr', value: 50000, visibility: 'private', valid_from: new Date('2026-01-15') });
    await insertTyped({ entity_slug: 'traj-vis', metric: 'mrr', value: 99999, visibility: 'world',   valid_from: new Date('2026-04-12') });

    const trusted = await engine.findTrajectory({ entitySlug: 'traj-vis', remote: false });
    expect(trusted.length).toBe(2);  // local CLI sees both

    const remote = await engine.findTrajectory({ entitySlug: 'traj-vis', remote: true });
    expect(remote.length).toBe(1);   // OAuth client sees world only
    expect(remote[0].value).toBe(99999);
  });

  test('remote default (undefined) is treated as trusted — sees both', async () => {
    await insertTyped({ entity_slug: 'traj-vis-default', metric: 'mrr', value: 50000, visibility: 'private', valid_from: new Date('2026-01-15') });
    await insertTyped({ entity_slug: 'traj-vis-default', metric: 'mrr', value: 99999, visibility: 'world',   valid_from: new Date('2026-04-12') });

    // No `remote` field — engine default must be trusted.
    const all = await engine.findTrajectory({ entitySlug: 'traj-vis-default' });
    expect(all.length).toBe(2);
  });
});

describe('findTrajectory — metric + since + until filters', () => {
  test('metric filter narrows to one canonical name', async () => {
    await insertTyped({ entity_slug: 'traj-m', metric: 'mrr', value: 50000, valid_from: new Date('2026-01-15') });
    await insertTyped({ entity_slug: 'traj-m', metric: 'arr', value: 600000, valid_from: new Date('2026-01-15') });

    const mrrOnly = await engine.findTrajectory({ entitySlug: 'traj-m', metric: 'mrr' });
    expect(mrrOnly.length).toBe(1);
    expect(mrrOnly[0].metric).toBe('mrr');
  });

  test('since/until window honored', async () => {
    await insertTyped({ entity_slug: 'traj-w', metric: 'mrr', value: 50000, valid_from: new Date('2026-01-15') });
    await insertTyped({ entity_slug: 'traj-w', metric: 'mrr', value: 99999, valid_from: new Date('2026-04-12') });
    await insertTyped({ entity_slug: 'traj-w', metric: 'mrr', value: 11111, valid_from: new Date('2026-07-08') });

    const inWindow = await engine.findTrajectory({
      entitySlug: 'traj-w',
      since: '2026-02-01',
      until: '2026-05-01',
    });
    expect(inWindow.length).toBe(1);
    expect(inWindow[0].value).toBe(99999);
  });

  test('unknown entity returns empty array', async () => {
    const empty = await engine.findTrajectory({ entitySlug: 'traj-does-not-exist' });
    expect(empty).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// trajectory.ts pure-function tests
// ────────────────────────────────────────────────────────────────────────

function makePoint(args: {
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

describe('detectRegressions (D-ENG-2)', () => {
  test('emits a regression when newer value drops by >= threshold', () => {
    const points: TrajectoryPoint[] = [
      makePoint({ id: 1, metric: 'mrr', value: 200000, date: '2026-04-12' }),
      makePoint({ id: 2, metric: 'mrr', value: 150000, date: '2026-07-08' }),  // -25%
    ];
    const regs = detectRegressions(points, DEFAULT_REGRESSION_THRESHOLD);
    expect(regs.length).toBe(1);
    expect(regs[0].metric).toBe('mrr');
    expect(regs[0].delta_pct).toBeCloseTo(-0.25, 4);
    expect(regs[0].from_date).toBe('2026-04-12');
    expect(regs[0].to_date).toBe('2026-07-08');
  });

  test('skips when drop is below threshold (5% with default 10%)', () => {
    const points: TrajectoryPoint[] = [
      makePoint({ id: 1, metric: 'mrr', value: 100000, date: '2026-01-15' }),
      makePoint({ id: 2, metric: 'mrr', value:  95000, date: '2026-04-12' }),  // -5%
    ];
    expect(detectRegressions(points).length).toBe(0);
  });

  test('multiple metrics tracked independently', () => {
    const points: TrajectoryPoint[] = [
      makePoint({ id: 1, metric: 'mrr', value: 200000, date: '2026-04-12' }),
      makePoint({ id: 2, metric: 'arr', value: 600000, date: '2026-04-12' }),
      makePoint({ id: 3, metric: 'mrr', value: 150000, date: '2026-07-08' }),  // -25% mrr
      makePoint({ id: 4, metric: 'arr', value: 700000, date: '2026-07-08' }),  // +16% arr → no regression
    ];
    const regs = detectRegressions(points);
    expect(regs.length).toBe(1);
    expect(regs[0].metric).toBe('mrr');
  });

  test('skips points with null value', () => {
    const points: TrajectoryPoint[] = [
      makePoint({ id: 1, metric: 'mrr', value: 200000, date: '2026-04-12' }),
      { ...makePoint({ id: 2, metric: 'mrr', value: 0, date: '2026-07-08' }), value: null },
    ];
    expect(detectRegressions(points).length).toBe(0);
  });

  test('skips when older value is 0 (division-by-zero guard)', () => {
    const points: TrajectoryPoint[] = [
      makePoint({ id: 1, metric: 'mrr', value:    0, date: '2026-04-12' }),
      makePoint({ id: 2, metric: 'mrr', value: 1000, date: '2026-07-08' }),
    ];
    expect(detectRegressions(points).length).toBe(0);
  });
});

describe('computeDriftScore (D-ENG-3 / G3)', () => {
  function unitVec(dim: number, offset: number): Float32Array {
    const a = new Float32Array(8);
    a[offset % 8] = 1.0;
    return a;
  }

  test('returns null with fewer than 3 embedded points', () => {
    const points: TrajectoryPoint[] = [
      makePoint({ id: 1, metric: 'mrr', value: 1, date: '2026-01-15', emb: unitVec(8, 0) }),
      makePoint({ id: 2, metric: 'mrr', value: 2, date: '2026-04-12', emb: unitVec(8, 1) }),
    ];
    expect(computeDriftScore(points)).toBeNull();
  });

  test('returns null when no points have embeddings (G3 graceful fallback)', () => {
    const points: TrajectoryPoint[] = [
      makePoint({ id: 1, metric: 'mrr', value: 1, date: '2026-01-15' }),
      makePoint({ id: 2, metric: 'mrr', value: 2, date: '2026-04-12' }),
      makePoint({ id: 3, metric: 'mrr', value: 3, date: '2026-07-08' }),
    ];
    expect(computeDriftScore(points)).toBeNull();
  });

  test('identical consecutive embeddings → drift 0 (cohesive narrative)', () => {
    const v = unitVec(8, 0);
    const points: TrajectoryPoint[] = [
      makePoint({ id: 1, metric: 'mrr', value: 1, date: '2026-01-15', emb: v }),
      makePoint({ id: 2, metric: 'mrr', value: 2, date: '2026-04-12', emb: v }),
      makePoint({ id: 3, metric: 'mrr', value: 3, date: '2026-07-08', emb: v }),
    ];
    expect(computeDriftScore(points)).toBe(0);
  });

  test('orthogonal consecutive embeddings → drift 1 (every claim unrelated)', () => {
    const points: TrajectoryPoint[] = [
      makePoint({ id: 1, metric: 'mrr', value: 1, date: '2026-01-15', emb: unitVec(8, 0) }),
      makePoint({ id: 2, metric: 'mrr', value: 2, date: '2026-04-12', emb: unitVec(8, 1) }),
      makePoint({ id: 3, metric: 'mrr', value: 3, date: '2026-07-08', emb: unitVec(8, 2) }),
    ];
    expect(computeDriftScore(points)).toBe(1);
  });
});

describe('computeTrajectoryStats — composed shape', () => {
  test('returns both regressions + drift_score in one call', () => {
    const v = new Float32Array(4);
    v[0] = 1;
    const points: TrajectoryPoint[] = [
      makePoint({ id: 1, metric: 'mrr', value: 200000, date: '2026-04-12', emb: v }),
      makePoint({ id: 2, metric: 'mrr', value: 150000, date: '2026-07-08', emb: v }),
    ];
    const stats = computeTrajectoryStats(points);
    expect(stats.regressions.length).toBe(1);
    expect(stats.drift_score).toBeNull(); // <3 embedded
  });
});
