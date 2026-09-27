import type { MemoryWritebackStatus, MemoryWritebackUpdate } from '../../../shared/contracts/brain.js';
import { contextBridge, ipcRenderer } from 'electron';
import type { SidecarState } from '../main/sidecar-manager.js';
import type {
  DesktopCloseBehavior,
  DesktopCustomEndpoint,
  DesktopCustomProvider,
  DesktopCustomProviderCatalog,
  DesktopCustomProviderSelection,
  DesktopNetworkMode,
  DesktopPreferences,
  DesktopTheme,
  SetupInfo,
  SetupPayload,
} from '../main/config-manager.js';
import type {
  AdvancedModelConfig,
  AdvancedModelPhase,
  AdvancedModelTier,
  AdvancedModelWriteInput,
} from '../main/advanced-model-config.js';
import type {
  CredentialKind,
  IntegrationClient,
  IntegrationInfo,
  IntegrationResult,
  SharedAccessContext,
  SharedCredentialInfo,
  SharedIntegrationPayload,
  SharedIntegrationResult,
  SharedSourceInfo,
} from '../main/integration-manager.js';
import type { UpdateState } from '../main/update-manager.js';
import type { DesktopModelTouchpoint, DesktopProviderModels } from '../main/model-catalog.js';
import type {
  DesktopModelConnectionTestInput,
  DesktopModelConnectionTestResult,
} from '../main/model-connection-test.js';
import type {
  DesktopSystemSettingsPayload,
  DesktopSystemSettingsSaveResult,
  DesktopSystemSettingsState,
} from '../main/system-settings.js';
import type { DesktopKnowledgeSourceStatus } from '../main/knowledge-source-git.js';
import type { WorkbuddyAgentIntegrationStatus } from '../main/integration/workbuddy-agent-controller.js';
import type { PgliteOwnerStatus } from '../../../src/core/pglite-owner-control.js';
import type { ManagedPostgresDatabase } from '../main/database-runtime-manager.js';

export type {
  AdvancedModelConfig,
  AdvancedModelPhase,
  AdvancedModelTier,
  AdvancedModelWriteInput,
  CredentialKind,
  DesktopCloseBehavior,
  DesktopCustomEndpoint,
  DesktopCustomProvider,
  DesktopCustomProviderCatalog,
  DesktopCustomProviderSelection,
  DesktopModelConnectionTestInput,
  DesktopModelConnectionTestResult,
  DesktopNetworkMode,
  DesktopKnowledgeSourceStatus,
  DesktopPreferences,
  DesktopSystemSettingsPayload,
  DesktopSystemSettingsSaveResult,
  DesktopSystemSettingsState,
  DesktopTheme,
  IntegrationClient,
  IntegrationInfo,
  IntegrationResult,
  SharedAccessContext,
  SharedCredentialInfo,
  SharedIntegrationPayload,
  SharedIntegrationResult,
  SharedSourceInfo,
  SetupInfo,
  SetupPayload,
  SidecarState,
  UpdateState,
  WorkbuddyAgentIntegrationStatus,
  ManagedPostgresDatabase,
};

export type DesktopSettingsPanel = 'basic' | 'models' | 'integrations' | 'updates' | 'system' | 'repair';

export interface DesktopPgliteUpgradeBackup {
  status: 'verified';
  backupDirectory: string;
  backupDatabasePath: string;
  manifestPath: string;
  createdAt: string;
  targetVersion: string;
  sourceSchemaVersion: number | null;
  recoveryVerifiedAt: string;
  bytes: number;
}

export interface DesktopPgliteUpgradeBackups {
  databasePath: string | null;
  backupRoot: string | null;
  keep: number;
  totalBytes: number;
  backups: DesktopPgliteUpgradeBackup[];
}

export interface DesktopPgliteUpgradeBackupMutation {
  status: 'pruned' | 'deleted' | 'restored' | 'updated' | 'unchanged';
  backupDirectory?: string;
  backupRoot?: string;
  deleted?: string[];
  kept?: string[];
  listing: DesktopPgliteUpgradeBackups;
}

export interface DesktopToastDiagnoseResult {
  status: string;
  stagingPath: string;
  productionPath: string | null;
  canAutoRepair: boolean;
  table?: string;
  column?: string;
  repairability?: string;
  recommendedAction?: string;
  row?: Record<string, unknown>;
  error?: string;
}

