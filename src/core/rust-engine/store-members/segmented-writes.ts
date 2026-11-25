/**
 * The reads and writes of a segmented replace of a page body (page-body/ingest.ts, page-body/projection.ts,
 * import-chunk-reuse.ts) that ran through executeRaw, served by gbrain-store `page_body::segmented_writes` and
 * `page_body::segmented_embedding` (rust/docs/store/page_body.md). PGLite and Postgres run them from
 * engine-sql/segmented-writes.ts. Each store write is one store transaction.
 *
 * Owner: the segmented-write lane (rust-engine/fingerprint-v3), which holds the whole file; these five members are copied
 * from it byte-identical. The store keeps one vector column, `embedding`; a member asked for another column refuses,
 * and vectors cross as number arrays.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served.
 */
import type { RetiredChunkVectorRow, SegmentedProjectionPage } from '../../engine-sql/segmented-writes.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

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
