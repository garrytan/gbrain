/**
 * v0.29 — Engine parity: salience + anomalies on PGLite vs Postgres.
 *
 * Codex flagged in the v0.22.0 source-boost review that engine-shape
 * differences (postgres.js vs PGLite SQL idioms) can silently diverge
 * results. The same risk applies to the new v0.29 ops:
 *   - getRecentSalience uses EXTRACT(EPOCH FROM ...), ln(), GROUP BY p.id.
 *   - findAnomalies uses generate_series + date_trunc + array_agg.
 *
 * This test seeds identical fixtures into both engines, runs the v0.29
 * ops, and asserts the result sets line up.
 *
 * DATABASE_URL gated — skips gracefully when not set.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const SKIP_PG = !hasDatabase();
const describeBoth = SKIP_PG ? describe.skip : describe;

const TODAY = new Date().toISOString().slice(0, 10);

async function seedFixture(engine: BrainEngine): Promise<void> {
  // 5 wedding-tagged pages, all updated today.
  for (let i = 0; i < 5; i++) {
    const slug = `personal/wedding/photos-${i}`;
    await engine.putPage(slug, {
      type: 'note',
      title: `Wedding photo ${i}`,
      compiled_truth: 'photos',
    });
    await engine.addTag(slug, 'wedding');
  }
  // 30 background pages backdated across 30 days.
  for (let i = 0; i < 30; i++) {
    const slug = `notes/random-${i}`;
    await engine.putPage(slug, {
      type: 'note',
      title: `Random ${i}`,
      compiled_truth: 'body',
    });
    await engine.addTag(slug, ['hardware', 'product', 'idea'][i % 3]);
  }
  await engine.executeRaw(
    `UPDATE pages
        SET updated_at = now() - interval '1 day' - (random() * interval '29 days')
      WHERE slug LIKE 'notes/random-%'`
  );
  await engine.executeRaw(
    `UPDATE pages SET emotional_weight = 0.5
      WHERE slug LIKE 'personal/wedding/%'`,
  );

  for (const slug of [
    'eligibility/past-zero',
    'eligibility/today-zero',
    'eligibility/future-zero',
    'eligibility/future-emotional',
    'eligibility/future-take',
    'eligibility/deleted',
  ]) {
    await engine.putPage(slug, {
      type: 'note',
      title: slug,
      compiled_truth: 'salience parity fixture',
    });
  }
  await engine.executeRaw(
    `UPDATE pages
        SET effective_date = CASE slug
          WHEN 'eligibility/past-zero' THEN now() - interval '1 day'
          WHEN 'eligibility/today-zero' THEN now()
          ELSE now() + interval '30 days'
        END
      WHERE slug LIKE 'eligibility/%'`,
  );
  await engine.executeRaw(
    `UPDATE pages SET emotional_weight = 0.1
      WHERE slug = 'eligibility/future-emotional'`,
  );
  await engine.executeRaw(
    `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active)
       SELECT id, 1, 'future signal', 'take', 'self', 0.7, TRUE
         FROM pages WHERE slug = 'eligibility/future-take'`,
  );
  await engine.softDeletePage('eligibility/deleted');
}

describeBoth('v0.29 engine parity — getRecentSalience', () => {
  let pglite: PGLiteEngine;
  let postgres: BrainEngine;

  beforeAll(async () => {
    pglite = new PGLiteEngine();
    await pglite.connect({ engine: 'pglite' } as never);
    await pglite.initSchema();
    await seedFixture(pglite);

    postgres = await setupDB();
    await seedFixture(postgres);
  }, 60_000);

  afterAll(async () => {
    if (pglite) await pglite.disconnect();
    await teardownDB();
  });

  test('top result is a wedding page on both engines', async () => {
    const pgliteRows = await pglite.getRecentSalience({ days: 7, limit: 5 });
    const postgresRows = await postgres.getRecentSalience({ days: 7, limit: 5 });
    expect(pgliteRows.length).toBeGreaterThan(0);
    expect(postgresRows.length).toBeGreaterThan(0);
    expect(pgliteRows[0].slug.startsWith('personal/wedding/')).toBe(true);
    expect(postgresRows[0].slug.startsWith('personal/wedding/')).toBe(true);
  });

  test('same set of wedding slugs returned in the top 5 on both engines', async () => {
    const pgliteRows = await pglite.getRecentSalience({ days: 7, limit: 10 });
    const postgresRows = await postgres.getRecentSalience({ days: 7, limit: 10 });
    const pgliteWedding = new Set(pgliteRows.filter(r => r.slug.startsWith('personal/wedding/')).map(r => r.slug));
    const postgresWedding = new Set(postgresRows.filter(r => r.slug.startsWith('personal/wedding/')).map(r => r.slug));
    expect(pgliteWedding.size).toBe(postgresWedding.size);
    for (const s of pgliteWedding) expect(postgresWedding.has(s)).toBe(true);
  });

  test('future eligibility, deletion, finite scoring, and explicit inclusion match', async () => {
    for (const includeFuture of [false, true]) {
      const opts = {
        days: 7,
        limit: 20,
        slugPrefix: 'eligibility/',
        recency_bias: 'on' as const,
        includeFuture,
      };
      const pgliteRows = await pglite.getRecentSalience(opts);
      const postgresRows = await postgres.getRecentSalience(opts);
      const pgliteSlugs = pgliteRows.map(row => row.slug).sort();
      const postgresSlugs = postgresRows.map(row => row.slug).sort();
      expect(pgliteSlugs).toEqual(postgresSlugs);
      expect(pgliteRows.every(row => Number.isFinite(row.score))).toBe(true);
      expect(postgresRows.every(row => Number.isFinite(row.score))).toBe(true);
      expect(pgliteSlugs).not.toContain('eligibility/deleted');
      expect(pgliteSlugs.includes('eligibility/future-zero')).toBe(includeFuture);
    }
  });
});

describeBoth('v0.29 engine parity — findAnomalies', () => {
  let pglite: PGLiteEngine;
  let postgres: BrainEngine;

  beforeAll(async () => {
    pglite = new PGLiteEngine();
    await pglite.connect({ engine: 'pglite' } as never);
    await pglite.initSchema();
    await seedFixture(pglite);

    postgres = await setupDB();
    await seedFixture(postgres);
  }, 60_000);

  afterAll(async () => {
    if (pglite) await pglite.disconnect();
    await teardownDB();
  });

  test('wedding tag cohort fires on both engines with similar counts', async () => {
    const pgliteRows = await pglite.findAnomalies({ since: TODAY, lookback_days: 30, sigma: 2 });
    const postgresRows = await postgres.findAnomalies({ since: TODAY, lookback_days: 30, sigma: 2 });
    const pgliteWedding = pgliteRows.find(r => r.cohort_kind === 'tag' && r.cohort_value === 'wedding');
    const postgresWedding = postgresRows.find(r => r.cohort_kind === 'tag' && r.cohort_value === 'wedding');
    expect(pgliteWedding).toBeDefined();
    expect(postgresWedding).toBeDefined();
    expect(pgliteWedding!.count).toBe(5);
    expect(postgresWedding!.count).toBe(5);
    // baseline mean should be very small (random-tag pages don't carry "wedding").
    expect(pgliteWedding!.baseline_mean).toBeLessThan(1);
    expect(postgresWedding!.baseline_mean).toBeLessThan(1);
  });
});
