import { app, type BrowserWindow } from 'electron';
import { ensureBootstrapToken, getDatabaseRuntimeConfig, getSetupInfo, markDesktopMigration, needsDesktopMigration } from '../config-manager.js';
import type { CliRuntime } from '../cli-runner.js';
import { findAvailablePort } from '../port-manager.js';
import { precheckPgliteLock } from '../pglite-lock-precheck.js';
import { SidecarManager, type SidecarState } from '../sidecar-manager.js';
import type { DesktopLogger } from '../logs.js';
import {
  GIN_REPAIR_DB_UNUSABLE_MESSAGE,
  GIN_REPAIR_PROGRESS_MESSAGE,
  GIN_REPAIR_SUCCESS_MESSAGE,
} from '../../../../src/core/pglite-gin-repair.js';

interface StartupProgress {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
}

export interface SidecarControllerDependencies {
  runtime: () => CliRuntime;
  getLogger: () => DesktopLogger | null;
  getMainWindow: () => BrowserWindow | null;
  getSetupInProgress: () => boolean;
  ensureRuntimeReady: () => Promise<void>;
  prepareConfiguredDatabase: () => Promise<void>;
  migrateConfiguredInstallation: () => Promise<boolean>;
  reconcileConfiguredEmbeddingIndex: () => Promise<void>;
  pendingPgliteBackupPath: () => string | null;
  prunePgliteUpgradeBackups: () => Promise<void>;
  reconcileLan: () => Promise<unknown>;
  stopLan: () => Promise<void>;
  sendSystemSettingsState: () => void;
  sendStartupProgress: (progress: StartupProgress) => void;
  hideStartupProgress: () => void;
}

export class SidecarController {
  private manager: SidecarManager | null = null;
  private stateValue: SidecarState | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private startupPromise: Promise<void> | null = null;
  private retryPromise: Promise<string> | null = null;
  private readyPromise: Promise<SidecarManager> | null = null;

  constructor(private readonly dependencies: SidecarControllerDependencies) {}

  get current(): SidecarManager | null {
    return this.manager;
  }

  get state(): SidecarState | null {
    return this.stateValue;
  }

  reportFailure(message: string): void {
    this.sendState({ phase: 'failed', port: this.manager?.port ?? 3131, message });
  }

  private sendState(state: SidecarState): void {
    this.stateValue = state;
    this.dependencies.getMainWindow()?.webContents.send('desktop:state', state);
  }

