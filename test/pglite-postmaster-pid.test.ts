import { expect, test } from 'bun:test';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearPgliteDataDirReadonly, clearStalePglitePostmasterPid } from '../src/core/pglite-lock.ts';
import { assertPgliteDataDirLockWritable, createPgliteDatabase } from '../src/core/pglite-open.ts';
import { openVerifiedRestoreCopy } from '../src/core/pglite-upgrade-backup.ts';
import { PG_CONTROL_FILE_SIZE } from '../src/core/pglite-resetwal.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pmbrain-postmaster-'));
}

function hasWriteBit(target: string): boolean {
  return (statSync(target).mode & 0o222) !== 0;
}

function markTreeReadonly(target: string): void {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const name of readdirSync(target)) markTreeReadonly(join(target, name));
  }
  chmodSync(target, 0o444);
}

function removeTemp(dir: string): void {
  const restore = (target: string): void => {
    let info: ReturnType<typeof lstatSync>;
    try { info = lstatSync(target); } catch { return; }
    if (info.isSymbolicLink()) return;
    if (info.isDirectory()) {
      try { chmodSync(target, 0o755); } catch { /* still try to list */ }
      let names: string[] = [];
      try { names = readdirSync(target); } catch { names = []; }
      for (const name of names) restore(join(target, name));
      return;
    }
    try { chmodSync(target, 0o644); } catch { /* delete will still be attempted */ }
  };
  restore(dir);
  rmSync(dir, { recursive: true, force: true });
}

test('只读且不是本机进程的 postmaster.pid 会去掉只读后删除，其他文件保留', () => {
  const dir = tempDir();
  try {
    const pidFile = join(dir, 'postmaster.pid');
    const page = join(dir, 'PG_VERSION');
    writeFileSync(pidFile, '-42\n/pglite/data\n');
    writeFileSync(page, '17\n');
    chmodSync(pidFile, 0o444);
    expect(clearStalePglitePostmasterPid(dir)).toEqual({ status: 'removed' });
    expect(existsSync(pidFile)).toBe(false);
    expect(readFileSync(page, 'utf8')).toBe('17\n');
  } finally {
    removeTemp(dir);
  }
});

test('postmaster.pid 指向仍在运行的进程时保留', () => {
  const dir = tempDir();
  try {
    const pidFile = join(dir, 'postmaster.pid');
    writeFileSync(pidFile, `${process.pid}\n`);
    expect(clearStalePglitePostmasterPid(dir)).toEqual({ status: 'kept-live', pid: process.pid });
    expect(readFileSync(pidFile, 'utf8')).toBe(`${process.pid}\n`);
  } finally {
    removeTemp(dir);
  }
});

test('只读失效启动锁不再挡住下一次打开', async () => {
  const dir = tempDir();
  let open: Awaited<ReturnType<typeof createPgliteDatabase>> | undefined;
  try {
    open = await createPgliteDatabase({ dataDir: dir });
    await open.close();
    open = undefined;
    const pidFile = join(dir, 'postmaster.pid');
    writeFileSync(pidFile, '-42\n/pglite/data\n');
    chmodSync(pidFile, 0o444);
    open = await createPgliteDatabase({ dataDir: dir });
    const result = await open.query<{ ok: number }>('SELECT 1 as ok');
    expect(result.rows[0]?.ok).toBe(1);
  } finally {
    await open?.close();
    removeTemp(dir);
  }
}, 60000);

test('数据目录只读时去掉目录和库文件的只读标记，不改内容，也不动启动锁', () => {
  const dir = tempDir();
  try {
    const page = join(dir, 'PG_VERSION');
    const nestedDir = join(dir, 'base');
    const nested = join(nestedDir, 'PG_VERSION');
    const pidFile = join(dir, 'postmaster.pid');
    mkdirSync(nestedDir);
    writeFileSync(page, '17\n');
    writeFileSync(nested, '17\n');
    writeFileSync(pidFile, '-42\n/pglite/data\n');
    markTreeReadonly(dir);
    clearPgliteDataDirReadonly(dir);
    expect(hasWriteBit(dir)).toBe(true);
    expect(hasWriteBit(page)).toBe(true);
    expect(hasWriteBit(nested)).toBe(true);
    expect(readFileSync(page, 'utf8')).toBe('17\n');
    expect(readFileSync(nested, 'utf8')).toBe('17\n');
    expect(hasWriteBit(pidFile)).toBe(false);
    expect(readFileSync(pidFile, 'utf8')).toBe('-42\n/pglite/data\n');
  } finally {
    removeTemp(dir);
  }
});

