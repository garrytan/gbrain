/**
 * v0.40.2.0 — Engine parity: facts.event_type round-trips through both
 * findTrajectory paths.
 *
 * Verifies that the new event_type column on facts is correctly projected
 * by PGLite. Postgres parity is gated on DATABASE_URL and runs only when
 * the real Postgres is available (test/e2e/* pattern); see TODOS for the
 * E2E variant.
 *
 * Hermetic, no API keys.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('PGLite — facts.event_type round-trip', () => {
  test('event_type column is queryable and projects through findTrajectory', async () => {
    // Insert one metric row + one event-only row + one row with neither set
    // for the same entity.
    await engine.executeRaw(`
      INSERT INTO facts (
        source_id, entity_slug, fact, kind, visibility,
        valid_from, source, source_session,
        claim_metric, claim_value, claim_unit, claim_period,
        event_type
      ) VALUES
        ('default', 'people/alice', 'MRR = 50000', 'fact', 'private',
         '2026-01-01T00:00:00Z', 'test', 'sess-1',
         'mrr', 50000, 'USD', 'monthly',
         NULL),
        ('default', 'people/alice', 'last met at Blue Bottle', 'event', 'private',
         '2026-02-15T00:00:00Z', 'test', 'sess-2',
         NULL, NULL, NULL, NULL,
         'meeting'),
        ('default', 'people/alice', 'legacy free-text fact', 'fact', 'private',
         '2026-03-01T00:00:00Z', 'test', 'sess-3',
         NULL, NULL, NULL, NULL,
         NULL)
    `);

    // kind: 'all' (default) returns all three
    const all = await engine.findTrajectory({ entitySlug: 'people/alice' });
    expect(all.length).toBe(3);

    // Find the event row and assert event_type round-trips
    const eventRow = all.find(p => p.event_type === 'meeting');
    expect(eventRow).toBeDefined();
    expect(eventRow!.metric).toBeNull();
    expect(eventRow!.value).toBeNull();
    expect(eventRow!.text).toBe('last met at Blue Bottle');

    // Find the metric row and assert event_type is null
    const metricRow = all.find(p => p.metric === 'mrr');
    expect(metricRow).toBeDefined();
    expect(metricRow!.event_type).toBeNull();
    expect(metricRow!.value).toBe(50000);

    // Find the legacy row and assert both null
    const legacyRow = all.find(p => p.text === 'legacy free-text fact');
    expect(legacyRow).toBeDefined();
    expect(legacyRow!.metric).toBeNull();
    expect(legacyRow!.event_type).toBeNull();
  });

  test('kind: "metric" filter returns only typed-claim rows', async () => {
    const points = await engine.findTrajectory({
      entitySlug: 'people/alice',
      kind: 'metric',
    });
    expect(points.length).toBe(1);
    expect(points[0].metric).toBe('mrr');
    expect(points[0].event_type).toBeNull();
  });

  test('kind: "event" filter returns only event_type rows', async () => {
    const points = await engine.findTrajectory({
      entitySlug: 'people/alice',
      kind: 'event',
    });
    expect(points.length).toBe(1);
    expect(points[0].metric).toBeNull();
    expect(points[0].event_type).toBe('meeting');
  });

  test('kind: "all" explicit matches default', async () => {
    const explicit = await engine.findTrajectory({
      entitySlug: 'people/alice',
      kind: 'all',
    });
    const implicit = await engine.findTrajectory({ entitySlug: 'people/alice' });
    expect(explicit.length).toBe(implicit.length);
    expect(explicit.length).toBe(3);
  });

  test('chronological ordering preserved when mixed metric + event rows', async () => {
    const points = await engine.findTrajectory({ entitySlug: 'people/alice' });
    expect(points.length).toBe(3);
    // 2026-01-01 → 2026-02-15 → 2026-03-01
    expect(points[0].valid_from.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(points[1].valid_from.toISOString().slice(0, 10)).toBe('2026-02-15');
    expect(points[2].valid_from.toISOString().slice(0, 10)).toBe('2026-03-01');
  });

  test('metric filter still works alongside event_type column', async () => {
    // Existing `metric` filter is a SEPARATE narrow — pinpoints one
    // canonical metric label. event_type doesn't change its behavior.
    const points = await engine.findTrajectory({
      entitySlug: 'people/alice',
      metric: 'mrr',
    });
    expect(points.length).toBe(1);
    expect(points[0].metric).toBe('mrr');
  });
});
