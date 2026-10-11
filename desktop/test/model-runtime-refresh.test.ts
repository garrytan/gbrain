import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModelServices, saveModelServicesLive } from '../src/main/models/model-services';
import { canHotUpdateRunningModels, modelServiceRuntimeChanged } from '../src/main/models/model-runtime-refresh';
import { newServiceModel, type ModelService } from '../../shared/model-services';

const current = {
  engine: 'pglite' as const,
  databasePath: 'D:\\brain\\brain.pglite',
  embeddingModel: 'ollama:embed',
  embeddingDimensions: 1024,
};

test('保存模型列表不再顺手停止本机服务', () => {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('saveModelServices:'), source.indexOf('providerModels:'));
  expect(handler).toContain('saveModelServicesLive');
  expect(handler).not.toContain('sidecarController.stop');
  expect(handler).not.toContain('sidecarController.start');
  const setup = readFileSync(new URL('../src/main/startup/setup-controller.ts', import.meta.url), 'utf8');
  expect(setup).toContain('canHotUpdateRunningModels');
  expect(setup).toContain('reloadLiveModels');
});

test('只改已添加模型时，不把密钥和地址当成运行配置变化', () => {
  const before = { provider_base_urls: { ollama: 'http://127.0.0.1:11434/v1' }, desktop: { model_services: [{ models: ['a', 'b'] }] } };
  const after = { provider_base_urls: { ollama: 'http://127.0.0.1:11434/v1' }, desktop: { model_services: [{ models: ['a'] }] } };
  expect(modelServiceRuntimeChanged(before, after)).toBe(false);
  expect(modelServiceRuntimeChanged(before, { ...after, provider_touchpoint_api_keys: { ollama: { chat: 'sk-new' } } })).toBe(true);
});

test('切换普通模型可以热更新，换向量模型、数据库或知识目录则不行', () => {
  const base = {
    sidecarReady: true,
    needsSetup: false,
    migrationRequired: false,
    applySourceConfiguration: false,
    current,
    payload: {
      engine: 'pglite' as const,
      databasePath: current.databasePath,
      resetAdvancedModelRouting: false,
      modelConfig: { chatModel: 'ollama:other', embeddingModel: 'ollama:embed', ocrEnabled: true, ocrModel: 'ollama:other' },
    },
  };
  expect(canHotUpdateRunningModels(base)).toBe(true);
  expect(canHotUpdateRunningModels({ ...base, payload: { ...base.payload, modelConfig: { ...base.payload.modelConfig, embeddingModel: 'ollama:other-embed' } } })).toBe(false);
  expect(canHotUpdateRunningModels({ ...base, payload: { ...base.payload, engine: 'postgres', databaseUrl: 'postgresql://localhost/brain' } })).toBe(false);
  expect(canHotUpdateRunningModels({ ...base, applySourceConfiguration: true })).toBe(false);
  expect(canHotUpdateRunningModels({ ...base, sidecarReady: false })).toBe(false);
});

test('移除未使用模型只保存文件，修改密钥才刷新运行中的服务', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pmbrain-model-refresh-'));
  const previous = process.env.PMBRAIN_HOME;
  process.env.PMBRAIN_HOME = home;
  try {
    const directory = join(home, '.pmbrain');
    mkdirSync(directory, { recursive: true });
    const service: ModelService = {
      id: 'ollama', provider: 'ollama', name: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', enabled: true,
      models: [newServiceModel('keep', 'chat'), newServiceModel('drop', 'chat')],
    };
    writeFileSync(join(directory, 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: join(directory, 'brain.pglite'),
      chat_model: 'ollama:keep',
      embedding_disabled: true,
      desktop: { model_services: [service], setup_completed: true, theme: 'system' },
    }));
    const reloads: string[] = [];
    const reload = async () => { reloads.push('reload'); };
    const first = readModelServices();
    await saveModelServicesLive({
      services: first.services.map(item => item.id === 'ollama' ? { ...item, models: item.models.filter(model => model.id !== 'drop') } : item),
      revision: first.revision,
    }, reload);
    expect(reloads).toEqual([]);
    expect(readModelServices().services.find(item => item.id === 'ollama')?.models.map(model => model.id)).toEqual(['keep']);

    const saved = readModelServices();
    await saveModelServicesLive({
      services: saved.services.map(item => item.id === 'ollama' ? { ...item, apiKey: 'sk-live' } : item),
      revision: saved.revision,
    }, reload);
    expect(reloads).toEqual(['reload']);
    const stored = JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')) as { provider_touchpoint_api_keys?: { ollama?: { chat?: string } } };
    expect(stored.provider_touchpoint_api_keys?.ollama?.chat).toBe('sk-live');

    const loaded = readModelServices();
    const filePath = join(directory, 'config.json');
    const unrelated = JSON.parse(readFileSync(filePath, 'utf8')) as { desktop?: Record<string, unknown> };
    unrelated.desktop = { ...unrelated.desktop, last_migrated_version: '9.9.9' };
    writeFileSync(filePath, JSON.stringify(unrelated));
    const savedKey = await saveModelServicesLive({
      services: loaded.services.map(item => item.id === 'ollama' ? { ...item, apiKey: 'sk-after-unrelated-write' } : item),
      revision: loaded.revision,
    }, reload);
    expect(savedKey.services.find(item => item.id === 'ollama')?.apiKey).toBe('sk-after-unrelated-write');
    const after = JSON.parse(readFileSync(filePath, 'utf8')) as { desktop?: { last_migrated_version?: string } };
    expect(after.desktop?.last_migrated_version).toBe('9.9.9');
  } finally {
    if (previous === undefined) delete process.env.PMBRAIN_HOME;
    else process.env.PMBRAIN_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
