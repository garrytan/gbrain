/**
 * Facts: the guarded relink writes of `facts` rows. Each function runs the facts update statement facts/relink-publish.ts
 * (the coordinator mutation `relink_facts`) or facts/conversation-relink.ts (`gbrain facts relink --conversation`) ran
 * through `executeRaw`, with the same predicates and parameters; only its home moved. The callers keep their transactions,
 * their page locks and the trust keep (`withTrustKeep`) around these calls.
 *
 * The conversation predicates (`derivedConversationRow`, the live, unlinked and unbacked row tests) live here so the relink
 * planner and this writer read the same text. `listConversationRelinkPages` is the planner's page pick.
 */
import type { SqlExecutor } from './executor.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { unbackedEntitySql } from '../facts/withdrawal-schema.ts';
import { entityLinkableSql, relinkTriedSql } from './facts-doctor.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

const CONVERSATION_SOURCE_SQL = "f.source LIKE 'cli:extract-conversation-facts%'";
/** The SQL predicate (on alias `f`, audit sources as `$audit`) of a conversation extractor's derived fact row. */
export const derivedConversationRow = (audit: string) => `${CONVERSATION_SOURCE_SQL} AND f.source <> ALL(${audit}::text[])`;
/** `derivedConversationRow` as a fragment that binds the audit sources itself. */
export const derivedConversationFragment = (): SqlFragment =>
  sqlFragment`${trustedSql(CONVERSATION_SOURCE_SQL)} AND f.source <> ALL(${[...AUDIT_ROW_SOURCES]}::text[])`;
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

/** The row is the source's `factId` and still has no place: no entity, page or row number, not expired. */
const unplaced = (sourceId: string, factId: number): SqlFragment => sqlFragment`WHERE source_id=${sourceId} AND id=${factId}
  AND entity_slug IS NULL AND row_num IS NULL AND source_markdown_slug IS NULL AND expired_at IS NULL RETURNING id`;

/** Places a pinned fact that still has no place (no entity, page or row number, not expired). True when the row moved. */
export async function placeRelinkedFact(exec: SqlExecutor, sourceId: string, placement: RelinkPlacement): Promise<boolean> {
  const where = unplaced(sourceId, placement.factId);
  const moved = placement.action === 'link'
    ? await exec.run(sqlFragment`UPDATE facts SET entity_slug=${placement.slug}, source_markdown_slug=${placement.slug}, row_num=${placement.rowNum}::integer, context=${placement.context} ${where}`)
    : await exec.run(sqlFragment`UPDATE facts SET entity_slug=${placement.slug}, expired_at=now(), context=${placement.context} ${where}`);
  return moved.rows.length === 1;
}

/**
 * Links a conversation page's derived row still exactly as planned (same claim on the page, live, unlinked or on the unbacked
 * key `from`, user or unattributed) to a live page. True when the row was linked.
 */
export async function linkConversationFact(exec: SqlExecutor, sourceId: string, link: ConversationFactLink): Promise<boolean> {
  const keyed = link.from ? sqlFragment`f.entity_slug = ${link.from} AND ${trustedSql(UNBACKED_FACT_SQL)}` : sqlFragment`${trustedSql(ACTIVE_UNLINKED_FACT_SQL)}`;
  const done = await exec.run(sqlFragment`UPDATE facts f SET entity_slug = ${link.entitySlug}, context = ${link.context}
      WHERE f.source_id = ${sourceId} AND f.id = ${link.factId} AND f.source_markdown_slug = ${link.pageSlug} AND f.fact = ${link.fact}
        AND ${keyed} AND ${trustedSql(entityLinkableSql())} AND ${derivedConversationFragment()}
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = ${sourceId} AND p.slug = ${link.entitySlug} AND p.deleted_at IS NULL) RETURNING f.id`);
  return done.rows.length > 0;
}

/**
 * Which pages `gbrain facts relink --conversation` takes: `unbacked` picks rows on an unbacked name key, otherwise rows with no
 * entity; `skipTried` leaves out rows the free relink already tried (conversation-memo.ts, the `fact_relink_attempts` record).
 */
export interface ConversationRelinkPagesQuery { limit: number; unbacked: boolean; skipTried: boolean }

/** The pages of the source with the most live, user-or-unattributed derived conversation rows the query picks, most rows first, then by slug in byte order, at most `limit`. */
export async function listConversationRelinkPages(raw: EngineRawRead, sourceId: string, q: ConversationRelinkPagesQuery): Promise<string[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT f.source_markdown_slug AS slug FROM facts f
      WHERE f.source_id = ${sourceId} AND f.source_markdown_slug IS NOT NULL AND ${q.unbacked ? trustedSql(UNBACKED_FACT_SQL) : trustedSql(ACTIVE_UNLINKED_FACT_SQL)} AND ${trustedSql(entityLinkableSql())}
        AND ${derivedConversationFragment()} AND NOT ${trustedSql(relinkTriedSql(q.skipTried))}
      GROUP BY f.source_markdown_slug ORDER BY COUNT(*) DESC, f.source_markdown_slug COLLATE "C" LIMIT ${q.limit}`);
  return (await raw<{ slug: string }>(text, params)).map(r => r.slug);
}
