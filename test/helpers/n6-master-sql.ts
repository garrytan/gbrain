/**
 * Master's text for the reads N6 moved behind BrainEngine members (the carry base abefe7f3af, before the move). Each
 * literal below is expanded from the call site by file and line (the line is the one scripts/sql-move-check.mjs reports
 * as the statement's origin); nothing is retyped from the members. The run-time text building each site did around its
 * statement is copied with it.
 *
 * test/n6-sql-move-parity.test.ts runs these against the members in src/core/engine-sql/{facts-doctor,link-reads,
 * writer-versions}.ts and against the `sources` reads that moved to typed source members.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageReadScope } from '../../src/core/types.ts';
import { AUDIT_ROW_SOURCES, NON_EXTRACTABLE_AUDIT_SOURCE, TERMINAL_AUDIT_SOURCE } from '../../src/core/facts/audit-sources.ts';
import { ENTITY_LINKABLE_SQL } from '../../src/core/facts/attribution.ts';
import { conversationPaidSql, conversationTriedSql } from '../../src/core/facts/conversation-memo.ts';
import { eligibleFactEmbedding, partiallyEmbeddedFact, staleFactEmbedding } from '../../src/core/facts/embedding-identity.ts';
import { boundedBodyPrefixSql } from '../../src/core/page-window/bounded-lead.ts';
import { entityTypePredicateSql, type EntityTypeFilter } from '../../src/core/schema-pack/entity-types.ts';
import { renderFragment, sqlFragment, trustedSql } from '../../src/core/engine-sql/fragment.ts';
import { quarantineFilterFragment } from '../../src/core/quarantine.ts';
import { pageReadFilter } from '../../src/core/search/read-policy-sql.ts';
import { privateLinkOriginFilterForCaller, privatePagesFilterForCaller } from '../../src/core/search/private-visibility.ts';
import { TEMPORAL_LINK_SELECT_SQL, temporalLinkJoinSql } from '../../src/core/link-validity.ts';
import { CONNECTOR_KINDS_SQL } from '../../src/core/persistence/connector-kinds.ts';
import { getFtsLanguage } from '../../src/core/fts-language.ts';

type Q = Pick<BrainEngine, 'executeRaw'>;
type Row = Record<string, unknown>;

// ------------------------------------------------------------------ facts statements (doctor checks)

/** src/commands/doctor/checks/conversation-outcomes.ts:27. */
export const conversationOutcomeRows = (e: Q, sources: string[], limit: number) => e.executeRaw<Row>(
      `SELECT source_id, source_markdown_slug AS slug, context FROM facts
        WHERE source_id = ANY($1::text[]) AND source LIKE 'cli:extract-conversation-facts%' AND source = ANY($2::text[]) AND expired_at IS NULL
        ORDER BY id DESC LIMIT $3`, [sources, [TERMINAL_AUDIT_SOURCE, NON_EXTRACTABLE_AUDIT_SOURCE], limit]);

/** src/commands/doctor/checks/facts-redaction-marker.ts:15. */
export const redactedFactRows = (e: Q, sourceIds?: string[]) => e.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n FROM facts f
      WHERE f.expired_at IS NULL AND f.superseded_by IS NULL AND f.fact LIKE '%[redacted%'
        AND f.source_id IN (SELECT id FROM sources WHERE archived IS NOT TRUE AND ($1::text[] IS NULL OR id=ANY($1::text[])))`, [sourceIds ?? null]);

/** src/commands/doctor/checks/outside-content-fences.ts:26. */
export const outsideContentFenceRows = (e: Q) => e.executeRaw<Row>(
      `SELECT p.source_id, p.slug, p.type, sum(x.facts)::int AS facts, sum(x.world_facts)::int AS world_facts,
              sum(x.takes)::int AS takes, sum(x.links)::int AS links
         FROM (SELECT fp.id AS page_id, 1 AS facts, CASE WHEN f.visibility = 'world' THEN 1 ELSE 0 END AS world_facts, 0 AS takes, 0 AS links
                 FROM facts f JOIN pages fp ON fp.source_id = f.source_id AND fp.slug = f.source_markdown_slug
                WHERE f.row_num IS NOT NULL AND f.expired_at IS NULL
               UNION ALL SELECT t.page_id, 0, 0, 1, 0 FROM takes t WHERE t.active
               UNION ALL SELECT l.origin_page_id, 0, 0, 0, 1 FROM links l WHERE l.origin_field = 'links_fence') x
         JOIN pages p ON p.id = x.page_id
         JOIN sources s ON s.id = p.source_id
        WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE
          AND ((s.config->>'kind' = 'google' AND p.type IN ('email', 'meeting')) OR s.config->>'kind' = 'github'
               OR p.frontmatter ? 'transcript_import')
        GROUP BY p.source_id, p.slug, p.type
        ORDER BY p.source_id, p.slug`);

/** src/commands/doctor/checks/queue-assets.ts:58. */
export const atomFactRows = (e: Q) => e.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM facts
          WHERE expired_at IS NULL AND (source_markdown_slug LIKE 'atoms/%' OR context LIKE 'atoms/%')`);

