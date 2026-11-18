/**
 * Read-command statements that ran through `engine.executeRaw` from the ops
 * layer (docs/research/rust-cli-executeraw-map.md, "Read-command queries"):
 * search-exact, wanted, whois, rank-entities and extraction-pending.
 *
 * Every function takes the engine's own `executeRaw`, so each statement runs
 * on exactly the path it ran on before it moved here: on Postgres a
 * `timeoutMs` read runs under a transaction-local statement_timeout and a
 * `jitOff` read with JIT disabled; PGLite runs every read as one statement.
 * The statements and their parameters are unchanged; only their home moved.
 */
import { buildExactBatchStatement, type ExactBatchRow, type ExactScanOpts } from '../search/exact-scan.ts';
import { exactIdentityStatement, type ExactIdentityRow, type ExactIdentityStatementOpts } from './exact-identity.ts';
import { rankEntitiesStatement, type RankEntitiesStatementOpts, type RankEntityRow } from './graph-rank.ts';
import { unverifiedExtractionFragment } from '../extraction-review.ts';
import { buildVisibilityClause } from '../search/sql-ranking.ts';
import { privatePagesFilterForCaller, privateProvenanceFilterUnderPolicy } from '../search/private-visibility.ts';
import { deletedPageProjectionHiddenSql } from '../eligibility/sql.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** The engine's `executeRaw` (bound), with the two bounds these reads use. */
export type EngineRawRead = <R = Record<string, unknown>>(sql: string, params?: unknown[], opts?: { timeoutMs?: number; jitOff?: boolean }) => Promise<R[]>;

/** One batch of the exact-phrase scan; null when the phrase has no searchable word (the statement builder's null). */
export async function scanExactBatch(raw: EngineRawRead, opts: ExactScanOpts, afterPageId: number, batchPages: number, timeoutMs: number): Promise<ExactBatchRow[] | null> {
  const stmt = buildExactBatchStatement(opts, afterPageId, batchPages);
  if (!stmt) return null;
  return raw<ExactBatchRow>(stmt.sql, stmt.params, { timeoutMs, jitOff: true });
}

/** The first live page after `afterPageId` in id order, in any source (the scan's step past a page that timed out alone). */
export async function nextLivePageAfter(raw: EngineRawRead, afterPageId: number): Promise<{ id: number; slug: string; source_id: string } | null> {
  const [next] = await raw<{ id: number; slug: string; source_id: string }>(
    'SELECT id, slug, source_id FROM pages WHERE id > $1::int AND deleted_at IS NULL ORDER BY id LIMIT 1', [afterPageId]);
  return next ?? null;
}

/** whois: the title, slug-basename, alias and email candidates (engine-sql/exact-identity.ts). */
export async function listExactIdentityCandidates(raw: EngineRawRead, opts: ExactIdentityStatementOpts): Promise<ExactIdentityRow[]> {
  const { text, params } = exactIdentityStatement(opts);
  return raw<ExactIdentityRow>(text, params);
}

/** rank_entities: the ranked rows (engine-sql/graph-rank.ts) under a `timeoutMs` statement deadline. */
export async function rankEntities(raw: EngineRawRead, opts: RankEntitiesStatementOpts, timeoutMs: number): Promise<RankEntityRow[]> {
  const { text, params } = rankEntitiesStatement(opts);
  return raw<RankEntityRow>(text, params, { timeoutMs });
}

export interface ExtractionPendingRow {
  slug: string;
  title: string;
  type: string;
  source_id: string;
  extracted_from: string | null;
  created_at: string;
}

/** extraction_pending: unverified auto-extracted pages visible in the scope (sourceIds before sourceId), newest first. */
export async function listExtractionPendingPages(raw: EngineRawRead, opts: { sourceIds?: string[]; sourceId?: string; limit: number; offset: number }): Promise<ExtractionPendingRow[]> {
  const srcClause = opts.sourceIds && opts.sourceIds.length > 0 ? sqlFragment`AND p.source_id = ANY(${opts.sourceIds}::text[])`
    : opts.sourceId ? sqlFragment`AND p.source_id = ${opts.sourceId}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug, p.title, p.type, p.source_id,
              p.frontmatter ->> 'source' AS extracted_from,
              p.created_at::text AS created_at
       FROM pages p
       JOIN sources s ON s.id = p.source_id
       WHERE ${trustedSql(unverifiedExtractionFragment('p'))}
         ${trustedSql(buildVisibilityClause('p', 's'))}
         ${srcClause}
       ORDER BY p.created_at DESC
       LIMIT ${opts.limit} OFFSET ${opts.offset}`);
  return raw<ExtractionPendingRow>(text, params);
}

export interface UnattributedFactRow {
  id: number | string;
  fact: string;
  kind: string | null;
  visibility: string;
  source_id: string;
  created_at: string;
  source: string | null;
}

/**
 * Active facts with no entity in `sourceIds`, newest id first, at most
 * `limit` rows after `offset`. `worldOnly` keeps world-visible facts only;
 * `excludePrivateProvenance` also drops facts whose provenance is private.
 */
