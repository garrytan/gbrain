/**
 * Warm-create speed gate for the LongMemEval engine path.
 *
 * Extracted from eval-longmemeval.test.ts into the slow tier to prevent
 * intermittent failures caused by PGLite I/O contention in the parallel
 * test suite. See: remediation A+E.
 *
 * Tier: *.slow.test.ts — runs sequentially via scripts/run-slow-tests.sh,
 * excluded from scripts/run-unit-parallel.sh (via run-unit-shard.sh).
 *
 * Gate: p75 < 500ms across n=20 isolated trials.
 * Rationale: in the slow tier we have headroom (60s/test, sequential
 * execution); p75 of 20 trials catches a genuine 2x regression reliably
 * without tripping on the noisier left tail.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createBenchmarkBrain, resetTables } from '../src/eval/longmemeval/harness.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';

// ---------------------------------------------------------------------------
// Isolated engine for the speed gate (independent of eval-longmemeval.test.ts)
// ---------------------------------------------------------------------------

let speedEngine: PGLiteEngine;

beforeAll(async () => {
  speedEngine = await createBenchmarkBrain();
});

afterAll(async () => {
  if (speedEngine) await speedEngine.disconnect();
});

// ---------------------------------------------------------------------------
// speed (warm) — p75 + p99 across 20 trials
// ---------------------------------------------------------------------------

describe('warm-create speed gate', () => {
  test('p75 < 500ms, p99 reported (warn-only at 1500ms)', async () => {
    const trials = 20;
    const samples: number[] = [];
    for (let i = 0; i < trials; i++) {
      const t0 = performance.now();
      await resetTables(speedEngine);
      for (let j = 0; j < 5; j++) {
        const slug = `chat/speed-${i}-${j}`;
        const content = `---\ntype: note\n---\n\n**user:** speed sample ${i}-${j} keyword apple\n`;
        await importFromContent(speedEngine, slug, content, { noEmbed: true });
      }
      await speedEngine.searchKeyword('apple', { limit: 5 });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    // p75 index for n=20: samples[Math.floor(20 * 0.75)] = samples[15]
    const p75 = samples[Math.floor(samples.length * 0.75)];
    const p99 = samples[Math.floor(samples.length * 0.99)];
    process.stderr.write(
      `[speed] warm reset+import+search p75=${p75.toFixed(1)}ms p99=${p99.toFixed(1)}ms (n=${trials})\n`,
    );
    expect(p75).toBeLessThan(500);
    if (p99 > 1500) {
      process.stderr.write(`[speed] WARN: p99 above 1500ms threshold (informational)\n`);
    }
  }, 60_000);
});
