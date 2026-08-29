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
});

// ---------------------------------------------------------------------------
// D5 — setEmotionalWeightBatch + getSalienceScores write/read parity.
//
// Pinned engine shapes (src/core/{pglite,postgres}-engine/salience.ts +
// the getSalienceScores methods on both engine classes):
//   - setEmotionalWeightBatch(rows: {slug, source_id, weight}[]) → number of
//     MATCHED pages (composite (slug, source_id) join against unnest;
//     RETURNING 1 counts a match even when the weight value is unchanged;
//     rows whose (slug, source_id) matches no page are silently dropped).
//   - salience_touched_at = now() ONLY on the
//     `pages.emotional_weight IS DISTINCT FROM u.weight` branch; a same-value
//     write leaves the old timestamp untouched.
//   - getSalienceScores(refs: {slug, source_id}[]) → Map keyed
//     `${source_id}::${slug}`, score = COALESCE(emotional_weight,0)*5
//     + ln(1 + COUNT(DISTINCT active takes)); unmatched refs are absent.
// ---------------------------------------------------------------------------

// Weights chosen to be exactly representable in REAL (float4) so read-back
// equality across engines is exact, not approximate.
const D5_PAGES = [
  'salience/batch-changed',  // 0.5   → 0.875 (changed → touched bumps)
  'salience/batch-same',     // 0.25  → 0.25  (same value → no bump)
  'salience/batch-same-2',   // 0.75  → 0.75  (same value → no bump)
  'salience/batch-fresh',    // 0.0 (column default) → 0.125 (changed → bump)
];
const D5_MISSING_SLUG = 'salience/no-such-page';

interface D5Snapshot {
  firstCount: number;
  mixedCount: number;
  before: Map<string, number>;  // slug → EXTRACT(EPOCH FROM salience_touched_at)
  after: Map<string, number>;
  weights: Map<string, number>; // slug → stored emotional_weight
}

async function readTouchedEpochs(engine: BrainEngine): Promise<Map<string, number>> {
  const rows = await engine.executeRaw<{ slug: string; ts: string | number }>(
    `SELECT slug, EXTRACT(EPOCH FROM salience_touched_at) AS ts
       FROM pages WHERE slug LIKE 'salience/batch-%'`
  );
  return new Map(rows.map(r => [String(r.slug), Number(r.ts)]));
}

async function readStoredWeights(engine: BrainEngine): Promise<Map<string, number>> {
  const rows = await engine.executeRaw<{ slug: string; w: string | number }>(
    `SELECT slug, emotional_weight AS w
       FROM pages WHERE slug LIKE 'salience/batch-%'`
  );
  return new Map(rows.map(r => [String(r.slug), Number(r.w)]));
}

/** Seed pages, run the first write + backdate + the MIXED batch; capture everything. */
async function runD5Fixture(engine: BrainEngine): Promise<D5Snapshot> {
  for (const slug of D5_PAGES) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'body' });
  }
  // One active take on batch-changed so getSalienceScores exercises the
  // ln(1 + take_count) term, not just weight * 5.
  const page = await engine.getPage('salience/batch-changed', { sourceId: 'default' });
  expect(page).not.toBeNull();
  await engine.addTakesBatch([{
    page_id: page!.id, row_num: 0, claim: 'd5 parity take',
    kind: 'take', holder: 'tester', weight: 0.5,
  }]);

  // First write: all three targets exist and change (0.0 default → new value).
  const firstCount = await engine.setEmotionalWeightBatch([
    { slug: 'salience/batch-changed', source_id: 'default', weight: 0.5 },
    { slug: 'salience/batch-same', source_id: 'default', weight: 0.25 },
    { slug: 'salience/batch-same-2', source_id: 'default', weight: 0.75 },
  ]);

  // Backdate salience_touched_at on every fixture page (batch-fresh included)
  // so the mixed batch's bump-vs-keep is unambiguous (~1h gap, no clock races).
  await engine.executeRaw(
    `UPDATE pages SET salience_touched_at = now() - interval '1 hour'
      WHERE slug LIKE 'salience/batch-%'`
  );
  const before = await readTouchedEpochs(engine);

  // The MIXED batch: one changing row, two same-value rows, one row changing
  // from the column default, one missing slug, one wrong-source ref.
  const mixedCount = await engine.setEmotionalWeightBatch([
    { slug: 'salience/batch-changed', source_id: 'default', weight: 0.875 },
    { slug: 'salience/batch-same', source_id: 'default', weight: 0.25 },
    { slug: 'salience/batch-same-2', source_id: 'default', weight: 0.75 },
    { slug: 'salience/batch-fresh', source_id: 'default', weight: 0.125 },
    { slug: D5_MISSING_SLUG, source_id: 'default', weight: 0.5 },
    { slug: 'salience/batch-changed', source_id: 'no-such-source', weight: 0.99 },
  ]);
  const after = await readTouchedEpochs(engine);
  const weights = await readStoredWeights(engine);
  return { firstCount, mixedCount, before, after, weights };
}

