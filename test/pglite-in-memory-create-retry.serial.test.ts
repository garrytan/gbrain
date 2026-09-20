/**
 * An in-memory PGLite create that aborts in the WASM runtime is retried once.
 *
 * Observed in CI (sim1-world/gbrain nightly, 2026-09-20): a serial test file
 * died in `beforeAll` with
 *   `access to a null reference (evaluating 'getWasmTableEntry(e)(t, r, a)')`
 * from `PGlite.create()` on a FRESH in-memory engine — no data dir, nothing
 * corrupt, nothing to repair. That shape classifies as 'unknown' (not
 * 'wasm-abort': it has no "Aborted()"/RuntimeError/"wasm runtime" text), so
 * it never reached any recovery path, and one transient trap out of ~200
 * serial files reds the whole lane.
 *
 * Pins: in-memory create failures retry ONCE cold and connect succeeds; the
 * retry drops the snapshot so `initSchema()` replays the schema instead of
 * trusting a restore that never happened; a second failure still surfaces the
 * actionable init error; the persistent path is untouched by the retry.
 *
 * .serial: mock.module patches '@electric-sql/pglite' process-wide, and real
 * PGLite cold starts (docs/TESTING.md R1).
 */

import { describe, test, expect, mock } from 'bun:test';
import type { EngineConfig } from '../src/core/types.ts';

const WASM_TRAP = "access to a null reference (evaluating 'getWasmTableEntry(e)(t, r, a)')";

const realPglite = await import('@electric-sql/pglite');
// Captured BEFORE mock.module: it patches the module namespace in place, so
// `realPglite.PGlite` would otherwise resolve to the subclass below and the
// delegating call would recurse forever.
const RealPGlite = realPglite.PGlite;

/** How many of the NEXT create() calls throw the observed trap. */
let pendingFailures = 0;
let createCalls = 0;

class FlakyPGlite extends RealPGlite {
  static async create(...args: Parameters<typeof RealPGlite.create>) {
    createCalls++;
    if (pendingFailures > 0) {
      pendingFailures--;
      throw new Error(WASM_TRAP);
    }
    return RealPGlite.create(...args);
  }
}

mock.module('@electric-sql/pglite', () => ({ ...realPglite, PGlite: FlakyPGlite }));

const { PGLiteEngine, classifyPgliteInitError } = await import('../src/core/pglite-engine.ts');

const IN_MEMORY = { engine: 'pglite' } as EngineConfig;
const COLD_START_TIMEOUT = 120_000;

async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string }> {
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    return { result: await fn(), warnings: warnings.join('\n') };
  } finally {
    console.warn = origWarn;
  }
}

describe('in-memory PGLite create retry', () => {
  test('the CI trap does NOT classify as wasm-abort — the retry cannot key on that verdict', () => {
    expect(classifyPgliteInitError(WASM_TRAP)).toBe('unknown');
  });

  test('a single create trap is retried cold and connect succeeds', async () => {
    pendingFailures = 1;
    createCalls = 0;
    const engine = new PGLiteEngine();
    const { warnings } = await captureWarnings(() => engine.connect(IN_MEMORY));
    try {
      expect(createCalls).toBe(2);
      expect(warnings).toContain('retried cold');
      expect(warnings).toContain(WASM_TRAP); // the swallowed cause is still reported
      // The engine is real and usable, and initSchema still builds the schema
      // (the retry dropped any snapshot, so it must not be skipped).
      await engine.initSchema();
      const rows = await engine.db.query<{ one: number }>('SELECT 1 AS one');
      expect(rows.rows[0]?.one).toBe(1);
      const pages = await engine.db.query('SELECT count(*)::int AS n FROM pages');
      expect(pages.rows.length).toBe(1);
    } finally {
      await engine.disconnect();
    }
  }, COLD_START_TIMEOUT);

  test('two traps in a row still surface the actionable init error', async () => {
    pendingFailures = 2;
    createCalls = 0;
    const engine = new PGLiteEngine();
    await expect(engine.connect(IN_MEMORY)).rejects.toThrow(/PGLite failed to initialize its WASM runtime/);
    expect(createCalls).toBe(2); // one attempt, one retry — never a third
    expect(pendingFailures).toBe(0);
  }, COLD_START_TIMEOUT);

  test('a healthy create is never retried', async () => {
    pendingFailures = 0;
    createCalls = 0;
    const engine = new PGLiteEngine();
    await engine.connect(IN_MEMORY);
    try {
      expect(createCalls).toBe(1);
    } finally {
      await engine.disconnect();
    }
  }, COLD_START_TIMEOUT);
});
