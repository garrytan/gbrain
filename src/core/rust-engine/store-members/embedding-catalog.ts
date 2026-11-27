/**
 * The vector catalog reads (src/core/engine-sql/embedding-catalog.ts) and the stale-fact count
 * (src/core/engine-sql/facts-doctor.ts `countStaleFactEmbeddings`), served from the store's per-vector records
 * (rust/crates/gbrain-store/src/embedding_catalog.rs and facts/doctor.rs).
 *
 * The store has no column types. The width of the vector column is the width of the first stored chunk vector, else
 * the config `embedding_dimensions`; with neither the column reads as absent, as on a PGLite brain with no schema yet, and
 * `readEmbeddingIdentity` resolves null. The model is the first chunk vector's model, else the config `embedding_model`.
 * The store keeps every table of PRIMARY_EMBEDDING_TABLES but `query_cache`, which never holds a vector.
 * countChunkVectorCoverage counts each source's chunks with getStats, as Postgres counts them (every generation,
 * soft-deleted pages too), and none as covered: the store refuses a chunk image vector, so it holds none.
 * readChunkColumnTypes answers from readChunkVectorColumn: a vector column the store has reads as `vector(<width>)` (the
 * store keeps no `halfvec`), and a name that is not a vector column has no row, as a missing column has none on Postgres.
 * countChunkColumnCoverage counts every chunk with getStats (the store's vectors are all in `embedding`); a fixed column
 * covers none, and any other column is missing: the read fails with Postgres's message, as it does there.
 *
 * Export only BrainEngine members from this file (index.ts spreads the whole module into STORE_MEMBERS).
 */
import type { BrainEngine } from '../../engine.ts';
import { FIXED_VECTOR_COLUMNS, PRIMARY_EMBEDDING_TABLES, type ChunkColumnType, type ChunkVectorColumn, type ChunkVectorCoverageRow, type FixedVectorColumn } from '../../engine-sql/embedding-catalog.ts';
import type { BrainStats } from '../../types.ts';
import { refuseMember, requireTextColumn, storeCall, type StoreMember } from './common.ts';
import { listAllSources } from './sources.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const readChunkVectorColumn: Member<'readChunkVectorColumn'> = (brain, column) =>
  storeCall({ member: 'readChunkVectorColumn' }, () => brain.readChunkVectorColumn({ name: column }));

export const readEmbeddingColumnTypmod: Member<'readEmbeddingColumnTypmod'> = (brain, table) =>
  storeCall({ member: 'readEmbeddingColumnTypmod' }, () => brain.readEmbeddingColumnTypmod(table));
export const readEmbeddingSignatureCensus: Member<'readEmbeddingSignatureCensus'> = (brain) =>
  storeCall({ member: 'readEmbeddingSignatureCensus' }, () => brain.readEmbeddingSignatureCensus());
export const countUnembeddedLiveFacts: Member<'countUnembeddedLiveFacts'> = (brain, excludedSources) =>
  storeCall({ member: 'countUnembeddedLiveFacts' }, () => brain.countUnembeddedLiveFacts([...excludedSources]));
export const countSynopsisTierPages: Member<'countSynopsisTierPages'> = (brain) =>
  storeCall({ member: 'countSynopsisTierPages' }, () => brain.countSynopsisTierPages());
export const countEmbedSkipNullChunks: Member<'countEmbedSkipNullChunks'> = (brain) =>
  storeCall({ member: 'countEmbedSkipNullChunks' }, () => brain.countEmbedSkipNullChunks());
export const readFalseStampedChunkCounts: Member<'readFalseStampedChunkCounts'> = (brain, column, signature, model) => {
  if (column !== 'embedding') refuseMember('readFalseStampedChunkCounts', `column ${column}; the store keeps embedding only`);
  return storeCall({ member: 'readFalseStampedChunkCounts' }, () => brain.readFalseStampedChunkCounts(signature, model));
};

export const readEmbeddingIdentity: Member<'readEmbeddingIdentity'> = (brain) =>
  storeCall({ member: 'readEmbeddingIdentity' }, () => brain.readEmbeddingIdentity());

export const listEmbeddingStores: Member<'listEmbeddingStores'> = async () => [...PRIMARY_EMBEDDING_TABLES];

export const hasStoredVectors: Member<'hasStoredVectors'> = (brain, store) =>
  storeCall({ member: 'hasStoredVectors' }, () => brain.hasStoredVectors({ name: store }));

/** No chunk holds an image vector: the store refuses one (the chunk writes take only the text `embedding`). */
export const hasChunkImageVectors: Member<'hasChunkImageVectors'> = async () => false;

export const countStaleFactEmbeddings: Member<'countStaleFactEmbeddings'> = (brain, opts) => {
  if (!Number.isInteger(opts.dims) || Math.abs(opts.dims) > 2 ** 31 - 1) refuseMember('countStaleFactEmbeddings', 'a width that is not a 32-bit integer');
  return storeCall({ member: 'countStaleFactEmbeddings' }, () =>
    brain.countStaleFactEmbeddings({ sourceId: opts.sourceId ?? null, model: opts.model, dims: opts.dims }));
};

export const countChunkVectorCoverage: Member<'countChunkVectorCoverage'> = async (brain, column) => {
  if (!FIXED_VECTOR_COLUMNS.includes(column)) refuseMember('countChunkVectorCoverage', `column ${String(column)}`);
  const ids = (await listAllSources(brain, { includeArchived: true })).map((s) => s.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rows: ChunkVectorCoverageRow[] = [];
  for (const id of ids) {
    const stats = await storeCall({ member: 'countChunkVectorCoverage' }, () => brain.getStats({ scope: [id] })) as BrainStats;
    if (stats.chunk_count > 0) rows.push({ source_id: id, total: stats.chunk_count, covered: 0 });
  }
  return rows;
};

export const readChunkColumnTypes: Member<'readChunkColumnTypes'> = async (brain, columns) => {
  const rows: ChunkColumnType[] = [];
  for (const name of new Set(columns)) {
    const column = await storeCall({ member: 'readChunkColumnTypes' }, () => brain.readChunkVectorColumn({ name })) as ChunkVectorColumn;
    if (column.exists && column.dims !== null) rows.push({ attname: name, formatted: `vector(${column.dims})` });
  }
  return rows;
};

export const countChunkColumnCoverage: Member<'countChunkColumnCoverage'> = async (brain, column) => {
  const fixed = FIXED_VECTOR_COLUMNS.includes(column as FixedVectorColumn);
  // A column the store does not keep is missing, as on Postgres, which fails the read with the same message.
  if (column !== 'embedding' && !fixed) throw new Error(`column "${String(column)}" does not exist`);
  await requireTextColumn(brain, 'countChunkColumnCoverage');
  const stats = await storeCall({ member: 'countChunkColumnCoverage' }, () => brain.getStats({ scope: null })) as BrainStats;
  const total = stats.chunk_count;
  const covered = fixed ? 0 : stats.embedded_count;
  return { pct: total > 0 ? (covered / total) * 100 : null, total };
};

/** The store keeps no query cache (no search result is cached on a Rust brain), so the schema-pack invalidation deletes nothing. */
export const invalidateQueryCacheRows: Member<'invalidateQueryCacheRows'> = async () => 0;
