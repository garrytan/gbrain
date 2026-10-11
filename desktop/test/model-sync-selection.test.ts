import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { configuredProvidersFirst, isCustomProvider, listedServiceModels, mergeServiceModels, newServiceModel, presetBaseUrl, providerKindLabel, SERVICE_KEY_PAGES, SERVICE_PRESETS, serviceEndpointError, serviceModelSections, serviceModelsNotOnRemote, serviceNeedsApiKey } from '../../shared/model-services';

const page = ['ModelServices.tsx', ...readdirSync(join(import.meta.dir, '../../admin/src/product/model-services')).filter(file => /\.tsx?$/.test(file)).map(file => `model-services/${file}`)]
  .map(file => readFileSync(join(import.meta.dir, '../../admin/src/product', file), 'utf8')).join('\n');

test('已经启用的服务商排在前面，同一组里仍保持原来的顺序', () => {
  const sorted = configuredProvidersFirst([
    { name: 'Ollama', enabled: false },
    { name: '深度求索', enabled: true },
    { name: '硅基流动', enabled: false },
    { name: '智谱开放平台', enabled: true },
  ]);
  expect(sorted.map(item => item.name)).toEqual(['深度求索', '智谱开放平台', 'Ollama', '硅基流动']);
});

test('平台返回的模型先作为候选，只有点选的才会进入已添加列表', () => {
  const remote = [newServiceModel('对话甲'), newServiceModel('向量乙', 'embedding'), newServiceModel('对话丙')];
  const chatOnly = listedServiceModels(remote, '', 'chat');
  expect(chatOnly.map(model => model.id)).toEqual(['对话甲', '对话丙']);
  const added = mergeServiceModels([newServiceModel('原来的')], [chatOnly[0]]);
  expect(added.map(model => model.id)).toEqual(['原来的', '对话甲']);
  expect(added.some(model => model.id === '向量乙' || model.id === '对话丙')).toBe(false);
});

test('搜索只看名称和模型 ID，远端没有的本地模型可以单独清出来', () => {
  const local = [newServiceModel('qwen3-embedding:0.6b', 'embedding'), newServiceModel('留下')];
  expect(listedServiceModels(local, 'QWEN').map(model => model.id)).toEqual(['qwen3-embedding:0.6b']);
  expect(serviceModelsNotOnRemote(local, [newServiceModel('留下'), newServiceModel('新的')]).map(model => model.id)).toEqual(['qwen3-embedding:0.6b']);
});

test('不完整或带账号的地址不会当作可以保存的 API 地址', () => {
  expect(serviceEndpointError({ name: '本地', baseUrl: 'http://' })).toContain('完整的 API 地址');
  expect(serviceEndpointError({ name: '云端', baseUrl: 'https://user:secret@api.example.com/v1' })).toContain('不含账号');
  expect(serviceEndpointError({ name: '云端', baseUrl: 'https://api.example.com/v1' })).toBeNull();
});

test('模型服务页按一份地址获取并挑选模型，切换后自动保存', () => {
  expect(page).toContain('同步模型');
  expect(page).toContain('选择模型');
  expect(page).toContain('添加所选模型');
  expect(page).toContain('检测并启用');
  expect(page).toContain('清理未返回的模型');
  expect(page).not.toContain('同步失败：HTTP');
  const syncSource = readFileSync(join(import.meta.dir, '../src/main/models/model-service-sync.ts'), 'utf8');
  expect(syncSource).toContain('拉取模型失败。API 密钥无效，请检查后重新配置');
  expect(page).toContain('提供商名称');
  expect(page).toContain('切换后自动保存');
  for (const removed of ['普通模型接口', '向量模型接口', '保存模型服务', '重新加载', '保存知识库模型配置', '请先保存模型服务']) {
    expect(page).not.toContain(removed);
  }
});

