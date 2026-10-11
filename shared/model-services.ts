export type ModelCapability = 'vision' | 'reasoning' | 'tools' | 'web';
export interface ServiceModel {
  id: string;
  name: string;
  group: string;
  kind: 'chat' | 'embedding' | 'unknown';
  capabilities: ModelCapability[];
  contextWindow?: number;
  inputPrice?: number;
  outputPrice?: number;
  inputPriceCny?: number;
  outputPriceCny?: number;
  dimensions?: number;
  typeOverride?: boolean;
}
export interface ModelService {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
  models: ServiceModel[];
  connections?: Partial<Record<'chat' | 'embedding', { baseUrl: string; apiKey: string }>>;
  legacy?: { kind: 'chat' | 'embedding'; endpointId: string; selected: boolean };
}
export interface ModelSyncResult { models: ServiceModel[]; warnings: string[] }
export function serviceConnection(service: ModelService, kind: 'chat' | 'embedding' = 'chat') {
  return service.connections?.[kind] ?? { baseUrl: service.baseUrl, apiKey: service.apiKey };
}
export interface ModelServicesState { services: ModelService[]; revision: string }
export function mergeServiceModels(existing: ServiceModel[], incoming: ServiceModel[]): ServiceModel[] {
  const models = new Map(existing.map(model => [model.id, model]));
  for (const model of incoming) {
    const old = models.get(model.id);
    models.set(model.id, old ? { ...model, ...old, kind: old.typeOverride || model.kind === 'unknown' ? old.kind : model.kind, capabilities: old.capabilities.length ? old.capabilities : model.capabilities } : model);
  }
  return [...models.values()];
}
export const SERVICE_PRESETS = [
  ['ollama', 'Ollama', 'http://localhost:11434/v1'],
  ['deepseek', '深度求索', 'https://api.deepseek.com/v1'],
  ['service-siliconflow', '硅基流动', 'https://api.siliconflow.cn/v1'],
  ['zhipu', '智谱开放平台', 'https://open.bigmodel.cn/api/paas/v4'],
  ['service-dmxapi', 'DMXAPI', 'https://www.dmxapi.cn/v1'],
  ['service-qiniu', '七牛云 AI 推理', 'https://api.qnaigc.com/v1'],
  ['service-lmstudio', 'LM Studio', 'http://localhost:1234/v1'],
  ['service-moonshot', '月之暗面', 'https://api.moonshot.cn/v1'],
  ['service-baichuan', '百川', 'https://api.baichuan-ai.com/v1'],
  ['mimo', '小米 MiMo', 'https://api.xiaomimimo.com/v1'],
  ['openai', 'OpenAI', 'https://api.openai.com/v1'],
  ['anthropic', 'Anthropic', 'https://api.anthropic.com/v1'],
  ['google', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta'],
  ['openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1'],
  ['dashscope', '阿里云百炼', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
  ['minimax', 'MiniMax', 'https://api.minimaxi.com/v1'],
  ['groq', 'Groq', 'https://api.groq.com/openai/v1'],
  ['together', 'Together AI', 'https://api.together.xyz/v1'],
  ['voyage', 'Voyage AI', 'https://api.voyageai.com/v1'],
] as const;
export function presetBaseUrl(provider: string): string | undefined {
  return SERVICE_PRESETS.find(([id]) => id === provider)?.[2];
}
export function newServiceModel(id: string, kind: ServiceModel['kind'] = 'chat'): ServiceModel {
  return { id, name: id, kind, group: id.split('/')[0].split(':')[0], capabilities: [] };
}
const PRESET_PROVIDER_IDS = new Set<string>(SERVICE_PRESETS.map(([id]) => id));
export function isCustomProvider(service: Pick<ModelService, 'id' | 'provider'>): boolean {
  return !PRESET_PROVIDER_IDS.has(service.id) && !PRESET_PROVIDER_IDS.has(service.provider);
}
export function providerKindLabel(service: Pick<ModelService, 'id' | 'provider'>): string {
  return isCustomProvider(service) ? '自定义服务商' : '模型服务';
}
export function configuredProvidersFirst<T extends { enabled: boolean }>(services: T[]): T[] {
  return services.map((service, index) => ({ service, index })).sort((left, right) => Number(right.service.enabled) - Number(left.service.enabled) || left.index - right.index).map(item => item.service);
}
export function serviceModelSections(models: ServiceModel[]): Array<{ group: string | null; models: ServiceModel[] }> {
  const label = (model: ServiceModel) => model.group || '其他模型';
  const counts = new Map<string, number>();
  for (const model of models) counts.set(label(model), (counts.get(label(model)) ?? 0) + 1);
  const emitted = new Set<string>();
  const sections: Array<{ group: string | null; models: ServiceModel[] }> = [];
  for (const model of models) {
    const group = label(model);
    const auto = model.id.split('/')[0].split(':')[0] || model.id;
    const shared = (counts.get(group) ?? 0) > 1;
    const namedByUser = group !== model.id && group !== model.name && group !== auto && group !== '其他模型';
    if (!shared && !namedByUser) {
      const last = sections.at(-1);
      if (last?.group === null) last.models.push(model);
      else sections.push({ group: null, models: [model] });
      continue;
    }
    if (emitted.has(group)) continue;
    emitted.add(group);
    sections.push({ group, models: models.filter(item => label(item) === group) });
  }
  return sections;
}
export function serviceModelValue(service: ModelService, model: ServiceModel): string {
  return `${service.legacy?.selected && service.legacy.kind === model.kind ? 'custom-openai' : service.provider}:${model.id}`;
}
export function availableServiceModels(services: ModelService[], kind: ServiceModel['kind']) {
  return services.filter(service => service.enabled).flatMap(service => service.models.filter(model => model.kind === kind).map(model => ({ value: serviceModelValue(service, model), label: `${model.name} · ${service.name}`, model, service })));
}
export type ServiceModelFilter = 'all' | ServiceModel['kind'];
export function serviceNeedsApiKey(provider: string, baseUrl: string): boolean {
  if (provider === 'ollama') return false;
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return false;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  } catch {
    return true;
  }
  return true;
}
export const SERVICE_KEY_PAGES: Record<string, string> = {
  deepseek: 'https://platform.deepseek.com/api_keys',
  'service-siliconflow': 'https://cloud.siliconflow.cn/account/ak',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  google: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/keys',
  'service-moonshot': 'https://platform.moonshot.cn/console/api-keys',
  groq: 'https://console.groq.com/keys',
};
export function serviceEndpointError(service: { name: string; baseUrl: string }): string | null {
  try {
    const url = new URL(service.baseUrl.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return `${service.name}：API 地址必须为不含账号、查询参数的 HTTP(S) 地址`;
  } catch { return `${service.name}：请填写完整的 API 地址，例如 http://localhost:1234/v1`; }
  return null;
}
export function listedServiceModels(models: ServiceModel[], query: string, filter: ServiceModelFilter = 'all'): ServiceModel[] {
  const text = query.trim().toLowerCase();
  return models.filter(model => (filter === 'all' || model.kind === filter) && (!text || `${model.name} ${model.id}`.toLowerCase().includes(text)));
}
export function serviceModelsNotOnRemote(local: ServiceModel[], remote: ServiceModel[]): ServiceModel[] {
  const ids = new Set(remote.map(model => model.id));
  return local.filter(model => !ids.has(model.id));
}
