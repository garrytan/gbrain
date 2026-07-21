import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron';
import { autoUpdater } from 'electron-updater';
import { join } from 'node:path';
import { DesktopLogger } from './logs.js';
import { findAvailablePort } from './port-manager.js';
import { SidecarManager, type SidecarState } from './sidecar-manager.js';
import { preflightCliRuntime, runCli, runCliChecked, type CliRuntime } from './cli-runner.js';
import { listDesktopProviderModels, type DesktopModelTouchpoint } from './model-catalog.js';
import {
  readAdvancedModelConfig,
  writeAdvancedModelConfig,
  type AdvancedModelTier,
} from './advanced-model-config.js';
import {
  ensureBootstrapToken,
  getDatabaseRuntimeConfig,
  getDesktopPreferences,
  getSetupInfo,
  isTrayHintShown,
  markDesktopMigration,
  markTrayHintShown,
  needsDesktopMigration,
  normalizeDesktopTheme,
  restoreConfig,
  saveDesktopPreferences,
  saveDesktopTheme,
  saveDetectedDockerContainerName,
  saveSetup,
  updateSavedEmbeddingDimension,
  type DesktopTheme,
  type SetupPayload,
} from './config-manager.js';
import {
  configureIntegration,
  createSharedIntegration,
  getSharedAccessContext,
  listIntegrationsWithConnectionState,
  revokeSharedIntegration,
  smokeTestSharedIntegration,
  type CredentialKind,
  type IntegrationClient,
  type SharedIntegrationPayload,
} from './integration-manager.js';
import { UpdateManager, type UpdateState } from './update-manager.js';
import { updateDesktopVersionHistory, type DesktopVersionHistory } from './version-history.js';
import { DatabaseRuntimeManager } from './database-runtime-manager.js';
import { LanMcpGateway, type LanMcpGatewayStatus } from './lan-mcp-gateway.js';
import { listNetworkCandidates } from './network-manager.js';
import type {
  DesktopSystemSettingsPayload,
  DesktopSystemSettingsSaveResult,
  DesktopSystemSettingsState,
} from './system-settings.js';

let mainWindow: BrowserWindow | null = null;
let sidecar: SidecarManager | null = null;
let logger: DesktopLogger | null = null;
let currentState: SidecarState | null = null;
let updateManager: UpdateManager | null = null;
let tray: Tray | null = null;
let lanGateway: LanMcpGateway | null = null;
let networkMonitor: ReturnType<typeof setInterval> | null = null;
let networkWarning: string | undefined;
let selectedAddressWasUnavailable = false;
let networkCheckInFlight = false;
let gatewayTransitionQueue: Promise<void> = Promise.resolve();
let gatewayTransitionGeneration = 0;
let sidecarLifecycleQueue: Promise<void> = Promise.resolve();
let sidecarStartupPromise: Promise<void> | null = null;
let serviceReadyPromise: Promise<SidecarManager> | null = null;
let sidecarRetryPromise: Promise<string> | null = null;
let runtimePreflightPromise: Promise<void> | null = null;
let setupInProgress = false;
let trayHintShown = false;
let desktopVersionHistory: DesktopVersionHistory = { current: '' };
let quitting = false;
const databaseRuntimeManager = new DatabaseRuntimeManager();
const LAN_MONITOR_INTERVAL_MS = 5_000;
const DESKTOP_MIGRATION_ARGS = ['apply-migrations', '--yes', '--non-interactive', '--no-autopilot-install'];
const DESKTOP_RENDERER_PATH = join(__dirname, '../renderer/index.html');

interface StartupProgress {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
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

const TRAY_ICON_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARzQklUCAgICHwIZIgAAAJpSURBVFiF7ZfdS1NhHMc/62XuxR11m9aWTd2FitpYhmiNQKUoCIqkoJvAILrovqsoFvVHRBAIXQT2cl9ZGGG4iyDUYlMrXc2Zuian4WxZp4vobHNbnubZdtP37vk953e+H56X3/M8mkqLWaKE2lJKc4Bt2YJ6QYvnbDMOlwVbUxXlFl1eP49FVgkHogTHIozc8RMXExnfaNZPQdNBO33eToQafV6muSQuxHno9RF4MZcboNFj49zNHlWN12vg4nAahLwG9IKWU9e7CmoO0OftxFBRlgnQfsKJqVrdYc8moUbP3uMNmQAOl6Xg5tm8UgCsRQRIesnbsNJu/GvS8MBbnt6ayIgbBC1Gs44qu5EGdzWuI3UIG0xlqlfWOvAvWhETrIgJFmdEJl+Gef0oyJkb+7HWmRTl5wXQeMCG1WECCda+/2RpVuT9qwUAPr9b5tntN5y+1oVGUyCA1p5a2o8lV7IkwfiTIPe8owCMDwXpPd/6G3IDqXIWaDSw57CDXc1mOfZ1aVVRrnqHkZTfoaoKgCTB2OMgIf8XOab0LMlrDUwMfSQ8uQzA2rcfLM6IzI4tyf3uo/VYassLBzDlm2fKN5+1r95dzaELbYr/tek6YBC0VOw0YnWYcO6roa13NzrT9sICnLzckbYNN6OSX8n+A8gAsYiyyqWGUr1kgDl/tGgAqV7yLggHojR6bDmTuvtb6O5vUQUgHEgCyCPgG5zOem9XW3ExgW9wOhMgGorx4Kqv4AD3r4wSDcXk9ladQe/901j8IPJpIoKzYwdlRuXVTInEhTh3L43gfx5Ki2e8jCj106zYKnkh+gVjEMHNYhHKxwAAAABJRU5ErkJggg==';

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

function currentSystemSettingsState(): DesktopSystemSettingsState {
  const preferences = getDesktopPreferences();
  const candidates = listNetworkCandidates();
  const selectedCandidate = candidates.find(candidate => (
    candidate.adapterName === preferences.sharedAdapter && candidate.address === preferences.sharedIp
  ));
  const selectedAddressAvailable = selectedCandidate?.recommended === true;
  const gateway = lanGateway?.getStatus() ?? null;
  return {
    preferences,
    theme: themeState(getSetupInfo().current.theme),
    launchAtLogin: app.isReady() ? app.getLoginItemSettings(loginItemSettingsOptions()).openAtLogin : false,
    networkCandidates: candidates,
    selectedAddressAvailable,
    localMcpUrl: sidecar?.mcpUrl,
    sharedMcpUrl: preferences.networkMode === 'shared' && preferences.sharedIp
      ? `http://${preferences.sharedIp}:3131/mcp`
      : undefined,
    gateway,
    ...(networkWarning ? { warning: networkWarning } : {}),
  };
}

function sendSystemSettingsState(): DesktopSystemSettingsState {
  const state = currentSystemSettingsState();
  mainWindow?.webContents.send('desktop:system-settings-state', state);
  refreshTrayMenu();
  return state;
}

function showNotification(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title, body, icon: nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, 'base64')) }).show();
}

