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
 *
 * The delete loop is timed in thread CPU time (PGLite runs on this thread),
 * which measures the work rather than how long the scheduler made it wait.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { DELETE_BATCH_SIZE } from '../src/core/engine-constants.ts';
import { cpuMsAsync } from './helpers/cpu-time.ts';

const N = 10_000;
let engine: PGLiteEngine;

const seed = (prefix: string, from: number, to: number) => engine.executeRaw(
  `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
   SELECT 'default', '${prefix}' || g, 'note', '${prefix}' || g, 'body', '', '{}'::jsonb
   FROM generate_series(${from}, ${to}) g`,
);

// Both fixtures are seeded once, here, so each test's 30 s budget covers only
// its delete loop. The first rows are ANALYZEd before the bulk insert: on an
// empty table bump_page_generation_fn's cached MAX(generation) plan is a seq
// scan, which makes a fresh-session 10K-row seed quadratic (~6 s of CPU
// instead of ~0.8 s).
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seed('perf/page-', 0, 99);
  await engine.executeRaw('ANALYZE pages');
  await seed('perf/page-', 100, N - 1);
  await seed('perf/soft-', 0, N - 1);
});

afterAll(async () => {
  await engine.disconnect();
});

test('10K-page batched delete completes in <5s on PGLite', async () => {
  // Confirm seed.
  const countRows = await engine.executeRaw<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM pages WHERE slug LIKE 'perf/page-%'`,
  );
  expect(Number(countRows[0].c)).toBe(N);

  // Batched delete, mirroring the sync loop's chunking.
  const allSlugs = Array.from({ length: N }, (_, i) => `perf/page-${i}`);
  let totalDeleted = 0;
  const elapsed = await cpuMsAsync(async () => {
    for (let i = 0; i < allSlugs.length; i += DELETE_BATCH_SIZE) {
      const batch = allSlugs.slice(i, i + DELETE_BATCH_SIZE);
      const deleted = await engine.deletePages(batch, { sourceId: 'default' });
      totalDeleted += deleted.length;
    }
  });

  expect(totalDeleted).toBe(N);
  // 10x headroom over 0.5s/1K → 5s for 10K. Generous for PGLite WASM.
  expect(elapsed).toBeLessThan(5000);

  // Optional: report wallclock so future regressions show up in CI logs.
  // (bun:test doesn't have a metrics surface; just stderr-log.)
  process.stderr.write(`[sync-delete-batch perf] 10K deletes in ${elapsed.toFixed(0)}ms of thread CPU\n`);
}, 30_000); // 30s test timeout — perf gate of 5s with headroom for setup.

test('#4587: 10K-page batched SOFT delete completes in <5s on PGLite', async () => {
  // Sync's delete lanes now run softDeletePages (UPDATE ... deleted_at),
  // so the loop's perf promise moves with them — same gate, same chunking.
  const allSlugs = Array.from({ length: N }, (_, i) => `perf/soft-${i}`);
  let totalFlipped = 0;
  const elapsed = await cpuMsAsync(async () => {
    for (let i = 0; i < allSlugs.length; i += DELETE_BATCH_SIZE) {
      const batch = allSlugs.slice(i, i + DELETE_BATCH_SIZE);
      const flipped = await engine.softDeletePages(batch, { sourceId: 'default' });
      totalFlipped += flipped.length;
    }
  });

  expect(totalFlipped).toBe(N);
  expect(elapsed).toBeLessThan(5000);

  // Idempotency at scale: a full re-run flips nothing (deleted_at IS NULL).
  let reFlipped = 0;
  for (let i = 0; i < allSlugs.length; i += DELETE_BATCH_SIZE) {
    reFlipped += (await engine.softDeletePages(allSlugs.slice(i, i + DELETE_BATCH_SIZE), { sourceId: 'default' })).length;
  }
  expect(reFlipped).toBe(0);

  process.stderr.write(`[sync-delete-batch perf] 10K soft-deletes in ${elapsed.toFixed(0)}ms of thread CPU\n`);
}, 30_000);
