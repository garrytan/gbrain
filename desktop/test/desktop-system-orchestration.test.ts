import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const main = readdirSync(resolve('src/main'), { recursive: true })
  .filter((path): path is string => typeof path === 'string' && path.endsWith('.ts'))
  .sort()
  .map(path => readFileSync(resolve('src/main', path), 'utf8'))
  .join('\n');
const sidecar = readFileSync(resolve('src/main/sidecar-manager.ts'), 'utf8');
const gateway = readFileSync(resolve('src/main/lan-mcp-gateway.ts'), 'utf8');
const integrationManager = readFileSync(resolve('src/main/integration-manager.ts'), 'utf8');
const preload = readFileSync(resolve('src/preload/index.ts'), 'utf8');
const setupController = readFileSync(resolve('src/main/startup/setup-controller.ts'), 'utf8');
const databaseController = readFileSync(resolve('src/main/database/database-upgrade.ts'), 'utf8');
const backupController = readFileSync(resolve('src/main/database/pglite-backup.ts'), 'utf8');
const sidecarController = readFileSync(resolve('src/main/sidecar/sidecar-controller.ts'), 'utf8');
const lanController = readFileSync(resolve('src/main/network/lan-controller.ts'), 'utf8');
const sharedAccessController = readFileSync(resolve('src/main/integration/shared-access-controller.ts'), 'utf8');
const trayController = readFileSync(resolve('src/main/app/tray-controller.ts'), 'utf8');
const menuController = readFileSync(resolve('src/main/app/menu-controller.ts'), 'utf8');