function markSharedResumeRequired(required: boolean): void {
  selectedAddressWasUnavailable = required;
  try {
    const current = getDesktopPreferences();
    if (current.sharedResumeRequired !== required) {
      saveDesktopPreferences({ sharedResumeRequired: required });
    }
  } catch (error) {
    logger?.write(
      'desktop',
      `Unable to persist shared resume state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function queueGatewayTransition<T>(transition: () => Promise<T>): Promise<T> {
  const pending = gatewayTransitionQueue.then(transition, transition);
  gatewayTransitionQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function stopLanGatewayNow(clear = true): Promise<void> {
  const active = lanGateway;
  if (clear) lanGateway = null;
  if (active) await active.stop();
}

function stopLanGateway(clear = true): Promise<void> {
  gatewayTransitionGeneration += 1;
  return queueGatewayTransition(() => stopLanGatewayNow(clear));
}

function reconcileLanGateway(): Promise<LanMcpGatewayStatus | null> {
  const generation = ++gatewayTransitionGeneration;
  return queueGatewayTransition(() => reconcileLanGatewayNow(generation));
}

async function reconcileLanGatewayNow(generation: number): Promise<LanMcpGatewayStatus | null> {
  if (generation !== gatewayTransitionGeneration) return null;
  const preferences = getDesktopPreferences();
  selectedAddressWasUnavailable ||= preferences.sharedResumeRequired;
  if (preferences.networkMode !== 'shared' || !sidecar || currentState?.phase !== 'ready') {
    await stopLanGatewayNow();
    if (preferences.networkMode !== 'shared') networkWarning = undefined;
    sendSystemSettingsState();
    return null;
  }
  const activeSidecar = sidecar;
  if (!preferences.sharedAdapter || !preferences.sharedIp) {
    await stopLanGatewayNow();
    networkWarning = '共享模式缺少固定网卡或 IPv4，请在系统设置中重新选择。';
    sendSystemSettingsState();
    return null;
  }
  const selectedCandidate = listNetworkCandidates().find(candidate => (
    candidate.adapterName === preferences.sharedAdapter && candidate.address === preferences.sharedIp
  ));
  if (!selectedCandidate?.recommended) {
    const firstLoss = !selectedAddressWasUnavailable;
    markSharedResumeRequired(true);
    await stopLanGatewayNow();
    networkWarning = selectedCandidate
      ? `固定地址 ${preferences.sharedIp} 不符合局域网共享安全要求：${selectedCandidate.warning || '只允许真实网卡上的私有 IPv4。'}`
      : `固定地址 ${preferences.sharedIp} 已不在网卡“${preferences.sharedAdapter}”上，局域网共享已停止。`;
    if (firstLoss) {
      showNotification('PMBrain 局域网共享已停止', `${preferences.sharedIp} 当前不可用；地址恢复后仍需手动确认共享。`);
    }
    sendSystemSettingsState();
    return null;
  }

  if (selectedAddressWasUnavailable) {
    await stopLanGatewayNow();
    networkWarning = `固定地址 ${preferences.sharedIp} 已重新出现，但为防止切换到其他 WiFi 后误共享，仍保持停用；请在系统设置中确认并重新应用共享模式。`;
    sendSystemSettingsState();
    return null;
  }

  const currentGateway = lanGateway?.getStatus();
  if (
    currentGateway?.running
    && currentGateway.bindAddress === preferences.sharedIp
    && currentGateway.targetMcpUrl === sidecar.mcpUrl
  ) {
    return currentGateway;
  }

  await stopLanGatewayNow();
  if (generation !== gatewayTransitionGeneration) return null;
  const gateway = new LanMcpGateway({
    bindAddress: preferences.sharedIp,
    sidecarPort: sidecar.port,
    verifyBearerToken: authorizationHeader => activeSidecar.verifyMcpBearer(authorizationHeader),
  });
  try {
    const status = await gateway.start();
    if (generation !== gatewayTransitionGeneration) {
      await gateway.stop();
      return null;
    }
    lanGateway = gateway;
    networkWarning = undefined;
    selectedAddressWasUnavailable = false;
    logger?.write('desktop', `LAN MCP gateway ready at ${status.mcpUrl}; target ${status.targetMcpUrl}`);
    sendSystemSettingsState();
    return status;
  } catch (error) {
    await gateway.stop().catch(() => undefined);
    if (generation !== gatewayTransitionGeneration) return null;
    const causeCode = (error as Error & { cause?: NodeJS.ErrnoException })?.cause?.code;
    if (causeCode === 'EADDRNOTAVAIL') markSharedResumeRequired(true);
    networkWarning = error instanceof Error ? error.message : String(error);
    logger?.write('desktop', networkWarning);
    sendSystemSettingsState();
    return null;
  }
}

async function checkSelectedNetworkAddress(): Promise<void> {
  if (networkCheckInFlight) return;
  networkCheckInFlight = true;
  try {
  const preferences = getDesktopPreferences();
  if (preferences.networkMode !== 'shared' || !preferences.sharedAdapter || !preferences.sharedIp) return;
  const selectedCandidate = listNetworkCandidates().find(candidate => (
    candidate.adapterName === preferences.sharedAdapter && candidate.address === preferences.sharedIp
  ));
  const available = selectedCandidate?.recommended === true;
  if (!available && !selectedAddressWasUnavailable) {
    markSharedResumeRequired(true);
    await stopLanGateway();
    networkWarning = `固定地址 ${preferences.sharedIp} 已消失，局域网 MCP 已立即停止；不会自动切换到其他网卡。`;
    logger?.write('desktop', networkWarning);
    showNotification('PMBrain 局域网共享已停止', `${preferences.sharedIp} 已不在所选网卡上，请打开系统设置确认网络。`);
    sendSystemSettingsState();
    return;
  }
  if (available && selectedAddressWasUnavailable) {
    const nextWarning = `固定地址 ${preferences.sharedIp} 已重新出现，但共享不会自动恢复；请确认当前仍是可信局域网后，在系统设置中重新应用。`;
    if (networkWarning !== nextWarning) {
      networkWarning = nextWarning;
      showNotification('PMBrain 等待确认恢复共享', '为避免换到其他 WiFi 后误开放，请在系统设置中手动确认。');
      sendSystemSettingsState();
    }
    return;
  }
  if (!lanGateway?.getStatus().running) await reconcileLanGateway();
  } finally {
    networkCheckInFlight = false;
  }
}

async function prepareConfiguredDatabase(): Promise<void> {
  const setup = getSetupInfo();
  if (setup.needsSetup || setup.current.engine === 'pglite') return;
  const database = getDatabaseRuntimeConfig();
  sendStartupProgress({
    visible: true,
    stage: 'database',
    title: '正在准备本机数据库',
    message: '正在检查 Postgres；如现有 Docker Desktop 或数据库容器未启动，PMBrain 会安全启动它们，但不会创建、删除或重建容器。',
  });
  const result = await databaseRuntimeManager.ensureReady({
    engine: database.engine,
    databaseUrl: database.databaseUrl,
    configuredContainerName: database.configuredContainerName,
  });
  if (result.kind === 'docker-postgres') {
    saveDetectedDockerContainerName(result.containerName);
    logger?.write('desktop', `Docker Postgres ready: ${result.containerName}; started=${result.containerStarted}`);
  } else {
    logger?.write('desktop', `Postgres runtime ready: ${result.kind}`);
  }
}

function revealMainWindow(): void {
  if (!mainWindow) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function openDesktop(): void {
  void openSettingsPanel('basic').catch(error => reportUiActionError('无法打开桌面设置', error));
}

function reportUiActionError(title: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logger?.write('desktop', `${title}: ${message}`);
  showNotification(title, message);
  revealMainWindow();
}

function refreshTrayMenu(): void {
  if (!tray) return;
  const preferences = getDesktopPreferences();
  const status = lanGateway?.getStatus();
  const shareLabel = preferences.networkMode === 'shared'
    ? status?.running ? `局域网共享：${status.bindAddress}:${status.port}` : '局域网共享：已停止'
    : '局域网共享：未启用';
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 PMBrain', click: openDesktop },
    { label: '打开管理控制台', click: () => void openAdmin().catch(error => reportUiActionError('无法打开管理控制台', error)) },
    { label: '系统设置', click: () => void openSettingsPanel('system').catch(error => reportUiActionError('无法打开系统设置', error)) },
    { type: 'separator' },
    { label: shareLabel, enabled: false },
    { type: 'separator' },
    {
      label: '退出 PMBrain',
      click: () => {
        app.quit();
      },
    },
  ]));
}

function initializeTray(): void {
  if (tray) return;
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_PNG, 'base64')).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip('PMBrain');
  tray.on('double-click', openDesktop);
  refreshTrayMenu();
}

function runtime(): CliRuntime {
  return {
    packaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
  };
}

async function ensureRuntimeReady(): Promise<void> {
  if (!app.isPackaged) return;
  if (runtimePreflightPromise) return runtimePreflightPromise;
  const pending = preflightCliRuntime(runtime()).then((result) => {
    if (!result) return;
    logger?.write(
      'runtime',
      `Verified ${result.arch}-${result.flavor} Bun ${result.bunRevision} on Windows ${result.windowsRelease}`,
    );
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger?.write('runtime', `Runtime preflight failed: ${message}`);
    throw error;
  });
  runtimePreflightPromise = pending;
  try {
    await pending;
  } catch (error) {
    if (runtimePreflightPromise === pending) runtimePreflightPromise = null;
    throw error;
  }
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
    await mainWindow.loadFile(DESKTOP_RENDERER_PATH);
  }
}

function queueSidecarTransition<T>(transition: () => Promise<T>): Promise<T> {
  const pending = sidecarLifecycleQueue.then(transition, transition);
  sidecarLifecycleQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function startSidecarOnce(openAdmin: boolean): Promise<void> {
  if (!mainWindow || !logger) return;
  await ensureRuntimeReady();
  const existing = sidecar;
  if (existing) {
    await existing.start();
    await reconcileLanGateway();
    return;
  }
  sendStartupProgress({
    visible: true,
    stage: 'sidecar',
    title: '正在启动 PMBrain 本地服务',
    message: '正在分配本机端口并启动 sidecar，请保持窗口开启。',
  });
  try {
    const port = await findAvailablePort();
    const bootstrapToken = ensureBootstrapToken();
    let manager!: SidecarManager;
    manager = new SidecarManager({
      ...runtime(),
      port,
      bootstrapToken,
      clientVersion: app.getVersion(),
      logger,
      onState: (state) => {
        if (sidecar !== manager) return;
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
        if (state.phase === 'failed' || state.phase === 'stopped') {
          void stopLanGateway().then(() => sendSystemSettingsState());
        }
        if (openAdmin && state.phase === 'ready') void mainWindow?.loadURL(state.adminUrl);
      },
    });
    sidecar = manager;
    await manager.start();
    if (sidecar !== manager) {
      await manager.stop();
      return;
    }
    await reconcileLanGateway();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.write('desktop', message);
    sendState({ phase: 'failed', port: sidecar?.port ?? 3131, message });
    hideStartupProgress();
    throw error;
  }
}

async function startSidecar(openAdmin: boolean): Promise<void> {
  if (sidecarStartupPromise) {
    await sidecarStartupPromise;
    if (openAdmin && sidecar && currentState?.phase === 'ready') {
      await mainWindow?.loadURL(await sidecar.createAdminLink());
    }
    return;
  }
  const pending = queueSidecarTransition(() => startSidecarOnce(openAdmin));
  sidecarStartupPromise = pending;
  try {
    await pending;
  } finally {
    if (sidecarStartupPromise === pending) sidecarStartupPromise = null;
  }
}

async function stopSidecarNow(): Promise<void> {
  await stopLanGateway();
  const active = sidecar;
  sidecar = null;
  if (active) await active.stop();
}

function stopSidecar(): Promise<void> {
  return queueSidecarTransition(stopSidecarNow);
}

async function restartSidecarForRetry(): Promise<string> {
  if (sidecarRetryPromise) return sidecarRetryPromise;
  const pending = queueSidecarTransition(async () => {
    if (setupInProgress) throw new Error('PMBrain 正在应用基础配置，请等待完成。');
    await ensureRuntimeReady();
    await prepareConfiguredDatabase();
    const active = sidecar;
    if (!active) {
      await startSidecarOnce(false);
      const started = sidecar as SidecarManager | null;
      if (!started) throw new Error('PMBrain 本地服务未能启动。');
      return started.createAdminLink();
    }
    const url = await active.restart();
    if (sidecar !== active) {
      await active.stop();
      throw new Error('PMBrain 本地服务在重试过程中已被替换。');
    }
    await reconcileLanGateway();
    return url;
  });
  sidecarRetryPromise = pending;
  try {
    return await pending;
  } finally {
    if (sidecarRetryPromise === pending) sidecarRetryPromise = null;
  }
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

async function ensureServiceReady(): Promise<SidecarManager> {
  if (sidecar && currentState?.phase === 'ready') return sidecar;
  if (getSetupInfo().needsSetup) throw new Error('请先完成 PMBrain 基础配置。');
  if (setupInProgress) throw new Error('PMBrain 正在应用基础配置，请等待完成后再打开管理台。');
  if (serviceReadyPromise) return serviceReadyPromise;

  const pending = (async () => {
    await ensureRuntimeReady();
    await prepareConfiguredDatabase();
    await migrateConfiguredInstallation();
    if (!sidecar || currentState?.phase !== 'ready') await startSidecar(false);
    if (!sidecar || currentState?.phase !== 'ready') throw new Error('PMBrain 本地服务尚未就绪。');
    return sidecar;
  })();
  serviceReadyPromise = pending;
  try {
    return await pending;
  } finally {
    if (serviceReadyPromise === pending) serviceReadyPromise = null;
  }
}

interface CanonicalMainSource {
  id: string;
  localPath?: string;
}

async function readCanonicalMainSource(activeSidecar = sidecar): Promise<CanonicalMainSource | null> {
  if (!activeSidecar || currentState?.phase !== 'ready') return null;
  const overview = await activeSidecar.adminRequest<{
    main_source_id?: string;
    sources?: Array<{ id: string; local_path?: string | null; archived?: boolean }>;
  }>('/admin/api/brain/overview');
  const id = overview.main_source_id?.trim();
  if (!id) return null;
  const source = overview.sources?.find(candidate => candidate.id === id && candidate.archived !== true);
  return { id, ...(source?.local_path ? { localPath: source.local_path } : {}) };
}

async function currentDesktopSetupState() {
  const setup = getSetupInfo();
  if (!setup.needsSetup) {
    const canonical = await readCanonicalMainSource().catch(() => null);
    if (canonical) {
      setup.current.knowledgeSourceId = canonical.id;
      if (canonical.localPath) setup.current.knowledgeDirectory = canonical.localPath;
    }
  }
  return {
    setup,
    integrations: await listIntegrationsWithConnectionState(sidecar?.port),
    port: sidecar?.port,
    mcpUrl: sidecar?.mcpUrl,
  };
}

async function applySetupOnce(payload: SetupPayload, setDefaultSource = true) {
  await ensureRuntimeReady();
  const hadRunningSidecar = Boolean(sidecar);
  await stopSidecar();
  let saved: ReturnType<typeof saveSetup>;
  let embeddingSwitchCommitted = false;
  let reembeddingWarning: string | null = null;
  try {
    saved = saveSetup(payload);
  } catch (error) {
    if (hadRunningSidecar) await startSidecar(false).catch(() => undefined);
    else hideStartupProgress();
    throw error;
  }
  try {
    await prepareConfiguredDatabase();
    if (saved.needsEmbeddingDimensionProbe || saved.embeddingModelChanged) {
      let probe: Awaited<ReturnType<typeof runCliChecked>>;
      try {
        probe = await runCliChecked(runtime(), ['models', 'detect-embedding-dimension', '--json']);
      } catch (error) {
        if (saved.config.embedding_model?.startsWith('custom-openai:')) {
          const baseUrl = saved.config.provider_touchpoint_base_urls?.['custom-openai']?.embedding
            ?? saved.config.provider_base_urls?.['custom-openai']
            ?? '自定义 Base URL';
          const model = saved.config.embedding_model.slice('custom-openai:'.length);
          throw new Error(
            `自定义向量模型验证失败：无法通过 ${baseUrl} 访问模型 ${model}。` +
            '请确认本地模型服务已启动、Base URL 包含正确的 /v1 路径、模型 ID 与 API Key 正确。',
            { cause: error },
          );
        }
        throw error;
      }
      const result = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1) || '{}') as { dimensions?: number };
      if (!Number.isInteger(result.dimensions) || (result.dimensions ?? 0) <= 0) {
        throw new Error('无法从向量模型响应中判断有效维度。');
      }
      if (saved.config.embedding_dimensions !== result.dimensions) {
        updateSavedEmbeddingDimension(saved.snapshot.path, result.dimensions!);
        saved.config.embedding_dimensions = result.dimensions!;
      }
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
    if (setDefaultSource && knowledgeDirectory && sourceId) {
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
    const alignmentArgs = ['models', 'align-embedding-dimension', '--yes', '--json'];
    if (saved.embeddingModelChanged) alignmentArgs.push('--force-reembed');
    await runCliChecked(runtime(), alignmentArgs);
    embeddingSwitchCommitted = saved.embeddingModelChanged;
    if (saved.embeddingModelChanged) {
      sendStartupProgress({
        visible: true,
        stage: 'migration',
        title: '正在使用新模型重建向量',
        message: '旧向量已安全失效，正在重新生成搜索索引。若本次中断，Dream 会从剩余内容继续。',
      });
      const reembed = await runCli(runtime(), ['embed', '--stale', '--catch-up', '--json']);
      if (reembed.code !== 0) {
        reembeddingWarning = (reembed.stderr || reembed.stdout).trim()
          || '本次重新向量化未完成，Dream 会继续处理剩余内容。';
      } else {
        try {
          const result = JSON.parse(reembed.stdout.trim().split(/\r?\n/).at(-1) || '{}') as {
            embedded?: number;
            total_chunks?: number;
          };
          const pending = Math.max(0, (result.total_chunks ?? 0) - (result.embedded ?? 0));
          if (pending > 0) {
            reembeddingWarning = `新模型已生效，但仍有 ${pending} 个分块等待向量化；Dream 下次启动会继续处理。`;
          }
        } catch {
          reembeddingWarning = '新模型已生效，但无法确认重新向量化是否全部完成；Dream 下次启动会检查并继续处理。';
        }
      }
    }
  } catch (error) {
    if (!embeddingSwitchCommitted) restoreConfig(saved.snapshot);
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
    integrations: await listIntegrationsWithConnectionState(sidecar?.port),
    port: sidecar?.port,
    mcpUrl: sidecar?.mcpUrl,
    backup: saved.backup,
    reembeddingWarning,
  };
}

type SettingsPanel = 'basic' | 'models' | 'integrations' | 'updates' | 'system';

function installMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'PMBrain',
      submenu: [
        { label: '打开管理控制台', click: () => void openAdmin().catch(error => reportUiActionError('无法打开管理控制台', error)) },
        { label: '基础配置', click: () => void openSettingsPanel('basic') },
        { label: '模型配置', click: () => void openSettingsPanel('models') },
        { label: 'MCP 接入', click: () => void openSettingsPanel('integrations') },
        { label: '系统设置', click: () => void openSettingsPanel('system') },
        { label: '软件更新', click: () => void openUpdates() },
        { type: 'separator' },
        { label: '打开日志目录', click: () => logger && void shell.openPath(logger.directory) },
        { type: 'separator' },
        {
          label: '退出 PMBrain',
          click: () => {
            app.quit();
          },
        },
      ],
    },
    { role: 'viewMenu', label: '视图' },
  ]));
}

async function applySetup(payload: SetupPayload) {
  if (setupInProgress) throw new Error('PMBrain 正在应用上一份基础配置，请等待完成。');
  setupInProgress = true;
  try {
    const canonical = payload.knowledgeSourceChanged === false
      ? await readCanonicalMainSource().catch(() => null)
      : null;
    const effectivePayload = canonical
      ? {
          ...payload,
          knowledgeSourceId: canonical.id,
          knowledgeDirectory: canonical.localPath ?? payload.knowledgeDirectory,
        }
      : payload;
    return await applySetupOnce(effectivePayload, payload.knowledgeSourceChanged !== false || !canonical);
  } finally {
    setupInProgress = false;
  }
}

async function openSettingsPanel(panel: SettingsPanel): Promise<void> {
  await showShell();
  mainWindow?.webContents.send('desktop:show-panel', panel);
  revealMainWindow();
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
  if (getSetupInfo().needsSetup) {
    await openSettingsPanel('basic');
    showNotification('请先完成基础配置', '数据库与模型配置完成后才能打开管理控制台。');
    return;
  }
  if (setupInProgress) {
    revealMainWindow();
    showNotification('PMBrain 正在完成配置', '请等待当前配置与数据库迁移完成。');
    return;
  }
  const activeSidecar = await ensureServiceReady();
  const url = await activeSidecar.createAdminLink();
  await mainWindow.loadURL(url);
  revealMainWindow();
}

function loginItemSettingsOptions() {
  return {
    path: process.execPath,
    args: app.isPackaged ? [] : [app.getAppPath()],
  };
}

function setLaunchAtLogin(openAtLogin: boolean): void {
  app.setLoginItemSettings({
    ...loginItemSettingsOptions(),
    openAtLogin,
  });
}

async function saveSystemSettings(
  payload: DesktopSystemSettingsPayload,
): Promise<DesktopSystemSettingsSaveResult> {
  const current = getDesktopPreferences();
  const candidates = listNetworkCandidates();
  const selected = payload.networkMode === 'shared'
    ? candidates.find(candidate => (
      candidate.adapterName === payload.sharedAdapter
      && candidate.address === payload.sharedIp
    ))
    : undefined;
  const modeChanged = current.networkMode !== payload.networkMode;
  const endpointChanged = payload.networkMode === 'shared' && (
    current.sharedAdapter !== payload.sharedAdapter || current.sharedIp !== payload.sharedIp
  );
  const resumeRequired = payload.networkMode === 'shared'
    && (selectedAddressWasUnavailable || current.sharedResumeRequired)
    && Boolean(selected);
  const networkApplyRequested = modeChanged || endpointChanged || resumeRequired;
  if (payload.networkMode === 'shared' && networkApplyRequested && !selected) {
    throw new Error('所选局域网地址当前不可用。PMBrain 不会自动改用其他网卡，请重新选择。');
  }
  if (payload.networkMode === 'shared' && networkApplyRequested && selected && !selected.recommended) {
    throw new Error(selected.warning || '共享模式只允许真实 Wi-Fi 或有线网卡上的私有局域网 IPv4。');
  }
  if (networkApplyRequested && mainWindow) {
    const enteringShared = payload.networkMode === 'shared';
    const detail = enteringShared
      ? [
        `将固定使用 ${payload.sharedAdapter} / ${payload.sharedIp}:3131。`,
        '本机 Agent 仍继续使用 127.0.0.1，不需要修改原配置。',
        '其他电脑必须使用新的局域网地址和独立 API Key；IP 变化后旧的远端配置会立即失效。',
        selected?.warning ? `注意：${selected.warning}` : '建议在路由器中为这台电脑设置 DHCP 地址保留。',
      ].join('\n')
      : [
        '关闭共享后，其他电脑现有的 PMBrain MCP 配置会立即断开。',
        '本机 127.0.0.1 MCP 与知识库数据不受影响。',
      ].join('\n');
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: resumeRequired && !modeChanged && !endpointChanged
        ? '确认恢复 PMBrain 局域网共享'
        : modeChanged ? '确认切换 PMBrain 网络模式' : '确认更换共享固定地址',
      message: enteringShared ? '即将启用局域网共享模式' : '即将恢复仅本机模式',
      detail,
      buttons: ['确认并应用', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirmation.response !== 0) {
      return { canceled: true, state: currentSystemSettingsState() };
    }
  }

  const saved = saveDesktopPreferences({
    networkMode: payload.networkMode,
    sharedAdapter: payload.sharedAdapter,
    sharedIp: payload.sharedIp,
    closeBehavior: payload.closeBehavior,
    sharedResumeRequired: payload.networkMode === 'local' || networkApplyRequested
      ? false
      : current.sharedResumeRequired,
  });
  const themeBackup = saveDesktopTheme(payload.theme);
  applyDesktopTheme(payload.theme);
  setLaunchAtLogin(payload.launchAtLogin === true);
  selectedAddressWasUnavailable = saved.preferences.sharedResumeRequired;
  networkWarning = undefined;
  const gateway = await reconcileLanGateway();
  if (payload.networkMode === 'shared' && networkApplyRequested && !gateway) {
    throw new Error(`系统偏好已保存，但局域网共享入口未能启动：${networkWarning || '请检查固定 IP 与 3131 端口。'}`);
  }
  return {
    canceled: false,
    state: currentSystemSettingsState(),
    backup: saved.backup ?? themeBackup,
  };
}


function requireSharedSidecar(): { sidecar: SidecarManager; mcpUrl: string } {
  if (!sidecar || currentState?.phase !== 'ready') throw new Error('请先启动 PMBrain 本地服务。');
  const preferences = getDesktopPreferences();
  if (!preferences.sharedIp) {
    throw new Error('尚未保存局域网共享地址，当前没有可管理的共享入口。');
  }
  return { sidecar, mcpUrl: `http://${preferences.sharedIp}:3131/mcp` };
}
function requireSharedGateway(): { sidecar: SidecarManager; status: LanMcpGatewayStatus } {
  if (!sidecar || currentState?.phase !== 'ready') throw new Error('请先启动 PMBrain 本地服务。');
  if (getDesktopPreferences().networkMode !== 'shared') {
    throw new Error('请先在系统设置中启用局域网共享模式。');
  }
  const status = lanGateway?.getStatus();
  if (!status?.running) {
    throw new Error(networkWarning || '局域网 MCP 尚未启动，请检查固定 IP 和端口状态。');
  }
  return { sidecar, status };
}

async function readSharedAccess() {
  const shared = requireSharedSidecar();
  return getSharedAccessContext(shared.sidecar, shared.mcpUrl);
}

async function createSharedAccess(payload: SharedIntegrationPayload) {
  const shared = requireSharedGateway();
  const result = await createSharedIntegration(shared.sidecar, shared.status.mcpUrl, payload);
  try {
    await smokeTestSharedIntegration(shared.status.mcpUrl, result.token, result.scopes, result.name);
  } catch (error) {
    try {
      await revokeSharedIntegration(shared.sidecar, result.name);
    } catch (rollbackError) {
      throw new Error(
        `共享凭证局域网校验失败，且自动撤销也失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        + `。请立即在成员凭证列表中手动撤销 ${result.name}。`,
        { cause: error },
      );
    }
    throw error;
  }
  return result;
}

function isTrustedDesktopShellUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'file:') {
      const normalized = decodeURIComponent(url.pathname).replace(/^\/(?:([A-Za-z]:))/, '$1').replace(/\\/g, '/').toLowerCase();
      const expected = DESKTOP_RENDERER_PATH.replace(/\\/g, '/').toLowerCase();
      return normalized === expected;
    }
    if (process.env.ELECTRON_RENDERER_URL) {
      const renderer = new URL(process.env.ELECTRON_RENDERER_URL);
      if (url.origin === renderer.origin) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function isAllowedWindowNavigationUrl(value: string): boolean {
  if (isTrustedDesktopShellUrl(value)) return true;
  try {
    const url = new URL(value);
    return Boolean(
      sidecar
      && url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
      && Number.parseInt(url.port, 10) === sidecar.port
    );
  } catch {
    return false;
  }
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedDesktopShellUrl(senderUrl)) throw new Error('已拒绝来自非 PMBrain 桌面设置页的方法调用。');
}


function handleTrustedIpc(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event);
    return listener(event, ...args);
  });
}
async function revokeSharedAccess(credentialName: string) {
  const shared = requireSharedSidecar();
  await revokeSharedIntegration(shared.sidecar, credentialName);
  return getSharedAccessContext(shared.sidecar, shared.mcpUrl);
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
  mainWindow.on('close', (event) => {
    if (quitting || getDesktopPreferences().closeBehavior === 'quit') return;
    event.preventDefault();
    mainWindow?.hide();
    if (!trayHintShown && !isTrayHintShown()) {
      trayHintShown = true;
      showNotification('PMBrain 仍在运行', '窗口已最小化到系统托盘，本地服务和局域网共享会继续运行。');
      try {
        markTrayHintShown();
      } catch (error) {
        console.error('[desktop] 无法保存托盘提示状态：', error);
      }
    } else {
      trayHintShown = true;
    }
  });
  const guardNavigation = (event: Electron.Event, url: string) => {
    if (isAllowedWindowNavigationUrl(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  };
  mainWindow.webContents.on('will-navigate', guardNavigation);
  mainWindow.webContents.on('will-redirect', guardNavigation);
  mainWindow.on('closed', () => { mainWindow = null; });
  await showShell();
  if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  if (!getSetupInfo().needsSetup) {
    try {
      await ensureServiceReady();
      if (sidecar && currentState?.phase === 'ready') await mainWindow.loadURL(await sidecar.createAdminLink());
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
    if (process.platform === 'win32') app.setAppUserModelId('com.pmbrain.desktop');
    logger = new DesktopLogger(app.getPath('userData'));
    const initialSetup = getSetupInfo();
    selectedAddressWasUnavailable = getDesktopPreferences().sharedResumeRequired;
    desktopVersionHistory = updateDesktopVersionHistory(
      join(app.getPath('userData'), 'version-history.json'),
      app.getVersion(),
      initialSetup.current.lastMigratedVersion,
    );
    applyDesktopTheme(initialSetup.current.theme);
    nativeTheme.on('updated', () => {
      mainWindow?.webContents.send('desktop:theme-state', themeState());
      sendSystemSettingsState();
    });
    initializeTray();
    installMenu();
    handleTrustedIpc('desktop:get-state', () => currentState);
    handleTrustedIpc('desktop:get-startup-progress', () => startupProgress);
    handleTrustedIpc('desktop:get-theme', () => themeState(getSetupInfo().current.theme));
    handleTrustedIpc('desktop:set-theme', (event, value: DesktopTheme) => {
      assertTrustedIpcSender(event);
      const source = normalizeDesktopTheme(value);
      const backup = saveDesktopTheme(source);
      const result = { ...applyDesktopTheme(source), backup };
      sendSystemSettingsState();
      return result;
    });
    handleTrustedIpc('desktop:get-system-settings', (event) => {
      assertTrustedIpcSender(event);
      return currentSystemSettingsState();
    });
    handleTrustedIpc('desktop:save-system-settings', (event, payload: DesktopSystemSettingsPayload) => {
      assertTrustedIpcSender(event);
      return saveSystemSettings(payload);
    });
    handleTrustedIpc('desktop:get-shared-access', (event) => {
      assertTrustedIpcSender(event);
      return readSharedAccess();
    });
    handleTrustedIpc('desktop:create-shared-integration', (event, payload: SharedIntegrationPayload) => {
      assertTrustedIpcSender(event);
      return createSharedAccess(payload);
    });
    handleTrustedIpc('desktop:revoke-shared-integration', (event, credentialName: string) => {
      assertTrustedIpcSender(event);
      return revokeSharedAccess(credentialName);
    });
    handleTrustedIpc('desktop:get-update-state', () => updateManager?.currentState ?? null);
    handleTrustedIpc('desktop:get-setup', () => currentDesktopSetupState());
    handleTrustedIpc('desktop:choose-directory', async (_event, initialPath?: string) => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        defaultPath: initialPath,
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    handleTrustedIpc('desktop:get-provider-models', (_event, provider: string, touchpoint: DesktopModelTouchpoint) => {
      return listDesktopProviderModels(provider, touchpoint);
    });
    handleTrustedIpc(
      'desktop:get-advanced-model-config',
      () => withSidecarPausedForModelConfig(() => readAdvancedModelConfig(runtime())),
    );
    handleTrustedIpc(
      'desktop:save-advanced-model-config',
      (_event, values: Partial<Record<AdvancedModelTier, string>>) => withSidecarPausedForModelConfig(
        () => writeAdvancedModelConfig(runtime(), values),
      ),
    );
    handleTrustedIpc('desktop:save-setup', (_event, payload: SetupPayload) => applySetup(payload));
    handleTrustedIpc('desktop:configure-integration', async (_event, client: IntegrationClient, kind: CredentialKind) => {
      if (!sidecar) throw new Error('请先完成数据库配置并启动 PMBrain。');
      return configureIntegration(sidecar, client, kind);
    });
    handleTrustedIpc('desktop:copy', (_event, value: string) => clipboard.writeText(value));
    handleTrustedIpc('desktop:open-admin', () => openAdmin());
    handleTrustedIpc('desktop:check-updates', () => updateManager?.check());
    handleTrustedIpc('desktop:install-update', () => updateManager?.install());
    handleTrustedIpc('desktop:open-previous-release', async () => {
      const previous = desktopVersionHistory.previous;
      if (!previous) throw new Error('当前没有可用的上一版本记录。');
      await shell.openExternal(`https://github.com/zhengyunhui123-dev/PMBrain/releases/tag/v${previous}`);
    });
    handleTrustedIpc('desktop:retry', async () => {
      await showShell();
      if (getSetupInfo().needsSetup) return;
      const url = await restartSidecarForRetry();
      await mainWindow?.loadURL(url);
    });
    handleTrustedIpc('desktop:open-logs', () => logger && shell.openPath(logger.directory));
    handleTrustedIpc('desktop:quit', () => {
      app.quit();
    });
    networkMonitor = setInterval(() => void checkSelectedNetworkAddress(), LAN_MONITOR_INTERVAL_MS);
    await createWindow();
    initializeUpdater();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    updateManager?.stop();
    if (networkMonitor) {
      clearInterval(networkMonitor);
      networkMonitor = null;
    }
    if (!sidecar) {
      quitting = true;
      tray?.destroy();
      tray = null;
      logger?.close();
      return;
    }
    event.preventDefault();
    quitting = true;
    void stopSidecar().finally(() => {
      tray?.destroy();
      tray = null;
      logger?.close();
      app.exit(0);
    });
  });

  app.on('window-all-closed', () => {
    if (getDesktopPreferences().closeBehavior === 'quit') app.quit();
  });
}
