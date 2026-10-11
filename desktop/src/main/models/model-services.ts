import { existsSync, readFileSync } from 'node:fs';
import { assertModelRevision, modelConfigRevision } from './model-config-revision.js';
import { desktopConfigPath, backupFile, writeJsonConfig, getSetupInfo } from '../config-manager.js';
import type { SetupInfo } from '../config-manager.js';
import { getRecipe } from '../../../../src/core/ai/recipes/index.js';
import { SERVICE_PRESETS, isCustomProvider, newServiceModel, type ModelService, type ModelServicesState, type ServiceModel, mergeServiceModels, serviceConnection, serviceModelValue } from '../../../../shared/model-services.js';
import { modelServiceRuntimeChanged } from './model-runtime-refresh.js';

function rawConfig(): Record<string, any> {
  const path = desktopConfigPath();
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) : {};
}
export function mergeModelServices(existing: ServiceModel[], incoming: ServiceModel[]): ServiceModel[] {
  return mergeServiceModels(existing, incoming);
}
export function readModelServices(): ModelServicesState {
  const config = rawConfig();
  const setup = getSetupInfo().current;
  return { services: hydrateModelServices(config, setup), revision: modelConfigRevision(config) };
}
export function hydrateModelServices(config: Record<string, any>, setup: SetupInfo['current']): ModelService[] {
  const stored: ModelService[] = config.desktop?.model_services ?? [];
  const services = SERVICE_PRESETS.map(([provider, name, baseUrl]): ModelService => {
    const saved = stored.find(service => service.provider === provider);
    if (saved) return structuredClone(saved);
    const models: ServiceModel[] = [];
    const selections: Array<['chat' | 'embedding' | 'unknown', unknown]> = [
      ['chat', setup.chatModel], ['embedding', setup.embeddingModel], ['chat', setup.ocrModel],
      ['chat', config.expansion_model], ['unknown', config.reranker_model], ['chat', config.embedding_image_ocr_model],
      ...(config.chat_fallback_chain ?? []).map((value: string): ['chat', string] => ['chat', value]),
      ...Object.entries(config).filter(([key]) => key.startsWith('models.')).map(([, value]): ['chat', unknown] => ['chat', value]),
    ];
    for (const [kind, full] of selections) {
      if (typeof full === 'string' && full.startsWith(`${provider}:`)) {
        const id = full.slice(provider.length + 1);
        if (!models.some(m => m.id === id)) {
          const model = newServiceModel(id, kind);
          if (kind === 'embedding') model.dimensions = setup.embeddingDimensions;
          models.push(model);
        }
      }
    }
    const apiKey = config.provider_touchpoint_api_keys?.[provider]?.chat ?? config.provider_touchpoint_api_keys?.[provider]?.embedding ?? setup.keyValues[provider] ?? '';
    const chatUrl = config.provider_touchpoint_base_urls?.[provider]?.chat ?? config.provider_base_urls?.[provider] ?? baseUrl;
    const embedUrl = config.provider_touchpoint_base_urls?.[provider]?.embedding ?? chatUrl;
    const embedKey = config.provider_touchpoint_api_keys?.[provider]?.embedding ?? apiKey;
    return { id: provider, provider, name, baseUrl: chatUrl, apiKey, ...(embedUrl !== chatUrl || embedKey !== apiKey ? { connections: { embedding: { baseUrl: embedUrl, apiKey: embedKey } } } : {}), enabled: Boolean(apiKey || models.length), models };
  });
  for (const service of stored) if (!services.some(item => item.id === service.id)) services.push(structuredClone(service));
  for (const kind of ['chat', 'embedding'] as const) for (const endpoint of setup.customProviders?.[kind] ?? []) {
    if (!endpoint.modelId) continue;
    const current = kind === 'chat' ? setup.chatModel : setup.embeddingModel;
    const selected = setup.customSelection?.[kind] === endpoint.id && current?.startsWith('custom-openai:') === true;
    const key = endpoint.apiKey ?? (selected ? setup.keyValues[kind === 'chat' ? 'customOpenaiChat' : 'customOpenaiEmbedding'] : '') ?? '';
    const model = newServiceModel(endpoint.modelId, kind);
    if (selected && kind === 'embedding') model.dimensions = setup.embeddingDimensions;
    const saved = services.find(s => s.id === endpoint.id);
    if (saved) {
      saved.legacy = { kind, endpointId: endpoint.id, selected };
      if (!saved.apiKey && key) saved.apiKey = key;
      if (!saved.models.some(m => m.id === model.id)) saved.models.push(model);
      else if (model.dimensions) {
        const existing = saved.models.find(m => m.id === model.id)!;
        existing.dimensions ??= model.dimensions;
      }
    } else services.push({ id: endpoint.id, provider: `service-${endpoint.id}`, name: endpoint.displayName, baseUrl: endpoint.baseUrl, apiKey: key, enabled: true, models: [model], legacy: { kind, endpointId: endpoint.id, selected } });
  }
  return services;
}

