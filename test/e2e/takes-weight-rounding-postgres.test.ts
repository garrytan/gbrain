/**
 * v0.32 EXP-1 + Hardening: weight normalization on real Postgres.
 *
 * The PGLite integration test (test/engine-weight-rounding-integration.test.ts)
 * proves the helper is wired at the addTakesBatch + updateTake sites for the
 * embedded engine. This file proves the same wiring works through postgres.js
 * + the unnest() bind path on real Postgres.
 *
 * Postgres-specific reasons this is its own test:
 *   - postgres.js's array param marshaling for REAL[] differs from PGLite
 *   - The unnest() multi-row path can drop bind shapes silently
 *   - Real Postgres REAL has 32-bit float semantics (matches the migration's
 *     tolerance comparison tested in test/migrations-v48 — this is the runtime
 *     write path)
 *
 * Skips gracefully when DATABASE_URL is unset.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { setupDB, teardownDB, hasDatabase, getEngine } from './helpers.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

let pageId: number;

beforeAll(async () => {
  if (!RUN) return;
  const engine = await setupDB();
  // Best-effort cleanup of any prior fixture row.
  await engine.executeRaw(`DELETE FROM pages WHERE slug = 'test/weight-rounding-postgres'`);
  const page = await engine.putPage('test/weight-rounding-postgres', {
    type: 'note', title: 'pg-weight-rounding', compiled_truth: 'b', frontmatter: {},
  });
  pageId = page.id;
});

afterAll(async () => {
  if (!RUN) return;
  const engine = getEngine();
  await engine.executeRaw(`DELETE FROM pages WHERE slug = 'test/weight-rounding-postgres'`);
  await teardownDB();
});

async function readWeight(rowNum: number): Promise<number | null> {
  const engine = getEngine();
  const rows = await engine.executeRaw<{ weight: number }>(
    `SELECT weight FROM takes WHERE page_id = $1 AND row_num = $2`,
    [pageId, rowNum],
  );
  return rows.length === 0 ? null : Number(rows[0].weight);
}

d('postgres-engine — weight rounding through addTakesBatch + updateTake (v0.32 EXP-1)', () => {
  test('addTakesBatch rounds 0.74 → 0.75 via the unnest() bind path', async () => {
    const engine = getEngine();
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 1, claim: 'a', kind: 'take', holder: 'world', weight: 0.74 },
    ]);
    expect(await readWeight(1)).toBeCloseTo(0.75, 4);
  });

  test('addTakesBatch handles NaN at the postgres.js array bind layer (codex review #8)', async () => {
    const engine = getEngine();
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 2, claim: 'b', kind: 'take', holder: 'world', weight: NaN as any },
    ]);
    const w = await readWeight(2);
    expect(w).toBeCloseTo(0.5, 4);
    expect(Number.isFinite(w!)).toBe(true);
  });

  test('addTakesBatch with mixed batch (10 rows, 4 off-grid) rounds each independently', async () => {
    const engine = getEngine();
    const inputs = [
      { weight: 0.74, expected: 0.75 },
      { weight: 0.5, expected: 0.5 },
      { weight: 0.82, expected: 0.80 },
      { weight: 1.0, expected: 1.0 },
      { weight: 0.025, expected: 0.05 },
      { weight: 0.0, expected: 0.0 },
      { weight: 1.5, expected: 1.0 },
      { weight: -0.1, expected: 0.0 },
      { weight: 0.95, expected: 0.95 },
      { weight: 0.85, expected: 0.85 },
    ];
    await engine.addTakesBatch(inputs.map((inp, i) => ({
      page_id: pageId,
      row_num: 100 + i,
      claim: `mix-${i}`,
      kind: 'take' as const,
      holder: 'world',
      weight: inp.weight,
    })));
    for (let i = 0; i < inputs.length; i++) {
      expect(await readWeight(100 + i)).toBeCloseTo(inputs[i].expected, 4);
    }
  });

  test('updateTake rounds 0.82 → 0.80 on real Postgres (was unhardened pre-v0.32)', async () => {
    const engine = getEngine();
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 200, claim: 'a', kind: 'take', holder: 'world', weight: 0.5 },
    ]);
    await engine.updateTake(pageId, 200, { weight: 0.82 });
    expect(await readWeight(200)).toBeCloseTo(0.80, 4);
  });

  test('updateTake handles NaN on real Postgres', async () => {
    const engine = getEngine();
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 201, claim: 'a', kind: 'take', holder: 'world', weight: 0.5 },
    ]);
    await engine.updateTake(pageId, 201, { weight: NaN as any });
    const w = await readWeight(201);
    expect(w).toBeCloseTo(0.5, 4);
    expect(Number.isFinite(w!)).toBe(true);
  });

  test('migration v48 tolerance matches engine-write tolerance — round-trip stays on grid', async () => {
    const engine = getEngine();
    // Insert via the engine path (helper rounds to 0.05 grid).
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 300, claim: 'roundtrip', kind: 'take', holder: 'world', weight: 0.74 },
    ]);

    // Run the v48 migration's WHERE clause manually — it should match ZERO rows
    // for THIS engine-rounded value, proving the engine + migration agree.
    const rows = await engine.executeRaw<{ off_grid: number | string }>(
      `SELECT count(*)::int AS off_grid FROM takes
         WHERE page_id = $1 AND row_num = $2
           AND weight IS NOT NULL
           AND abs(weight::numeric - ROUND(weight::numeric * 20) / 20) > 0.001`,
      [pageId, 300],
    );
    expect(Number(rows[0].off_grid)).toBe(0);
  });
});
