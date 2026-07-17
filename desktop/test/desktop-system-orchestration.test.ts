import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const main = readFileSync(resolve('src/main/index.ts'), 'utf8');
const sidecar = readFileSync(resolve('src/main/sidecar-manager.ts'), 'utf8');
const preload = readFileSync(resolve('src/preload/index.ts'), 'utf8');

describe('desktop system orchestration contracts', () => {
  test('keeps the original sidecar private and exposes sharing through the desktop gateway', () => {
    expect(sidecar).toContain("'--bind', '127.0.0.1'");
    expect(sidecar).not.toContain("'--bind', '0.0.0.0'");
    expect(main).toContain('new LanMcpGateway');
    expect(main).toContain('sharedIp');
    expect(main).toContain('不会自动切换到其他网卡');
  });

  test('prepares Postgres before migrations and sidecar startup paths', () => {
    expect(main).toMatch(/async function applySetupOnce[\s\S]*?await ensureRuntimeReady\(\);\s+const hadRunningSidecar[\s\S]*?saved = saveSetup\(payload\);/);
    expect(main).toMatch(/await prepareConfiguredDatabase\(\);\s+await migrateConfiguredInstallation\(\);/);
    expect(main).toMatch(/saved = saveSetup\(payload\);\s+\} catch \(error\) \{\s+if \(hadRunningSidecar\) await startSidecar\(false\)[\s\S]*?throw error;\s+\}\s+try \{\s+await prepareConfiguredDatabase\(\);/);
    expect(main).toContain('saveDetectedDockerContainerName');
  });

  test('wires native system settings, tray behavior, autostart, and shared credentials through IPC', () => {
    for (const channel of [
      'desktop:get-system-settings',
      'desktop:save-system-settings',
      'desktop:get-shared-access',
      'desktop:create-shared-integration',
      'desktop:revoke-shared-integration',
    ]) {
      expect(main).toContain(channel);
      expect(preload).toContain(channel);
    }
    expect(main).toContain('new Tray');
    expect(main).toContain("closeBehavior === 'quit'");
    expect(main).toContain('app.setLoginItemSettings');
    expect(main).toContain('dialog.showMessageBox');
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
    expect(main).toContain('handleTrustedIpc');
    expect(main).toContain('assertTrustedIpcSender(event)');
    expect(main).toContain('系统偏好已保存，但局域网共享入口未能启动');
    expect(main).toContain("url.hostname === '127.0.0.1' || url.hostname === 'localhost'");
  });

  test('returns to native desktop panels and reconciles the database main source before saving', () => {
    expect(main).toContain("{ label: '显示 PMBrain', click: openDesktop }");
    expect(main).toContain("tray.on('double-click', openDesktop)");
    expect(main).toContain("'/admin/api/brain/overview'");
    expect(main).toContain('payload.knowledgeSourceChanged === false');
    expect(main).toContain('applySetupOnce(effectivePayload');
  });

  test('serializes gateway transitions and keeps service startup single-flight', () => {
    expect(main).toContain('queueGatewayTransition');
    expect(main).toContain('gatewayTransitionQueue');
    expect(main).toContain('gatewayTransitionGeneration');
    expect(main).toContain('stopLanGatewayNow');
    expect(main).toContain('sidecarLifecycleQueue');
    expect(main).toContain('queueSidecarTransition');
    expect(main).toContain('ensureServiceReady');
    expect(main).toContain('serviceReadyPromise');
    expect(main).toContain('sidecarStartupPromise');
    expect(main).toContain('revealMainWindow');
  });

  test('invalidates and rebuilds embeddings on every model change with Dream-safe resume state', () => {
    expect(main).toContain('saved.embeddingModelChanged');
    expect(main).toContain("alignmentArgs.push('--force-reembed')");
    expect(main).toContain("['embed', '--stale', '--catch-up', '--json']");
    expect(main).toContain('(result.total_chunks ?? 0) - (result.embedded ?? 0)');
    expect(main).toContain('if (!embeddingSwitchCommitted) restoreConfig(saved.snapshot)');
    expect(main).toContain('Dream 会从剩余内容继续');
  });

  test('allows credential listing and revocation while keeping creation behind the live gateway', () => {
    expect(main).toMatch(/readSharedAccess[\s\S]*requireSharedSidecar/);
    expect(main).toMatch(/revokeSharedAccess[\s\S]*requireSharedSidecar/);
    expect(main).toMatch(/createSharedAccess[\s\S]*requireSharedGateway/);
  });
});
