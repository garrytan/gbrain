/**
 * countOffGridTakeWeights on PGLite, with weights the typed API cannot store.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the count of takes more than 0.001 off the 0.05 weight grid is the SQL's `ROUND(weight::numeric * 20) / 20`
 *    rule on the `real` column, including the exact-0.001 boundary and a take on a soft-deleted page.
 *  - Regression: an engine that counted by float arithmetic, or by a page join, shows `gbrain doctor` a different
 *    takes_weight_grid verdict than the SQL gives.
 *  - Why existing coverage misses it: addTakesBatch and updateTake round every weight to the grid, so the engine-parity
 *    case can only store on-grid weights; test/doctor.test.ts checks the verdict, not the boundary values. The Rust
 *    store runs this same fixture (rust/crates/gbrain-store/tests/takes_reads.rs), so the two stay equal.
 *  - Seam: raw INSERT of the off-grid weights, the only way to make one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('countOffGridTakeWeights', () => {
  test('counts weights further than 0.001 from the 0.05 grid, on any page', async () => {
    expect(await engine.countOffGridTakeWeights()).toEqual({ off_grid: 0, total: 0 });
    const a = await engine.putPage('grid/a', { type: 'note', title: 'a', compiled_truth: 'x', frontmatter: {} });
    const gone = await engine.putPage('grid/gone', { type: 'note', title: 'gone', compiled_truth: 'x', frontmatter: {} });
    // 0.051 and 0.999 sit exactly 0.001 off the grid (not counted); 0.0501 is inside it; 0.052 and 0.9989 are just
    // outside; 0.075 rounds half up to 0.1; 0.1234567 prints as 0.123457.
    const weights = [0.05, 0.051, 0.0501, 0.052, 0.1234567, 1.0, 0.5, 0.075, 0.999, 0.9989, 0.0];
    for (const [i, w] of weights.entries()) {
      await engine.executeRaw(
        `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active) VALUES ($1, $2, 'c', 'take', 'world', $3::real, true)`,
        [a.id, i + 1, w],
      );
    }
    expect(await engine.countOffGridTakeWeights()).toEqual({ off_grid: 4, total: 11 });
    await engine.executeRaw(
      `INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active) VALUES ($1, 1, 'c', 'take', 'world', 0.052::real, true)`,
      [gone.id],
    );
    await engine.softDeletePage('grid/gone');
    expect(await engine.countOffGridTakeWeights()).toEqual({ off_grid: 5, total: 12 });
  });
});
