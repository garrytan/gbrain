/**
 * The `gbrain embed --stale` reads and writes (src/core/engine-sql/embed-stale-work.ts) on the Rust engine
 * (rust/crates/gbrain-store/src/embeddings/stale_work.rs, rust/docs/store/embed-stale-work.md), served from the store: the
 * archived-source work count, the pending-projection reads, the segmented-page probe, the signature-drift probe, the
 * content-drift sweep's cursor row and one content-drift batch.
 *
 * The store keeps one vector column, `embedding`: a member asked about another column refuses
 * `engine_capability_missing` here, before the store call. The Postgres statement bound is not a store concept; the
 * members take no read options.
 */
import type { BrainEngine } from '../../engine.ts';
import type { ContentDriftChunkResult } from '../../engine-sql/embed-stale-work.ts';
import { assertStoreSerializedTransactions, refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function storeColumn(member: string, column: string | null | undefined): void {
  if (column != null && column !== 'embedding') refuseMember(member, `column ${column}`);
}

export const countArchivedEmbeddingWork: Member<'countArchivedEmbeddingWork'> = async (brain, opts) => {
  storeColumn('countArchivedEmbeddingWork', opts.column);
  return Number(await storeCall({ member: 'countArchivedEmbeddingWork' }, () => brain.countArchivedEmbeddingWork({ ...opts })));
};

export const countEmbedPendingProjections: Member<'countEmbedPendingProjections'> = async (brain, scope) => {
  storeColumn('countEmbedPendingProjections', scope.stale?.column);
  return Number(await storeCall({ member: 'countEmbedPendingProjections' }, () => brain.countEmbedPendingProjections({ ...scope })));
};

export const listEmbedPendingProjections: Member<'listEmbedPendingProjections'> = async (brain, scope, limit) => {
  storeColumn('listEmbedPendingProjections', scope.stale?.column);
  return storeCall({ member: 'listEmbedPendingProjections' }, () => brain.listEmbedPendingProjections({ ...scope }, limit));
};

export const listEmbedProjectionRepairPages: Member<'listEmbedProjectionRepairPages'> = async (brain, scope, afterPageId, limit) => {
  storeColumn('listEmbedProjectionRepairPages', scope.stale?.column);
  return storeCall({ member: 'listEmbedProjectionRepairPages' }, () => brain.listEmbedProjectionRepairPages({ ...scope }, afterPageId, limit));
};

export const readPageIsSegmented: Member<'readPageIsSegmented'> = async (brain, pageId) =>
  (await storeCall({ member: 'readPageIsSegmented' }, () => brain.readPageIsSegmented(pageId))) === true;

export const hasEmbeddingSignatureDrift: Member<'hasEmbeddingSignatureDrift'> = async (brain, opts) => {
  storeColumn('hasEmbeddingSignatureDrift', opts.column);
  return (await storeCall({ member: 'hasEmbeddingSignatureDrift' }, () => brain.hasEmbeddingSignatureDrift({ ...opts }))) === true;
};

export const lockContentDriftState: Member<'lockContentDriftState'> = async (brain, key, initial) => {
  // The FOR UPDATE after the insert is skipped while explicit transactions hold the writer (`serialized_transactions`).
  assertStoreSerializedTransactions(brain, 'lockContentDriftState');
  return storeCall({ member: 'lockContentDriftState' }, () => brain.ensureConfig(key, initial));
};

export const invalidateContentDriftChunks: Member<'invalidateContentDriftChunks'> = async (brain, window) => {
  storeColumn('invalidateContentDriftChunks', window.column);
  const after = Math.trunc(window.afterChunkId);
  const limit = Math.trunc(window.limit);
  if (!Number.isFinite(after) || !Number.isFinite(limit) || after < 0 || limit < 1) {
    throw new Error(`invalid content-drift batch window: after ${window.afterChunkId}, limit ${window.limit}`);
  }
  return await storeCall({ member: 'invalidateContentDriftChunks' }, () =>
    brain.invalidateContentDriftChunks({ column: window.column, afterChunkId: after, limit, ...(window.sourceId !== undefined && { sourceId: window.sourceId }) })) as ContentDriftChunkResult;
};

export const listUnembeddedChunkIndexes: Member<'listUnembeddedChunkIndexes'> = async (brain, slug, sourceId, column) => {
  storeColumn('listUnembeddedChunkIndexes', column);
  return ((await storeCall({ member: 'listUnembeddedChunkIndexes', slug }, () => brain.listUnembeddedChunkIndexes(slug, sourceId))) as Array<number | string>).map(Number);
};

export const sumEmbedBackfillChars: Member<'sumEmbedBackfillChars'> = async (brain, sourceId, all) => {
  const row = await storeCall({ member: 'sumEmbedBackfillChars' }, () => brain.sumEmbedBackfillChars(sourceId ?? undefined, all)) as { chunk_chars: number | string; chunkless_chars: number | string };
  return { chunk_chars: Number(row.chunk_chars), chunkless_chars: Number(row.chunkless_chars) };
};
