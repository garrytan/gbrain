import { contextBridge, ipcRenderer } from 'electron';
import type { SidecarState } from '../main/sidecar-manager.js';
import type { DesktopTheme, SetupInfo, SetupPayload } from '../main/config-manager.js';
import type { AdvancedModelConfig, AdvancedModelTier } from '../main/advanced-model-config.js';
import type { CredentialKind, IntegrationClient, IntegrationInfo, IntegrationResult } from '../main/integration-manager.js';
import type { UpdateState } from '../main/update-manager.js';
import type { DesktopModelTouchpoint, DesktopProviderModels } from '../main/model-catalog.js';

export type {
  AdvancedModelConfig,
  AdvancedModelTier,
  CredentialKind,
  DesktopTheme,
  IntegrationClient,
  IntegrationInfo,
  IntegrationResult,
  SetupInfo,
  SetupPayload,
  SidecarState,
  UpdateState,
};

export type DesktopSettingsPanel = 'basic' | 'models' | 'integrations' | 'updates';

export interface DesktopThemeState {
  source: DesktopTheme;
  resolved: 'light' | 'dark';
  backup?: string | null;
}

export interface StartupProgress {
  visible: boolean;
  stage: 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
}

export interface DesktopSetupState {
  setup: SetupInfo;
  integrations: IntegrationInfo[];
  port?: number;
  mcpUrl?: string;
}

export interface PMBrainDesktopApi {
  getState(): Promise<SidecarState | null>;
  getStartupProgress(): Promise<StartupProgress>;
  onStartupProgress(listener: (progress: StartupProgress) => void): () => void;
  getTheme(): Promise<DesktopThemeState>;
  setTheme(theme: DesktopTheme): Promise<DesktopThemeState>;
  onThemeState(listener: (state: DesktopThemeState) => void): () => void;
  getSetup(): Promise<DesktopSetupState>;
  onState(listener: (state: SidecarState) => void): () => void;
  getUpdateState(): Promise<UpdateState | null>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  onShowUpdates(listener: () => void): () => void;
  onShowPanel(listener: (panel: DesktopSettingsPanel) => void): () => void;
  chooseDirectory(initialPath?: string): Promise<string | null>;
  getProviderModels(provider: string, touchpoint: DesktopModelTouchpoint): Promise<DesktopProviderModels>;
  getAdvancedModelConfig(): Promise<AdvancedModelConfig>;
  saveAdvancedModelConfig(values: Partial<Record<AdvancedModelTier, string>>): Promise<AdvancedModelConfig>;
  saveSetup(payload: SetupPayload): Promise<DesktopSetupState & { backup?: string | null }>;
  configureIntegration(client: IntegrationClient, kind: CredentialKind): Promise<IntegrationResult>;
  copy(value: string): Promise<void>;
  openAdmin(): Promise<void>;
  checkUpdates(): Promise<UpdateState | null>;
  installUpdate(): Promise<void>;
  openPreviousRelease(): Promise<void>;
  retry(): Promise<void>;
  openLogs(): Promise<string>;
  quit(): Promise<void>;
}

const api: PMBrainDesktopApi = {
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  getStartupProgress: () => ipcRenderer.invoke('desktop:get-startup-progress'),
  onStartupProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: StartupProgress) => listener(progress);
    ipcRenderer.on('desktop:startup-progress', handler);
    return () => ipcRenderer.removeListener('desktop:startup-progress', handler);
  },
  getTheme: () => ipcRenderer.invoke('desktop:get-theme'),
  setTheme: (theme) => ipcRenderer.invoke('desktop:set-theme', theme),
  onThemeState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopThemeState) => listener(state);
    ipcRenderer.on('desktop:theme-state', handler);
    return () => ipcRenderer.removeListener('desktop:theme-state', handler);
  },
  getSetup: () => ipcRenderer.invoke('desktop:get-setup'),
  onState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: SidecarState) => listener(state);
    ipcRenderer.on('desktop:state', handler);
    return () => ipcRenderer.removeListener('desktop:state', handler);
  },
  getUpdateState: () => ipcRenderer.invoke('desktop:get-update-state'),
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateState) => listener(state);
    ipcRenderer.on('desktop:update-state', handler);
    return () => ipcRenderer.removeListener('desktop:update-state', handler);
  },
  onShowUpdates: (listener) => {
    const handler = () => listener();
    ipcRenderer.on('desktop:show-updates', handler);
    return () => ipcRenderer.removeListener('desktop:show-updates', handler);
  },
  onShowPanel: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, panel: DesktopSettingsPanel) => listener(panel);
    ipcRenderer.on('desktop:show-panel', handler);
    return () => ipcRenderer.removeListener('desktop:show-panel', handler);
  },
  chooseDirectory: (initialPath) => ipcRenderer.invoke('desktop:choose-directory', initialPath),
  getProviderModels: (provider, touchpoint) => ipcRenderer.invoke('desktop:get-provider-models', provider, touchpoint),
  getAdvancedModelConfig: () => ipcRenderer.invoke('desktop:get-advanced-model-config'),
  saveAdvancedModelConfig: (values) => ipcRenderer.invoke('desktop:save-advanced-model-config', values),
  saveSetup: (payload) => ipcRenderer.invoke('desktop:save-setup', payload),
  configureIntegration: (client, kind) => ipcRenderer.invoke('desktop:configure-integration', client, kind),
  copy: (value) => ipcRenderer.invoke('desktop:copy', value),
  openAdmin: () => ipcRenderer.invoke('desktop:open-admin'),
  checkUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  openPreviousRelease: () => ipcRenderer.invoke('desktop:open-previous-release'),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
};

contextBridge.exposeInMainWorld('pmbrainDesktop', api);
