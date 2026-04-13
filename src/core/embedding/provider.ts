import type { EmbeddingProvider as EmbeddingProviderMode, GBrainConfig } from '../config.ts';

const DEFAULT_LOCAL_MODEL = 'nomic-embed-text';
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

export interface EmbeddingProviderCapability {
  mode: EmbeddingProviderMode;
  available: boolean;
  implementation: 'none' | 'local-http' | 'test-local';
  model: string | null;
  dimensions: number | null;
  reason?: string;
}

export interface ResolvedEmbeddingProvider {
  capability: EmbeddingProviderCapability;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export interface ResolveEmbeddingProviderOptions {
  config?: GBrainConfig | null;
}

export function resolveEmbeddingProvider(
  opts: ResolveEmbeddingProviderOptions = {},
): ResolvedEmbeddingProvider {
  const config = opts.config ?? null;
  const mode: EmbeddingProviderMode = config?.embedding_provider ?? 'none';
  const localProvider = resolveLocalProvider(mode);
  if (localProvider) {
    return localProvider;
  }

  return unavailableProvider({
    mode,
    available: false,
    implementation: 'none',
    model: null,
    dimensions: null,
    reason: mode === 'local'
      ? 'Local embedding runtime is not configured. Set OLLAMA_HOST or GBRAIN_LOCAL_EMBEDDING_URL.'
      : 'Embedding provider is disabled (embedding_provider=\"none\").',
  });
}

function resolveLocalProvider(mode: EmbeddingProviderMode): ResolvedEmbeddingProvider | null {
  if (mode !== 'local') return null;

  const configuredUrl = resolveLocalEmbeddingUrl();
  const configuredModel = process.env.GBRAIN_LOCAL_EMBEDDING_MODEL || DEFAULT_LOCAL_MODEL;
  const configuredDimensions = parsePositiveInt(process.env.GBRAIN_LOCAL_EMBEDDING_DIMENSIONS);

  return {
    capability: {
      mode,
      available: true,
      implementation: 'local-http',
      model: configuredModel,
      dimensions: configuredDimensions,
    },
    embedBatch: async (texts: string[]) => {
      const response = await fetch(configuredUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: configuredModel,
          input: texts,
        }),
      });

      if (!response.ok) {
        throw new Error(`Local embedding runtime returned ${response.status} ${response.statusText}`);
      }

      const payload = await response.json() as {
        embeddings?: number[][];
        data?: Array<{ embedding?: number[] }>;
      };

      const embeddings = Array.isArray(payload.embeddings)
        ? payload.embeddings
        : Array.isArray(payload.data)
          ? payload.data.map(item => item.embedding ?? [])
          : [];

      if (embeddings.length !== texts.length || embeddings.some(vector => vector.length === 0)) {
        throw new Error('Local embedding runtime returned an unexpected embedding payload');
      }

      return embeddings.map(vector => new Float32Array(vector));
    },
  };
}

function resolveLocalEmbeddingUrl(): string {
  const configured = process.env.GBRAIN_LOCAL_EMBEDDING_URL;
  if (configured) return configured;

  const ollamaHost = process.env.OLLAMA_HOST;
  if (ollamaHost) {
    return new URL('/api/embed', withTrailingSlash(ollamaHost)).toString();
  }

  return new URL('/api/embed', withTrailingSlash(DEFAULT_OLLAMA_HOST)).toString();
}

function unavailableProvider(capability: EmbeddingProviderCapability): ResolvedEmbeddingProvider {
  return {
    capability,
    embedBatch: async () => {
      throw new Error(capability.reason || 'Embedding provider unavailable');
    },
  };
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}
