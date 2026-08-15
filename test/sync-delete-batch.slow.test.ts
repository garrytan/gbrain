/**
 * v0.41.19.0 — sync delete batched perf gate
 *
 * `.slow.test.ts` keeps this OUT of the fast parallel loop (per CLAUDE.md
 * test taxonomy). Run via `bun run test:slow`. Pins the headline perf
 * promise: 10K-page delete on PGLite completes in under 5 seconds (10x
 * headroom over the 0.5s/1K-page target).
 *
 * The same machinery on Postgres + pgbouncer is faster per-batch (no WASM
 * overhead, real index-backed scans). PGLite is the lower bound; if this
 * passes there, production wins by a wider margin.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { DELETE_BATCH_SIZE } from '../src/core/engine-constants.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

test('10K-page batched delete completes in <5s on PGLite', async () => {
  const N = 10_000;

  // Seed N pages via bulk INSERT (single statement to keep setup fast).
  // putPage one-at-a-time would dominate the test runtime.
  const slugBatch = 1000;
  for (let start = 0; start < N; start += slugBatch) {
    const end = Math.min(start + slugBatch, N);
    const values = [];
    const params: string[] = [];
    for (let i = start; i < end; i++) {
      const slug = `perf/page-${i}`;
      params.push(slug);
      values.push(`('default', $${params.length}, 'note', $${params.length}, 'body', '', '{}'::jsonb)`);
    }
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter) VALUES ${values.join(',')}`,
      params,
    );
  }

  // Confirm seed.
  const countRows = await engine.executeRaw<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM pages WHERE slug LIKE 'perf/page-%'`,
  );
  expect(Number(countRows[0].c)).toBe(N);

  // Batched delete, mirroring the sync loop's chunking.
  const allSlugs = Array.from({ length: N }, (_, i) => `perf/page-${i}`);
  const start = Date.now();
  let totalDeleted = 0;
  for (let i = 0; i < allSlugs.length; i += DELETE_BATCH_SIZE) {
    const batch = allSlugs.slice(i, i + DELETE_BATCH_SIZE);
    const deleted = await engine.deletePages(batch, { sourceId: 'default' });
    totalDeleted += deleted.length;
  }
  const elapsed = Date.now() - start;

  expect(totalDeleted).toBe(N);
  // 10x headroom over 0.5s/1K → 5s for 10K. Generous for PGLite WASM.
  expect(elapsed).toBeLessThan(5000);

  // Optional: report wallclock so future regressions show up in CI logs.
  // (bun:test doesn't have a metrics surface; just stderr-log.)
  process.stderr.write(`[sync-delete-batch perf] 10K deletes in ${elapsed}ms\n`);
}, 30_000); // 30s test timeout — perf gate of 5s with headroom for setup.
