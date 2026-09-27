import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve('src/renderer/settings-content.html'), 'utf8');
const renderer = readFileSync(resolve('src/renderer/src.ts'), 'utf8');
const mainIndex = readFileSync(resolve('src/main/index.ts'), 'utf8');
const styles = readFileSync(resolve('src/renderer/style.css'), 'utf8');
const main = readdirSync(resolve('src/main'), { recursive: true })
  .filter((path): path is string => typeof path === 'string' && path.endsWith('.ts'))
  .sort()
  .map(path => readFileSync(resolve('src/main', path), 'utf8'))
  .join('\n');
const preload = readFileSync(resolve('src/preload/index.ts'), 'utf8');
const builder = readFileSync(resolve('electron-builder.yml'), 'utf8');
const preview = readFileSync(resolve('scripts/preview-renderer.ts'), 'utf8');

describe('desktop settings renderer contracts', () => {
  test('shows the Documents/PMBrain default on first use and keeps it on save', () => {
    expect(html).toContain('id="knowledge-directory"');
    expect(html).toContain('placeholder="默认：Documents\\PMBrain"');
    expect(html).toContain('选择原始资料目录后，PMBrain 会将其注册为主源；启用 Git 后，快速维护可自动同步目录变化。');
    expect(html).toContain('id="knowledge-source-status"');
    expect(html).toContain('id="enable-knowledge-source-git"');
    expect(html).toContain('高级：自定义主源 ID');
    expect(renderer).toContain('setup.current.knowledgeDirectory || setup.defaults.knowledgeDirectory');
    expect(renderer).toContain('inspectKnowledgeSourceDirectory');
    expect(renderer).toContain('initializeKnowledgeSourceGit');
    expect(renderer).toContain('✓ Git 已启用 · 快速维护会自动同步此目录');
    expect(renderer).toContain('⚠ 未启用 Git，快速维护暂时无法自动同步');
    expect(main).toContain("'--name', basename(knowledgeDirectory), '--federated'");
    expect(main).toContain('主源路径校验失败');
  });

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

  test('database engine cards explain PGLite single-writer limits and multi-user Postgres', () => {
    expect(html).toContain('id="database-engine-hint"');
    expect(html).toContain('id="database-engine-hint-text"');
    expect(html).toContain('不支持多人并发写入');
    expect(html).toContain('适合多用户、局域网共享');
    expect(html).toContain('id="pglite-shared-warning"');
    expect(html).toContain('PGLite + 共享模式');
    expect(renderer).toContain('renderDatabaseEngineHint');
    expect(renderer).toContain('renderPgliteSharedWarning');
    expect(renderer).toContain('configuredEngine');
    expect(renderer).toContain('多人同时使用可能卡顿或不稳定');
    expect(styles).toContain('.engine-usage-hint');
    expect(styles).toContain('.engine-usage-hint.warning');
  });

  test('keeps the six desktop tasks separate and exposes advanced-only controls', () => {
    for (const panel of ['basic', 'models', 'integrations', 'system', 'updates', 'repair']) {
      expect(html).toContain(`data-target="${panel}"`);
      expect(html).toContain(`id="panel-${panel}"`);
    }
    expect(html).toContain('id="advanced-model-settings"');
    expect(html).toContain('id="advanced-utility-provider"');
    expect(html).toContain('id="advanced-phase-propose_takes-provider"');
    expect(html).toContain('Dream 阶段模型');
    expect(html).toContain('跟随普通模型');
    expect(html).toContain('跟随推理任务');
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
    expect(renderer).not.toContain("populate(next);\n    switchPanel('integrations');");
  });

  test('实验性数据连接不进入桌面普通入口', () => {
    expect(html).not.toContain('data-target="connections"');
    expect(html).not.toContain('data-target="daily"');
    expect(html).toContain('<section class="panel" id="panel-connections" hidden>');
    expect(renderer).not.toContain("if (target === 'connections') void refreshDailyPanel()");
    expect(main).not.toContain("label: '数据连接'");
    expect(main).not.toContain("label: '待我处理'");
    expect(main).not.toContain("openAdmin('#waiting')");
  });

  test('reuses custom chat models in advanced tier and Dream phase selectors', () => {
    expect(renderer).toContain('function syncAdvancedProviderOptions');
    expect(renderer).toContain('customCatalog.chat');
    expect(renderer).toContain('advancedProviderModels[tier] = endpoint.modelId ? [endpoint.modelId] : []');
    expect(renderer).toContain('advancedPhaseProviderModels[phase] = endpoint.modelId ? [endpoint.modelId] : []');
    expect(renderer).toContain('syncAdvancedProviderOptions();');
  });

  test('adds custom OpenAI-compatible models from both model cards without fake editable controls', () => {
    expect(html).toContain('id="add-custom-chat-model"');
    expect(html).toContain('id="add-custom-embedding-model"');
    expect(html).toContain('id="custom-provider-dialog"');
    expect(html).toContain('id="custom-provider-base-url"');
    expect(html).toContain('id="custom-provider-model-id"');
    expect(html).toContain('id="chat-provider-dropdown"');
    expect(html).toContain('id="embedding-provider-dropdown"');
    expect(html).toContain('供应商路由');
    expect(html).toContain('OpenAI 兼容');
    expect(html).not.toContain('id="custom-provider-id"');
    expect(html).not.toContain('id="custom-provider-protocol"');
    expect(html).toContain('API Key 可选');
    expect(html).not.toContain('厂商');
    expect(renderer).toContain('customCatalog');
    expect(renderer).toContain('customProviders: customCatalog');
    expect(renderer).toContain('customSelection');
    expect(renderer).toContain("openCustomProvider('chat')");
    expect(renderer).toContain("openCustomProvider('embedding')");
    expect(renderer).toContain('[target]: [...customCatalog[target], endpoint]');
    expect(renderer).toContain('deleteCustomEndpoint');
    expect(renderer).toContain('provider-delete');
    expect(renderer).toContain("kind === 'embedding' ? 'customOpenaiEmbedding'");
    expect(renderer).toContain("kind === 'chat' ? 'customOpenaiChat'");
    expect(renderer).toContain("providerKeyId(chatProvider, 'chat')");
    expect(renderer).toContain("providerKeyId(embeddingProvider, 'embedding')");
    expect(main).toContain('自定义向量模型验证失败');
    expect(main).toContain('error.message.trim()');
    expect(styles).toContain('.model-add-button');
    expect(styles).toContain('.custom-provider-dialog');
    expect(styles).toContain('.provider-dropdown');
    expect(styles).toContain('.provider-delete');
  });

  test('restores custom provider labels before restoring saved model selections', () => {
    const catalogIndex = renderer.indexOf('customCatalog = {');
    const chatSyncIndex = renderer.indexOf("syncCustomProviderOptions('chat');", catalogIndex);
    const embeddingSyncIndex = renderer.indexOf("syncCustomProviderOptions('embedding');", catalogIndex);
    const chatValueIndex = renderer.indexOf("($<HTMLSelectElement>('#chat-provider')).value = chatProviderValue;");
    const embeddingValueIndex = renderer.indexOf("($<HTMLSelectElement>('#embedding-provider')).value = embeddingProviderValue;");

    expect(catalogIndex).toBeGreaterThanOrEqual(0);
    expect(chatSyncIndex).toBeGreaterThan(catalogIndex);
    expect(embeddingSyncIndex).toBeGreaterThan(catalogIndex);
    expect(chatSyncIndex).toBeLessThan(chatValueIndex);
    expect(embeddingSyncIndex).toBeLessThan(embeddingValueIndex);
    expect(renderer).toContain('option.textContent = endpoint.displayName');
  });

  test('selects the custom provider immediately after adding a model', () => {
    const confirmIndex = renderer.indexOf('function confirmCustomProvider');
    const catalogIndex = renderer.indexOf('customCatalog = {', confirmIndex);
    const syncIndex = renderer.indexOf('syncCustomProviderOptions(target);', confirmIndex);
    const applyIndex = renderer.indexOf('applyProviderSelection(target, endpoint.id, false);', confirmIndex);
    const renderIndex = renderer.indexOf('renderProviderDropdown(target);', confirmIndex);

    expect(confirmIndex).toBeGreaterThanOrEqual(0);
    expect(catalogIndex).toBeGreaterThan(confirmIndex);
    expect(syncIndex).toBeGreaterThan(catalogIndex);
    expect(syncIndex).toBeLessThan(applyIndex);
    expect(renderIndex).toBeGreaterThan(applyIndex);
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

  test('tests unsaved model drafts and reports provider or dimension errors in place', () => {
    expect(html).toContain('id="test-chat-model"');
    expect(html).toContain('id="test-embedding-model"');
    expect(html).toContain('class="model-test-icon"');
    expect(renderer).toContain('testConfiguredModel');
    expect(renderer).toContain('window.pmbrainDesktop.testModelConnection(modelConnectionInput(kind))');
    expect(renderer).toContain('本地模型首次加载可能需要 1–2 分钟');
    expect(renderer).toContain('✓ 连接成功 · ${result.dimensions} 维 · ${result.durationMs}ms');
    expect(renderer).toContain('⚠ ${result.message} · ${result.durationMs}ms');
    expect(preload).toContain("desktop:test-model-connection");
    expect(main).toContain("desktop:test-model-connection");
    expect(styles).toContain('.model-connection-field');
    expect(styles).toContain('.model-test-button.busy');
    expect(preview).toContain('testModelConnection: async (input)');
  });

  test('shows product names while preserving provider API model IDs', () => {
    expect(renderer).toContain("model === 'deepseek-flash') return 'DeepSeek-V4.1-Flash'");
    expect(renderer).toContain("model === 'mimo-v2.6-pro') return 'MiMo-V2.6-Pro'");
    expect(renderer).toContain("model === 'mimo-v2.6-flash') return 'MiMo-V2.6-Flash'");
    expect(renderer).toContain('input.value = model');
  });

  test('keeps the optional OCR model, credential check and image test in the model settings flow', () => {
    for (const id of ['ocr-provider', 'ocr-model-name', 'ocr-api-key', 'test-ocr-model']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).not.toContain('id="ocr-enabled"');
    expect(html).not.toContain('id="ocr-model-mode"');
    expect(html).toContain('留空时自动使用上面的普通模型');
    expect(html).toContain('id="ocr-model-name" spellcheck="false" placeholder="留空时使用普通模型"');
    const saveStart = renderer.indexOf('async function save(): Promise<void>');
    const saveEnd = renderer.indexOf('function selectedCredential', saveStart);
    const saveSource = renderer.slice(saveStart, saveEnd);
    const dailyStart = renderer.indexOf('async function refreshDailyPanel');
    const dailyEnd = renderer.indexOf('async function refreshDailyPeople', dailyStart);
    const dailySource = renderer.slice(dailyStart, dailyEnd);
    expect(saveSource).toContain("providerKeyId(ocrProvider, 'chat')");
    expect(saveSource).toContain("(keys as Record<string, string>)[ocrKey] = ocrKeyValue");
    expect(saveSource).toContain('ocrEnabled: true');
    expect(dailySource).not.toContain('ocrKeyValue');
    expect(renderer).toContain("touchpoint: 'ocr'");
  });

  test('model settings label the embedding model without an optional marker', () => {
    expect(html).toContain('<b>向量化模型</b>');
    expect(html).not.toContain('向量化模型（可选）');
    expect(html).toContain('普通模型用于问答与 AI 深度整理，配置完成后会按任务自动使用。');
    expect(html).toContain('向量模型用于语义检索和向量化，需要单独配置。');
    expect(html).not.toContain('不受该开关影响');
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

  test('keeps local MCP setup and routes shared member management within the product', () => {
    expect(html).toContain('本机 Agent 接入');
    expect(html).toContain('共享成员接入');
    expect(html).toContain('id="shared-open-admin"');
    expect(html).toContain('凭证创建与成员管理请到 MCP 接入页面');
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
    expect(renderer).toContain("item.id === 'claude' ? '生成接入命令' : '生成接入配置'");
    expect(renderer).toContain('已写入，等待连接');
    expect(renderer).toContain('重试连接');
  });

  test('keeps integration actions together, uses unified deep integration copy, and shows launch only for detected apps', () => {
    expect(renderer).not.toContain('renderWorkbuddyIntegration');
    expect(renderer).not.toContain('移除深度接入');
    expect(renderer).not.toContain("if (item.id === 'workbuddy') return renderWorkbuddyIntegration(item)");
    expect(renderer).toContain("item.id === 'workbuddy' && item.configured");
    expect(renderer).not.toContain('写入规则与 Agent');
    expect(renderer).toContain("agentButton.textContent = '深度接入'");
    expect(renderer).toContain('writeWorkbuddyUserAgent');
    expect(renderer).toMatch(/item\.id === 'workbuddy'[\s\S]*?agentButton\.textContent = '深度接入'[\s\S]*?writeWorkbuddyUserAgent\(agentButton\)[\s\S]*?actions\.append\(agentButton\)/);
    expect(renderer).toContain("button.addEventListener('click', () => void configure(item.id, button))");
    expect(renderer).toContain("item.configured ? '更新连接' : '接入'");
    expect(renderer).toContain("['codex','claude','grok'].includes(item.id)");
    expect(renderer).toContain("deep.textContent = '深度接入'");
    expect(renderer).toMatch(/\['codex','claude','grok'\][\s\S]*?deep\.textContent = '深度接入'[\s\S]*?configure\(item\.id, deep, true\)[\s\S]*?actions\.append\(deep\)/);
    expect(renderer).toContain('item.launchAvailable');
    expect(renderer).toContain("launchLabel.textContent = '启动'");
    expect(renderer).toContain('launchIntegration(item.id, launchButton)');
    expect(renderer).toContain("launchButton.className = 'integration-launch'");
    expect(renderer.indexOf('actions.append(deep)')).toBeLessThan(renderer.indexOf('if (item.launchAvailable)'));
    expect(renderer).toContain('更新连接只更新 MCP；深度接入还会安装自动记忆规则');
    expect(styles).toContain('.integration-actions');
    expect(styles).toContain('.integration-launch');
    expect(styles).toContain('.integration-launch-icon');
    expect(preview).toContain('writeWorkbuddyUserAgent: async');
    expect(preview).toContain('launchIntegration: async');
    expect(main).toContain('desktop:write-workbuddy-user-agent');
    expect(main).toContain('desktop:launch-integration');
    expect(preload).toContain('desktop:write-workbuddy-user-agent');
    expect(preload).toContain('desktop:launch-integration');
  });

  test('shows the migrated database address and discovers switchable PMBrain Docker databases', () => {
    expect(html).toContain('id="database-instance"');
    expect(html).toContain('正在检查 Docker 中可用的 PMBrain 数据库');
    expect(renderer).toContain('setup.current.databaseUrl ||');
    expect(renderer).toContain('listDockerDatabases');
    expect(renderer).toContain('activateDockerDatabase');
    expect(renderer).toContain('renderDockerDatabases');
    expect(renderer).toContain("database.status === 'stopped' ? '已停止' : '运行中'");
    expect(renderer).toContain("option.dataset.databaseUrl");
    expect(renderer).toContain("$<HTMLSelectElement>('#database-instance').addEventListener('change'");
    expect(main).toContain("'desktop:list-docker-databases'");
    expect(main).toContain("'desktop:activate-docker-database'");
    expect(preload).toContain("'desktop:list-docker-databases'");
    expect(preload).toContain("'desktop:activate-docker-database'");
  });

  test('立即显示 MCP 卡片，并在后台刷新真实连接状态', () => {
    expect(preload).toContain('getIntegrations(probe?: boolean)');
    expect(main).toContain("'desktop:get-integrations'");
    expect(renderer).toContain('refreshIntegrations(false)');
    expect(renderer).toContain('refreshIntegrations');
    expect(renderer).toContain('refreshIntegrations(true)');
    expect(renderer).toMatch(/refreshIntegrations\(false\)[\s\S]*?refreshIntegrations\(true\)/);
  });

  test('长期记忆首次点击保留用户选择，未接入时给出就地引导', () => {
    expect(html).toContain('id="memory-setup-hint"');
    expect(html).toContain('id="memory-open-integrations"');
    expect(html).toContain('请先到“MCP 接入”更新至少一个 AI 客户端');
    expect(renderer).toContain('memoryModeUserChanged');
    expect(renderer).toContain('handleMemoryModeChange');
    expect(renderer).toContain('showMemorySetupHint');
    expect(renderer).toContain("switchPanel('integrations')");
  });

  test('shows invalid local credentials and a one-click repair action', () => {
    expect(renderer).toContain('接入失效');
    expect(renderer).toContain('现有凭证已失效');
    expect(renderer).toContain('重新生成凭证');
    expect(renderer).toContain("'invalid badge'");
    expect(styles).toContain('.badge.invalid');
  });

  test('接入操作立刻展示分阶段弹窗，并用直接验证结果更新当前卡片', () => {
    for (const id of [
      'integration-progress-dialog',
      'integration-progress-title',
      'integration-progress-stage',
      'integration-progress-message',
      'integration-progress-close',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(renderer).toContain('openIntegrationProgress(client, deep)');
    expect(renderer).toContain("button.textContent = '处理中…'");
    expect(renderer).toContain('applyIntegrationResult(result)');
    expect(renderer).toContain('void refreshIntegrations(true)');
    expect(renderer).not.toMatch(/const integrations = await refreshIntegrations\(true\);[\s\S]*?refreshedConnection/);
    expect(renderer).toContain('首次设置时会先询问“重要内容 / 全部事实”');
    expect(renderer).toContain('长期记忆范围请到“系统设置”修改');
    expect(styles).toContain('.integration-progress-dialog');
    expect(styles).toContain('.integration-progress-state.busy');
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
    expect(preview).toContain('inspectKnowledgeSourceDirectory: async');
    expect(preview).toContain('initializeKnowledgeSourceGit: async');
    expect(preview).toContain("id: 'trae', name: 'Trae Work'");
    expect(preview).toContain("id: 'cherry', name: 'CherryStudio'");
    expect(preview).toContain("id: 'grok', name: 'Grok Build'");
    expect(preview).toContain("id: 'qwenpaw', name: 'QwenPaw'");
    expect(preview).toContain("id: 'qwen', name: 'Qwen Code'");
    expect(preview).toContain("id: 'qoder', name: 'Qoder CN（通义灵码）'");
    expect(preview).toContain("id: 'zcode', name: 'ZCode（智谱）'");
    expect(preview).toContain("id: 'mimo', name: 'MiMo Code（小米）'");
    expect(preview).toContain("id: 'kimi', name: 'Kimi Code（月之暗面）'");
    expect(preview).toContain("id: 'hermes', name: 'Hermes'");
    expect(preview).toContain("id: 'openclaw', name: 'OpenClaw'");
    expect(preview.indexOf("id: 'cherry'")).toBeLessThan(preview.indexOf("id: 'workbuddy'"));
    expect(preview.indexOf("id: 'codebuddy'")).toBeGreaterThan(preview.indexOf("id: 'openclaw'"));
    expect(preview).toContain('drivers\\\\mcp\\\\pmbrain.yaml');
    expect(renderer).toContain('Number(right.item.configured) - Number(left.item.configured)');
    expect(renderer).toContain('(left.item.defaultOrder ?? left.index) - (right.item.defaultOrder ?? right.index)');
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
      'desktop:list-pglite-upgrade-backups',
      'desktop:prune-pglite-upgrade-backups',
      'desktop:delete-pglite-upgrade-backup',
      'desktop:restore-pglite-upgrade-backup',
      'desktop:set-pglite-upgrade-backup-root',
      'desktop:open-pglite-upgrade-backup',
    ]) {
      expect(main).toContain(channel);
      expect(preload).toContain(channel);
    }
    expect(main).toContain('nativeTheme.themeSource');
    for (const label of ['基础配置', '模型配置', 'MCP 接入', '软件更新', '软件修复', '打开日志目录']) {
      expect(main).toContain(`label: '${label}'`);
    }
    expect(main).toContain("desktop:show-panel");
    expect(preload).toContain("desktop:show-panel");
    expect(builder).toContain('out/main/**/*');
    expect(builder).toContain('out/preload/**/*');
    expect(builder).toContain('out/renderer/**/*');
    expect(builder).not.toContain('out/**/*');
    expect(renderer).toContain('document.documentElement.dataset.theme');
    expect(html).toContain('id="panel-repair"');
    expect(html).toContain('id="repair-backup-list"');
    expect(html).toContain('id="repair-prune-backups"');
    expect(html).toContain('id="repair-change-backup-root"');
    expect(html).toContain('清理旧备份');
    expect(html).toContain('更改位置');
    expect(renderer).toContain('listPgliteUpgradeBackups');
    expect(renderer).toContain('恢复此备份');
    expect(renderer).toContain('删除此备份');
    expect(renderer).toContain('打开备份目录');
    expect(renderer).toContain('restorePgliteUpgradeBackup');
    expect(renderer).toContain('prunePgliteUpgradeBackups');
    expect(renderer).toContain('setPgliteUpgradeBackupRoot');
    expect(renderer).not.toContain('previous-version');
    expect(preload).not.toContain('openPreviousRelease');
  });

  test('memory writeback selection is not reset by settings polling before save', () => {
    expect(renderer).toContain("input[name=\"memory-writeback\"]");
    expect(renderer).toContain("addEventListener('change', () => void handleMemoryModeChange(input))");
    expect(renderer).toContain('memoryModeUserChanged && pending !== undefined && pending !== state.mode');
    expect(renderer).toContain('loadedMemoryMode = state.mode');
    expect(html).toContain('id="memory-mode-salient-card"');
    expect(html).toContain('id="memory-agent-status"');
  });

  test('integration verification survives setup snapshots and reruns when the sidecar becomes ready', () => {
    expect(renderer).toContain('const integrations = latestIntegrations.length > 0');
    expect(renderer).toContain(': restoreLastVerifiedIntegrations(next.integrations)');
    expect(renderer).toContain('if (sidecarReady && !integrationProbeSidecarReady)');
    expect(renderer).toContain('integrationChecksComplete = checkable.every');
    expect(renderer).toContain('restoreLastVerifiedIntegrations');
    expect(renderer).toContain('recordIntegrationVerification');
    expect(renderer).toContain('pmbrain.desktop.integration-verification.v1');
    expect(renderer).toContain("badge.textContent = '接入可用'");
    expect(renderer).toContain("badge.textContent = '接入失效'");
    expect(renderer).not.toContain("badge.textContent = '已写入，待验证'");
  });

  test('opening advanced model settings only reads a draft and saves with the PGLite pause', () => {
    expect(mainIndex).toContain('advancedModelConfig: () => readAdvancedModelConfig(runtime())');
    expect(mainIndex).toContain('saveAdvancedModelConfig: values => sidecarController.withPausedForModelConfig(');
    expect(main).toContain("title: '正在安全保存模型路由'");
    expect(main).not.toContain("title: '正在安全读取模型路由'");
    expect(renderer).toContain('正在读取当前高级路由…');
    expect(renderer).not.toContain('正在读取当前高级路由并安全检查本地服务…');
  });

  test('reports resumable re-embedding instead of claiming a mixed model switch succeeded', () => {
    expect(renderer).toContain('next.reembeddingWarning');
    expect(renderer).toContain('模型配置已保存：');
    expect(preload).toContain('reembeddingWarning?: string | null');
  });
});
