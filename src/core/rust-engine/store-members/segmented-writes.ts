/**
 * The reads and writes a segmented write, a segmented re-chunk and a fence rewrite ran through executeRaw, served by
 * gbrain-store `page_body::segmented_writes` and `page_body::segment_rewrite` (rust/docs/store/page_body.md, "Segmented
 * write statements"). PGLite and Postgres run
 * them from engine-sql/segmented-writes.ts. Each store write is one store transaction.
 *
 * The segmented embed members and readRetiredChunkVectors are served by gbrain-store `page_body::segmented_embedding`.
 * The store keeps one vector column, `embedding`; a member asked for another column refuses, and vectors cross as
 * number arrays.
 * The materializing-revision members keep the setting in the transaction's own settings map, which flipBodyGeneration
 * reads (page-body.ts); outside a transaction the read is null and the set does nothing, as on PGLite, where the
 * setting ends with its statement.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served.
 */
import type { RustEngine } from '../../rust-engine.ts';
import type { LiveEmbedSegmentRow, OccurrenceChunkRow, RechunkCandidateScope, RetiredChunkVectorRow, SegmentChunkRowRow, SegmentedGenerationLock, SegmentedLivePageRow, SegmentedProjectionPage,
  SegmentedRechunkPageRow, SegmentedRewritePageRow, SegmentedStaleRowRow, SegmentedStaleRowsOpts, SegmentedVectorInstall } from '../../engine-sql/segmented-writes.ts';
import type { SegmentDerivationInput } from '../../page-body/derivations.ts';
import type { ResolvedColumn } from '../../types.ts';
import type { StoreBrain } from '../store.ts';
import { mapStoreError } from '../store-errors.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

/** The transaction setting a re-chunk sets so its flip keeps the page's revision. */
const MATERIALIZING_REVISION = 'gbrain.materializing_revision';



export const readSegmentedLivePage: StoreMember<[pageId: number], SegmentedLivePageRow | null> = (brain, pageId) =>
  storeCall({ member: 'readSegmentedLivePage' }, () => brain.readSegmentedLivePage(pageId));


export const listChunkedOccurrences: StoreMember<[pageId: number, occurrenceIds: readonly number[], generation: number], number[]> =
  (brain, pageId, occurrenceIds, generation) =>
    storeCall({ member: 'listChunkedOccurrences' }, () => brain.listChunkedOccurrences(pageId, [...occurrenceIds], generation));

/** The one vector column the store keeps; a member asked for another refuses. */
function storeColumn(member: string, column: string): void {
  if (column !== 'embedding') refuseMember(member, `column ${column}`);
}

export const readRetiredChunkVectors: StoreMember<[pageId: number, occurrences: readonly number[], column: string], RetiredChunkVectorRow[]> =
  async (brain, pageId, occurrences, column) => {
    storeColumn('readRetiredChunkVectors', column);
    if (occurrences.length === 0) return [];
    return storeCall({ member: 'readRetiredChunkVectors' }, () => brain.readRetiredChunkVectors(pageId, [...occurrences]));
  };

export const hasStaleSegmentChunks: StoreMember<[pageId: number, generation: number, live: readonly number[]], boolean> =
  (brain, pageId, generation, live) =>
    storeCall({ member: 'hasStaleSegmentChunks' }, () => brain.hasStaleSegmentChunks(pageId, generation, [...live]));

export const retireStaleSegmentChunks: StoreMember<[pageId: number, generation: number, live: readonly number[], maxRows: number], number> =
  (brain, pageId, generation, live, maxRows) =>
    storeCall({ member: 'retireStaleSegmentChunks' }, () => brain.retireStaleSegmentChunks(pageId, generation, [...live], maxRows));

export const readSegmentedProjectionPage: StoreMember<[sourceId: string, slug: string], SegmentedProjectionPage | null> = (brain, sourceId, slug) =>
  storeCall({ member: 'readSegmentedProjectionPage', sourceId, slug }, () => brain.readSegmentedProjectionPage(sourceId, slug));

export const listSegmentedRechunkCandidates: StoreMember<[chunkerVersion: number, scope?: RechunkCandidateScope], number[]> =
  (brain, chunkerVersion, scope) =>
    storeCall({ member: 'listSegmentedRechunkCandidates' }, () => brain.listSegmentedRechunkCandidates(chunkerVersion,
      { ...(scope?.sourceId ? { sourceId: scope.sourceId } : {}), ...(scope?.slug ? { slug: scope.slug } : {}) }));

export const readSegmentedRechunkPage: StoreMember<[pageId: number], SegmentedRechunkPageRow | null> = (brain, pageId) =>
  storeCall({ member: 'readSegmentedRechunkPage' }, () => brain.readSegmentedRechunkPage(pageId));

export const listOccurrenceChunks: StoreMember<[pageId: number, occurrences: readonly number[]], OccurrenceChunkRow[]> = (brain, pageId, occurrences) =>
  storeCall({ member: 'listOccurrenceChunks' }, () => brain.listOccurrenceChunks(pageId, [...occurrences]));

export const restorePageUpdatedAt: StoreMember<[pageId: number, updatedUs: string], void> = async (brain, pageId, updatedUs) => {
  await storeCall({ member: 'restorePageUpdatedAt' }, () => brain.restorePageUpdatedAt(pageId, updatedUs));
};




export const readSegmentedRewritePage: StoreMember<[pageId: number], SegmentedRewritePageRow | null> = (brain, pageId) =>
  storeCall({ member: 'readSegmentedRewritePage' }, () => brain.readSegmentedRewritePage(pageId));

