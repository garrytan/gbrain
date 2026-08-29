/**
 * #4143 regression pin — the read_latency_under_sync 600s hang.
 *
 * Mechanism (reproduced, bisected to the v0.45.13.0 truthful-surface wave):
 * `TelemetryWriter.record()` fires a fire-and-forget flush when pendingCount
 * hits FLUSH_THRESHOLD_CALLS. Post-#4096 that flush issues TWO sequential
 * INSERTs (normal bucket + the empty_result cause bucket), so when a workload
 * runs an EXACT MULTIPLE of the threshold and then disconnects, the second
 * INSERT is still in flight when `PGLiteEngine.disconnect()` calls
 * `db.close()` — and PGLite's close() deadlocks PERMANENTLY with a statement
 * in flight (both promises never settle). Writers/sync were irrelevant.
 *
 * Post-fix, disconnect() drains the registered search-telemetry sink (order 5)
 * after the early-null and before close, so the in-flight flush settles and
 * close is clean; the bounded close is the backstop.
 *
 * This test drives the REAL pipeline: in-memory PGLite, real hybridSearch
 * (keyword-only — no gateway configured, mirroring the heavy workload), the
 * imported threshold (never a hard-coded 100), then the workload's exact
 * epilogue: one foreground query, then disconnect, raced against a timer.
 *
 * Serial: real PGLite engine + module-singleton telemetry writer.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import {
  FLUSH_THRESHOLD_CALLS,
  getTelemetryWriter,
  _resetTelemetryWriterForTest,
} from '../src/core/search/telemetry.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  _resetTelemetryWriterForTest();
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' }); // in-memory, like the heavy workload
  await engine.initSchema();
  for (let i = 0; i < 5; i++) {
    await engine.executeRaw(
      `INSERT INTO pages (slug, type, title, compiled_truth, content_hash) VALUES ($1, 'note', $2, $3, $4)
       ON CONFLICT (source_id, slug) DO NOTHING`,
      [`fixture-${i}`, `Fixture ${i}`, `fixture telemetry page number ${i}`, `hash-4143-${i}`],
    );
  }
});

afterAll(async () => {
  _resetTelemetryWriterForTest();
  // Engine already disconnected by the test body; double-disconnect is a
  // pinned no-op, so this is safe either way.
  await engine.disconnect();
});

describe('telemetry flush vs disconnect (#4143, serial)', () => {
  test('an exact-threshold search count followed by disconnect settles instead of deadlocking', async () => {
    // Run EXACTLY the flush threshold so the last record() fires the
    // fire-and-forget flush — the trigger alignment from the bisect
    // (199 passed, 200 hung, 201 passed).
    for (let i = 0; i < FLUSH_THRESHOLD_CALLS; i++) {
      await hybridSearch(engine, i % 2 === 0 ? 'fixture telemetry' : 'zzz-no-match-query', { limit: 3 });
    }
    // Telemetry buffered and the threshold flush is now in flight (or has
    // just landed) — mirror the workload's epilogue exactly.
    const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages');
    expect(rows[0].n).toBeGreaterThanOrEqual(5);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const winner = await Promise.race([
      engine.disconnect().then(() => 'disconnected' as const),
      new Promise<'hung'>((r) => { timer = setTimeout(() => r('hung'), 15_000); }),
    ]);
    if (timer) clearTimeout(timer);
    expect(winner).toBe('disconnected'); // pre-fix: 'hung' (600s CI kill)
    // The writer must not be left holding an in-flight flush.
    expect(getTelemetryWriter().pendingFlush()).toBeNull();
  }, 60_000);
});
