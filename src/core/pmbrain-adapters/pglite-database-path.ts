import { mkdirSync, statSync, type Stats } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PgliteOpenError, PglitePermissionError } from '../pglite-errors.js';

function filesystemFailure(databasePath: string, cause: unknown): Error {
  const original = cause instanceof Error ? cause.message : String(cause);
  const message = `PGLite 数据库路径检查失败：${databasePath}\n${original}\n请检查该路径的访问权限和所在磁盘。PMBrain 不会自动改用其他数据库。`;
  if (['EACCES', 'EPERM'].includes((cause as NodeJS.ErrnoException)?.code ?? '')) {
    return new PglitePermissionError(message, databasePath, { cause });
  }
  return new PgliteOpenError(message, { databasePath, cause });
}

export function validatePgliteDatabasePath(
  databasePath: string | null | undefined,
  statPath: (path: string) => Pick<Stats, 'isDirectory' | 'isFile'> = statSync,
): 'memory' | 'directory' | 'missing' {
  if (!databasePath) return 'memory';
  const target = resolve(databasePath);
  let candidate = target;
  while (true) {
    let info: Pick<Stats, 'isDirectory' | 'isFile'>;
    try {
      info = statPath(candidate);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException)?.code;
      const parent = dirname(candidate);
      if ((code === 'ENOENT' || code === 'ENOTDIR') && parent !== candidate) {
        candidate = parent;
        continue;
      }
      throw filesystemFailure(databasePath, cause);
    }
    if (!info.isDirectory()) {
      const location = candidate === target ? '该路径' : `父路径 ${candidate}`;
      const kind = info.isFile() ? '是一个普通文件' : '不是文件夹';
      throw new PgliteOpenError(
        `PGLite 数据库路径无效：${databasePath}\n${location}${kind}，PGLite 需要数据库文件夹。`
        + '\nPMBrain 未修改该文件或自动切换数据库。请保留原文件，点击「修改配置」，选择原有有效的 PGLite 数据库文件夹；不要删除文件或改用空数据库。',
        { databasePath },
      );
    }
    return candidate === target ? 'directory' : 'missing';
  }
}

export function createPgliteDatabaseDirectory(databasePath: string): void {
  if (validatePgliteDatabasePath(databasePath) === 'directory') return;
  try {
    mkdirSync(databasePath, { recursive: true });
  } catch (cause) {
    try {
      validatePgliteDatabasePath(databasePath);
    } catch (validation) {
      if (validation instanceof PglitePermissionError) {
        throw new PglitePermissionError(validation.message, databasePath, { cause });
      }
      if (validation instanceof PgliteOpenError) {
        throw new PgliteOpenError(validation.message, { databasePath, cause });
      }
      throw validation;
    }
    throw filesystemFailure(databasePath, cause);
  }
}
