/**
 * #8821: retrieval logs (feedback store, eval capture) carry page slugs but have no foreign key to `pages`, so a
 * page purge's cascade misses them. After the page row is gone this removes what still names a slug that no page
 * of that source (eval capture: of any source) holds any more. A slug that is live again is left alone.
 */
import type { BrainEngine } from '../engine.ts';

/** A slug of an edge key `from|type|to`, or the whole key for a page element. */
const gone = (expr: string) => `(${expr} = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = t.source_id AND p.slug = ${expr}))`;
const edgeEnds = (col: string) => `${gone(`split_part(t.${col}, '|', 1)`)} OR ${gone(`split_part(t.${col}, '|', 3)`)}`;

export async function purgeRetrievalLogResidue(tx: Pick<BrainEngine, 'executeRaw'>, slugs: readonly string[]): Promise<Record<string, number>> {
  const list = [...new Set(slugs)];
  if (!list.length) return {};
  const count = async (sql: string) => (await tx.executeRaw(sql, [list])).length;
  return {
    retrieval_event_pages: await count(`DELETE FROM retrieval_event_pages t WHERE ${gone('t.slug')} RETURNING 1`),
    retrieval_event_links: await count(`DELETE FROM retrieval_event_links t WHERE ${gone('t.to_slug')} OR ${edgeEnds('edge_key')} RETURNING 1`),
    retrieval_feedback: await count(`DELETE FROM retrieval_feedback t WHERE (t.element_kind = 'page' AND ${gone('t.element_key')}) OR (t.element_kind = 'link' AND (${edgeEnds('element_key')})) RETURNING 1`),
    retrieval_weights: await count(`DELETE FROM retrieval_weights t WHERE (t.element_kind = 'page' AND ${gone('t.element_key')}) OR (t.element_kind = 'link' AND (${edgeEnds('element_key')})) RETURNING 1`),
    eval_candidates: await count(`UPDATE eval_candidates SET retrieved_slugs = ARRAY(SELECT s FROM unnest(retrieved_slugs) AS s WHERE NOT (s = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.slug = s)))
      WHERE retrieved_slugs && $1::text[] RETURNING 1`),
  };
}
