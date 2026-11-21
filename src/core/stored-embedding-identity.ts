import type { BrainEngine } from './engine.ts';
import type { EmbeddingIdentity, EmbeddingStore } from './engine-sql/embedding-catalog.ts';

/** The tables that carry an `embedding` vector column (engine member `listEmbeddingStores`). */
export async function readPrimaryEmbeddingStores(
  engine: Pick<BrainEngine, 'listEmbeddingStores'>,
): Promise<EmbeddingStore[]> {
  return engine.listEmbeddingStores();
}

/**
 * The stored embedding identity (engine member `readEmbeddingIdentity`): null when the brain has no vector column yet;
 * on Postgres and PGLite it throws when the column's width is unknown.
 */
export async function readStoredEmbeddingIdentity(
  engine: Pick<BrainEngine, 'readEmbeddingIdentity'>,
): Promise<EmbeddingIdentity | null> {
  return engine.readEmbeddingIdentity();
}
