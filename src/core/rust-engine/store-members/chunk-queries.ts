/**
 * Chunk reads beyond the core chunks members: one page of a page's chunks (BrainEngine getChunkPage), batched chunk
 * windows for evidence delivery (getChunkWindows) and the pages with a body but no chunks
 * (countChunklessPagesWithContent, listChunklessPagesWithContent), and the import's deleteChunksExcept.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Row decoders and other helpers stay
 * unexported.
 */
import { mapChunkWindowRows, type ChunkWindowOpts, type ChunkWindowPage, type ChunkWindowRequest } from '../../search/chunk-windows.ts';
import type { Chunk, ChunklessPageRow, PageReadScope } from '../../types.ts';
import { toChunk } from '../store-codec.ts';
import { namedSourceIds, refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

// The SQL engines never read these PageReadScope keys in these statements, so the store ignores them too.
// `excludePrivate` (a privacy filter) and `requireSafeChunks` (the chunker-version fence the store does not record)
// are not here: when true they refuse.
const UNREAD_SCOPE = ['minTrust', 'suppressFlagged'] as const;

type ChunkPage = { chunks: Chunk[]; total_chunks: number; max_chunk_index: number | null };

export const getChunkPage: StoreMember<[slug: string, opts: PageReadScope & { fromIndex: number; limit: number }], ChunkPage> =
  async (brain, slug, opts) => {
    const { sourceIds, sourceId, fromIndex, limit } = takeOptions('getChunkPage', opts, ['sourceId', 'sourceIds', 'fromIndex', 'limit'], UNREAD_SCOPE) as
      { sourceId?: unknown; sourceIds?: unknown[]; fromIndex?: number; limit?: number };
    // The scope resolves as getChunks resolves it: `sourceIds` when not empty, else `sourceId` (default `default`). A
    // scope that names no source matches nothing, and a read over several sources is refused (the chunk order ties).
    const requested = sourceIds?.length ? sourceIds : [sourceId ?? 'default'];
    const named = namedSourceIds(requested);
    if (named.length === 0) return { chunks: [], total_chunks: 0, max_chunk_index: null };
    if (named.length > 1) refuseMember('getChunkPage', 'a read over several sources');
    const options = { sourceId: named[0]!, fromIndex, limit };
    const page: ChunkPage = await storeCall({ member: 'getChunkPage', slug }, () => brain.getChunkPage(slug, options));
    return { chunks: page.chunks.map((row) => toChunk(row)), total_chunks: page.total_chunks, max_chunk_index: page.max_chunk_index };
  };

export const getChunkWindows: StoreMember<[requests: ChunkWindowRequest[], opts: ChunkWindowOpts], ChunkWindowPage[]> =
  async (brain, requests, opts) => {
    // The SQL engines answer an empty request list before they read any option.
    if (requests.length === 0) return [];
    const options = takeOptions('getChunkWindows', opts, ['sourceId', 'sourceIds', 'chunkSources', 'maxRows'], UNREAD_SCOPE);
    // The SQL engines bind every request field into an int[]; a value that is not an integer is not guessed at.
    for (const r of requests) {
      if (![r.page_id, r.from_index, r.to_index, r.priority].every(Number.isSafeInteger)) refuseMember('getChunkWindows', 'a request field that is not an integer');
    }
    const maxRows = Math.max(0, Math.floor(opts.maxRows));
    if (!Number.isSafeInteger(maxRows)) refuseMember('getChunkWindows', 'a maxRows that is not a finite number');
    const wire = requests.map((r) => ({ page_id: r.page_id, from_index: r.from_index, to_index: r.to_index, priority: r.priority }));
    const rows: Record<string, unknown>[] =
      await storeCall({ member: 'getChunkWindows' }, () => brain.getChunkWindows(wire, { ...options, maxRows }));
    return mapChunkWindowRows(rows, maxRows);
  };

export const countChunklessPagesWithContent: StoreMember<[opts?: { sourceId?: string }], number> = (brain, opts) => {
  const options = takeOptions('countChunklessPagesWithContent', opts, ['sourceId']);
  return storeCall({ member: 'countChunklessPagesWithContent' }, () => brain.countChunklessPagesWithContent(options));
};

export const listChunklessPagesWithContent: StoreMember<[opts?: { batchSize?: number; afterPageId?: number; sourceId?: string }], ChunklessPageRow[]> =
  (brain, opts) => {
    const options = takeOptions('listChunklessPagesWithContent', opts, ['batchSize', 'afterPageId', 'sourceId']);
    return storeCall({ member: 'listChunklessPagesWithContent' }, () => brain.listChunklessPagesWithContent(options));
  };

const INT32_MAX = 2 ** 31 - 1;

function int32Ids(member: string, ids: readonly number[]): number[] {
  for (const id of ids) {
    if (!Number.isInteger(id) || Math.abs(id) > INT32_MAX) refuseMember(member, 'an id that is not a 32-bit integer');
  }
  return [...ids];
}

/** Unlike deleteChunks the slug is matched as written and the text seal is kept. */
export const deleteChunksExcept: StoreMember<[slug: string, keepIds: readonly number[], opts?: { sourceId?: string }], void> =
  async (brain, slug, keepIds, opts) => {
    const keep = int32Ids('deleteChunksExcept', keepIds);
    const { sourceId } = takeOptions('deleteChunksExcept', opts, ['sourceId']) as { sourceId?: string };
    await storeCall({ member: 'deleteChunksExcept', slug }, () => brain.deleteChunksExcept({ slug, keepIds: keep, sourceId: sourceId ?? 'default' }));
  };
