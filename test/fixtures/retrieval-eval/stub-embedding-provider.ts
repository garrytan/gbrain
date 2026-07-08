import type { ResolvedEmbeddingProvider } from '../../../src/core/embedding/provider.ts';

/**
 * Deterministic stub embedding provider for the EV-1c ±embeddings baselines.
 *
 * This is NOT a semantic model. It is a feature-hashed bag-of-tokens embedding
 * (FNV-1a token hashing into 1024 buckets, L2-normalized) whose only purpose is
 * to exercise the real vector path end-to-end — embed at backfill time, store
 * through the engine, embed the query at probe time, run engine.searchVector,
 * and fuse via RRF — with zero network, zero model downloads, and byte-stable
 * output across machines. Cosine similarity under this stub reflects token
 * overlap, so the vector leg contributes signal instead of noise.
 *
 * The dimension count (1024) matches the pgvector `vector(1024)` column pin so
 * the same stub works on both the SQLite and PGLite (Postgres-dialect) engines.
 * Baselines produced with this provider are named `*-stub-embeddings` and must
 * never be read as evidence about real embedding-model quality.
 */
export const STUB_EMBEDDING_MODEL = 'stub-hash-1024';
export const STUB_EMBEDDING_DIMENSIONS = 1024;

export interface StubEmbeddingStats {
  batch_count: number;
  text_count: number;
}

export interface StubEmbeddingProviderHandle {
  provider: ResolvedEmbeddingProvider;
  stats: StubEmbeddingStats;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function embedStubText(text: string): Float32Array {
  const vector = new Float32Array(STUB_EMBEDDING_DIMENSIONS);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    vector[fnv1a(token) % STUB_EMBEDDING_DIMENSIONS] += 1;
  }

  let normSquared = 0;
  for (let index = 0; index < vector.length; index++) {
    normSquared += vector[index] * vector[index];
  }
  if (normSquared === 0) {
    vector[0] = 1;
    return vector;
  }
  const norm = Math.sqrt(normSquared);
  for (let index = 0; index < vector.length; index++) {
    vector[index] /= norm;
  }
  return vector;
}

export function createStubEmbeddingProvider(): StubEmbeddingProviderHandle {
  const stats: StubEmbeddingStats = { batch_count: 0, text_count: 0 };
  return {
    stats,
    provider: {
      capability: {
        mode: 'local',
        available: true,
        implementation: 'test-local',
        model: STUB_EMBEDDING_MODEL,
        dimensions: STUB_EMBEDDING_DIMENSIONS,
      },
      embedBatch: async (texts: string[]) => {
        stats.batch_count += 1;
        stats.text_count += texts.length;
        return texts.map((text) => embedStubText(text));
      },
    },
  };
}
