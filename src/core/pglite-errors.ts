/**
 * Typed PGLite / desktop-sidecar errors so callers can classify failures
 * without parsing free-form Error.message strings.
 */

export type SidecarErrorCategory =
  | 'database_owned'
  | 'database_open_failed'
  | 'database_corrupt'
  | 'toast_corrupt'
  | 'migration_failed'
  | 'port_conflict'
  | 'runtime_missing'
  | 'permission'
  | 'transient'
  | 'unknown';

export interface SidecarErrorClassification {
  category: SidecarErrorCategory;
  retryable: boolean;
  labelZh: string;
}

export class DatabaseAlreadyOwnedError extends Error {
  readonly name = 'DatabaseAlreadyOwnedError';
  readonly databasePath: string;
  readonly lockPath: string;
  readonly ownerPid: number | null;
  readonly ownerType: string | null;
  readonly executablePath: string | null;
  readonly lockCreatedAt: string | null;
  readonly ownerToken: string | null;

  constructor(opts: {
    databasePath: string;
    lockPath: string;
    ownerPid?: number | null;
    ownerType?: string | null;
    executablePath?: string | null;
    lockCreatedAt?: string | null;
    ownerToken?: string | null;
    message?: string;
  }) {
    const pid = opts.ownerPid ?? null;
    super(
      opts.message
      ?? `PGLite database is already owned by another process`
        + (pid != null ? ` (pid=${pid}` : '')
        + (opts.ownerType ? `, type=${opts.ownerType}` : '')
        + (pid != null ? ')' : '')
        + `. Database: ${opts.databasePath}. Lock: ${opts.lockPath}.`
        + ' Close the other PMBrain instance, then retry.',
    );
    this.databasePath = opts.databasePath;
    this.lockPath = opts.lockPath;
    this.ownerPid = pid;
    this.ownerType = opts.ownerType ?? null;
    this.executablePath = opts.executablePath ?? null;
    this.lockCreatedAt = opts.lockCreatedAt ?? null;
    this.ownerToken = opts.ownerToken ?? null;
  }
}

export class StaleLockArchivedWarning extends Error {
  readonly name = 'StaleLockArchivedWarning';
  readonly archivePath: string;
  readonly reason: string;

  constructor(archivePath: string, reason: string) {
    super(`Stale PGLite lock archived to ${archivePath} (${reason})`);
    this.archivePath = archivePath;
    this.reason = reason;
  }
}

export class PgliteOpenError extends Error {
  readonly name = 'PgliteOpenError';
  readonly databasePath: string | null;
  readonly cause: unknown;

  constructor(message: string, opts?: { databasePath?: string | null; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.databasePath = opts?.databasePath ?? null;
    this.cause = opts?.cause;
  }
}

export class PgliteProbeError extends Error {
  readonly name = 'PgliteProbeError';
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
  }
}

export class PgliteLockMetadataError extends Error {
  readonly name = 'PgliteLockMetadataError';
  readonly lockPath: string;

  constructor(lockPath: string, message: string) {
    super(message);
    this.lockPath = lockPath;
  }
}

export class PglitePermissionError extends Error {
  readonly name = 'PglitePermissionError';
  readonly databasePath: string | null;

  constructor(message: string, databasePath?: string | null, opts?: { cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.databasePath = databasePath ?? null;
  }
}

export class SidecarExitedBeforeHealthyError extends Error {
  readonly name = 'SidecarExitedBeforeHealthyError';
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
  readonly category: SidecarErrorCategory;

  constructor(opts: {
    message: string;
    exitCode?: number | null;
    signal?: string | null;
    stderr?: string;
    category?: SidecarErrorCategory;
  }) {
    super(opts.message);
    this.exitCode = opts.exitCode ?? null;
    this.signal = opts.signal ?? null;
    this.stderr = opts.stderr ?? '';
    this.category = opts.category ?? 'unknown';
  }
}

export class SidecarHealthTimeoutError extends Error {
  readonly name = 'SidecarHealthTimeoutError';
  readonly healthUrl: string;
  readonly lastError: string;
  readonly sidecarAlive: boolean;
  readonly sidecarPid: number | null;
  readonly recentStderr: string;
  readonly category: SidecarErrorCategory;

