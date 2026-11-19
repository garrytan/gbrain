/**
 * The vector catalog reads (src/core/engine-sql/embedding-catalog.ts) and the stale-fact count
 * (src/core/engine-sql/facts-doctor.ts `countStaleFactEmbeddings`), served from the store's per-vector records
 * (rust/crates/gbrain-store/src/embedding_catalog.rs and facts/doctor.rs).
 *
 * The store has no column types. The width of the vector column is the width of the first stored chunk vector, else
 * the config `embedding_dimensions`; with neither the column reads as absent, as on a PGLite brain with no schema yet, and
 * `readEmbeddingIdentity` resolves null. The model is the first chunk vector's model, else the config `embedding_model`.
 * The store keeps every table of PRIMARY_EMBEDDING_TABLES but `query_cache`, which never holds a vector.
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 */
import type { BrainEngine } from '../../engine.ts';
import { PRIMARY_EMBEDDING_TABLES } from '../../engine-sql/embedding-catalog.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const readChunkVectorColumn: Member<'readChunkVectorColumn'> = (brain, column) =>
  storeCall({ member: 'readChunkVectorColumn' }, () => brain.readChunkVectorColumn({ name: column }));

export const readEmbeddingIdentity: Member<'readEmbeddingIdentity'> = (brain) =>
  storeCall({ member: 'readEmbeddingIdentity' }, () => brain.readEmbeddingIdentity());

export const listEmbeddingStores: Member<'listEmbeddingStores'> = async () => [...PRIMARY_EMBEDDING_TABLES];

export const hasStoredVectors: Member<'hasStoredVectors'> = (brain, store) =>
  storeCall({ member: 'hasStoredVectors' }, () => brain.hasStoredVectors({ name: store }));

export const countStaleFactEmbeddings: Member<'countStaleFactEmbeddings'> = (brain, opts) => {
  if (!Number.isInteger(opts.dims) || Math.abs(opts.dims) > 2 ** 31 - 1) refuseMember('countStaleFactEmbeddings', 'a width that is not a 32-bit integer');
  return storeCall({ member: 'countStaleFactEmbeddings' }, () =>
    brain.countStaleFactEmbeddings({ sourceId: opts.sourceId ?? null, model: opts.model, dims: opts.dims }));
};