test('云端密钥和自定义服务商都要在弹窗里确认后才保存，本地服务不要求密钥', () => {
  expect(serviceNeedsApiKey('ollama', 'http://localhost:11434/v1')).toBe(false);
  expect(serviceNeedsApiKey('ollama', 'https://example.com/v1')).toBe(false);
  expect(serviceNeedsApiKey('service-lmstudio', 'http://127.0.0.1:1234/v1')).toBe(false);
  expect(serviceNeedsApiKey('service-custom', 'http://192.168.1.8:1234/v1')).toBe(false);
  expect(serviceNeedsApiKey('service-custom', 'http://[::1]:11434/v1')).toBe(false);
  expect(serviceNeedsApiKey('deepseek', 'https://api.deepseek.com/v1')).toBe(true);
  expect(serviceNeedsApiKey('service-custom', 'https://api.example.com/v1')).toBe(true);
  expect(serviceNeedsApiKey('service-custom', '还没写完')).toBe(true);
  expect(SERVICE_KEY_PAGES.deepseek).toBe('https://platform.deepseek.com/api_keys');
  expect(SERVICE_KEY_PAGES.mimo).toBeUndefined();
  expect(page).toContain('添加 API 密钥');
  expect(page).toContain('保存并关闭');
  expect(page).toContain('获取密钥');
  expect(page).toContain('添加端点');
  expect(page).toContain('确认前不会保存');
  expect(page).toContain('添加自定义提供商');
  expect(page).toContain('端点设置');
  expect(page).toContain('例如 OpenAI');
  expect(page).toContain('实际请求路径');
  expect(page).toContain('provider-draft-mark');
  expect(page).toContain('className="key-box draft-key"');
  expect(page).not.toContain("step: 'address'");
  expect(page).toContain('serviceNeedsApiKey');
  for (const removed of ['修改后自动保存', '添加后立即保存', 'onBlur={blurPrimary}']) {
    expect(page).not.toContain(removed);
  }
});

test('单独一个模型不重复显示分组，自定义名称下面保留 API 模型 ID', () => {
  const flash = newServiceModel('mimo-v2.6-flash');
  const renamed = { ...newServiceModel('mimo-v2.6-pro'), name: '我的专业模型' };
  const shared = [newServiceModel('openai/gpt-4o'), newServiceModel('openai/gpt-4o-mini')];
  expect(serviceModelSections([flash, renamed]).map(section => section.group)).toEqual([null]);
  expect(serviceModelSections([renamed])[0].models[0].name).toBe('我的专业模型');
  expect(serviceModelSections([renamed])[0].models[0].id).toBe('mimo-v2.6-pro');
  expect(serviceModelSections(shared).map(section => [section.group, section.models.length])).toEqual([['openai', 2]]);
  expect(serviceModelSections([{ ...newServiceModel('solo'), group: '我的分组' }])[0].group).toBe('我的分组');
  expect(providerKindLabel({ id: 'mimo', provider: 'mimo' })).toBe('模型服务');
  expect(providerKindLabel({ id: 'service-siliconflow', provider: 'service-siliconflow' })).toBe('模型服务');
  expect(isCustomProvider({ id: 'service-extra', provider: 'service-extra' })).toBe(true);
  expect(providerKindLabel({ id: 'service-extra', provider: 'service-extra' })).toBe('自定义服务商');
  expect(SERVICE_PRESETS.some(([id]) => id === 'service-extra')).toBe(false);
  expect(page).toContain('删除服务商');
  expect(page).toContain('自定义服务商');
  expect(page).toContain('isCustomProvider(service)');
  expect(page).toContain('serviceModelSections');
});

test('编辑密钥带上已保存的值，复制编辑删除在悬停出现，眼睛一直在', () => {
  expect(page).toMatch(/value:\s*current\?\.apiKey\s*\?\?\s*['"]{2}/);
  expect(page).not.toContain("setKeyEditor({ value: '', show: false, error: '' })");
  expect(page).toContain('key-hover-actions');
  expect(page).toContain('className="key-eye"');
  expect(page).toContain('复制密钥');
  expect(page).toContain('编辑密钥');
  expect(page).toContain('删除密钥');
  expect(page).toContain('删除后将停用');
  expect(page).toContain('删除并停用');
  expect(page).toContain('恢复默认');
  expect(page).toContain('row-actions');
  expect(presetBaseUrl('service-dmxapi')).toBe('https://www.dmxapi.cn/v1');
  expect(presetBaseUrl('service-qiniu')).toBe('https://api.qnaigc.com/v1');
  expect(presetBaseUrl('service-baichuan')).toBe('https://api.baichuan-ai.com/v1');
  expect(presetBaseUrl('ollama')).toBe('http://localhost:11434/v1');
  for (const id of ['service-dmxapi', 'service-qiniu', 'service-baichuan']) {
    expect(isCustomProvider({ id, provider: id })).toBe(false);
  }
  expect(SERVICE_PRESETS.map(([id]) => id).slice(0, 9)).toEqual(['ollama', 'deepseek', 'service-siliconflow', 'zhipu', 'service-dmxapi', 'service-qiniu', 'service-lmstudio', 'service-moonshot', 'service-baichuan']);
});
