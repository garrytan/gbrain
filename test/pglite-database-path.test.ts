import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { validatePgliteDatabasePath } from '../src/core/pmbrain-adapters/pglite-database-path.ts';
import { classifySidecarStartupError, PgliteOpenError, PglitePermissionError } from '../src/core/pglite-errors.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('pmbrain-path-validation-')) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true });
  }
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'pmbrain-path-validation-'));
  roots.push(path);
  return path;
}

test('无持久路径与不存在目录只读检查，不创建数据库或改变原目录', () => {
  expect(validatePgliteDatabasePath(undefined)).toBe('memory');
  expect(validatePgliteDatabasePath('')).toBe('memory');
  const directory = root(), path = join(directory, 'new', 'brain.pglite');
  expect(validatePgliteDatabasePath(path)).toBe('missing');
  expect(existsSync(path)).toBe(false);
  expect(readdirSync(directory)).toEqual([]);
});

test('已有目录原样放行，路径检查不重建数据库或要求迁移', () => {
  const path = root();
  writeFileSync(join(path, 'PG_VERSION'), '17\n');
  expect(validatePgliteDatabasePath(path)).toBe('directory');
  expect(readdirSync(path)).toEqual(['PG_VERSION']);
  expect(readFileSync(join(path, 'PG_VERSION'), 'utf8')).toBe('17\n');
});

for (const code of ['EACCES', 'EPERM', 'EIO']) test(`${code} 保留原始原因和路径，不伪装成不存在目录`, () => {
  const path = join(root(), 'brain.pglite');
  const cause = Object.assign(new Error(`${code}: cannot inspect configured path`), { code });
  let error: unknown;
  try { validatePgliteDatabasePath(path, () => { throw cause; }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(code === 'EIO' ? PgliteOpenError : PglitePermissionError);
  expect((error as Error).cause).toBe(cause);
  expect((error as Error).message).toContain(path);
  expect(classifySidecarStartupError(error)).toMatchObject({ category: code === 'EIO' ? 'database_open_failed' : 'permission', retryable: false });
  expect(existsSync(path)).toBe(false);
});

test('冲突文件名含 WAL 或 corrupt 仍是路径错误，不触发数据库恢复分类', () => {
  const directory = root(), path = join(directory, 'WAL-corrupt.pglite');
  writeFileSync(path, 'Do not misclassify file names as database recovery failures.');
  let error: unknown;
  try { validatePgliteDatabasePath(path); } catch (caught) { error = caught; }
  expect(classifySidecarStartupError(error)).toMatchObject({ category: 'database_open_failed', retryable: false });
  expect(classifySidecarStartupError(`Sidecar exited: ${(error as Error).message}`)).toMatchObject({ category: 'database_open_failed', retryable: false });
  expect(readFileSync(path, 'utf8')).toContain('Do not misclassify');
});

test('存在的父目录下仍允许选择新的数据库目录', () => {
  const directory = root();
  mkdirSync(join(directory, 'existing-parent'));
  expect(validatePgliteDatabasePath(join(directory, 'existing-parent', 'brain.pglite'))).toBe('missing');
  expect(readdirSync(join(directory, 'existing-parent'))).toEqual([]);
});
