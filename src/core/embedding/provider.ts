import type { EmbeddingProvider as EmbeddingProviderMode, MBrainConfig } from '../config.ts';

export const DEFAULT_LOCAL_EMBEDDING_MODEL = 'qwen3-embedding:0.6b';
export const DEFAULT_LOCAL_EMBEDDING_DIMENSIONS = 1024;
export const QWEN3_QUERY_INSTRUCTION =
  'Given a question or search query, retrieve the most relevant MBrain memory chunks.';

const DEFAULT_LLAMA_CPP_HOST = 'http://127.0.0.1:8080';
const DEFAULT_MLX_HOST = 'http://127.0.0.1:8765';
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
  return typeof model === 'string' && model.toLowerCase().startsWith('nomic-embed-text');
}

export function modelUsesQwen3QueryInstruction(model: string | null | undefined): boolean {
  return typeof model === 'string' && model.toLowerCase().startsWith('qwen3-embedding');
}

export function defaultEmbeddingDimensionsForModel(model: string | null | undefined): number | null {
  const normalized = model?.toLowerCase() ?? '';
  if (modelUsesQwen3QueryInstruction(normalized)) return DEFAULT_LOCAL_EMBEDDING_DIMENSIONS;
  if (modelUsesNomicTaskPrefixes(normalized)) return 768;
  if (normalized.startsWith('embeddinggemma')) return 768;
  if (normalized.startsWith('granite-embedding')) return 768;
  if (normalized.startsWith('bge-m3')) return 1024;
  if (normalized.startsWith('mxbai-embed-large')) return 1024;
  return null;
}

export function defaultLocalEmbeddingUrlForPlatform(platform: string = process.platform): string {
  const host = platform === 'darwin'
    ? DEFAULT_MLX_HOST
    : DEFAULT_LLAMA_CPP_HOST;
  return new URL('/v1/embeddings', withTrailingSlash(host)).toString();
}

export function prepareEmbeddingInputForModel(
  text: string,
  kind: 'document' | 'query',
  model: string | null | undefined,
): string {
  if (modelUsesNomicTaskPrefixes(model)) {
    return kind === 'document'
      ? `search_document: ${text}`
      : `search_query: ${text}`;
  }

  if (kind === 'query' && modelUsesQwen3QueryInstruction(model)) {
    return `Instruct: ${QWEN3_QUERY_INSTRUCTION}\nQuery: ${text}`;
  }

  return text;
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
      ? 'Local embedding runtime is not configured. Set MBRAIN_LLAMA_CPP_HOST or MBRAIN_LOCAL_EMBEDDING_URL.'
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
    || DEFAULT_LOCAL_EMBEDDING_MODEL;
  const configuredDimensions = parsePositiveInt(process.env.MBRAIN_LOCAL_EMBEDDING_DIMENSIONS)
    ?? defaultEmbeddingDimensionsForModel(configuredModel);
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
          const detail = await readEmbeddingErrorDetail(response);
          throw new Error(formatLocalEmbeddingHttpError(
            response.status,
            response.statusText,
            configuredUrl,
            configuredModel,
            detail,
          ));
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
        if (isFetchConnectionError(error)) {
          throw new Error(formatLocalEmbeddingConnectionError(
            configuredUrl,
            configuredModel,
            error,
          ));
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

  const llamaCppHost = process.env.MBRAIN_LLAMA_CPP_HOST;
  if (llamaCppHost) {
    return new URL('/v1/embeddings', withTrailingSlash(llamaCppHost)).toString();
  }

  const ollamaHost = process.env.OLLAMA_HOST;
  if (ollamaHost) {
    return new URL('/api/embed', withTrailingSlash(ollamaHost)).toString();
  }

  return defaultLocalEmbeddingUrlForPlatform();
}

function unavailableProvider(capability: EmbeddingProviderCapability): ResolvedEmbeddingProvider {
  return {
    capability,
    embedBatch: async () => {
      throw new Error(capability.reason || 'Embedding provider unavailable');
    },
  };
}

async function readEmbeddingErrorDetail(response: Response): Promise<string | null> {
  try {
    const raw = await response.text();
    if (!raw.trim()) return null;

    try {
      const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
      if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
      if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
    } catch {
      // Fall back to the raw text body below.
    }

    return raw.trim();
  } catch {
    return null;
  }
}

function formatLocalEmbeddingHttpError(
  status: number,
  statusText: string,
  url: string,
  model: string,
  detail: string | null,
): string {
  const base = `Local embedding runtime returned ${status} ${statusText}`;
  const suffix = detail ? `: ${detail}` : '';
  const hint = shouldSuggestMlxStart(url, status, detail)
    ? ' Start an MLX embedding server on http://127.0.0.1:8765/v1/embeddings or set MBRAIN_LOCAL_EMBEDDING_URL.'
    : shouldSuggestLlamaCppStart(url, status, detail)
    ? ' Start llama.cpp embedding server: scripts/run-qwen3-llamacpp-embedding-cpu.sh'
    : shouldSuggestOllamaPull(url, status, detail)
    ? ` Run: ollama pull ${model}`
    : '';
  return `${base}${suffix}${hint}`;
}

function formatLocalEmbeddingConnectionError(
  url: string,
  model: string,
  error: TypeError,
): string {
  const hint = shouldSuggestLlamaCppStart(url, 0, null)
    ? ' Start llama.cpp embedding server: scripts/run-qwen3-llamacpp-embedding-cpu.sh'
    : shouldSuggestMlxStart(url, 0, null)
    ? ' Start an MLX embedding server on http://127.0.0.1:8765/v1/embeddings or set MBRAIN_LOCAL_EMBEDDING_URL.'
    : isLikelyOllamaEmbedUrl(url)
    ? ` Start Ollama or run: ollama pull ${model}`
    : '';
  return `Local embedding runtime is unreachable at ${url}: ${error.message}.${hint}`;
}

function shouldSuggestMlxStart(url: string, status: number, detail: string | null): boolean {
  if (!isDefaultMlxEmbeddingUrl(url)) return false;
  if (status === 0 || status === 404 || status === 405) return true;

  const normalized = detail?.toLowerCase() ?? '';
  return normalized.includes('embedding') || normalized.includes('model');
}

function shouldSuggestLlamaCppStart(url: string, status: number, detail: string | null): boolean {
  if (isDefaultMlxEmbeddingUrl(url)) return false;
  if (!isLikelyLlamaCppEmbeddingUrl(url)) return false;
  if (status === 0 || status === 404 || status === 405) return true;

  const normalized = detail?.toLowerCase() ?? '';
  return normalized.includes('embedding') || normalized.includes('pooling');
}

function shouldSuggestOllamaPull(url: string, status: number, detail: string | null): boolean {
  if (!isLikelyOllamaEmbedUrl(url)) return false;
  if (status === 404) return true;

  const normalized = detail?.toLowerCase() ?? '';
  return normalized.includes('not found') || normalized.includes('pull');
}

function isLikelyOllamaEmbedUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/api/embed');
  } catch {
    return false;
  }
}

function isLikelyLlamaCppEmbeddingUrl(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/v1/embeddings');
  } catch {
    return false;
  }
}

function isDefaultMlxEmbeddingUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const defaultMlx = new URL(defaultLocalEmbeddingUrlForPlatform('darwin'));
    return parsed.hostname === defaultMlx.hostname
      && parsed.port === defaultMlx.port
      && parsed.pathname === defaultMlx.pathname;
  } catch {
    return false;
  }
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

function isFetchConnectionError(error: unknown): error is TypeError {
  return error instanceof TypeError;
}
