import { expect, test } from 'bun:test';
import { hydrateModelServices, projectModelServices } from '../src/main/models/model-services';
import { modelServiceRuntimeChanged } from '../src/main/models/model-runtime-refresh';
import { syncServiceModels } from '../src/main/models/model-service-sync';
import { newServiceModel, serviceModelValue, type ModelService } from '../../shared/model-services';

const platform = (patch: Partial<ModelService> = {}): ModelService => ({ id: 'local', provider: 'service-local', name: '本地服务', baseUrl: 'http://localhost:1234/v1', apiKey: '', enabled: true, models: [], ...patch });
test('upgrading separate custom chat and embedding preserves keys, addresses, selections and dimensions', () => {
  const config = { chat_model: 'custom-openai:local-chat', embedding_model: 'custom-openai:local-embed', embedding_dimensions: 768, provider_touchpoint_base_urls: { 'custom-openai': { chat: 'http://localhost:8000/v1', embedding: 'http://localhost:8001/v1' } }, provider_touchpoint_api_keys: { 'custom-openai': { chat: 'chat-secret', embedding: 'embed-secret' } } };
  const setup: any = { chatModel: config.chat_model, embeddingModel: config.embedding_model, embeddingDimensions: 768, keyValues: { customOpenaiChat: 'chat-secret', customOpenaiEmbedding: 'embed-secret' }, customProviders: { chat: [{ id: 'custom-endpoint-chat-legacy', displayName: '普通接口', baseUrl: 'http://localhost:8000/v1', modelId: 'local-chat' }], embedding: [{ id: 'custom-endpoint-embedding-legacy', displayName: '向量接口', baseUrl: 'http://localhost:8001/v1', modelId: 'local-embed' }] }, customSelection: { chat: 'custom-endpoint-chat-legacy', embedding: 'custom-endpoint-embedding-legacy' } };
  const services = hydrateModelServices(config, setup);
  const chat = services.find(s => s.legacy?.kind === 'chat')!;
  const embedding = services.find(s => s.legacy?.kind === 'embedding')!;
  expect(chat.apiKey).toBe('chat-secret'); expect(embedding.apiKey).toBe('embed-secret');
  expect(embedding.models[0].dimensions).toBe(768);
  const next = projectModelServices({ ...config, desktop: { model_services: services } }, services);
  expect(next.chat_model).toBe(config.chat_model); expect(next.embedding_model).toBe(config.embedding_model);
  expect(next.provider_touchpoint_base_urls['custom-openai']).toEqual(config.provider_touchpoint_base_urls['custom-openai']);
  expect(next.provider_touchpoint_api_keys['custom-openai']).toEqual(config.provider_touchpoint_api_keys['custom-openai']);
  expect(next.embedding_dimensions).toBe(768);
  expect(hydrateModelServices(next, setup).filter(s => s.legacy).length).toBe(2);
});
test('cloud sync explains missing API key before issuing any request', async () => {
  let calls = 0;
  await expect(syncServiceModels(platform({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }), async () => { calls++; return new Response('{}'); })).rejects.toThrow('API 密钥');
  expect(calls).toBe(0);
});
test('local OpenAI model listing supports no key, deduplicates and separates embedding', async () => {
  const result = await syncServiceModels(platform(), async (url) => {
    expect(String(url)).toBe('http://localhost:1234/v1/models');
    return Response.json({ data: [{ id: 'local-chat' }, { id: 'bge-m3', type: 'embedding' }, { id: 'local-chat' }] });
  });
  expect(result.models.map(m => [m.id, m.kind])).toEqual([['local-chat', 'chat'], ['bge-m3', 'embedding']]);
});
test('one Ollama show error does not hide installed models and reports uncertain capability', async () => {
  const result = await syncServiceModels(platform({ provider: 'ollama', baseUrl: 'http://localhost:11434/' }), async (url, init) => {
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'local-chat' }, { name: 'local-embed' }, { name: 'unknown' }] });
    const name = JSON.parse(String(init?.body)).model;
    if (name === 'unknown') return new Response('', { status: 404 });
    return Response.json({ capabilities: name === 'local-chat' ? ['completion', 'vision', 'tools'] : ['embedding'], model_info: { 'bert.embedding_length': 768 } });
  });
  expect(result.models.map(m => m.kind)).toEqual(['chat', 'embedding', 'unknown']);
  expect(result.models[1].dimensions).toBe(768); expect(result.warnings.length).toBe(1);
});
test('sync reports authentication errors with actionable guidance', async () => {
  await expect(syncServiceModels(platform({ apiKey: 'bad-key' }), async () => Response.json({ error: { message: 'Invalid API key' } }, { status: 401 }))).rejects.toThrow('密钥');
});
test('native provider separate touchpoints survive editing chat key', () => {
  const svc = platform({ id: 'ollama', provider: 'ollama', models: [newServiceModel('chat')], connections: { embedding: { baseUrl: 'http://localhost:8001/v1', apiKey: 'embedding-key' } } });
  const result = projectModelServices({ desktop: { model_services: [svc] } }, [{ ...svc, apiKey: 'new-chat-key' }]);
  expect(result.provider_touchpoint_api_keys.ollama).toEqual({ chat: 'new-chat-key', embedding: 'embedding-key' });
});

