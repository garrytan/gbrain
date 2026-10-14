import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStalePglitePostmasterPid } from '../src/core/pglite-lock.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pmbrain-postmaster-'));
}

test('只读且不是本机进程的 postmaster.pid 会去掉只读后删除，其他文件保留', () => {
  const dir = tempDir();
  try {
    const pidFile = join(dir, 'postmaster.pid');
    const page = join(dir, 'PG_VERSION');
    writeFileSync(pidFile, '-42\n/pglite/data\n');
    writeFileSync(page, '17\n');
    chmodSync(pidFile, 0o444);
    expect(clearStalePglitePostmasterPid(dir)).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
    expect(readFileSync(page, 'utf8')).toBe('17\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('postmaster.pid 指向仍在运行的进程时保留', () => {
  const dir = tempDir();
  try {
    const pidFile = join(dir, 'postmaster.pid');
    writeFileSync(pidFile, `${process.pid}\n`);
    expect(clearStalePglitePostmasterPid(dir)).toBe(false);
    expect(readFileSync(pidFile, 'utf8')).toBe(`${process.pid}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('没有 postmaster.pid 时不改目录', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'PG_VERSION'), '17\n');
    expect(clearStalePglitePostmasterPid(dir)).toBe(false);
    expect(existsSync(join(dir, 'PG_VERSION'))).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
