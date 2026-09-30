import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync, readlinkSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, releaseLock, peekLock, inspectLockHolder, getPgliteKernelLockPath,
  isProcessAlive, msSinceLastReap, LiveServeLockError, PgliteBusyError, type LockHandle } from '../src/core/pglite-lock.ts';

const roots: string[] = [], locks: LockHandle[] = [], children: Bun.Subprocess[] = [];
function temporary(): string { const root = mkdtempSync(join(tmpdir(), 'gbrain-pglite-kernel-')); roots.push(root); return root; }
async function take(path?: string): Promise<LockHandle> { const lock = await acquireLock(path, { timeoutMs: 100 }); locks.push(lock); return lock; }
async function holder(root: string, command = 'other') {
  const dataDir = join(root, 'store'), ready = join(root, 'ready');
  const child = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, 'fixtures/pglite-lock-process.ts'), dataDir, ready, command], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  children.push(child);
  const deadline = performance.now() + 5000;
  while (!existsSync(ready) && child.exitCode === null && performance.now() < deadline) await delay(5);
  if (!existsSync(ready)) throw new Error('lock fixture failed to become ready');
  return child;
}
afterEach(async () => {
  for (const lock of locks.splice(0)) await releaseLock(lock);
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill(9); await child.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PGLite datastore kernel ownership', () => {
  test('in-memory access requires no kernel lock', async () => {
    const lock = await take();
    expect(lock.acquired).toBe(true);
    expect(lock.lockDir).toBe('');
    expect(lock.nativeLock).toBeUndefined();
  });
  test('retains the sibling inode and preserves diagnostic metadata', async () => {
    const dataDir = join(temporary(), 'store');
    const lock = await take(dataDir), kernel = getPgliteKernelLockPath(dataDir)!;
    expect(kernel.startsWith(dataDir + '/')).toBe(false);
    const inode = statSync(kernel).ino;
    const metadata = JSON.parse(readFileSync(lock.lockPath!, 'utf8'));
    expect(metadata.pid).toBe(process.pid);
    expect(metadata.argv).toEqual(process.argv.slice(1));
    expect(metadata.owner_token).toBe(lock.ownerToken);
    expect(metadata.protocol).toBe('kernel-v1');
    expect(inspectLockHolder(dataDir).held).toBe(true);
    await releaseLock(lock);
    await releaseLock(lock);
    expect(existsSync(lock.lockDir)).toBe(false);
    await take(dataDir);
    expect(statSync(kernel).ino).toBe(inode);
  });
  test('same-process contenders cannot open a second datastore handle', async () => {
    const path = join(temporary(), 'store');
    await take(path);
    await expect(acquireLock(path, { timeoutMs: 30 })).rejects.toBeInstanceOf(PgliteBusyError);
  });
  test('metadata corruption and stale age cannot steal a paused process; death releases ownership', async () => {
    const root = temporary(), dataDir = join(root, 'store');
    const child = await holder(root);
    if (process.platform !== 'win32') child.kill('SIGSTOP');
    writeFileSync(join(dataDir, '.gbrain-lock/lock'), '{corrupt');
    await expect(acquireLock(dataDir, { timeoutMs: 40 })).rejects.toBeInstanceOf(PgliteBusyError);
    child.kill(9); await child.exited;
    const successor = await take(dataDir);
    expect(successor.reaped).toBe(false); // kernel proof, independent of metadata
  });
  test('a dead or reused diagnostic PID cannot override the live kernel owner', async () => {
    const root = temporary(), dataDir = join(root, 'store');
    const child = await holder(root);
    const metadataPath = join(dataDir, '.gbrain-lock/lock');
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
    for (const pid of [99999999, process.pid]) {
      writeFileSync(metadataPath, JSON.stringify({ ...metadata, pid, refreshed_at: 1,
        command: 'unrelated-program', argv: ['/unrelated/program'], subcommand: 'other' }));
      await expect(acquireLock(dataDir, { timeoutMs: 30 })).rejects.toBeInstanceOf(PgliteBusyError);
      expect(JSON.parse(readFileSync(metadataPath, 'utf8')).owner_token).toBe(metadata.owner_token);
    }
    child.kill(9); await child.exited;
    expect((await take(dataDir)).acquired).toBe(true);
  });
  test('datastore replacement cannot replace the ownership inode', async () => {
    const root = temporary(), dataDir = join(root, 'store');
    const lock = await take(dataDir);
    renameSync(dataDir, join(root, 'previous-store'));
    mkdirSync(dataDir);
    await expect(acquireLock(dataDir, { timeoutMs: 30 })).rejects.toBeInstanceOf(PgliteBusyError);
    await releaseLock(lock);
    await take(dataDir);
  });
  test('a stale handle cannot remove successor metadata or unlock it', async () => {
    const dataDir = join(temporary(), 'store');
    const first = await take(dataDir), stale = { ...first };
    await releaseLock(first);
    const successor = await take(dataDir);
    await releaseLock(stale);
    expect(JSON.parse(readFileSync(successor.lockPath!, 'utf8')).owner_token).toBe(successor.ownerToken);
    await expect(acquireLock(dataDir, { timeoutMs: 30 })).rejects.toBeInstanceOf(PgliteBusyError);
  });
  test('live serve metadata remains available for engine-free IPC routing', async () => {
    const root = temporary(), dataDir = join(root, 'store');
    const child = await holder(root, 'serve');
    expect(inspectLockHolder(dataDir)).toEqual({ held: true, pid: child.pid, serve: true, subcommand: 'serve' });
    expect(peekLock(dataDir).isServe).toBe(true);
    await expect(acquireLock(dataDir, { timeoutMs: 30 })).rejects.toBeInstanceOf(LiveServeLockError);
  });
  test('read-only probes create nothing and treat unknown metadata conservatively', () => {
    const root = temporary(), dataDir = join(root, 'missing');
    expect(inspectLockHolder(dataDir).held).toBe(false);
    expect(peekLock(undefined).held).toBe(false);
    expect(existsSync(dataDir)).toBe(false);
    mkdirSync(join(dataDir, '.gbrain-lock'), { recursive: true });
    writeFileSync(join(dataDir, '.gbrain-lock/lock'), '{corrupt');
    expect(inspectLockHolder(dataDir).held).toBe(true);
    expect(peekLock(dataDir).held).toBe(true);
  });
  test.each(['live', 'corrupt', 'missing'])('refuses ambiguous %s legacy ownership instead of TTL reaping', async mode => {
    const dataDir = join(temporary(), 'store'), dir = join(dataDir, '.gbrain-lock');
    mkdirSync(dir, { recursive: true });
    if (mode !== 'missing') writeFileSync(join(dir, 'lock'), mode === 'corrupt' ? '{corrupt' : JSON.stringify({ pid: process.pid, acquired_at: 1, refreshed_at: 1 }));
    await expect(acquireLock(dataDir, { timeoutMs: 30 })).rejects.toBeInstanceOf(PgliteBusyError);
    expect(existsSync(dir)).toBe(true);
  });
  test.each(['/Users/Example User/project/src/cli.ts', 'C:\\Users\\Example User\\project\\src\\CLI.TS'])(
    'structured legacy argv preserves serve diagnostics for %s without authorizing takeover', async script => {
      const dataDir = join(temporary(), 'store'), dir = join(dataDir, '.gbrain-lock');
      mkdirSync(dir, { recursive: true });
      const metadata = { pid: process.pid, command: `${script} serve --http`,
        argv: [script, 'serve', '--http'], subcommand: 'serve', acquired_at: 1, refreshed_at: 1 };
      writeFileSync(join(dir, 'lock'), JSON.stringify(metadata));
      expect(inspectLockHolder(dataDir)).toEqual({ held: true, pid: process.pid, serve: true, subcommand: 'serve' });
      await expect(acquireLock(dataDir, { timeoutMs: 30 })).rejects.toBeInstanceOf(LiveServeLockError);
      expect(JSON.parse(readFileSync(join(dir, 'lock'), 'utf8'))).toEqual(metadata);
    });
  test('legacy death migration requires same namespace proof and quarantines repair once', async () => {
    const dataDir = join(temporary(), 'store'), dir = join(dataDir, '.gbrain-lock');
    mkdirSync(dir, { recursive: true });
    const metadata = { pid: 99999999, acquired_at: 1,
      pid_ns: process.platform === 'linux' ? readlinkSync('/proc/self/ns/pid') : null,
      boot_id: process.platform === 'linux' ? readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() : null };
    writeFileSync(join(dir, 'lock'), JSON.stringify(metadata));
    const migrated = await take(dataDir);
    expect(migrated.reaped).toBe(true);
    await releaseLock(migrated);
    expect((await take(dataDir)).reaped).toBe(false);
  });
  test('retains older repair quarantine markers', () => {
    const dataDir = join(temporary(), 'store');
    expect(msSinceLastReap(dataDir)).toBeNull();
    writeFileSync(`${dataDir}.lock-reap.json`, JSON.stringify({ ts: Date.now() - 1000 }));
    expect(msSinceLastReap(dataDir)).toBeGreaterThanOrEqual(1000);
  });
  test('invalid PIDs are unknown/alive and a provably absent PID is dead', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(NaN)).toBe(true);
    expect(isProcessAlive(-1)).toBe(true);
    expect(isProcessAlive(99999999)).toBe(false);
  });
  test.skipIf(process.platform === 'win32')('canonicalizes symlink aliases to the same kernel file', async () => {
    const root = temporary(), original = join(root, 'store'), alias = join(root, 'alias');
    mkdirSync(original); symlinkSync(original, alias);
    await take(original);
    expect(getPgliteKernelLockPath(alias)).toBe(getPgliteKernelLockPath(original));
    await expect(acquireLock(alias, { timeoutMs: 30 })).rejects.toBeInstanceOf(PgliteBusyError);
  });
});
