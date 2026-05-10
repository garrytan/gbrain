/**
 * Migration v46 (takes_weight_round_to_grid) — behavioral test on PGLite.
 *
 * Cross-modal eval over 100K production takes (v0.31) flagged 0.74, 0.82-style
 * weights as false precision. PR #795 added engine-layer rounding to the 0.05
 * grid on insert. This migration backfills pre-v0.32 rows to the same grid.
 *
 * Codex review #2 corrected the original plan's "SIGTERM mid-update resume"
 * test — that would prove the wrong thing. A single SQL UPDATE either
 * completes or rolls back; transaction:false buys non-blocking-the-runner,
 * not mid-statement resume. The right test is **re-run idempotency**: after
 * the first complete pass, every row is on-grid, so a second invocation is
 * a zero-row UPDATE.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

// Helper: directly INSERT raw weights via SQL (bypassing the engine's
// addTakesBatch normalization) to seed pre-v0.32 off-grid state.
async function seedRawTake(slug: string, rowNum: number, weight: number) {
  // Ensure a page exists for the FK.
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: 'seed body for v46 migration test',
    frontmatter: {},
  });
  const pageRows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 LIMIT 1`,
    [slug],
  );
  const pageId = pageRows[0]?.id;
  if (!pageId) throw new Error(`page not found for ${slug}`);
  await engine.executeRaw(
    `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active)
     VALUES ($1, $2, $3, 'take', 'world', $4::real, true)
     ON CONFLICT (page_id, row_num) DO UPDATE SET weight = EXCLUDED.weight`,
    [pageId, rowNum, `seeded weight ${weight}`, weight],
  );
}

async function readWeights(slug: string): Promise<number[]> {
  const rows = await engine.executeRaw<{ weight: number; row_num: number }>(
    `SELECT t.weight, t.row_num FROM takes t
     JOIN pages p ON p.id = t.page_id
     WHERE p.slug = $1
     ORDER BY t.row_num`,
    [slug],
  );
  return rows.map(r => Number(r.weight));
}

async function runV46(slugFilter?: string): Promise<number> {
  const v46 = MIGRATIONS.find(m => m.version === 46);
  if (!v46) throw new Error('v46 migration not found');
  // Tolerance-matched count of rows the migration WOULD touch — same
  // predicate as the migration's WHERE clause. Optionally scoped to a slug
  // so independent test fixtures don't leak counts into each other.
  const filter = slugFilter
    ? `AND p.slug = '${slugFilter.replace(/'/g, "''")}'`
    : '';
  const before = await engine.executeRaw<{ off_grid: number }>(
    `SELECT count(*)::int AS off_grid
       FROM takes t JOIN pages p ON p.id = t.page_id
      WHERE t.weight IS NOT NULL
        AND abs(t.weight::numeric - ROUND(t.weight::numeric * 20) / 20) > 0.001
        ${filter}`,
  );
  await engine.executeRaw(v46.sql);
  return before[0]?.off_grid ?? 0;
}

describe('v46 takes weight backfill (behavioral)', () => {
  test('rounds 0.74 → 0.75, 0.82 → 0.80, leaves 0.5 / 1.0 / 0.0 / 0.025 → 0.05', async () => {
    const slug = 'wiki/takes-v46-rounding';
    await seedRawTake(slug, 1, 0.74);
    await seedRawTake(slug, 2, 0.82);
    await seedRawTake(slug, 3, 0.5);
    await seedRawTake(slug, 4, 1.0);
    await seedRawTake(slug, 5, 0.0);
    await seedRawTake(slug, 6, 0.025);

    const updated = await runV46(slug);
    expect(updated).toBeGreaterThanOrEqual(3); // 0.74, 0.82, 0.025 are off-grid

    const weights = await readWeights(slug);
    expect(weights[0]).toBeCloseTo(0.75, 5);
    expect(weights[1]).toBeCloseTo(0.80, 5);
    expect(weights[2]).toBeCloseTo(0.50, 5);
    expect(weights[3]).toBeCloseTo(1.0, 5);
    expect(weights[4]).toBeCloseTo(0.0, 5);
    expect(weights[5]).toBeCloseTo(0.05, 5);
  });

  test('Codex #2: re-run idempotency — second invocation is a zero-row UPDATE', async () => {
    const slug = 'wiki/takes-v46-idempotency';
    await seedRawTake(slug, 1, 0.74);
    await seedRawTake(slug, 2, 0.82);

    const firstUpdated = await runV46(slug);
    expect(firstUpdated).toBe(2); // exactly 2 off-grid rows for THIS slug

    // Second invocation: every row is now on-grid (within tolerance);
    // the WHERE clause filters them all out for THIS slug.
    const secondUpdated = await runV46(slug);
    expect(secondUpdated).toBe(0);

    // Weights remain stable.
    const weights = await readWeights(slug);
    expect(weights[0]).toBeCloseTo(0.75, 5);
    expect(weights[1]).toBeCloseTo(0.80, 5);
  });

  test('preserves on-grid weights exactly — 0.05 boundaries are NOT touched', async () => {
    const slug = 'wiki/takes-v46-on-grid';
    const onGrid = [0.0, 0.05, 0.10, 0.25, 0.50, 0.75, 0.85, 0.95, 1.0];
    for (let i = 0; i < onGrid.length; i++) {
      await seedRawTake(slug, i + 1, onGrid[i]);
    }

    const updated = await runV46(slug);
    // No off-grid rows for THIS slug; updated count for this fixture is 0
    // (other test slugs may have already been migrated by prior tests
    // running in the same describe block, so check this slug specifically).
    expect(updated).toBe(0);

    const weights = await readWeights(slug);
    for (let i = 0; i < onGrid.length; i++) {
      expect(weights[i]).toBeCloseTo(onGrid[i], 5);
    }
  });
});
