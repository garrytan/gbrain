import type { MemoryWritebackStatus, MemoryWritebackUpdate } from '../../../shared/contracts/brain.js';
import {
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from 'electron';
import type { AdvancedModelWriteInput } from './advanced-model-config.js';
import type { CredentialKind, IntegrationClient, SharedIntegrationPayload } from './integration-manager.js';
import type { DesktopModelTouchpoint } from './model-catalog.js';
import type {
  DesktopModelConnectionTestInput,
  DesktopModelConnectionTestResult,
} from './model-connection-test.js';
import type { SidecarState } from './sidecar-manager.js';
import type {
  DesktopSystemSettingsPayload,
  DesktopSystemSettingsSaveResult,
  DesktopSystemSettingsState,
} from './system-settings.js';
import type { DesktopTheme, SetupPayload } from './config-manager.js';
import type { UpdateState } from './update-manager.js';
import type {
  DesktopPgliteUpgradeBackupMutation,
  DesktopPgliteUpgradeBackups,
  DesktopToastDiagnoseResult,
  DesktopToastRepairResult,
} from '../preload/index.js';
import type { DesktopKnowledgeSourceStatus } from './knowledge-source-git.js';
import type { PgliteOwnerStatus } from '../../../src/core/pglite-owner-control.js';
import type { ProductSurfaceHandlers } from './product-surfaces.js';
import { isSafeGoogleConsentUrl } from '../../../src/core/creds/oauth-envelope.js';
import { validateProductRequest, type ProductRequest, type ProductResponse } from './product-request.js';

type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any;

export interface DesktopIpcHandlers {
  productRequest: (request: ProductRequest) => Promise<ProductResponse>;
  assertTrustedSender: (event: IpcMainInvokeEvent) => void;
  mainWindow: () => BrowserWindow | null;
  state: () => SidecarState | null;
  startupProgress: () => unknown;
  theme: () => unknown;
  setTheme: (value: DesktopTheme) => unknown;
  systemSettings: () => DesktopSystemSettingsState;
  saveSystemSettings: (payload: DesktopSystemSettingsPayload) => Promise<DesktopSystemSettingsSaveResult>;
  memoryWriteback: () => Promise<unknown>;
  saveMemoryWriteback: (payload: MemoryWritebackUpdate) => Promise<unknown>;
  sharedAccess: () => Promise<unknown>;
  createSharedIntegration: (payload: SharedIntegrationPayload) => Promise<unknown>;
  revokeSharedIntegration: (credentialName: string) => Promise<unknown>;
  updateState: () => UpdateState | null;
  setup: () => Promise<unknown>;
  listDockerDatabases: () => Promise<unknown>;
  activateDockerDatabase: (containerName: string) => Promise<unknown>;
  integrations: (probe: boolean) => Promise<unknown>;
  inspectKnowledgeSourceDirectory: (path: string) => DesktopKnowledgeSourceStatus;
  initializeKnowledgeSourceGit: (path: string) => DesktopKnowledgeSourceStatus;
  providerModels: (provider: string, touchpoint: DesktopModelTouchpoint) => unknown;
  testModelConnection: (input: DesktopModelConnectionTestInput) => Promise<DesktopModelConnectionTestResult>;
  advancedModelConfig: () => Promise<unknown>;
  saveAdvancedModelConfig: (values: AdvancedModelWriteInput) => Promise<unknown>;
  saveSetup: (payload: SetupPayload) => Promise<unknown>;
  inspectDockerMigration: () => Promise<unknown>;
  migrateToDocker: (planFingerprint: string, skipUnknown: boolean) => Promise<unknown>;
  openDockerInstallGuide: () => Promise<unknown>;
  chooseEmbeddingRebuild: (choice: 'wait' | 'defer') => void;
  configureIntegration: (client: IntegrationClient, kind: CredentialKind, deep?: boolean) => Promise<unknown>;
  launchIntegration: (client: IntegrationClient) => Promise<void>;
  writeWorkbuddyUserAgent: () => Promise<unknown>;
  getWorkbuddyAgentIntegration: () => Promise<unknown>;
  installWorkbuddyAgent: (workspace: string) => Promise<unknown>;
  updateWorkbuddyAgent: () => Promise<unknown>;
  removeWorkbuddyAgent: () => Promise<unknown>;
  openAdmin: () => Promise<void>;
  checkUpdates: () => Promise<unknown> | undefined;
  downloadUpdate: () => Promise<unknown> | undefined;
  installUpdate: () => Promise<unknown> | undefined;
  pgliteUpgradeBackups: () => Promise<DesktopPgliteUpgradeBackups>;
  prunePgliteUpgradeBackups: () => Promise<DesktopPgliteUpgradeBackupMutation>;
  deletePgliteUpgradeBackup: (backupDirectory: string) => Promise<DesktopPgliteUpgradeBackupMutation>;
  restorePgliteUpgradeBackup: (backupDirectory: string) => Promise<DesktopPgliteUpgradeBackupMutation>;
  setPgliteUpgradeBackupRoot: (directory: string) => Promise<DesktopPgliteUpgradeBackupMutation>;
  openPgliteUpgradeBackup: (target: string) => Promise<void>;
  diagnosePgliteToast: () => Promise<DesktopToastDiagnoseResult>;
  replacePgliteToastRepair: (stagingPath: string) => Promise<DesktopToastRepairResult>;
  previousVersion: () => string | undefined;
  pgliteRecoveryStatus: () => Promise<PgliteOwnerStatus>;
  terminatePgliteOwnerAndRetry: (pid: number) => Promise<string | undefined>;
  retry: () => Promise<string | undefined>;
  openLogs: () => Promise<void> | void;
  exportDiagnosticBundle: () => Promise<unknown>;
  productSurfaces: ProductSurfaceHandlers;
  chooseFile: (filters?: Array<{ name: string; extensions: string[] }>) => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;
}

function registerTrustedHandler(
  channel: string,
  handlers: DesktopIpcHandlers,
  listener: IpcHandler,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    handlers.assertTrustedSender(event);
    return listener(event, ...args);
  });
}

