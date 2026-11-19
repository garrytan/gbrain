/**
 * Embedding state of chunks, pages and takes (rust/docs/store/embeddings.md). The store keeps each chunk's text vector
 * (`embedding`) and each take's vector with the model and text they were computed from; these members read and
 * invalidate that state as PGLite's shared SQL does. Built by the core store work; other families do not edit this
 * file.
 *
 * Members: getEmbeddingsByChunkIds, cosinesByChunkIds, countStaleChunks, sumStaleChunkChars, setPageEmbeddingSignature,
 * invalidateStaleSignatureEmbeddings, invalidateContentDriftEmbeddings, listStaleChunks, readEmbeddingStateCounts,
 * listEmbeddingStateRows, getChunksWithEmbeddings, updateTakeEmbeddings, getTakeEmbeddings, countStaleTakes,
 * listStaleTakes.
 *
 * The store has one vector column, `embedding`. A brain whose config routes reads to another column
 * (`search_embedding_column`, `embedding_columns`) is refused, not answered from the wrong space.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import type { BatchOpts } from '../../engine.ts';
import type { EmbeddingState, EmbeddingStateCounts, EmbeddingStateRow } from '../../embedding-state.ts';
import { COLUMN_NAME_REGEX, EmbeddingColumnNotRegisteredError } from '../../search/embedding-column.ts';
import type { StaleTakeOpts, StaleTakeRow, TakeEmbeddingInput } from '../../takes-row-types.ts';
import type { Chunk, StaleChunkRow } from '../../types.ts';
import { toChunk, withDates } from '../store-codec.ts';
import type { StoreBrain } from '../store.ts';
import { refuseMember, requireTextColumn, storeCall, takeOptions, throwIfAborted, type StoreMember } from './common.ts';

type StaleChunkOpts = { sourceId?: string; signature?: string; includeNullSignature?: boolean };
const STALE_CHUNK_OPTIONS = ['sourceId', 'signature', 'includeNullSignature'] as const;

/** `[{ id, embedding }]` from the store as PGLite's `Map<id, Float32Array>`. */
function vectorMap(rows: { id: number; embedding: number[] }[]): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>();
  for (const row of rows) out.set(row.id, new Float32Array(row.embedding));
  return out;
}

export const getEmbeddingsByChunkIds: StoreMember<[ids: number[], column?: string], Map<number, Float32Array>> =
  async (brain, ids, column = 'embedding') => {
    if (ids.length === 0) return new Map();
    if (!COLUMN_NAME_REGEX.test(column)) throw new EmbeddingColumnNotRegisteredError(column, []);
    if (column !== 'embedding') refuseMember('getEmbeddingsByChunkIds', `column ${column}`);
    return vectorMap(await storeCall({ member: 'getEmbeddingsByChunkIds' }, () => brain.getEmbeddingsByChunkIds(ids)));
  };

/**
 * The text-space cosine of each served chunk's vector and `query`, an exact scan in the store (rust/docs/store/vectors.md):
 * 0 for another dimension count or a zero vector or query, no row for an id that is no served chunk with a vector.
 */
export const cosinesByChunkIds: StoreMember<[ids: number[], column: string, query: Float32Array], Map<number, number>> =
  async (brain, ids, column, query) => {
    if (!COLUMN_NAME_REGEX.test(column)) throw new EmbeddingColumnNotRegisteredError(column, []);
    if (column !== 'embedding') refuseMember('cosinesByChunkIds', `column ${column}`);
    const rows: { id: number; cosine: number }[] =
      await storeCall({ member: 'cosinesByChunkIds' }, () => brain.cosinesByChunkIds(ids, Array.from(query)));
    return new Map(rows.map((row) => [row.id, row.cosine]));
  };

export const countStaleChunks: StoreMember<[opts?: StaleChunkOpts], number> = async (brain, opts) => {
  const options = takeOptions('countStaleChunks', opts, STALE_CHUNK_OPTIONS);
  await requireTextColumn(brain, 'countStaleChunks');
  return storeCall({ member: 'countStaleChunks' }, () => brain.countStaleChunks(options));
};

export const sumStaleChunkChars: StoreMember<[opts?: StaleChunkOpts], number> = async (brain, opts) => {
  const options = takeOptions('sumStaleChunkChars', opts, STALE_CHUNK_OPTIONS);
  await requireTextColumn(brain, 'sumStaleChunkChars');
  return storeCall({ member: 'sumStaleChunkChars' }, () => brain.sumStaleChunkChars(options));
};

export const setPageEmbeddingSignature: StoreMember<[slug: string, opts: { sourceId?: string; signature: string }], void> =
  async (brain, slug, opts) => {
    const options = takeOptions('setPageEmbeddingSignature', opts, ['sourceId', 'signature']);
    await storeCall({ member: 'setPageEmbeddingSignature', slug }, () => brain.setPageEmbeddingSignature(slug, options));
  };

export const invalidateStaleSignatureEmbeddings: StoreMember<[opts: { signature: string; sourceId?: string; includeNullSignature?: boolean }], number> =
  async (brain, opts) => {
    const options = takeOptions('invalidateStaleSignatureEmbeddings', opts, ['signature', 'sourceId', 'includeNullSignature']);
    await requireTextColumn(brain, 'invalidateStaleSignatureEmbeddings');
    return storeCall({ member: 'invalidateStaleSignatureEmbeddings' }, () => brain.invalidateStaleSignatureEmbeddings(options));
  };

export const invalidateContentDriftEmbeddings: StoreMember<[opts?: { sourceId?: string }], number> = async (brain, opts) => {
  const options = takeOptions('invalidateContentDriftEmbeddings', opts, ['sourceId']);
  await requireTextColumn(brain, 'invalidateContentDriftEmbeddings');
  return storeCall({ member: 'invalidateContentDriftEmbeddings' }, () => brain.invalidateContentDriftEmbeddings(options));
};

