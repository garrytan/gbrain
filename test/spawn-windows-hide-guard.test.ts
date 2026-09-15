/**
 * Windows console-window guard (#4992).
 *
 * A detached gbrain child (Stop-hook push, backup check, the supervisor →
 * worker → job-child tree) runs on Windows with DETACHED_PROCESS, i.e. with
 * NO console. Every console-subsystem grandchild it then spawns (git,
 * powershell, the CLI re-exec'ing itself) gets a brand-new console window
 * that steals focus — one flash per git call per agent turn, one persistent
 * window per worker. CREATE_NO_WINDOW is the fix; Node and Bun expose it as
 * `windowsHide: true` (a documented no-op on every other platform).
 *
 * The flag lives at ONE seam, `src/core/spawn.ts`, which wraps
 * `child_process` and `Bun.spawn` and merges `windowsHide: true` into every
 * options object. This guard keeps the seam load-bearing:
 *   (a) pins the option-merge shapes for every child_process signature,
 *   (b) proves the runtime accepts the flag on a real subprocess,
 *   (c) fails on any `child_process` / `Bun.spawn` use in src/ outside the seam
 *       — a new call site that bypasses the wrapper silently regresses Windows.
 *
 * Static scan only, no Windows box required; the maintainer collects the
 * platform receipt from the reporter separately.
 */

import { describe, test, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join, relative, resolve, sep } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const SRC_DIR = join(REPO_ROOT, 'src');
const SEAM = 'src/core/spawn.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** `file:line` for every code line (comment-only lines skipped) matching `re`. */
function offenders(re: RegExp): string[] {
  const hits: string[] = [];
  for (const file of walk(SRC_DIR)) {
    const rel = relative(REPO_ROOT, file).split(sep).join('/');
    if (rel === SEAM) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (re.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits.sort();
}

// Any quoted `child_process` specifier: static import/export, `await import()`,
// `require()`, and `typeof import()` all carry the quoted module name.
const CHILD_PROCESS_SPECIFIER = /['"](node:)?child_process['"]/;
const BUN_SPAWN_CALL = /\bBun\.spawn(Sync)?\(/;

describe('windowsHide seam — src/ routes every subprocess through src/core/spawn.ts (#4992)', () => {
  test('the seam itself is the one place that touches child_process (guard is not vacuous)', () => {
    const seam = readFileSync(join(REPO_ROOT, 'src', 'core', 'spawn.ts'), 'utf8');
    expect(CHILD_PROCESS_SPECIFIER.test(seam)).toBe(true);
    expect(seam).toMatch(/\bBun\.spawn\b/);
    expect(seam).toMatch(/\bBun\.spawnSync\b/);
    expect(seam).toContain('windowsHide');
  });

  test('no src file outside the seam names the child_process module', () => {
    expect(offenders(CHILD_PROCESS_SPECIFIER)).toEqual([]);
  });

  test('no src file outside the seam calls Bun.spawn / Bun.spawnSync directly', () => {
    expect(offenders(BUN_SPAWN_CALL)).toEqual([]);
  });

  test('scanner self-test — comment-only lines are ignored, code lines are not', () => {
    // Guards against the scan rotting into a permanent pass.
    expect(/^\s*(\/\/|\*|\/\*)/.test(`  // import { spawn } from 'child_process';`)).toBe(true);
    expect(CHILD_PROCESS_SPECIFIER.test(`import { spawn } from 'node:child_process';`)).toBe(true);
    expect(CHILD_PROCESS_SPECIFIER.test(`const { execSync } = await import('child_process');`)).toBe(true);
    expect(CHILD_PROCESS_SPECIFIER.test(`require('child_process') as typeof import('child_process')`)).toBe(true);
    expect(CHILD_PROCESS_SPECIFIER.test(`import { spawn } from '../core/spawn.ts';`)).toBe(false);
    expect(BUN_SPAWN_CALL.test(`const proc = Bun.spawn(argv, {`)).toBe(true);
    expect(BUN_SPAWN_CALL.test(`const proc = bunSpawn(argv, {`)).toBe(false);
  });
});

describe('withWindowsHide — option-merge shapes for every child_process signature', () => {
  const load = () => import('../src/core/spawn.ts');

  test('spawn(cmd, args) / spawnSync / execFileSync: options appended', async () => {
    const { withWindowsHide } = await load();
    expect(withWindowsHide(['git', ['status']])).toEqual(['git', ['status'], { windowsHide: true }]);
    expect(withWindowsHide(['git'])).toEqual(['git', { windowsHide: true }]);
  });

  test('existing options object gets the flag merged, at either position, without mutation', async () => {
    const { withWindowsHide } = await load();
    const opts = { cwd: '/tmp', stdio: 'ignore' };
    expect(withWindowsHide(['git', ['status'], opts])).toEqual([
      'git', ['status'], { cwd: '/tmp', stdio: 'ignore', windowsHide: true },
    ]);
    expect(withWindowsHide(['git', opts])).toEqual(['git', { cwd: '/tmp', stdio: 'ignore', windowsHide: true }]);
    expect(opts).toEqual({ cwd: '/tmp', stdio: 'ignore' });
  });

  test('exec(cmd, cb) / execFile(file, args, cb): options inserted BEFORE the callback', async () => {
    const { withWindowsHide } = await load();
    const cb = () => {};
    expect(withWindowsHide(['ls', cb])).toEqual(['ls', { windowsHide: true }, cb]);
    expect(withWindowsHide(['ls', ['-l'], cb])).toEqual(['ls', ['-l'], { windowsHide: true }, cb]);
    expect(withWindowsHide(['ls', ['-l'], { cwd: '/' }, cb])).toEqual([
      'ls', ['-l'], { cwd: '/', windowsHide: true }, cb,
    ]);
  });

  test('an explicit undefined options slot is filled, not shadowed by a 4th argument', async () => {
    const { withWindowsHide } = await load();
    expect(withWindowsHide(['git', ['status'], undefined])).toEqual(['git', ['status'], { windowsHide: true }]);
    const cb = () => {};
    expect(withWindowsHide(['ls', undefined, cb])).toEqual(['ls', { windowsHide: true }, cb]);
  });

  test('a caller that explicitly sets windowsHide keeps its value (GUI children may opt out)', async () => {
    const { withWindowsHide } = await load();
    expect(withWindowsHide(['app', { windowsHide: false }])).toEqual(['app', { windowsHide: false }]);
  });

  test('the wrapped functions run a real subprocess with the flag (runtime accepts windowsHide)', async () => {
    const { execFileSync, spawnSync, bunSpawnSync } = await load();
    const argv = ['-e', 'process.stdout.write("ok")'];
    expect(execFileSync(process.execPath, argv, { encoding: 'utf8' })).toBe('ok');
    expect(spawnSync(process.execPath, argv, { encoding: 'utf8' }).stdout).toBe('ok');
    expect(bunSpawnSync([process.execPath, ...argv], { stdout: 'pipe' }).stdout.toString()).toBe('ok');
  });
});
