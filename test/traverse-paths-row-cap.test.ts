/**
 * traversePaths row cap (ship-review fix, cross-model pass).
 *
 * The edge walk is a path-enumerating recursive CTE; its `both` branch fans
 * out combinatorially on an entity hub and the in-memory dedup only ran
 * AFTER the DB had materialized every row. Both engines now bound the final
 * SELECT at TRAVERSE_PATH_ROW_CAP (+1 probe row) and report the overflow via
 * `traversePathsDetailed().truncated`; `traversePaths` stays the `.paths`
 * projection so every existing caller keeps its GraphPath[] shape, and the
 * traverse_graph op surfaces the hit as a stderr note (wire shape additive).
 *
 * PGLite half here; the Postgres twin + cross-engine agreement live in
 * test/e2e/engine-parity.test.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { TRAVERSE_PATH_ROW_CAP } from '../src/core/engine-constants.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { DENSE_HUB_SLUG, DENSE_HUB_SPOKES, seedDenseHub } from './helpers/dense-hub.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedDenseHub(engine);
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

function ctx(warn: (msg: string) => void): OperationContext {
  return {
    engine,
    remote: false,
    config: {},
    logger: { info() {}, warn, error() {}, debug() {} },
    dryRun: false,
    sourceId: 'default',
  } as unknown as OperationContext;
}

describe('traversePaths row cap (PGLite)', () => {
  test('a depth-3 bidirectional walk from a dense hub is bounded and flagged truncated', async () => {
    const started = Date.now();
    const walk = await engine.traversePathsDetailed(DENSE_HUB_SLUG, { depth: 3, direction: 'both' });
    const elapsed = Date.now() - started;
    expect(walk.truncated).toBe(true);
    expect(walk.paths.length).toBeGreaterThan(0);
    expect(walk.paths.length).toBeLessThanOrEqual(TRAVERSE_PATH_ROW_CAP);
    // Truncation drops the DEEPEST rows (ORDER BY depth): the hub's own 400
    // edges at depth 1 all survive.
    expect(walk.paths.filter(p => p.depth === 1).length).toBe(DENSE_HUB_SPOKES);
    expect(Math.max(...walk.paths.map(p => p.depth))).toBeLessThanOrEqual(3);
    // Bounded materialization keeps the call prompt even on the WASM engine.
    expect(elapsed).toBeLessThan(60_000);
  }, 90_000);

  test('traversePaths (the GraphPath[] projection) honours the same cap', async () => {
    const paths = await engine.traversePaths(DENSE_HUB_SLUG, { depth: 3, direction: 'both' });
    // Pre-cap: 5,200 deduped edges (every edge at depth 2 AND depth 3).
    expect(paths.length).toBeLessThanOrEqual(TRAVERSE_PATH_ROW_CAP);
    const detailed = await engine.traversePathsDetailed(DENSE_HUB_SLUG, { depth: 3, direction: 'both' });
    expect(paths).toEqual(detailed.paths);
  }, 90_000);

  test('a walk under the cap is not flagged', async () => {
    const walk = await engine.traversePathsDetailed(DENSE_HUB_SLUG, { depth: 1, direction: 'out' });
    expect(walk.truncated).toBe(false);
    expect(walk.paths.length).toBe(DENSE_HUB_SPOKES / 2);
    expect(await engine.traversePaths(DENSE_HUB_SLUG, { depth: 1, direction: 'out' })).toEqual(walk.paths);
  });

  test('traverse_graph op: truncation is a stderr note, the GraphPath[] wire shape is unchanged', async () => {
    const warnings: string[] = [];
    const result = await operationsByName.traverse_graph.handler(ctx(m => warnings.push(m)), {
      slug: DENSE_HUB_SLUG, depth: 3, direction: 'both',
    }) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(TRAVERSE_PATH_ROW_CAP);
    expect(warnings.some(w => w.includes('truncated') && w.includes(String(TRAVERSE_PATH_ROW_CAP)))).toBe(true);

    const quiet: string[] = [];
    await operationsByName.traverse_graph.handler(ctx(m => quiet.push(m)), {
      slug: DENSE_HUB_SLUG, depth: 1, direction: 'out',
    });
    expect(quiet.filter(w => w.includes('truncated'))).toEqual([]);
  }, 90_000);
});
