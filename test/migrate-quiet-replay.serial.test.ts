/**
 * Quiet fresh-install migration replay (src/core/migrate.ts runMigrations).
 *
 * Pins:
 *   - Fresh brain (version 1, all migrations pending) replays quietly: ONE
 *     "Setting up brain schema (vN)..." line, no per-migration "[N] name..."
 *     lines, and the v123/v124 handler notices are suppressed.
 *   - GBRAIN_MIGRATE_VERBOSE=1 escape hatch restores full verbose output on
 *     a fresh brain.
 *   - Upgrades (current > 1) keep the full verbose "Schema version X → Y"
 *     narration — including an in-process upgrade AFTER a quiet fresh replay,
 *     which proves the module-level quietMigrationNotices flag is reset in
 *     the finally and does not leak.
 *   - A no-pending run applies nothing and stays silent.
 *
 * Serial: mutates process.env (GBRAIN_MIGRATE_VERBOSE, GBRAIN_PGLITE_SNAPSHOT)
 * and monkey-patches process.stderr.write; everything is saved in beforeAll /
 * restored in afterAll or per-test try/finally (repo rule R1).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMigrations, LATEST_VERSION } from '../src/core/migrate.ts';

let engineA: PGLiteEngine; // fresh quiet replay + later upgrade re-run
let engineB: PGLiteEngine | null = null; // fresh verbose replay (test 2)

let prevVerbose: string | undefined;
let prevSnapshot: string | undefined;

/** Capture everything written to process.stderr.write while fn runs. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return out;
}

beforeAll(async () => {
  prevVerbose = process.env.GBRAIN_MIGRATE_VERBOSE;
  prevSnapshot = process.env.GBRAIN_PGLITE_SNAPSHOT;
  // Default state for the file: quiet mode active, and NO snapshot fast-path —
  // a snapshot-restored engine skips runMigrations entirely, which would make
  // every assertion below vacuous.
  delete process.env.GBRAIN_MIGRATE_VERBOSE;
  delete process.env.GBRAIN_PGLITE_SNAPSHOT;

  engineA = new PGLiteEngine();
  await engineA.connect({});
  // NOTE: initSchema() deliberately NOT called here — test 1 captures its
  // stderr output as the fresh-install replay under test.
});

afterAll(async () => {
  if (prevVerbose === undefined) delete process.env.GBRAIN_MIGRATE_VERBOSE;
  else process.env.GBRAIN_MIGRATE_VERBOSE = prevVerbose;
  if (prevSnapshot === undefined) delete process.env.GBRAIN_PGLITE_SNAPSHOT;
  else process.env.GBRAIN_PGLITE_SNAPSHOT = prevSnapshot;

  await engineA.disconnect();
  if (engineB) await engineB.disconnect();
});

describe('quiet fresh-install replay', () => {
  test('fresh brain prints one summary line, no per-migration or notice lines', async () => {
    const out = await captureStderr(async () => {
      await engineA.initSchema();
    });

    expect(out).toContain('Setting up brain schema (v');
    // No per-migration "  [N] name..." progress lines.
    expect(out).not.toMatch(/\[\d+\] \S+\.\.\./);
    // No "  [N] ✓ name" completion lines.
    expect(out).not.toContain('✓');
    // The verbose header is replaced, not printed alongside.
    expect(out).not.toContain('Schema version 1 →');
    // v123/v124 handler notices are suppressed via quietMigrationNotices.
    expect(out).not.toContain('v123:');
    expect(out).not.toContain('v124:');

    // The replay actually ran to completion.
    expect(await engineA.getConfig('version')).toBe(String(LATEST_VERSION));
  });

  test('GBRAIN_MIGRATE_VERBOSE=1 keeps full output on a fresh brain', async () => {
    process.env.GBRAIN_MIGRATE_VERBOSE = '1';
    try {
      engineB = new PGLiteEngine();
      await engineB.connect({});
      const out = await captureStderr(async () => {
        await engineB!.initSchema();
      });

      expect(out).toContain('Schema version 1 →');
      expect(out).toMatch(/\[\d+\] ✓ /);
      expect(out).not.toContain('Setting up brain schema');
    } finally {
      delete process.env.GBRAIN_MIGRATE_VERBOSE;
    }
  });

  test('upgrade path (current > 1) stays verbose — and the quiet flag did not leak from test 1', async () => {
    // Rewind engineA one version so exactly the last migration is pending.
    // This runs in the SAME process AFTER test 1's quiet replay, so verbose
    // output here also proves runMigrations' finally reset quietMigrationNotices.
    await engineA.setConfig('version', String(LATEST_VERSION - 1));

    let result: { applied: number; current: number } | undefined;
    const out = await captureStderr(async () => {
      result = await runMigrations(engineA);
    });

    expect(result?.applied).toBe(1);
    expect(result?.current).toBe(LATEST_VERSION);
    expect(out).toContain(`Schema version ${LATEST_VERSION - 1} → `);
    expect(out).toContain('✓');
    expect(out).not.toContain('Setting up brain schema');
  });

  test('no-pending run applies nothing and emits no setup/migration lines', async () => {
    let result: { applied: number; current: number } | undefined;
    const out = await captureStderr(async () => {
      result = await runMigrations(engineA);
    });

    expect(result?.applied).toBe(0);
    expect(result?.current).toBe(LATEST_VERSION);
    expect(out).not.toContain('Setting up brain schema');
    expect(out).not.toContain('Schema version');
    expect(out).not.toContain('✓');
  });
});
