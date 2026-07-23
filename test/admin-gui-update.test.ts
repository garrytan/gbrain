import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAdminBrainPageDetail, listAdminBrainPages } from '../src/commands/admin-console.ts';
import { normalizeThemeMode, readStoredThemeMode, readThemeMode, resolveTheme } from '../admin/src/lib/theme.ts';
import { getThinkRetrievalWarning, parseThinkOutput } from '../admin/src/lib/think-output.ts';

const appSource = readFileSync(join(process.cwd(), 'admin/src/App.tsx'), 'utf8');
const consoleSource = readFileSync(join(process.cwd(), 'admin/src/pages/Console.tsx'), 'utf8');
const adminStyles = readFileSync(join(process.cwd(), 'admin/src/index.css'), 'utf8');
const serveHttpSource = readFileSync(join(process.cwd(), 'src/commands/serve-http.ts'), 'utf8');

describe('Admin GUI update contract', () => {
  test('support modal promotes the developer account and opens a donation QR view', () => {
    expect(appSource).toContain('扫码关注开发者公众号，获取最新信息');
    expect(appSource).not.toContain('用于获取管理员登录链接、MCP 接入帮助和常见运维问题支持。');
    expect(appSource).toContain('认为产品还不错的话可进行打赏，你的支持是产品更新的动力。');
    expect(appSource).toContain("setSupportPanel('donate')");
    expect(appSource).toContain('wechat-donation.jpg');
  });
  test('theme defaults to system and supports explicit overrides', () => {
    expect(readThemeMode()).toBe('system');
    expect(readStoredThemeMode()).toBeNull();
    expect(normalizeThemeMode('dark')).toBe('dark');
    expect(normalizeThemeMode('invalid')).toBe('system');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });

  test('admin theme supports a browser override with desktop fallback', () => {
    expect(normalizeThemeMode('light')).toBe('light');
    expect(normalizeThemeMode('system')).toBe('system');
    expect(resolveTheme(normalizeThemeMode('system'), true)).toBe('dark');
    expect(appSource).toContain('api.theme()');
    expect(appSource).toContain('readStoredThemeMode() === null');
    expect(appSource).toContain('storeThemeMode(mode)');
    expect(consoleSource).toContain('onThemeModeChange(value)');
    expect(consoleSource).not.toContain('请在 PMBrain 桌面端修改界面主题');
    expect(serveHttpSource).toContain("app.get('/admin/api/theme'");
  });

  test('settings consolidates the main source and aligns Dream actions', () => {
    expect(consoleSource).toContain('className="main-source-current"');
    expect(consoleSource).toContain('className="main-source-purpose"');
    expect(consoleSource).not.toContain('className="main-source-grid"');
    expect(consoleSource).toContain('className="dream-output-action-row"');
    expect(consoleSource).not.toContain('<div className="settings-panel-actions">');
    expect(adminStyles).toContain('.dream-output-setting,');
    expect(adminStyles).toContain('.settings-feedback');
  });

  test('import options expose a clear data-source action', () => {
    expect(consoleSource).toContain("{importOptionsOpen ? '收起' : '展开'}");
    expect(consoleSource).toContain('可选择不同数据源及文件处理方式');
    expect(consoleSource).toContain('className="import-options-action"');
    expect(consoleSource).toContain('source.id !== overview.main_source_id');
    expect(consoleSource).not.toContain('className="worker-option"');
    expect(consoleSource).toContain('workers: 1');
    expect(adminStyles).toContain('.import-options-action');
  });

  test('settings exposes the all-file chunking and vectorization threshold', () => {
    expect(consoleSource).toContain('function ImportVectorizationSettings()');
    expect(consoleSource).toContain('默认 500 KB，可设置 100–5000 KB');
    expect(consoleSource).toContain('适用于所有文件');
    expect(serveHttpSource).toContain("app.get('/admin/api/import/settings'");
    expect(serveHttpSource).toContain("app.post('/admin/api/import/settings'");
  });

  test('Dream local Markdown toggle persists immediately and rolls back on failure', () => {
    expect(consoleSource).toContain('const saveDualWrite = async (dualWrite: boolean)');
    expect(consoleSource).toContain('onChange={event => void saveDualWrite(event.target.checked)}');
    expect(consoleSource).toContain("setMessage(dualWrite ? '已开启本地 Markdown 写入' : '已关闭本地 Markdown 写入')");
    expect(consoleSource).toContain('dualWrite: previousValue');
  });

  test('dark mode covers code blocks and Dream contrast-sensitive content', () => {
    expect(adminStyles).toContain('html[data-theme="dark"] .code-block pre');
    expect(adminStyles).toContain('html[data-theme="dark"] .dream-recommendation b');
    expect(adminStyles).toContain('html[data-theme="dark"] .dream-library-metrics b');
    expect(adminStyles).toContain('html[data-theme="dark"] .dream-result-grid section');
    expect(adminStyles).toContain('html[data-theme="dark"] .dream-ops-diagnostics');
    expect(adminStyles).toContain('html[data-theme="dark"] .dream-ops-grid section');
  });

  test('navigation exposes the consolidated beginner surfaces', () => {
    expect(appSource).toContain("{ page: 'dashboard' as Page, label: '总体概览' }");
    expect(appSource).toContain("page: 'import', label: '知识工作台'");
    expect(appSource).toContain("page: 'data', label: '知识库'");
    expect(appSource).toContain("page: 'dream', label: '知识整理'");
    expect(appSource).not.toContain("title: '知识工作'");
    expect(appSource).not.toContain('nav-arrow');
    expect(appSource).not.toContain("{ page: 'natural', label: '自然语言任务' }");
    expect(appSource).not.toContain("{ page: 'config', label: 'API 与模型配置' }");
  });

  test('assistant exposes direct import/search actions, AI, and five local history entries', () => {
    expect(consoleSource).toContain("startDirect('import')");
    expect(consoleSource).toContain("startDirect('search')");
    expect(consoleSource).toContain('className="pm-assistant-action search-action"');
    expect(consoleSource).toContain('<strong>导入</strong>');
    expect(consoleSource).toContain('<strong>搜索</strong>');
    expect(consoleSource).toContain("<strong>{loading ? '处理中…' : '发送'}</strong>");
    expect(consoleSource).not.toContain('本地文件或文件夹</small>');
    expect(consoleSource).not.toContain('模型综合并附引用</small>');
    expect(consoleSource).toContain('submitAuto()');
    expect(consoleSource).toContain('export const NATURAL_HISTORY_LIMIT = 5');
    expect(consoleSource).toContain("const NATURAL_WORKSPACE_KEY = 'pmbrain.natural.workspace'");
    expect(consoleSource).toContain('saveNaturalWorkspace({ text, preview, run, error, activeHistoryId, pendingContext })');
    expect(consoleSource).toContain('assistant-action-icon');
  });

  test('assistant distinguishes retrieval timeouts from an empty knowledge base', () => {
    expect(getThinkRetrievalWarning('[think.gather] hybrid stream failed: canceling statement due to statement timeout'))
      .toContain('不代表知识库中没有相关内容');
    expect(getThinkRetrievalWarning('')).toBeNull();
  });

  test('assistant reads the pretty JSON emitted by think --json', () => {
    const parsed = parseThinkOutput(JSON.stringify({
      answer: '综合回答',
      citations: [{ page_slug: 'wiki/example', row_num: 2 }],
      gaps: ['缺少后续数据'],
    }, null, 2));
    expect(parsed).toEqual({
      answer: '综合回答',
      citations: ['wiki/example#2'],
      gaps: ['缺少后续数据'],
    });
  });

  test('page detail reads full Markdown plus active takes', async () => {
    const statements: string[] = [];
    const engine = {
      executeRaw: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('FROM pages p')) return [{
          id: 7, slug: 'notes/example', title: 'Example', source_id: 'default', source_name: 'default',
          source_path: 'D:\\notes', type: 'note', page_kind: 'markdown', compiled_truth: '# Full body',
          timeline: '', frontmatter: {}, source_kind: 'file', source_uri: 'D:\\notes\\example.md',
          created_at: '2026-07-11', updated_at: '2026-07-11',
        }];
        return [{ row_num: 1, claim: 'A claim', kind: 'belief', holder: 'self', weight: 1, source: null }];
      },
    } as any;
    const detail = await getAdminBrainPageDetail(engine, 'default', 'notes/example');
    expect(detail?.compiled_truth).toBe('# Full body');
    expect(detail?.takes[0]?.claim).toBe('A claim');
    expect(statements.some(sql => sql.includes('p.deleted_at IS NULL'))).toBe(true);
  });

  test('knowledge view presets are translated into page-type filters', async () => {
    const statements: string[] = [];
    const engine = {
      executeRaw: async (sql: string) => {
        statements.push(sql);
        return sql.startsWith('SELECT COUNT') ? [{ total: 0 }] : [];
      },
    } as any;
    await listAdminBrainPages(engine, { view: 'insights' });
    expect(statements[0]).toContain('p.type IN');
  });

  test('recycle bin lists only deleted pages and can read their detail', async () => {
    const statements: string[] = [];
    const engine = {
      executeRaw: async (sql: string) => {
        statements.push(sql);
        if (sql.startsWith('SELECT COUNT')) return [{ total: 0 }];
        if (sql.includes('FROM pages p') && sql.includes('LIMIT 1')) return [{
          id: 9, slug: 'notes/deleted', title: 'Deleted', source_id: 'default', source_name: 'default',
          source_path: 'D:\\notes', type: 'note', page_kind: 'markdown', compiled_truth: '# Deleted',
          timeline: '', frontmatter: {}, source_kind: 'file', source_uri: null,
          created_at: '2026-07-11', updated_at: '2026-07-13',
        }];
        return [];
      },
    } as any;
    await listAdminBrainPages(engine, { view: 'trash' });
    expect(statements[0]).toContain('p.deleted_at IS NOT NULL');
    expect(statements[0]).toContain('ORDER BY p.deleted_at DESC');

    statements.length = 0;
    const detail = await getAdminBrainPageDetail(engine, 'default', 'notes/deleted', true);
    expect(detail?.compiled_truth).toBe('# Deleted');
    expect(statements[0]).not.toContain('p.deleted_at IS NULL');
  });

  test('knowledge data UI exposes a three-day recycle bin without a top undo notice', () => {
    expect(consoleSource).toContain("['trash', '回收站']");
    expect(consoleSource).toContain('移出的内容保留 3 天，之后自动清空');
    expect(consoleSource).toContain('restoreSelectedPage');
    expect(consoleSource).not.toContain('已移出知识库，可在本页撤销');
  });

  test('restoring a page refreshes the recycle bin without switching to all pages', () => {
    const restoreBlock = consoleSource.slice(
      consoleSource.indexOf('const restoreSelectedPage'),
      consoleSource.indexOf('\n  return (', consoleSource.indexOf('const restoreSelectedPage')),
    );
    expect(restoreBlock).toContain('await loadRows()');
    expect(restoreBlock).not.toContain("view: 'all'");
  });
});