describeBoth('D5 engine parity — setEmotionalWeightBatch + getSalienceScores', () => {
  let pglite: PGLiteEngine;
  let postgres: BrainEngine;
  let pgliteSnap: D5Snapshot;
  let postgresSnap: D5Snapshot;

  beforeAll(async () => {
    pglite = new PGLiteEngine();
    await pglite.connect({ engine: 'pglite' } as never);
    await pglite.initSchema();
    pgliteSnap = await runD5Fixture(pglite);

    postgres = await setupDB();
    postgresSnap = await runD5Fixture(postgres);
  }, 60_000);

  afterAll(async () => {
    if (pglite) await pglite.disconnect();
    await teardownDB();
  });

  test('mixed batch: identical matched-row counts on both engines', () => {
    // First write matched all 3 existing targets.
    expect(pgliteSnap.firstCount).toBe(3);
    expect(postgresSnap.firstCount).toBe(3);
    // Mixed batch: 4 matched pages (same-value writes still match + count);
    // the missing slug and the wrong-source ref match nothing.
    expect(pgliteSnap.mixedCount).toBe(4);
    expect(postgresSnap.mixedCount).toBe(4);
  });

  test('mixed batch: identical stored weights on both engines', () => {
    const expected = new Map([
      ['salience/batch-changed', 0.875],
      ['salience/batch-same', 0.25],
      ['salience/batch-same-2', 0.75],
      ['salience/batch-fresh', 0.125],
    ]);
    for (const snap of [pgliteSnap, postgresSnap]) {
      expect(snap.weights.size).toBe(expected.size);
      for (const [slug, w] of expected) {
        expect(snap.weights.get(slug)).toBe(w);
      }
    }
    // The wrong-source ref (weight 0.99) must not have fanned out onto the
    // default-source page: composite (slug, source_id) key held.
    expect(pgliteSnap.weights.get('salience/batch-changed')).toBe(0.875);
    expect(postgresSnap.weights.get('salience/batch-changed')).toBe(0.875);
  });

  test('salience_touched_at bumps ONLY for rows whose weight actually changed', () => {
    const changed = ['salience/batch-changed', 'salience/batch-fresh'];
    const unchanged = ['salience/batch-same', 'salience/batch-same-2'];
    for (const snap of [pgliteSnap, postgresSnap]) {
      for (const slug of D5_PAGES) {
        expect(Number.isFinite(snap.before.get(slug)!)).toBe(true);
        expect(Number.isFinite(snap.after.get(slug)!)).toBe(true);
      }
      for (const slug of changed) {
        // IS DISTINCT FROM branch fired: touched_at moved forward ~1h past
        // the backdated value (allow generous slack, assert > 30 min).
        expect(snap.after.get(slug)! - snap.before.get(slug)!).toBeGreaterThan(1800);
      }
      for (const slug of unchanged) {
        // Same-value write: old timestamp preserved exactly.
        expect(snap.after.get(slug)).toBe(snap.before.get(slug)!);
      }
    }
  });

  test('getSalienceScores: same source::slug → score mapping on both engines', async () => {
    const refs = [
      ...D5_PAGES.map(slug => ({ slug, source_id: 'default' })),
      { slug: D5_MISSING_SLUG, source_id: 'default' },
      { slug: 'salience/batch-changed', source_id: 'no-such-source' },
    ];
    const pgliteScores = await pglite.getSalienceScores(refs);
    const postgresScores = await postgres.getSalienceScores(refs);

    // Key shape is `${source_id}::${slug}`; unmatched refs are absent.
    const expectedKeys = D5_PAGES.map(slug => `default::${slug}`).sort();
    expect([...pgliteScores.keys()].sort()).toEqual(expectedKeys);
    expect([...postgresScores.keys()].sort()).toEqual(expectedKeys);
    expect(pgliteScores.has(`default::${D5_MISSING_SLUG}`)).toBe(false);
    expect(postgresScores.has('no-such-source::salience/batch-changed')).toBe(false);

    // Score = weight * 5 + ln(1 + active take count). batch-changed carries
    // the one active take; the rest have zero takes.
    const expectedScores = new Map([
      ['default::salience/batch-changed', 0.875 * 5 + Math.log(2)],
      ['default::salience/batch-same', 0.25 * 5],
      ['default::salience/batch-same-2', 0.75 * 5],
      ['default::salience/batch-fresh', 0.125 * 5],
    ]);
    for (const [key, expectedScore] of expectedScores) {
      const pgliteScore = pgliteScores.get(key)!;
      const postgresScore = postgresScores.get(key)!;
      expect(pgliteScore).toBeCloseTo(postgresScore, 6);
      expect(pgliteScore).toBeCloseTo(expectedScore, 5);
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