export const restorePageDeletedAt: StoreMember<[pageId: number, deletedAt: string], void> = async (brain, pageId, deletedAt) => {
  await storeCall({ member: 'restorePageDeletedAt' }, () => brain.restorePageDeletedAt(pageId, String(deletedAt)));
};

/** The store serializes writes, so the row lock is a plain read. */
export const lockSegmentedGenerationPage: StoreMember<[pageId: number], SegmentedGenerationLock | null> = (brain, pageId) =>
  storeCall({ member: 'lockSegmentedGenerationPage' }, () => brain.lockSegmentedGenerationPage(pageId));

export const splitManifestGeneration: StoreMember<[pageId: number, generation: number, stagingId: string], void> =
  async (brain, pageId, generation, stagingId) => {
    await storeCall({ member: 'splitManifestGeneration' }, () => brain.splitManifestGeneration(pageId, generation, stagingId));
  };

export const publishRebuiltGeneration: StoreMember<[pageId: number, generation: number, stagingId: string], void> =
  async (brain, pageId, generation, stagingId) => {
    await storeCall({ member: 'publishRebuiltGeneration' }, () => brain.publishRebuiltGeneration(pageId, generation, stagingId));
  };

export const setSegmentedVersionHash: StoreMember<[pageId: number, generation: number, contentHash: string, bodyBytes: number], void> =
  async (brain, pageId, generation, contentHash, bodyBytes) => {
    await storeCall({ member: 'setSegmentedVersionHash' }, () => brain.setSegmentedVersionHash(pageId, generation, contentHash, bodyBytes));
  };


/** `current_setting('gbrain.materializing_revision', true)`: the transaction's value, null when never set in it. */
export const readMaterializingRevision = async function readMaterializingRevision(this: RustEngine, _brain: StoreBrain): Promise<string | null> {
  const scope = this._txScope;
  if (scope?.ended) throw mapStoreError({ code: 'store_closed' }, { member: 'readMaterializingRevision' });
  return scope?.settings.get(MATERIALIZING_REVISION) ?? null;
};

/** `set_config('gbrain.materializing_revision', revision, true)`: kept for the rest of the transaction; outside one, nothing is kept. */
export const setMaterializingRevision = async function setMaterializingRevision(this: RustEngine, _brain: StoreBrain, revision: string): Promise<void> {
  const scope = this._txScope;
  if (scope?.ended) throw mapStoreError({ code: 'store_closed' }, { member: 'setMaterializingRevision' });
  scope?.settings.set(MATERIALIZING_REVISION, revision);
};


export const hasLiveSegmentedPage: StoreMember<[sourceId: string, slug: string], boolean> = (brain, sourceId, slug) =>
  storeCall({ member: 'hasLiveSegmentedPage', sourceId, slug }, () => brain.hasLiveSegmentedPage(sourceId, slug));

export const countSegmentedEmbedRows: StoreMember<[pageId: number, column: string], { total: number; stale: number }> = async (brain, pageId, column) => {
  storeColumn('countSegmentedEmbedRows', column);
  return storeCall({ member: 'countSegmentedEmbedRows' }, () => brain.countSegmentedEmbedRows(pageId));
};

export const listSegmentedStaleRows: StoreMember<[pageId: number, column: string, opts: SegmentedStaleRowsOpts], SegmentedStaleRowRow[]> =
  async (brain, pageId, column, opts) => {
    storeColumn('listSegmentedStaleRows', column);
    return storeCall({ member: 'listSegmentedStaleRows' }, () => brain.listSegmentedStaleRows(pageId, {
      beforeChunkIndex: opts.beforeChunkIndex, limit: opts.limit, includeEmbedded: opts.includeEmbedded ?? false,
      ...(opts.occurrenceIds ? { occurrenceIds: [...opts.occurrenceIds] } : {}),
    }));
  };

export const readSegmentChunkInputHashes: StoreMember<[pageId: number, chunkIndexes: readonly number[]], Array<{ chunk_index: number; embedding_input_hash: string | null }>> =
  (brain, pageId, chunkIndexes) =>
    storeCall({ member: 'readSegmentChunkInputHashes' }, () => brain.readSegmentChunkInputHashes(pageId, [...chunkIndexes]));

export const installSegmentedVectors: StoreMember<[pageId: number, column: ResolvedColumn, model: string | null, vectors: readonly SegmentedVectorInstall[]], number> =
  async (brain, pageId, column, model, vectors) => {
    storeColumn('installSegmentedVectors', column.name);
    if (vectors.length === 0) return 0;
    const updates = vectors.map(v => ({ chunk_index: v.chunk_index, chunk_text: v.chunk_text, vector: Array.from(v.vector), hash: v.hash, expected: v.expected }));
    return storeCall({ member: 'installSegmentedVectors' }, () => brain.installSegmentedVectors(pageId, model ?? undefined, updates));
  };

export const listLiveEmbedSegments: StoreMember<[pageId: number], LiveEmbedSegmentRow[]> = async (brain, pageId) => {
  const rows: Array<{ occurrence_id: number; sha256: string; entry_state: unknown }> =
    await storeCall({ member: 'listLiveEmbedSegments' }, () => brain.listLiveEmbedSegments(pageId));
  return rows.map(row => ({ occurrence_id: row.occurrence_id, sha256: new Uint8Array(Buffer.from(row.sha256, 'hex')), entry_state: row.entry_state }));
};

export const listSegmentChunkRows: StoreMember<[pageId: number, occurrenceId: number], SegmentChunkRowRow[]> = (brain, pageId, occurrenceId) =>
  storeCall({ member: 'listSegmentChunkRows' }, () => brain.listSegmentChunkRows(pageId, occurrenceId));
