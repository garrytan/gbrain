/**
 * Chunk members (BrainEngine upsertChunks, sealChunks, getChunks, deleteChunks). A chunk's text vector (`embedding`) is
 * stored with it (rust/docs/store/embeddings.md); an image vector (`embedding_image`) is not, so a chunk that carries
 * one is refused.
 */
import type { Chunk, ChunkInput } from '../../types.ts';
import { prepareChunks } from '../chunk-input.ts';
import { toChunk } from '../store-codec.ts';
import { sanitizeRemoteBody } from '../../remote-body.ts';
import { isRevisionRejection, mapStoreError } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { namedSourceIds, refuseMember, storeCall, takeOptions, throwIfAborted, type StoreMember } from './common.ts';

type UpsertOpts = { sourceId?: string; expectedRevision?: string; deferSeal?: true; signal?: AbortSignal; auditSite?: unknown };

/** Sends the chunks to the store and maps a revision rejection. `seal` is PGLite's `sealChunks` (replace and seal). */
async function writeChunks(brain: StoreBrain, slug: string, chunks: ChunkInput[], options: Record<string, unknown>, member: string): Promise<void> {
  for (const chunk of chunks) {
    if (chunk.embedding_image !== undefined) refuseMember(member, 'chunk image vectors are not stored');
  }
  const sourceId = options.sourceId as string | undefined;
  try {
    await brain.upsertChunks(slug, await prepareChunks(brain, chunks), options);
  } catch (error) {
    const current = isRevisionRejection(error)
      ? ((await brain.readPageSnapshot(slug, { sourceId, includeDeleted: true }).catch(() => null))?.revision ?? null)
      : null;
    throw mapStoreError(error, { member, slug, sourceId, expectedRevision: options.expectedRevision as string | undefined, currentRevision: current });
  }
}

export const upsertChunks: StoreMember<[slug: string, chunks: ChunkInput[], opts?: UpsertOpts], void> = async (brain, slug, chunks, opts) => {
  // `deferSeal` only matters to a write that seals, which `upsertChunks` does not do; it changes nothing here.
  const options = takeOptions('upsertChunks', opts, ['sourceId', 'expectedRevision'], ['signal', 'auditSite', 'deferSeal']);
  throwIfAborted(opts?.signal);
  await writeChunks(brain, slug, chunks, options, 'upsertChunks');
};

/**
 * Replaces a page's chunks and seals them to its current revision (PGLite's sealChunks). A missing or deleted page
 * throws PGLite's `Page not found`; the write itself carries the revision it read, so a page that changes in between
 * rejects as a revision conflict. The seal also sends `sanitizeRemoteBody(timeline)`, the timeline text of the page
 * keyword vector (PGLite's `sealPageTextProjection`); a segmented page (NULL timeline) sends none. The store refuses,
 * before it writes, what PGLite's `sealChunks` refuses: a page in an archived source (`Page not found`) and a
 * segmented page (`sealChunks refuses segmented page ...`), whose projection is built from its segments.
 */
export const sealChunks: StoreMember<[slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; expectedRevision?: string }], void> =
  async (brain, slug, chunks, opts) => {
    const sourceId = opts?.sourceId ?? 'default';
    const current: { page: { deleted_at: unknown; timeline: string | null }; revision: string } | null = await storeCall({ member: 'sealChunks', slug }, () => brain.readPageSnapshot(slug, { sourceId, includeDeleted: true }));
    if (!current || current.page.deleted_at) throw new Error(`Page not found: ${slug} (source=${sourceId})`);
    const timeline = current.page.timeline;
    const searchTimeline = typeof timeline === 'string' ? sanitizeRemoteBody(timeline) : undefined;
    await writeChunks(brain, slug, chunks, { sourceId, expectedRevision: opts?.expectedRevision ?? current.revision, seal: true, searchTimeline }, 'sealChunks');
  };

export const getChunks: StoreMember<[slug: string, opts?: { sourceId?: string; sourceIds?: string[]; includeEmbedding?: boolean; includeUnsealed?: boolean }], Chunk[]> =
  async (brain, slug, opts) => {
    const { sourceIds, sourceId, includeEmbedding, includeUnsealed } =
      takeOptions('getChunks', opts, ['sourceId', 'sourceIds', 'includeEmbedding', 'includeUnsealed']) as
        { sourceId?: unknown; sourceIds?: unknown[]; includeEmbedding?: boolean; includeUnsealed?: boolean };
    // PGLite reads `sourceIds` when it is not empty and otherwise the one `sourceId` (default `default`). An id that
    // names no source (an empty string) matches nothing there, and the store would read it as "no scope" and answer
    // for every source, so a scope that names no source is answered here with no chunks and never forwarded.
    const requested = sourceIds?.length ? sourceIds : [sourceId ?? 'default'];
    const named = namedSourceIds(requested);
    if (named.length === 0) return [];
    // Chunks of one slug from several sources come back in an order PGLite leaves to the database (the sort key ties
    // across sources), so a read over more than one source is refused, not guessed.
    if (named.length > 1) refuseMember('getChunks', 'a read over several sources');
    const scope = { sourceId: named[0]!, includeEmbedding: includeEmbedding === true, includeUnsealed: includeUnsealed === true };
    const rows: Chunk[] = await storeCall({ member: 'getChunks', slug }, () => brain.getChunks(slug, scope));
    return rows.map((row) => toChunk(row));
  };

export const deleteChunks: StoreMember<[slug: string, opts?: { sourceId?: string }], void> = async (brain, slug, opts) => {
  await storeCall({ member: 'deleteChunks', slug }, () => brain.deleteChunks(slug, takeOptions('deleteChunks', opts, ['sourceId'])));
};
