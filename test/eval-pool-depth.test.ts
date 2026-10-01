/**
 * Eval-only candidate pool depth (src/core/search/eval-pool-depth.ts, the
 * System One recall experiment's `--eval-pool-depth N`).
 *
 * Protects: without the flag the per-arm cap stays MAX_SEARCH_LIMIT (100) and
 * the per-arm pool is today's max(2*limit, floor, offset+limit) — production
 * depth unchanged; with a depth set, every arm fetches N and the engine arm
 * returns more than 100 rows; the depth is range-checked and clears to null.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { MAX_SEARCH_LIMIT } from '../src/core/engine.ts';
import { PRE_FUSION_POOL_FLOOR } from '../src/core/search/hybrid.ts';
import { EVAL_POOL_DEPTH_MAX, evalPoolDepth, perArmPoolLimit, searchLimitCap, setEvalPoolDepth } from '../src/core/search/eval-pool-depth.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

let engine: PGLiteEngine;
const PAGES = 150;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 0; i < PAGES; i++) {
    const slug = `notes/pool-${i}`;
    const text = `deep pool keyword row ${i}`;
    await engine.putPage(slug, { type: 'note', title: `pool ${i}`, compiled_truth: text });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' }]);
  }
}, 120_000);

afterAll(async () => { await engine.disconnect(); });
afterEach(() => setEvalPoolDepth(null));

describe('eval pool depth', () => {
  test('default: cap 100 and the production per-arm pool', () => {
    expect(evalPoolDepth()).toBeNull();
    expect(searchLimitCap()).toBe(MAX_SEARCH_LIMIT);
    expect(MAX_SEARCH_LIMIT).toBe(100);
    expect(perArmPoolLimit(8, 0, PRE_FUSION_POOL_FLOOR)).toBe(50);
    expect(perArmPoolLimit(40, 0, PRE_FUSION_POOL_FLOOR)).toBe(80);
    expect(perArmPoolLimit(90, 0, PRE_FUSION_POOL_FLOOR)).toBe(100);
    expect(perArmPoolLimit(50, 200, PRE_FUSION_POOL_FLOOR)).toBe(100);
  });

  test('a depth lifts the cap to N and every arm fetches N', () => {
    setEvalPoolDepth(300);
    expect(searchLimitCap()).toBe(300);
    expect(perArmPoolLimit(8, 0, PRE_FUSION_POOL_FLOOR)).toBe(300);
    setEvalPoolDepth(30);
    expect(searchLimitCap()).toBe(100);
    expect(perArmPoolLimit(8, 0, PRE_FUSION_POOL_FLOOR)).toBe(50);
  });

  test('range-checked', () => {
    expect(() => setEvalPoolDepth(0)).toThrow();
    expect(() => setEvalPoolDepth(EVAL_POOL_DEPTH_MAX + 1)).toThrow();
    expect(() => setEvalPoolDepth(1.5)).toThrow();
  });

  test('the keyword arm returns at most 100 rows without a depth, and the full pool with one', async () => {
    expect((await engine.searchKeyword('deep pool keyword', { limit: 300 })).length).toBe(MAX_SEARCH_LIMIT);
    setEvalPoolDepth(300);
    expect((await engine.searchKeyword('deep pool keyword', { limit: 300 })).length).toBe(PAGES);
  }, 60_000);
});
