/**
 * The scrubs of a page purge's retrieval stores, name stores and query cache (BrainEngine deletePurgedFeedbackRows,
 * deletePurgedNameStoreRows and clearQueryCache; SQL in engine-sql/purge-stores.ts), served from the store's eval candidate records
 * (gbrain-store `eval_capture.rs scrub_eval_candidate_slugs`; rust/docs/store/pages.md, "The page purge's retrieval, name and cache
 * scrubs").
 *
 * Answered here, without a store call, because the store keeps no such rows:
 * - `deletePurgedFeedbackRows` answers 0 for the retrieval event, link event, rating and weight stores (their keyspaces are reserved
 *   and hold no records) and takes the eval candidate count from the store;
 * - `deletePurgedNameStoreRows` takes the volunteer log's count from the store (rust/docs/store/volunteer-events.md) and answers 0 for
 *   the gazetteer;
 * - `clearQueryCache` answers 0: the store keeps no query cache, so the cache is present and empty, and the purge receipt names no
 *   missing cache, as on a brain whose cache holds no row.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const deletePurgedFeedbackRows: Member<'deletePurgedFeedbackRows'> = async (brain, sourceId, slugs) => ({
  retrieval_event_pages: 0,
  retrieval_event_links: 0,
  retrieval_feedback: 0,
  retrieval_weights: 0,
  'eval_candidates.retrieved_slugs': Number(await storeCall({ member: 'deletePurgedFeedbackRows', sourceId }, () => brain.scrubEvalCandidateSlugs(sourceId, [...slugs]))),
});

export const deletePurgedNameStoreRows: Member<'deletePurgedNameStoreRows'> = async (brain, sourceId, slugs) => ({
  context_volunteer_events: slugs.length === 0 ? 0 : Number(await storeCall({ member: 'deletePurgedNameStoreRows', sourceId }, () => brain.deleteVolunteerEventsForSlugs(sourceId, [...slugs]))),
  mention_gazetteer_entries: 0,
});

export const clearQueryCache: Member<'clearQueryCache'> = async () => 0;