  constructor(opts: {
    healthUrl: string;
    lastError: string;
    sidecarAlive: boolean;
    sidecarPid?: number | null;
    recentStderr?: string;
    category?: SidecarErrorCategory;
    message?: string;
  }) {
    super(
      opts.message
      ?? `本地服务启动失败：健康检查超时（${opts.healthUrl}）。最后错误：${opts.lastError}`,
    );
    this.healthUrl = opts.healthUrl;
    this.lastError = opts.lastError;
    this.sidecarAlive = opts.sidecarAlive;
    this.sidecarPid = opts.sidecarPid ?? null;
    this.recentStderr = opts.recentStderr ?? '';
    this.category = opts.category ?? 'unknown';
  }
}

/**
 * Classify sidecar/PGLite startup failures for retry policy and UI labels.
 * Database ownership / open / corruption / migration failures are never retryable
 * via automatic rapid restart — retries only create new races.
 */
export function classifySidecarStartupError(error: unknown): SidecarErrorClassification {
  const text = extractErrorText(error);

  if (/PGLite 数据库路径无效：/.test(text)) {
    return { category: 'database_open_failed', retryable: false, labelZh: '数据库路径不是有效文件夹' };
  }
  if (/PGLite 数据库路径检查失败：/.test(text)) {
    const permission = error instanceof PglitePermissionError || /EACCES|EPERM/.test(text);
    return { category: permission ? 'permission' : 'database_open_failed', retryable: false, labelZh: permission ? '数据库目录权限不足' : '数据库路径无法访问' };
  }

  if (
    error instanceof Error && error.name === 'GinIndexUnusableError'
    || /搜索索引修复失败|搜索索引异常，已停止后续数据库写入/.test(text)
  ) {
    return {
      category: 'unknown',
      retryable: false,
      labelZh: '搜索索引修复失败',
    };
  }

  if (
    error instanceof DatabaseAlreadyOwnedError
    || /DatabaseAlreadyOwnedError|already owned|lock owner active|Timed out waiting for PGLite lock|has held it/i.test(text)
  ) {
    return {
      category: 'database_owned',
      retryable: false,
      labelZh: '数据库已被其他 PMBrain 进程占用',
    };
  }

  if (
    error instanceof PglitePermissionError
    || /permission denied|EACCES|EPERM/i.test(text)
  ) {
    return {
      category: 'permission',
      retryable: false,
      labelZh: '数据库目录权限不足',
    };
  }

  if (isPgliteToastInconsistencyError(error)) {
    return {
      category: 'toast_corrupt',
      retryable: false,
      labelZh: '检测到数据库大字段数据损坏，不会继续自动重置 WAL，请使用数据修复/备份恢复。',
    };
  }

  if (/corrupt|database recovery failed|WAL|checksum|invalid page/i.test(text)) {
    return {
      category: 'database_corrupt',
      retryable: false,
      labelZh: '数据库恢复失败',
    };
  }

  if (
    /migration failed|schema migration|Schema probe failed|hasPendingMigrations/i.test(text)
  ) {
    return {
      category: 'migration_failed',
      retryable: false,
      labelZh: '迁移失败',
    };
  }

  if (
    error instanceof PgliteOpenError
    || /PGlite\.create failed|PGLite failed to initialize|Aborted\(\)|filesystem error|ENOSPC|database open/i.test(text)
  ) {
    return {
      category: 'database_open_failed',
      retryable: false,
      labelZh: '数据库无法打开',
    };
  }

  if (/EADDRINUSE|address already in use|port .* in use/i.test(text)) {
    return {
      category: 'port_conflict',
      retryable: true,
      labelZh: '端口被占用',
    };
  }

  if (/ENOENT|runtime missing|bun.*not found|Cannot find module|pmbrain-sidecar/i.test(text)) {
    return {
      category: 'runtime_missing',
      retryable: false,
      labelZh: 'sidecar 运行时缺失',
    };
  }

  if (
    /ECONNREFUSED|ECONNRESET|fetch failed|network|socket hang up|timed out|timeout|Health check returned/i.test(text)
  ) {
    return {
      category: 'transient',
      retryable: true,
      labelZh: '临时网络或健康检查错误',
    };
  }

  return {
    category: 'unknown',
    retryable: false,
    labelZh: '未知错误',
  };
}

export interface PgliteToastErrorLocation {
  actualChunk: number | null;
  expectedChunk: number | null;
  toastValue: number;
  toastRelation: string;
  heapOid: number;
}

export function parsePgliteToastError(error: unknown): PgliteToastErrorLocation | null {
  const text = extractErrorText(error);
  const unexpected = text.match(
    /unexpected chunk number\s+(\d+)\s+\(expected\s+(\d+)\)\s+for toast value\s+(\d+)\s+in\s+(pg_toast_\d+)/i,
  );
  if (unexpected) {
    const toastRelation = unexpected[4]!.toLowerCase();
    return {
      actualChunk: Number(unexpected[1]),
      expectedChunk: Number(unexpected[2]),
      toastValue: Number(unexpected[3]),
      toastRelation,
      heapOid: Number(toastRelation.slice('pg_toast_'.length)),
    };
  }
  const missing = text.match(
    /missing chunk number\s+(\d+)\s+for toast value\s+(\d+)\s+in\s+(pg_toast_\d+)/i,
  );
  if (missing) {
    const toastRelation = missing[3]!.toLowerCase();
    return {
      actualChunk: null,
      expectedChunk: Number(missing[1]),
      toastValue: Number(missing[2]),
      toastRelation,
      heapOid: Number(toastRelation.slice('pg_toast_'.length)),
    };
  }
  return null;
}

export function isPgliteToastInconsistencyError(error: unknown): boolean {
  return parsePgliteToastError(error) != null
    || /unexpected chunk number|missing chunk number|for toast value \d+ in pg_toast_/i.test(
      extractErrorText(error),
    );
}

function extractErrorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    const causeText = cause instanceof Error ? cause.message : cause != null ? String(cause) : '';
    return `${error.name}: ${error.message}\n${causeText}`;
  }
  return String(error);
}
