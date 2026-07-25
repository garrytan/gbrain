import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const consoleSource = readFileSync(join(process.cwd(), 'admin/src/pages/Console.tsx'), 'utf8');
const appSource = readFileSync(join(process.cwd(), 'admin/src/App.tsx'), 'utf8');
const styles = readFileSync(join(process.cwd(), 'admin/src/index.css'), 'utf8');
const desktopRenderer = readFileSync(join(process.cwd(), 'desktop/src/renderer/src.ts'), 'utf8');

describe('Admin settings information architecture', () => {
  test('Admin settings are split into five service-focused sections', () => {
    for (const label of [
      '常规设置',
      '知识库设置',
      '知识整理设置',
      '导入与向量化',
      '模型配置',
    ]) {
      expect(consoleSource).toContain(`label: '${label}'`);
    }
    expect(appSource).toContain('aria-label="设置"');
    expect(appSource).toContain('className={`nav-item nav-subitem');
    expect(appSource).toContain("'settings-general'");
    expect(appSource).toContain("'settings-knowledge'");
    expect(appSource).toContain("'settings-dream'");
    expect(appSource).toContain("'settings-import'");
    expect(appSource).toContain("'settings-models'");
    expect(consoleSource).not.toContain('className="settings-menu"');
    expect(consoleSource).toContain("section === 'knowledge'");
    expect(consoleSource).toContain("section === 'dream'");
    expect(consoleSource).toContain("section === 'import'");
    expect(consoleSource).toContain("section === 'models'");
    expect(consoleSource).not.toContain("section === 'system'");
    expect(consoleSource).not.toContain('<h2>系统与更新</h2>');
  });

  test('desktop-only controls are omitted from Admin settings', () => {
    expect(consoleSource).not.toContain('开机启动和关闭窗口行为属于桌面应用权限');
    expect(consoleSource).not.toContain('不会尝试修改 Windows 登录启动项');
    expect(consoleSource).not.toContain('版本更新记录');
    expect(desktopRenderer).toContain('本版本暂无更新记录');
    expect(desktopRenderer).toContain('renderReleaseNotes(update.releaseNotes)');
  });

  test('source Git actions match repository state and do not expose CLI output', () => {
    expect(consoleSource).toContain("source.git_repo ? '提交更改' : '创建 Git'");
    expect(consoleSource).toContain('{source.local_path && (');
    expect(consoleSource).toContain('将包含新增、修改和删除的文件');
    expect(consoleSource).not.toContain('同步复用 PMBrain CLI');
    expect(consoleSource).not.toContain("run?.kind === 'sync_source'");
  });

  test('desktop layout uses compact sidebar subitems and a single content area', () => {
    expect(styles).toContain('.nav-section-settings');
    expect(styles).toContain('.nav-subitem');
    expect(styles).toContain('.settings-content-standalone');
    expect(styles).not.toContain('.settings-menu');
  });
});
