import { filterSupportedModels, type OpenAICodexModelCache, type OpenAICodexModelMetadata } from './model-cache.ts';
import { redactTokenLike } from './token-store.ts';

export type OpenAICodexFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DiscoverOpenAICodexModelsOptions {
  endpoint: string;
  accessToken: string;
  accountId?: string;
  fetch?: OpenAICodexFetch;
  now?: () => Date;
  clientVersion?: string;
}

function responseHeader(response: Response, name: string): string | undefined {
  const value = response.headers.get(name);
  return value === null ? undefined : value;
}

function asModelList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.data)) return v.data;
    if (Array.isArray(v.models)) return v.models;
  }
  throw new Error('openai-codex model discovery response must be an array or contain data/models array');
}

function normalizeModel(value: unknown): OpenAICodexModelMetadata {
  if (!value || typeof value !== 'object') throw new Error('openai-codex model entry must be an object');
  const v = value as Record<string, unknown>;
  const slug = typeof v.slug === 'string' ? v.slug : (typeof v.id === 'string' ? v.id : undefined);
  if (!slug) throw new Error('openai-codex model entry missing slug');
  if (typeof v.supported_in_api !== 'boolean') throw new Error(`openai-codex model ${slug} missing supported_in_api`);
  const { id: _id, name: _name, ...rest } = v;
  return {
    ...rest,
    slug,
    supported_in_api: v.supported_in_api,
    ...(typeof v.display_name === 'string'
      ? { display_name: v.display_name }
      : (typeof v.name === 'string' ? { display_name: v.name } : {})),
    ...(typeof v.context_window === 'number' ? { context_window: v.context_window } : {}),
    ...(typeof v.max_output_tokens === 'number' ? { max_output_tokens: v.max_output_tokens } : {}),
    ...(Array.isArray(v.supported_reasoning_levels) && v.supported_reasoning_levels.every(x => typeof x === 'string')
      ? { supported_reasoning_levels: v.supported_reasoning_levels }
      : {}),
    ...(Array.isArray(v.service_tiers) && v.service_tiers.every(x => typeof x === 'string')
      ? { service_tiers: v.service_tiers }
      : {}),
  } as OpenAICodexModelMetadata;
}

export async function discoverOpenAICodexModels(opts: DiscoverOpenAICodexModelsOptions): Promise<OpenAICodexModelCache> {
  const transport = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  let response: Response;
  try {
    response = await transport(opts.endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
        Accept: 'application/json',
        'User-Agent': opts.clientVersion ? `codex-cli/${opts.clientVersion}` : 'codex-cli',
        ...(opts.accountId ? { 'ChatGPT-Account-Id': opts.accountId } : {}),
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to discover openai-codex models: ${redactTokenLike(msg)}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to discover openai-codex models: HTTP ${response.status}: ${redactTokenLike(text)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse openai-codex model discovery response: ${redactTokenLike(msg)}`);
  }

  const rawModels = asModelList(parsed).map(normalizeModel);
  const supported = filterSupportedModels(rawModels);
  return {
    schema_version: 1,
    fetched_at: now().toISOString(),
    ...(opts.clientVersion ? { client_version: opts.clientVersion } : {}),
    ...(responseHeader(response, 'etag') ? { etag: responseHeader(response, 'etag') } : {}),
    raw_count: rawModels.length,
    supported_count: supported.length,
    models: supported,
  };
}
