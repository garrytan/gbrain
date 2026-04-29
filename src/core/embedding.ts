import { loadConfig, type MBrainConfig } from './config.ts';
import type { ChunkInput } from './types.ts';
import type { ResolvedEmbeddingProvider } from './embedding/provider.ts';
import { modelUsesNomicTaskPrefixes, resolveEmbeddingProvider } from './embedding/provider.ts';

const MAX_CHARS = 8000;
const DEFAULT_BATCH_SIZE = 100;

export type {
  EmbeddingProviderCapability,
  ResolvedEmbeddingProvider,
} from './embedding/provider.ts';

export interface EmbeddingRuntimeOptions {
  config?: MBrainConfig | null;
  provider?: ResolvedEmbeddingProvider;
  onBatchStart?: (progress: EmbeddingBatchProgress) => void;
  onBatchComplete?: (progress: EmbeddingBatchProgress) => void;
}

type EmbeddingKind = 'document' | 'query';

export interface EmbeddingBatchProgress {
  batchIndex: number;
  batchCount: number;
  batchSize: number;
  completed: number;
  total: number;
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
  const results = await embedBatchForKind([text], 'query', options);
  return results[0];
}

export async function embedQuery(text: string, options: EmbeddingRuntimeOptions = {}): Promise<Float32Array> {
  const results = await embedBatchForKind([text], 'query', options);
  return results[0];
}

export async function embedBatch(
  texts: string[],
  options: EmbeddingRuntimeOptions = {},
): Promise<Float32Array[]> {
  return embedBatchForKind(texts, 'document', options);
}

async function embedBatchForKind(
  texts: string[],
  kind: EmbeddingKind,
  options: EmbeddingRuntimeOptions = {},
): Promise<Float32Array[]> {
  const provider = getEmbeddingProvider(options);
  const prepared = texts.map(text => prepareEmbeddingInput(text, kind, provider));
  const truncated = prepared.map(text => truncateForEmbedding(text));

  if (!provider.capability.available) {
    throw new Error(provider.capability.reason || 'Embedding provider unavailable');
  }

  const results: Float32Array[] = [];
  const batchCount = Math.ceil(truncated.length / DEFAULT_BATCH_SIZE);
  for (let index = 0; index < truncated.length; index += DEFAULT_BATCH_SIZE) {
    const batch = truncated.slice(index, index + DEFAULT_BATCH_SIZE);
    const batchIndex = Math.floor(index / DEFAULT_BATCH_SIZE) + 1;
    options.onBatchStart?.({
      batchIndex,
      batchCount,
      batchSize: batch.length,
      completed: results.length,
      total: truncated.length,
    });
    const batchResults = await provider.embedBatch(batch);
    if (batchResults.length !== batch.length) {
      throw new Error('Embedding provider returned an unexpected result count');
    }
    results.push(...batchResults);
    options.onBatchComplete?.({
      batchIndex,
      batchCount,
      batchSize: batch.length,
      completed: results.length,
      total: truncated.length,
    });
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

export const EMBEDDING_MODEL = 'nomic-embed-text';
export const EMBEDDING_DIMENSIONS = 768;

function truncateForEmbedding(text: string): string {
  return text.slice(0, MAX_CHARS);
}

function prepareEmbeddingInput(
  text: string,
  kind: EmbeddingKind,
  provider: ResolvedEmbeddingProvider,
): string {
  if (!modelUsesNomicTaskPrefixes(provider.capability.model)) {
    return text;
  }

  return kind === 'document'
    ? `search_document: ${text}`
    : `search_query: ${text}`;
}

function safeLoadConfig(): MBrainConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}
