import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  acquireLock,
  releaseLock,
  writeLockFixture,
  lockDirExists,
  readLockMetadata,
  listArchivedLocks,
  inspectLock,
  previousOwnerConfirmedDeadFromLock,
  clearReapMarker,
  pruneArchivedLocks,
  LOCK_ARCHIVE_RETENTION_MS,
  LOCK_ARCHIVE_KEEP_NEWEST,
  setDefaultProcessInspector,
} from '../src/core/pglite-lock.ts';
import { FakeProcessInspector } from '../src/core/pglite-process-inspector.ts';
import { DatabaseAlreadyOwnedError } from '../src/core/pglite-errors.ts';
import {
  classifySidecarStartupError,
  PgliteOpenError,
  SidecarExitedBeforeHealthyError,
} from '../src/core/pglite-errors.ts';

const TEST_DIR = join(tmpdir(), 'gbrain-lock-test-' + process.pid + '-' + Date.now());

describe('pglite-lock v2', () => {
  let inspector: FakeProcessInspector;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    inspector = new FakeProcessInspector({ bootMarker: 'boot-current' });
    inspector.setProcess(process.pid, {
      exists: true,
      startTime: 'start-self',
      executablePath: process.execPath,
    });
    setDefaultProcessInspector(inspector);
  });

  afterEach(async () => {
    setDefaultProcessInspector(null);
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test('1. acquires lock atomically when absent', async () => {
    const lock = await acquireLock(TEST_DIR, { inspector, ownerType: 'test' });
    expect(lock.acquired).toBe(true);
    expect(lock.ownerToken).toBeTruthy();
    expect(lockDirExists(TEST_DIR)).toBe(true);
    const meta = readLockMetadata(TEST_DIR);
    expect(meta?.schemaVersion).toBe(2);
    expect(meta?.pid).toBe(process.pid);
    expect(meta?.bootMarker).toBe('boot-current');
    expect(meta?.ownerType).toBe('test');
    await releaseLock(lock);
    expect(lockDirExists(TEST_DIR)).toBe(false);
  });

  test('路径被普通文件占用时明确提示并保留原文件，不创建锁或改用其他数据库', async () => {
    const path = join(TEST_DIR, 'brain.pglite');
    const original = Buffer.from('Unknown existing file must remain byte-for-byte intact.');
    writeFileSync(path, original);
    let failure: unknown;
    try { await acquireLock(path, { inspector, ownerType: 'test' }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PgliteOpenError);
    expect((failure as Error).message).toContain('普通文件');
    expect((failure as Error).message).toContain('修改配置');
    expect((failure as PgliteOpenError).databasePath).toBe(path);
    expect(classifySidecarStartupError(failure)).toMatchObject({ category: 'database_open_failed', retryable: false });
    expect(readFileSync(path)).toEqual(original);
    expect(readdirSync(TEST_DIR)).toEqual(['brain.pglite']);
  });

  test('父路径被文件占用时指出具体冲突位置，不创建任何目录', async () => {
    const parent = join(TEST_DIR, 'parent-file');
    writeFileSync(parent, 'Retain parent file.');
    let failure: unknown;
    try { await acquireLock(join(parent, 'nested', 'brain.pglite'), { inspector, ownerType: 'test' }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(PgliteOpenError);
    expect((failure as Error).message).toContain('父路径');
    expect((failure as Error).message).toContain(parent);
    expect(readFileSync(parent, 'utf8')).toBe('Retain parent file.');
    expect(readdirSync(TEST_DIR)).toEqual(['parent-file']);
  });

  test('2. second process cannot acquire the same lock while owner is active', async () => {
    const lock1 = await acquireLock(TEST_DIR, { inspector, ownerType: 'desktop-sidecar', timeoutMs: 500 });
    await expect(
      acquireLock(TEST_DIR, { inspector, ownerType: 'cli', timeoutMs: 300, failFastIfOwned: true }),
    ).rejects.toBeInstanceOf(DatabaseAlreadyOwnedError);
    await releaseLock(lock1);
  });

  test('live serve owner rejects a queued contender immediately and keeps its lock', async () => {
    const ownerPid = 555000;
    writeLockFixture(TEST_DIR, {
      schemaVersion: 2,
      pid: ownerPid,
      processStartTime: 'serve-start',
      bootMarker: 'boot-current',
      ownerToken: 'serve-owner',
      ownerType: 'desktop-sidecar',
      databasePath: TEST_DIR,
      executablePath: 'D:\\Apps\\PMBrain\\bun.exe',
      command: 'D:\\Apps\\PMBrain\\pmbrain-sidecar.js serve --http',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    inspector.setProcess(ownerPid, {
      exists: true,
      startTime: 'serve-start',
      executablePath: 'D:\\Apps\\PMBrain\\bun.exe',
    });

    const startedAt = Date.now();
    await expect(
      acquireLock(TEST_DIR, { inspector, ownerType: 'cli', timeoutMs: 2_000 }),
    ).rejects.toBeInstanceOf(DatabaseAlreadyOwnedError);
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(readLockMetadata(TEST_DIR)?.ownerToken).toBe('serve-owner');
    expect(listArchivedLocks(TEST_DIR)).toHaveLength(0);
  });

  test('short-lived CLI owner still hands off serially after it exits', async () => {
    const ownerPid = 555009;
    writeLockFixture(TEST_DIR, {
      schemaVersion: 2,
      pid: ownerPid,
      processStartTime: 'cli-start',
      bootMarker: 'boot-current',
      ownerToken: 'cli-owner',
      // Packaged one-shot commands historically inherited this broad label;
      // the recorded subcommand must take precedence and keep them waitable.
      ownerType: 'desktop-sidecar',
      subcommand: 'dream',
      databasePath: TEST_DIR,
      executablePath: 'D:\\Apps\\PMBrain\\bun.exe',
      command: 'D:\\Apps\\PMBrain\\pmbrain-sidecar.js dream --preset quick',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    inspector.setProcess(ownerPid, {
      exists: true,
      startTime: 'cli-start',
      executablePath: 'D:\\Apps\\PMBrain\\bun.exe',
    });
    setTimeout(() => inspector.clearProcess(ownerPid), 20);

    const lock = await acquireLock(TEST_DIR, {
      inspector,
      ownerType: 'desktop-sidecar',
      timeoutMs: 1_500,
    });
    expect(lock.acquired).toBe(true);
    expect(readLockMetadata(TEST_DIR)?.ownerToken).toBe(lock.ownerToken);
    expect(listArchivedLocks(TEST_DIR).some(path => path.includes('pid_not_running'))).toBe(true);
    await releaseLock(lock);
  });

  test('3. archives lock when PID does not exist', async () => {
    writeLockFixture(TEST_DIR, {
      schemaVersion: 2,
      pid: 999999991,
      processStartTime: 'old',
      bootMarker: 'boot-current',
      ownerToken: 'dead-token',
      ownerType: 'desktop-sidecar',
      databasePath: TEST_DIR,
      executablePath: 'C:\\fake\\pmbrain-sidecar.exe',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    inspector.clearProcess(999999991);

    const lock = await acquireLock(TEST_DIR, { inspector, ownerType: 'cli' });
    expect(lock.acquired).toBe(true);
    expect(lock.diagnostics?.reason).toMatch(/pid_not_running|after_pid/);
    expect(previousOwnerConfirmedDeadFromLock(lock)).toBe(true);
    const archives = listArchivedLocks(TEST_DIR);
    expect(archives.some((p) => p.includes('.stale-') && p.includes('pid_not_running'))).toBe(true);
    await releaseLock(lock);
  });

  test('4. archives lock from previous bootMarker', async () => {
    writeLockFixture(TEST_DIR, {
      schemaVersion: 2,
      pid: 12345,
      processStartTime: 't1',
      bootMarker: 'boot-previous',
      ownerToken: 'old',
      ownerType: 'desktop-sidecar',
      databasePath: TEST_DIR,
      executablePath: 'C:\\Windows\\System32\\notepad.exe',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    inspector.setProcess(12345, { exists: true, startTime: 't1', executablePath: 'C:\\Windows\\System32\\notepad.exe' });

    const lock = await acquireLock(TEST_DIR, { inspector });
    expect(lock.acquired).toBe(true);
    expect(listArchivedLocks(TEST_DIR).some((p) => p.includes('previous_system_boot'))).toBe(true);
    expect(previousOwnerConfirmedDeadFromLock(lock)).toBe(true);
    await releaseLock(lock);
  });

  test('clearReapMarker removes the sibling quarantine file', () => {
    const marker = `${TEST_DIR}.lock-reap.json`;
    writeFileSync(marker, JSON.stringify({ ts: Date.now(), by: 1 }));
    clearReapMarker(TEST_DIR);
    expect(existsSync(marker)).toBe(false);
  });

  test('previousOwnerConfirmedDeadFromLock is true only after a dead PID or previous boot reap', () => {
    expect(previousOwnerConfirmedDeadFromLock(undefined)).toBe(false);
    expect(previousOwnerConfirmedDeadFromLock({
      reaped: true,
      diagnostics: { reason: 'after_pid_not_running' } as never,
    })).toBe(true);
    expect(previousOwnerConfirmedDeadFromLock({
      reaped: true,
      diagnostics: { reason: 'after_corrupt_lock' } as never,
    })).toBe(false);
    expect(previousOwnerConfirmedDeadFromLock({
      reaped: false,
      diagnostics: { reason: 'after_pid_not_running' } as never,
    })).toBe(false);
  });

  test('5. detects PID reuse via processStartTime mismatch', async () => {
    writeLockFixture(TEST_DIR, {
      schemaVersion: 2,
      pid: 4242,
      processStartTime: 'start-original',
      bootMarker: 'boot-current',
      ownerToken: 'token-a',
      ownerType: 'desktop-sidecar',
      databasePath: TEST_DIR,
      executablePath: 'C:\\pmbrain\\pmbrain-sidecar.exe',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    inspector.setProcess(4242, {
      exists: true,
      startTime: 'start-reused',
      executablePath: 'C:\\pmbrain\\pmbrain-sidecar.exe',
    });

    const lock = await acquireLock(TEST_DIR, { inspector });
    expect(lock.acquired).toBe(true);
    expect(listArchivedLocks(TEST_DIR).some((p) => p.includes('pid_reused'))).toBe(true);
    await releaseLock(lock);
  });

  test('6. archives when PID exists but executable is not PMBrain', async () => {
    writeLockFixture(TEST_DIR, {
      schemaVersion: 2,
      pid: 7777,
      processStartTime: null,
      bootMarker: 'boot-current',
      ownerToken: 'x',
      ownerType: 'desktop-sidecar',
      databasePath: TEST_DIR,
      executablePath: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    inspector.setProcess(7777, {
      exists: true,
      startTime: null,
      executablePath: 'C:\\Windows\\System32\\svchost.exe',
    });

    const lock = await acquireLock(TEST_DIR, { inspector });
    expect(lock.acquired).toBe(true);
    expect(listArchivedLocks(TEST_DIR).some((p) => p.includes('executable_not_pmbrain') || p.includes('executable_path'))).toBe(true);
    await releaseLock(lock);
  });

  test('7. truly active sidecar lock is not stolen', async () => {
    const ownerPid = 555001;
    writeLockFixture(TEST_DIR, {
      schemaVersion: 2,
      pid: ownerPid,
      processStartTime: 'start-live',
      bootMarker: 'boot-current',
      ownerToken: 'live-token',
      ownerType: 'desktop-sidecar',
      databasePath: TEST_DIR,
      executablePath: 'D:\\Apps\\PMBrain\\pmbrain-sidecar.exe',
      createdAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
      updatedAt: new Date().toISOString(),
    });
    inspector.setProcess(ownerPid, {
      exists: true,
      startTime: 'start-live',
      executablePath: 'D:\\Apps\\PMBrain\\pmbrain-sidecar.exe',
    });

    await expect(
      acquireLock(TEST_DIR, { inspector, timeoutMs: 200, failFastIfOwned: true }),
    ).rejects.toBeInstanceOf(DatabaseAlreadyOwnedError);
    expect(lockDirExists(TEST_DIR)).toBe(true);
    expect(readLockMetadata(TEST_DIR)?.ownerToken).toBe('live-token');
  });

  test('8. lock older than five minutes with valid owner is never deleted', async () => {
    const ownerPid = 555002;
    writeLockFixture(TEST_DIR, {
      schemaVersion: 2,
      pid: ownerPid,
      processStartTime: 'start-old',
      bootMarker: 'boot-current',
      ownerToken: 'old-but-live',
      ownerType: 'desktop-sidecar',
      databasePath: TEST_DIR,
      executablePath: join('C:', 'pmbrain', 'bun.exe'),
      createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      acquired_at: Date.now() - 60 * 60 * 1000,
    });
    inspector.setProcess(ownerPid, {
      exists: true,
      startTime: 'start-old',
      executablePath: join('C:', 'pmbrain', 'bun.exe'),
    });

    await expect(
      acquireLock(TEST_DIR, { inspector, timeoutMs: 150, failFastIfOwned: true }),
    ).rejects.toBeInstanceOf(DatabaseAlreadyOwnedError);
    expect(lockDirExists(TEST_DIR)).toBe(true);
    expect(listArchivedLocks(TEST_DIR).length).toBe(0);
  });

  test('9. corrupt lock metadata is archived not permanently deleted', async () => {
    const lockDir = join(TEST_DIR, '.gbrain-lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'lock'), '{not-json');

    const lock = await acquireLock(TEST_DIR, { inspector });
    expect(lock.acquired).toBe(true);
    const archives = listArchivedLocks(TEST_DIR);
    expect(archives.some((p) => p.includes('corrupt') || p.includes('missing') || existsSync(p))).toBe(true);
    // Original path no longer active; archive retained.
    expect(archives.length).toBeGreaterThan(0);
    await releaseLock(lock);
  });

  test('10. only matching ownerToken can release lock', async () => {
    const lock = await acquireLock(TEST_DIR, { inspector, ownerType: 'cli' });
    const fake = { ...lock, ownerToken: 'wrong-token' };
    await releaseLock(fake);
    expect(lockDirExists(TEST_DIR)).toBe(true);
    await releaseLock(lock);
    expect(lockDirExists(TEST_DIR)).toBe(false);
  });

  test('11. old process cannot delete lock created by new process', async () => {
    const first = await acquireLock(TEST_DIR, { inspector, ownerType: 'cli' });
    // Simulate takeover only after first is "stale" — but release with stale token must no-op
    // after we manually swap tokens on disk by re-acquiring after force archive.
    await releaseLock(first);

    const second = await acquireLock(TEST_DIR, { inspector, ownerType: 'desktop-sidecar' });
    const staleHandle = {
      lockDir: second.lockDir,
      acquired: true,
      ownerToken: first.ownerToken,
    };
    await releaseLock(staleHandle);
    expect(lockDirExists(TEST_DIR)).toBe(true);
    expect(readLockMetadata(TEST_DIR)?.ownerToken).toBe(second.ownerToken);
    await releaseLock(second);
  });

  test('12. concurrent acquire: only one succeeds', async () => {
    const results = await Promise.allSettled([
      acquireLock(TEST_DIR, { inspector, ownerType: 'cli', timeoutMs: 2_000, failFastIfOwned: true }),
      acquireLock(TEST_DIR, { inspector, ownerType: 'cli', timeoutMs: 2_000, failFastIfOwned: true }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireLock>>>[];
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    await releaseLock(fulfilled[0].value);
  });

  test('14. release after acquire removes active lock directory', async () => {
    const lock = await acquireLock(TEST_DIR, { inspector });
    await releaseLock(lock);
    expect(lockDirExists(TEST_DIR)).toBe(false);
  });

  test('15. residual lock after crash is correctly judged on next start', async () => {
    writeLockFixture(TEST_DIR, {
      schemaVersion: 2,
      pid: 888001,
      processStartTime: 'gone',
      bootMarker: 'boot-current',
      ownerToken: 'crashed',
      ownerType: 'desktop-sidecar',
      databasePath: TEST_DIR,
      executablePath: 'D:\\pmbrain\\pmbrain-sidecar.exe',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // PID no longer exists
    const diag = await inspectLock(TEST_DIR, { inspector });
    expect(diag.decision).toBe('archive_stale_lock');
    expect(diag.reason).toBe('pid_not_running');

    const lock = await acquireLock(TEST_DIR, { inspector });
    expect(lock.acquired).toBe(true);
    await releaseLock(lock);
  });

  test('22. Chinese path metadata read/write', async () => {
    const chineseDir = join(TEST_DIR, '用户数据', '知识库');
    mkdirSync(chineseDir, { recursive: true });
    const lock = await acquireLock(chineseDir, { inspector, ownerType: 'cli' });
    const meta = readLockMetadata(chineseDir);
    expect(meta?.databasePath).toContain('知识库');
    expect(meta?.schemaVersion).toBe(2);
    await releaseLock(lock);
  });

  test('creates missing data directory before acquiring lock', async () => {
    const missing = join(TEST_DIR, 'missing-data-dir');
    const lock = await acquireLock(missing, { inspector });
    expect(existsSync(missing)).toBe(true);
    await releaseLock(lock);
  });

  test('release archives remain unique when two owners finish in one second', async () => {
    const first = await acquireLock(TEST_DIR, { inspector, ownerType: 'migration' });
    await releaseLock(first);
    const second = await acquireLock(TEST_DIR, { inspector, ownerType: 'migration' });
    await releaseLock(second);

    expect(lockDirExists(TEST_DIR)).toBe(false);
    const released = listArchivedLocks(TEST_DIR).filter((path) => path.includes('.released-'));
    expect(new Set(released).size).toBe(2);
  });

  test('skips lock for in-memory undefined dataDir', async () => {
    const lock = await acquireLock(undefined, { inspector });
    expect(lock.acquired).toBe(true);
    expect(lock.lockDir).toBe('');
    await releaseLock(lock);
  });

  test('legacy lock with dead PID is archived', async () => {
    writeLockFixture(TEST_DIR, {
      pid: 999999992,
      acquired_at: Date.now() - 1000,
      command: 'old-pmbrain',
    });
    const lock = await acquireLock(TEST_DIR, { inspector });
    expect(lock.acquired).toBe(true);
    await releaseLock(lock);
  });

  test('prunes lock archives older than 3 days except the newest 5', () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stampAt = (ms: number) => {
      const date = new Date(ms);
      return (
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
        + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
      );
    };
    const now = Date.now();
    const plant = (kind: 'released' | 'stale', ms: number, extra: string) => {
      const dir = join(TEST_DIR, `.gbrain-lock.${kind}-${stampAt(ms)}-${extra}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'lock'), '{}');
      return dir;
    };

    const expired = [
      plant('released', now - LOCK_ARCHIVE_RETENTION_MS - 86_400_000, 'old1'),
      plant('stale', now - LOCK_ARCHIVE_RETENTION_MS - 80_000_000, 'old2'),
    ];
    const floor = [
      plant('released', now - LOCK_ARCHIVE_RETENTION_MS - 70_000_000, 'old3'),
      plant('stale', now - LOCK_ARCHIVE_RETENTION_MS - 60_000_000, 'old4'),
      plant('released', now - LOCK_ARCHIVE_RETENTION_MS - 50_000_000, 'old5'),
      plant('stale', now - LOCK_ARCHIVE_RETENTION_MS - 40_000_000, 'old6'),
      plant('released', now - LOCK_ARCHIVE_RETENTION_MS - 30_000_000, 'old7'),
    ];
    mkdirSync(join(TEST_DIR, '.gbrain-lock'));
    writeFileSync(join(TEST_DIR, '.gbrain-lock', 'lock'), '{"pid":1}');
    writeFileSync(join(TEST_DIR, 'PG_VERSION'), '17\n');

    const result = pruneArchivedLocks(TEST_DIR, now);
    for (const path of expired) expect(existsSync(path)).toBe(false);
    for (const path of floor) expect(existsSync(path)).toBe(true);
    expect(existsSync(join(TEST_DIR, '.gbrain-lock'))).toBe(true);
    expect(existsSync(join(TEST_DIR, 'PG_VERSION'))).toBe(true);
    expect(result.kept).toHaveLength(LOCK_ARCHIVE_KEEP_NEWEST);
    expect(result.deleted).toHaveLength(2);
  });

  test('keeps every lock archive from the last 3 days even when there are more than 5', () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stampAt = (ms: number) => {
      const date = new Date(ms);
      return (
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
        + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
      );
    };
    const now = Date.now();
    const recent = Array.from({ length: 8 }, (_, i) => {
      const dir = join(
        TEST_DIR,
        `.gbrain-lock.released-${stampAt(now - (i + 1) * 3_600_000)}-r${i}`,
      );
      mkdirSync(dir);
      writeFileSync(join(dir, 'lock'), '{}');
      return dir;
    });

    const result = pruneArchivedLocks(TEST_DIR, now);
    expect(result.deleted).toEqual([]);
    for (const path of recent) expect(existsSync(path)).toBe(true);
    expect(result.kept).toHaveLength(8);
  });

  test('acquire and release drop lock archives older than 3 days beyond the newest 5', async () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stampAt = (ms: number) => {
      const date = new Date(ms);
      return (
        `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
        + `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
      );
    };
    const now = Date.now();
    const oldest = join(
      TEST_DIR,
      `.gbrain-lock.stale-${stampAt(now - LOCK_ARCHIVE_RETENTION_MS - 86_400_000)}-oldest`,
    );
    mkdirSync(oldest);
    writeFileSync(join(oldest, 'lock'), '{}');
    for (let i = 0; i < 5; i++) {
      const dir = join(
        TEST_DIR,
        `.gbrain-lock.released-${stampAt(now - LOCK_ARCHIVE_RETENTION_MS - (5 - i) * 3_600_000)}-keep${i}`,
      );
      mkdirSync(dir);
      writeFileSync(join(dir, 'lock'), '{}');
    }

    const lock = await acquireLock(TEST_DIR, { inspector, ownerType: 'test' });
    expect(existsSync(oldest)).toBe(false);
    await releaseLock(lock);
    const leftover = listArchivedLocks(TEST_DIR);
    expect(leftover.some((path) => path.includes('.released-'))).toBe(true);
    expect(leftover.every((path) => !path.includes('-oldest'))).toBe(true);
  });
});

describe('classifySidecarStartupError', () => {
  test('16. DatabaseAlreadyOwnedError is not retryable', () => {
    const err = new DatabaseAlreadyOwnedError({
      databasePath: 'D:/brain.pglite',
      lockPath: 'D:/brain.pglite/.gbrain-lock',
      ownerPid: 1,
      ownerType: 'desktop-sidecar',
    });
    const c = classifySidecarStartupError(err);
    expect(c.category).toBe('database_owned');
    expect(c.retryable).toBe(false);
  });

  test('17. transient network errors remain retryable', () => {
    const c = classifySidecarStartupError(new Error('fetch failed: ECONNREFUSED'));
    expect(c.category).toBe('transient');
    expect(c.retryable).toBe(true);
  });

  test('19. PGlite.create / Aborted is database_open_failed non-retryable', () => {
    const err = new PgliteOpenError('PGLite failed to initialize\nOriginal error: Aborted()', {
      cause: new Error('Aborted()'),
    });
    const c = classifySidecarStartupError(err);
    expect(c.category).toBe('database_open_failed');
    expect(c.retryable).toBe(false);
    expect(err.cause).toBeInstanceOf(Error);
  });

  test('18. sidecar exited before healthy is classified from message', () => {
    const err = new SidecarExitedBeforeHealthyError({
      message: 'Sidecar exited (code 1). DatabaseAlreadyOwnedError',
      exitCode: 1,
      category: 'database_owned',
    });
    const c = classifySidecarStartupError(err);
    expect(c.retryable).toBe(false);
    expect(c.category).toBe('database_owned');
  });

  test('port conflict is retryable', () => {
    const c = classifySidecarStartupError(new Error('listen EADDRINUSE: address already in use'));
    expect(c.category).toBe('port_conflict');
    expect(c.retryable).toBe(true);
  });

  test('GIN index repair failure is not retryable and is not a whole-database restore', () => {
    const c = classifySidecarStartupError(new Error('搜索索引修复失败，无法确认搜索已恢复。'));
    expect(c.retryable).toBe(false);
    expect(c.labelZh).toBe('搜索索引修复失败');
  });

  test('toast corruption is not WAL recovery and is not retryable', () => {
    const c = classifySidecarStartupError(
      new Error('unexpected chunk number 3 (expected 0) for toast value 191139 in pg_toast_16852'),
    );
    expect(c.retryable).toBe(false);
    expect(c.category).toBe('toast_corrupt');
    expect(c.labelZh).toContain('不会继续自动重置 WAL');
  });
});
