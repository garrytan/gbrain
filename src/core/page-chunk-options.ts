import type { BrainEngine } from './engine.ts';
import {
  DEFAULT_QWEN3_CHUNK_OVERLAP_TOKENS,
  DEFAULT_QWEN3_CHUNK_SIZE_TOKENS,
  type ChunkOptions,
} from './chunkers/recursive.ts';

export const DEFAULT_CHUNK_SIZE_TOKENS = DEFAULT_QWEN3_CHUNK_SIZE_TOKENS;
export const DEFAULT_CHUNK_OVERLAP_TOKENS = DEFAULT_QWEN3_CHUNK_OVERLAP_TOKENS;

export type PageChunkOptions = Pick<ChunkOptions, 'chunkSizeTokens' | 'chunkOverlapTokens'>;

export async function resolvePageChunkOptions(
  engine: Partial<Pick<BrainEngine, 'getConfig'>>,
): Promise<PageChunkOptions> {
  if (typeof engine.getConfig !== 'function') {
    return defaultPageChunkOptions();
  }

  const [sizeValue, overlapValue] = await Promise.all([
    engine.getConfig('chunk_size_tokens'),
    engine.getConfig('chunk_overlap_tokens'),
  ]);

  return {
    chunkSizeTokens: parsePositiveInt(sizeValue) ?? DEFAULT_CHUNK_SIZE_TOKENS,
    chunkOverlapTokens: parsePositiveInt(overlapValue) ?? DEFAULT_CHUNK_OVERLAP_TOKENS,
  };
}

export function defaultPageChunkOptions(): PageChunkOptions {
  return {
    chunkSizeTokens: DEFAULT_CHUNK_SIZE_TOKENS,
    chunkOverlapTokens: DEFAULT_CHUNK_OVERLAP_TOKENS,
  };
}

function parsePositiveInt(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
