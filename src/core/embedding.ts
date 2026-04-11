import { loadConfig, type GBrainConfig } from './config.ts';
import type { ChunkInput } from './types.ts';
import type { ResolvedEmbeddingProvider } from './embedding/provider.ts';
import { resolveEmbeddingProvider } from './embedding/provider.ts';

const MAX_CHARS = 8000;
const BATCH_SIZE = 100;

export type {
  EmbeddingProviderCapability,
  ResolvedEmbeddingProvider,
} from './embedding/provider.ts';

export interface EmbeddingRuntimeOptions {
  config?: GBrainConfig | null;
  provider?: ResolvedEmbeddingProvider;
}

export interface EmbeddedChunkBatch {
  capability: ResolvedEmbeddingProvider['capability'];
  chunks: ChunkInput[];
  deferred: boolean;
}

let providerOverrideForTests: ResolvedEmbeddingProvider | null = null;

export function setEmbeddingProviderForTests(provider: ResolvedEmbeddingProvider): void {
  providerOverrideForTests = provider;
}

export function resetEmbeddingProviderForTests(): void {
  providerOverrideForTests = null;
}

export function getEmbeddingProvider(
  options: EmbeddingRuntimeOptions = {},
): ResolvedEmbeddingProvider {
  if (options.provider) return options.provider;
  if (providerOverrideForTests) return providerOverrideForTests;

  return resolveEmbeddingProvider({
    config: options.config ?? safeLoadConfig(),
  });
}

export function getEmbeddingRuntime(
  options: EmbeddingRuntimeOptions = {},
): ResolvedEmbeddingProvider['capability'] {
  return getEmbeddingProvider(options).capability;
}

export async function embed(text: string, options: EmbeddingRuntimeOptions = {}): Promise<Float32Array> {
  const results = await embedBatch([text], options);
  return results[0];
}

export async function embedBatch(
  texts: string[],
  options: EmbeddingRuntimeOptions = {},
): Promise<Float32Array[]> {
  const provider = getEmbeddingProvider(options);
  const truncated = texts.map(text => truncateForEmbedding(text));

  if (!provider.capability.available) {
    throw new Error(provider.capability.reason || 'Embedding provider unavailable');
  }

  const results: Float32Array[] = [];
  for (let index = 0; index < truncated.length; index += BATCH_SIZE) {
    const batch = truncated.slice(index, index + BATCH_SIZE);
    const batchResults = await provider.embedBatch(batch);
    if (batchResults.length !== batch.length) {
      throw new Error('Embedding provider returned an unexpected result count');
    }
    results.push(...batchResults);
  }

  return results;
}

export async function embedChunks(
  chunks: ChunkInput[],
  options: EmbeddingRuntimeOptions = {},
): Promise<EmbeddedChunkBatch> {
  const provider = getEmbeddingProvider(options);
  if (chunks.length === 0) {
    return { capability: provider.capability, chunks: [], deferred: false };
  }

  if (!provider.capability.available) {
    return {
      capability: provider.capability,
      chunks: chunks.map(chunk => ({
        ...chunk,
        token_count: chunk.token_count ?? estimateTokenCount(chunk.chunk_text),
      })),
      deferred: true,
    };
  }

  const embeddings = await embedBatch(
    chunks.map(chunk => chunk.chunk_text),
    { ...options, provider },
  );

  return {
    capability: provider.capability,
    deferred: false,
    chunks: chunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index],
      model: provider.capability.model ?? chunk.model,
      token_count: chunk.token_count ?? estimateTokenCount(chunk.chunk_text),
    })),
  };
}

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export const EMBEDDING_MODEL = 'text-embedding-3-large';
export const EMBEDDING_DIMENSIONS = 1536;

function truncateForEmbedding(text: string): string {
  return text.slice(0, MAX_CHARS);
}

function safeLoadConfig(): GBrainConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}
