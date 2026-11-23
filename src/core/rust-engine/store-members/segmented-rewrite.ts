/**
 * A segmented page's write statements served from the store (BrainEngine members of engine-members/segmented-writes.ts;
 * SQL in engine-sql/segmented-rewrite.ts): a live fence rewrite's page read and deleted_at restore, and the chunk probes and
 * retirement of a projection (rust/crates/gbrain-store/src/page_body/segment_rewrite.rs). What each answers:
 * rust/docs/store/page_body.md.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const readSegmentedRewritePage: Member<'readSegmentedRewritePage'> = (brain, pageId) =>
  storeCall({ member: 'readSegmentedRewritePage' }, () => brain.readSegmentedRewritePage(pageId)) as ReturnType<BrainEngine['readSegmentedRewritePage']>;

// The SQL arms may hand back a Date for a timestamp column; the store takes ISO text.
export const restorePageDeletedAt: Member<'restorePageDeletedAt'> = async (brain, pageId, deletedAt) => {
  const iso = typeof deletedAt === 'string' ? deletedAt : new Date(deletedAt as never).toISOString();
  await storeCall({ member: 'restorePageDeletedAt' }, () => brain.restorePageDeletedAt(pageId, iso));
};

export const readSegmentedProjectionPage: Member<'readSegmentedProjectionPage'> = (brain, sourceId, slug) =>
  storeCall({ member: 'readSegmentedProjectionPage', sourceId }, () => brain.readSegmentedProjectionPage(sourceId, slug)) as ReturnType<BrainEngine['readSegmentedProjectionPage']>;

export const listChunkedOccurrences: Member<'listChunkedOccurrences'> = (brain, pageId, occurrenceIds, generation) =>
  storeCall({ member: 'listChunkedOccurrences' }, () => brain.listChunkedOccurrences(pageId, [...occurrenceIds], generation)) as Promise<number[]>;

export const hasStaleSegmentChunks: Member<'hasStaleSegmentChunks'> = (brain, pageId, generation, live) =>
  storeCall({ member: 'hasStaleSegmentChunks' }, () => brain.hasStaleSegmentChunks(pageId, generation, [...live])) as Promise<boolean>;

export const retireStaleSegmentChunks: Member<'retireStaleSegmentChunks'> = (brain, pageId, generation, live, maxRows) =>
  storeCall({ member: 'retireStaleSegmentChunks' }, () => brain.retireStaleSegmentChunks(pageId, generation, [...live], maxRows)) as Promise<number>;

export const readSegmentedLivePage: Member<'readSegmentedLivePage'> = (brain, pageId) =>
  storeCall({ member: 'readSegmentedLivePage' }, () => brain.readSegmentedLivePage(pageId)) as ReturnType<BrainEngine['readSegmentedLivePage']>;

// The store keeps one vector column, `embedding`; a member asked for another column refuses. Vectors cross as number arrays.
export const readRetiredChunkVectors: Member<'readRetiredChunkVectors'> = async (brain, pageId, occurrences, column) => {
  if (column !== 'embedding') refuseMember('readRetiredChunkVectors', `column ${column}`);
  if (occurrences.length === 0) return [];
  return await storeCall({ member: 'readRetiredChunkVectors' }, () => brain.readRetiredChunkVectors(pageId, [...occurrences])) as Awaited<ReturnType<BrainEngine['readRetiredChunkVectors']>>;
};
