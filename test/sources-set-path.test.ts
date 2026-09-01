/**
 * gbrain sources set-path <id> <path> (#4739)
 *
 * Non-destructive local_path pointer repair. Validates:
 *   - Happy path: updates sources.local_path for an existing source +
 *     existing directory (prior NULL and prior non-NULL both).
 *   - Missing args → exit 2 with usage.
 *   - Unknown source → exit 4 (loud rejection, never a silent 0-row UPDATE).
 *   - Nonexistent path → exit 5, no mutation (never creates directories).
 *
 * Modeled on test/sources-set-cr-mode.test.ts (same runSources dispatch,
 * same process.exit stub).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runSources } from '../src/commands/sources.ts';

describe('gbrain sources set-path', () => {
  let engine: PGLiteEngine;
  let origExit: typeof process.exit;
  let exitCode: number | null;
  const tmpDirs: string[] = [];

  function makeDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'gb-setpath-'));
    tmpDirs.push(d);
    return d;
  }

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    process.exit = origExit;
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    exitCode = null;
    origExit = process.exit;
    (process as unknown as { exit: (n: number) => never }).exit = ((n: number) => {
      exitCode = n;
      throw new Error(`__test_exit_${n}__`);
    }) as never;
  });

  async function readLocalPath(id: string): Promise<string | null> {
    const rows = await engine.executeRaw<{ local_path: string | null }>(
      `SELECT local_path FROM sources WHERE id = $1`,
      [id],
    );
    return rows[0]?.local_path ?? null;
  }

  test('happy path: sets a NULL local_path to a real directory', async () => {
    const dir = makeDir();
    expect(await readLocalPath('default')).toBeNull();
    await runSources(engine, ['set-path', 'default', dir]);
    expect(await readLocalPath('default')).toBe(dir);
  });

  test('happy path: repoints an existing local_path', async () => {
    const first = makeDir();
    const second = makeDir();
    await runSources(engine, ['set-path', 'default', first]);
    await runSources(engine, ['set-path', 'default', second]);
    expect(await readLocalPath('default')).toBe(second);
  });

  test('rejection: missing arguments → exit 2 (usage)', async () => {
    try {
      await runSources(engine, ['set-path', 'default']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_2__');
    }
    expect(exitCode).toBe(2);
    expect(await readLocalPath('default')).toBeNull(); // no mutation
  });

  test('rejection: unknown source → exit 4 (loud, never a silent 0-row UPDATE)', async () => {
    const dir = makeDir();
    try {
      await runSources(engine, ['set-path', 'nonexistent-source', dir]);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_4__');
    }
    expect(exitCode).toBe(4);
  });

  test('rejection: nonexistent path → exit 5, no mutation (never creates directories)', async () => {
    try {
      await runSources(engine, ['set-path', 'default', '/definitely/not/a/real/dir/xyz']);
    } catch (err) {
      expect((err as Error).message).toContain('__test_exit_5__');
    }
    expect(exitCode).toBe(5);
    expect(await readLocalPath('default')).toBeNull(); // no mutation
  });
});