/** src/commands/doctor/checks/trust-release-unpreviewed.ts:21 (`LIMIT ${LIMIT}`, interpolated by the caller). */
export const unpreviewedTrustRows = (e: Q, LIMIT: number) => e.executeRaw<Row>(
      `SELECT f.id, f.source_id, f.source_markdown_slug AS slug, f.row_num, h.id AS hold_id, COUNT(*) OVER () AS total
         FROM facts f JOIN LATERAL (SELECT id FROM write_gate_holds WHERE kind = 'fact' AND status = 'released' AND source_id = f.source_id
          AND slug = f.source_markdown_slug AND payload->>'row_num' = f.row_num::text
          AND request_id::text IS NOT DISTINCT FROM f.write_origin->>'request_id' ORDER BY id DESC LIMIT 1) h ON true
        WHERE f.trust_tier = 'user_confirmed' AND f.expired_at IS NULL AND f.write_origin->>'channel' = 'trust_release'
          AND f.write_origin->>'fields_previewed' IS NULL
        ORDER BY f.id LIMIT ${LIMIT}`);

// src/commands/doctor/checks/unlinked-facts.ts: the constants the statements splice.
const DERIVED = `f.source LIKE 'cli:extract-conversation-facts%'`;
const ACTIVE = `f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now()) AND f.source <> ALL($2::text[]) AND ${ENTITY_LINKABLE_SQL}`;
const ORIGIN = `CASE WHEN ${DERIVED} THEN 'conversation' WHEN f.source = 'mcp:put_page' THEN 'mcp:put_page'
  WHEN f.source LIKE 'mcp:%' OR f.source LIKE 'sync:%' OR f.source LIKE 'hook:%' OR f.source IN ('file_upload', 'code_import') THEN 'extraction'
  ELSE 'remember' END`;
const INFERRED = `(f.context LIKE 'entity inferred from %' OR f.context LIKE '% — entity inferred from %')`;
const INFERRED_TIER = `substring(f.context from 'entity inferred from ([a-z]+)')`;

/** src/commands/doctor/checks/unlinked-facts.ts:79. */
export const factTableCatalogRows = (e: Q) => e.executeRaw<{ facts: string | null; attempts: string | null }>(
    `SELECT to_regclass('facts')::text AS facts, to_regclass('fact_relink_attempts')::text AS attempts`);

