import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as privacy from '../src/core/backup/private-path.ts';

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;

type Launch = { kind: 'warmup' | 'protection'; timeout: number | undefined; executable: string; args: string[] };
type Outcome = 'ok' | 'timeout' | 'error' | 'throw';

/**
 * Simulates Windows PowerShell on any host. `coldMs` is how long PowerShell
 * takes to start for the first time, on a virtual clock: each launch waits for
 * what is left of it and fails as execFile's timeout kill does when its bound
 * is shorter, so a warm-up killed at its bound leaves the next launch still
 * cold. `warmup` forces the warm-up launch's outcome instead; `protection`
 * forces every protection launch to hang past its bound or fail.
 */
function simulatePowerShell(options: { coldMs?: number; warmup?: Outcome; protection?: 'timeout' | 'error' }) {
  const launches: Launch[] = [];
  const execute = childProcess.execFile;
  let elapsed = 0;
  const spy = spyOn(childProcess, 'execFile').mockImplementation(new Proxy(execute, {
    apply(target, thisArg, args) {
      if (args[0] !== powershell) return Reflect.apply(target, thisArg, args);
      const launchOptions = args[2] as childProcess.ExecFileOptionsWithStringEncoding;
      const kind = launchOptions.env?.GBRAIN_BACKUP_PRIVATE_PATH ? 'protection' : 'warmup';
      launches.push({ kind, timeout: launchOptions.timeout, executable: args[0], args: [...args[1]] });
      const startup = Math.max(0, (options.coldMs ?? 0) - elapsed);
      const forced = kind === 'warmup' ? options.warmup : options.protection;
      if (forced === 'throw') throw new Error('injected warm-up launch failure');
      const timedOut = forced === 'timeout' || startup > (launchOptions.timeout ?? Infinity);
      elapsed += timedOut ? launchOptions.timeout ?? 0 : startup;
      const done = args[3];
      return Reflect.apply(target, thisArg, [process.execPath, ['--no-env-file', '--eval',
        "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(process.env.GBRAIN_BACKUP_PRIVATE_PATH ? 'private' : ''))"],
        { ...launchOptions, timeout: undefined },
        (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => {
          if (timedOut) return done(Object.assign(new Error('spawn timed out'), { killed: true, signal: 'SIGTERM', code: null }), '', '');
          if (forced === 'error') return done(Object.assign(new Error('injected warm-up failure'), { code: 1 }), '', '');
          done(error, stdout, stderr);
        }]);
    },
  }));
  return { launches, restore: () => spy.mockRestore() };
}

async function protectFresh(): Promise<{ path: string; error: unknown }> {
  const tmp = fs.mkdtempSync(join(tmpdir(), 'gbrain-warmup-'));
  const path = join(tmp, 'empty');
  fs.writeFileSync(path, '');
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    await privacy.protectNewBackupPath(path, 'file');
    return { path, error: null };
  } catch (error) {
    return { path, error };
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

afterEach(() => privacy.__resetPowerShellWarmupForTests());

test('a cold PowerShell start longer than the protection bound no longer fails the first backup', async () => {
  privacy.__resetPowerShellWarmupForTests();
  const shell = simulatePowerShell({ coldMs: 27_700 });
  try {
    const first = await protectFresh();
    const second = await protectFresh();
    expect(first.error).toBeNull();
    expect(second.error).toBeNull();
    expect(shell.launches.map(launch => launch.kind)).toEqual(['warmup', 'protection', 'protection']);
    const [warmup, protection] = shell.launches;
    expect(warmup.args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0']);
    expect(warmup.timeout).toBe(30_000);
    expect(protection.timeout).toBe(15_000);
  } finally { shell.restore(); }
});

for (const warmup of ['timeout', 'error', 'throw'] as const) {
  test(`a warm-up ${warmup} is ignored and the protection step still launches exactly once`, async () => {
    privacy.__resetPowerShellWarmupForTests();
    const shell = simulatePowerShell({ warmup });
    try {
      const result = await protectFresh();
      expect(result.error).toBeNull();
      expect(shell.launches.map(launch => launch.kind)).toEqual(['warmup', 'protection']);
    } finally { shell.restore(); }
  });
}

test('a protection timeout after the warm-up stays final: one launch, no retry', async () => {
  privacy.__resetPowerShellWarmupForTests();
  const shell = simulatePowerShell({ protection: 'timeout' });
  try {
    const result = await protectFresh();
    expect(shell.launches.map(launch => launch.kind)).toEqual(['warmup', 'protection']);
    expect(result.error).toMatchObject({ code: 'private_backup_protection_timeout' });
  } finally { shell.restore(); }
});

// security-regressions (windows-latest, Bun 1.4.0) on #7409: the round trip failed after 46,063 ms, the warm-up's 30 s
// bound plus the protection launch's 15 s, and reported the destination's permissions.
test('a 50 s cold start outlasts both bounds and is reported as a PowerShell timeout, not a permissions refusal', async () => {
  privacy.__resetPowerShellWarmupForTests();
  const shell = simulatePowerShell({ coldMs: 50_000 });
  try {
    const result = await protectFresh();
    expect(shell.launches.map(launch => launch.kind)).toEqual(['warmup', 'protection']);
    expect(result.error).toMatchObject({ code: 'private_backup_protection_timeout' });
    expect((result.error as Error).message).toContain('did not start within 15 seconds');
  } finally { shell.restore(); }
});

test('a protection launch that fails without a timeout still reports the destination refusal', async () => {
  privacy.__resetPowerShellWarmupForTests();
  const shell = simulatePowerShell({ protection: 'error' });
  try {
    const result = await protectFresh();
    expect(result.error).toMatchObject({ code: 'private_backup_path_unavailable' });
  } finally { shell.restore(); }
});
