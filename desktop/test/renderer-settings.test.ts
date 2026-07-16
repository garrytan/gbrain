import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve('src/renderer/index.html'), 'utf8');
const renderer = readFileSync(resolve('src/renderer/src.ts'), 'utf8');
const styles = readFileSync(resolve('src/renderer/style.css'), 'utf8');
const main = readFileSync(resolve('src/main/index.ts'), 'utf8');
const preload = readFileSync(resolve('src/preload/index.ts'), 'utf8');
const builder = readFileSync(resolve('electron-builder.yml'), 'utf8');
const preview = readFileSync(resolve('scripts/preview-renderer.ts'), 'utf8');

describe('desktop settings renderer contracts', () => {
  test('keeps the five desktop tasks separate and exposes advanced-only controls', () => {
    for (const panel of ['basic', 'models', 'integrations', 'system', 'updates']) {
      expect(html).toContain(`data-target="${panel}"`);
      expect(html).toContain(`id="panel-${panel}"`);
    }
    expect(html).toContain('id="advanced-model-settings"');
    expect(html).toContain('id="advanced-utility-provider"');
    expect(html).toContain('跟随普通模型');
    expect(html).not.toContain('placeholder="例如 provider:model"');
    expect(html).toContain('高级：自定义主源 ID');
    expect(html).toContain('id="docker-help"');
    expect(styles).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(html).not.toContain('用于问答、扩展、总结等普通 LLM 调用。');
    expect(html).not.toContain('用于知识库切片向量化和搜索召回。');
    expect(renderer).not.toContain('个已支持模型，也可以直接输入自定义模型名。');
    expect(styles).toContain('.model-picker-trigger, .advanced-model-picker-trigger');
    expect(styles).toContain('place-items: center');
    expect(renderer).not.toContain('window.scrollTo');
    expect(renderer).not.toContain("switchPanel('integrations');");
  });

  test('moves appearance and native desktop behavior into an accessible system panel', () => {
    for (const id of [
      'network-mode-local',
      'network-mode-shared',
      'shared-address',
      'launch-at-login',
      'close-behavior',
      'system-theme-select',
      'save-system-settings',
      'restart-shared-gateway',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toContain('id="theme-select"');
    expect(html).toContain('aria-label="选择共享网络适配器和 IPv4 地址"');
    expect(html).toContain('固定局域网入口');
    expect(html).toContain('DHCP 地址保留');
    expect(html).toContain('本机 sidecar');
    expect(html).toContain('员工 Agent');
    expect(html).toContain('id="shared-connection-spine"');
    expect(renderer).toContain("$('#shared-connection-spine').hidden = !shared");
    expect(html).not.toContain('管理桌面端的局域网入口、开机启动、关闭行为和界面外观。');
    expect(html).not.toContain('默认仅本机使用；共享模式只开放 MCP，不开放管理台。');
    expect(html).not.toContain('这些设置只影响 Windows 桌面端，不修改知识库或 GBrain 核心配置。');
    expect(renderer).not.toContain('切换共享模式、网卡或 IPv4 时会弹出二次确认。');
    expect(renderer).toContain('getSystemSettings()');
    expect(renderer).toContain('saveSystemSettings(payload)');
    expect(renderer).toContain('restartSharedGateway()');
    expect(renderer).toContain("setBusy(button, true, '正在重启…')");
    expect(styles).toContain('.gateway-status.warning > i { background: #ff6655;');
    expect(styles).toContain('grid-template-columns: 8px minmax(0, 1fr) auto');
    expect(renderer).toContain('onSystemSettingsState((next) => applySystemSettingsState(next))');
    expect(styles).toContain('.connection-spine');
  });

  test('keeps local MCP setup and adds explicit least-privilege shared member access', () => {
    expect(html).toContain('本机 Agent 接入');
    expect(html).toContain('共享成员接入');
    for (const id of [
      'shared-member-name',
      'shared-client',
      'shared-can-write',
      'shared-write-source',
      'shared-read-sources',
      'create-shared-integration',
      'shared-member-list',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toMatch(/id="shared-can-write"(?![^>]*checked)/);
    expect(html).toContain('默认只读');
    expect(html).toContain('新增、覆盖、删除、恢复和回滚内容');
    expect(renderer).toContain('getSharedAccess()');
    expect(renderer).toContain('createSharedIntegration(payload)');
    expect(renderer).toContain('revokeSharedIntegration(credentialName)');
    expect(renderer).toContain('credential.credentialName');
  });

  test('keeps shared credential actions honest across refresh, revoke, and network changes', () => {
    expect(renderer).toContain('const refreshed = await loadSharedAccess()');
    expect(renderer).toContain('共享凭证已创建，但成员列表刷新失败');
    expect(renderer).toContain('不要重复创建');
    expect(renderer).toContain('window.confirm(`确定撤销');
    expect(renderer).toContain("lastResult = ''");
    expect(renderer).toContain('先前显示的 Bearer 凭证已失效');
    expect(renderer).toContain('applySystemSettingsState');
    expect(renderer).toContain('共享不会自动恢复');
    expect(renderer).toContain("unavailable.value = 'network-unavailable'");
    expect(renderer).toContain('局域网共享仍保持停止');
    expect(renderer).toContain('result.state.gateway?.running');
    expect(renderer).toContain('已有成员凭证仍可查看和撤销');
    expect(renderer).toContain('if (!latestSystemSettings?.preferences.sharedIp)');
    expect(renderer).toContain('开启后即可创建和管理成员凭证');
    expect(renderer).toContain("void loadSharedAccess();");
  });

  test('keeps the browser preview aligned with system and shared-access APIs', () => {
    expect(preview).toContain("'system'");
    expect(preview).toContain('getSystemSettings: async');
    expect(preview).toContain('onSystemSettingsState:');
    expect(preview).toContain('getSharedAccess: async');
    expect(preview).toContain('createSharedIntegration: async');
    expect(preview).toContain('revokeSharedIntegration: async');
  });

  test('disables premature system saves and exposes accessible security notices', () => {
    expect(html).toContain('id="save-system-settings" disabled');
    expect(renderer).toContain('state?.setup.needsSetup !== false');
    expect(renderer).toContain('请先在“基础配置”完成数据库与知识目录设置');
    expect(html).toContain('id="global-error" role="alert" aria-live="assertive"');
    expect(html).toContain('id="global-success" role="status" aria-live="polite"');
    expect(html).toContain('仅用于可信局域网');
    expect(html).toContain('HTTP + Bearer');
    expect(html).toContain('TLS 反向代理');
    expect(renderer).toContain('clearNotices();');
  });

  test('pairs theme, startup progress, and advanced-model IPC across main and preload', () => {
    for (const channel of [
      'desktop:get-theme',
      'desktop:set-theme',
      'desktop:get-startup-progress',
      'desktop:get-advanced-model-config',
      'desktop:save-advanced-model-config',
      'desktop:open-previous-release',
    ]) {
      expect(main).toContain(channel);
      expect(preload).toContain(channel);
    }
    expect(main).toContain('nativeTheme.themeSource');
    for (const label of ['基础配置', '模型配置', 'MCP 接入', '软件更新', '打开日志目录']) {
      expect(main).toContain(`label: '${label}'`);
    }
    expect(main).toContain("desktop:show-panel");
    expect(preload).toContain("desktop:show-panel");
    expect(builder).toContain('out/main/**/*');
    expect(builder).toContain('out/preload/**/*');
    expect(builder).toContain('out/renderer/**/*');
    expect(builder).not.toContain('out/**/*');
    expect(renderer).toContain('document.documentElement.dataset.theme');
    expect(html).toContain('id="previous-version-action"');
  });
});
