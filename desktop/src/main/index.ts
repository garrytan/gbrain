import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import { join } from 'node:path';
import { DesktopLogger } from './logs.js';
import { findAvailablePort } from './port-manager.js';
import { SidecarManager, type SidecarState } from './sidecar-manager.js';
import { runCli, runCliChecked, type CliRuntime } from './cli-runner.js';
import { listDesktopProviderModels, type DesktopModelTouchpoint } from './model-catalog.js';
import {
  ensureBootstrapToken,
  getSetupInfo,
  markDesktopMigration,
  needsDesktopMigration,
  restoreConfig,
  saveSetup,
  updateSavedEmbeddingDimension,
  type SetupPayload,
} from './config-manager.js';
import {
  configureIntegration,
  listIntegrations,
  type CredentialKind,
  type IntegrationClient,
} from './integration-manager.js';
import { UpdateManager, type UpdateState } from './update-manager.js';

let mainWindow: BrowserWindow | null = null;
let sidecar: SidecarManager | null = null;
let logger: DesktopLogger | null = null;
let currentState: SidecarState | null = null;
let updateManager: UpdateManager | null = null;
let quitting = false;
const DESKTOP_MIGRATION_ARGS = ['apply-migrations', '--yes', '--non-interactive', '--no-autopilot-install'];

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
        if (openAdmin && state.phase === 'ready') void mainWindow?.loadURL(state.adminUrl);
      },
    });
    await sidecar.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.write('desktop', message);
    sendState({ phase: 'failed', port: sidecar?.port ?? 3131, message });
    throw error;
  }
}

async function stopSidecar(): Promise<void> {
  const active = sidecar;
  sidecar = null;
  if (active) await active.stop();
}

async function migrateConfiguredInstallation(): Promise<void> {
  if (!needsDesktopMigration(app.getVersion())) return;
  logger?.write('desktop', `Applying migrations for desktop ${app.getVersion()}`);
  await runCliChecked(runtime(), DESKTOP_MIGRATION_ARGS);
  await syncModelDefaultsToDatabase();
  markDesktopMigration(app.getVersion());
}

async function syncModelDefaultsToDatabase(): Promise<void> {
  const chatModel = getSetupInfo().current.chatModel?.trim();
  if (!chatModel) return;
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
    await runCliChecked(runtime(), DESKTOP_MIGRATION_ARGS);
    await syncModelDefaultsToDatabase();
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
    }
    throw error;
  }
  await startSidecar(false);
  return {
    setup: getSetupInfo(),
    integrations: listIntegrations(sidecar?.port),
    port: sidecar?.port,
    mcpUrl: sidecar?.mcpUrl,
    backup: saved.backup,
  };
}

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'PMBrain',
      submenu: [
        { label: '打开管理控制台', click: () => void openAdmin() },
        { label: '配置与 MCP 接入', click: () => void showShell() },
        { label: '检查软件更新', click: () => void openUpdates() },
        { type: 'separator' },
        { label: '打开日志目录', click: () => logger && void shell.openPath(logger.directory) },
        { type: 'separator' },
        { role: 'quit', label: '退出 PMBrain' },
      ],
    },
    { role: 'viewMenu', label: '视图' },
  ]));
}

async function openUpdates(): Promise<void> {
  await showShell();
  mainWindow?.webContents.send('desktop:show-updates');
  await updateManager?.check();
}

function initializeUpdater(): void {
  if (!logger) return;
  updateManager = new UpdateManager({
    updater: autoUpdater,
    packaged: app.isPackaged,
    currentVersion: app.getVersion(),
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
    detail: '立即安装会先安全停止 PMBrain 本地服务，安装完成后自动重新启动、执行数据库迁移并检查健康状态。',
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
    backgroundColor: '#101312',
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
    installMenu();
    ipcMain.handle('desktop:get-state', () => currentState);
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
    ipcMain.handle('desktop:save-setup', (_event, payload: SetupPayload) => applySetup(payload));
    ipcMain.handle('desktop:configure-integration', async (_event, client: IntegrationClient, kind: CredentialKind) => {
      if (!sidecar) throw new Error('请先完成数据库配置并启动 PMBrain。');
      return configureIntegration(sidecar, client, kind);
    });
    ipcMain.handle('desktop:copy', (_event, value: string) => clipboard.writeText(value));
    ipcMain.handle('desktop:open-admin', () => openAdmin());
    ipcMain.handle('desktop:check-updates', () => updateManager?.check());
    ipcMain.handle('desktop:install-update', () => updateManager?.install());
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
