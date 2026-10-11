import { getRecipe } from '../../../../src/core/ai/recipes/index.js';
import { newServiceModel, serviceConnection, serviceNeedsApiKey, type ModelService, type ModelSyncResult, type ServiceModel } from '../../../../shared/model-services.js';

export function requiresServiceKey(service: ModelService, address = service.baseUrl): boolean {
  return serviceNeedsApiKey(service.provider, address);
}
function classify(record: any, id: string): ServiceModel['kind'] {
  const declared = record.type ?? record.task ?? record.model_type;
  const methods = record.supportedGenerationMethods;
  if (/embed|bge[-/]|e5[-/]|nomic-embed/i.test(id) || /embed/i.test(declared ?? '') || methods?.includes('embedContent')) return 'embedding';
  if (/rerank|image|audio|speech|transcri/i.test(declared ?? '') || /rerank|whisper|tts-|dall-e|stable-diffusion/i.test(id)) return 'unknown';
  return 'chat';
}
function enrichRemoteModel(provider: string, id: string, record: any): ServiceModel {
  const model = newServiceModel(id, classify(record, id));
  const chat = getRecipe(provider)?.touchpoints.chat;
  const known = model.kind === 'chat' && chat?.models.includes(id) ? chat : undefined;
  const modalities = record.input_modalities ?? record.architecture?.input_modalities;
  const capabilities = Array.isArray(record.capabilities) ? record.capabilities : undefined;
  const parameters = Array.isArray(record.supported_parameters) ? record.supported_parameters : undefined;
  const vision = Array.isArray(modalities) ? modalities.includes('image') : capabilities ? capabilities.includes('vision') : Boolean(known?.supports_vision && (!known.vision_models || known.vision_models.includes(id)));
  const tools = parameters ? parameters.includes('tools') : capabilities ? capabilities.includes('tools') : known?.supports_tools;
  const reasoning = Array.isArray(record.effort?.supported_levels) ? record.effort.supported_levels.length > 0 : parameters ? parameters.includes('reasoning') : capabilities?.includes('reasoning');
  if (vision) model.capabilities.push('vision');
  if (tools) model.capabilities.push('tools');
  if (reasoning) model.capabilities.push('reasoning');
  if (capabilities?.includes('web')) model.capabilities.push('web');
  const dimensions = record.dimensions ?? record.embedding_length;
  if (Number.isInteger(dimensions) && dimensions > 0) model.dimensions = dimensions;
  const context = record.context_window ?? record.context_length ?? record.inputTokenLimit ?? known?.max_context_tokens;
  if (Number.isInteger(context) && context > 0) model.contextWindow = context;
  if (known?.cost_per_1m_input_usd !== undefined) model.inputPrice = known.cost_per_1m_input_usd;
  if (known?.cost_per_1m_output_usd !== undefined) model.outputPrice = known.cost_per_1m_output_usd;
  return model;
}
export async function syncServiceModels(service: ModelService, fetchImpl: typeof fetch = fetch, kind: 'chat' | 'embedding' = 'chat'): Promise<ModelSyncResult> {
  const connection = serviceConnection(service, kind);
  let url: URL;
  try { url = new URL(connection.baseUrl.trim()); } catch { throw new Error('请填写完整的 API 地址，例如 http://localhost:1234/v1'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址只支持不含账号和查询参数的 HTTP(S) 地址');
  if (!getRecipe(service.provider)) throw new Error('不支持的模型平台');
  const key = connection.apiKey.trim();
  if (requiresServiceKey(service, url.href) && !key) throw new Error(`${service.name} 尚未配置 API 密钥。请填写密钥后再同步模型。`);
  const base = url.href.replace(/\/+$/, '');
  const ollama = service.provider === 'ollama';
  const root = ollama ? base.replace(/\/v1$/i, '') : base;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (service.provider === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; if (key) headers['x-api-key'] = key; }
  else if (service.provider === 'google') { if (key) headers['x-goog-api-key'] = key; }
  else if (key) headers.Authorization = `Bearer ${key}`;
  const request = async (target: string, init: RequestInit = {}) => {
    let response: Response;
    try { response = await fetchImpl(target, { ...init, headers: { ...headers, ...init.headers }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error('拉取模型失败。无法连接到服务，请检查 API 地址和网络'); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('拉取模型失败。API 密钥无效，请检查后重新配置');
      if (response.status === 404) throw new Error('拉取模型失败。请检查 API 地址。这个服务可能不提供模型列表，可以手动添加模型');
      if (response.status === 429) throw new Error('拉取模型失败。请求过于频繁或额度不足，请稍后再试');
      throw new Error('拉取模型失败。请检查服务商状态后重试');
    }
    try { return await response.json() as any; } catch { throw new Error('拉取模型失败。平台返回的内容无法识别，请检查 API 地址'); }
  };
  const warnings: string[] = [];
  const records: any[] = [];
  let next = `${root}/${ollama ? 'api/tags' : 'models'}`;
  for (let page = 0; next && page < 50; page++) {
    const body = await request(next);
    const list = ollama || service.provider === 'google' ? body.models : Array.isArray(body) ? body : body.data;
    if (!Array.isArray(list)) throw new Error('平台未返回有效模型列表，请检查 API 地址；也可以手动添加模型');
    records.push(...list);
    next = service.provider === 'google' && body.nextPageToken ? `${root}/models?pageToken=${encodeURIComponent(body.nextPageToken)}` : service.provider === 'anthropic' && body.has_more && body.last_id ? `${root}/models?after_id=${encodeURIComponent(body.last_id)}` : '';
    if (page === 49 && next) warnings.push('模型列表超过 50 页，已停止继续读取。');
  }
  if (service.provider === 'openrouter') {
    try { const body = await request(`${root}/embeddings/models`); if (Array.isArray(body.data)) records.push(...body.data.map((r: any) => ({ ...r, type: 'embedding' }))); }
    catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
  }
  const unique = [...new Map(records.filter(r => r && typeof (r.id ?? r.name ?? r.model) === 'string').map(r => {
    const id = String(r.id ?? r.name ?? r.model);
    return [service.provider === 'google' ? id.replace(/^models\//, '') : id, r];
  })).entries()];
  const models: ServiceModel[] = new Array(unique.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, unique.length) }, async () => {
    while (cursor < unique.length) {
      const index = cursor++; const [id, record] = unique[index];
      const model = ollama ? newServiceModel(id, classify(record, id)) : enrichRemoteModel(service.provider, id, record);
      model.name = record.displayName ?? record.display_name ?? record.name ?? id;
      if (ollama) {
        try {
          const detail = await request(`${root}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: id }) });
          const capabilities = Array.isArray(detail.capabilities) ? detail.capabilities : [];
          model.kind = capabilities.includes('embedding') ? 'embedding' : capabilities.includes('completion') ? 'chat' : 'unknown';
          if (model.kind === 'unknown') warnings.push(`${id} 未提供模型能力，请在模型设置中确认类型。`);
          for (const [source, target] of [['vision', 'vision'], ['thinking', 'reasoning'], ['tools', 'tools']] as const) if (capabilities.includes(source)) model.capabilities.push(target);
          for (const [field, value] of Object.entries(detail.model_info ?? {})) {
            if (typeof value !== 'number' || value <= 0) continue;
            if (field.endsWith('.context_length')) model.contextWindow = value;
            if (field.endsWith('.embedding_length') && model.kind === 'embedding') model.dimensions = value;
          }
        } catch (error) { model.kind = 'unknown'; warnings.push(`${id}：${error instanceof Error ? error.message : String(error)} 请手动确认模型类型。`); }
      }
      models[index] = model;
    }
  }));
  if (!models.length) warnings.push(ollama ? 'Ollama 已连接，但没有已安装的模型，请先在 Ollama 安装模型。' : '平台返回了空模型列表，可手动添加平台提供的模型 ID。');
  return { models, warnings };
}