test('未使用的自定义服务商可以删除，正在使用的旧接口不能删除', () => {
  const chatEndpoint = { id: 'custom-endpoint-chat-legacy', displayName: '33', baseUrl: 'https://aigocode.app/v1', modelId: '333', apiKey: 'chat-secret' };
  const embeddingEndpoint = { id: 'custom-endpoint-embedding-legacy', displayName: '向量接口', baseUrl: 'http://localhost:8001/v1', modelId: 'local-embed' };
  const config = { chat_model: 'custom-openai:333', embedding_model: 'ollama:nomic', desktop: { custom_endpoints: { chat: [chatEndpoint], embedding: [embeddingEndpoint] } } };
  const setup: any = { chatModel: config.chat_model, embeddingModel: config.embedding_model, keyValues: { customOpenaiChat: 'chat-secret' }, customProviders: { chat: [chatEndpoint], embedding: [embeddingEndpoint] }, customSelection: { chat: chatEndpoint.id } };
  const services = hydrateModelServices(config, setup);
  const saved = projectModelServices({ ...config, desktop: { ...config.desktop, model_services: services } }, services);
  const chat = saved.desktop.model_services.find((item: ModelService) => item.legacy?.endpointId === chatEndpoint.id);
  const embedding = saved.desktop.model_services.find((item: ModelService) => item.legacy?.endpointId === embeddingEndpoint.id);
  expect(() => projectModelServices(saved, saved.desktop.model_services.filter((item: ModelService) => item.id !== chat.id))).toThrow('不能移除正在使用的模型平台');
  const removed = projectModelServices(saved, saved.desktop.model_services.filter((item: ModelService) => item.id !== embedding.id));
  expect(removed.desktop.custom_endpoints.embedding.map((item: { id: string }) => item.id)).toEqual([]);
  expect(removed.desktop.custom_endpoints.chat.map((item: { id: string }) => item.id)).toEqual([chatEndpoint.id]);
  expect(removed.provider_base_urls[embedding.provider]).toBeUndefined();
  expect(removed.provider_touchpoint_api_keys[embedding.provider]).toBeUndefined();
  const again = hydrateModelServices(removed, { ...setup, customProviders: { chat: [chatEndpoint], embedding: [] } });
  expect(again.some(item => item.legacy?.endpointId === embeddingEndpoint.id)).toBe(false);
  expect(again.some(item => item.legacy?.endpointId === chatEndpoint.id)).toBe(true);
});
test('删除未使用的自建平台会清掉它的地址和密钥，内置平台不会被清掉', () => {
  const custom = platform({ id: 'service-extra', provider: 'service-extra', name: '自建', baseUrl: 'https://extra.example/v1', apiKey: 'extra-key', models: [newServiceModel('demo')] });
  const ollama = platform({ id: 'ollama', provider: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', models: [newServiceModel('qwen')] });
  const saved = projectModelServices({ chat_model: 'ollama:qwen', provider_base_urls: { ollama: 'http://localhost:11434/v1' }, desktop: { model_services: [custom, ollama] } }, [custom, ollama]);
  expect(saved.provider_base_urls['service-extra']).toBe('https://extra.example/v1');
  expect(() => projectModelServices({ ...saved, chat_model: 'service-extra:demo' }, [ollama])).toThrow('不能移除正在使用的模型平台');
  const removed = projectModelServices(saved, [ollama]);
  expect(removed.provider_base_urls['service-extra']).toBeUndefined();
  expect(removed.provider_touchpoint_api_keys['service-extra']).toBeUndefined();
  expect(removed.provider_base_urls.ollama).toBe('http://localhost:11434/v1');
  expect(modelServiceRuntimeChanged(saved, removed)).toBe(true);
  const idle = projectModelServices({ provider_base_urls: { ollama: 'http://localhost:11434/v1' }, desktop: { model_services: [ollama] } }, [ollama]);
  const droppedPreset = projectModelServices(idle, []);
  expect(droppedPreset.provider_base_urls.ollama).toBe('http://localhost:11434/v1');
  expect(modelServiceRuntimeChanged(idle, droppedPreset)).toBe(false);
});
test('启用中的平台不能把已有密钥直接清空，停用后清空会抹掉保存的密钥', () => {
  const svc = platform({ id: 'service-one', provider: 'service-one', name: '云端', baseUrl: 'https://one.example/v1', apiKey: 'secret', enabled: true, connections: { embedding: { baseUrl: 'https://one.example/v1', apiKey: 'embed-secret' } } });
  const saved = projectModelServices({ desktop: { model_services: [svc] } }, [svc]);
  expect(saved.provider_touchpoint_api_keys['service-one']).toEqual({ chat: 'secret', embedding: 'embed-secret' });
  expect(() => projectModelServices(saved, [{ ...svc, apiKey: '', connections: { embedding: { baseUrl: svc.baseUrl, apiKey: '' } } }])).toThrow('请填写密钥，或先停用该平台');
  const cleared = projectModelServices(saved, [{ ...svc, apiKey: '', enabled: false, connections: { embedding: { baseUrl: svc.baseUrl, apiKey: '' } } }]);
  expect(cleared.desktop.model_services.find((item: ModelService) => item.id === svc.id)).toMatchObject({ apiKey: '', enabled: false });
  expect(cleared.provider_touchpoint_api_keys['service-one']).toEqual({ chat: '', embedding: '' });
  expect(modelServiceRuntimeChanged(saved, cleared)).toBe(true);
});
test('models added to a legacy embedding service use its own route for chat', () => {
  const service = platform({ legacy: { kind: 'embedding', endpointId: 'local', selected: true } });
  expect(serviceModelValue(service, newServiceModel('same', 'embedding'))).toBe('custom-openai:same');
  expect(serviceModelValue(service, newServiceModel('same', 'chat'))).toBe('service-local:same');
});
