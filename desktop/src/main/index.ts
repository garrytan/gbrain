import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { join } from 'node:path';
import { DesktopLogger } from './logs.js';
import { findAvailablePort } from './port-manager.js';
import { SidecarManager, type SidecarState } from './sidecar-manager.js';
import { runCli, runCliChecked, type CliRuntime } from './cli-runner.js';
import { listDesktopProviderModels, type DesktopModelTouchpoint } from './model-catalog.js';
import {
  readAdvancedModelConfig,
  writeAdvancedModelConfig,
  type AdvancedModelTier,
} from './advanced-model-config.js';
import {
  ensureBootstrapToken,
  getSetupInfo,
  markDesktopMigration,
  needsDesktopMigration,
  normalizeDesktopTheme,
  restoreConfig,
  saveDesktopTheme,
  saveSetup,
  updateSavedEmbeddingDimension,
  type DesktopTheme,
  type SetupPayload,
} from './config-manager.js';
import {
  configureIntegration,
  listIntegrations,
  type CredentialKind,
  type IntegrationClient,
} from './integration-manager.js';
import { UpdateManager, type UpdateState } from './update-manager.js';
import { updateDesktopVersionHistory, type DesktopVersionHistory } from './version-history.js';

let mainWindow: BrowserWindow | null = null;
let sidecar: SidecarManager | null = null;
let logger: DesktopLogger | null = null;
let currentState: SidecarState | null = null;
let updateManager: UpdateManager | null = null;
let desktopVersionHistory: DesktopVersionHistory = { current: '' };
let quitting = false;
const DESKTOP_MIGRATION_ARGS = ['apply-migrations', '--yes', '--non-interactive', '--no-autopilot-install'];

interface StartupProgress {
  visible: boolean;
  stage: 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
}

interface DesktopThemeState {
  source: DesktopTheme;
  resolved: 'light' | 'dark';
}

let startupProgress: StartupProgress = {
  visible: false,
  stage: 'sidecar',
  title: '',
  message: '',
};

