import { expect, test } from 'bun:test';
import { mergeModelServices, projectModelServices, syncServiceModels } from '../src/main/models/model-services';
import { newServiceModel, type ModelService } from '../../shared/model-services';
import { getRecipe } from '../../src/core/ai/recipes';

const service = (id: string): ModelService => ({ id, provider: `service-${id}`, name: id, baseUrl: `https://${id}.example/v1`, apiKey: `${id}-test-key`, enabled: true, models: [newServiceModel('same-model')] });
test('platforms with the same model name retain separate endpoints and credentials', () => {
  const config = projectModelServices({ unknown: 42, chat_model: 'deepseek:old', embedding_model: 'ollama:old' }, [service('one'), service('two')]);
  expect(config.provider_base_urls['service-one']).toBe('https://one.example/v1');
  expect(config.provider_touchpoint_api_keys['service-two'].chat).toBe('two-test-key');
  expect(config.chat_model).toBe('deepseek:old');
  expect(config.embedding_model).toBe('ollama:old');
  expect(config.unknown).toBe(42);
});
test('existing model metadata survives synchronization', () => {
  const old = { ...newServiceModel('same-model'), inputPrice: 5, capabilities: ['vision' as const] };
  expect(mergeModelServices([old], [newServiceModel('same-model'), newServiceModel('new')])).toEqual([old, newServiceModel('new')]);
});
test('a selected platform cannot be disabled and an embedding endpoint cannot be retargeted silently', () => {
  const current = projectModelServices({ chat_model: 'service-one:same-model', embedding_model: 'service-one:same-model' }, [service('one')]);
  expect(() => projectModelServices(current, [{ ...service('one'), enabled: false }])).toThrow();
  expect(() => projectModelServices(current, [{ ...service('one'), baseUrl: 'https://other.example/v1' }])).toThrow();
});
test('sync surfaces HTTP errors and does not replace them with catalog models', async () => {
  await expect(syncServiceModels(service('one'), async () => new Response('bad credential', { status: 401 }))).rejects.toThrow('拉取模型失败。API 密钥无效，请检查后重新配置');
});
test('service aliases resolve independently and never inherit another platform key', () => {
  expect(getRecipe('service-one')?.id).toBe('service-one');
  expect(getRecipe('service-one')?.auth_env.optional).toEqual(['PMBRAIN_SERVICE_ONE_API_KEY']);
  expect(getRecipe('service-INVALID')).toBeUndefined();
  expect(getRecipe('custom-openai')?.auth_env.optional).toContain('CUSTOM_OPENAI_API_KEY');
});
