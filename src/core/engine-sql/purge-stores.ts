/**
 * The statements a page purge runs on the stores that hold a page's name outside any foreign key, and on the query cache
 * (feedback/store.ts scrubPurgedSlugs, persistence/purge-name-stores.ts scrubPurgedNameStores and
 * persistence/rebuildable-cache.ts clearRebuildableCache). Each ran through `executeRaw`; SQL once for both engines, so the Rust
 * store serves the same members (src/core/rust-engine/store-members/page-purge-scrubs.ts).
 *
 * Every function takes the engine (or transaction) it runs on. Counts come back as numbers, keyed as the purge receipt names
 * the store. Static text: `$1` the source, `$2` the slugs.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * The delete from the retrieval stores that name a page, and the rewrite of the eval candidates that retrieved it, keyed as the
 * purge receipt names them. A link edge is keyed `from|relation|to`: it names the slug at either end. A candidate keeps a slug a
 * page of another source it covers still holds.
 */
const FEEDBACK_STATEMENTS = {
  retrieval_event_pages: 'DELETE FROM retrieval_event_pages WHERE source_id = $1 AND slug = ANY($2::text[]) RETURNING 1',
  retrieval_event_links: `DELETE FROM retrieval_event_links WHERE source_id = $1 AND (to_slug = ANY($2::text[]) OR EXISTS (SELECT 1 FROM unnest($2::text[]) AS s(slug) WHERE starts_with(edge_key, s.slug || '|') OR right(edge_key, length(s.slug) + 1) = '|' || s.slug)) RETURNING 1`,
  retrieval_feedback: `DELETE FROM retrieval_feedback WHERE source_id = $1
      AND ((element_kind = 'page' AND element_key = ANY($2::text[])) OR (element_kind = 'link' AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS s(slug) WHERE starts_with(element_key, s.slug || '|') OR right(element_key, length(s.slug) + 1) = '|' || s.slug))) RETURNING 1`,
  retrieval_weights: `DELETE FROM retrieval_weights WHERE source_id = $1
      AND ((element_kind = 'page' AND element_key = ANY($2::text[])) OR (element_kind = 'link' AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS s(slug) WHERE starts_with(element_key, s.slug || '|') OR right(element_key, length(s.slug) + 1) = '|' || s.slug))) RETURNING 1`,
  'eval_candidates.retrieved_slugs': `UPDATE eval_candidates
      SET retrieved_slugs = ARRAY(SELECT s FROM unnest(retrieved_slugs) WITH ORDINALITY AS u(s, n) WHERE NOT (u.s = ANY($2::text[]) AND NOT EXISTS (SELECT 1 FROM pages po WHERE po.slug = u.s AND po.source_id = ANY(eval_candidates.source_ids) AND po.source_id <> $1)) ORDER BY n)
      WHERE $1 = ANY(source_ids) AND EXISTS (SELECT 1 FROM unnest(retrieved_slugs) AS r(s) WHERE r.s = ANY($2::text[]) AND NOT EXISTS (SELECT 1 FROM pages po WHERE po.slug = r.s AND po.source_id = ANY(eval_candidates.source_ids) AND po.source_id <> $1)) RETURNING 1`,
} as const;

/** What deletePurgedFeedbackRows removed or rewrote, keyed as the purge receipt names each store. */
export type PurgedFeedbackRows = Record<keyof typeof FEEDBACK_STATEMENTS, number>;

/**
 * Deletes the retrieval rows (events, link events, ratings, weights) that name any of `slugs` in `sourceId`, and strips the slugs
 * from the eval candidates that cover the source; rows removed or rewritten per store. Writes the retrieval stores and
 * eval_candidates; run it in the purge transaction.
 */
export async function deletePurgedFeedbackRows(tx: Raw, sourceId: string, slugs: readonly string[]): Promise<PurgedFeedbackRows> {
  const count = async (sql: string) => (await tx.executeRaw(sql, [sourceId, [...slugs]])).length;
  return {
    retrieval_event_pages: await count(FEEDBACK_STATEMENTS.retrieval_event_pages),
    retrieval_event_links: await count(FEEDBACK_STATEMENTS.retrieval_event_links),
    retrieval_feedback: await count(FEEDBACK_STATEMENTS.retrieval_feedback),
    retrieval_weights: await count(FEEDBACK_STATEMENTS.retrieval_weights),
    'eval_candidates.retrieved_slugs': await count(FEEDBACK_STATEMENTS['eval_candidates.retrieved_slugs']),
  };
}

/** The two stores that keep a page's name beside its slug (#9068), keyed as the purge receipt names them. */
const NAME_STORE_DELETES = {
  context_volunteer_events: 'DELETE FROM context_volunteer_events WHERE source_id = $1 AND slug = ANY($2::text[]) RETURNING 1',
  mention_gazetteer_entries: 'DELETE FROM mention_gazetteer_entries WHERE source_id = $1 AND target_slug = ANY($2::text[]) RETURNING 1',
} as const;

/** What deletePurgedNameStoreRows removed, keyed as the purge receipt names each store. */
export type PurgedNameStoreRows = Record<keyof typeof NAME_STORE_DELETES, number>;

/** Deletes the volunteer log rows and the gazetteer entries of `slugs` in `sourceId`; rows removed per store. Writes both; run it in the purge transaction. */
export async function deletePurgedNameStoreRows(tx: Raw, sourceId: string, slugs: readonly string[]): Promise<PurgedNameStoreRows> {
  const count = async (sql: string) => (await tx.executeRaw(sql, [sourceId, [...slugs]])).length;
  return {
    context_volunteer_events: await count(NAME_STORE_DELETES.context_volunteer_events),
    mention_gazetteer_entries: await count(NAME_STORE_DELETES.mention_gazetteer_entries),
  };
}

/**
 * Empties the query cache (or, with `sourceId`, the rows of that source) and returns the rows removed, or null when the table
 * does not exist. The existence check runs before the delete because a 42P01 inside a Postgres transaction aborts the whole
 * transaction even when caught (#6911). Writes query_cache; run it in the purge transaction. The semantic query cache's
 * clear (search/query-cache.ts SemanticQueryCache.clear) calls it too, with or without a source.
 */
export async function clearQueryCache(tx: Raw, sourceId?: string): Promise<number | null> {
  const [row] = await tx.executeRaw<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', ['query_cache']);
  if (row?.present !== true) return null;
  if (sourceId) return (await tx.executeRaw('DELETE FROM query_cache WHERE source_id = $1 RETURNING 1', [sourceId])).length;
  return (await tx.executeRaw('DELETE FROM query_cache RETURNING 1')).length;
}

/** The scrub members over a raw executor (a transaction handle inside an engine's own SQL), for the purge orchestrators. */
export type PurgeStoreScrubber = Pick<BrainEngine, 'executeRaw' | 'deletePurgedFeedbackRows' | 'deletePurgedNameStoreRows' | 'clearQueryCache'>;
export function purgeStoreScrubber(tx: Raw): PurgeStoreScrubber {
  return {
    executeRaw: tx.executeRaw.bind(tx) as Raw['executeRaw'],
    deletePurgedFeedbackRows: (sourceId, slugs) => deletePurgedFeedbackRows(tx, sourceId, slugs),
    deletePurgedNameStoreRows: (sourceId, slugs) => deletePurgedNameStoreRows(tx, sourceId, slugs),
    clearQueryCache: sourceId => clearQueryCache(tx, sourceId),
  };
}
