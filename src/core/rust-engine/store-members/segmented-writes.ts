/**
 * The reads and writes a segmented write and a segmented re-chunk ran through executeRaw, served by gbrain-store
 * `page_body::segmented_writes` (rust/docs/store/page_body.md, "Segmented write statements"). PGLite and Postgres run
 * them from engine-sql/segmented-writes.ts. Each store write is one store transaction.
 *
 * readRetiredChunkVectors returns no rows: the store keeps no vectors (stageSegmentChunks refuses a chunk that carries
 * one), so there is no vector to reuse and a re-chunked text waits for the embed sweep, as a new text does elsewhere.
 * The materializing-revision members keep the setting in the transaction's own settings map, which flipBodyGeneration
 * reads (page-body.ts); outside a transaction the read is null and the set does nothing, as on PGLite, where the
 * setting ends with its statement.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served.
 */
import type { RustEngine } from '../../rust-engine.ts';
import type { OccurrenceChunkRow, PageTrustRef, PageTrustStamp, RechunkCandidateScope, RetiredChunkVectorRow, SegmentedLivePageRow,
  SegmentedProjectionPage, SegmentedRechunkPageRow } from '../../engine-sql/segmented-writes.ts';
import type { StoreBrain } from '../store.ts';
import { mapStoreError } from '../store-errors.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The transaction setting a re-chunk sets so its flip keeps the page's revision. */
const MATERIALIZING_REVISION = 'gbrain.materializing_revision';

export const lockBodyStagingState: StoreMember<[stagingId: string], string | null> = (brain, stagingId) =>
  storeCall({ member: 'lockBodyStagingState' }, () => brain.lockBodyStagingState(stagingId));

export const deleteUnstagedSegmentChunks: StoreMember<[pageId: number, generation: number, keepIndexes: readonly number[]], void> =
  async (brain, pageId, generation, keepIndexes) => {
    await storeCall({ member: 'deleteUnstagedSegmentChunks' }, () => brain.deleteUnstagedSegmentChunks(pageId, generation, [...keepIndexes]));
  };

export const readSegmentedLivePage: StoreMember<[pageId: number], SegmentedLivePageRow | null> = (brain, pageId) =>
  storeCall({ member: 'readSegmentedLivePage' }, () => brain.readSegmentedLivePage(pageId));

export const readSegmentedSealed: StoreMember<[sourceId: string, slug: string], boolean> = (brain, sourceId, slug) =>
  storeCall({ member: 'readSegmentedSealed', sourceId, slug }, () => brain.readSegmentedSealed(sourceId, slug));

export const listChunkedOccurrences: StoreMember<[pageId: number, occurrenceIds: readonly number[], generation: number], number[]> =
  (brain, pageId, occurrenceIds, generation) =>
    storeCall({ member: 'listChunkedOccurrences' }, () => brain.listChunkedOccurrences(pageId, [...occurrenceIds], generation));

export const readRetiredChunkVectors: StoreMember<[pageId: number, occurrences: readonly number[], column: string], RetiredChunkVectorRow[]> =
  async () => [];

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

export const readPageTrustStamp: StoreMember<[page: PageTrustRef], PageTrustStamp | null> = (brain, page) =>
  storeCall({ member: 'readPageTrustStamp' }, () => brain.readPageTrustStamp('id' in page ? { id: page.id } : { sourceId: page.sourceId, slug: page.slug }));

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
