/**
 * Link reads: the graph counts and endpoint reads that doctor, orphans,
 * graph-query, the entity card, automatic link preparation and two search
 * stages ran through `engine.executeRaw`, once for both engines.
 *
 * Every statement here ran on master from the caller named on its function.
 * They keep master's text and run on master's raw path (`exec.executeRaw`)
 * unscoped, as before. A caller that swallowed a database error still does;
 * a refused capability is never swallowed (engine-capability-refusal.ts).
 */
import type { EntityTypeFilter } from '../schema-pack/entity-types.ts';
import { entityTypePredicateSql } from '../schema-pack/entity-types.ts';
import type { PageReadScope } from '../types.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { privateLinkOriginFilterForCaller, privatePagesFilterForCaller } from '../search/private-visibility.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { CONNECTOR_SOURCE_KINDS } from '../persistence/connector-kinds.ts';
import { getFtsLanguage } from '../fts-language.ts';
import { TEMPORAL_LINK_SELECT_SQL, temporalLinkJoinSql } from '../link-validity.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { readFilter, rows } from './search-reads.ts';

/** Live pages and live pages with an inbound link, optionally in `sourceIds` (doctor graph_signals_coverage). */
export async function inboundLinkCoverage(exec: LegacyUnscopedRead, opts?: { sourceIds?: string[] }): Promise<{ livePages: number; linkedPages: number }> {
  const scope = opts?.sourceIds ? ' AND p.source_id = ANY($1::text[])' : '';
  const params = opts?.sourceIds ? [opts.sourceIds] : undefined;
  const totalRows = await exec.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages p WHERE deleted_at IS NULL${scope}`, params);
  const livePages = Number(totalRows[0]?.n ?? 0);
  if (livePages === 0) return { livePages, linkedPages: 0 };
  const linkedRows = await exec.executeRaw<{ n: number }>(
    `SELECT COUNT(DISTINCT l.to_page_id)::int AS n
       FROM links l
       JOIN pages p ON p.id = l.to_page_id
       WHERE p.deleted_at IS NULL${scope}`,
    params,
  );
  return { livePages, linkedPages: Number(linkedRows[0]?.n ?? 0) };
}

export interface JunkEntityHubRow {
  slug: string;
  source_id: string | null;
  edges: number;
  chunks: number;
  connector_page: boolean;
  source_kind: string | null;
  canonical_twin_source: string | null;
}

/**
 * Live pages with more than `edgeThreshold` link ends (every link, deleted pages' too) and at most `maxChunks`
 * chunks, not marked `junk_hub_exempt: true`, most edges first, at most `limit` (doctor junk_entity_hubs).
 */
export async function listJunkEntityHubs(exec: LegacyUnscopedRead, opts: { edgeThreshold: number; maxChunks: number; limit: number }): Promise<JunkEntityHubRow[]> {
  return rows<JunkEntityHubRow>(exec, sqlFragment`WITH edge_counts AS (
       SELECT page_id, COUNT(*)::int AS edges FROM (
         SELECT from_page_id AS page_id FROM links
         UNION ALL
         SELECT to_page_id AS page_id FROM links
       ) e
       GROUP BY page_id
       HAVING COUNT(*) > ${opts.edgeThreshold}
     ),
     chunk_counts AS (
       -- chunk-visibility-ok: doctor counts every chunk row a page holds, as master did
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
                AND COALESCE(ts.config ->> 'kind', '') <> ALL(${[...CONNECTOR_SOURCE_KINDS]}::text[])
              ORDER BY (t.source_id = 'default') DESC, t.source_id LIMIT 1) AS canonical_twin_source
     FROM edge_counts ec
     JOIN pages p ON p.id = ec.page_id AND p.deleted_at IS NULL
     LEFT JOIN sources s ON s.id = p.source_id
     LEFT JOIN chunk_counts cc ON cc.page_id = ec.page_id
     WHERE COALESCE(cc.chunks, 0) <= ${opts.maxChunks}
       AND COALESCE(p.frontmatter ->> 'junk_hub_exempt', 'false') <> 'true'
     ORDER BY ec.edges DESC
     LIMIT ${opts.limit}`);
}

/**
 * Live entity pages under `filter`: unquarantined ones with `excludeQuarantined` (doctor graph_coverage), in one
 * source with `sourceId` (doctor orphan_ratio).
 */
export async function countEntityPages(exec: LegacyUnscopedRead, filter: EntityTypeFilter, opts?: { sourceId?: string; excludeQuarantined?: boolean }): Promise<number> {
  const isEntity = entityTypePredicateSql('pages', filter);
  const { text, params } = opts?.excludeQuarantined
    ? renderFragment(sqlFragment`SELECT COUNT(*)::int AS count FROM pages WHERE pages.deleted_at IS NULL AND ${isEntity} AND ${trustedSql(quarantineFilterFragment('pages'))}`)
    : renderFragment(sqlFragment`SELECT COUNT(*)::int AS count FROM pages
      WHERE ${isEntity} AND pages.deleted_at IS NULL
        ${opts?.sourceId ? sqlFragment`AND pages.source_id = ${opts.sourceId}::text` : sqlFragment``}`);
  return Number((await exec.executeRaw<{ count: number }>(text, params))[0]?.count ?? 0);
}

/**
 * Over the live unquarantined entity pages that are not test fixtures or the person template: how many there are,
 * how many have a link in or out, and how many have a timeline entry (doctor graph_coverage).
 */
export async function entityGraphCoverage(exec: LegacyUnscopedRead, filter: EntityTypeFilter): Promise<{ entities: number; connected: number; withTimeline: number } | null> {
  const isEntity = entityTypePredicateSql('pages', filter);
  const quarantine = trustedSql(quarantineFilterFragment('pages'));
  const { text, params } = renderFragment(sqlFragment`WITH eligible AS (
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
        (SELECT count(DISTINCT page_id)::int FROM timeline_entries WHERE page_id IN (SELECT id FROM eligible)) AS with_timeline`);
  const row = (await exec.executeRaw<{ entities: number; connected: number; with_timeline: number }>(text, params))[0];
  return row ? { entities: Number(row.entities), connected: Number(row.connected), withTimeline: Number(row.with_timeline) } : null;
}

/** Links of the page (`sourceId`, `slug`) whose other end is in another source, in `direction` (graph-query). */
export async function countForeignEdges(exec: LegacyUnscopedRead, slug: string, sourceId: string, direction: 'in' | 'out' | 'both'): Promise<number> {
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
  const rows = await exec.executeRaw<{ n: string }>(sql, [slug, sourceId]);
  return Number(rows[0]?.n ?? 0);
}

export interface LivePageSummary { slug: string; type: string | null; quarantined: boolean }

/** Every live page `scope` reads, with its type and whether it is quarantined, in no order (orphans' denominator). */
export async function listLivePageSummaries(exec: LegacyUnscopedRead, scope?: PageReadScope): Promise<LivePageSummary[]> {
  const liveParams: unknown[] = [];
  const scopeClause = ` AND ${pageReadFilter('pages', scope, liveParams)}`;
  return exec.executeRaw<LivePageSummary>(
    `SELECT slug, type, (NOT ${quarantineFilterFragment('pages')}) AS quarantined
       FROM pages WHERE deleted_at IS NULL${scopeClause}`,
    liveParams,
  );
}

/**
 * Inbound links of the page (`sourceId`, `slug`) from live pages of the same source, mentions left out (the entity
 * card's backlink_count). With `excludePrivate` the referrer and the link's origin must be readable; an origin must
 * be live, and in the same source with `originSameSource`.
 */
export async function countInboundLinks(exec: LegacyUnscopedRead, slug: string, sourceId: string, opts: { excludePrivate: boolean; originSameSource: boolean }): Promise<number> {
  const privacy = opts.excludePrivate
    ? sqlFragment` AND ${trustedSql(privatePagesFilterForCaller('f'))} AND ${trustedSql(privateLinkOriginFilterForCaller('l'))}`
    : sqlFragment``;
  const originSource = opts.originSameSource ? sqlFragment` AND lo.source_id = ${sourceId}` : sqlFragment``;
  const found = await rows<{ n: string | number }>(exec, sqlFragment`SELECT COUNT(*) AS n
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE t.slug = ${slug} AND t.source_id = ${sourceId} AND f.source_id = ${sourceId} AND f.deleted_at IS NULL
        AND COALESCE(l.link_source, '') <> 'mentions'${privacy} AND (l.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM pages lo WHERE lo.id = l.origin_page_id AND lo.deleted_at IS NULL${originSource}))`);
  return Number(found[0]?.n ?? 0);
}

/** One inbound edge of the entity card, with the raw temporal columns of `TEMPORAL_LINK_SELECT_SQL` (annotateTemporalRow). */
export interface EntityInboundEdgeRow {
  from_slug: string;
  link_type: string;
  context: string | null;
  temporal_ranges: string | null;
  temporal_semantics: string | null;
  temporal_disputed: boolean | null;
  temporal_undated_past: number | null;
  temporal_first_start: string | null;
  temporal_recorded_at: Date | string | null;
  temporal_retired_at: Date | string | null;
}

/**
 * The links countInboundLinks counts, by link id, each with its referrer's slug and its relationship's temporal
 * columns in the `world` scope with `excludePrivate`, else `all` (the entity card's incoming edges).
 */
export async function readEntityInboundEdges(exec: LegacyUnscopedRead, slug: string, sourceId: string, opts: { excludePrivate: boolean; originSameSource: boolean }): Promise<EntityInboundEdgeRow[]> {
  const inboundPrivacy = (opts.excludePrivate
    ? ` AND ${privatePagesFilterForCaller('f')} AND ${privateLinkOriginFilterForCaller('l')}`
    : '') + ` AND (l.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM pages lo WHERE lo.id = l.origin_page_id AND lo.deleted_at IS NULL${opts.originSameSource ? ' AND lo.source_id = $2' : ''}))`;
  return exec.executeRaw<EntityInboundEdgeRow>(
        `SELECT f.slug AS from_slug, l.link_type, l.context${TEMPORAL_LINK_SELECT_SQL}
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
           ${temporalLinkJoinSql('l', opts.excludePrivate)}
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2 AND f.deleted_at IS NULL
            AND COALESCE(l.link_source, '') <> 'mentions'${inboundPrivacy}
          ORDER BY l.id`,
        [slug, sourceId],
      );
}

/**
 * Link endpoints by slug: every live page in the origin source, plus other
 * sources' pages for the slugs the origin lacks or a link names elsewhere ($3).
 * The origin read and each source's residual read use (source_id, slug).
 */
export const LINK_ENDPOINTS_SQL = `WITH own AS (
    SELECT slug, source_id, type, knowledge_revision FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL),
  elsewhere AS (SELECT array_agg(k) AS refs FROM unnest($2::text[]) k WHERE k=ANY($3::text[]) OR NOT EXISTS (SELECT 1 FROM own WHERE own.slug=k))
  SELECT slug, source_id, type, knowledge_revision FROM own
  UNION ALL
  SELECT p.slug, p.source_id, p.type, p.knowledge_revision FROM elsewhere e, sources s, LATERAL (SELECT slug, source_id, type, knowledge_revision
    FROM pages WHERE source_id=s.id AND slug=ANY(e.refs) AND deleted_at IS NULL OFFSET 0) p
  WHERE s.id<>$1`;

export interface LinkEndpointPage { slug: string; source_id: string; type: string; knowledge_revision: string }

/** The live pages LINK_ENDPOINTS_SQL names: the origin source's rows first (automatic link preparation). */
export async function listLinkEndpointPages(exec: LegacyUnscopedRead, sourceId: string, slugs: string[], crossSourceSlugs: string[]): Promise<LinkEndpointPage[]> {
  return exec.executeRaw<LinkEndpointPage>(LINK_ENDPOINTS_SQL, [sourceId, slugs, crossSourceSlugs]);
}

export interface TitledPage { id: number; slug: string; title: string; type: string | null; source_id: string }

/**
 * Pages `scope` reads live whose title (three characters or more) the lowercased query contains, by source and slug,
 * at most 50 (the entity anchor).
 */
export async function listPagesTitledIn(exec: LegacyUnscopedRead, queryLower: string, scope: PageReadScope): Promise<TitledPage[]> {
  // The title match runs first over bare rows; the read filter (page visibility subqueries) then sees only the matches.
  return rows<TitledPage>(exec, sqlFragment`WITH titled AS MATERIALIZED (SELECT id FROM pages WHERE title IS NOT NULL AND length(title) >= 3 AND strpos(${queryLower}, lower(title)) > 0)
     SELECT p.id, p.slug, p.title, p.type, p.source_id FROM pages p
     WHERE p.id IN (SELECT id FROM titled) AND ${readFilter('p', scope, true)}
     ORDER BY p.source_id, p.slug LIMIT 50`);
}

/** Each word to its lexemes under the brain's full-text config, sorted as the tsvector holds them (fact relevance). */
export async function wordLexemes(exec: LegacyUnscopedRead, words: string[]): Promise<Map<string, string[]>> {
  const found = await rows<{ w: string; lexemes: string[] | string | null }>(exec,
    sqlFragment`SELECT w, tsvector_to_array(to_tsvector(${getFtsLanguage()}::regconfig, w)) AS lexemes FROM unnest(${words}::text[]) AS w`);
  return new Map(found.map(r => [r.w,
    Array.isArray(r.lexemes) ? r.lexemes : typeof r.lexemes === 'string' ? r.lexemes.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : []]));
}