function themeState(source = normalizeDesktopTheme(nativeTheme.themeSource)): DesktopThemeState {
  return { source, resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' };
}

function applyDesktopTheme(source: DesktopTheme): DesktopThemeState {
  nativeTheme.themeSource = normalizeDesktopTheme(source);
  const state = themeState(source);
  mainWindow?.webContents.send('desktop:theme-state', state);
  return state;
}

function sendStartupProgress(progress: StartupProgress): void {
  startupProgress = progress;
  mainWindow?.webContents.send('desktop:startup-progress', progress);
}

function hideStartupProgress(): void {
  sendStartupProgress({ ...startupProgress, visible: false });
}

function runtime(): CliRuntime {
  return {
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  };
}

function sendState(state: SidecarState): void {
  currentState = state;
  mainWindow?.webContents.send('desktop:state', state);
}

async function showShell(): Promise<void> {
  if (!mainWindow) return;
  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

async function startSidecar(openAdmin: boolean): Promise<void> {
  if (!mainWindow || !logger) return;
  sendStartupProgress({
    visible: true,
    stage: 'sidecar',
    title: '正在启动 PMBrain 本地服务',
    message: '正在分配本机端口并启动 sidecar，请保持窗口开启。',
  });
  try {
    const port = await findAvailablePort();
    const bootstrapToken = ensureBootstrapToken();
    sidecar = new SidecarManager({
      ...runtime(),
      port,
      bootstrapToken,
      clientVersion: app.getVersion(),
      logger,
      onState: (state) => {
        sendState(state);
        if (state.phase === 'starting') {
          sendStartupProgress({
            visible: true,
            stage: 'health',
            title: '正在等待本地服务健康检查',
            message: 'sidecar 已启动，PMBrain 正在检查数据库与 HTTP 服务；首次启动最长可能需要约 45 秒。',
          });
        } else if (state.phase === 'ready' || state.phase === 'failed') {
          hideStartupProgress();
        }
        if (openAdmin && state.phase === 'ready') void mainWindow?.loadURL(state.adminUrl);
      },
    });
    await sidecar.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.write('desktop', message);
    sendState({ phase: 'failed', port: sidecar?.port ?? 3131, message });
    hideStartupProgress();
    throw error;
  }
}

async function stopSidecar(): Promise<void> {
  const active = sidecar;
  sidecar = null;
  if (active) await active.stop();
}

async function withSidecarPausedForModelConfig<T>(operation: () => Promise<T>): Promise<T> {
  const shouldRestart = Boolean(sidecar && getSetupInfo().current.engine === 'pglite');
  if (shouldRestart) await stopSidecar();
  sendStartupProgress({
    visible: true,
    stage: 'sidecar',
    title: '正在安全读取模型路由',
    message: shouldRestart
      ? 'PGLite 配置需要独占访问，桌面端已暂停本地服务；完成后会自动重启并执行健康检查。'
      : '正在读取 PMBrain 的任务层级模型配置。',
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
        await startSidecar(false);
      } catch (restartError) {
        if (!operationError) throw restartError;
        logger?.write('desktop', `模型路由操作失败后，本地服务恢复也失败：${restartError instanceof Error ? restartError.message : String(restartError)}`);
      }
    } else {
      hideStartupProgress();
    }
  }
}

async function migrateConfiguredInstallation(): Promise<void> {
  if (!needsDesktopMigration(app.getVersion())) return;
  sendStartupProgress({
    visible: true,
    stage: 'migration',
    title: '正在升级现有 PMBrain 数据库',
    message: '检测到桌面版本更新，正在执行兼容迁移。不会删除知识库或原始资料，请不要关闭窗口。',
  });
  logger?.write('desktop', `Applying migrations for desktop ${app.getVersion()}`);
  await runCliChecked(runtime(), DESKTOP_MIGRATION_ARGS);
  await syncModelDefaultsToDatabase();
  markDesktopMigration(app.getVersion());
}

async function syncModelDefaultsToDatabase(opts: { resetAdvanced?: boolean } = {}): Promise<void> {
  const chatModel = getSetupInfo().current.chatModel?.trim();
  if (!chatModel) return;
  if (opts.resetAdvanced) {
    await runCliChecked(runtime(), ['config', 'unset', '--pattern', 'models.tier.']);
    await runCliChecked(runtime(), ['config', 'unset', '--pattern', 'models.dream.']);
  }
  await runCliChecked(runtime(), ['config', 'set', 'chat_model', chatModel]);
  await runCliChecked(runtime(), ['config', 'set', 'models.default', chatModel]);
}

async function applySetup(payload: SetupPayload) {
  const hadRunningSidecar = Boolean(sidecar);
  await stopSidecar();
  const saved = saveSetup(payload);
  try {
    if (saved.needsEmbeddingDimensionProbe) {
      const probe = await runCliChecked(runtime(), ['models', 'detect-embedding-dimension', '--json']);
      const result = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1) || '{}') as { dimensions?: number };
      if (!Number.isInteger(result.dimensions) || (result.dimensions ?? 0) <= 0) {
        throw new Error('无法从向量模型响应中判断有效维度。');
      }
      updateSavedEmbeddingDimension(saved.snapshot.path, result.dimensions!);
      saved.config.embedding_dimensions = result.dimensions!;
    }
    sendStartupProgress({
      visible: true,
      stage: 'migration',
      title: '正在应用数据库迁移',
      message: '正在确保现有数据库结构与当前桌面版本兼容。知识库与原始资料不会被删除。',
    });
    await runCliChecked(runtime(), DESKTOP_MIGRATION_ARGS);
    await syncModelDefaultsToDatabase({ resetAdvanced: payload.resetAdvancedModelRouting === true });
    const knowledgeDirectory = saved.config.desktop?.knowledge_directory;
    const sourceId = saved.config.desktop?.knowledge_source_id;
    if (knowledgeDirectory && sourceId) {
      const add = await runCli(runtime(), [
        'sources', 'add', sourceId, '--path', knowledgeDirectory,
        '--name', '桌面知识库', '--federated',
      ]);
      if (add.code !== 0 && !/already exists|duplicate|已存在|already registered/i.test(`${add.stderr}\n${add.stdout}`)) {
        throw new Error((add.stderr || add.stdout).trim());
      }
      await runCliChecked(runtime(), ['sources', 'default', sourceId]);
    }
    markDesktopMigration(app.getVersion());
    // Keep this as the final fallible setup step: once the DB column is
    // aligned, no later config rollback may restore an incompatible width.
    await runCliChecked(runtime(), ['models', 'align-embedding-dimension', '--yes', '--json']);
  } catch (error) {
    restoreConfig(saved.snapshot);
    if (hadRunningSidecar && saved.snapshot.existed) {
      await startSidecar(false).catch(() => undefined);
    } else {
      hideStartupProgress();
    }
    throw error;
  }
  await startSidecar(false);
  applyDesktopTheme(getSetupInfo().current.theme);
  return {
    setup: getSetupInfo(),
    integrations: listIntegrations(sidecar?.port),
    port: sidecar?.port,
    mcpUrl: sidecar?.mcpUrl,
    backup: saved.backup,
  };
}