function validateService(service: ModelService): void {
  if (!service || typeof service.id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(service.id) || !getRecipe(service.provider)) throw new Error('无效的模型平台');
  if (!service.name?.trim() || service.name.length > 100 || typeof service.apiKey !== 'string' || service.apiKey.length > 8192 || typeof service.enabled !== 'boolean') throw new Error('请检查平台名称与密钥');
  const url = new URL(service.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址必须为不含账号、查询参数的 HTTP(S) 地址');
  for (const connection of Object.values(service.connections ?? {})) {
    if (!connection || typeof connection.apiKey !== 'string') throw new Error('独立接口密钥无效');
    const endpoint = new URL(connection.baseUrl);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('独立接口地址无效');
  }
  if (!Array.isArray(service.models) || service.models.length > 5000 || new Set(service.models.map(m => m.id)).size !== service.models.length) throw new Error('模型列表无效或有重复 ID');
  for (const model of service.models) {
    if (typeof model.name !== 'string' || typeof model.group !== 'string' || model.name.length > 250 || model.group.length > 100) throw new Error('模型名称或分组无效');
    if (!model.id?.trim() || model.id.length > 250 || /[\r\n]/.test(model.id) || !['chat', 'embedding', 'unknown'].includes(model.kind)) throw new Error('请检查模型 ID 和类型');
    if (!Array.isArray(model.capabilities) || model.capabilities.some(c => !['vision', 'reasoning', 'tools', 'web'].includes(c))) throw new Error('模型能力标签无效');
    for (const value of [model.inputPrice, model.outputPrice, model.inputPriceCny, model.outputPriceCny, model.contextWindow, model.dimensions]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('价格及上下文长度必须为非负数');
    if (model.dimensions !== undefined && (!Number.isInteger(model.dimensions) || model.dimensions < 1)) throw new Error('向量维度必须为正整数，或留空自动检测');
  }
}
export function projectModelServices(config: Record<string, any>, services: ModelService[]): Record<string, any> {
  if (!Array.isArray(services) || services.length > 100 || new Set(services.map(s => s.id)).size !== services.length || new Set(services.map(s => s.provider)).size !== services.length) throw new Error('模型平台列表无效');
  const selected = [config.chat_model, config.embedding_model, config.ocr_model, config.expansion_model, config.reranker_model, config.embedding_image_ocr_model, ...(config.chat_fallback_chain ?? []), ...Object.entries(config).filter(([key]) => key.startsWith('models.')).map(([, value]) => value)].filter((v): v is string => typeof v === 'string');
  const next = structuredClone(config);
  next.provider_base_urls ??= {};
  next.provider_touchpoint_api_keys ??= {};
  next.provider_touchpoint_base_urls ??= {};
  for (const service of services) {
    validateService(service);
    const legacySelected = service.legacy?.kind === 'embedding' ? [config.embedding_model] : [config.chat_model, config.ocr_model, config.expansion_model, config.embedding_image_ocr_model, ...(config.chat_fallback_chain ?? []), ...Object.entries(config).filter(([key]) => key.startsWith('models.')).map(([, value]) => value)];
    const active = selected.filter(value => value.startsWith(`${service.provider}:`) || service.legacy?.selected && value.startsWith('custom-openai:') && legacySelected.includes(value));
    if (active.length && (!service.enabled || active.some(full => !service.models.some(m => serviceModelValue(service, m) === full || `${service.provider}:${m.id}` === full)))) throw new Error(`${service.name} 的模型仍在使用，请先修改知识库模型配置`);
    const old: ModelService | undefined = config.desktop?.model_services?.find((s: ModelService) => s.id === service.id);
    if (old?.apiKey && !service.apiKey && service.enabled) throw new Error('请填写密钥，或先停用该平台');
    if (old?.apiKey && !service.apiKey) {
      const chat = serviceConnection(service, 'chat');
      const embedding = serviceConnection(service, 'embedding');
      next.provider_touchpoint_api_keys[service.provider] = { ...next.provider_touchpoint_api_keys[service.provider], chat: chat.apiKey, embedding: embedding.apiKey };
      if (service.legacy) {
        const { kind, endpointId, selected: isSelected } = service.legacy;
        if (isSelected) next.provider_touchpoint_api_keys['custom-openai'] = { ...next.provider_touchpoint_api_keys['custom-openai'], [kind]: '' };
        const endpoints = next.desktop?.custom_endpoints?.[kind];
        if (endpoints) next.desktop.custom_endpoints[kind] = endpoints.map((entry: { id?: string }) => entry.id === endpointId ? { ...entry, apiKey: '' } : entry);
      }
    }
    if (active.includes(config.embedding_model) && old && JSON.stringify(serviceConnection(old, old.legacy?.kind ?? 'embedding')) !== JSON.stringify(serviceConnection(service, service.legacy?.kind ?? 'embedding')) && serviceConnection(old, old.legacy?.kind ?? 'embedding').baseUrl !== serviceConnection(service, service.legacy?.kind ?? 'embedding').baseUrl) throw new Error('该平台仍在使用。请添加新平台后切换用途，避免隐式更换向量空间');
    if (!service.enabled) continue;
    if (old && old.baseUrl === service.baseUrl && old.apiKey === service.apiKey && old.enabled === service.enabled && JSON.stringify(old.connections) === JSON.stringify(service.connections) && (!service.provider.startsWith('service-') || config.provider_base_urls?.[service.provider])) continue;
    next.provider_base_urls[service.provider] = service.baseUrl.replace(/\/+$/, '');
    const chat = serviceConnection(service, 'chat'); const embedding = serviceConnection(service, 'embedding');
    next.provider_touchpoint_base_urls[service.provider] = { ...next.provider_touchpoint_base_urls[service.provider], chat: chat.baseUrl, embedding: embedding.baseUrl };
    next.provider_touchpoint_api_keys[service.provider] = { ...next.provider_touchpoint_api_keys[service.provider], chat: chat.apiKey, embedding: embedding.apiKey };
    if (service.legacy) {
      const { kind, endpointId, selected: isSelected } = service.legacy;
      if (isSelected) {
        next.provider_touchpoint_base_urls['custom-openai'] = { ...next.provider_touchpoint_base_urls['custom-openai'], [kind]: service.baseUrl };
        next.provider_touchpoint_api_keys['custom-openai'] = { ...next.provider_touchpoint_api_keys['custom-openai'], [kind]: service.apiKey };
      }
      const endpoints = next.desktop?.custom_endpoints?.[kind];
      if (endpoints) next.desktop.custom_endpoints[kind] = endpoints.map((entry: any) => entry.id === endpointId ? { ...entry, displayName: service.name, baseUrl: service.baseUrl, apiKey: service.apiKey } : entry);
    }
  }
  for (const old of (config.desktop?.model_services ?? []) as ModelService[]) {
    if (services.some(item => item.id === old.id)) continue;
    const kindValues = old.legacy?.kind === 'embedding'
      ? [config.embedding_model]
      : [config.chat_model, config.ocr_model, config.expansion_model, config.embedding_image_ocr_model, ...(config.chat_fallback_chain ?? []), ...Object.entries(config).filter(([key]) => key.startsWith('models.')).map(([, value]) => value)];
    const legacyInUse = Boolean(old.legacy?.selected) && kindValues.some(value => typeof value === 'string' && value.startsWith('custom-openai:'));
    const stillUsed = legacyInUse || selected.some(value => value.startsWith(`${old.provider}:`)) || old.models?.some(model => selected.includes(serviceModelValue(old, model)));
    if (stillUsed) throw new Error('不能移除正在使用的模型平台');
    if (!isCustomProvider(old)) continue;
    delete next.provider_base_urls[old.provider];
    delete next.provider_touchpoint_api_keys[old.provider];
    delete next.provider_touchpoint_base_urls[old.provider];
    const endpoints = old.legacy && next.desktop?.custom_endpoints?.[old.legacy.kind];
    if (old.legacy && endpoints) next.desktop.custom_endpoints[old.legacy.kind] = endpoints.filter((entry: { id?: string }) => entry.id !== old.legacy?.endpointId);
  }
  next.desktop = { ...next.desktop, model_services: services };
  return next;
}
export function saveModelServices(input: ModelServicesState): ModelServicesState {
  const config = rawConfig();
  assertModelRevision(config, input?.revision);
  const baseline = readModelServices();
  const next = projectModelServices({ ...config, desktop: { ...config.desktop, model_services: baseline.services } }, input.services);
  backupFile(desktopConfigPath(), 'config');
  writeJsonConfig(desktopConfigPath(), next);
  return readModelServices();
}

/** Persist the model catalog. Reload the running gateway only when keys or addresses changed. */
export async function saveModelServicesLive(input: ModelServicesState, reloadRuntime: () => Promise<void>): Promise<ModelServicesState> {
  const before = rawConfig();
  const saved = saveModelServices(input);
  if (modelServiceRuntimeChanged(before, rawConfig())) await reloadRuntime();
  return saved;
}
export { syncServiceModels } from './model-service-sync.js';
