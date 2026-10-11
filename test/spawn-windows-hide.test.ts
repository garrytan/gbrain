/**
 * #4992: every subprocess gbrain launches defaults `windowsHide: true` through
 * src/core/spawn.ts, so a detached gbrain process on Windows (no console)
 * stops opening a visible console window for each program it runs.
 *
 * The wrappers are checked for every argument shape Node accepts, and the
 * production sites behind the reported windows (the detached supervisor, its
 * worker, the Stop-hook push's git) are checked at the child_process boundary.
 * The window itself is observed natively in test/windows-hidden-console.test.ts.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as seam from '../src/core/spawn.ts';
import { spawnDetachedSupervisor } from '../src/core/minions/detached-stderr.ts';
import { ChildWorkerSupervisor } from '../src/core/minions/child-worker-supervisor.ts';
import { resolveWorkspaceRoot } from '../src/core/workspace-push.ts';

afterEach(() => { mock.restore(); });

/** Replace `name` on child_process with a recorder; returns the recorded argument lists. */
function record(name: 'spawn' | 'spawnSync' | 'execFile' | 'execFileSync' | 'exec' | 'execSync') {
  const calls: unknown[][] = [];
  spyOn(childProcess, name).mockImplementation(((...args: unknown[]) => { calls.push(args); return 'recorded'; }) as never);
  return calls;
}