type SettingsPanel = 'basic' | 'models' | 'integrations' | 'updates';

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'PMBrain',
      submenu: [
        { label: '打开管理控制台', click: () => void openAdmin() },
        { label: '基础配置', click: () => void openSettingsPanel('basic') },
        { label: '模型配置', click: () => void openSettingsPanel('models') },
        { label: 'MCP 接入', click: () => void openSettingsPanel('integrations') },
        { label: '软件更新', click: () => void openUpdates() },
        { type: 'separator' },
        { label: '打开日志目录', click: () => logger && void shell.openPath(logger.directory) },
        { type: 'separator' },
        { role: 'quit', label: '退出 PMBrain' },
      ],
    },
    { role: 'viewMenu', label: '视图' },
  ]));
}

async function openSettingsPanel(panel: SettingsPanel): Promise<void> {
  await showShell();
  mainWindow?.webContents.send('desktop:show-panel', panel);
}

async function openUpdates(): Promise<void> {
  await openSettingsPanel('updates');
  await updateManager?.check();
}

function initializeUpdater(): void {
  if (!logger) return;
  updateManager = new UpdateManager({
    updater: autoUpdater,
    packaged: app.isPackaged,
    currentVersion: app.getVersion(),
    previousVersion: desktopVersionHistory.previous,
    logger,
    beforeInstall: async () => {
      updateManager?.stop();
      await stopSidecar();
      logger?.write('updater', 'Sidecar stopped; handing control to NSIS updater.');
      quitting = true;
      logger?.close();
    },
    onState: (state) => {
      mainWindow?.webContents.send('desktop:update-state', state);
      if (state.phase === 'downloaded') void promptInstall(state);
    },
  });
  updateManager.start();
}

async function promptInstall(state: UpdateState): Promise<void> {
  if (!mainWindow) return;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'PMBrain 更新已就绪',
    message: `版本 ${state.availableVersion ?? ''} 已下载完成`,
    detail: `${state.fileName ? `安装文件：${state.fileName}\n` : ''}立即安装会先安全停止 PMBrain 本地服务，安装完成后自动重新启动、执行数据库迁移并检查健康状态。`,
    buttons: ['立即安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
  });
  if (result.response === 0) await updateManager?.install();
}

