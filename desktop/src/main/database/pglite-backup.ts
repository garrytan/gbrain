import { resolve } from 'node:path';
import { validatePgliteDatabasePath } from '../../../../src/core/pmbrain-adapters/pglite-database-path.js';
import type { CliRuntime } from '../cli-runner.js';
import type { SetupInfo } from '../config-manager.js';
import type {
  DesktopPgliteUpgradeBackup,
  DesktopPgliteUpgradeBackupMutation,
  DesktopPgliteUpgradeBackups,
} from '../../preload/index.js';

interface StartupProgress {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
}

interface PgliteBackupListCliEntry {
  status?: string;
  backup_directory?: string;
  backup_database_path?: string;
  manifest_path?: string;
  created_at?: string;
  target_version?: string;
  source_schema_version?: number | null;
  recovery_verified_at?: string;
  bytes?: number;
}

function parseLastJson<T>(stdout: string, errorMessage: string): T {
  const line = stdout.trim().split(/\r?\n/).at(-1) || '';
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    throw new Error(errorMessage, { cause: error });
  }
}

function normalizedPath(value: string): string {
  const full = resolve(value);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

export interface PgliteBackupControllerDependencies {
  appVersion: () => string;
  setupInfo: () => SetupInfo;
  runtime: () => CliRuntime;
  runCliChecked: (runtime: CliRuntime, args: string[]) => Promise<{ stdout: string }>;
  sendStartupProgress: (progress: StartupProgress) => void;
  log: (message: string) => void;
}

export class PgliteBackupController {
  private readonly backupByVersion = new Map<string, string | null>();
  pendingBackupPath: string | null = null;

  constructor(private readonly dependencies: PgliteBackupControllerDependencies) {}

  async ensureUpgradeBackup(databasePath: string | null | undefined): Promise<string | null> {
    if (!databasePath) throw new Error('PGLite 升级前无法确定数据库路径，已停止迁移。');
    validatePgliteDatabasePath(databasePath);
    const pathKey = process.platform === 'win32' ? databasePath.toLowerCase() : databasePath;
    const key = `${pathKey}::${this.dependencies.appVersion()}`;
    if (this.backupByVersion.has(key)) {
      const cached = this.backupByVersion.get(key) ?? null;
      this.pendingBackupPath = cached;
      return cached;
    }

    this.pendingBackupPath = null;
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'migration',
      title: '正在创建升级前数据库冷备',
      message: 'sidecar 已停止。PMBrain 正在取得独占迁移锁、复制完整 PGLite 目录并验证恢复副本，请不要关闭窗口。',
    });
    const { parseSuccessfulBackupJsonFromError } = await import('../startup/post-upgrade-startup.js');
    let result: {
      status?: string;
      backup_directory?: string;
      reason?: string;
    };
    try {
      const completed = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
        'pglite-backup',
        'create',
        '--path', databasePath,
        '--target-version', this.dependencies.appVersion(),
        '--json',
      ]);
      result = JSON.parse(completed.stdout.trim().split(/\r?\n/).at(-1) || '{}') as {
        status?: string;
        backup_directory?: string;
        reason?: string;
      };
    } catch (error) {
      // Windows occasionally exits non-zero after printing a valid success
      // envelope. Recover so upgrade first-boot is not false-failed.
      const recovered = parseSuccessfulBackupJsonFromError(
        error instanceof Error ? error.message : String(error),
      );
      if (!recovered) throw error;
      this.dependencies.log(
        `PGLite upgrade backup CLI exited non-zero but returned success JSON (${recovered.status}); continuing.`,
      );
      result = recovered;
    }
    if (result.status === 'not_required' && result.reason === 'database_missing') {
      this.backupByVersion.set(key, null);
      this.dependencies.log(`PGLite upgrade backup not required; database does not exist yet: ${databasePath}`);
      return null;
    }
    if (!['created', 'reused'].includes(result.status ?? '') || !result.backup_directory) {
      throw new Error('PGLite 升级冷备没有返回可验证的备份目录，已停止迁移。');
    }

    this.pendingBackupPath = result.backup_directory;
    this.backupByVersion.set(key, result.backup_directory);
    this.dependencies.log(`Verified PGLite pre-upgrade backup: ${result.backup_directory}`);
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'migration',
      title: '升级前冷备验证通过',
      message: `可恢复备份已保留：${result.backup_directory}。现在开始兼容迁移；失败时不会自动覆盖数据库。`,
    });
    return result.backup_directory;
  }

  async listUpgradeBackups(): Promise<DesktopPgliteUpgradeBackups> {
    const setup = this.dependencies.setupInfo();
    if (setup.needsSetup || setup.current.engine !== 'pglite') {
      return { databasePath: null, backupRoot: null, keep: 2, totalBytes: 0, backups: [] };
    }
    const databasePath = setup.current.databasePath ?? setup.defaults.databasePath;
    const completed = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
      'pglite-backup',
      'list',
      '--path', databasePath,
      '--json',
    ]);
    const result = parseLastJson<{
      status?: string;
      database_path?: string;
      backup_root?: string;
      keep?: number;
      total_bytes?: number;
      backups?: PgliteBackupListCliEntry[];
    }>(completed.stdout, 'PGLite 备份清单返回格式无效，无法显示软件修复内容。');
    if (result.status !== 'ok' || !Array.isArray(result.backups)) {
      throw new Error('PGLite 备份清单返回格式无效，无法显示软件修复内容。');
    }
    const backups = result.backups.flatMap((entry) => this.mapVerifiedBackup(entry));
    return {
      databasePath: result.database_path ?? databasePath,
      backupRoot: result.backup_root ?? null,
      keep: typeof result.keep === 'number' && result.keep >= 2 ? result.keep : 2,
      totalBytes: typeof result.total_bytes === 'number' && result.total_bytes >= 0
        ? result.total_bytes
        : backups.reduce((sum, backup) => sum + backup.bytes, 0),
      backups,
    };
  }

  async pruneUpgradeBackups(): Promise<DesktopPgliteUpgradeBackupMutation> {
    const { databasePath } = await this.requirePgliteDatabase();
    this.dependencies.log(`Pruning PGLite upgrade backups for ${databasePath}`);
    const completed = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
      'pglite-backup',
      'prune',
      '--path', databasePath,
      '--keep', '2',
      '--json',
    ]);
    const result = parseLastJson<{ status?: string; deleted?: string[]; kept?: string[] }>(
      completed.stdout,
      'PGLite 备份清理返回格式无效。',
    );
    if (result.status !== 'pruned') {
      throw new Error('PGLite 备份清理未完成。');
    }
    return {
      status: 'pruned',
      deleted: Array.isArray(result.deleted) ? result.deleted : [],
      kept: Array.isArray(result.kept) ? result.kept : [],
      listing: await this.listUpgradeBackups(),
    };
  }

  async pruneUpgradeBackupsAfterUpgrade(): Promise<void> {
    try {
      const result = await this.pruneUpgradeBackups();
      this.dependencies.log(
        `PGLite upgrade backup prune kept ${result.kept?.length ?? 0} and deleted ${result.deleted?.length ?? 0}.`,
      );
    } catch (error) {
      this.dependencies.log(
        `PGLite upgrade backup prune failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async deleteUpgradeBackup(backupDirectory: string): Promise<DesktopPgliteUpgradeBackupMutation> {
    const selected = await this.requireListedBackup(backupDirectory);
    const completed = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
      'pglite-backup',
      'delete',
      '--backup', selected.backupDirectory,
      '--path', selected.databasePath,
      '--json',
    ]);
    const result = parseLastJson<{ status?: string; backup_directory?: string }>(
      completed.stdout,
      'PGLite 备份删除返回格式无效。',
    );
    if (result.status !== 'deleted') {
      throw new Error('PGLite 备份删除未完成。');
    }
    return {
      status: 'deleted',
      backupDirectory: result.backup_directory ?? selected.backupDirectory,
      listing: await this.listUpgradeBackups(),
    };
  }

  async restoreUpgradeBackup(backupDirectory: string): Promise<DesktopPgliteUpgradeBackupMutation> {
    const selected = await this.requireListedBackup(backupDirectory);
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'database',
      title: '正在恢复数据库备份',
      message: '本地服务已暂停。PMBrain 正在校验备份并用它替换当前数据库，请不要关闭窗口。',
    });
    const { parseSuccessfulBackupJsonFromError } = await import('../startup/post-upgrade-startup.js');
    let completed: { stdout: string };
    try {
      completed = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
        'pglite-backup',
        'restore',
        '--backup', selected.backupDirectory,
        '--path', selected.databasePath,
        '--yes',
        '--json',
      ]);
    } catch (error) {
      const recovered = parseSuccessfulBackupJsonFromError(
        error instanceof Error ? error.message : String(error),
      );
      if (recovered?.status !== 'restored') throw error;
      this.dependencies.log(
        `PGLite restore CLI exited non-zero but returned success JSON; continuing.`,
      );
      completed = {
        stdout: JSON.stringify({
          status: 'restored',
          backup_directory: recovered.backup_directory,
          backupDirectory: recovered.backup_directory,
        }),
      };
    }
    const result = parseLastJson<{ status?: string; backup_directory?: string; backupDirectory?: string }>(
      completed.stdout,
      'PGLite 备份恢复返回格式无效。',
    );
    if (result.status !== 'restored') {
      throw new Error('PGLite 备份恢复未完成。');
    }
    this.dependencies.log(`Restored PGLite database from ${selected.backupDirectory}`);
    return {
      status: 'restored',
      backupDirectory: result.backupDirectory ?? result.backup_directory ?? selected.backupDirectory,
      listing: await this.listUpgradeBackups(),
    };
  }

  async setBackupRoot(directory: string): Promise<DesktopPgliteUpgradeBackupMutation> {
    const { databasePath } = await this.requirePgliteDatabase();
    const completed = await this.dependencies.runCliChecked(this.dependencies.runtime(), [
      'pglite-backup',
      'set-root',
      '--dir', directory,
      '--path', databasePath,
      '--json',
    ]);
    const result = parseLastJson<{ status?: string; backup_root?: string }>(
      completed.stdout,
      'PGLite 备份目录更新返回格式无效。',
    );
    if (result.status !== 'updated' && result.status !== 'unchanged') {
      throw new Error('PGLite 备份目录没有更新。');
    }
    return {
      status: result.status,
      backupRoot: result.backup_root ?? directory,
      listing: await this.listUpgradeBackups(),
    };
  }

  async resolveOpenableBackupPath(target: string): Promise<string> {
    const listing = await this.listUpgradeBackups();
    const requested = normalizedPath(target);
    if (listing.backupRoot && normalizedPath(listing.backupRoot) === requested) {
      return listing.backupRoot;
    }
    const match = listing.backups.find(backup => normalizedPath(backup.backupDirectory) === requested);
    if (!match) throw new Error('只能打开当前软件修复页列出的备份目录。');
    return match.backupDirectory;
  }

  private mapVerifiedBackup(entry: PgliteBackupListCliEntry): DesktopPgliteUpgradeBackup[] {
    if (entry.status !== 'verified'
      || !entry.backup_directory
      || !entry.backup_database_path
      || !entry.manifest_path
      || !entry.created_at
      || !entry.target_version
      || !entry.recovery_verified_at) {
      return [];
    }
    return [{
      status: 'verified' as const,
      backupDirectory: entry.backup_directory,
      backupDatabasePath: entry.backup_database_path,
      manifestPath: entry.manifest_path,
      createdAt: entry.created_at,
      targetVersion: entry.target_version,
      sourceSchemaVersion: typeof entry.source_schema_version === 'number' ? entry.source_schema_version : null,
      recoveryVerifiedAt: entry.recovery_verified_at,
      bytes: typeof entry.bytes === 'number' && entry.bytes >= 0 ? entry.bytes : 0,
    }];
  }

  private async requirePgliteDatabase(): Promise<{ databasePath: string }> {
    const setup = this.dependencies.setupInfo();
    if (setup.needsSetup || setup.current.engine !== 'pglite') {
      throw new Error('完成 PGLite 基础配置后才能管理升级备份。');
    }
    const databasePath = setup.current.databasePath ?? setup.defaults.databasePath;
    if (!databasePath) throw new Error('当前尚未配置 PGLite 数据库路径。');
    return { databasePath };
  }

  private async requireListedBackup(backupDirectory: string): Promise<{
    backupDirectory: string;
    databasePath: string;
  }> {
    const listing = await this.listUpgradeBackups();
    if (!listing.databasePath) throw new Error('当前尚未配置 PGLite 数据库。');
    const match = listing.backups.find(backup => (
      normalizedPath(backup.backupDirectory) === normalizedPath(backupDirectory)
    ));
    if (!match) throw new Error('只能操作当前软件修复页列出的已验证备份。');
    return { backupDirectory: match.backupDirectory, databasePath: listing.databasePath };
  }
}