export interface DesktopToastRepairResult {
  status: 'replaced' | 'refused' | 'needs-confirm';
  stagingPath?: string;
  preservedPath?: string;
  pages?: number;
  chunks?: number;
  facts?: number;
  diagnose?: DesktopToastDiagnoseResult;
  error?: string;
}

export interface DesktopDiagnosticBundleResult {
  path: string;
  fileName: string;
  files: string[];
}

export interface DesktopThemeState {
  source: DesktopTheme;
  resolved: 'light' | 'dark';
  backup?: string | null;
}

export interface StartupProgress {
  visible: boolean;
  stage: 'database' | 'migration' | 'sidecar' | 'health';
  title: string;
  message: string;
  canDeferEmbeddingRebuild?: boolean;
  embeddingRebuildTotal?: number;
}

export interface DesktopSetupState {
  setup: SetupInfo;
  integrations: IntegrationInfo[];
  port?: number;
  mcpUrl?: string;
}

export interface PMBrainDesktopApi {
  productRequest(request: import('../main/product-request.js').ProductRequest): Promise<import('../main/product-request.js').ProductResponse>;
  onNavigate(listener: (target: string) => void): () => void;
  getState(): Promise<SidecarState | null>;
  getStartupProgress(): Promise<StartupProgress>;
  onStartupProgress(listener: (progress: StartupProgress) => void): () => void;
  getTheme(): Promise<DesktopThemeState>;
  setTheme(theme: DesktopTheme): Promise<DesktopThemeState>;
  onThemeState(listener: (state: DesktopThemeState) => void): () => void;
  getSetup(): Promise<DesktopSetupState>;
  listDockerDatabases(): Promise<ManagedPostgresDatabase[]>;
  activateDockerDatabase(containerName: string): Promise<ManagedPostgresDatabase>;
  getIntegrations(probe?: boolean): Promise<IntegrationInfo[]>;
  chooseEmbeddingRebuild(choice: 'wait' | 'defer'): Promise<void>;
  onState(listener: (state: SidecarState) => void): () => void;
  getUpdateState(): Promise<UpdateState | null>;
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  onShowUpdates(listener: () => void): () => void;
  onShowPanel(listener: (panel: DesktopSettingsPanel) => void): () => void;
  getSystemSettings(): Promise<DesktopSystemSettingsState>;
  saveSystemSettings(payload: DesktopSystemSettingsPayload): Promise<DesktopSystemSettingsSaveResult>;
  getMemoryWriteback(): Promise<MemoryWritebackStatus>;
  saveMemoryWriteback(payload: MemoryWritebackUpdate): Promise<MemoryWritebackStatus>;
  onSystemSettingsState(listener: (state: DesktopSystemSettingsState) => void): () => void;
  getSharedAccess(): Promise<SharedAccessContext>;
  createSharedIntegration(payload: SharedIntegrationPayload): Promise<SharedIntegrationResult>;
  revokeSharedIntegration(credentialName: string): Promise<SharedAccessContext>;
  chooseDirectory(initialPath?: string): Promise<string | null>;
  inspectKnowledgeSourceDirectory(path: string): Promise<DesktopKnowledgeSourceStatus>;
  initializeKnowledgeSourceGit(path: string): Promise<DesktopKnowledgeSourceStatus>;
  getProviderModels(provider: string, touchpoint: DesktopModelTouchpoint): Promise<DesktopProviderModels>;
  testModelConnection(input: DesktopModelConnectionTestInput): Promise<DesktopModelConnectionTestResult>;
  getAdvancedModelConfig(): Promise<AdvancedModelConfig>;
  saveAdvancedModelConfig(values: AdvancedModelWriteInput): Promise<AdvancedModelConfig>;
  saveSetup(payload: SetupPayload): Promise<DesktopSetupState & { backup?: string | null; reembeddingWarning?: string | null }>;
  inspectDockerMigration(): Promise<{ schemaVersion: string | null; fingerprint: string; tables: Array<{ name: string; rows: number; action: 'direct' | 'convert' | 'skip' | 'unknown'; reason: string; skippable?: boolean }>; vectors: Array<{ table: string; column: string; source: string; target: string | null }> }>;
  migrateToDocker(planFingerprint: string, skipUnknown: boolean): Promise<{ backupDirectory: string; configBackup: string | null; containerName: string; volumeName: string; tables: number; rows: number; skippedTables: Array<{ name: string; rows: number; reason: string }>; reportPath: string }>;
  openDockerInstallGuide(): Promise<void>;
  configureIntegration(client: IntegrationClient, kind: CredentialKind, deep?: boolean): Promise<IntegrationResult>;
  launchIntegration(client: IntegrationClient): Promise<void>;
  writeWorkbuddyUserAgent(): Promise<{ written: string[]; backedUp: string[] }>;
  getWorkbuddyAgentIntegration(): Promise<WorkbuddyAgentIntegrationStatus>;
  installWorkbuddyAgent(workspace: string): Promise<WorkbuddyAgentIntegrationStatus>;
  updateWorkbuddyAgent(): Promise<WorkbuddyAgentIntegrationStatus>;
  removeWorkbuddyAgent(): Promise<WorkbuddyAgentIntegrationStatus>;
  copy(value: string): Promise<void>;
  openAdmin(): Promise<void>;
  checkUpdates(): Promise<UpdateState | null>;
  downloadUpdate(): Promise<UpdateState | null>;
  installUpdate(): Promise<void>;
  listPgliteUpgradeBackups(): Promise<DesktopPgliteUpgradeBackups>;
  prunePgliteUpgradeBackups(): Promise<DesktopPgliteUpgradeBackupMutation>;
  deletePgliteUpgradeBackup(backupDirectory: string): Promise<DesktopPgliteUpgradeBackupMutation>;
  restorePgliteUpgradeBackup(backupDirectory: string): Promise<DesktopPgliteUpgradeBackupMutation>;
  setPgliteUpgradeBackupRoot(directory: string): Promise<DesktopPgliteUpgradeBackupMutation>;
  openPgliteUpgradeBackup(target: string): Promise<void>;
  diagnosePgliteToast(): Promise<DesktopToastDiagnoseResult>;
  replacePgliteToastRepair(stagingPath: string): Promise<DesktopToastRepairResult>;
  getPgliteRecoveryStatus(): Promise<PgliteOwnerStatus>;
  terminatePgliteOwnerAndRetry(pid: number): Promise<void>;
  retry(): Promise<void>;
  openLogs(): Promise<string>;
  exportDiagnosticBundle(): Promise<DesktopDiagnosticBundleResult | null>;
  quit(): Promise<void>;
  productConnectors(provider?: string): Promise<unknown>;
  productConnectorSync(body: { provider: string; full?: boolean; dry_run?: boolean }): Promise<unknown>;
  productConnectorAuth(body: { provider: string; cookie?: string; token?: string }): Promise<unknown>;
  productConnectorLogout(provider: string): Promise<unknown>;
  productConnectorAutoSync(provider: string, enabled: boolean): Promise<unknown>;
  productWaiting(): Promise<unknown>;
  productWaitingClose(body: { id: number; status: 'done' | 'dropped'; note?: string }): Promise<unknown>;
  productWaitingScan(lanes?: Array<'gmail' | 'meeting' | 'conversation'>): Promise<unknown>;
  productChronicleDay(date?: string): Promise<unknown>;
  productChronicleOnThisDay(date?: string): Promise<unknown>;
  productChronicleStatus(): Promise<unknown>;
  productEnableChronicle(): Promise<unknown>;
  productOrganizeChronicleHistory(): Promise<unknown>;
  productHideChronicleEvent(slug: string): Promise<unknown>;
  productOntology(entity: string): Promise<unknown>;
  productEntityIdentity(query?: { entity_id?: string; slug?: string }): Promise<unknown>;
  productEntityIdentityLink(body: { entity_id: string; slug: string; source_id: string; canonical?: boolean }): Promise<unknown>;
  productPeople(query?: string): Promise<unknown>;
  productPeopleCard(entityId: string): Promise<unknown>;
  productMergePeople(members: Array<{ source_id: string; slug: string; title?: string }>): Promise<unknown>;
  productRejectPeople(body: { left: { source_id: string; slug: string }; right: { source_id: string; slug: string } }): Promise<unknown>;
  productUnlinkPeople(body: { entity_id: string; source_id: string; slug: string }): Promise<unknown>;
  googleStatus(): Promise<unknown>;
  googleConnect(input?: { account?: string; paste?: boolean; code?: string; clientJsonPath?: string }): Promise<{
    ok: boolean;
    status: string;
    next_action?: { command?: string; user_message?: string };
    error?: { code: string; problem?: string; cause?: string; fix?: string };
    account?: string;
  }>;
  googleSource(body: { account: string; id?: string }): Promise<unknown>;
  chooseFile(filters?: Array<{ name: string; extensions: string[] }>): Promise<string | null>;
  openExternal(url: string): Promise<void>;
}