test('目录本来可写时，不改里面单独只读的文件', () => {
  const dir = tempDir();
  try {
    const page = join(dir, 'PG_VERSION');
    writeFileSync(page, '17\n');
    chmodSync(page, 0o444);
    clearPgliteDataDirReadonly(dir);
    expect(hasWriteBit(dir)).toBe(true);
    expect(hasWriteBit(page)).toBe(false);
    expect(readFileSync(page, 'utf8')).toBe('17\n');
  } finally {
    removeTemp(dir);
  }
});

test('只读的数据目录可以再次打开并读出结果', async () => {
  const dir = tempDir();
  let open: Awaited<ReturnType<typeof createPgliteDatabase>> | undefined;
  try {
    open = await createPgliteDatabase({ dataDir: dir });
    await open.close();
    open = undefined;
    const pidFile = join(dir, 'postmaster.pid');
    writeFileSync(pidFile, '-42\n/pglite/data\n');
    markTreeReadonly(dir);
    open = await createPgliteDatabase({ dataDir: dir });
    const result = await open.query<{ ok: number }>('SELECT 1 as ok');
    expect(result.rows[0]?.ok).toBe(1);
    expect(existsSync(pidFile)).toBe(true);
    expect(hasWriteBit(dir)).toBe(true);
  } finally {
    await open?.close();
    removeTemp(dir);
  }
}, 60000);

test('目录只读标记去不掉时，打开前就停止，不改文件内容', () => {
  const dir = tempDir();
  try {
    const page = join(dir, 'PG_VERSION');
    writeFileSync(page, '17\n');
    chmodSync(dir, 0o555);
    expect(() => assertPgliteDataDirLockWritable(dir)).toThrow(/Permission denied/);
    expect(() => assertPgliteDataDirLockWritable(dir)).toThrow(/postmaster\.pid/);
    expect(readFileSync(page, 'utf8')).toBe('17\n');
    expect(hasWriteBit(dir)).toBe(false);
  } finally {
    removeTemp(dir);
  }
});

test('校验副本看起来未正常关闭时，启动锁权限失败也不做 WAL 修复', async () => {
  const dir = tempDir();
  const stderr: string[] = [];
  const previousWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    mkdirSync(join(dir, 'base'));
    mkdirSync(join(dir, 'global'));
    mkdirSync(join(dir, 'pg_wal'));
    writeFileSync(join(dir, 'PG_VERSION'), '17\n');
    writeFileSync(join(dir, 'global', 'pg_control'), Buffer.alloc(PG_CONTROL_FILE_SIZE));
    await expect(openVerifiedRestoreCopy(dir, async () => {
      throw new Error('PGlite failed to initialize properly\nFATAL: could not create lock file "postmaster.pid": Permission denied');
    })).rejects.toThrow(/Permission denied/);
    expect(stderr.join('')).not.toContain('attempting automatic WAL repair');
    expect(readFileSync(join(dir, 'PG_VERSION'), 'utf8')).toBe('17\n');
  } finally {
    process.stderr.write = previousWrite;
    removeTemp(dir);
  }
});

test('只读校验副本可以打开，并且不会做 WAL 修复', async () => {
  const dir = tempDir();
  let open: Awaited<ReturnType<typeof createPgliteDatabase>> | undefined;
  const stderr: string[] = [];
  const previousWrite = process.stderr.write.bind(process.stderr);
  try {
    open = await createPgliteDatabase({ dataDir: dir });
    await open.close();
    open = undefined;
    writeFileSync(join(dir, 'postmaster.pid'), '-42\n/pglite/data\n');
    markTreeReadonly(dir);
    process.stderr.write = ((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    open = await openVerifiedRestoreCopy(dir, () => createPgliteDatabase({ dataDir: dir }));
    const result = await open.query<{ ok: number }>('SELECT 1 as ok');
    expect(result.rows[0]?.ok).toBe(1);
    expect(stderr.join('')).not.toContain('attempting automatic WAL repair');
    expect(hasWriteBit(dir)).toBe(true);
  } finally {
    process.stderr.write = previousWrite;
    await open?.close();
    removeTemp(dir);
  }
}, 60000);

test('没有 postmaster.pid 时不改目录', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'PG_VERSION'), '17\n');
    expect(clearStalePglitePostmasterPid(dir)).toEqual({ status: 'absent' });
    expect(existsSync(join(dir, 'PG_VERSION'))).toBe(true);
  } finally {
    removeTemp(dir);
  }
});