/** src/commands/doctor/checks/unlinked-facts.ts:87 (`ids`, `audit` and `UNLINKED_WINDOW_PER_SOURCE` as the caller computed them). */
export function unlinkedOriginRows(e: Q, ids: string[], audit: string[], UNLINKED_WINDOW_PER_SOURCE: number, hasAttempts: boolean) {
  const tried = hasAttempts ? conversationTriedSql : 'false';
  const paid = hasAttempts ? conversationPaidSql : 'false';
  return e.executeRaw<Row>(
    `SELECT s.id AS source_id, w.origin, COUNT(*)::int AS active, COUNT(*) FILTER (WHERE w.unlinked)::int AS unlinked,
            COUNT(*) FILTER (WHERE w.unlinked AND w.fence_owned AND NOT w.derived)::int AS fence_owned,
            COUNT(*) FILTER (WHERE w.unlinked AND w.derived)::int AS conversation,
            COUNT(*) FILTER (WHERE w.unlinked AND w.derived AND w.tried)::int AS conversation_tried,
            COUNT(*) FILTER (WHERE w.unlinked AND w.derived AND w.tried AND w.paid)::int AS conversation_paid
       FROM unnest($1::text[]) AS s(id) CROSS JOIN LATERAL (
         SELECT ${ORIGIN} AS origin, f.entity_slug IS NULL AS unlinked, ${DERIVED} AS derived,
                CASE WHEN f.entity_slug IS NULL AND ${DERIVED} THEN ${tried} ELSE false END AS tried,
                CASE WHEN f.entity_slug IS NULL AND ${DERIVED} THEN ${paid} ELSE false END AS paid,
                (f.row_num IS NOT NULL OR f.source_markdown_slug IS NOT NULL) AS fence_owned
           FROM facts f WHERE f.source_id = s.id AND ${ACTIVE}
          ORDER BY f.created_at DESC LIMIT $3) w
      GROUP BY s.id, w.origin`,
    [ids, audit, UNLINKED_WINDOW_PER_SOURCE],
  );
}

/** src/commands/doctor/checks/unlinked-facts.ts:116. */
export function unlinkedFactStatRows(e: Q, ids: string[], audit: string[], hasAttempts: boolean) {
  const tried = hasAttempts ? conversationTriedSql : 'false';
  const judged = hasAttempts
    ? `EXISTS (SELECT 1 FROM fact_relink_attempts a WHERE a.source_id = f.source_id AND a.fact_id = f.id AND a.outcome = 'no_subject')`
    : 'false';
  return e.executeRaw<Row>(
    `SELECT COUNT(*)::int AS facts, COUNT(*) FILTER (WHERE f.entity_slug IS NULL)::int AS unlinked,
            COUNT(*) FILTER (WHERE f.entity_slug IS NULL AND ${judged})::int AS no_subject,
            COUNT(*) FILTER (WHERE f.entity_slug IS NULL AND ${tried})::int AS conversation_unresolved,
            COUNT(*) FILTER (WHERE ${INFERRED} AND ${INFERRED_TIER} = 'page')::int AS inferred_page,
            COUNT(*) FILTER (WHERE ${INFERRED} AND ${INFERRED_TIER} = 'mention')::int AS inferred_mention
       FROM facts f WHERE f.source_id = ANY($1::text[]) AND f.created_at >= now() - interval '7 days' AND ${ACTIVE}`,
    [ids, audit],
  );
}

/** src/commands/doctor/checks/unlinked-facts.ts:128. */
export const factRelinkOutcomeRows = (e: Q, ids: string[]) => e.executeRaw<Row>(
      `SELECT outcome, tier, COUNT(*)::int AS n FROM fact_relink_attempts
        WHERE source_id = ANY($1::text[])
          AND (outcome = 'no_subject' OR (outcome = 'linked' AND attempted_at >= now() - interval '7 days'))
        GROUP BY outcome, tier`,
      [ids],
    );

/** src/commands/doctor/checks/unlinked-facts.ts:144 (`hitSql` as the caller chose it from the fix kind). */
export function unlinkedConversationSlugRows(e: Q, sourceId: string, audit: string[], UNLINKED_WINDOW_PER_SOURCE: number, fixKind: 'relink' | 'reextract' | 'manual', hasAttempts: boolean) {
  const tried = hasAttempts ? conversationTriedSql : 'false';
  const paid = hasAttempts ? conversationPaidSql : 'false';
  const hitSql = { relink: `NOT ${tried}`, reextract: `${tried} AND NOT ${paid}`, manual: `${tried} AND ${paid}` }[fixKind];
  return e.executeRaw<{ slug: string }>(
      `SELECT w.slug FROM (SELECT f.source_markdown_slug AS slug, f.entity_slug IS NULL AND ${DERIVED} AND ${hitSql} AS hit
           FROM facts f WHERE f.source_id = $1 AND ${ACTIVE} ORDER BY f.created_at DESC LIMIT $3) w
        WHERE w.hit AND w.slug IS NOT NULL GROUP BY w.slug ORDER BY COUNT(*) DESC, w.slug`,
      [sourceId, audit, UNLINKED_WINDOW_PER_SOURCE],
    );
}

