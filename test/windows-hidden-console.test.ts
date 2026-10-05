/**
 * #4992 on Windows: a detached gbrain process (the Stop-hook push, the backup
 * check, the job supervisor, its worker, every job child) has no console, so
 * each console program it launches without windowsHide opens a visible
 * console window that takes focus.
 *
 * The launcher fixture runs detached through the production supervisor path
 * and launches a compiled console probe the ways gbrain does; the probe
 * reports whether its own console window is visible. The control launch
 * (raw child_process, no windowsHide) must show a window, or this runner
 * cannot tell a hidden launch from one that never had a window. Runs natively
 * on the windows-latest row of the test.yml security-regressions job.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnDetachedSupervisor } from '../src/core/minions/detached-stderr.ts';

const FIXTURES = join(import.meta.dir, 'fixtures', 'windows-console');
const HIDDEN = { console: true, visibleWindow: false };
const SEAM_LAUNCHERS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'bunSpawn', 'bunSpawnSync'];

describe.skipIf(process.platform !== 'win32')('console windows from a detached gbrain process (#4992)', () => {
  let dir = '';
  let results: Record<string, unknown> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-console-'));
    mkdirSync(join(dir, 'bin'));
    const probe = join(dir, 'bin', 'git.exe');
    const build = spawnSync(process.execPath, ['build', '--compile', '--no-compile-autoload-bunfig', join(FIXTURES, 'console-state.ts'), '--outfile', probe], { encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`probe build failed: ${build.stderr}`);

    const started = spawnDetachedSupervisor(process.execPath, join(FIXTURES, 'console-less-launcher.ts'), [dir, probe]);
    const result = join(dir, 'result.json');
    for (let waited = 0; !existsSync(result) && waited < 120_000; waited += 100) await Bun.sleep(100);
    if (!existsSync(result)) {
      const stderr = started.stderrPath && existsSync(started.stderrPath) ? readFileSync(started.stderrPath, 'utf8') : '';
      throw new Error(`launcher wrote no result (pid ${started.pid}): ${stderr.slice(-2000)}`);
    }
    results = JSON.parse(readFileSync(result, 'utf8'));
    process.stderr.write(`Windows console windows: ${JSON.stringify({ arch: process.arch, runtime: Bun.version, results })}\n`);
  }, 240_000);

  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  test('control: the detached process has no console, and an unhidden launch from it shows a window', () => {
    expect(results.launcher).toEqual({ console: false, visibleWindow: false });
    expect(results.control).toEqual({ console: true, visibleWindow: true });
  });

  test("the job supervisor's worker opens no visible console window", () => {
    expect(results.worker).toEqual(HIDDEN);
  });

  test("the Stop-hook push's git command opens no visible console window", () => {
    expect(results.git).toEqual(HIDDEN);
  });

  test('every src/core/spawn.ts launcher opens no visible console window', () => {
    const seen = Object.fromEntries(SEAM_LAUNCHERS.map(name => [name, results[name] ?? results.seam]));
    expect(seen).toEqual(Object.fromEntries(SEAM_LAUNCHERS.map(name => [name, HIDDEN])));
  });
});
