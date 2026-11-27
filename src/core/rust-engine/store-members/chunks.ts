/**
 * Chunk members (BrainEngine upsertChunks, sealChunks, getChunks, deleteChunks). A chunk's text vector (`embedding`) is
 * stored with it (rust/docs/store/embeddings.md); an image vector (`embedding_image`) is not, so a chunk that carries
 * one is refused, and so is an `embeddingColumn` that names another column than the `embedding` vector column.
 */
import type { Chunk, ChunkInput } from '../../types.ts';
import { prepareChunks, textColumnModel } from '../chunk-input.ts';
import { toChunk, toGetPage } from '../store-codec.ts';
import { overlayStoreSnapshot, storeNormalizer, type StoreSnapshot } from '../snapshot-overlay.ts';
import { sanitizeRemoteBody } from '../../remote-body.ts';
import { isRevisionRejection, mapStoreError } from '../store-errors.ts';
import type { StoreBrain } from '../store.ts';
import { namedSourceIds, refuseMember, storeCall, takeOptions, throwIfAborted, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';
import { requiresSafeChunks } from '../../search/safe-chunks.ts';

type UpsertOpts = { sourceId?: string; expectedRevision?: string; sealChunkerVersion?: number; pageId?: number; deferSeal?: true; embeddingColumn?: unknown; signal?: AbortSignal; auditSite?: unknown };

/** Sends the chunks to the store and maps a revision rejection. `seal` is PGLite's `sealChunks` (replace and seal). */
async function writeChunks(brain: StoreBrain, slug: string, chunks: ChunkInput[], options: Record<string, unknown>, member: string, columnModel?: string): Promise<void> {
  for (const chunk of chunks) {
    if (chunk.embedding_image !== undefined) refuseMember(member, 'chunk image vectors are not stored');
  }
  const sourceId = options.sourceId as string | undefined;
  try {
    await brain.upsertChunks(slug, await prepareChunks(brain, chunks, columnModel), options);
  } catch (error) {
    const current = isRevisionRejection(error)
      ? ((await brain.readPageSnapshot(slug, { sourceId, includeDeleted: true }).catch(() => null))?.revision ?? null)
      : null;
    throw mapStoreError(error, { member, slug, sourceId, expectedRevision: options.expectedRevision as string | undefined, currentRevision: current });
  }
}

export const upsertChunks: StoreMember<[slug: string, chunks: ChunkInput[], opts?: UpsertOpts], void> = async (brain, slug, chunks, opts) => {
  // `sealChunkerVersion` goes as the text PGLite binds (`String(version)`), which the store casts to a smallint as
  // Postgres does. `pageId` and `deferSeal` only matter to a write with `sealChunkerVersion`; the store ignores them otherwise.
  // `embeddingColumn` (import's resolved write column) is served for the store's one vector column (`textColumnModel`)
  // and stays here: it only picks the model label of a chunk that names none.
  const { embeddingColumn, ...options } = takeOptions('upsertChunks', opts,
    ['sourceId', 'expectedRevision', 'sealChunkerVersion', 'pageId', 'deferSeal', 'embeddingColumn'], ['signal', 'auditSite']);
  if (options.sealChunkerVersion !== undefined) options.sealChunkerVersion = String(options.sealChunkerVersion);
  throwIfAborted(opts?.signal);
  const columnModel = textColumnModel('upsertChunks', embeddingColumn);
  await writeChunks(brain, slug, chunks, options, 'upsertChunks', columnModel);
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
    // PGLite seals the overlaid timeline (its readPageSnapshot strikes withdrawn fence rows), so the store's is overlaid here.
    const stored: StoreSnapshot | null = await storeCall({ member: 'sealChunks', slug }, () => brain.readPageSnapshot(slug, { sourceId, includeDeleted: true }));
    // A segmented page has no whole body to overlay (toGetPage refuses it); the store refuses its seal as PGLite does.
    const segmented = (stored?.page as { body_storage?: string } | undefined)?.body_storage === 'segmented';
    const current = stored === null ? null : segmented ? stored : await overlayStoreSnapshot(storeNormalizer(brain), { ...stored, page: toGetPage(stored.page) });
    if (!current || current.page.deleted_at) throw new Error(`Page not found: ${slug} (source=${sourceId})`);
    const timeline = current.page.timeline;
    const searchTimeline = typeof timeline === 'string' ? sanitizeRemoteBody(timeline) : undefined;
    await writeChunks(brain, slug, chunks, { sourceId, expectedRevision: opts?.expectedRevision ?? current.revision, seal: true, searchTimeline }, 'sealChunks');
  };

export const getChunks: StoreMember<[slug: string, opts?: { sourceId?: string; sourceIds?: string[]; includeEmbedding?: boolean; includeUnsealed?: boolean; requireSafeChunks?: boolean; excludePrivate?: boolean }], Chunk[]> =
  async (brain, slug, opts) => {
    const { sourceIds, sourceId, includeEmbedding, includeUnsealed, requireSafeChunks: requireSafe, excludePrivate } =
      takeOptions('getChunks', opts, ['sourceId', 'sourceIds', 'includeEmbedding', 'includeUnsealed', 'requireSafeChunks', 'excludePrivate']) as
        { sourceId?: unknown; sourceIds?: unknown[]; includeEmbedding?: boolean; includeUnsealed?: boolean; requireSafeChunks?: boolean; excludePrivate?: boolean };
    // `excludePrivate` adds the caller's page policy, and implies the safe-chunk fence unless the read says otherwise
    // (`requiresSafeChunks`), as the SQL engines' getChunks does.
    const policy = storePagePolicy('getChunks', excludePrivate, { callerReaders: true }) ?? null;
    const requireSafeChunks = requiresSafeChunks({ requireSafeChunks: requireSafe, excludePrivate });
    // PGLite reads `sourceIds` when it is not empty and otherwise the one `sourceId` (default `default`). An id that
    // names no source (an empty string) matches nothing there, and the store would read it as "no scope" and answer
    // for every source, so a scope that names no source is answered here with no chunks and never forwarded.
    const requested = sourceIds?.length ? sourceIds : [sourceId ?? 'default'];
    const named = namedSourceIds(requested);
    if (named.length === 0) return [];
    // Chunks of one slug from several sources merge in document order, the source id (byte order) breaking a tie.
    // `requireSafeChunks` (safeChunksFilter): a page chunked before the fence chunker version has no chunks to read.
    const scope = { ...(named.length > 1 ? { sourceIds: named } : { sourceId: named[0]! }), includeEmbedding: includeEmbedding === true, includeUnsealed: includeUnsealed === true,
      requireSafeChunks: requireSafeChunks === true, excludePrivate: policy };
    const rows: Chunk[] = await storeCall({ member: 'getChunks', slug }, () => brain.getChunks(slug, scope));
    return rows.map((row) => toChunk(row));
  };

export const deleteChunks: StoreMember<[slug: string, opts?: { sourceId?: string }], void> = async (brain, slug, opts) => {
  await storeCall({ member: 'deleteChunks', slug }, () => brain.deleteChunks(slug, takeOptions('deleteChunks', opts, ['sourceId'])));
};