/** src/commands/doctor/checks/vector-coverage.ts:46. */
export const factEmbeddingCoverageRows = (e: Q, sourceId: string | null, model: string, dims: number) => e.executeRaw<Row>(
      `SELECT f.source_id, count(*) FILTER (WHERE f.embedding IS NULL)::int AS missing,
              count(*) FILTER (WHERE ${staleFactEmbedding})::int AS stale,
              count(*) FILTER (WHERE NOT ${staleFactEmbedding} AND ${partiallyEmbeddedFact})::int AS partial
         FROM facts f WHERE ($1::text IS NULL OR f.source_id = $1) AND ${eligibleFactEmbedding}
        GROUP BY f.source_id`,
      [sourceId, [...AUDIT_ROW_SOURCES], model, dims]);

/** src/core/facts/embedding-identity.ts:42 (countStaleFactEmbeddings), with its row mapping. */
export async function staleFactEmbeddingCount(e: Q, model: string, dimensions: number, sourceId?: string) {
  const [row] = await e.executeRaw<{ count: number; chars: string }>(`SELECT count(*)::int AS count,
    COALESCE(sum(length(f.fact)),0)::text AS chars FROM facts f
    WHERE ($1::text IS NULL OR f.source_id=$1) AND ${eligibleFactEmbedding} AND ${staleFactEmbedding}`,
  [sourceId ?? null, [...AUDIT_ROW_SOURCES], model, dimensions]);
  return { count: Number(row!.count), chars: Number(row!.chars) };
}

