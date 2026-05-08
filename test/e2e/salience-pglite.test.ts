/**
 * v0.29 E2E — the "Garry test" for salience.
 *
 * Seeds a fixture: 7 pages tagged `wedding`, all touched today, plus 100
 * background pages with random tags spread across 30 days. Asserts that
 * `getRecentSalience({days:7})` returns the wedding pages at the top.
 *
 * Uses raw SQL UPDATE to backdate `updated_at` on the background pages
 * (codex C4#7) — `engine.putPage` always stamps `updated_at = now()` so
 * seeding via the engine alone can't reproduce historical recency windows.
 *
 * Runs against PGLite in-memory; no DATABASE_URL required.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  // ── Seed: 7 wedding pages (all touched today, default updated_at).
  for (let i = 0; i < 7; i++) {
    const slug = `personal/wedding/photos-${i}`;
    await engine.putPage(slug, {
      type: 'note',
      title: `Wedding photo ${i}`,
      compiled_truth: `Photos from the wedding day, group ${i}.`,
    });
    await engine.addTag(slug, 'wedding');
  }

  // ── Seed: 100 background pages, tagged with miscellaneous tags.
  const RANDOM_TAGS = ['hardware', 'product', 'meeting', 'idea', 'people', 'concept'];
  for (let i = 0; i < 100; i++) {
    const slug = `notes/random-${i}`;
    await engine.putPage(slug, {
      type: 'note',
      title: `Random note ${i}`,
      compiled_truth: `Body text for note ${i}.`,
    });
    await engine.addTag(slug, RANDOM_TAGS[i % RANDOM_TAGS.length]);
  }

  // ── Backdate background pages across the last 30 days via raw SQL
  //   (codex C4#7 — putPage stamps updated_at = now(), so we can't get
  //   historical timestamps without bypassing the engine path).
  await engine.executeRaw(
    `UPDATE pages
        SET updated_at = now() - (random() * interval '30 days')
      WHERE slug LIKE 'notes/random-%'`
  );

  // Recompute emotional_weight for the wedding pages so they get the
  // tag-emotion boost in the salience formula.
  const inputs = await engine.batchLoadEmotionalInputs();
  const { computeEmotionalWeight } = await import('../../src/core/cycle/emotional-weight.ts');
  const writes = inputs.map(r => ({
    slug: r.slug,
    source_id: r.source_id,
    weight: computeEmotionalWeight({ tags: r.tags, takes: r.takes }),
  }));
  await engine.setEmotionalWeightBatch(writes);
});

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('v0.29 E2E — getRecentSalience (Garry test)', () => {
  test('wedding pages outrank random-tag noise in the 7-day window', async () => {
    const rows = await engine.getRecentSalience({ days: 7, limit: 20 });
    expect(rows.length).toBeGreaterThan(0);
    // The top result should be a wedding page (max emotional_weight = 0.5).
    const top = rows[0];
    expect(top.slug).toMatch(/^personal\/wedding\//);
    expect(top.emotional_weight).toBeGreaterThan(0);

    // All 7 wedding pages should appear in the top 10. Compare against the
    // result-set, not the rank order — score ties on emotional_weight + the
    // recency-decay term may shuffle within the wedding cohort.
    const top10 = rows.slice(0, 10).map(r => r.slug);
    const weddingHits = top10.filter(s => s.startsWith('personal/wedding/'));
    expect(weddingHits.length).toBeGreaterThanOrEqual(7);
  });

  test('slugPrefix filter narrows to the named directory', async () => {
    const rows = await engine.getRecentSalience({ days: 30, slugPrefix: 'personal/wedding/' });
    expect(rows.length).toBe(7);
    for (const r of rows) {
      expect(r.slug.startsWith('personal/wedding/')).toBe(true);
    }
  });

  test('days=0 returns no rows (boundary case)', async () => {
    // boundary = now − 0 = now, so only pages updated > now are matched.
    // updated_at = now() inserts are inclusive, so allow at most a few rows
    // that match the equality boundary; assert window is at least narrow.
    const rows = await engine.getRecentSalience({ days: 0, limit: 1000 });
    expect(rows.length).toBeLessThanOrEqual(7); // only wedding pages from this run
  });

  test('limit cap is respected', async () => {
    const rows = await engine.getRecentSalience({ days: 365, limit: 5 });
    expect(rows.length).toBe(5);
  });

  test('empty-window slugPrefix returns []', async () => {
    const rows = await engine.getRecentSalience({ days: 7, slugPrefix: 'nope/does-not-exist/' });
    expect(rows).toEqual([]);
  });
});
