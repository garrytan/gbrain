/**
 * v0.41.30.0 — code-callers / code-callees end-to-end source resolution (BUG 1).
 *
 * Serial (`*.serial.test.ts`) because it process.chdir()s into a temp dir
 * holding a .gbrain-source pin — process.cwd() is process-global and races
 * with parallel files. Drives the real runCodeCallers / runCodeCallees through
 * their process.cwd()-based resolution, asserting:
 *   - a .gbrain-source pin resolves on a multi-source brain (no exit 2)
 *   - no pin + no flag + multi-source still errors (exit 2)
 *   - explicit --source overrides
 *   - A4: JSON envelope carries source_id + scope; --all-sources → null/'all'
 *   - A4: sole_non_default tier emits the stderr nudge
 *   - A5: zero-result implicit scope appends the "try --all-sources" hint
 *
 * PGLite in-memory, no DATABASE_URL.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCodeCallers } from '../src/commands/code-callers.ts';
import { runCodeCallees } from '../src/commands/code-callees.ts';

let engine: PGLiteEngine;
let origCwd: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  origCwd = process.cwd();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(() => {
  process.chdir(origCwd);
});

async function addSource(id: string, localPath: string | null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, created_at)
     VALUES ($1, $1, $2, '{}'::jsonb, NOW()) ON CONFLICT (id) DO NOTHING`,
    [id, localPath],
  );
}

function pinnedDir(sourceId: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-pin-cli-'));
  writeFileSync(join(dir, '.gbrain-source'), `${sourceId}\n`);
  return dir;
}

/** Run fn with process.exit + console.log/error spied. Returns captured output
 * + the exit code if process.exit was called (spied to throw an EXIT sentinel). */
async function capture(fn: () => Promise<void>): Promise<{ logs: string[]; errs: string[]; exitCode: number | null }> {
  const logs: string[] = [];
  const errs: string[] = [];
  let exitCode: number | null = null;
  const logSpy = spyOn(console, 'log').mockImplementation((m?: unknown) => { logs.push(String(m)); });
  const errSpy = spyOn(console, 'error').mockImplementation((m?: unknown) => { errs.push(String(m)); });
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error('EXIT');
  }) as never);
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof Error) || e.message !== 'EXIT') throw e;
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { logs, errs, exitCode };
}

describe('code-callers / code-callees — .gbrain-source pin (CLI wiring)', () => {
  test('pin resolves on a multi-source brain: no exit 2, output names the pinned source', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    const dir = pinnedDir('repo-a');
    process.chdir(dir);
    try {
      const callers = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        capture(() => runCodeCallers(engine, ['someSym', '--no-json'])));
      expect(callers.exitCode).toBeNull(); // resolved, did NOT error
      expect(callers.logs.join('\n')).toContain("repo-a");

      const callees = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        capture(() => runCodeCallees(engine, ['someSym', '--no-json'])));
      expect(callees.exitCode).toBeNull();
      expect(callees.logs.join('\n')).toContain("repo-a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('no pin + no flag + multi-source → exit 2 (ambiguous preserved)', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-nopin-cli-'));
    process.chdir(dir);
    try {
      const callers = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        capture(() => runCodeCallers(engine, ['someSym', '--no-json'])));
      expect(callers.exitCode).toBe(2);
      expect(callers.errs.join('\n')).toContain('--source');

      const callees = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        capture(() => runCodeCallees(engine, ['someSym', '--no-json'])));
      expect(callees.exitCode).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('explicit --source overrides (even with a conflicting pin)', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    const dir = pinnedDir('repo-a');
    process.chdir(dir);
    try {
      const { logs, exitCode } = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        capture(() => runCodeCallers(engine, ['someSym', '--source', 'repo-b', '--json'])));
      expect(exitCode).toBeNull();
      const env = JSON.parse(logs.join('\n'));
      expect(env.source_id).toBe('repo-b');
      expect(env.scope).toBe('single');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A4: JSON envelope carries source_id + scope (resolved pin)', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    const dir = pinnedDir('repo-a');
    process.chdir(dir);
    try {
      const { logs } = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        capture(() => runCodeCallers(engine, ['someSym', '--json'])));
      const env = JSON.parse(logs.join('\n'));
      expect(env.source_id).toBe('repo-a');
      expect(env.scope).toBe('single');
      expect(env.symbol).toBe('someSym');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A4: --all-sources → source_id null, scope "all"', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-all-cli-'));
    process.chdir(dir);
    try {
      const { logs, exitCode } = await capture(() =>
        runCodeCallers(engine, ['someSym', '--all-sources', '--json']));
      expect(exitCode).toBeNull();
      const env = JSON.parse(logs.join('\n'));
      expect(env.source_id).toBeNull();
      expect(env.scope).toBe('all');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A4: sole_non_default tier emits the stderr nudge', async () => {
    await addSource('repo-a', '/fake/a'); // default + one non-default w/ local_path
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-sole-cli-'));
    process.chdir(dir);
    try {
      const { errs, exitCode } = await withEnv(
        { GBRAIN_SOURCE: undefined, GBRAIN_NO_SOLE_NON_DEFAULT_NUDGE: undefined },
        () => capture(() => runCodeCallers(engine, ['someSym', '--json'])));
      expect(exitCode).toBeNull();
      expect(errs.join('\n')).toContain("routing to source 'repo-a'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A4: dotfile-pin tier does NOT emit the sole_non_default nudge', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    const dir = pinnedDir('repo-a');
    process.chdir(dir);
    try {
      const { errs } = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        capture(() => runCodeCallers(engine, ['someSym', '--json'])));
      expect(errs.join('\n')).not.toContain('routing to source');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('A5: zero-result implicit scope appends the "try --all-sources" hint', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    const dir = pinnedDir('repo-a');
    process.chdir(dir);
    try {
      // human output
      const human = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        capture(() => runCodeCallers(engine, ['someSym', '--no-json'])));
      expect(human.logs.join('\n')).toContain('Try --all-sources');

      // JSON hint field
      const jsonRun = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        capture(() => runCodeCallees(engine, ['someSym', '--json'])));
      const env = JSON.parse(jsonRun.logs.join('\n'));
      expect(env.count).toBe(0);
      expect(env.hint).toContain('--all-sources');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bad .gbrain-source pin → exit 2 with JSON error envelope', async () => {
    await addSource('repo-a', '/fake/a');
    await addSource('repo-b', '/fake/b');
    const dir = pinnedDir('nonexistent-src');
    process.chdir(dir);
    try {
      const { logs, exitCode } = await withEnv({ GBRAIN_SOURCE: undefined }, () =>
        capture(() => runCodeCallers(engine, ['someSym', '--json'])));
      expect(exitCode).toBe(2);
      const env = JSON.parse(logs.join('\n'));
      expect(env.error.code).toBe('invalid_source_pin');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
