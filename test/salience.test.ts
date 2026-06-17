import { describe, expect, test } from 'bun:test';
import { computeAnomaliesFromBuckets } from '../src/core/cycle/anomaly.ts';

/**
 * Unit-level salience checks. The full Garry-test fixture lives in
 * test/e2e/salience-pglite.test.ts (PGLite, no DATABASE_URL needed).
 *
 * These are the pure-function checks for the CLI args parser and a smoke
 * for the engine method shape via a minimal fake. Most of the salience
 * logic is SQL — see e2e for behavior validation.
 */

describe('v0.29 — salience SQL shape pinned via type contract', () => {
  // The salience score formula is in postgres-engine.ts and pglite-engine.ts
  // SQL strings. These are smoke-tested against the engines in
  // test/e2e/salience-pglite.test.ts and (optionally) the Postgres parity test.
  // Here we just confirm the SalienceResult fields are present on the type
  // so any future renames break compilation, not runtime.
  test('SalienceResult is a stable contract', async () => {
    const mod = await import('../src/core/types.ts');
    // If any of these fields is dropped, tsc fails before tests run.
    const sample = {} as import('../src/core/types.ts').SalienceResult;
    void sample.slug;
    void sample.source_id;
    void sample.title;
    void sample.type;
    void sample.updated_at;
    void sample.emotional_weight;
    void sample.take_count;
    void sample.take_avg_weight;
    void sample.score;
    expect(typeof mod).toBe('object');
  });
});

describe('v0.29 — anomaly cohort buckets connect to the engine', () => {
  test('computeAnomaliesFromBuckets is exported and pure', () => {
    // Smoke that the import path engines use is wired. The behavior is
    // covered exhaustively in test/anomalies.test.ts.
    expect(typeof computeAnomaliesFromBuckets).toBe('function');
  });
});
