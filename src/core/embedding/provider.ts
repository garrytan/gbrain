import type { EmbeddingProvider as EmbeddingProviderMode, MBrainConfig } from '../config.ts';

const DEFAULT_LOCAL_MODEL = 'nomic-embed-text';
const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
const DEFAULT_LOCAL_EMBED_TIMEOUT_MS = 300_000;

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
  config?: MBrainConfig | null;
}

export function modelUsesNomicTaskPrefixes(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.startsWith('nomic-embed-text');
}

export function resolveEmbeddingProvider(
  opts: ResolveEmbeddingProviderOptions = {},
): ResolvedEmbeddingProvider {
  const config = opts.config ?? null;
  const mode: EmbeddingProviderMode = config?.embedding_provider ?? 'none';
  const localProvider = resolveLocalProvider(mode, config);
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
      ? 'Local embedding runtime is not configured. Set OLLAMA_HOST or MBRAIN_LOCAL_EMBEDDING_URL.'
      : 'Embedding provider is disabled (embedding_provider=\"none\").',
  });
}

function resolveLocalProvider(
  mode: EmbeddingProviderMode,
  config: MBrainConfig | null,
): ResolvedEmbeddingProvider | null {
  if (mode !== 'local') return null;

  const configuredUrl = resolveLocalEmbeddingUrl();
  const configuredModel = process.env.MBRAIN_LOCAL_EMBEDDING_MODEL
    || config?.embedding_model
    || DEFAULT_LOCAL_MODEL;
  const configuredDimensions = parsePositiveInt(process.env.MBRAIN_LOCAL_EMBEDDING_DIMENSIONS);
  const configuredTimeoutMs = parsePositiveInt(process.env.MBRAIN_EMBED_TIMEOUT_MS)
    ?? DEFAULT_LOCAL_EMBED_TIMEOUT_MS;

  return {
    capability: {
      mode,
      available: true,
      implementation: 'local-http',
      model: configuredModel,
      dimensions: configuredDimensions,
    },
    embedBatch: async (texts: string[]) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), configuredTimeoutMs);
      let payload: {
        embeddings?: number[][];
        data?: Array<{ embedding?: number[] }>;
      } | null = null;

      try {
        const response = await fetch(configuredUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            model: configuredModel,
            input: texts,
          }),
        });

        if (!response.ok) {
          throw new Error(`Local embedding runtime returned ${response.status} ${response.statusText}`);
        }

        payload = await response.json() as {
          embeddings?: number[][];
          data?: Array<{ embedding?: number[] }>;
        };
      } catch (error: unknown) {
        if (controller.signal.aborted || isAbortError(error)) {
          throw new Error(
            `Local embedding runtime timed out after ${configuredTimeoutMs}ms ` +
            `(url ${configuredUrl}, model ${configuredModel}, batch size ${texts.length}). ` +
            'Set MBRAIN_EMBED_TIMEOUT_MS to adjust.',
          );
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }

      if (!payload) {
        throw new Error('Local embedding runtime returned an unexpected embedding payload');
      }

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
  const configured = process.env.MBRAIN_LOCAL_EMBEDDING_URL;
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