  private queueTransition<T>(transition: () => Promise<T>): Promise<T> {
    const pending = this.lifecycleQueue.then(transition, transition);
    this.lifecycleQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async startOnce(openAdmin: boolean): Promise<void> {
    const mainWindow = this.dependencies.getMainWindow();
    const logger = this.dependencies.getLogger();
    if (!mainWindow || !logger) return;
    await this.dependencies.ensureRuntimeReady();
    const existing = this.manager;
    if (existing) {
      await existing.start();
      await this.dependencies.reconcileLan();
      return;
    }
    if (getDatabaseRuntimeConfig().engine === 'pglite') {
      const precheck = precheckPgliteLock(getSetupInfo().current.databasePath);
      if (precheck.blocked && precheck.message) {
        logger.write('desktop', `PGLite lock precheck blocked startup: holder PID ${precheck.holderPid}`);
        this.sendState({ phase: 'failed', port: this.manager?.port ?? 3131, message: precheck.message });
        this.dependencies.hideStartupProgress();
        throw new Error(precheck.message);
      }
    }
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'sidecar',
      title: '正在启动 PMBrain 本地服务',
      message: '正在分配本机端口并启动 sidecar，请保持窗口开启。',
    });
    try {
      const { resolveSidecarHealthTimeoutMs, POST_UPGRADE_HEALTH_TIMEOUT_MS } = await import('../startup/post-upgrade-startup.js');
      const upgradePending = needsDesktopMigration(app.getVersion());
      const healthTimeoutMs = resolveSidecarHealthTimeoutMs({
        engine: getDatabaseRuntimeConfig().engine,
        upgradePending,
      });
      const port = await findAvailablePort();
      const bootstrapToken = ensureBootstrapToken();
      let manager!: SidecarManager;
      manager = new SidecarManager({
        ...this.dependencies.runtime(),
        port,
        bootstrapToken,
        clientVersion: app.getVersion(),
        healthTimeoutMs,
        logger,
        onStderr: (_chunk, recent) => {
          if (this.manager !== manager) return;
          if (recent.includes(GIN_REPAIR_DB_UNUSABLE_MESSAGE)) {
            this.dependencies.sendStartupProgress({
              visible: true,
              stage: 'database',
              title: '数据库无法打开',
              message: GIN_REPAIR_DB_UNUSABLE_MESSAGE,
            });
            return;
          }
          if (recent.includes(GIN_REPAIR_SUCCESS_MESSAGE)) {
            this.dependencies.sendStartupProgress({
              visible: true,
              stage: 'sidecar',
              title: GIN_REPAIR_SUCCESS_MESSAGE,
              message: GIN_REPAIR_SUCCESS_MESSAGE,
            });
            return;
          }
          if (recent.includes(GIN_REPAIR_PROGRESS_MESSAGE)) {
            this.dependencies.sendStartupProgress({
              visible: true,
              stage: 'sidecar',
              title: '正在修复搜索索引',
              message: GIN_REPAIR_PROGRESS_MESSAGE,
            });
          }
        },
        onState: state => {
          if (this.manager !== manager) return;
          this.sendState(state);
          if (state.phase === 'starting') {
            const waitHint = healthTimeoutMs >= POST_UPGRADE_HEALTH_TIMEOUT_MS
              ? '升级后首次打开较大知识库可能需要几分钟，请不要关闭窗口。'
              : healthTimeoutMs >= 60_000
                ? `正在打开本机数据库，最长可能需要约 ${Math.round(healthTimeoutMs / 60_000)} 分钟。`
                : 'sidecar 已启动，PMBrain 正在检查数据库与 HTTP 服务。';
            this.dependencies.sendStartupProgress({
              visible: true,
              stage: 'health',
              title: '正在等待本地服务健康检查',
              message: waitHint,
            });
          } else if (state.phase === 'ready' || state.phase === 'failed') {
            this.dependencies.hideStartupProgress();
          }
          if (state.phase === 'failed' || state.phase === 'stopped') {
            void this.dependencies.stopLan().then(this.dependencies.sendSystemSettingsState);
          }
          if (openAdmin && state.phase === 'ready') this.dependencies.getMainWindow()?.webContents.send('desktop:navigate', 'import');
        },
      });
      this.manager = manager;
      await manager.start();
      if (this.manager !== manager) {
        await manager.stop();
        return;
      }
      await this.dependencies.reconcileLan();
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const database = getDatabaseRuntimeConfig();
      const databasePath = getSetupInfo().current.databasePath;
      const failure = this.manager?.lastFailure;
      if (failure) {
        logger.write(
          'desktop',
          `sidecar failure details: exitCode=${failure.exitCode ?? 'none'} signal=${failure.signal ?? 'none'} pid=${failure.sidecarPid ?? 'none'} stderr=${failure.recentStderr?.trim() || '(empty)'}`,
        );
      }
      let message = database.engine === 'pglite' && databasePath
        ? `${rawMessage}\nPGLite 数据库路径：${databasePath}`
        : rawMessage;
      const pendingBackupPath = this.dependencies.pendingPgliteBackupPath();
      if (database.engine === 'pglite' && pendingBackupPath) {
        message +=
          `\n升级前冷备已验证并保留：${pendingBackupPath}`
          + '\nPMBrain 不会自动覆盖当前数据库。请保留此备份和桌面日志，不要连续重复迁移。';
      }
      logger.write('desktop', message);
      this.sendState({ phase: 'failed', port: this.manager?.port ?? 3131, message });
      this.dependencies.hideStartupProgress();
      throw new Error(message, { cause: error });
    }
  }

  async start(openAdmin: boolean): Promise<void> {
    if (this.startupPromise) {
      await this.startupPromise;
      if (openAdmin && this.manager && this.stateValue?.phase === 'ready') {
        this.dependencies.getMainWindow()?.webContents.send('desktop:navigate', 'import');
      }
      return;
    }
    const pending = this.queueTransition(() => this.startOnce(openAdmin));
    this.startupPromise = pending;
    try {
      await pending;
    } finally {
      if (this.startupPromise === pending) this.startupPromise = null;
    }
  }

  private async stopNow(): Promise<void> {
    await this.dependencies.stopLan();
    const active = this.manager;
    this.manager = null;
    if (active) await active.stop();
  }

  stop(): Promise<void> {
    return this.queueTransition(() => this.stopNow());
  }

  async restartForRetry(): Promise<string> {
    if (this.retryPromise) return this.retryPromise;
    const pending = this.queueTransition(async () => {
      if (this.dependencies.getSetupInProgress()) throw new Error('PMBrain 正在应用基础配置，请等待完成。');
      await this.dependencies.ensureRuntimeReady();
      await this.stopNow();
      await this.dependencies.prepareConfiguredDatabase();
      const retrySetup = getSetupInfo();
      const migrationRequired = retrySetup.current.engine === 'pglite'
        && needsDesktopMigration(app.getVersion());
      if (!migrationRequired) {
        await this.dependencies.reconcileConfiguredEmbeddingIndex();
      }
      await this.startOnce(false);
      const started = this.manager;
      if (!started) throw new Error('PMBrain 本地服务未能启动。');
      if (migrationRequired) {
        markDesktopMigration(app.getVersion());
        await this.dependencies.prunePgliteUpgradeBackups();
      }
      return started.createAdminLink();
    });
    this.retryPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.retryPromise === pending) this.retryPromise = null;
    }
  }

  async withPausedForPgliteBackupRestore<T>(operation: () => Promise<T>): Promise<T> {
    const shouldRestart = Boolean(this.manager && getSetupInfo().current.engine === 'pglite');
    if (shouldRestart) await this.stop();
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'database',
      title: '正在恢复数据库备份',
      message: shouldRestart
        ? '恢复需要独占访问当前数据库，桌面端已暂停本地服务；完成后会自动重启并执行健康检查。'
        : '正在用已验证的升级备份替换当前数据库。',
    });
    let operationError: unknown;
    try {
      return await operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (shouldRestart) {
        try {
          await this.start(false);
        } catch (restartError) {
          if (!operationError) throw restartError;
          this.dependencies.getLogger()?.write(
            'desktop',
            `备份恢复失败后，本地服务恢复也失败：${restartError instanceof Error ? restartError.message : String(restartError)}`,
          );
        }
      } else {
        this.dependencies.hideStartupProgress();
      }
    }
  }

  async withPausedForModelConfig<T>(operation: () => Promise<T>): Promise<T> {
    const shouldRestart = Boolean(this.manager && getSetupInfo().current.engine === 'pglite');
    if (shouldRestart) await this.stop();
    this.dependencies.sendStartupProgress({
      visible: true,
      stage: 'sidecar',
      title: '正在安全保存模型路由',
      message: shouldRestart
        ? 'PGLite 配置需要独占访问，桌面端已暂停本地服务；完成后会自动重启并执行健康检查。'
        : '正在保存 PMBrain 的任务层级模型配置。',
    });
    let operationError: unknown;
    try {
      return await operation();
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      if (shouldRestart) {
        try {
          await this.start(false);
        } catch (restartError) {
          if (!operationError) throw restartError;
          this.dependencies.getLogger()?.write(
            'desktop',
            `模型路由操作失败后，本地服务恢复也失败：${restartError instanceof Error ? restartError.message : String(restartError)}`,
          );
        }
      } else {
        this.dependencies.hideStartupProgress();
      }
    }
  }

  async ensureReady(): Promise<SidecarManager> {
    if (this.manager && this.stateValue?.phase === 'ready') return this.manager;
    if (getSetupInfo().needsSetup) throw new Error('请先完成 PMBrain 基础配置。');
    if (this.dependencies.getSetupInProgress()) throw new Error('PMBrain 正在应用基础配置，请等待完成后再打开管理台。');
    if (this.readyPromise) return this.readyPromise;

    const pending = (async () => {
      const {
        POST_UPGRADE_READY_ATTEMPTS,
        POST_UPGRADE_SETTLE_MS,
        postUpgradeRetryDelayMs,
        sanitizeStartupFailureMessage,
        sleep,
      } = await import('../startup/post-upgrade-startup.js');

      await this.dependencies.ensureRuntimeReady();
      await this.dependencies.prepareConfiguredDatabase();
      const setup = getSetupInfo();
      const migrationRequired = await this.dependencies.migrateConfiguredInstallation();
      // PGLite migrations are intentionally performed by the sidecar's sole
      // database owner. Inspect only after that migration has completed on a
      // later startup; never let the preflight CLI open a pending upgrade DB.
      if (!(migrationRequired && setup.current.engine === 'pglite')) {
        await this.dependencies.reconcileConfiguredEmbeddingIndex();
      }
      if (migrationRequired && setup.current.engine !== 'pglite') markDesktopMigration(app.getVersion());

      // Upgrade cold-backup holds an exclusive PGLite lock. Give it a short
      // settle window so the first sidecar start does not race the lock.
      if (migrationRequired) {
        this.dependencies.sendStartupProgress({
          visible: true,
          stage: 'sidecar',
          title: '升级完成，正在启动本地服务',
          message: '升级前冷备已完成。PMBrain 正在启动本地服务并自动重试，请稍候，无需手动点击重启。',
        });
        await sleep(POST_UPGRADE_SETTLE_MS);
      }

      const maxAttempts = migrationRequired ? POST_UPGRADE_READY_ATTEMPTS : 1;
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (this.manager && this.stateValue?.phase !== 'ready') {
            // Clear a failed/half-started manager before another attempt.
            await this.stopNow();
          }
          if (!this.manager || this.stateValue?.phase !== 'ready') {
            await this.start(false);
          }
          if (this.manager && this.stateValue?.phase === 'ready') {
            if (migrationRequired && setup.current.engine === 'pglite') {
              markDesktopMigration(app.getVersion());
              await this.dependencies.prunePgliteUpgradeBackups();
            }
            return this.manager;
          }
          lastError = new Error('PMBrain 本地服务尚未就绪。');
        } catch (error) {
          lastError = error;
          const raw = error instanceof Error ? error.message : String(error);
          this.dependencies.getLogger()?.write(
            'desktop',
            `ensureReady attempt ${attempt}/${maxAttempts} failed: ${raw}`,
          );
          try {
            await this.stopNow();
          } catch {
            // best-effort cleanup between retries
          }
        }
        if (attempt < maxAttempts) {
          this.dependencies.sendStartupProgress({
            visible: true,
            stage: 'sidecar',
            title: `正在自动重试本地服务（${attempt + 1}/${maxAttempts}）`,
            message: '升级后首次启动偶发未就绪，PMBrain 正在自动重试，成功后会直接进入管理台。',
          });
          await sleep(postUpgradeRetryDelayMs(attempt));
        }
      }

      const message = sanitizeStartupFailureMessage(
        lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown'),
      );
      throw new Error(message, { cause: lastError });
    })();
    this.readyPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.readyPromise === pending) this.readyPromise = null;
    }
  }
}
