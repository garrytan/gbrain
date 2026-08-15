/**
 * #1470 — runCycle swallowed lock.release() errors with empty catches. When
 * the release SQL throws (e.g. CONNECTION_ENDED after the pool was ended out
 * from under the cycle), the row in gbrain_cycle_locks persists with zero
 * operator-visible signal; the next `gbrain dream` within the TTL then skips
 * with a phantom `cycle_already_running`.
 *
 * Behavioral pin: a cycle whose DB-lock release throws still completes
 * (release stays best-effort) but emits a one-line stderr diagnostic naming
 * the failure, instead of silence.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';

let engine: PGLiteEngine;
let tmpHome: string;
let prevHome: string | undefined;

beforeAll(async () => {
  // Point the file-lock path (gbrainPath('cycle.lock')) at a throwaway dir so
  // the test never touches the operator's real ~/.gbrain.
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-cycle-diag-'));
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmpHome;

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
});

describe('runCycle lock-release failure diagnostic (#1470)', () => {
  test('a throwing DB-lock release is logged, not silently swallowed', async () => {
    // Simulate the pool being ended under the cycle: the release DELETE on
    // gbrain_cycle_locks throws; everything else passes through untouched.
    const db = (engine as unknown as { db: { query: (...a: unknown[]) => Promise<unknown> } }).db;
    const realQuery = db.query.bind(db);
    db.query = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && (args[0] as string).includes('DELETE FROM gbrain_cycle_locks')) {
        return Promise.reject(new Error('CONNECTION_ENDED (simulated)'));
      }
      return realQuery(...args);
    };

    const errLines: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => { errLines.push(args.map(String).join(' ')); };

    let report: Awaited<ReturnType<typeof runCycle>>;
    try {
      // 'lint' needs the cycle lock; brainDir null skips the phase body fast.
      report = await runCycle(engine, { phases: ['lint'], brainDir: null });
    } finally {
      console.error = origError;
      db.query = realQuery;
    }

    // Release stays best-effort — the cycle itself still completes...
    expect(report.status).not.toBe('failed');
    // ...but the swallowed release error now leaves a diagnostic naming the
    // failure and the stranded-lock consequence.
    const diagnostic = errLines.find(l => l.includes('release') && l.includes('CONNECTION_ENDED (simulated)'));
    expect(diagnostic).toBeDefined();

    // The stranded row really is there (release never ran) — the situation
    // the diagnostic points the operator at.
    const rows = await engine.executeRaw<{ id: string }>(`SELECT id FROM gbrain_cycle_locks`);
    expect(rows.length).toBeGreaterThan(0);
  }, 60_000);
});
