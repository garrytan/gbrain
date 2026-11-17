/** Chunk members (BrainEngine upsertChunks, sealChunks, getChunks, deleteChunks). Vectors are not stored, so a chunk that carries one is refused. */
import type { Chunk, ChunkInput } from '../../types.ts';
import { toChunk } from '../store-codec.ts';
import { isRevisionRejection, mapStoreError } from '../store-errors.ts';
import { refuseMember, storeCall, takeOptions, type StoreMember } from './common.ts';

type UpsertOpts = { sourceId?: string; expectedRevision?: string; deferSeal?: true; signal?: AbortSignal; auditSite?: unknown };

export const upsertChunks: StoreMember<[slug: string, chunks: ChunkInput[], opts?: UpsertOpts], void> = async (brain, slug, chunks, opts) => {
  const options = takeOptions('upsertChunks', opts, ['sourceId', 'expectedRevision', 'deferSeal'], ['signal', 'auditSite']);
  for (const chunk of chunks) {
    if (chunk.embedding !== undefined || chunk.embedding_image !== undefined) refuseMember('upsertChunks', 'chunk vectors are not stored');
  }
  const sourceId = options.sourceId as string | undefined;
  try {
    await brain.upsertChunks(slug, chunks, options);
  } catch (error) {
    const current = isRevisionRejection(error)
      ? ((await brain.readPageSnapshot(slug, { sourceId, includeDeleted: true }).catch(() => null))?.revision ?? null)
      : null;
    throw mapStoreError(error, { member: 'upsertChunks', slug, sourceId, expectedRevision: opts?.expectedRevision, currentRevision: current });
  }
};

/**
 * Replaces a page's chunks and seals them to its current revision (PGLite's sealChunks). A missing or deleted page
 * throws PGLite's `Page not found`; the write itself carries the revision it read, so a page that changes in between
 * rejects as a revision conflict.
 */
export const sealChunks: StoreMember<[slug: string, chunks: ChunkInput[], opts?: { sourceId?: string; expectedRevision?: string }], void> =
  async (brain, slug, chunks, opts) => {
    const sourceId = opts?.sourceId ?? 'default';
    const current: { page: { deleted_at: unknown }; revision: string } | null = await storeCall({ member: 'sealChunks', slug }, () => brain.readPageSnapshot(slug, { sourceId, includeDeleted: true }));
    if (!current || current.page.deleted_at) throw new Error(`Page not found: ${slug} (source=${sourceId})`);
    await upsertChunks(brain, slug, chunks, { sourceId, expectedRevision: opts?.expectedRevision ?? current.revision });
  };

export const getChunks: StoreMember<[slug: string, opts?: { sourceId?: string; sourceIds?: string[]; includeEmbedding?: boolean; includeUnsealed?: boolean }], Chunk[]> =
  async (brain, slug, opts) => {
    const rows: Chunk[] = await storeCall({ member: 'getChunks', slug }, () =>
      brain.getChunks(slug, takeOptions('getChunks', opts, ['sourceId', 'sourceIds'])));
    return rows.map((row) => toChunk(row));
  };

export const deleteChunks: StoreMember<[slug: string, opts?: { sourceId?: string }], void> = async (brain, slug, opts) => {
  await storeCall({ member: 'deleteChunks', slug }, () => brain.deleteChunks(slug, takeOptions('deleteChunks', opts, ['sourceId'])));
};