export async function listUnattributedFacts(raw: EngineRawRead, opts: { sourceIds: string[]; worldOnly: boolean; excludePrivateProvenance: boolean; limit: number; offset: number }): Promise<UnattributedFactRow[]> {
  const provenance = trustedSql(opts.excludePrivateProvenance ? ` AND ${privateProvenanceFilterUnderPolicy('facts')}` : '');
  const { text, params } = renderFragment(sqlFragment`SELECT id, fact, kind, visibility, source_id, created_at::text AS created_at, source FROM facts
      WHERE source_id = ANY(${opts.sourceIds}::text[]) AND entity_slug IS NULL AND expired_at IS NULL
        AND (valid_until IS NULL OR valid_until > now())
        AND (${opts.worldOnly}::boolean = false OR visibility = 'world')${provenance}
        AND ${trustedSql(deletedPageProjectionHiddenSql('facts', 'facts'))}
      ORDER BY id DESC LIMIT ${opts.limit} OFFSET ${opts.offset}`);
  return raw<UnattributedFactRow>(text, params);
}

/** One missing link target, as `listWantedPages` returns it (wanted-links-store.ts re-exports it). */
export interface WantedPageRow {
  target: string;
  target_source_id: string;
  ref_kind: 'slug' | 'name';
  referenced_by: number;
  sample_origins: Array<{ slug: string; source_id: string }>;
  link_types: string[];
  /** Live pages whose basename equals a bare-name target (link them by slug). */
  existing_matches: Array<{ slug: string; source_id: string }>;
  first_seen: string;
  last_checked: string;
}

interface WantedPageRawRow {
  target_source_id: string;
  target_ref: string;
  ref_kind: 'slug' | 'name';
  referenced_by: number;
  origins: Array<{ slug: string; source_id: string }>;
  link_types: string[];
  matches: Array<{ slug: string; source_id: string }> | null;
  first_seen: Date | string;
  last_checked: Date | string;
}

/**
 * Missing link targets, most-referenced first, and how many there are.
 * Scope applies to the origin pages (sourceIds before sourceId); with
 * `excludePrivate`, private origins are removed before aggregation and
 * private pages never appear as bare-name matches.
 */
export async function listWantedPages(raw: EngineRawRead, opts: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean; limit: number; offset: number }): Promise<{ total: number; rows: WantedPageRow[] }> {
  const scope = opts.sourceIds?.length ? sqlFragment` AND o.source_id = ANY(${opts.sourceIds}::text[])`
    : opts.sourceId ? sqlFragment` AND o.source_id = ${opts.sourceId}` : sqlFragment``;
  const originPrivacy = trustedSql(opts.excludePrivate ? ` AND ${privatePagesFilterForCaller('o')}` : '');
  const matchPrivacy = trustedSql(opts.excludePrivate ? ` AND ${privatePagesFilterForCaller('m')}` : '');
  const base = sqlFragment`WITH wanted AS (
      SELECT w.target_source_id, w.target_ref, w.ref_kind, w.link_type, w.first_seen_at, w.checked_at,
        o.slug AS origin_slug, o.source_id AS origin_source_id
      FROM wanted_links w JOIN pages o ON o.id = w.origin_page_id AND o.deleted_at IS NULL
      WHERE NOT EXISTS (SELECT 1 FROM pages t WHERE t.source_id = w.target_source_id AND t.slug = w.target_ref AND t.deleted_at IS NULL)
        ${scope}${originPrivacy}
    ), grouped AS (
      SELECT target_source_id, target_ref, min(ref_kind) AS ref_kind,
        count(DISTINCT (origin_source_id, origin_slug))::int AS referenced_by,
        jsonb_agg(jsonb_build_object('slug', origin_slug, 'source_id', origin_source_id) ORDER BY origin_slug) AS origins,
        coalesce(jsonb_agg(DISTINCT link_type) FILTER (WHERE link_type <> ''), '[]'::jsonb) AS link_types,
        min(first_seen_at) AS first_seen, max(checked_at) AS last_checked
      FROM wanted GROUP BY target_source_id, target_ref
    )`;
  const count = renderFragment(sqlFragment`${base} SELECT count(*)::int AS total FROM grouped`);
  const [{ total }] = await raw<{ total: number }>(count.text, count.params);
  const page = renderFragment(sqlFragment`${base}
    SELECT g.*, (SELECT jsonb_agg(jsonb_build_object('slug', m.slug, 'source_id', m.source_id))
        FROM (SELECT m.slug, m.source_id FROM pages m WHERE g.ref_kind = 'name' AND m.source_id = g.target_source_id
          AND regexp_replace(m.slug, '^.*/', '') = g.target_ref AND m.deleted_at IS NULL${matchPrivacy}
          ORDER BY m.slug LIMIT 3) m) AS matches
    FROM grouped g ORDER BY g.referenced_by DESC, g.target_source_id, g.target_ref
    LIMIT ${opts.limit} OFFSET ${opts.offset}`);
  const rows = await raw<WantedPageRawRow>(page.text, page.params);
  const iso = (value: Date | string) => (value instanceof Date ? value : new Date(value)).toISOString();
  return { total: Number(total ?? 0), rows: rows.map(row => {
    const seen = new Set<string>();
    const origins = (row.origins ?? []).filter(o => !seen.has(`${o.source_id}\0${o.slug}`) && seen.add(`${o.source_id}\0${o.slug}`));
    return { target: row.target_ref, target_source_id: row.target_source_id, ref_kind: row.ref_kind,
      referenced_by: Number(row.referenced_by), sample_origins: origins.slice(0, 3), link_types: row.link_types ?? [],
      existing_matches: row.matches ?? [], first_seen: iso(row.first_seen),
      last_checked: Number.isFinite(new Date(row.last_checked).getTime()) ? iso(row.last_checked) : 'pending' };
  }) };
}
