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
  test('shares the PMBrain violet visual identity across dark and light themes', () => {
    expect(styles).toContain('--accent: #938aff;');
    expect(styles).toContain('--accent: #6b5de8;');
    expect(styles).toContain('--success: #55c89c;');
    expect(styles).toContain('--danger: #ff7e8e;');
    expect(styles).toContain('.rail-item.active');
    expect(styles).toContain('border-radius: 13px');
    expect(styles).toContain('button.primary:hover:not(:disabled)');
    expect(styles).not.toContain('#97e66c');
  });

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

  test('adds custom OpenAI-compatible models from both model cards without fake editable controls', () => {
    expect(html).toContain('id="add-custom-chat-model"');
    expect(html).toContain('id="add-custom-embedding-model"');
    expect(html).toContain('id="custom-provider-dialog"');
    expect(html).toContain('id="custom-provider-base-url"');
    expect(html).toContain('id="custom-provider-model-id"');
    expect(html).toContain('value="custom-openai"');
    expect(html).toContain('供应商路由');
    expect(html).toContain('OpenAI 兼容');
    expect(html).not.toContain('id="custom-provider-id"');
    expect(html).not.toContain('id="custom-provider-protocol"');
    expect(html).toContain('API Key 可选');
    expect(html).not.toContain('厂商');
    expect(renderer).toContain('customProviderDraft');
    expect(renderer).toContain('customProvider: customProviderDraft ?? undefined');
    expect(renderer).toContain("provider === 'custom-openai'");
    expect(renderer).toContain("openCustomProvider('chat')");
    expect(renderer).toContain("openCustomProvider('embedding')");
    expect(renderer).toContain('customProviderDraft?.baseUrls?.[target]');
    expect(renderer).toContain('baseUrls: { ...customProviderDraft?.baseUrls, [target]: normalizedBaseUrl }');
    expect(renderer).toContain("kind === 'embedding' ? 'customOpenaiEmbedding'");
    expect(renderer).toContain("kind === 'chat' ? 'customOpenaiChat'");
    expect(renderer).toContain("providerKeyId(chatProvider, 'chat')");
    expect(renderer).toContain("providerKeyId(embeddingProvider, 'embedding')");
    expect(main).toContain('自定义向量模型验证失败');
    expect(styles).toContain('.model-add-button');
    expect(styles).toContain('.custom-provider-dialog');
  });

  test('marks and validates every required custom model field before accepting it', () => {
    expect(html).toContain('id="custom-provider-form" novalidate');
    for (const id of ['custom-provider-name', 'custom-provider-base-url', 'custom-provider-model-id']) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]*required[^>]*aria-required="true"`));
    }
    expect(html.match(/class="required-marker"/g)).toHaveLength(3);
    expect(html).toContain('模型名称（模型 ID）');
    expect(styles).toContain('.required-marker');
    expect(renderer).toContain("setCustomProviderError('请填写 Base URL。', baseUrlInput)");
    expect(renderer).toContain("setCustomProviderError('请填写模型名称（模型 ID）。', modelIdInput)");
    expect(renderer).toContain("field.setAttribute('aria-invalid', 'true')");
  });

  test('offers local Ollama models for both ordinary and embedding model cards', () => {
    const chatProvider = html.match(/<select id="chat-provider">([\s\S]*?)<\/select>/)?.[1] ?? '';
    const embeddingProvider = html.match(/<select id="embedding-provider">([\s\S]*?)<\/select>/)?.[1] ?? '';
    expect(chatProvider).toContain('<option value="ollama">ollama</option>');
    expect(embeddingProvider).toContain('<option value="ollama">ollama</option>');
    expect(renderer).toContain("if (['ollama', 'llama-server', 'litellm', 'llama-server-reranker'].includes(normalized))");
    expect(renderer).toContain("provider === 'ollama' ? '正在读取本机 Ollama 模型…'");
    expect(preview).toContain("touchpoint === 'embedding' ? ['nomic-embed-text'] : ['qwen3:latest', 'qwen2.5:latest']");
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
    expect(styles).toContain('.gateway-status.warning > i { background: var(--danger);');
    expect(styles).toContain('grid-template-columns: 8px minmax(0, 1fr) auto');
    expect(renderer).toContain('onSystemSettingsState((next) => applySystemSettingsState(next))');
    expect(styles).toContain('.connection-spine');
  });

  test('keeps local MCP setup and routes shared member management to the admin console', () => {
    expect(html).toContain('本机 Agent 接入');
    expect(html).toContain('共享成员接入');
    expect(html).toContain('id="shared-open-admin"');
    expect(html).toContain('凭证创建与成员管理请到 PMBrain 管理控制台');
    for (const removedId of [
      'shared-member-name',
      'shared-client',
      'shared-can-write',
      'shared-write-source',
      'shared-read-sources',
      'create-shared-integration',
      'shared-member-list',
    ]) {
      expect(html).not.toContain(`id="${removedId}"`);
      expect(renderer).not.toContain(`#${removedId}`);
    }
    expect(renderer).toContain("$('#shared-open-admin').addEventListener('click', () => void window.pmbrainDesktop.openAdmin())");
    expect(renderer).toContain("client === 'qwenpaw' ? 'api_key' : selectedCredential()");
    expect(renderer).toContain('通过本机 API 写入 Bearer 并验证，不使用 OAuth');
    expect(renderer).toContain('已写入，等待连接');
    expect(renderer).toContain('重试连接');
  });

  test('removes stale shared credential DOM access while preserving network settings', () => {
    expect(renderer).not.toContain('loadSharedAccess');
    expect(renderer).not.toContain('renderSharedAccess');
    expect(renderer).not.toContain('createSharedMember');
    expect(renderer).not.toContain('revokeSharedMember');
    expect(renderer).not.toContain('.shared-form');
    expect(renderer).not.toContain('.shared-guide');
    expect(renderer).toContain('applySystemSettingsState');
    expect(renderer).toContain('共享不会自动恢复');
    expect(renderer).toContain("unavailable.value = 'network-unavailable'");
    expect(renderer).toContain('局域网共享仍保持停止');
    expect(renderer).toContain('result.state.gateway?.running');
  });

  test('keeps the browser preview aligned with system and shared-access APIs', () => {
    expect(preview).toContain("'system'");
    expect(preview).toContain("process.argv.find((arg) => arg.startsWith('--theme=')");
    expect(preview).toContain("const VALID_THEMES = ['dark', 'light'] as const");
    expect(preview).toContain('getSystemSettings: async');
    expect(preview).toContain('onSystemSettingsState:');
    expect(preview).toContain('getSharedAccess: async');
    expect(preview).toContain('createSharedIntegration: async');
    expect(preview).toContain('revokeSharedIntegration: async');
    expect(preview).toContain("id: 'qwenpaw', name: 'QwenPaw'");
    expect(preview).toContain('drivers\\\\mcp\\\\pmbrain.yaml');
  });

  test('disables premature system saves and exposes accessible global notices', () => {
    expect(html).toContain('id="save-system-settings" disabled');
    expect(renderer).toContain('state?.setup.needsSetup !== false');
    expect(renderer).toContain('请先在“基础配置”完成数据库与知识目录设置');
    expect(html).toContain('id="global-error" role="alert" aria-live="assertive"');
    expect(html).toContain('id="global-success" role="status" aria-live="polite"');
    expect(html).not.toContain('仅用于可信局域网');
    expect(html).not.toContain('HTTP + Bearer');
    expect(html).not.toContain('TLS 反向代理');
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

  test('reports resumable re-embedding instead of claiming a mixed model switch succeeded', () => {
    expect(renderer).toContain('next.reembeddingWarning');
    expect(renderer).toContain('剩余向量将在 Dream 中继续处理');
    expect(preload).toContain('reembeddingWarning?: string | null');
  });
});
