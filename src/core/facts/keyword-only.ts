/**
 * Does fact recall on this brain run keyword-only? True when the brain opted
 * out of embedding or no embedding provider is available: the same two
 * conditions under which question ranking (question-recall.ts) has no cosine
 * arm. Kept in its own module so a CLI command can ask without importing the
 * gateway into its own scan surface.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';

export async function factRecallIsKeywordOnly(engine: BrainEngine, config: GBrainConfig | null): Promise<boolean> {
  const { factEmbeddingDisabled } = await import('../embedding-disabled.ts');
  if (await factEmbeddingDisabled(engine, config)) return true;
  const { isAvailable } = await import('../ai/gateway.ts');
  return !isAvailable('embedding');
}
