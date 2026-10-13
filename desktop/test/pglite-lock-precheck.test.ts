/**
 * 桌面端 PGLite 锁预检测试（产品经理视角）：
 * 老用户升级桌面端时，如果另一个 PMBrain（旧窗口/托盘/命令行）还开着数据库，
 * 新版本应该在启动的一瞬间就告诉用户"请先退出另一个 PMBrain（PID xxx）"，
 * 而不是干等半分钟后报一个看不懂的迁移失败。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { precheckPgliteLock } from '../src/main/pglite-lock-precheck.js';

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* best-effort */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeDbDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-lock-precheck-'));
  roots.push(root);
  return root;
}

function writeLock(dbDir: string, data: unknown): void {
  const lockDir = join(dbDir, '.gbrain-lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'lock'), typeof data === 'string' ? data : JSON.stringify(data));
}

describe('precheckPgliteLock', () => {
  test('无数据库路径 → 放行', () => {
    expect(precheckPgliteLock(undefined).blocked).toBe(false);
    expect(precheckPgliteLock(null).blocked).toBe(false);
    expect(precheckPgliteLock('').blocked).toBe(false);
  });

  test('无锁目录 → 放行', () => {
    const dbDir = makeDbDir();
    expect(precheckPgliteLock(dbDir).blocked).toBe(false);
  });

  test('数据库路径是普通文件时在 Sidecar 启动前拦截，并保留原文件', () => {
    const root = makeDbDir(), path = join(root, 'brain.pglite');
    writeFileSync(path, 'Keep the existing file.');
    const result = precheckPgliteLock(path);
    expect(result.blocked).toBe(true);
    expect(result.message).toContain('普通文件');
    expect(result.message).toContain('修改配置');
    expect(result.message).toContain(path);
    expect(readFileSync(path, 'utf8')).toBe('Keep the existing file.');
    expect(readdirSync(root)).toEqual(['brain.pglite']);
  });

  test('父路径文件冲突不能被当作无锁目录放行', () => {
    const root = makeDbDir(), parent = join(root, 'parent-file');
    writeFileSync(parent, 'Keep the parent file.');
    const result = precheckPgliteLock(join(parent, 'brain.pglite'));
    expect(result.blocked).toBe(true);
    expect(result.message).toContain('父路径');
    expect(result.message).toContain(parent);
    expect(readFileSync(parent, 'utf8')).toBe('Keep the parent file.');
  });

  test('锁文件损坏 → 安全拦截且不自动删除', () => {
    const dbDir = makeDbDir();
    writeLock(dbDir, '{not valid json');
    const result = precheckPgliteLock(dbDir);
    expect(result.blocked).toBe(true);
    expect(result.message).toContain('lock metadata');
    expect(result.message).toContain('not delete');
  });

  test('锁 PID 已死 → 放行（stale 检测会清理）', () => {
    const dbDir = makeDbDir();
    // 选一个几乎不可能存活的 PID
    writeLock(dbDir, { pid: 4194300, acquired_at: Date.now(), command: 'old-pmbrain serve' });
    const result = precheckPgliteLock(dbDir);
    expect(result.blocked).toBe(false);
  });

  test('锁 PID 是当前进程自己 → 放行', () => {
    const dbDir = makeDbDir();
    writeLock(dbDir, { pid: process.pid, acquired_at: Date.now(), command: 'self' });
    expect(precheckPgliteLock(dbDir).blocked).toBe(false);
  });

  test('锁 PID 是另一个活进程 → 拦截并给出可操作指引', async () => {
    const dbDir = makeDbDir();
    // spawn 一个真实存活进程（ping 自己 5 秒）拿真实 PID
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'ignore' });
    children.push(child);
    await new Promise((r) => setTimeout(r, 200));
    expect(child.pid).toBeDefined();

    writeLock(dbDir, {
      pid: child.pid,
      acquired_at: Date.now(),
      refreshed_at: Date.now(),
      command: 'pmbrain-sidecar.js serve --http',
      role: 'desktop-sidecar',
      owner_token: 'desktop-owner-token',
    });
    const result = precheckPgliteLock(dbDir);
    expect(result.blocked).toBe(true);
    expect(result.holderPid).toBe(child.pid);
    expect(result.message).toContain(`PID ${child.pid}`);
    expect(result.message).toContain('请先退出该 PMBrain 实例');
    expect(result.message).toContain('desktop-sidecar');
    expect(result.message).toContain(dbDir);
  });

  test('锁文件缺 pid 字段 → 安全拦截', () => {
    const dbDir = makeDbDir();
    writeLock(dbDir, { acquired_at: Date.now(), command: 'x' });
    const result = precheckPgliteLock(dbDir);
    expect(result.blocked).toBe(true);
    expect(result.message).toContain('cannot verify lock owner');
  });

  test('lock directory without metadata is blocked safely', () => {
    const dbDir = makeDbDir();
    mkdirSync(join(dbDir, '.gbrain-lock'));
    const result = precheckPgliteLock(dbDir);
    expect(result.blocked).toBe(true);
    expect(result.message).toContain('lock metadata is missing');
  });
});