async function openAdmin(): Promise<void> {
  if (!mainWindow) return;
  if (!sidecar) await startSidecar(false);
  const url = await sidecar!.createAdminLink();
  await mainWindow.loadURL(url);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#101312' : '#f5f7f4',
    title: 'PMBrain',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await showShell();
  if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  if (!getSetupInfo().needsSetup) {
    try {
      await migrateConfiguredInstallation();
      if (sidecar && currentState?.phase === 'ready') {
        await mainWindow.loadURL(await sidecar.createAdminLink());
      } else {
        await startSidecar(true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.write('desktop', message);
      sendState({ phase: 'failed', port: sidecar?.port ?? 3131, message });
      hideStartupProgress();
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else {
      void createWindow();
    }
  });

  app.on('activate', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    } else {
      void createWindow();
    }
  });

  app.whenReady().then(async () => {
    logger = new DesktopLogger(app.getPath('userData'));
    const initialSetup = getSetupInfo();
    desktopVersionHistory = updateDesktopVersionHistory(
      join(app.getPath('userData'), 'version-history.json'),
      app.getVersion(),
      initialSetup.current.lastMigratedVersion,
    );
    applyDesktopTheme(initialSetup.current.theme);
    nativeTheme.on('updated', () => {
      mainWindow?.webContents.send('desktop:theme-state', themeState());
    });
    installMenu();
    ipcMain.handle('desktop:get-state', () => currentState);
    ipcMain.handle('desktop:get-startup-progress', () => startupProgress);
    ipcMain.handle('desktop:get-theme', () => themeState(getSetupInfo().current.theme));
    ipcMain.handle('desktop:set-theme', (_event, value: DesktopTheme) => {
      const source = normalizeDesktopTheme(value);
      const backup = saveDesktopTheme(source);
      return { ...applyDesktopTheme(source), backup };
    });
    ipcMain.handle('desktop:get-update-state', () => updateManager?.currentState ?? null);
    ipcMain.handle('desktop:get-setup', () => ({ setup: getSetupInfo(), integrations: listIntegrations(sidecar?.port), port: sidecar?.port, mcpUrl: sidecar?.mcpUrl }));
    ipcMain.handle('desktop:choose-directory', async (_event, initialPath?: string) => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        defaultPath: initialPath,
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('desktop:get-provider-models', (_event, provider: string, touchpoint: DesktopModelTouchpoint) => {
      return listDesktopProviderModels(provider, touchpoint);
    });
    ipcMain.handle(
      'desktop:get-advanced-model-config',
      () => withSidecarPausedForModelConfig(() => readAdvancedModelConfig(runtime())),
    );
    ipcMain.handle(
      'desktop:save-advanced-model-config',
      (_event, values: Partial<Record<AdvancedModelTier, string>>) => withSidecarPausedForModelConfig(
        () => writeAdvancedModelConfig(runtime(), values),
      ),
    );
    ipcMain.handle('desktop:save-setup', (_event, payload: SetupPayload) => applySetup(payload));
    ipcMain.handle('desktop:configure-integration', async (_event, client: IntegrationClient, kind: CredentialKind) => {
      if (!sidecar) throw new Error('请先完成数据库配置并启动 PMBrain。');
      return configureIntegration(sidecar, client, kind);
    });
    ipcMain.handle('desktop:copy', (_event, value: string) => clipboard.writeText(value));
    ipcMain.handle('desktop:open-admin', () => openAdmin());
    ipcMain.handle('desktop:check-updates', () => updateManager?.check());
    ipcMain.handle('desktop:install-update', () => updateManager?.install());
    ipcMain.handle('desktop:open-previous-release', async () => {
      const previous = desktopVersionHistory.previous;
      if (!previous) throw new Error('当前没有可用的上一版本记录。');
      await shell.openExternal(`https://github.com/zhengyunhui123-dev/PMBrain/releases/tag/v${previous}`);
    });
    ipcMain.handle('desktop:retry', async () => {
      await showShell();
      if (sidecar) {
        const url = await sidecar.restart();
        await mainWindow?.loadURL(url);
      } else if (!getSetupInfo().needsSetup) {
        await migrateConfiguredInstallation();
        await startSidecar(true);
      }
    });
    ipcMain.handle('desktop:open-logs', () => logger && shell.openPath(logger.directory));
    ipcMain.handle('desktop:quit', () => app.quit());
    await createWindow();
    initializeUpdater();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    updateManager?.stop();
    if (!sidecar) {
      logger?.close();
      return;
    }
    event.preventDefault();
    quitting = true;
    void stopSidecar().finally(() => {
      logger?.close();
      app.exit(0);
    });
  });

  app.on('window-all-closed', () => app.quit());
}
