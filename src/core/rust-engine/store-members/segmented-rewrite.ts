/**
 * A segmented page's write statements served from the store (BrainEngine members of engine-members/segmented-writes.ts;
 * SQL in engine-sql/segmented-rewrite.ts): a live fence rewrite's page read and deleted_at restore, and the live page a segmented write
 * diffs against (rust/crates/gbrain-store/src/page_body/segment_rewrite.rs). The chunk probes, the retirement and the retired-vector
 * read are segmented-writes.ts. What each answers:
 * rust/docs/store/page_body.md.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const readSegmentedRewritePage: Member<'readSegmentedRewritePage'> = (brain, pageId) =>
  storeCall({ member: 'readSegmentedRewritePage' }, () => brain.readSegmentedRewritePage(pageId)) as ReturnType<BrainEngine['readSegmentedRewritePage']>;

// The SQL arms may hand back a Date for a timestamp column; the store takes ISO text.
export const restorePageDeletedAt: Member<'restorePageDeletedAt'> = async (brain, pageId, deletedAt) => {
  const iso = typeof deletedAt === 'string' ? deletedAt : new Date(deletedAt as never).toISOString();
  await storeCall({ member: 'restorePageDeletedAt' }, () => brain.restorePageDeletedAt(pageId, iso));
};

export const readSegmentedLivePage: Member<'readSegmentedLivePage'> = (brain, pageId) =>
  storeCall({ member: 'readSegmentedLivePage' }, () => brain.readSegmentedLivePage(pageId)) as ReturnType<BrainEngine['readSegmentedLivePage']>;
