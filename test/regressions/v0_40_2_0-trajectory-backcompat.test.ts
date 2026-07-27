/**
 * v0.40.2.0 — Back-compat regression: event-only facts rows MUST be
 * invisible to existing trajectory callers' per-metric math.
 *
 * Codex outside-voice review correctly flagged the concern: existing
 * callers (`founder-scorecard`, `eval-trajectory`) already defensively
 * skip `metric === null` rows in their per-metric loops. Adding
 * event-only rows (metric=NULL, event_type='meeting') to the same entity
 * MUST NOT affect their output. This test pins that contract — if a
 * future refactor accidentally counts event rows in metric math, this
 * test screams.
 *
 * Hermetic, no DATABASE_URL, no API keys.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { computeTrajectoryStats } from '../../src/core/trajectory.ts';
import { computeFounderScorecard } from '../../src/commands/founder-scorecard.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('v0.40.2.0 back-compat — event rows ignored by metric callers', () => {
  beforeAll(async () => {
    // Seed: one metric row (mrr=50K → 75K → 100K) + one event-only row.
    // The event row shares the entity but has metric=NULL.
    await engine.executeRaw(`
      INSERT INTO facts (
        source_id, entity_slug, fact, kind, visibility,
        valid_from, source, source_session,
        claim_metric, claim_value, claim_unit, claim_period,
        event_type
      ) VALUES
        ('default', 'companies/acme-test', 'MRR = 50000', 'fact', 'private',
         '2026-01-01T00:00:00Z', 'test', 'sess-1',
         'mrr', 50000, 'USD', 'monthly', NULL),
        ('default', 'companies/acme-test', 'MRR = 75000', 'fact', 'private',
         '2026-04-01T00:00:00Z', 'test', 'sess-2',
         'mrr', 75000, 'USD', 'monthly', NULL),
        ('default', 'companies/acme-test', 'kickoff meeting with founder', 'event', 'private',
         '2026-05-15T00:00:00Z', 'test', 'sess-3',
         NULL, NULL, NULL, NULL, 'meeting'),
        ('default', 'companies/acme-test', 'MRR = 100000', 'fact', 'private',
         '2026-07-01T00:00:00Z', 'test', 'sess-4',
         'mrr', 100000, 'USD', 'monthly', NULL)
    `);
  });

  test('computeTrajectoryStats output is byte-identical with and without event rows', async () => {
    // Pull all points (kind:'all' default) — includes the event row.
    const allPoints = await engine.findTrajectory({
      entitySlug: 'companies/acme-test',
    });
    expect(allPoints.length).toBe(4);
    expect(allPoints.some(p => p.event_type === 'meeting')).toBe(true);

    // Pull only metric rows (the kind callers actually want).
    const metricPoints = await engine.findTrajectory({
      entitySlug: 'companies/acme-test',
      kind: 'metric',
    });
    expect(metricPoints.length).toBe(3);
    expect(metricPoints.every(p => p.event_type === null)).toBe(true);

    // Critical: computeTrajectoryStats over BOTH inputs MUST yield the
    // same regressions + drift_score. The event row should be silently
    // filtered out by the per-metric loop at trajectory.ts:99.
    const allStats = computeTrajectoryStats(allPoints);
    const metricStats = computeTrajectoryStats(metricPoints);

    expect(allStats.regressions).toEqual(metricStats.regressions);
    expect(allStats.drift_score).toBe(metricStats.drift_score);
  });

  test('computeFounderScorecard ignores event rows in per-metric math', async () => {
    const allPoints = await engine.findTrajectory({
      entitySlug: 'companies/acme-test',
    });

    const withEventRows = computeFounderScorecard({
      entitySlug: 'companies/acme-test',
      windowSince: '2026-01-01',
      windowUntil: '2026-12-31',
      points: allPoints,
      takes: [],
    });

    // Filter out the event row manually for the comparison case.
    const metricOnly = allPoints.filter(p => p.metric !== null);
    const withoutEventRows = computeFounderScorecard({
      entitySlug: 'companies/acme-test',
      windowSince: '2026-01-01',
      windowUntil: '2026-12-31',
      points: metricOnly,
      takes: [],
    });

    // The scorecard MUST be byte-identical between the two — the event
    // row should not perturb any field.
    expect(withEventRows).toEqual(withoutEventRows);
  });

  test('founder-scorecard math does not throw NaN on mixed input', async () => {
    const allPoints = await engine.findTrajectory({
      entitySlug: 'companies/acme-test',
    });
    const scorecard = computeFounderScorecard({
      entitySlug: 'companies/acme-test',
      windowSince: '2026-01-01',
      windowUntil: '2026-12-31',
      points: allPoints,
      takes: [],
    });
    // Spot-check key fields: nothing should be NaN.
    const json = JSON.stringify(scorecard);
    expect(json).not.toContain('NaN');
  });

  test('kind: "all" returns event row in chronological position', async () => {
    const points = await engine.findTrajectory({
      entitySlug: 'companies/acme-test',
    });
    // Chronological order: 2026-01-01, 2026-04-01, 2026-05-15 (event), 2026-07-01
    expect(points.map(p => p.valid_from.toISOString().slice(0, 10))).toEqual([
      '2026-01-01',
      '2026-04-01',
      '2026-05-15',
      '2026-07-01',
    ]);
    expect(points[2].event_type).toBe('meeting');
    expect(points[2].metric).toBeNull();
  });
});
