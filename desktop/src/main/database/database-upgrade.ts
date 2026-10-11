import { app } from 'electron';
import { getDatabaseRuntimeConfig, getSetupInfo, needsDesktopMigration, saveDetectedDockerContainerName } from '../config-manager.js';
import { runCliChecked, type CliRuntime } from '../cli-runner.js';
import type { DesktopLogger } from '../logs.js';
import { DatabaseRuntimeManager } from '../database-runtime-manager.js';
import type { PgliteBackupController } from './pglite-backup.js';

const DESKTOP_MIGRATION_ARGS = ['apply-migrations', '--yes', '--non-interactive', '--no-autopilot-install'];

interface StartupProgress {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
}

interface EmbeddingDimensionStatusCliResult {
  status?: string;
  embedding_model?: string | null;
  configured_dimensions?: number | null;
  column_dimensions?: number | null;
  existing_embeddings?: number | string;
}

function parseLastJson<T>(stdout: string, errorMessage: string): T {
  const line = stdout.trim().split(/\r?\n/).at(-1) || '';
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    throw new Error(errorMessage, { cause: error });
  }
}

export interface DatabaseUpgradeDependencies {
  runtime: () => CliRuntime;
  getLogger: () => DesktopLogger | null;
  pgliteBackup: PgliteBackupController;
  syncModelDefaults: () => Promise<void>;
  sendStartupProgress: (progress: StartupProgress) => void;
}

export class DatabaseUpgradeController {
  private readonly runtimeManager = new DatabaseRuntimeManager();

  constructor(private readonly dependencies: DatabaseUpgradeDependencies) {}

  async prepareConfiguredDatabase(): Promise<void> {
    const setup = getSetupInfo();
    if (setup.needsSetup || setup.current.engine === 'pglite') return;
    const database = getDatabaseRuntimeConfig();
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'database',
      title: '正在准备本机数据库',
      message: '正在检查 Postgres；如现有 Docker Desktop 或数据库容器未启动，PMBrain 会安全启动它们，但不会创建、删除或重建容器。',
    });
    const result = await this.runtimeManager.ensureReady({
      engine: database.engine,
      databaseUrl: database.databaseUrl,
      configuredContainerName: database.configuredContainerName,
    });
    if (result.kind === 'docker-postgres') {
      saveDetectedDockerContainerName(result.containerName);
      this.dependencies.getLogger()?.write('desktop', `Docker Postgres ready: ${result.containerName}; started=${result.containerStarted}`);
    } else {
      this.dependencies.getLogger()?.write('desktop', `Postgres runtime ready: ${result.kind}`);
    }
  }

  async migrateConfiguredInstallation(): Promise<boolean> {
    if (!needsDesktopMigration(app.getVersion())) return false;
    const setup = getSetupInfo();
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'migration',
      title: '正在升级现有 PMBrain 数据库',
      message: setup.current.engine === 'pglite'
        ? '检测到桌面版本更新，将由唯一的 sidecar 连接完成 PGLite 兼容迁移和健康检查。'
        : '检测到桌面版本更新，正在执行兼容迁移。不会删除知识库或原始资料，请不要关闭窗口。',
    });
    if (setup.current.engine === 'pglite') {
      await this.dependencies.pgliteBackup.ensureUpgradeBackup(setup.current.databasePath);
      this.dependencies.getLogger()?.write('desktop', `PGLite migrations delegated to sidecar for desktop ${app.getVersion()}`);
      await this.dependencies.syncModelDefaults();
      return true;
    }
    this.dependencies.getLogger()?.write('desktop', `Applying migrations for desktop ${app.getVersion()}`);
    await runCliChecked(this.dependencies.runtime(), DESKTOP_MIGRATION_ARGS);
    await this.dependencies.syncModelDefaults();
    return true;
  }

  /**
   * Repair the interrupted first-activation state before sidecar startup.
   * This is deliberately a status-first flow: only a dimension mismatch with
   * zero stored vectors may use the existing empty-only alignment command.
   */
  async reconcileConfiguredEmbeddingIndex(): Promise<void> {
    const setup = getSetupInfo();
    const model = setup.current.embeddingModel?.trim();
    if (setup.needsSetup || !model) return;

    const statusResult = await runCliChecked(this.dependencies.runtime(), [
      'models', 'embedding-dimension-status', '--json',
    ], {}, chunk => this.dependencies.getLogger()?.write('embedding-preflight:stderr', chunk));
    const status = parseLastJson<EmbeddingDimensionStatusCliResult>(
      statusResult.stdout,
      '向量维度状态检查返回格式无效，已停止自动修复。',
    );
    const existingEmbeddings = Number(status.existing_embeddings ?? 0);
    this.dependencies.getLogger()?.write(
      'desktop',
      `Embedding dimension preflight: status=${status.status ?? 'unknown'} `
        + `model=${status.embedding_model ?? model} `
        + `configured=${status.configured_dimensions ?? 'unknown'} `
        + `column=${status.column_dimensions ?? 'unknown'} `
        + `existing=${existingEmbeddings}`,
    );

    if (status.status === 'aligned' || status.status === 'not_configured') return;
    if (status.status !== 'mismatch') {
      this.dependencies.getLogger()?.write(
        'desktop',
        `Embedding dimension preflight did not auto-repair status=${status.status ?? 'unknown'}; `
          + 'the database and source content were left unchanged.',
      );
      return;
    }

    const hasValidDimensions = Number.isInteger(status.column_dimensions)
      && (status.column_dimensions ?? 0) > 0
      && Number.isInteger(status.configured_dimensions)
      && (status.configured_dimensions ?? 0) > 0;
    if (!hasValidDimensions || !Number.isInteger(existingEmbeddings) || existingEmbeddings < 0) {
      this.dependencies.getLogger()?.write(
        'desktop',
        'Embedding dimension preflight returned invalid mismatch data; automatic repair was refused.',
      );
      return;
    }

    if (existingEmbeddings > 0) {
      this.dependencies.getLogger()?.write(
        'desktop',
        `Embedding dimension mismatch remains at vector(${status.column_dimensions}) `
          + `while ${status.existing_embeddings} derived vector(s) exist for ${model}; `
          + 'automatic clearing was refused. Explicit model-rebuild confirmation is required.',
      );
      return;
    }

    if (setup.current.engine === 'pglite') {
      await this.dependencies.pgliteBackup.ensureUpgradeBackup(setup.current.databasePath);
    }
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'migration',
      title: '正在修复搜索索引兼容性',
      message: `检测到空向量库的维度不一致（数据库 ${status.column_dimensions} 维，配置 ${status.configured_dimensions} 维），正在安全对齐。知识页面、文本分块和原始资料不会被修改。`,
    });
    const aligned = await runCliChecked(this.dependencies.runtime(), [
      'models', 'align-embedding-dimension', '--yes', '--json', '--empty-only',
    ]);
    const result = parseLastJson<{ status?: string }>(
      aligned.stdout,
      '向量维度自动修复返回格式无效，请保留日志并重试。',
    );
    if (result.status !== 'aligned' && result.status !== 'already_aligned') {
      throw new Error(`向量维度自动修复未完成（状态：${result.status ?? 'unknown'}）。`);
    }
    this.dependencies.getLogger()?.write(
      'desktop',
      `Embedding dimension preflight repaired an empty vector store from vector(${status.column_dimensions}) `
        + `to vector(${status.configured_dimensions}) for ${model}.`,
    );
  }
}
