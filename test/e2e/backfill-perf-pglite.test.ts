/**
 * v0.29 — backfill perf regression guard (codex C4#3+#4).
 *
 * The first plan revision did per-page reads + per-page writes (N+1) which
 * would multi-minute on real brains. The shipped path is two SQL round-trips
 * total (CTE-shaped batch read + UPDATE FROM unnest batch write).
 *
 * This test seeds 1000 pages with random tags + 0-3 takes each, runs the
 * recompute_emotional_weight phase against PGLite in-memory, and asserts
 * wall-clock < 5s on the same fixture pattern. Goal is to catch a regression
 * to N+1 — a fast machine on PGLite in-memory should finish in well under
 * a second; the 5s budget is generous for slow CI.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseRecomputeEmotionalWeight } from '../../src/core/cycle/recompute-emotional-weight.ts';

let engine: PGLiteEngine;

const TAG_POOL = [
  'wedding', 'family', 'work', 'product', 'hardware',
  'meeting', 'idea', 'concept', 'people', 'health',
];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();

  // Seed 1000 pages, each with 1-3 tags from the pool.
  for (let i = 0; i < 1000; i++) {
    const slug = `notes/perf-${i}`;
    await engine.putPage(slug, {
      type: 'note',
      title: `Page ${i}`,
      compiled_truth: 'body',
    });
    const tagCount = 1 + (i % 3);
    for (let t = 0; t < tagCount; t++) {
      await engine.addTag(slug, TAG_POOL[(i + t) % TAG_POOL.length]);
    }
  }
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('v0.29 — recompute_emotional_weight perf on a 1000-page fixture', () => {
  test('full-mode backfill completes in under 5 seconds', async () => {
    const start = Date.now();
    const result = await runPhaseRecomputeEmotionalWeight(engine, {});
    const elapsedMs = Date.now() - start;

    expect(result.status).toBe('ok');
    expect(result.pages_recomputed).toBeGreaterThanOrEqual(1000);
    expect(elapsedMs).toBeLessThan(5_000);
  }, 30_000);
});
