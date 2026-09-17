import { afterEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireNativeLock, nativeLockCapability, NativeLockUnavailableError, tryAcquireNativeLock, type NativeLockHandle } from '../src/core/persistence/native-lock.ts';
import { waitFor } from './helpers/wait-for.ts';

const roots: string[] = [];
const locks: NativeLockHandle[] = [];
const children: ReturnType<typeof spawnHolder>[] = [];
const fixture = resolve(import.meta.dir, 'fixtures/native-lock-process.ts');
function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-native-lock-'));
  roots.push(root);
  return root;
}
function spawnHolder(path: string, result: string, start?: string) {
  return Bun.spawn([process.execPath, '--no-env-file', fixture, path, result, ...(start ? [start] : [])], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, TEMP: process.env.TEMP, TMP: process.env.TMP },
  });
}
async function holder(path: string, result: string) {
  const child = spawnHolder(path, result);
  children.push(child);
  await waitFor(() => existsSync(result) || child.exitCode !== null, { timeoutMs: 15000, intervalMs: 10 });
  if (!existsSync(result)) throw new Error(`Lock child failed: ${await new Response(child.stderr).text()}`);
  expect(readFileSync(result, 'utf8')).toBe('acquired');
  return child;
}
async function track(path: string): Promise<NativeLockHandle> {
  const lock = await tryAcquireNativeLock(path);
  expect(lock).not.toBeNull();
  locks.push(lock!);
  return lock!;
}
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill(9);
    await child.exited;
  }
  for (const lock of locks.splice(0)) await lock.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native writer locks', () => {
  test('loads the genuine platform addon and retains the lock inode across release', async () => {
    expect((await nativeLockCapability()).napi).toBe(3);
    const path = join(temporary(), 'space ünicode', 'writer.lock');
    const first = await track(path);
    const inode = statSync(path).ino;
    expect(await tryAcquireNativeLock(path)).toBeNull();
    await first.release();
    await first.release();
    expect(first.released).toBe(true);
    expect(existsSync(path)).toBe(true);
    await track(path);
    expect(statSync(path).ino).toBe(inode);
  });

  test('two synchronized processes elect one holder', async () => {
    const root = temporary(), path = join(root, 'writer.lock'), start = join(root, 'start');
    const outcomes = ['a', 'b'].map(name => join(root, name));
    for (const result of outcomes) children.push(spawnHolder(path, result, start));
    await waitFor(() => outcomes.every(result => existsSync(`${result}.ready`)), { timeoutMs: 15000, intervalMs: 10 });
    writeFileSync(start, 'start');
    await waitFor(() => outcomes.every(existsSync), { timeoutMs: 15000, intervalMs: 10 });
    expect(outcomes.map(result => readFileSync(result, 'utf8')).sort()).toEqual(['acquired', 'busy']);
    expect(await tryAcquireNativeLock(path)).toBeNull();
  });

  test('a live process cannot be stolen by aging the file; SIGKILL releases immediately', async () => {
    const root = temporary(), path = join(root, 'writer.lock');
    const child = await holder(path, join(root, 'held'));
    const old = new Date(0);
    utimesSync(path, old, old);
    expect(await acquireNativeLock(path, { timeoutMs: 50, pollMs: 10 })).toBeNull();
    child.kill(9);
    await child.exited;
    await track(path);
  });

  test('a waiter completes after a real process explicitly releases', async () => {
    const root = temporary(), path = join(root, 'writer.lock');
    const child = await holder(path, join(root, 'held'));
    const waiting = acquireNativeLock(path, { timeoutMs: 5000 });
    child.stdin.write('release\n');
    child.stdin.end();
    const lock = await waiting;
    expect(lock).not.toBeNull();
    locks.push(lock!);
    expect(await child.exited).toBe(0);
  });

  test('aborted and timed-out waiters close their handles without releasing the owner', async () => {
    const path = join(temporary(), 'writer.lock');
    const owner = await track(path);
    const signal = new AbortController();
    const pending = acquireNativeLock(path, { timeoutMs: 10000, pollMs: 10, signal: signal.signal });
    signal.abort(new Error('cancel fixture'));
    await expect(pending).rejects.toThrow();
    expect(await acquireNativeLock(path, { timeoutMs: 10 })).toBeNull();
    await owner.release();
    await track(path);
  });

  test('invalid paths, unsupported durations, and nonregular files fail closed', async () => {
    await expect(acquireNativeLock('relative.lock')).rejects.toThrow(TypeError);
    await expect(acquireNativeLock(join(temporary(), 'nul\0.lock'))).rejects.toThrow(TypeError);
    await expect(acquireNativeLock(join(temporary(), 'x'), { timeoutMs: Infinity })).rejects.toThrow(RangeError);
    await expect(tryAcquireNativeLock(temporary())).rejects.toBeInstanceOf(NativeLockUnavailableError);
  });

  test('missing native assets allow module import but refuse capability and writes', async () => {
    const root = temporary(), destination = join(root, 'src/core/persistence');
    mkdirSync(destination, { recursive: true });
    cpSync(resolve(import.meta.dir, '../src/core/persistence/native-lock.ts'), join(destination, 'native-lock.ts'));
    cpSync(dirname(require.resolve('detect-libc/package.json')), join(root, 'node_modules/detect-libc'), { recursive: true });
    const program = `
      const api = await import(process.argv[1]);
      console.log('imported');
      try { await api.tryAcquireNativeLock(process.argv[2]); process.exit(2); }
      catch (error) { if (error.code !== 'writer_lock_unavailable') throw error; }
    `;
    const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', program, join(destination, 'native-lock.ts'), join(root, 'writer.lock')], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    expect(await child.exited).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe('imported');
    expect(existsSync(join(root, 'writer.lock'))).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('refuses a lock-file symlink', async () => {
    const root = temporary(), target = join(root, 'target'), link = join(root, 'link');
    writeFileSync(target, 'preserved');
    symlinkSync(target, link);
    await expect(tryAcquireNativeLock(link)).rejects.toBeInstanceOf(NativeLockUnavailableError);
    expect(readFileSync(target, 'utf8')).toBe('preserved');
  });
});
