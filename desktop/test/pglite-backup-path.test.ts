import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { PgliteBackupController, type PgliteBackupControllerDependencies } from '../src/main/database/pglite-backup.js';
import { PgliteOpenError } from '../../src/core/pglite-errors.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('pmbrain-upgrade-path-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true });
  }
});
function root(): string { const path = mkdtempSync(join(tmpdir(), 'pmbrain-upgrade-path-')); roots.push(path); return path; }
function controller(run: PgliteBackupControllerDependencies['runCliChecked']): PgliteBackupController {
  return new PgliteBackupController({ appVersion: () => 'path-test', setupInfo: () => { throw new Error('Unused test seam'); }, runtime: () => ({ bunPath: process.execPath, scriptPath: 'unused' } as any), runCliChecked: run, sendStartupProgress: () => {}, log: () => {} });
}

test('覆盖升级前先拦截同名文件，不启动备份或迁移 CLI，也不修改原文件', async () => {
  const path = join(root(), 'brain.pglite');writeFileSync(path, 'Preserve original unknown data.');
  let calls = 0;
  const backup = controller(async () => { calls++;throw new Error('Invalid path must not launch CLI'); });
  await expect(backup.ensureUpgradeBackup(path)).rejects.toBeInstanceOf(PgliteOpenError);
  expect(calls).toBe(0);expect(readFileSync(path, 'utf8')).toBe('Preserve original unknown data.');
});

test('正常目录沿用已有升级备份流程，已缓存路径改为文件时仍重新检查', async () => {
  const directory = root(), path = join(directory, 'brain.pglite');mkdirSync(path);
  let calls = 0;
  const backup = controller(async () => { calls++;return { stdout: JSON.stringify({ status: 'created', backup_directory: join(directory, 'verified-backup') }) }; });
  expect(await backup.ensureUpgradeBackup(path)).toBe(join(directory, 'verified-backup'));
  expect(await backup.ensureUpgradeBackup(path)).toBe(join(directory, 'verified-backup'));expect(calls).toBe(1);
  rmdirSync(path);writeFileSync(path, 'File replaces only the empty synthetic fixture directory.');
  await expect(backup.ensureUpgradeBackup(path)).rejects.toBeInstanceOf(PgliteOpenError);expect(calls).toBe(1);
});

test('新安装不存在目录仍按既有 not_required 返回，不由预检提前创建数据库', async () => {
  const path = join(root(), 'missing.pglite');
  const backup = controller(async () => ({ stdout: JSON.stringify({ status: 'not_required', reason: 'database_missing' }) }));
  expect(await backup.ensureUpgradeBackup(path)).toBeNull();
});
