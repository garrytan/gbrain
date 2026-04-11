export type EmbeddingProviderName = 'openai' | 'venice';

export interface EmbeddingProviderConfig {
  embedding_provider?: EmbeddingProviderName;
  openai_api_key?: string;
  openai_base_url?: string;
  venice_api_key?: string;
  venice_base_url?: string;
}

export interface ResolvedEmbeddingProvider {
  provider: EmbeddingProviderName;
  apiKey: string;
  baseURL?: string;
  model: string;
  dimensions: number;
}

const OPENAI_MODEL = 'text-embedding-3-large';
const VENICE_MODEL = 'text-embedding-bge-m3';
const DEFAULT_DIMENSIONS = 1536;
const DEFAULT_VENICE_BASE_URL = 'https://api.venice.ai/api/v1';

export function resolveEmbeddingProvider(
  config?: EmbeddingProviderConfig | null,
): ResolvedEmbeddingProvider | null {
  const provider = normalizeProvider(
    process.env.GBRAIN_EMBEDDING_PROVIDER ?? config?.embedding_provider,
  );
  const openaiApiKey = firstNonEmpty(process.env.OPENAI_API_KEY, config?.openai_api_key);
  const openaiBaseURL = firstNonEmpty(process.env.OPENAI_BASE_URL, config?.openai_base_url);
  const veniceApiKey = firstNonEmpty(process.env.VENICE_API_KEY, config?.venice_api_key);
  const veniceBaseURL = firstNonEmpty(
    process.env.VENICE_BASE_URL,
    config?.venice_base_url,
    DEFAULT_VENICE_BASE_URL,
  );

  if (provider === 'openai') {
    if (!openaiApiKey) return null;
    return {
      provider: 'openai',
      apiKey: openaiApiKey,
      baseURL: openaiBaseURL,
      model: OPENAI_MODEL,
      dimensions: DEFAULT_DIMENSIONS,
    };
  }

  if (provider === 'venice') {
    const key = veniceApiKey || openaiApiKey;
    if (!key) return null;
    return {
      provider: 'venice',
      apiKey: key,
      baseURL: isVeniceBaseUrl(openaiBaseURL) ? openaiBaseURL : veniceBaseURL,
      model: VENICE_MODEL,
      dimensions: DEFAULT_DIMENSIONS,
    };
  }

  if (isVeniceBaseUrl(openaiBaseURL) && openaiApiKey) {
    return {
      provider: 'venice',
      apiKey: openaiApiKey,
      baseURL: openaiBaseURL,
      model: VENICE_MODEL,
      dimensions: DEFAULT_DIMENSIONS,
    };
  }

  if (openaiApiKey) {
    return {
      provider: 'openai',
      apiKey: openaiApiKey,
      baseURL: openaiBaseURL,
      model: OPENAI_MODEL,
      dimensions: DEFAULT_DIMENSIONS,
    };
  }

  if (veniceApiKey) {
    return {
      provider: 'venice',
      apiKey: veniceApiKey,
      baseURL: veniceBaseURL,
      model: VENICE_MODEL,
      dimensions: DEFAULT_DIMENSIONS,
    };
  }

  return null;
}

export function hasEmbeddingProvider(config?: EmbeddingProviderConfig | null): boolean {
  return resolveEmbeddingProvider(config) !== null;
}

export function getEmbeddingModel(config?: EmbeddingProviderConfig | null): string {
  return resolveEmbeddingProvider(config)?.model || OPENAI_MODEL;
}

export function getEmbeddingDimensions(config?: EmbeddingProviderConfig | null): number {
  return resolveEmbeddingProvider(config)?.dimensions || DEFAULT_DIMENSIONS;
}

function normalizeProvider(value?: string | null): EmbeddingProviderName | undefined {
  if (value === 'openai' || value === 'venice') return value;
  return undefined;
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function isVeniceBaseUrl(value?: string | null): boolean {
  return typeof value === 'string' && value.includes('venice.ai');
}

export {
  DEFAULT_DIMENSIONS as DEFAULT_EMBEDDING_DIMENSIONS,
  OPENAI_MODEL as OPENAI_EMBEDDING_MODEL,
  VENICE_MODEL as VENICE_EMBEDDING_MODEL,
  DEFAULT_VENICE_BASE_URL as VENICE_BASE_URL,
};
