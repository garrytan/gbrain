import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assistantTarget,
  createIntent,
  finishedMaintenance,
  importBuildDetail,
  importBuildSteps,
  libraryMode,
  maintenanceView,
  navActive,
  suggestedChatModel,
} from '../admin/src/product/home-model.ts';
import { rememberedChatModel } from '../admin/src/workbench/chat-model.ts';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('首页按有没有知识库区分，并接上现有能力', () => {
  test('桌面端尚未完成配置时是新用户，浏览器管理台和已配置用户进入使用首页', () => {
    expect(libraryMode(true, null)).toBe('loading');
    expect(libraryMode(true, true)).toBe('new');
    expect(libraryMode(true, false)).toBe('ready');
    expect(libraryMode(false, false)).toBe('ready');
    expect(libraryMode(false, true)).toBe('ready');
  });

  test('只有一个对话模型且尚未配置时才自动选用，多个或已配置都不擅自改写', () => {
    expect(suggestedChatModel(undefined, [{ value: 'ollama:qwen' }])).toBe('ollama:qwen');
    expect(suggestedChatModel('', [{ value: 'a' }, { value: 'b' }])).toBeNull();
    expect(suggestedChatModel('deepseek:chat', [{ value: 'ollama:qwen' }])).toBeNull();
    expect(suggestedChatModel(undefined, [])).toBeNull();
  });

  test('维护提示只在升级、启动和失败时出现，完成后可以收起', () => {
    expect(maintenanceView({ startup: null, servicePhase: 'ready', updatePhase: 'idle', needsSetup: false }).visible).toBe(false);
    expect(maintenanceView({ startup: null, servicePhase: 'starting', updatePhase: null, needsSetup: true }).visible).toBe(false);
    const updating = maintenanceView({ startup: null, servicePhase: 'ready', updatePhase: 'downloading', updateMessage: '正在下载', needsSetup: false });
    expect(updating.visible).toBe(true);
    expect(updating.title).toBe('正在更新 PMBrain…');
    const migration = maintenanceView({
      startup: { visible: true, stage: 'migration', title: '正在升级数据库', message: '正在迁移' },
      servicePhase: 'starting',
      updatePhase: null,
      needsSetup: false,
    });
    expect(migration.steps.map(step => step.state)).toEqual(['done', 'current', 'pending', 'pending']);
    expect(migration.steps.map(step => step.label)).toEqual(['数据备份', '数据库升级', '健康检查', '服务启动']);
    const failed = maintenanceView({ startup: null, servicePhase: 'failed', updatePhase: null, needsSetup: false });
    expect(failed.steps.at(-1)?.state).toBe('failed');
    expect(finishedMaintenance().steps.every(step => step.state === 'done')).toBe(true);
  });

  test('导入进度按真实输出推进，不把还没发生的步骤标成完成', () => {
    expect(importBuildSteps(null).map(step => step.state)).toEqual(['current', 'pending', 'pending']);
    const running = importBuildSteps({ status: 'running', stdout: 'Found 3 files', stderr: '' });
    expect(running.map(step => step.state)).toEqual(['done', 'current', 'pending']);
    const done = importBuildSteps({ status: 'completed', stdout: 'Import complete\n  3 chunks created', stderr: '' });
    expect(done.every(step => step.state === 'done')).toBe(true);
    expect(importBuildDetail({ status: 'failed', stdout: '', stderr: '', error: '路径不存在' })).toBe('路径不存在');
  });

  test('首页入口和菜单文案指向现有页面', () => {
    expect(createIntent('#create?intent=import')).toBe('import');
    expect(createIntent('#create')).toBe('');
    expect(assistantTarget('import')).toBe(true);
    expect(navActive('import', 'assistant')).toBe(true);
    expect(navActive('create', 'home')).toBe(true);
    const app = read('admin/src/product/ProductApp.tsx');
    const home = read('admin/src/product/HomePage.tsx');
    const create = read('admin/src/product/CreateLibrary.tsx');
    expect(app).toContain("const currentPage = () => window.location.hash.replace(/^#/, '').split('?')[0] || 'home'");
    expect(app).toContain("[Home, '首页', 'home']");
    expect(app).toContain("[Database, '知识库', 'data']");
    expect(app).toContain("[Waypoints, '知识图谱', 'graph']");
    expect(app).toContain("[PenLine, '知识整理', 'dream']");
    expect(app).toContain("[MessageCircle, '知识助手', 'assistant']");
    expect(app).toContain("[Cable, 'MCP 接入', 'mcp']");
    expect(app).toContain('帮助支持');
    expect(app).toContain("[ListTodo, '任务中心', 'tasks']");
    expect(app).not.toContain('知识工作台');
    expect(app).toContain('aria-label={collapsed ? \'展开菜单\' : \'收起菜单\'}');
    expect(home).toContain('创建我的知识库');
    expect(home).toContain('已有知识库？');
    expect(home).toContain("'wb-composer'");
    expect(home).toContain('aria-label="添加附件"');
    expect(home).toContain('aria-label="对话模型"');
    expect(home).toContain("onOpen('knowledge-import')");
    expect(home).toContain("onOpen('mcp')");
    expect(home).toContain('title="总体概览"');
    expect(home).toContain("onOpen('dashboard')");
    expect(home).toContain('你好，开始探索你的知识');
    expect(home).not.toContain('最近活动');
    expect(create).toContain('desktop.saveSetup');
    expect(create).toContain('api.startImportRun');
    expect(create).toContain('api.startImportUploadRun');
    expect(create).toContain('选择文件夹');
    expect(read('admin/src/workbench/Workbench.tsx')).toContain('pmbrain:open-conversation');
  });

  test('知识助手能看出当前是谁在写，成果卡片显示知识库路径', () => {
    const workbench = read('admin/src/workbench/Workbench.tsx');
    const message = read('admin/src/workbench/Message.tsx');
    const css = read('admin/src/workbench/workbench.css');
    expect(workbench).toContain('agentAvatar');
    expect(workbench).toContain('正在使用');
    expect(workbench).toContain('{agentRoleLabel(wb.assistantId)} · 当前对话');
    expect(workbench).toContain('向${assistant.name}发送');
    expect(workbench).toContain('{assistant.name} · {wb.knowledge ? \'结合知识库回答\' : \'普通对话\'}');
    expect(message).toContain('已保存到 ${item.publishedPath}');
    expect(message).toContain("assistantRole === '主助手' ? 'main' : 'specialist'");
    expect(css).toContain('button[data-kind="specialist"] .wb-agent-avatar');
    expect(css).toContain('.wb-assistant-chip[data-kind="specialist"]');
    expect(css).toContain('.wb-message[data-kind="specialist"] .wb-avatar');
    expect(read('admin/src/workbench/AgentSettings.tsx')).toContain('周报等成果会写入所选知识来源的本地目录，优先主数据源路径');
  });

  test('菜单默认展开且保留手动折叠，两个 MCP 页对调，对话模型记住上次选择，停止按钮是蓝色', () => {
    const app = read('admin/src/product/ProductApp.tsx');
    const workbench = read('admin/src/workbench/useWorkbench.ts');
    expect(app).toContain("localStorage.getItem(NAV_COLLAPSED_KEY) === '1'");
    expect(app).toContain('menuMcp');
    expect(app).toContain("menuMcp ? 'integrations'");
    expect(app).toContain("category === 'integrations'");
    expect(app).toContain('<ConnectionCenterPage />');
    expect(rememberedChatModel('ollama:qwen', 'deepseek:v4', ['deepseek:v4', 'ollama:qwen'])).toBe('ollama:qwen');
    expect(rememberedChatModel('', 'deepseek:v4', ['deepseek:v4', 'ollama:qwen'])).toBe('deepseek:v4');
    expect(rememberedChatModel('', '', ['ollama:qwen'])).toBe('ollama:qwen');
    expect(rememberedChatModel('kept-model', 'other', [])).toBe('');
    expect(workbench).toContain('rememberedChatModel');
    expect(workbench).toContain('rememberChatModel');
    expect(workbench).not.toContain('setModel(next.model)');
    expect(read('admin/src/workbench/Workbench.tsx')).toContain('className="wb-send wb-stop"');
    expect(read('admin/src/workbench/workbench.css')).toContain('#0874ff');
    expect(read('desktop/src/renderer/settings-content.html')).toContain('class="preference-row"');
    expect(read('admin/src/product/model-services/ModelRoles.tsx')).toContain('启用图片与文档 OCR');
    const theme = read('admin/src/product/product-theme.css');
    expect(theme).toContain('min-height: 20px');
    expect(theme).toContain('justify-content: flex-start');
    expect(theme).toContain('#34C759');
    expect(theme).toContain('height: fit-content');
  });
});
