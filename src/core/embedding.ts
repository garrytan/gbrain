import { loadConfig, type MBrainConfig } from './config.ts';
import type { ChunkInput } from './types.ts';
import type { ResolvedEmbeddingProvider } from './embedding/provider.ts';
import {
  DEFAULT_LOCAL_EMBEDDING_DIMENSIONS,
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  prepareEmbeddingInputForModel,
  resolveEmbeddingProvider,
} from './embedding/provider.ts';
import { estimateTokenCount } from './token-count.ts';

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

export async function embedQueries(
  texts: string[],
  options: EmbeddingRuntimeOptions = {},
): Promise<Float32Array[]> {
  return embedBatchForKind(texts, 'query', options);
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
    assertEmbeddingBatchDimensions(
      batchResults,
      provider.capability.dimensions,
      index,
    );
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
    chunks.map(chunk => buildChunkEmbeddingInput(chunk)),
    { ...options, provider },
  );

  return {
    capability: provider.capability,
    deferred: false,
    chunks: chunks.map((chunk, index) => ({
      ...chunk,
      embedding: embeddings[index],
      model: resolveChunkEmbeddingModel(chunk, provider),
      token_count: chunk.token_count ?? estimateTokenCount(chunk.chunk_text),
    })),
  };
}

export function buildChunkEmbeddingInput(chunk: Pick<ChunkInput, 'chunk_text' | 'embed_context'>): string {
  const context = chunk.embed_context?.trim();
  if (!context) return chunk.chunk_text;
  return `${context}\n\n${chunk.chunk_text}`;
}

export function resolveChunkEmbeddingModel(
  chunk: Pick<ChunkInput, 'model' | 'embedding_input_version'>,
  provider: ResolvedEmbeddingProvider,
): string | undefined {
  const model = provider.capability.model ?? chunk.model;
  if (!chunk.embedding_input_version) return model;
  return `${model ?? DEFAULT_LOCAL_EMBEDDING_MODEL}#${chunk.embedding_input_version}`;
}

export { estimateTokenCount };

export const EMBEDDING_MODEL = DEFAULT_LOCAL_EMBEDDING_MODEL;
export const EMBEDDING_DIMENSIONS = DEFAULT_LOCAL_EMBEDDING_DIMENSIONS;

export function assertEmbeddingBatchDimensions(
  embeddings: Float32Array[],
  expectedDimensions: number | null,
  startIndex = 0,
): void {
  if (expectedDimensions === null) return;

  for (let index = 0; index < embeddings.length; index++) {
    const actualDimensions = embeddings[index].length;
    if (actualDimensions === expectedDimensions) continue;

    throw new Error(
      `Embedding provider result ${startIndex + index} expected ` +
      `${expectedDimensions} dimensions, got ${actualDimensions}.`,
    );
  }
}

function truncateForEmbedding(text: string): string {
  return text.slice(0, MAX_CHARS);
}

function prepareEmbeddingInput(
  text: string,
  kind: EmbeddingKind,
  provider: ResolvedEmbeddingProvider,
): string {
  return prepareEmbeddingInputForModel(text, kind, provider.capability.model);
}

function safeLoadConfig(): MBrainConfig | null {
  try {
    return loadConfig();
  } catch {
    return null;
  }
}