/** src/commands/doctor/checks/fence-integrity.ts:192. */
export const segmentedCensusRows = (e: Q, sourceIds: string[], checkedOut: string[]) => e.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages
    WHERE deleted_at IS NULL AND page_kind = 'markdown' AND body_storage = 'segmented' AND source_id = ANY($1::text[])
      AND (source_path IS NULL OR NOT (source_id = ANY($2::text[])))`,
    [sourceIds, checkedOut]);

/** src/commands/doctor/checks/facts-pages.ts:26. */
export const factsPageBodyRows = (e: Q) => e.executeRaw<Row>(
      `SELECT p.slug, p.source_id, p.body_storage = 'segmented' AS segmented, ${boundedBodyPrefixSql('p')} AS body
         FROM pages p WHERE p.type = 'facts' AND p.deleted_at IS NULL ORDER BY p.source_id, p.slug`);

// ------------------------------------------------------------------ link statements

/** src/commands/doctor/checks/graph-embedding.ts:80 and :92 (the two reads of graph_signals_coverage). */
export async function inboundCoverageRows(e: Q, opts?: { sourceIds?: string[] }) {
  const scope = opts?.sourceIds ? ' AND p.source_id = ANY($1::text[])' : '';
  const params = opts?.sourceIds ? [opts.sourceIds] : undefined;
  const totalRows = await e.executeRaw(`SELECT COUNT(*)::int AS n FROM pages p WHERE deleted_at IS NULL${scope}`, params);
  const linkedRows = await e.executeRaw(
      `SELECT COUNT(DISTINCT l.to_page_id)::int AS n
       FROM links l
       JOIN pages p ON p.id = l.to_page_id
       WHERE p.deleted_at IS NULL${scope}`,
      params,
    );
  return { livePages: Number((totalRows as any)[0]?.n ?? 0), linkedPages: Number((linkedRows as any)[0]?.n ?? 0) };
}

/** src/commands/doctor/checks/graph-embedding.ts:476 (`JUNK_HUB_LIMIT + 1` is the caller's `limit`). */
export const junkEntityHubRows = (e: Q, edgeThreshold: number, maxChunks: number, limitPlusOne: number) => e.executeRaw<Row>(
      `WITH edge_counts AS (
         SELECT page_id, COUNT(*)::int AS edges FROM (
           SELECT from_page_id AS page_id FROM links
           UNION ALL
           SELECT to_page_id AS page_id FROM links
         ) e
         GROUP BY page_id
         HAVING COUNT(*) > $1
       ),
       chunk_counts AS (
         SELECT page_id, COUNT(*)::int AS chunks
         FROM content_chunks
         GROUP BY page_id
       )
       SELECT p.slug, p.source_id, ec.edges, COALESCE(cc.chunks, 0)::int AS chunks,
              (p.frontmatter ->> 'google_contact_id') IS NOT NULL AS connector_page,
              s.config ->> 'kind' AS source_kind,
              (SELECT t.source_id FROM pages t LEFT JOIN sources ts ON ts.id = t.source_id
                WHERE t.slug = p.slug AND t.source_id <> p.source_id AND t.deleted_at IS NULL
                  AND (t.frontmatter ->> 'google_contact_id') IS NULL
                  AND COALESCE(ts.config ->> 'kind', '') NOT IN (${CONNECTOR_KINDS_SQL})
                ORDER BY (t.source_id = 'default') DESC, t.source_id LIMIT 1) AS canonical_twin_source
       FROM edge_counts ec
       JOIN pages p ON p.id = ec.page_id AND p.deleted_at IS NULL
       LEFT JOIN sources s ON s.id = p.source_id
       LEFT JOIN chunk_counts cc ON cc.page_id = ec.page_id
       WHERE COALESCE(cc.chunks, 0) <= $2
         AND COALESCE(p.frontmatter ->> 'junk_hub_exempt', 'false') <> 'true'
       ORDER BY ec.edges DESC
       LIMIT $3`,
      [edgeThreshold, maxChunks, limitPlusOne]);

/** src/commands/doctor/checks/graph-health.ts:48 (graph_coverage) and :183 (orphan_ratio). */
export async function entityCountRows(e: Q, filter: EntityTypeFilter, opts?: { sourceId?: string; excludeQuarantined?: boolean }) {
  const isEntity = entityTypePredicateSql('pages', filter);
  if (opts?.excludeQuarantined) {
    const quarantine = trustedSql(quarantineFilterFragment('pages'));
    const countSql = renderFragment(sqlFragment`SELECT COUNT(*)::int AS count FROM pages WHERE pages.deleted_at IS NULL AND ${isEntity} AND ${quarantine}`);
    return (await e.executeRaw<{ count: number }>(countSql.text, countSql.params))[0]?.count ?? 0;
  }
  const srcId = opts?.sourceId;
  const countSql = renderFragment(sqlFragment`SELECT COUNT(*)::int AS count FROM pages
      WHERE ${entityTypePredicateSql('pages', filter)} AND pages.deleted_at IS NULL
        ${srcId ? sqlFragment`AND pages.source_id = ${srcId}::text` : sqlFragment``}`);
  return (await e.executeRaw<{ count: number }>(countSql.text, countSql.params))[0]?.count ?? 0;
}

/** src/commands/doctor/checks/graph-health.ts:61. */
export async function entityGraphCoverageRows(e: Q, filter: EntityTypeFilter) {
  const isEntity = entityTypePredicateSql('pages', filter);
  const quarantine = trustedSql(quarantineFilterFragment('pages'));
  const eligibleSql = renderFragment(sqlFragment`WITH eligible AS (
        SELECT pages.id FROM pages
        WHERE pages.deleted_at IS NULL
          AND ${isEntity}
          AND ${quarantine}
          AND pages.slug NOT LIKE 'tools/gbrain/test/%'
          AND pages.slug <> 'templates/new-person'
      )
      SELECT
        (SELECT count(*)::int FROM eligible) AS entities,
        (SELECT count(*)::int FROM eligible e
           WHERE EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = e.id)
              OR EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = e.id)) AS connected,
        (SELECT count(DISTINCT page_id)::int FROM timeline_entries WHERE page_id IN (SELECT id FROM eligible)) AS timeline`);
  const row = (await e.executeRaw<{ entities: number; connected: number; timeline: number }>(eligibleSql.text, eligibleSql.params))[0];
  return row ? { entities: Number(row.entities), connected: Number(row.connected), withTimeline: Number(row.timeline) } : null;
}

/** src/commands/graph-query.ts:133 (in), :141 (both) and :149 (out). */
export async function foreignEdgeRows(e: Q, rootSlug: string, direction: 'in' | 'out' | 'both', sourceId: string) {
  const sql = direction === 'in'
    ? `SELECT COUNT(*)::text AS n
         FROM links l
         JOIN pages fp ON l.from_page_id = fp.id
         JOIN pages tp ON l.to_page_id = tp.id
        WHERE tp.slug = $1 AND tp.source_id = $2
          AND fp.source_id IS NOT NULL
          AND fp.source_id <> tp.source_id`
    : direction === 'both'
    ? `SELECT COUNT(*)::text AS n
         FROM links l
         JOIN pages fp ON l.from_page_id = fp.id
         JOIN pages tp ON l.to_page_id = tp.id
        WHERE ((fp.slug = $1 AND fp.source_id = $2) OR (tp.slug = $1 AND tp.source_id = $2))
          AND fp.source_id IS NOT NULL
          AND tp.source_id IS NOT NULL
          AND fp.source_id <> tp.source_id`
    : `SELECT COUNT(*)::text AS n
         FROM links l
         JOIN pages fp ON l.from_page_id = fp.id
         JOIN pages tp ON l.to_page_id = tp.id
        WHERE fp.slug = $1 AND fp.source_id = $2
          AND tp.source_id IS NOT NULL
          AND fp.source_id <> tp.source_id`;
  const rows = await e.executeRaw<{ n: string }>(sql, [rootSlug, sourceId]);
  return Number(rows[0]?.n ?? 0);
}

/** src/commands/orphans.ts:177 (`opts` is the orphan options, of which the page read scope is read). */
export function livePageRows(e: Q, opts: PageReadScope) {
  const liveParams: unknown[] = [];
  const scopeClause = ` AND ${pageReadFilter('pages', opts, liveParams)}`;
  return e.executeRaw<Row>(
      `SELECT slug, type, (NOT ${quarantineFilterFragment('pages')}) AS quarantined
         FROM pages WHERE deleted_at IS NULL${scopeClause}`,
      liveParams,
    );
}

/** src/core/verbs/entity-card.ts: the `inboundPrivacy` text, built with `remote` = whether the origin must share the source. */
function inboundPrivacy(excludePrivate: boolean, remote: boolean): string {
  return (excludePrivate
    ? ` AND ${privatePagesFilterForCaller('f')} AND ${privateLinkOriginFilterForCaller('l')}`
    : '') + ` AND (l.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM pages lo WHERE lo.id = l.origin_page_id AND lo.deleted_at IS NULL${remote ? ' AND lo.source_id = $2' : ''}))`;
}

/** src/core/verbs/entity-card.ts:625 (the incoming edges). */
export const inboundEdgeRows = (e: Q, pageSlug: string, sourceId: string, excludePrivate: boolean, remote: boolean) => e
      .executeRaw<Row>(
        `SELECT f.slug AS from_slug, l.link_type, l.context${TEMPORAL_LINK_SELECT_SQL}
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
           ${temporalLinkJoinSql('l', excludePrivate)}
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2 AND f.deleted_at IS NULL
            AND COALESCE(l.link_source, '') <> 'mentions'${inboundPrivacy(excludePrivate, remote)}
          ORDER BY l.id`,
        [pageSlug, sourceId],
      );

/** src/core/verbs/entity-card.ts:639 (backlink_count). */
export const inboundCountRows = (e: Q, pageSlug: string, sourceId: string, excludePrivate: boolean, remote: boolean) => e
      .executeRaw<{ n: string | number }>(
        `SELECT COUNT(*) AS n
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2 AND f.deleted_at IS NULL
            AND COALESCE(l.link_source, '') <> 'mentions'${inboundPrivacy(excludePrivate, remote)}`,
        [pageSlug, sourceId],
      );

/** src/core/persistence/links-preparation.ts:80 (LINK_ENDPOINTS_SQL), run as the caller ran it. */
export const LINK_ENDPOINTS_SQL = `WITH own AS (
    SELECT slug, source_id, type, knowledge_revision FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL),
  elsewhere AS (SELECT array_agg(k) AS refs FROM unnest($2::text[]) k WHERE k=ANY($3::text[]) OR NOT EXISTS (SELECT 1 FROM own WHERE own.slug=k))
  SELECT slug, source_id, type, knowledge_revision FROM own
  UNION ALL
  SELECT p.slug, p.source_id, p.type, p.knowledge_revision FROM elsewhere e, sources s, LATERAL (SELECT slug, source_id, type, knowledge_revision
    FROM pages WHERE source_id=s.id AND slug=ANY(e.refs) AND deleted_at IS NULL OFFSET 0) p
  WHERE s.id<>$1`;
export const linkEndpointRows = (e: Q, sourceId: string, slugs: string[], cross: string[]) => e.executeRaw<Row>(LINK_ENDPOINTS_SQL, [sourceId, slugs, cross]);

/** src/core/search/entity-anchor.ts:82 (namedEntity). */
export function titledPageRows(e: Q, queryLower: string, scope: PageReadScope) {
  const params: unknown[] = [queryLower];
  const filter = pageReadFilter('p', scope, params, true);
  return e.executeRaw<Row>(
    `WITH titled AS MATERIALIZED (SELECT id FROM pages WHERE title IS NOT NULL AND length(title) >= 3 AND strpos($1, lower(title)) > 0)
     SELECT p.id, p.slug, p.title, p.type, p.source_id FROM pages p
     WHERE p.id IN (SELECT id FROM titled) AND ${filter}
     ORDER BY p.source_id, p.slug LIMIT 50`, params);
}

/** src/core/search/fact-relevance.ts:167 (wordStems), before it filters the lexemes. */
export const wordLexemeRows = (e: Q, words: string[]) => e.executeRaw<{ w: string; lexemes: string[] | string | null }>(
      `SELECT w, tsvector_to_array(to_tsvector('${getFtsLanguage()}'::regconfig, w)) AS lexemes FROM unnest($1::text[]) AS w`, [words]);

/** An ask of worldLinkContexts: the row index, the stored edge and the returned context. */
export interface Ask { i: number; fromSourceId: string; fromSlug: string; toSourceId: string; toSlug: string; linkType: string; context: string }

/** src/core/eligibility/fence-overlay.ts:345. */
export const linkContextMatchRows = (e: Q, asked: Ask[]) => e.executeRaw<Row>(
      `SELECT u.i, l.link_source, l.context, e.id AS page_id
       FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS u(i, fs, fslug, ts, tslug, lt, ctx)
       JOIN pages f ON f.source_id = u.fs AND f.slug = u.fslug
       JOIN pages t ON t.source_id = u.ts AND t.slug = u.tslug
       JOIN links l ON l.from_page_id = f.id AND l.to_page_id = t.id AND l.link_type = u.lt
         AND (l.context = u.ctx OR (right(u.ctx, 1) = '…' AND left(l.context, char_length(u.ctx) - 1) = left(u.ctx, char_length(u.ctx) - 1)))
       LEFT JOIN pages e ON e.id = COALESCE(l.origin_page_id, l.from_page_id) AND e.deleted_at IS NULL`,
      [asked.map(a => a.i), asked.map(a => a.fromSourceId), asked.map(a => a.fromSlug), asked.map(a => a.toSourceId),
        asked.map(a => a.toSlug), asked.map(a => a.linkType), asked.map(a => a.context)]);

/** src/core/eligibility/fence-overlay.ts:358. */
export const linkContextOriginRows = (e: Q, pageIds: number[]) => e.executeRaw<Row>(
      `SELECT id, source_id, slug, compiled_truth, timeline FROM pages
       WHERE id = ANY($1::bigint[]) AND body_storage IS DISTINCT FROM 'segmented'`, [pageIds]);

// ------------------------------------------------------------------ writer versions

/** src/commands/doctor/checks/writer-version.ts:16. */
export const writerVersionCutoffRows = (e: Q) => e.executeRaw<{ cutoff: unknown }>('SELECT writer_version_cutoff AS cutoff FROM persistence_brain WHERE singleton=1');

/** src/core/persistence/writer-versions.ts:51 (listWriterVersions), before its row mapping. */
export const writerVersionRows = (e: Q, limit: number) => e.executeRaw<Row>(
    `SELECT * FROM (
      SELECT DISTINCT ON (admitter_host_id,principal_kind,principal_id) 'admitter' AS role,admitter_host_id::text AS host_id,
        principal_kind||':'||principal_id AS principal,admitter_version AS version,created_at AS last_seen
      FROM persistence_requests ORDER BY admitter_host_id,principal_kind,principal_id,created_at DESC) a
    UNION ALL SELECT * FROM (
      SELECT DISTINCT ON (consumer_host_id,principal_kind,principal_id) 'consumer' AS role,consumer_host_id::text AS host_id,
        principal_kind||':'||principal_id AS principal,consumer_version AS version,COALESCE(published_at,completed_at) AS last_seen
      FROM persistence_requests WHERE state='committed'
      ORDER BY consumer_host_id,principal_kind,principal_id,COALESCE(published_at,completed_at) DESC) c
    ORDER BY last_seen DESC LIMIT $1`, [limit]);

/** src/core/persistence/writer-versions.ts:75 (recentWriterVersions), before its row mapping. */
export const recentWriterVersionRows = (e: Q, days: number) => e.executeRaw<Row>(
    `WITH cutoff AS (SELECT writer_version_cutoff AS at FROM persistence_brain WHERE singleton=1 AND writer_version_cutoff IS NOT NULL),
    recent AS (SELECT r.*,COALESCE(r.published_at,r.completed_at) AS publication FROM persistence_requests r
      WHERE r.state='committed' AND COALESCE(r.published_at,r.completed_at)>=now()-($1::double precision*interval '1 day'))
    SELECT 'admitter' AS role,r.admitter_host_id::text AS host_id,r.principal_kind||':'||r.principal_id AS principal,
      r.admitter_version AS version,MAX(r.created_at) AS last_seen,COUNT(*)::integer AS requests
    FROM recent r CROSS JOIN cutoff c WHERE r.created_at>=c.at GROUP BY 2,3,4
    UNION ALL
    SELECT 'consumer' AS role,COALESCE(r.consumer_host_id,w.owner_host_id)::text AS host_id,r.principal_kind||':'||r.principal_id AS principal,
      r.consumer_version AS version,MAX(r.publication) AS last_seen,COUNT(*)::integer AS requests
    FROM recent r LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id CROSS JOIN cutoff c WHERE r.publication>=c.at GROUP BY 2,3,4
    ORDER BY last_seen DESC`, [days]);

// ------------------------------------------------------------------ source reads that moved to typed members

/** The `sources` reads of conversation-outcomes, stale.ts, orphans.ts, file-modes.ts, loops.ts and graph-rank.ts. */
export const liveSourceIdRows = (e: Q) => e.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id');
export const allSourceIdRows = (e: Q) => e.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id');
export const notArchivedSourceIdRows = (e: Q) => e.executeRaw<{ id: string }>('SELECT id FROM sources WHERE NOT archived ORDER BY id');
/** src/commands/orphans.ts:68. */
export const connectorKindRows = (e: Q) => e.executeRaw<{ id: string; kind: string | null }>(`SELECT id, config->>'kind' AS kind FROM sources`);
/** src/core/google/file-modes.ts:77. */
export const googleSourceRows = (e: Q) => e.executeRaw<{ id: string; local_path: string | null; config: Record<string, unknown> }>(
    "SELECT id, local_path, config FROM sources WHERE archived IS NOT TRUE AND config->>'kind'='google' ORDER BY id");
/** src/core/ops/loops.ts (the config of one source, the live sources' sync clocks, the incarnations of listed sources). */
export const sourceConfigRows = (e: Q, sourceId: string) => e.executeRaw<{ config: unknown }>(`SELECT config FROM sources WHERE id = $1`, [sourceId]);
export const liveSourceClockRows = (e: Q) => e.executeRaw<{ id: string; last_sync_at: string | null; config: unknown }>(
      `SELECT id, last_sync_at, config FROM sources WHERE archived IS NOT TRUE`, []);
export const sourceIncarnationRows = (e: Q, ids: string[]) => e.executeRaw<{ id: string; incarnation: string; local_path: string | null; config: Record<string, unknown> }>(
      `SELECT id, incarnation::text AS incarnation, local_path, config FROM sources WHERE id = ANY(string_to_array($1, E'\\n'))`,
      [ids.join('\n')]);
/** src/commands/status.ts (buildLocalReport): every source with its name, path and config. */
export const statusSourceRows = (e: Q) => e.executeRaw<{ id: string; name: string; local_path: string | null; config: unknown }>(`SELECT id, name, local_path, config FROM sources ORDER BY id`);
