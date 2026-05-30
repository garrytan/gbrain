/**
 * Regression: synthesize phase MUST refuse to write reverse-pages to a
 * relative brainDir. Pre-fix, `runCycle({brainDir: '.'})` or any caller
 * passing a relative path (or empty string) would silently let
 * writeFileSync resolve against cwd, spilling synthesize output into
 * `<cwd>/companies/novamind.md` etc. Surfaced by the warm-narwhal wave
 * when E2E test cleanup found orphan synthesize pages at repo root.
 *
 * Two contracts pinned here:
 *   1. Empty/whitespace-only brainDir → returns failed() with code
 *      `BRAINDIR_EMPTY` (loud, not silent cwd resolution).
 *   2. Relative brainDir → resolved to absolute via path.resolve() before
 *      any reverse-write can use it. Verified by checking opts.brainDir
 *      after the call returns.
 *
 * Doesn't drive Anthropic — synthesize hits the "not_configured" skip
 * branch first (no corpus dir set), which is sufficient to exercise the
 * brainDir gate at function entry.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';

let engine: PGLiteEngine;
let tmpDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  tmpDir = mkdtempSync(join(tmpdir(), 'synth-braindir-'));
});

afterAll(async () => {
  await engine.disconnect();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('runPhaseSynthesize brainDir resolution (regression)', () => {
  test('empty brainDir returns failed(BRAINDIR_EMPTY) instead of silently resolving against cwd', async () => {
    const result = await runPhaseSynthesize(engine, {
      brainDir: '',
      dryRun: true,
    });
    expect(result.status).toBe('fail');
    expect((result as { error?: { code?: string } }).error?.code).toBe('BRAINDIR_EMPTY');
  });

  test('whitespace-only brainDir also fails BRAINDIR_EMPTY', async () => {
    const result = await runPhaseSynthesize(engine, {
      brainDir: '   ',
      dryRun: true,
    });
    expect(result.status).toBe('fail');
    expect((result as { error?: { code?: string } }).error?.code).toBe('BRAINDIR_EMPTY');
  });

  test('relative brainDir gets resolved to absolute before any reverse-write', async () => {
    const opts = { brainDir: '.', dryRun: true };
    // The phase will return early ('not_configured' — no corpus dir set on
    // this fresh engine) but the normalization runs unconditionally at entry.
    await runPhaseSynthesize(engine, opts);
    // After the call, opts.brainDir should be the resolved absolute path,
    // proving the normalization fired.
    expect(isAbsolute(opts.brainDir)).toBe(true);
    expect(opts.brainDir).not.toBe('.');
  });

  test('absolute brainDir is preserved unchanged', async () => {
    const opts = { brainDir: tmpDir, dryRun: true };
    await runPhaseSynthesize(engine, opts);
    // Already absolute → no mutation.
    expect(opts.brainDir).toBe(tmpDir);
  });
});