const api: PMBrainDesktopApi = {
  onNavigate: listener => {
    const handler = (_event: Electron.IpcRendererEvent, target: string) => listener(target);
    ipcRenderer.on('desktop:navigate', handler);
    return () => ipcRenderer.removeListener('desktop:navigate', handler);
  },
  productRequest: request => ipcRenderer.invoke('desktop:product-request', request),
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
  listDockerDatabases: () => ipcRenderer.invoke('desktop:list-docker-databases'),
  activateDockerDatabase: (containerName) => ipcRenderer.invoke('desktop:activate-docker-database', containerName),
  getIntegrations: (probe) => ipcRenderer.invoke('desktop:get-integrations', probe),
  chooseEmbeddingRebuild: (choice) => ipcRenderer.invoke('desktop:choose-embedding-rebuild', choice),
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
  getSystemSettings: () => ipcRenderer.invoke('desktop:get-system-settings'),
  saveSystemSettings: (payload) => ipcRenderer.invoke('desktop:save-system-settings', payload),
  getMemoryWriteback: () => ipcRenderer.invoke('desktop:get-memory-writeback'),
  saveMemoryWriteback: (payload) => ipcRenderer.invoke('desktop:save-memory-writeback', payload),
  onSystemSettingsState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopSystemSettingsState) => listener(state);
    ipcRenderer.on('desktop:system-settings-state', handler);
    return () => ipcRenderer.removeListener('desktop:system-settings-state', handler);
  },
  getSharedAccess: () => ipcRenderer.invoke('desktop:get-shared-access'),
  createSharedIntegration: (payload) => ipcRenderer.invoke('desktop:create-shared-integration', payload),
  revokeSharedIntegration: (credentialName) => ipcRenderer.invoke('desktop:revoke-shared-integration', credentialName),
  chooseDirectory: (initialPath) => ipcRenderer.invoke('desktop:choose-directory', initialPath),
  inspectKnowledgeSourceDirectory: (path) => ipcRenderer.invoke('desktop:inspect-knowledge-source', path),
  initializeKnowledgeSourceGit: (path) => ipcRenderer.invoke('desktop:initialize-knowledge-source-git', path),
  getProviderModels: (provider, touchpoint) => ipcRenderer.invoke('desktop:get-provider-models', provider, touchpoint),
  testModelConnection: input => ipcRenderer.invoke('desktop:test-model-connection', input),
  getAdvancedModelConfig: () => ipcRenderer.invoke('desktop:get-advanced-model-config'),
  saveAdvancedModelConfig: (values) => ipcRenderer.invoke('desktop:save-advanced-model-config', values),
  saveSetup: (payload) => ipcRenderer.invoke('desktop:save-setup', payload),
  inspectDockerMigration: () => ipcRenderer.invoke('desktop:inspect-docker-migration'),
  migrateToDocker: (planFingerprint, skipUnknown) => ipcRenderer.invoke('desktop:migrate-to-docker', planFingerprint, skipUnknown),
  openDockerInstallGuide: () => ipcRenderer.invoke('desktop:open-docker-install-guide'),
  configureIntegration: (client, kind, deep) => ipcRenderer.invoke('desktop:configure-integration', client, kind, deep),
  launchIntegration: client => ipcRenderer.invoke('desktop:launch-integration', client),
  writeWorkbuddyUserAgent: () => ipcRenderer.invoke('desktop:write-workbuddy-user-agent'),
  getWorkbuddyAgentIntegration: () => ipcRenderer.invoke('desktop:get-workbuddy-agent-integration'),
  installWorkbuddyAgent: (workspace) => ipcRenderer.invoke('desktop:install-workbuddy-agent', workspace),
  updateWorkbuddyAgent: () => ipcRenderer.invoke('desktop:update-workbuddy-agent'),
  removeWorkbuddyAgent: () => ipcRenderer.invoke('desktop:remove-workbuddy-agent'),
  copy: (value) => ipcRenderer.invoke('desktop:copy', value),
  openAdmin: () => ipcRenderer.invoke('desktop:open-admin'),
  checkUpdates: () => ipcRenderer.invoke('desktop:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('desktop:download-update'),
  installUpdate: () => ipcRenderer.invoke('desktop:install-update'),
  listPgliteUpgradeBackups: () => ipcRenderer.invoke('desktop:list-pglite-upgrade-backups'),
  prunePgliteUpgradeBackups: () => ipcRenderer.invoke('desktop:prune-pglite-upgrade-backups'),
  deletePgliteUpgradeBackup: (backupDirectory) => ipcRenderer.invoke('desktop:delete-pglite-upgrade-backup', backupDirectory),
  restorePgliteUpgradeBackup: (backupDirectory) => ipcRenderer.invoke('desktop:restore-pglite-upgrade-backup', backupDirectory),
  setPgliteUpgradeBackupRoot: (directory) => ipcRenderer.invoke('desktop:set-pglite-upgrade-backup-root', directory),
  openPgliteUpgradeBackup: (target) => ipcRenderer.invoke('desktop:open-pglite-upgrade-backup', target),
  diagnosePgliteToast: () => ipcRenderer.invoke('desktop:diagnose-pglite-toast'),
  replacePgliteToastRepair: (stagingPath) => ipcRenderer.invoke('desktop:replace-pglite-toast-repair', stagingPath),
  getPgliteRecoveryStatus: () => ipcRenderer.invoke('desktop:get-pglite-recovery-status'),
  terminatePgliteOwnerAndRetry: (pid) => ipcRenderer.invoke('desktop:terminate-pglite-owner-and-retry', pid),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
  exportDiagnosticBundle: () => ipcRenderer.invoke('desktop:export-diagnostic-bundle'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  productConnectors: (provider) => ipcRenderer.invoke('desktop:product-connectors', provider),
  productConnectorSync: (body) => ipcRenderer.invoke('desktop:product-connector-sync', body),
  productConnectorAuth: (body) => ipcRenderer.invoke('desktop:product-connector-auth', body),
  productConnectorLogout: (provider) => ipcRenderer.invoke('desktop:product-connector-logout', provider),
  productConnectorAutoSync: (provider, enabled) => ipcRenderer.invoke('desktop:product-connector-auto-sync', provider, enabled),
  productWaiting: () => ipcRenderer.invoke('desktop:product-waiting'),
  productWaitingClose: (body) => ipcRenderer.invoke('desktop:product-waiting-close', body),
  productWaitingScan: (lanes) => ipcRenderer.invoke('desktop:product-waiting-scan', lanes),
  productChronicleDay: (date) => ipcRenderer.invoke('desktop:product-chronicle-day', date),
  productChronicleOnThisDay: (date) => ipcRenderer.invoke('desktop:product-chronicle-on-this-day', date),
  productChronicleStatus: () => ipcRenderer.invoke('desktop:product-chronicle-status'),
  productEnableChronicle: () => ipcRenderer.invoke('desktop:product-chronicle-enable'),
  productOrganizeChronicleHistory: () => ipcRenderer.invoke('desktop:product-chronicle-history'),
  productHideChronicleEvent: (slug) => ipcRenderer.invoke('desktop:product-chronicle-hide', slug),
  productOntology: (entity) => ipcRenderer.invoke('desktop:product-ontology', entity),
  productEntityIdentity: (query) => ipcRenderer.invoke('desktop:product-entity-identity', query),
  productEntityIdentityLink: (body) => ipcRenderer.invoke('desktop:product-entity-identity-link', body),
  productPeople: (query) => ipcRenderer.invoke('desktop:product-people', query),
  productPeopleCard: (entityId) => ipcRenderer.invoke('desktop:product-people-card', entityId),
  productMergePeople: (members) => ipcRenderer.invoke('desktop:product-people-merge', members),
  productRejectPeople: (body) => ipcRenderer.invoke('desktop:product-people-reject', body),
  productUnlinkPeople: (body) => ipcRenderer.invoke('desktop:product-people-unlink', body),
  googleStatus: () => ipcRenderer.invoke('desktop:google-status'),
  googleConnect: (input) => ipcRenderer.invoke('desktop:google-connect', input),
  googleSource: (body) => ipcRenderer.invoke('desktop:google-source', body),
  chooseFile: (filters) => ipcRenderer.invoke('desktop:choose-file', filters),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
};

contextBridge.exposeInMainWorld('pmbrainDesktop', api);