describe('desktop system orchestration contracts', () => {
  test('keeps the original sidecar private and exposes sharing through the desktop gateway', () => {
    expect(sidecar).toContain("'--bind', '127.0.0.1'");
    expect(sidecar).not.toContain("'--bind', '0.0.0.0'");
    expect(main).toContain('new LanMcpGateway');
    expect(main).toContain('sharedIp');
    expect(main).toContain('不会自动切换到其他网卡');
  });

  test('uses the sidecar as the only MCP tool and permission authority', () => {
    expect(gateway).not.toContain('SHARED_MCP_READ_TOOL_NAMES');
    expect(gateway).not.toContain('SHARED_MCP_WRITE_TOOL_NAMES');
    expect(gateway).not.toContain('SHARED_MCP_TOOL_SET');
    expect(gateway).not.toContain('filterToolsListResponse');
    expect(integrationManager).not.toContain('SHARED_MCP_TOOL_NAMES');
  });

  test('opens the current log in the system file manager instead of the default folder handler', () => {
    expect(main).toContain('shell.showItemInFolder(logger.filePath)');
    expect(main).not.toContain('shell.openPath(logger.directory)');
  });

  test('Postgres 用户升级时仍先准备数据库并执行原有迁移流程', () => {
    expect(setupController).toMatch(/async applyOnce[\s\S]*?ensureRuntimeReady\(\)[\s\S]*?hadRunningSidecar[\s\S]*?saveSetup\(payload\)/);
    expect(setupController).toMatch(/saveSetup\(payload\)[\s\S]*?prepareConfiguredDatabase\(\)[\s\S]*?needsDesktopMigration/);
    expect(databaseController).toContain('saveDetectedDockerContainerName');
    expect(databaseController).toContain('runCliChecked(this.dependencies.runtime(), DESKTOP_MIGRATION_ARGS)');
  });

  test('Sidecar 启动失败会把 exit code 和完整 stderr 写入桌面日志', () => {
    expect(sidecar).toContain('healthTimeoutMs');
    expect(sidecar).toContain('logSidecarFailure');
    expect(sidecar).toContain('exitCode=');
    expect(sidecar).toContain('(empty)');
    expect(sidecar).toContain('onStderr');
    expect(sidecarController).toContain('resolveSidecarHealthTimeoutMs');
    expect(sidecarController).toContain('POST_UPGRADE_HEALTH_TIMEOUT_MS');
    expect(sidecarController).toContain("failure.recentStderr");
    expect(sidecarController).toContain('GIN_REPAIR_PROGRESS_MESSAGE');
    expect(sidecarController).toContain('GIN_REPAIR_SUCCESS_MESSAGE');
    expect(sidecarController).toContain('GIN_REPAIR_DB_UNUSABLE_MESSAGE');
  });

  test('PGLite 用户升级时只由 sidecar 打开数据库，健康后才记录升级完成', () => {
    expect(main).toContain("setup.current.engine === 'pglite'");
    expect(databaseController).toMatch(/async migrateConfiguredInstallation[\s\S]*?engine === 'pglite'[\s\S]*?pgliteBackup\.ensureUpgradeBackup[\s\S]*?return true;[\s\S]*?DESKTOP_MIGRATION_ARGS/);
    expect(sidecarController).toMatch(/migrateConfiguredInstallation\(\)[\s\S]*?this\.start\(false\)[\s\S]*?engine === 'pglite'\)[\s\S]*?markDesktopMigration/);
    expect(sidecarController).toMatch(/async restartForRetry[\s\S]*?needsDesktopMigration\(app\.getVersion\(\)\)[\s\S]*?startOnce\(false\)[\s\S]*?markDesktopMigration\(app\.getVersion\(\)\)/);
    expect(main).toContain('PGLite 数据库路径：${databasePath}');
  });

  test('PGLite 迁移前完成冷备和恢复验证，失败时显示备份而不自动覆盖', () => {
    expect(backupController).toContain('async ensureUpgradeBackup');
    expect(backupController).toContain("'pglite-backup',");
    expect(backupController).toContain("'create',");
    expect(backupController).toContain("'--target-version', this.dependencies.appVersion()");
    expect(databaseController).toContain('pgliteBackup.ensureUpgradeBackup(setup.current.databasePath)');
    expect(setupController).toMatch(/migrationRequired = needsDesktopMigration[\s\S]*?engine === 'pglite'[\s\S]*?pgliteBackup\.ensureUpgradeBackup[\s\S]*?needsEmbeddingDimensionProbe/);
    expect(main).toContain('升级前冷备已验证并保留');
    expect(main).toContain('PMBrain 不会自动覆盖当前数据库');
    expect(backupController).toContain("process.platform === 'win32' ? databasePath.toLowerCase() : databasePath");
    expect(backupController).toMatch(/backupByVersion\.has\(key\)[\s\S]*?pendingBackupPath = cached/);
    expect(backupController).toMatch(/pendingBackupPath = null;[\s\S]*?runCliChecked\(this\.dependencies\.runtime\(\), \[/);
  });

  test('软件修复通过 CLI 列出、恢复、删除和清理 PGLite 备份', () => {
    expect(main).toContain("'desktop:list-pglite-upgrade-backups'");
    expect(main).toContain("'desktop:prune-pglite-upgrade-backups'");
    expect(main).toContain("'desktop:delete-pglite-upgrade-backup'");
    expect(main).toContain("'desktop:restore-pglite-upgrade-backup'");
    expect(main).toContain("'desktop:set-pglite-upgrade-backup-root'");
    expect(main).toContain("'desktop:open-pglite-upgrade-backup'");
    expect(preload).toContain("'desktop:list-pglite-upgrade-backups'");
    expect(preload).toContain("'desktop:restore-pglite-upgrade-backup'");
    expect(backupController).toMatch(/listUpgradeBackups[\s\S]*?'pglite-backup',[\s\S]*?'list',[\s\S]*?'--path'/);
    expect(backupController).toContain("'prune'");
    expect(backupController).toContain("'delete'");
    expect(backupController).toContain("'restore'");
    expect(main).toContain("'desktop:diagnose-pglite-toast'");
    expect(main).toContain("'desktop:replace-pglite-toast-repair'");
    expect(main).toContain("'repair', 'toast-diagnose'");
    expect(main).toContain("'repair', 'toast-replace'");
    expect(main).not.toContain("from '../../../src/core/pglite-toast-repair");
    expect(readFileSync(resolve('../src/core/model-usage.ts'), 'utf8')).not.toMatch(/import\s*\{[^}]*ALL_PHASES[^}]*\}\s*from\s*['\"]\.\/cycle\.ts['\"]/);
    expect(backupController).toContain('parseSuccessfulBackupJsonFromError');
    expect(backupController).toContain("recovered?.status !== 'restored'");
    expect(backupController).toContain("'set-root'");
    expect(backupController).toContain("'--yes'");
    expect(backupController).toContain("'--keep', '2'");
    expect(backupController).not.toContain("from '../../../src/core/pglite-upgrade-backup");
    expect(sidecarController).toContain('withPausedForPgliteBackupRestore');
    expect(sidecarController).toMatch(/markDesktopMigration\(app\.getVersion\(\)\);[\s\S]*?prunePgliteUpgradeBackups\(\)/);
  });

  test('桌面启动阶段不自动启动 Supervisor、Worker、Dream 或 Autopilot', () => {
    expect(main).not.toMatch(/runCliChecked\(runtime\(\), \[['"]jobs['"], ['"]supervisor['"], ['"]start['"]/);
    expect(main).not.toMatch(/runCliChecked\(runtime\(\), \[['"]worker['"]/);
    expect(main).not.toMatch(/runCliChecked\(runtime\(\), \[['"]dream['"]/);
    expect(main).not.toMatch(/runCliChecked\(runtime\(\), \[['"]autopilot['"]/);
  });

  test('wires native system settings, tray behavior, autostart, and shared credentials through IPC', () => {
    for (const channel of [
      'desktop:get-system-settings',
      'desktop:save-system-settings',
      'desktop:save-desktop-behavior',
      'desktop:get-shared-access',
      'desktop:create-shared-integration',
      'desktop:revoke-shared-integration',
    ]) {
      expect(main).toContain(channel);
      expect(preload).toContain(channel);
    }
    expect(main).toContain('new Tray');
    expect(main).toContain("closeBehavior === 'quit'");
    expect(main).toContain('startMinimized && !getSetupInfo().needsSetup');
    expect(main).toContain('app.setLoginItemSettings');
    expect(main).toContain('dialog.showMessageBox');
  });

  test('MCP 卡片快照不等待连接探测，Grok 深度接入复用 Claude 兼容合同', () => {
    expect(setupController).toMatch(/async currentState\(configurationOnly = false\)[\s\S]*?integrations: listIntegrations\(/);
    expect(setupController).toMatch(/async integrationStates\(\)[\s\S]*?listIntegrationsWithConnectionState/);
    expect(sharedAccessController).toContain("client === 'grok' ? 'claude' : client");
    expect(integrationManager).toContain("['codex', 'claude', 'grok'].includes(client)");
  });

  test('fails closed across network changes and untrusted renderer navigation', () => {
    expect(main).toContain('共享不会自动恢复');
    expect(main).toContain('selectedAddressWasUnavailable');
    expect(main).toContain('sharedResumeRequired');
    expect(main).toContain('selectedCandidate?.recommended');
    expect(main).toContain('markSharedResumeRequired(true)');
    expect(main).toContain("webContents.on('will-navigate'");
    expect(main).toContain("webContents.on('will-redirect'");
    expect(main).toContain('isTrustedDesktopShellUrl');
    expect(main).toContain('registerTrustedHandler');
    expect(main).toContain('handlers.assertTrustedSender(event)');
    expect(main).toContain('系统偏好已保存，但局域网共享入口未能启动');
    expect(main).toContain("url.hostname === '127.0.0.1' || url.hostname === 'localhost'");
  });

  test('returns to native desktop panels and reconciles the database main source before saving', () => {
    expect(trayController).toContain('click: this.dependencies.openDesktop');
    expect(trayController).toContain("tray.on('double-click', this.dependencies.openDesktop)");
    expect(main).toContain("'/admin/api/brain/overview'");
    expect(main).toContain("'/admin/api/advisor'");
    expect(trayController).not.toContain("知识库体检");
    expect(menuController).not.toContain("知识库体检");
    expect(menuController).toContain("{ label: '实际大小', role: 'resetZoom' }");
    expect(menuController).toContain("{ label: '放大', role: 'zoomIn' }");
    expect(menuController).toContain("{ label: '缩小', role: 'zoomOut' }");
    expect(menuController).toContain("{ label: '切换全屏', role: 'togglefullscreen' }");
    expect(menuController).not.toContain("role: 'viewMenu'");
    expect(main).not.toContain('collectChronicle');
    expect(main).not.toContain('runAdvisor');
    expect(main).toContain('knowledgeSourceChanged === true');
    expect(setupController).toContain('this.applyOnce(effectivePayload, sourcePolicy');
    expect(setupController).toContain('repairMissingMainSourcePath');
    expect(setupController).toContain("'/admin/api/sources/local-path'");
    expect(setupController).toContain('!sourcePolicy.explicitSourceChange');
    expect(setupController).toContain('ensureKnowledgeDirectory(knowledgeDirectory)');
    expect(setupController).toContain('sourcePolicy.applySourceConfiguration');
    expect(setupController).toContain('sourcePolicy.bindPath');
    expect(setupController).toContain('主源路径校验失败');
  });

  test('serializes gateway transitions and keeps service startup single-flight', () => {
    expect(lanController).toContain('transitionQueue');
    expect(lanController).toContain('transitionGeneration');
    expect(lanController).toContain('queueTransition');
    expect(lanController).toContain('stopNow');
    expect(sidecarController).toContain('lifecycleQueue');
    expect(sidecarController).toContain('queueTransition');
    expect(sidecarController).toContain('readyPromise');
    expect(sidecarController).toContain('startupPromise');
  });

  test('only clears embeddings after explicit desktop confirmation, and does it immediately', () => {
    expect(main).toContain('saved.embeddingModelChanged');
    expect(main).toContain('saved.embeddingModelActivated');
    expect(main).toContain("'--empty-only'");
    expect(main).toContain('payload.confirmEmbeddingRebuild !== true');
    expect(main).toContain('embeddingVectorsCleared');
    expect(main).toContain("'--force-reembed'");
    expect(main).toContain("'/admin/api/runs/action'");
    expect(main).not.toContain('pauseEmbeddingRebuild');
    expect(main).not.toContain('forceReembed: true');
    expect(main).toContain('if (!embeddingSwitchCommitted) restoreConfig(saved.snapshot)');
  });

  test('启动前只对空向量库自动修复维度漂移，并在已有向量时保留数据', () => {
    expect(databaseController).toContain("'models', 'embedding-dimension-status', '--json'");
    expect(databaseController).toContain('existing_embeddings');
    expect(databaseController).toContain("'--empty-only'");
    expect(databaseController).toContain('pgliteBackup.ensureUpgradeBackup');
    expect(databaseController).toContain('automatic clearing was refused');
    expect(sidecarController).toMatch(/migrateConfiguredInstallation\(\)[\s\S]*?reconcileConfiguredEmbeddingIndex\(\)[\s\S]*?this\.start\(false\)/);
    expect(sidecarController).toMatch(/await this\.stopNow\(\);[\s\S]*?reconcileConfiguredEmbeddingIndex\(\)[\s\S]*?await this\.startOnce\(false\)/);
    expect(main).toContain('reconcileConfiguredEmbeddingIndex: () => databaseUpgradeController.reconcileConfiguredEmbeddingIndex()');
  });

  test('模型保存时仅 Postgres 独立执行迁移，PGLite 等 sidecar 健康后完成升级记录', () => {
    expect(main).toContain("title: '正在验证向量模型'");
    expect(main).toContain("title: '正在保存模型配置'");
    expect(setupController).toContain("title: '正在准备搜索索引'");
    expect(setupController).toContain('canDeferEmbeddingRebuild');
    expect(setupController).toContain('migrationRequired = needsDesktopMigration(app.getVersion())');
    expect(setupController).toMatch(/if \(migrationRequired && saved\.config\.engine !== 'pglite'\) \{[\s\S]*?runCliChecked\(this\.dependencies\.runtime\(\), DESKTOP_MIGRATION_ARGS\)/);
    expect(setupController).toMatch(/this\.dependencies\.sidecar\.start\(false\)[\s\S]*?if \(migrationRequired && saved\.config\.engine === 'pglite'\)/);
    expect(main).not.toContain("title: '正在应用数据库迁移'");
  });

  test('切换向量模型时先清旧向量，Sidecar 就绪后再补新向量', () => {
    expect(setupController).toMatch(
      /saved\.embeddingModelChanged && !legacyEmbeddingRecoveryConfirmed\) \{[\s\S]*'--force-reembed'[\s\S]*await this\.dependencies\.sidecar\.start\(false\)[\s\S]*if \(embeddingVectorsCleared\) \{[\s\S]*action: 'embed_stale', catchUp: true/,
    );
    expect(setupController).not.toContain('waitEmbeddingRebuildChoice()');
  });

  test('allows credential listing and revocation while keeping creation behind the live gateway', () => {
    expect(sharedAccessController).toMatch(/async read\(\)[\s\S]*requireSidecar/);
    expect(sharedAccessController).toMatch(/async revoke[\s\S]*requireSidecar/);
    expect(sharedAccessController).toMatch(/async create[\s\S]*requireGateway/);
  });
});