type ListStaleOpts = {
  batchSize?: number; afterPageId?: number; afterChunkIndex?: number; sourceId?: string;
  orderBy?: 'page_id' | 'updated_desc'; afterUpdatedAt?: string | null;
};

export const listStaleChunks: StoreMember<[opts?: ListStaleOpts], StaleChunkRow[]> = async (brain, opts) => {
  const options = takeOptions('listStaleChunks', opts,
    ['batchSize', 'afterPageId', 'afterChunkIndex', 'sourceId', 'orderBy', 'afterUpdatedAt']);
  await requireTextColumn(brain, 'listStaleChunks');
  const rows: StaleChunkRow[] = await storeCall({ member: 'listStaleChunks' }, () => brain.listStaleChunks(options));
  // The `updated_desc` page also carries the page's `updated_at` (a Date, as PGLite's TIMESTAMPTZ reads back).
  return rows.map((row) => withDates(row, ['updated_at']));
};

export const readEmbeddingStateCounts: StoreMember<[opts: { mode: 'ops' | 'full'; sourceIds?: string[]; purgeWindowHours: number }], EmbeddingStateCounts> =
  async (brain, opts) => {
    const options = takeOptions('readEmbeddingStateCounts', opts, ['mode', 'sourceIds', 'purgeWindowHours']);
    await requireTextColumn(brain, 'readEmbeddingStateCounts');
    const counts: EmbeddingStateCounts = await storeCall({ member: 'readEmbeddingStateCounts' }, () => brain.readEmbeddingStateCounts(options));
    return withDates(counts, ['unstamped_created_at_min']);
  };

export const listEmbeddingStateRows: StoreMember<[opts: { sourceIds?: string[]; slugs?: string[]; states: readonly EmbeddingState[]; limit: number; purgeWindowHours: number }], EmbeddingStateRow[]> =
  async (brain, opts) => {
    const options = takeOptions('listEmbeddingStateRows', opts, ['sourceIds', 'slugs', 'states', 'limit', 'purgeWindowHours']);
    await requireTextColumn(brain, 'listEmbeddingStateRows');
    const rows: EmbeddingStateRow[] = await storeCall({ member: 'listEmbeddingStateRows' }, () => brain.listEmbeddingStateRows(options));
    return rows.map((row) => withDates(row, ['deleted_at']));
  };

export const getChunksWithEmbeddings: StoreMember<[slug: string, opts?: { sourceId?: string; includeUnsealed?: boolean }], Chunk[]> =
  async (brain, slug, opts) => {
    const options = takeOptions('getChunksWithEmbeddings', opts, ['sourceId', 'includeUnsealed']);
    const rows: Record<string, unknown>[] = await storeCall({ member: 'getChunksWithEmbeddings', slug },
      () => brain.getChunksWithEmbeddings(slug, options));
    // Chunks of one slug in two sources tie on PGLite's sort key (chunk_index), so their order is the database's.
    if (new Set(rows.map((row) => row.page_id)).size > 1) refuseMember('getChunksWithEmbeddings', 'a slug read over several sources');
    // PGLite selects `cc.*`, which has no `embedding_is_null` column.
    return rows.map((row) => {
      const { embedding_is_null: _null, ...chunk } = toChunk(row);
      return chunk as unknown as Chunk;
    });
  };

export const updateTakeEmbeddings: StoreMember<[rows: TakeEmbeddingInput[], opts?: BatchOpts], number> = async (brain, rowsIn, opts) => {
  takeOptions('updateTakeEmbeddings', opts, [], ['signal', 'auditSite']);
  if (rowsIn.length === 0) return 0;
  throwIfAborted(opts?.signal);
  // The validation of the shared SQL module, before anything is written.
  const seen = new Set<number>();
  const rows = rowsIn.map(({ take_id, embedding, claim, model }) => {
    if (!Number.isInteger(take_id) || take_id <= 0) throw new Error(`invalid take_id: ${take_id}`);
    if (seen.has(take_id)) throw new Error(`duplicate take_id in embedding batch: ${take_id}`);
    seen.add(take_id);
    if (typeof claim !== 'string' || typeof model !== 'string' || model.length === 0) {
      throw new Error(`take embedding for take_id=${take_id} must name its claim text and model`);
    }
    const values = Array.from(embedding);
    if (values.length === 0 || values.some((v) => !Number.isFinite(v))) throw new Error(`invalid embedding for take_id=${take_id}`);
    return { take_id, embedding: values, claim, model };
  });
  return storeCall({ member: 'updateTakeEmbeddings' }, () => brain.updateTakeEmbeddings(rows));
};

export const getTakeEmbeddings: StoreMember<[ids: number[]], Map<number, Float32Array>> = async (brain, ids) => {
  if (ids.length === 0) return new Map();
  return vectorMap(await storeCall({ member: 'getTakeEmbeddings' }, () => brain.getTakeEmbeddings(ids)));
};

export const countStaleTakes: StoreMember<[opts?: StaleTakeOpts], number> = async (brain, opts) => {
  const options = takeOptions('countStaleTakes', opts, ['sourceId', 'model', 'dims']);
  return storeCall({ member: 'countStaleTakes' }, () => brain.countStaleTakes(options));
};

export const listStaleTakes: StoreMember<[opts?: StaleTakeOpts], StaleTakeRow[]> = async (brain, opts) => {
  const options = takeOptions('listStaleTakes', opts, ['sourceId', 'model', 'dims']);
  return storeCall({ member: 'listStaleTakes' }, () => brain.listStaleTakes(options));
};
