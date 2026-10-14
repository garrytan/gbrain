/**
 * Read-only PGLite owner precheck before the desktop sidecar starts.
 *
 * PGLite is an embedded PostgreSQL database with one real OS-process owner per
 * data directory. This check never removes a lock or terminates a process.
 * Only a lock whose PID is proven dead is left for the engine's stale cleanup.
 * Missing, malformed, or unverifiable metadata fails closed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validatePgliteDatabasePath } from '../../../src/core/pmbrain-adapters/pglite-database-path.js';

export interface PgliteLockPrecheckResult {
  blocked: boolean;
  holderPid?: number;
  message?: string;
}

interface LockMetadata {
  pid?: unknown;
  acquired_at?: unknown;
  refreshed_at?: unknown;
  command?: unknown;
  role?: unknown;
  owner_token?: unknown;
}

function metadataBlocked(databasePath: string, lockDir: string, reason: string): PgliteLockPrecheckResult {
  return {
    blocked: true,
    message:
      `PGLite ${reason}. PMBrain will not delete ${lockDir} automatically because it cannot verify lock owner liveness.\n` +
      `请先退出所有 PMBrain/GBrain 进程并检查任务管理器；确认没有进程使用数据库后，再人工处理残留锁。\n` +
      `PGLite 数据库路径：${databasePath}`,
  };
}

export function precheckPgliteLock(databasePath: string | null | undefined): PgliteLockPrecheckResult {
  if (!databasePath) return { blocked: false };

  try {
    validatePgliteDatabasePath(databasePath);
  } catch (error) {
    return { blocked: true, message: error instanceof Error ? error.message : String(error) };
  }

  const lockDir = join(databasePath, '.gbrain-lock');
  if (!existsSync(lockDir)) return { blocked: false };

  const lockFile = join(lockDir, 'lock');
  if (!existsSync(lockFile)) {
    return metadataBlocked(databasePath, lockDir, 'lock metadata is missing');
  }

  let data: LockMetadata;
  try {
    data = JSON.parse(readFileSync(lockFile, 'utf-8'));
  } catch {
    return metadataBlocked(databasePath, lockDir, 'lock metadata is unreadable');
  }

  const pid = typeof data.pid === 'number' ? data.pid : NaN;
  if (!Number.isInteger(pid) || pid <= 0) {
    return metadataBlocked(databasePath, lockDir, 'cannot verify lock owner: metadata has no valid PID');
  }
  if (pid === process.pid) return { blocked: false };

  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (!alive) return { blocked: false };

  const since = typeof data.acquired_at === 'number'
    ? new Date(data.acquired_at).toLocaleString('zh-CN')
    : '未知时间';
  const refreshed = typeof data.refreshed_at === 'number'
    ? new Date(data.refreshed_at).toLocaleString('zh-CN')
    : '未知时间';
  const command = typeof data.command === 'string' && data.command.trim()
    ? data.command.trim()
    : '未知命令';
  const role = typeof data.role === 'string' && data.role.trim()
    ? data.role.trim()
    : 'legacy/unknown';

  return {
    blocked: true,
    holderPid: pid,
    message:
      `检测到另一个 PMBrain 进程正在使用本地数据库（PID ${pid}，角色 ${role}，启动于 ${since}，最近心跳 ${refreshed}）：\n${command}\n\n` +
      `请先退出该 PMBrain 实例（其他窗口、托盘图标或命令行），再点击「重新启动服务」。\n` +
      `活进程锁绝不会被抢占或自动删除。PGLite 数据库路径：${databasePath}`,
  };
}