describe('src/core/spawn.ts defaults windowsHide: true', () => {
  const callback = () => {};

  test.each([
    ['spawn(cmd)', () => seam.spawn('cmd'), [[], { windowsHide: true }]],
    ['spawn(cmd, args)', () => seam.spawn('cmd', ['a']), [['a'], { windowsHide: true }]],
    ['spawn(cmd, options)', () => seam.spawn('cmd', { cwd: '/w' }), [[], { cwd: '/w', windowsHide: true }]],
    ['spawn(cmd, args, options)', () => seam.spawn('cmd', ['a'], { detached: true, stdio: 'ignore' }), [['a'], { detached: true, stdio: 'ignore', windowsHide: true }]],
    ['spawn(cmd, undefined, options)', () => seam.spawn('cmd', undefined as never, { cwd: '/w' }), [[], { cwd: '/w', windowsHide: true }]],
    ['spawn explicit false', () => seam.spawn('cmd', ['a'], { windowsHide: false }), [['a'], { windowsHide: false }]],
  ])('%s', (_label, call, rest) => {
    const calls = record('spawn');
    call();
    expect(calls).toEqual([['cmd', ...rest]]);
  });

  test.each([
    ['spawnSync', () => seam.spawnSync('cmd', { encoding: 'utf8' }), 'spawnSync', [[], { encoding: 'utf8', windowsHide: true }]],
    ['execFileSync(file, args, options)', () => seam.execFileSync('git', ['status'], { encoding: 'utf8', timeout: 5 }), 'execFileSync', [['status'], { encoding: 'utf8', timeout: 5, windowsHide: true }]],
    ['execFileSync(file, options)', () => seam.execFileSync('git', { stdio: 'pipe' }), 'execFileSync', [[], { stdio: 'pipe', windowsHide: true }]],
    ['execSync(command)', () => seam.execSync('git status'), 'execSync', [{ windowsHide: true }]],
    ['execSync explicit false', () => seam.execSync('git status', { windowsHide: false }), 'execSync', [{ windowsHide: false }]],
  ] as const)('%s', (_label, call, name, rest) => {
    const calls = record(name);
    call();
    expect(calls).toEqual([[name === 'execSync' ? 'git status' : name === 'spawnSync' ? 'cmd' : 'git', ...rest]]);
  });

  test.each([
    ['execFile(file, callback)', () => seam.execFile('git', callback), ['git', [], { windowsHide: true }, callback]],
    ['execFile(file, args, callback)', () => seam.execFile('git', ['log'], callback), ['git', ['log'], { windowsHide: true }, callback]],
    ['execFile(file, options, callback)', () => seam.execFile('git', { cwd: '/w' }, callback), ['git', [], { cwd: '/w', windowsHide: true }, callback]],
    ['execFile(file, args, options, callback)', () => seam.execFile('git', ['log'], { timeout: 9 }, callback), ['git', ['log'], { timeout: 9, windowsHide: true }, callback]],
    ['execFile(file, args, options)', () => seam.execFile('git', ['log'], { timeout: 9 }), ['git', ['log'], { timeout: 9, windowsHide: true }]],
  ])('%s', (_label, call, expected) => {
    const calls = record('execFile');
    call();
    expect(calls).toEqual([expected]);
  });

  test.each([
    ['exec(command, callback)', () => seam.exec('git log', callback), ['git log', { windowsHide: true }, callback]],
    ['exec(command, options, callback)', () => seam.exec('git log', { cwd: '/w' }, callback), ['git log', { cwd: '/w', windowsHide: true }, callback]],
  ])('%s', (_label, call, expected) => {
    const calls = record('exec');
    call();
    expect(calls).toEqual([expected]);
  });

  test('bunSpawn and bunSpawnSync default it in both call forms and keep an explicit false', () => {
    const spawned: unknown[][] = [];
    spyOn(Bun, 'spawn').mockImplementation(((...args: unknown[]) => { spawned.push(args); return {}; }) as never);
    spyOn(Bun, 'spawnSync').mockImplementation(((...args: unknown[]) => { spawned.push(args); return {}; }) as never);
    seam.bunSpawn(['git', 'log'], { stdout: 'pipe' });
    seam.bunSpawn({ cmd: ['git', 'log'] });
    seam.bunSpawnSync(['git', 'log']);
    seam.bunSpawnSync({ cmd: ['git', 'log'], windowsHide: false });
    expect(spawned).toEqual([
      [['git', 'log'], { stdout: 'pipe', windowsHide: true }],
      [{ cmd: ['git', 'log'], windowsHide: true }],
      [['git', 'log'], { windowsHide: true }],
      [{ cmd: ['git', 'log'], windowsHide: false }],
    ]);
  });

  test('real launches keep their results: sync output, async callback and promisified { stdout, stderr }', async () => {
    const script = ['-e', 'process.stdout.write("out"); process.stderr.write("err")'];
    expect(seam.execFileSync(process.execPath, script, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).toBe('out');
    const viaCallback = await new Promise<string>((resolve, reject) =>
      seam.execFile(process.execPath, script, (error, stdout) => (error ? reject(error) : resolve(String(stdout)))));
    expect(viaCallback).toBe('out');
    expect(await promisify(seam.execFile)(process.execPath, script)).toEqual({ stdout: 'out', stderr: 'err' });
  });
});

describe('the spawn sites behind the reported windows pass windowsHide: true', () => {
  test('the detached job supervisor (`jobs supervisor start --detach`)', () => {
    const spawn = spyOn(childProcess, 'spawn');
    const started = spawnDetachedSupervisor(process.execPath, '-e', ['void 0']);
    expect(started.pid).toBeGreaterThan(0);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true, windowsHide: true });
  });

  test("the supervisor's worker", async () => {
    const spawn = spyOn(childProcess, 'spawn');
    let stopping = false;
    await new ChildWorkerSupervisor({
      cliPath: process.execPath, args: ['-e', 'void 0'], maxCrashes: 1, _backoffFloorMs: 1,
      isStopping: () => stopping,
      onMaxCrashesExceeded: () => { stopping = true; },
      onEvent: event => { if (event.kind === 'worker_exited') stopping = true; },
    }).run();
    expect(spawn.mock.calls.length).toBe(1);
    expect(spawn.mock.calls[0][2]).toMatchObject({ stdio: 'inherit', windowsHide: true });
  });

  test("the Stop-hook push's git commands", () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-push-git-'));
    try {
      const git = spyOn(childProcess, 'execFileSync');
      resolveWorkspaceRoot(dir);
      expect(git.mock.calls[0]?.[0]).toBe('git');
      expect(git.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
