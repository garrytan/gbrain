import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve('src/renderer/index.html'), 'utf8');
const renderer = readFileSync(resolve('src/renderer/src.ts'), 'utf8');
const styles = readFileSync(resolve('src/renderer/style.css'), 'utf8');
const main = readFileSync(resolve('src/main/index.ts'), 'utf8');
const preload = readFileSync(resolve('src/preload/index.ts'), 'utf8');
const builder = readFileSync(resolve('electron-builder.yml'), 'utf8');

describe('desktop settings renderer contracts', () => {
  test('keeps the four desktop tasks separate and exposes advanced-only controls', () => {
    for (const panel of ['basic', 'models', 'integrations', 'updates']) {
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
