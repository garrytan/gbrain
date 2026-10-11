import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settingGroupNames, visibleSettingItems, type SettingNavItem } from '../admin/src/product/settings-nav';

const items: SettingNavItem[] = [
  { key: 'models', label: '模型服务', group: 'AI 与模型', desktop: true },
  { key: 'model-roles', label: '知识库模型配置', group: 'AI 与模型', desktop: true },
  { key: 'general', label: '通用设置', group: '偏好' },
  { key: 'knowledge', label: '知识库设置', group: '知识库' },
  { key: 'basic', label: '数据库与资料目录', group: '知识库', desktop: true },
  { key: 'dream', label: '整理设置', group: '知识整理' },
  { key: 'integrations', label: 'MCP 接入', group: '连接与服务', desktop: true },
  { key: 'system', label: '桌面、网络与启动', group: '系统', desktop: true },
  { key: 'updates', label: '软件更新', group: '系统', desktop: true },
  { key: 'repair', label: '数据备份与修复', group: '系统', desktop: true },
];

test('搜索模型时只留下有匹配项的分组，空分组不再出现', () => {
  const matched = visibleSettingItems(items, '模型', true);
  expect(matched.map(item => item.label)).toEqual(['模型服务', '知识库模型配置']);
  expect(settingGroupNames(matched)).toEqual(['AI 与模型']);
  expect(settingGroupNames(matched)).not.toContain('偏好');
  expect(settingGroupNames(matched)).not.toContain('系统');
});

test('搜索分组名称时显示这一组，清空搜索时分组都还在', () => {
  expect(settingGroupNames(visibleSettingItems(items, '系统', true))).toEqual(['系统']);
  expect(visibleSettingItems(items, '系统', true).map(item => item.key)).toEqual(['system', 'updates', 'repair']);
  expect(settingGroupNames(visibleSettingItems(items, '', true))).toEqual(['AI 与模型', '偏好', '知识库', '知识整理', '连接与服务', '系统']);
});

test('左下角版本号和设置搜索都接在当前产品页面上', () => {
  const page = readFileSync(join(import.meta.dir, '../admin/src/product/ProductApp.tsx'), 'utf8');
  expect(page).toContain('product-version');
  expect(page).toContain('visibleSettingItems');
  expect(page).not.toContain('Array.from(new Set(settingItems.map(item => item.group)))');
  expect(page).toContain("label: '网络与连接'");
  expect(page).not.toContain('桌面、网络与启动');
});