export function registerDesktopIpcHandlers(handlers: DesktopIpcHandlers): void {
  registerTrustedHandler('desktop:product-request', handlers, (_event, request) => handlers.productRequest(validateProductRequest(request)));
  registerTrustedHandler('desktop:get-state', handlers, () => handlers.state());
  registerTrustedHandler('desktop:get-startup-progress', handlers, () => handlers.startupProgress());
  registerTrustedHandler('desktop:get-theme', handlers, () => handlers.theme());
  registerTrustedHandler('desktop:set-theme', handlers, (_event, value: DesktopTheme) => handlers.setTheme(value));
  registerTrustedHandler('desktop:get-system-settings', handlers, () => handlers.systemSettings());
  registerTrustedHandler('desktop:save-system-settings', handlers, (_event, payload: DesktopSystemSettingsPayload) => handlers.saveSystemSettings(payload));
  registerTrustedHandler('desktop:get-memory-writeback', handlers, () => handlers.memoryWriteback());
  registerTrustedHandler('desktop:save-memory-writeback', handlers, (_event, payload: MemoryWritebackUpdate) => handlers.saveMemoryWriteback(payload));
  registerTrustedHandler('desktop:get-shared-access', handlers, () => handlers.sharedAccess());
  registerTrustedHandler('desktop:create-shared-integration', handlers, (_event, payload: SharedIntegrationPayload) => handlers.createSharedIntegration(payload));
  registerTrustedHandler('desktop:revoke-shared-integration', handlers, (_event, credentialName: string) => handlers.revokeSharedIntegration(credentialName));
  registerTrustedHandler('desktop:get-update-state', handlers, () => handlers.updateState());
  registerTrustedHandler('desktop:get-setup', handlers, () => handlers.setup());
  registerTrustedHandler('desktop:list-docker-databases', handlers, () => handlers.listDockerDatabases());
  registerTrustedHandler('desktop:activate-docker-database', handlers, (_event, containerName: string) => handlers.activateDockerDatabase(containerName));
  registerTrustedHandler('desktop:get-integrations', handlers, (_event, probe?: boolean) => handlers.integrations(probe === true));
  registerTrustedHandler('desktop:inspect-knowledge-source', handlers, (_event, path: string) => handlers.inspectKnowledgeSourceDirectory(path));
  registerTrustedHandler('desktop:initialize-knowledge-source-git', handlers, (_event, path: string) => handlers.initializeKnowledgeSourceGit(path));
  registerTrustedHandler('desktop:choose-directory', handlers, async (_event, initialPath?: string) => {
    const window = handlers.mainWindow();
    if (!window) throw new Error('PMBrain 桌面窗口尚未就绪。');
    const result = await dialog.showOpenDialog(window, {
      defaultPath: initialPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  registerTrustedHandler('desktop:get-provider-models', handlers, (_event, provider: string, touchpoint: DesktopModelTouchpoint) => handlers.providerModels(provider, touchpoint));
  registerTrustedHandler('desktop:test-model-connection', handlers, (_event, input: DesktopModelConnectionTestInput) => handlers.testModelConnection(input));
  registerTrustedHandler('desktop:get-advanced-model-config', handlers, () => handlers.advancedModelConfig());
  registerTrustedHandler('desktop:save-advanced-model-config', handlers, (_event, values: AdvancedModelWriteInput) => handlers.saveAdvancedModelConfig(values ?? {}));
  registerTrustedHandler('desktop:save-setup', handlers, (_event, payload: SetupPayload) => handlers.saveSetup(payload));
  registerTrustedHandler('desktop:inspect-docker-migration', handlers, () => handlers.inspectDockerMigration());
  registerTrustedHandler('desktop:migrate-to-docker', handlers, (_event, planFingerprint: string, skipUnknown: boolean) => handlers.migrateToDocker(planFingerprint, skipUnknown));
  registerTrustedHandler('desktop:open-docker-install-guide', handlers, () => handlers.openDockerInstallGuide());
  registerTrustedHandler('desktop:choose-embedding-rebuild', handlers, (_event, choice: 'wait' | 'defer') => handlers.chooseEmbeddingRebuild(choice));
  registerTrustedHandler('desktop:configure-integration', handlers, (_event, client: IntegrationClient, kind: CredentialKind, deep?: boolean) => handlers.configureIntegration(client, kind, deep));
  registerTrustedHandler('desktop:launch-integration', handlers, (_event, client: IntegrationClient) => handlers.launchIntegration(client));
  registerTrustedHandler('desktop:write-workbuddy-user-agent', handlers, () => handlers.writeWorkbuddyUserAgent());
  registerTrustedHandler('desktop:get-workbuddy-agent-integration', handlers, () => handlers.getWorkbuddyAgentIntegration());
  registerTrustedHandler('desktop:install-workbuddy-agent', handlers, (_event, workspace: string) => handlers.installWorkbuddyAgent(workspace));
  registerTrustedHandler('desktop:update-workbuddy-agent', handlers, () => handlers.updateWorkbuddyAgent());
  registerTrustedHandler('desktop:remove-workbuddy-agent', handlers, () => handlers.removeWorkbuddyAgent());
  registerTrustedHandler('desktop:copy', handlers, (_event, value: string) => clipboard.writeText(value));
  registerTrustedHandler('desktop:open-admin', handlers, () => handlers.openAdmin());
  registerTrustedHandler('desktop:check-updates', handlers, () => handlers.checkUpdates());
  registerTrustedHandler('desktop:download-update', handlers, () => handlers.downloadUpdate());
  registerTrustedHandler('desktop:install-update', handlers, () => handlers.installUpdate());
  registerTrustedHandler('desktop:list-pglite-upgrade-backups', handlers, () => handlers.pgliteUpgradeBackups());
  registerTrustedHandler('desktop:prune-pglite-upgrade-backups', handlers, () => handlers.prunePgliteUpgradeBackups());
  registerTrustedHandler('desktop:delete-pglite-upgrade-backup', handlers, (_event, backupDirectory: string) => handlers.deletePgliteUpgradeBackup(backupDirectory));
  registerTrustedHandler('desktop:restore-pglite-upgrade-backup', handlers, (_event, backupDirectory: string) => handlers.restorePgliteUpgradeBackup(backupDirectory));
  registerTrustedHandler('desktop:set-pglite-upgrade-backup-root', handlers, (_event, directory: string) => handlers.setPgliteUpgradeBackupRoot(directory));
  registerTrustedHandler('desktop:open-pglite-upgrade-backup', handlers, (_event, target: string) => handlers.openPgliteUpgradeBackup(target));
  registerTrustedHandler('desktop:diagnose-pglite-toast', handlers, () => handlers.diagnosePgliteToast());
  registerTrustedHandler('desktop:replace-pglite-toast-repair', handlers, (_event, stagingPath: string) => handlers.replacePgliteToastRepair(stagingPath));
  registerTrustedHandler('desktop:open-previous-release', handlers, async () => {
    const previous = handlers.previousVersion();
    if (!previous) throw new Error('当前没有可用的上一版本记录。');
    await shell.openExternal(`https://github.com/zhengyunhui123-dev/PMBrain/releases/tag/v${previous}`);
  });
  registerTrustedHandler('desktop:get-pglite-recovery-status', handlers, () => handlers.pgliteRecoveryStatus());
  registerTrustedHandler('desktop:terminate-pglite-owner-and-retry', handlers, async (_event, pid: number) => {
    const url = await handlers.terminatePgliteOwnerAndRetry(pid);
    if (url) handlers.mainWindow()?.webContents.send('desktop:navigate', 'import');
  });
  registerTrustedHandler('desktop:retry', handlers, async () => {
    const url = await handlers.retry();
    if (url) handlers.mainWindow()?.webContents.send('desktop:navigate', 'import');
  });
  registerTrustedHandler('desktop:open-logs', handlers, () => handlers.openLogs());
  registerTrustedHandler('desktop:export-diagnostic-bundle', handlers, () => handlers.exportDiagnosticBundle());
  registerTrustedHandler('desktop:quit', handlers, () => app.quit());
  registerTrustedHandler('desktop:product-connectors', handlers, (_event, provider?: string) => handlers.productSurfaces.connectors(provider));
  registerTrustedHandler('desktop:product-connector-sync', handlers, (_event, body: { provider: string; full?: boolean; dry_run?: boolean }) => handlers.productSurfaces.connectorSync(body));
  registerTrustedHandler('desktop:product-connector-auth', handlers, (_event, body: { provider: string; cookie?: string; token?: string }) => handlers.productSurfaces.connectorAuth(body));
  registerTrustedHandler('desktop:product-connector-logout', handlers, (_event, provider: string) => handlers.productSurfaces.connectorLogout(provider));
  registerTrustedHandler('desktop:product-connector-auto-sync', handlers, (_event, provider: string, enabled: boolean) => handlers.productSurfaces.connectorAutoSync(provider, enabled));
  registerTrustedHandler('desktop:product-waiting', handlers, () => handlers.productSurfaces.waiting());
  registerTrustedHandler('desktop:product-waiting-close', handlers, (_event, body: { id: number; status: 'done' | 'dropped'; note?: string }) => handlers.productSurfaces.closeWaiting(body));
  registerTrustedHandler('desktop:product-waiting-scan', handlers, (_event, lanes?: Array<'gmail' | 'meeting' | 'conversation'>) => handlers.productSurfaces.waitingScan(lanes));
  registerTrustedHandler('desktop:product-chronicle-day', handlers, (_event, date?: string) => handlers.productSurfaces.chronicleDay(date));
  registerTrustedHandler('desktop:product-chronicle-on-this-day', handlers, (_event, date?: string) => handlers.productSurfaces.chronicleOnThisDay(date));
  registerTrustedHandler('desktop:product-chronicle-status', handlers, () => handlers.productSurfaces.chronicleStatus());
  registerTrustedHandler('desktop:product-chronicle-enable', handlers, () => handlers.productSurfaces.enableChronicle());
  registerTrustedHandler('desktop:product-chronicle-history', handlers, () => handlers.productSurfaces.organizeChronicleHistory());
  registerTrustedHandler('desktop:product-chronicle-hide', handlers, (_event, slug: string) => handlers.productSurfaces.hideChronicleEvent(slug));
  registerTrustedHandler('desktop:product-ontology', handlers, (_event, entity: string) => handlers.productSurfaces.ontology(entity));
  registerTrustedHandler('desktop:product-entity-identity', handlers, (_event, query?: { entity_id?: string; slug?: string }) => handlers.productSurfaces.entityIdentity(query));
  registerTrustedHandler('desktop:product-entity-identity-link', handlers, (_event, body: { entity_id: string; slug: string; source_id: string; canonical?: boolean }) => handlers.productSurfaces.linkEntityIdentity(body));
  registerTrustedHandler('desktop:product-people', handlers, (_event, query?: string) => handlers.productSurfaces.people(query));
  registerTrustedHandler('desktop:product-people-card', handlers, (_event, entityId: string) => handlers.productSurfaces.peopleCard(entityId));
  registerTrustedHandler('desktop:product-people-merge', handlers, (_event, members: Array<{ source_id: string; slug: string; title?: string }>) => handlers.productSurfaces.mergePeople(members));
  registerTrustedHandler('desktop:product-people-reject', handlers, (_event, body: { left: { source_id: string; slug: string }; right: { source_id: string; slug: string } }) => handlers.productSurfaces.rejectPeople(body));
  registerTrustedHandler('desktop:product-people-unlink', handlers, (_event, body: { entity_id: string; source_id: string; slug: string }) => handlers.productSurfaces.unlinkPeople(body));
  registerTrustedHandler('desktop:google-status', handlers, () => handlers.productSurfaces.googleStatus());
  registerTrustedHandler('desktop:google-connect', handlers, (_event, input?: { account?: string; paste?: boolean; code?: string; clientJsonPath?: string }) => handlers.productSurfaces.googleConnect(input));
  registerTrustedHandler('desktop:google-source', handlers, (_event, body: { account: string; id?: string }) => handlers.productSurfaces.addGoogleSource(body));
  registerTrustedHandler('desktop:choose-file', handlers, (_event, filters?: Array<{ name: string; extensions: string[] }>) => handlers.chooseFile(filters));
  registerTrustedHandler('desktop:open-external', handlers, (_event, url: string) => {
    if (!isSafeGoogleConsentUrl(url)) throw new Error('拒绝打开未授权的外部地址。');
    return handlers.openExternal(url);
  });
}
