import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setPrivatePathRunnerForTests, protectNewBackupPath, withColdStartRetry } from '../src/core/backup/private-path.ts';

// A PowerShell cold start can outrun the 15 s bound on a fresh Windows machine
// (protectNewBackupPath). These cases pin the retry policy on every platform;
// the Windows ACL path itself runs in backup-portability-native.serial.test.ts.
const timedOut = () => Object.assign(new Error('Command failed: powershell.exe'), { killed: true, signal: 'SIGTERM' });

describe('withColdStartRetry', () => {
  test('a run killed by the timeout is retried once and its second result returned', async () => {
    let calls = 0;
    const result = await withColdStartRetry(async () => { calls++; if (calls === 1) throw timedOut(); return 'private'; });
    expect(result).toBe('private');
    expect(calls).toBe(2);
  });

  test('a second timeout is final', async () => {
    let calls = 0;
    await expect(withColdStartRetry(async () => { calls++; throw timedOut(); })).rejects.toMatchObject({ killed: true });
    expect(calls).toBe(2);
  });

  test('any other failure is not retried', async () => {
    for (const failure of [new Error('Access rule mismatch'), new Error('Private path input failed'), Object.assign(new Error('exit 1'), { killed: false, code: 1 }),
      Object.assign(new Error('stdout maxBuffer length exceeded'), { killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })]) {
      let calls = 0;
      await expect(withColdStartRetry(async () => { calls++; throw failure; })).rejects.toBe(failure);
      expect(calls).toBe(1);
    }
  });

  test('a first success runs once', async () => {
    let calls = 0;
    expect(await withColdStartRetry(async () => { calls++; return 'private'; })).toBe('private');
    expect(calls).toBe(1);
  });
});

// Forced probe through protectNewBackupPath itself: the platform reads as
// win32 and the PowerShell runner is replaced, so the first launch is killed
// by the 15 s bound (as a cold start is) and the second answers.
describe('protectNewBackupPath on a cold Windows start', () => {
  const realPlatform = process.platform;
  const dirs: string[] = [];
  const asWindows = () => Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    __setPrivatePathRunnerForTests();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const emptyDir = () => { const d = mkdtempSync(join(tmpdir(), 'gbrain-private-path-')); dirs.push(d); return d; };

  test('a first launch killed by the timeout is retried and the path is protected', async () => {
    const dir = emptyDir();
    let launches = 0;
    __setPrivatePathRunnerForTests(async () => { launches++; if (launches === 1) throw timedOut(); return 'private'; });
    asWindows();
    await protectNewBackupPath(dir, 'directory');
    expect(launches).toBe(2);
  });

  test('two timeouts still refuse with private_backup_path_unavailable', async () => {
    const dir = emptyDir();
    let launches = 0;
    __setPrivatePathRunnerForTests(async () => { launches++; throw timedOut(); });
    asWindows();
    await expect(protectNewBackupPath(dir, 'directory')).rejects.toMatchObject({ code: 'private_backup_path_unavailable' });
    expect(launches).toBe(2);
  });

  test('a failed ACL check is not retried', async () => {
    const dir = emptyDir();
    let launches = 0;
    __setPrivatePathRunnerForTests(async () => { launches++; throw new Error('Access rule mismatch'); });
    asWindows();
    await expect(protectNewBackupPath(dir, 'directory')).rejects.toMatchObject({ code: 'private_backup_path_unavailable' });
    expect(launches).toBe(1);
  });
});
