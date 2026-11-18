/**
 * Facts: the guarded relink writes of `facts` rows. Each function runs the facts update statement facts/relink-publish.ts
 * (the coordinator mutation `relink_facts`) or facts/conversation-relink.ts (`gbrain facts relink --conversation`) ran
 * through `executeRaw`, with the same predicates and parameters; only its home moved. The callers keep their transactions,
 * their page locks and the trust keep (`withTrustKeep`) around these calls.
 *
 * The conversation predicates (`derivedConversationRow`, the live, unlinked and unbacked row tests) live here so the relink
 * planner and this writer read the same text.
 */
import type { SqlExecutor } from './executor.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { ENTITY_LINKABLE_SQL } from '../facts/attribution.ts';
import { unbackedEntitySql } from '../facts/withdrawal-schema.ts';

/** The SQL predicate (on alias `f`, audit sources as `$audit`) of a conversation extractor's derived fact row. */
export const derivedConversationRow = (audit: string) => `f.source LIKE 'cli:extract-conversation-facts%' AND f.source <> ALL(${audit}::text[])`;
/** A live row: not expired, and its validity has not lapsed. */
export const LIVE_FACT_SQL = 'f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())';
/** A live row with no entity. */
export const ACTIVE_UNLINKED_FACT_SQL = `f.entity_slug IS NULL AND ${LIVE_FACT_SQL}`;
/** GBRA-574: a live row on an unbacked name key (`--unbacked`). */
export const UNBACKED_FACT_SQL = `${unbackedEntitySql('f')} AND ${LIVE_FACT_SQL}`;

/**
 * Where relink places one pinned unlinked fact. `link` moves it onto `slug`'s fence at `rowNum`; `retire` expires it, detached
 * onto `slug`, as a duplicate of a row the page already holds. `context` is the row's new context (its relink note appended).
 */
export type RelinkPlacement =
  | { factId: number; action: 'link'; slug: string; rowNum: number; context: string }
  | { factId: number; action: 'retire'; slug: string; context: string };

/** One planned conversation link. A non-empty `from` is the unbacked name key the row moves off; otherwise the row has no entity. */
export interface ConversationFactLink {
  factId: number;
  pageSlug: string;
  fact: string;
  entitySlug: string;
  context: string;
  from: string | null;
}

const UNPLACED = 'WHERE source_id=$1 AND id=$2 AND entity_slug IS NULL AND row_num IS NULL AND source_markdown_slug IS NULL AND expired_at IS NULL RETURNING id';

/** Places a pinned fact that still has no place (no entity, page or row number, not expired). True when the row moved. */
export async function placeRelinkedFact(exec: SqlExecutor, sourceId: string, placement: RelinkPlacement): Promise<boolean> {
  const moved = placement.action === 'link'
    ? await exec.executeRaw(`UPDATE facts SET entity_slug=$3, source_markdown_slug=$3, row_num=$4::integer, context=$5 ${UNPLACED}`,
      [sourceId, placement.factId, placement.slug, placement.rowNum, placement.context])
    : await exec.executeRaw(`UPDATE facts SET entity_slug=$3, expired_at=now(), context=$4 ${UNPLACED}`,
      [sourceId, placement.factId, placement.slug, placement.context]);
  return moved.length === 1;
}

/**
 * Links a conversation page's derived row still exactly as planned (same claim on the page, live, unlinked or on the unbacked
 * key `from`, user or unattributed) to a live page. True when the row was linked.
 */
export async function linkConversationFact(exec: SqlExecutor, sourceId: string, link: ConversationFactLink): Promise<boolean> {
  const done = await exec.executeRaw(
    `UPDATE facts f SET entity_slug = $4, context = $5 WHERE f.source_id = $1 AND f.id = $2 AND f.source_markdown_slug = $3 AND f.fact = $6
        AND ${link.from ? `f.entity_slug = $8 AND ${UNBACKED_FACT_SQL}` : ACTIVE_UNLINKED_FACT_SQL} AND ${ENTITY_LINKABLE_SQL} AND ${derivedConversationRow('$7')}
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = $1 AND p.slug = $4 AND p.deleted_at IS NULL) RETURNING f.id`,
    [sourceId, link.factId, link.pageSlug, link.entitySlug, link.context, link.fact, [...AUDIT_ROW_SOURCES], ...(link.from ? [link.from] : [])]);
  return done.length > 0;
}
