/**
 * Engine integration test for normalizeWeightForStorage at all 4 takes
 * write sites (codex review #8).
 *
 * The helper is unit-tested in test/takes-weight-rounding.test.ts. This
 * file exercises the integration: do addTakesBatch and updateTake actually
 * call the helper in their write paths? Tests against PGLite for both
 * paths; the postgres-engine's path is exercised in the E2E suite.
 *
 * Without these tests, a refactor that accidentally bypasses the helper
 * (e.g., inlining logic that drops the NaN guard) would still pass the
 * pure-helper tests while regressing the actual write contract.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
let pageId: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('test/weight-integration', {
    type: 'note', title: 'integration', compiled_truth: 'b', frontmatter: {},
  });
  const rows = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = 'test/weight-integration' LIMIT 1`,
  );
  pageId = rows[0].id;
});

afterAll(async () => {
  await engine.disconnect();
});

async function readWeight(rowNum: number): Promise<number | null> {
  const rows = await engine.executeRaw<{ weight: number }>(
    `SELECT weight FROM takes WHERE page_id = $1 AND row_num = $2`,
    [pageId, rowNum],
  );
  return rows.length === 0 ? null : Number(rows[0].weight);
}

describe('addTakesBatch integration — weight normalization at the write path', () => {
  test('off-grid 0.74 input is stored as 0.75 (rounded by helper)', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 100, claim: 'a', kind: 'take', holder: 'world', weight: 0.74 },
    ]);
    expect(await readWeight(100)).toBeCloseTo(0.75, 5);
  });

  test('off-grid 0.82 input is stored as 0.80', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 101, claim: 'b', kind: 'take', holder: 'world', weight: 0.82 },
    ]);
    expect(await readWeight(101)).toBeCloseTo(0.80, 5);
  });

  test('on-grid weights round to themselves', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 102, claim: 'c', kind: 'take', holder: 'world', weight: 0.75 },
      { page_id: pageId, row_num: 103, claim: 'd', kind: 'take', holder: 'world', weight: 1.0 },
      { page_id: pageId, row_num: 104, claim: 'e', kind: 'take', holder: 'world', weight: 0.0 },
    ]);
    expect(await readWeight(102)).toBeCloseTo(0.75, 5);
    expect(await readWeight(103)).toBeCloseTo(1.0, 5);
    expect(await readWeight(104)).toBeCloseTo(0.0, 5);
  });

  test('NaN input goes to default 0.5 (codex review #8 — the hole the helper plugs)', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 105, claim: 'f', kind: 'take', holder: 'world', weight: NaN as number },
    ]);
    const w = await readWeight(105);
    expect(w).toBeCloseTo(0.5, 5);
    expect(Number.isFinite(w!)).toBe(true);
  });

  test('Infinity input goes to default 0.5 (not 1.0)', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 106, claim: 'g', kind: 'take', holder: 'world', weight: Infinity },
    ]);
    expect(await readWeight(106)).toBeCloseTo(0.5, 5);
  });

  test('out-of-range high (1.3) clamps to 1.0', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 107, claim: 'h', kind: 'take', holder: 'world', weight: 1.3 },
    ]);
    expect(await readWeight(107)).toBeCloseTo(1.0, 5);
  });

  test('out-of-range low (-0.1) clamps to 0.0', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 108, claim: 'i', kind: 'take', holder: 'world', weight: -0.1 },
    ]);
    expect(await readWeight(108)).toBeCloseTo(0.0, 5);
  });

  test('undefined weight defaults to 0.5', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 109, claim: 'j', kind: 'take', holder: 'world' } as any,
    ]);
    expect(await readWeight(109)).toBeCloseTo(0.5, 5);
  });

  test('batch with mixed valid + clamp + NaN preserves order and rounds each independently', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 110, claim: 'k', kind: 'take', holder: 'world', weight: 0.74 },
      { page_id: pageId, row_num: 111, claim: 'l', kind: 'take', holder: 'world', weight: NaN as any },
      { page_id: pageId, row_num: 112, claim: 'm', kind: 'take', holder: 'world', weight: 0.5 },
      { page_id: pageId, row_num: 113, claim: 'n', kind: 'take', holder: 'world', weight: 1.5 },
    ]);
    expect(await readWeight(110)).toBeCloseTo(0.75, 5);
    expect(await readWeight(111)).toBeCloseTo(0.5, 5);
    expect(await readWeight(112)).toBeCloseTo(0.5, 5);
    expect(await readWeight(113)).toBeCloseTo(1.0, 5);
  });
});

describe('updateTake integration — weight normalization at the write path (was unhardened pre-v0.32)', () => {
  test('updateTake rounds 0.74 to 0.75 (was: only clamped, did NOT round)', async () => {
    // Seed an on-grid value, then update with off-grid input.
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 200, claim: 'a', kind: 'take', holder: 'world', weight: 0.5 },
    ]);
    await engine.updateTake(pageId, 200, { weight: 0.74 });
    expect(await readWeight(200)).toBeCloseTo(0.75, 5);
  });

  test('updateTake handles NaN (codex review #8 — was missing entirely on this site)', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 201, claim: 'a', kind: 'take', holder: 'world', weight: 0.5 },
    ]);
    await engine.updateTake(pageId, 201, { weight: NaN as any });
    const w = await readWeight(201);
    expect(w).toBeCloseTo(0.5, 5);
    expect(Number.isFinite(w!)).toBe(true);
  });

  test('updateTake handles Infinity', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 202, claim: 'a', kind: 'take', holder: 'world', weight: 0.5 },
    ]);
    await engine.updateTake(pageId, 202, { weight: Infinity as any });
    expect(await readWeight(202)).toBeCloseTo(0.5, 5);
  });

  test('updateTake clamps and rounds in one call', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 203, claim: 'a', kind: 'take', holder: 'world', weight: 0.5 },
    ]);
    await engine.updateTake(pageId, 203, { weight: 1.74 });
    expect(await readWeight(203)).toBeCloseTo(1.0, 5);
  });

  test('updateTake with undefined weight does NOT touch the column (preserves prior value)', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 204, claim: 'a', kind: 'take', holder: 'world', weight: 0.85 },
    ]);
    // updateTake's COALESCE($3::real, weight) keeps prior weight when input is undefined.
    await engine.updateTake(pageId, 204, { source: 'updated note' });
    expect(await readWeight(204)).toBeCloseTo(0.85, 5);
  });

  test('updateTake with -0.5 clamps to 0.0', async () => {
    await engine.addTakesBatch([
      { page_id: pageId, row_num: 205, claim: 'a', kind: 'take', holder: 'world', weight: 0.5 },
    ]);
    await engine.updateTake(pageId, 205, { weight: -0.5 });
    expect(await readWeight(205)).toBeCloseTo(0.0, 5);
  });
});
