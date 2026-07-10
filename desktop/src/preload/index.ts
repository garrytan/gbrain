import { contextBridge, ipcRenderer } from 'electron';
import type { SidecarState } from '../main/sidecar-manager.js';
import type { SetupInfo, SetupPayload } from '../main/config-manager.js';
import type { CredentialKind, IntegrationClient, IntegrationInfo, IntegrationResult } from '../main/integration-manager.js';
import type { UpdateState } from '../main/update-manager.js';
import type { DesktopModelTouchpoint, DesktopProviderModels } from '../main/model-catalog.js';

export type { SidecarState, SetupInfo, SetupPayload, CredentialKind, IntegrationClient, IntegrationInfo, IntegrationResult, UpdateState };

export interface DesktopSetupState {
  setup: SetupInfo;
  integrations: IntegrationInfo[];
  port?: number;
  mcpUrl?: string;
}

export interface PMBrainDesktopApi {
  getState(): Promise<SidecarState | null>;
  getSetup(): Promise<DesktopSetupState>;
  onState(listener: (state: SidecarState) => void): () => void;
  getUpdateState(): Promise<UpdateState | null>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  onShowUpdates(listener: () => void): () => void;
  chooseDirectory(initialPath?: string): Promise<string | null>;
  getProviderModels(provider: string, touchpoint: DesktopModelTouchpoint): Promise<DesktopProviderModels>;
  saveSetup(payload: SetupPayload): Promise<DesktopSetupState & { backup?: string | null }>;
  configureIntegration(client: IntegrationClient, kind: CredentialKind): Promise<IntegrationResult>;
  copy(value: string): Promise<void>;
  openAdmin(): Promise<void>;
  checkUpdates(): Promise<UpdateState | null>;
  installUpdate(): Promise<void>;
  retry(): Promise<void>;
  openLogs(): Promise<string>;
  quit(): Promise<void>;
}

const api: PMBrainDesktopApi = {
  getState: () => ipcRenderer.invoke('desktop:get-state'),
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
  chooseDirectory: (initialPath) => ipcRenderer.invoke('desktop:choose-directory', initialPath),
  getProviderModels: (provider, touchpoint) => ipcRenderer.invoke('desktop:get-provider-models', provider, touchpoint),
  saveSetup: (payload) => ipcRenderer.invoke('desktop:save-setup', payload),
  configureIntegration: (client, kind) => ipcRenderer.invoke('desktop:configure-integration', client, kind),
  copy: (value) => ipcRenderer.invoke('desktop:copy', value),
  openAdmin: () => ipcRenderer.invoke('desktop:open-admin'),
  checkUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
};

contextBridge.exposeInMainWorld('pmbrainDesktop', api);
