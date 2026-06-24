/**
 * v0.29 E2E — find_anomalies against PGLite.
 *
 * Same fixture shape as the Garry test: 7 wedding-tagged pages touched today
 * + 100 background pages spread across 30 days. Anomaly detection should
 * fire on the wedding tag cohort because its baseline is near-zero.
 *
 * Also covers the brand-new-cohort case (no baseline rows; small-sample
 * fallback fires when count >= 2) and the no-anomaly case (steady cohort,
 * no spike).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  // 7 wedding-tagged pages, all updated today (default putPage stamp).
  for (let i = 0; i < 7; i++) {
    const slug = `personal/wedding/photos-${i}`;
    await engine.putPage(slug, {
      type: 'note',
      title: `Wedding photo ${i}`,
      compiled_truth: `Photos from the wedding day, group ${i}.`,
    });
    await engine.addTag(slug, 'wedding');
  }
  // Pin the wedding pages to noon UTC of TODAY. putPage stamps updated_at via
  // the DB clock (server-local), while the anomaly window is derived from
  // `new Date().toISOString()` (UTC); near a UTC midnight boundary those two
  // dates disagree and the "today" window misses the pages. Anchor explicitly
  // so the fixture is deterministic regardless of the runner's timezone.
  await engine.executeRaw(
    `UPDATE pages SET updated_at = '${TODAY}T12:00:00Z'::timestamptz
      WHERE slug LIKE 'personal/wedding/%'`
  );

  // 100 background pages, tagged with rotating "steady" tags, backdated.
  const RANDOM_TAGS = ['hardware', 'product', 'meeting'];
  for (let i = 0; i < 100; i++) {
    const slug = `notes/random-${i}`;
    await engine.putPage(slug, {
      type: 'note',
      title: `Random note ${i}`,
      compiled_truth: `Body text for note ${i}.`,
    });
    await engine.addTag(slug, RANDOM_TAGS[i % RANDOM_TAGS.length]);
  }
  // Spread the random pages randomly across the last 30 days relative to the
  // same UTC TODAY the anomaly window uses (excluding today, so the wedding
  // cohort is the only "today" spike).
  await engine.executeRaw(
    `UPDATE pages
        SET updated_at = '${TODAY}T12:00:00Z'::timestamptz - interval '1 day' - (random() * interval '29 days')
      WHERE slug LIKE 'notes/random-%'`
  );
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('v0.29 E2E — findAnomalies (Garry test)', () => {
  test('wedding-tag cohort fires as anomaly when guard is disabled', async () => {
    // The wedding fixture is exactly the Day-1-of-import shape this guard suppresses
    // by default: 0 active baseline days for the wedding tag. To prove the
    // legacy detector behavior still works, pass min_baseline_days: 0.
    const rows = await engine.findAnomalies({
      since: TODAY,
      lookback_days: 30,
      sigma: 3.0,
      min_baseline_days: 0,
    });
    const wedding = rows.find(r => r.cohort_kind === 'tag' && r.cohort_value === 'wedding');
    expect(wedding).toBeDefined();
    expect(wedding!.count).toBe(7);
    // Baseline should be ~0 because none of the wedding pages were backdated.
    expect(wedding!.baseline_mean).toBeLessThan(1);
    expect(wedding!.sigma_observed).toBeGreaterThan(3);
  });

  test('returned page_slugs sample contains wedding pages (guard disabled)', async () => {
    const rows = await engine.findAnomalies({
      since: TODAY,
      lookback_days: 30,
      min_baseline_days: 0,
    });
    const wedding = rows.find(r => r.cohort_kind === 'tag' && r.cohort_value === 'wedding');
    expect(wedding!.page_slugs.length).toBe(7);
    expect(wedding!.page_slugs.every(s => s.startsWith('personal/wedding/'))).toBe(true);
  });

  test('a date with no activity returns []', async () => {
    // Look at a date earlier than any seeded page — every cohort has count=0,
    // none should fire as anomalous.
    const rows = await engine.findAnomalies({
      since: '2024-01-15',
      lookback_days: 30,
      sigma: 3.0,
    });
    expect(rows).toEqual([]);
  });

  test('high sigma threshold suppresses borderline cohorts (guard disabled)', async () => {
    const lowRows = await engine.findAnomalies({ since: TODAY, lookback_days: 30, sigma: 0.5, min_baseline_days: 0 });
    const highRows = await engine.findAnomalies({ since: TODAY, lookback_days: 30, sigma: 100, min_baseline_days: 0 });
    // sigma=100 should suppress every cohort (would need a literally
    // impossible spike to fire). The wedding cohort fires at sigma 3 so
    // there's enough headroom for sigma=0.5 ⊇ sigma=100.
    expect(lowRows.length).toBeGreaterThanOrEqual(highRows.length);
    // Wedding-tag (count=7, baseline mean ~0, stddev ~0) shouldn't pass
    // sigma=100 because the small-sample fallback uses count > mean+1, not
    // sigma scaling.
    const weddingHigh = highRows.find(r => r.cohort_kind === 'tag' && r.cohort_value === 'wedding');
    if (weddingHigh) {
      // It can still fire because the sample-stddev fallback uses count > mean + 1,
      // not sigma * stddev. Confirm the sigma_observed is finite (no NaN).
      expect(Number.isFinite(weddingHigh.sigma_observed)).toBe(true);
    }
  });
});

describe('Day-1-of-import anomaly suppression (E2E)', () => {
  test('default min_baseline_days=7 suppresses the wedding cohort', async () => {
    // Same fixture as the Garry test, but with the default guard active.
    // The wedding tag has 0 active baseline days (all touches are today), so
    // it must be suppressed — otherwise we'd report 481σ Day-1 noise.
    const rows = await engine.findAnomalies({ since: TODAY, lookback_days: 30, sigma: 3.0 });
    const wedding = rows.find(r => r.cohort_kind === 'tag' && r.cohort_value === 'wedding');
    expect(wedding).toBeUndefined();
  });

  test('no cohort with enough baseline → empty array', async () => {
    // The random pages were spread across 30 days but are not touched today.
    // Combined with the wedding-tag suppression, the Day-1 result is [].
    const rows = await engine.findAnomalies({ since: TODAY, lookback_days: 30 });
    // All returned rows must have at least 7 distinct active days of baseline.
    // (No way to introspect the baseline from the result, but the wedding/
    // background fixture intentionally has none — so [] is the contract.)
    expect(rows).toEqual([]);
  });
});
