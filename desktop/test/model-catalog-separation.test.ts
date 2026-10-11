import { expect, test } from 'bun:test';
import { hydrateModelServices, projectModelServices } from '../src/main/models/model-services';
import { syncServiceModels } from '../src/main/models/model-service-sync';
import { mergeServiceModels, newServiceModel, type ModelService } from '../../shared/model-services';
import { getRecipe } from '../../src/core/ai/recipes';

const setup: any = { keyValues: {} };
const service: ModelService = { id: 'deepseek', provider: 'deepseek', name: '深度求索', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-key', enabled: true, models: [newServiceModel('legacy-private')] };

test('new platforms do not insert registry model IDs into the saved list', () => {
  expect(hydrateModelServices({}, setup).every(item => item.models.length === 0)).toBe(true);
  expect(getRecipe('deepseek')?.touchpoints.embedding?.models).not.toContain('deepseek-embedding');
});

test('legacy selections, advanced routes and stored metadata survive hydration and saving', () => {
  const saved = { ...service, models: [{ ...newServiceModel('deepseek-embedding', 'embedding'), dimensions: 768, inputPrice: 2 }] };
  expect(hydrateModelServices({ desktop: { model_services: [saved] } }, setup).find(item => item.id === saved.id)).toEqual(saved);
  const config = { chat_model: 'deepseek:my-chat', embedding_model: 'openai:my-vector', 'models.tier.high': 'deepseek:my-high', expansion_model: 'deepseek:my-expand' };
  const current = { ...setup, chatModel: config.chat_model, embeddingModel: config.embedding_model, embeddingDimensions: 768 };
  const services = hydrateModelServices(config, current);
  expect(services.find(item => item.id === 'deepseek')?.models.map(model => model.id)).toEqual(['my-chat', 'my-expand', 'my-high']);
  expect(services.find(item => item.id === 'openai')?.models[0].dimensions).toBe(768);
  const next = projectModelServices(config, services);
  expect(hydrateModelServices(next, current)).toEqual(services);
  for (const [key, value] of Object.entries(config)) expect(next[key]).toBe(value);
});

test('online IDs alone define the catalog; remote metadata wins over registry defaults', async () => {
  const result = await syncServiceModels(service, async () => Response.json({ data: [
    { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', context_window: 1048576, input_modalities: ['text', 'image'], effort: { supported_levels: ['low', 'high'] } },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', context_window: 1048576, input_modalities: ['text'], effort: { supported_levels: ['high'] } },
  ] }));
  expect(result.models.map(model => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
  expect(result.models[0].name).toBe('DeepSeek-V4.1-Flash');
  expect(result.models[0].contextWindow).toBe(1048576);
  expect(result.models[0].capabilities).toEqual(expect.arrayContaining(['vision', 'reasoning', 'tools']));
  expect(result.models[1].capabilities).not.toContain('vision');
  const models = mergeServiceModels(service.models, [result.models[0]]);
  const next = projectModelServices({}, [{ ...service, models }]);
  expect(hydrateModelServices(next, setup).find(item => item.id === 'deepseek')?.models).toEqual(models);
  expect(service.models.map(model => model.id)).toEqual(['legacy-private']);
});

test('empty and failed online responses never fall back to local models', async () => {
  expect((await syncServiceModels(service, async () => Response.json({ data: [] }))).models).toEqual([]);
  await expect(syncServiceModels(service, async () => Response.json({ error: { message: 'denied' } }, { status: 401 }))).rejects.toThrow('拉取模型失败。API 密钥无效，请检查后重新配置');
  expect(service.models.map(model => model.id)).toEqual(['legacy-private']);
});

test('unknown remote IDs do not inherit capabilities from other registry entries', async () => {
  const result = await syncServiceModels(service, async () => Response.json({ data: [{ id: 'future-model' }, { id: 'deepseek-flash', input_modalities: ['text'], supported_parameters: [], context_window: 32000 }] }));
  expect(result.models[0]).toEqual(newServiceModel('future-model'));
  expect(result.models[1].capabilities).toEqual([]);
  expect(result.models[1].contextWindow).toBe(32000);
});

test.each(['zhipu', 'mimo', 'openai', 'service-private'])('%s only lists remote IDs without injecting or rewriting them', async (provider) => {
  const result = await syncServiceModels({ ...service, provider }, async () => Response.json({ data: [{ id: 'models/private-chat' }] }));
  expect(result.models).toEqual([newServiceModel('models/private-chat')]);
});
