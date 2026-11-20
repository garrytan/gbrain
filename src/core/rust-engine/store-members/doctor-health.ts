/**
 * Doctor reads, health set (src/core/engine-sql/doctor-health.ts), on the Rust engine
 * (rust/docs/store/cli-reads-doctor-health.md). Four kinds of member:
 *  - served from the store's records (rust/crates/gbrain-store/src/cli_reads/doctor_health.rs): the contextual
 *    retrieval coverage, abandoned-thread and orphaned-projection counts;
 *  - answered from the store's key layout, which holds what the SQL catalog reads check for:
 *    `readPagesUpsertArbiter`, `readTimelineDedupIndex`, `readRetrievalTrackingColumn`;
 *  - `countAppliedGradeVerdicts` answers 0 with no store call: the store keeps no `take_grade_cache`, and its only
 *    writer (src/core/cycle/grade-takes.ts) runs raw SQL, which the engine refuses, so no Rust brain holds a verdict;
 *  - `readRequestIndexStates` refuses by name: the store has no request-table indexes, and it finds a request by a
 *    full scan of its request keys (rust/crates/gbrain-store/src/persistence.rs `all_requests`), so no index state
 *    is true. Doctor `persistence_request_indexes` reports health unknown.
 */
import type { BrainEngine } from '../../engine.ts';
import { TIMELINE_DEDUP_INDEX } from '../../engine-sql/doctor-health.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

// ---- served from the store's records ----------------------------------------------------------------------------------

export const countContextualRetrievalCoverage: Member<'countContextualRetrievalCoverage'> = async (brain, markdownChunkerVersion, sourceIds) =>
  storeCall({ member: 'countContextualRetrievalCoverage' }, () => brain.countContextualRetrievalCoverage(markdownChunkerVersion, sourceIds ?? null));
export const countAbandonedThreads: Member<'countAbandonedThreads'> = async (brain, sourceIds) =>
  storeCall({ member: 'countAbandonedThreads' }, () => brain.countAbandonedThreads(sourceIds ?? null));
export const countOrphanedEventProjections: Member<'countOrphanedEventProjections'> = async (brain, sourceIds) =>
  storeCall({ member: 'countOrphanedEventProjections' }, () => brain.countOrphanedEventProjections(sourceIds ?? null));

// ---- answered from the key layout ---------------------------------------------------------------------------------------

/**
 * A page record is keyed by (source, slug): `keys::page` (rust/crates/gbrain-store/src/keys.rs), written by
 * `store_page` (pages.rs); `createSegmentedPageShell` refuses a taken pair with the `pages_source_slug_key` error
 * (page_body.rs), and `rename_page` refuses a taken slug and deletes the old key (pages.rs). So the arbiter is always
 * present and no (source, slug) pair holds two records (the store test `a_source_and_slug_hold_one_page_record`).
 */
export const readPagesUpsertArbiter: Member<'readPagesUpsertArbiter'> = async () =>
  ({ tablePresent: true, arbiterPresent: true, duplicateGroups: 0 });

/**
 * Timeline entries dedup on (page_id, date, md5(summary), source): the store's `timeline_dedup` key
 * (rust/crates/gbrain-store/src/timeline.rs) holds exactly the columns of the v138 index. The definition is the one
 * the SQL engines print for it, so `timeline-dedup-repair.ts` parses the same columns.
 */
export const readTimelineDedupIndex: Member<'readTimelineDedupIndex'> = async () => ({
  tablePresent: true,
  indexdef: `CREATE UNIQUE INDEX ${TIMELINE_DEDUP_INDEX} ON public.timeline_entries USING btree (page_id, date, md5(summary), source)`,
});

/** The store records page retrievals (rust/crates/gbrain-store/src/page_ops/retrievals.rs, `bumpPageRetrievals`), read as `last_retrieved_at`. */
export const readRetrievalTrackingColumn: Member<'readRetrievalTrackingColumn'> = async () => true;

// ---- no store call ------------------------------------------------------------------------------------------------------

/** No `take_grade_cache` on a Rust brain: its only writer runs raw SQL, which the engine refuses. */
export const countAppliedGradeVerdicts: Member<'countAppliedGradeVerdicts'> = async () => 0;

export const readRequestIndexStates: Member<'readRequestIndexStates'> = async () =>
  refuseMember('readRequestIndexStates', 'the store has no request-table indexes; it finds a request by a full scan of its request keys');
