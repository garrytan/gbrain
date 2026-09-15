/**
 * Coverage audit for the subprocess seam (#4992) — fills the branches
 * test/spawn-windows-hide-guard.test.ts leaves open:
 *   - withWindowsHide: `null` options slot, explicit `windowsHide: false` at
 *     the spawn(cmd, args, opts) position and input non-mutation, an explicit
 *     `windowsHide: undefined` still defaulting to true;
 *   - hidden(): the call-time `cp[name]` lookup means spyOn(cp, ...) sees the
 *     merged options;
 *   - bunSpawn/bunSpawnSync: object call shape, and an explicit `false` in the
 *     caller's opts winning the spread;
 *   - end-to-end through real children on this host (windowsHide is a no-op
 *     off Windows, but the merge must not break any signature);
 *   - the compiled-binary regression (e84d93266): spawn.ts must never carry an
 *     `export *` line;
 *   - promisify(exec/execFile) keeps node's `{ stdout, stderr }` resolution
 *     (the wrappers carry `util.promisify.custom`).
 * Keyless; no network.
 */

import { test, expect, spyOn } from 'bun:test';
import * as cp from 'child_process';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { promisify } from 'node:util';
import {
  withWindowsHide, spawnSync, execFileSync, exec, execFile, bunSpawn, bunSpawnSync,
} from '../src/core/spawn.ts';

const SEAM_PATH = join(resolve(import.meta.dir, '..'), 'src', 'core', 'spawn.ts');

test('withWindowsHide / hidden() / bunSpawn — uncovered merge branches', () => {
  // `null` options slot is filled like `undefined` (== null branch).
  expect(withWindowsHide(['git', null])).toEqual(['git', { windowsHide: true }]);
  const cb = () => {};
  expect(withWindowsHide(['ls', null, cb])).toEqual(['ls', { windowsHide: true }, cb]);

  // Explicit false at the spawn(cmd, args, opts) position survives; neither the
  // args array nor the options object is mutated.
  const args = ['app', ['--gui'], { windowsHide: false, cwd: '/' }] as const;
  const snapshot = JSON.parse(JSON.stringify(args));
  expect(withWindowsHide(args)).toEqual(['app', ['--gui'], { windowsHide: false, cwd: '/' }]);
  expect(JSON.parse(JSON.stringify(args))).toEqual(snapshot);
  expect(withWindowsHide(args)[2]).not.toBe(args[2]);

  // `windowsHide: undefined` is "unset", not "opted out".
  expect(withWindowsHide(['x', { windowsHide: undefined }])).toEqual(['x', { windowsHide: true }]);

  // hidden(): the namespace lookup happens per call, so a spy on cp sees the
  // merged options — and the seam adds exactly one key.
  const spy = spyOn(cp, 'spawnSync').mockImplementation((() => ({ stdout: 'MOCK' })) as never);
  try {
    expect((spawnSync('nope', ['x'], { encoding: 'utf8' }) as { stdout: unknown }).stdout).toBe('MOCK');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toEqual(['nope', ['x'], { encoding: 'utf8', windowsHide: true }]);
  } finally {
    spy.mockRestore();
  }

  // bunSpawn: both call shapes get the flag; caller's explicit false wins the
  // spread (opts spreads AFTER `windowsHide: true`).
  const seen: unknown[][] = [];
  const orig = Bun.spawnSync;
  (Bun as { spawnSync: unknown }).spawnSync = (...a: unknown[]) => { seen.push(a); return { exitCode: 0 }; };
  try {
    bunSpawnSync(['echo'], { stdout: 'pipe' });
    bunSpawnSync({ cmd: ['echo'], stdout: 'pipe' });
    bunSpawnSync(['echo'], { windowsHide: false } as never);
    bunSpawnSync({ cmd: ['echo'], windowsHide: false } as never);
  } finally {
    (Bun as { spawnSync: unknown }).spawnSync = orig;
  }
  expect(seen).toEqual([
    [['echo'], { windowsHide: true, stdout: 'pipe' }],
    [{ windowsHide: true, cmd: ['echo'], stdout: 'pipe' }],
    [['echo'], { windowsHide: false }],
    [{ windowsHide: false, cmd: ['echo'] }],
  ]);
});

test('end-to-end through the seam on this host + no `export *` in spawn.ts', async () => {
  expect(execFileSync('echo', ['hi'], { encoding: 'utf8' }).trim()).toBe('hi');
  expect(spawnSync('echo', ['hi'], { encoding: 'utf8' }).stdout.trim()).toBe('hi');

  // Callback form: options object is spliced in BEFORE the callback.
  const viaExec = await new Promise<string>((res, rej) =>
    exec('echo hi', (err, stdout) => (err ? rej(err) : res(String(stdout)))));
  expect(viaExec.trim()).toBe('hi');

  const proc = bunSpawn(['echo', 'hi'], { stdout: 'pipe' });
  expect(await proc.exited).toBe(0);
  expect((await new Response(proc.stdout).text()).trim()).toBe('hi');
  expect(bunSpawnSync({ cmd: ['echo', 'hi'], stdout: 'pipe' }).stdout.toString().trim()).toBe('hi');

  // e84d93266: `export * from 'child_process'` compiles to a __reExport against
  // an undefined node-builtin binding under `bun build --compile`; the binary
  // then dies at load. Only type-only + wrapped-value exports are allowed.
  const seam = readFileSync(SEAM_PATH, 'utf8');
  const exportStar = seam.split('\n').filter((l) => /^\s*export\s+\*/.test(l));
  expect(exportStar).toEqual([]);
  expect(seam).toMatch(/^export type \{/m);
});

test('promisify(exec) / promisify(execFile) through the seam resolve { stdout, stderr } like node', async () => {
  const viaExec = await promisify(exec)('echo hi');
  expect(typeof viaExec).toBe('object');
  expect(String(viaExec.stdout).trim()).toBe('hi');
  expect(viaExec).toHaveProperty('stderr');
  const viaExecFile = await promisify(execFile)('echo', ['hi']);
  expect(String(viaExecFile.stdout).trim()).toBe('hi');
});
