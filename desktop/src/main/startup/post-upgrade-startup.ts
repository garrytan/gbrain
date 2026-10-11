/**
 * Post-upgrade first-boot helpers.
 *
 * After NSIS install + quitAndInstall, the first ensureReady often races the
 * PGLite exclusive lock released by the cold-backup CLI. Manual "重新启动服务"
 * almost always succeeds a moment later. These helpers encode automatic retry
 * and user-facing message sanitization so upgrades enter Admin without a click.
 */

/** Delay after upgrade cold-backup / migration before the first sidecar start. */
export const POST_UPGRADE_SETTLE_MS = 1_500;

/** Max ensureReady attempts when this launch performed an upgrade migration. */
export const POST_UPGRADE_READY_ATTEMPTS = 2;

/** Default sidecar /health wait for Postgres and non-PGLite engines. */
export const DEFAULT_HEALTH_TIMEOUT_MS = 45_000;

/** PGLite already-migrated start: opening a large data dir can exceed 45s. */
export const PGLITE_HEALTH_TIMEOUT_MS = 180_000;

/**
 * First start after a desktop upgrade. Sidecar owns PGLite migrations,
 * including GIN trigram indexes on existing chunk text. Killing the process
 * at 45s rolls the in-progress transaction back and the next retry starts over.
 */
export const POST_UPGRADE_HEALTH_TIMEOUT_MS = 600_000;

export function resolveSidecarHealthTimeoutMs(opts: {
  engine: string;
  upgradePending: boolean;
}): number {
  if (opts.engine !== 'pglite') return DEFAULT_HEALTH_TIMEOUT_MS;
  return opts.upgradePending ? POST_UPGRADE_HEALTH_TIMEOUT_MS : PGLITE_HEALTH_TIMEOUT_MS;
}

/** Base backoff between ensureReady attempts (multiplied by attempt index). */
export const POST_UPGRADE_RETRY_BASE_MS = 2_000;

export function postUpgradeRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return POST_UPGRADE_RETRY_BASE_MS * n;
}

/**
 * Extract a successful pglite-backup --json payload from a thrown CLI error.
 * Some Windows runs print a valid {status:created|reused} line but still exit
 * non-zero; treat that as success so upgrade startup can continue.
 */
export function parseSuccessfulBackupJsonFromError(message: string): {
  status: 'created' | 'reused' | 'restored';
  backup_directory: string;
} | null {
  const lines = message
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as {
        status?: string;
        backup_directory?: string;
        backupDirectory?: string;
      };
      const backupDirectory = typeof parsed.backup_directory === 'string' && parsed.backup_directory.length > 0
        ? parsed.backup_directory
        : typeof parsed.backupDirectory === 'string' && parsed.backupDirectory.length > 0
          ? parsed.backupDirectory
          : null;
      if (
        (parsed.status === 'created' || parsed.status === 'reused' || parsed.status === 'restored')
        && backupDirectory
      ) {
        return {
          status: parsed.status,
          backup_directory: backupDirectory,
        };
      }
    } catch {
      // keep scanning other lines
    }
  }
  return null;
}

/**
 * Recovery UI must never dump raw CLI JSON (especially successful backup
 * envelopes) as the failure reason — users read it as "data corruption".
 */
export function sanitizeStartupFailureMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return 'PMBrain 本地服务没有成功启动。配置与知识库已保留，请点击「重新启动服务」。';
  }

  const successfulBackup = parseSuccessfulBackupJsonFromError(trimmed);
  if (successfulBackup?.status === 'restored') {
    return '数据库备份已恢复，配置与知识库已替换为该备份。请点击「重新启动服务」。';
  }
  if (successfulBackup) {
    return (
      '升级后首次启动未完成。升级前冷备已保留，配置与知识库安全。' +
      'PMBrain 会自动重试本地服务；若仍失败，请点击「重新启动服务」。'
    );
  }

  if (trimmed.startsWith('{') && /"backup_directory"\s*:/.test(trimmed)) {
    return (
      '升级准备阶段异常。配置与知识库已保留。' +
      '请点击「重新启动服务」；若反复失败，请打开日志排查。'
    );
  }

  // Strip accidental multi-line JSON tails while keeping human text.
  if (trimmed.includes('\n{') && /"status"\s*:/.test(trimmed)) {
    const head = trimmed.slice(0, trimmed.indexOf('\n{')).trim();
    if (head) return head;
  }

  return trimmed;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function readMigrationProgress(stderr:string):{visible:true;stage:'migration'|'health';title:string;message:string}|null{
  const started=Math.max(stderr.lastIndexOf('Schema version '),stderr.lastIndexOf('[serve] opening database'));
  const ready=stderr.lastIndexOf('[migrate] schema ready');
  if(ready>started)return {visible:true,stage:'health',title:'数据库升级完成，正在检查本地服务',message:'正在等待本地服务健康检查。'};
  const matches=[...stderr.matchAll(/page revision backfill: (\d+)\/(\d+) row\(s\) done/g)];
  const latest=matches.at(-1);
  if(latest)return {visible:true,stage:'migration',title:'正在升级知识库',message:`页面版本号已完成 ${latest[1]} / ${latest[2]} 页。关闭应用后，下次启动会从已完成的批次继续。`};
  if(stderr.includes('Schema version '))return {visible:true,stage:'migration',title:'正在升级知识库',message:'升级正在本地执行，完成后会继续启动服务。'};
  return null;
}
