/**
 * Read-command statements that ran through `engine.executeRaw` from the ops
 * layer (docs/research/rust-cli-executeraw-map.md, "Read-command queries"):
 * search-exact (with its held-snippet chunk reads), wanted, whois,
 * rank-entities (with its remote coverage), extraction-pending and the held
 * fence cells of a world-only fact read (eligibility/stamp.ts heldFenceLines).
 *
 * Every function takes the engine's own `executeRaw`, so each statement runs
 * on exactly the path it ran on before it moved here: on Postgres a
 * `timeoutMs` read runs under a transaction-local statement_timeout and a
 * `jitOff` read with JIT disabled; PGLite runs every read as one statement.
 * The statements and their parameters are unchanged; only their home moved.
 */
import { buildExactBatchStatement, type ExactBatchRow, type ExactScanOpts } from '../search/exact-scan.ts';
import { exactIdentityStatement, type ExactIdentityRow, type ExactIdentityStatementOpts } from './exact-identity.ts';
import { rankCoverageStatement, rankEntitiesStatement, type RankCoverageStatementOpts, type RankEntitiesStatementOpts, type RankEntityRow } from './graph-rank.ts';
import { chunkVisibleFilter, safeChunksFilter } from '../search/safe-chunks.ts';
import { unverifiedExtractionFragment } from '../extraction-review.ts';
import { buildVisibilityClause } from '../search/sql-ranking.ts';
import { privatePagesFilterForCaller, privateProvenanceFilterUnderPolicy } from '../search/private-visibility.ts';
import { deletedPageProjectionHiddenSql } from '../eligibility/sql.ts';
import { heldRowSql } from '../eligibility/fence-overlay.ts';
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

/** One source's remote rank coverage: a readable page still owes link extraction, or (with mention types) a mention pass. */
export interface RankCoverageRow { link_behind: boolean; mention_due: boolean }

/** rank_entities' remote coverage for one source (engine-sql/graph-rank.ts `rankCoverageStatement`) under a `timeoutMs` statement deadline. */
export async function readRankCoverage(raw: EngineRawRead, opts: RankCoverageStatementOpts, timeoutMs: number): Promise<RankCoverageRow> {
  const { text, params } = rankCoverageStatement(opts);
  const [row] = await raw<RankCoverageRow>(text, params, { timeoutMs });
  return { link_behind: row?.link_behind === true, mention_due: row?.mention_due === true };
}

/** One exact-scan snippet to place in its stored chunk: the page, the chunk index and the snippet text. */
export interface ExactSnippetKey { pageId: number; chunkIndex: number; snippet: string }
/** The stored chunk a snippet was cut from; `i` is the 1-based position of its key. */
export interface ExactSnippetChunkRow { i: number; chunk_text: string }
/** One visible, safe-fenced chunk of a page the exact scan reads again. */
export interface ExactRescanChunkRow { page_id: number; chunk_index: number; chunk_source: string; chunk_text: string }

/**
 * search_exact's held-snippet check: per key, the text of its chunk when the chunk is visible (served projection, not
 * ahead of the page's body generation) and holds the snippet, by key position. With `excludePrivate` a private page
 * the caller may not read gives no row.
 */
export async function readExactSnippetChunks(raw: EngineRawRead, keys: readonly ExactSnippetKey[], opts: { excludePrivate: boolean }): Promise<ExactSnippetChunkRow[]> {
  if (!keys.length) return [];
  const privacy = trustedSql(opts.excludePrivate ? ` AND ${privatePagesFilterForCaller('p')}` : '');
  const { text, params } = renderFragment(sqlFragment`SELECT k.i, cc.chunk_text
      FROM unnest(${keys.map(k => k.pageId)}::int[], ${keys.map(k => k.chunkIndex)}::int[], ${keys.map(k => k.snippet)}::text[]) WITH ORDINALITY AS k(page_id, chunk_index, snippet, i)
      JOIN pages p ON p.id = k.page_id JOIN content_chunks cc ON cc.page_id = k.page_id AND cc.chunk_index = k.chunk_index
      WHERE ${trustedSql(chunkVisibleFilter('p', 'cc'))} AND strpos(cc.chunk_text, k.snippet) > 0${privacy}
      ORDER BY k.i`);
  const rows = await raw<{ i: number | string; chunk_text: string }>(text, params);
  return rows.map(r => ({ i: Number(r.i), chunk_text: r.chunk_text }));
}

/**
 * search_exact's rescan: every visible chunk past the safe-chunk fence of `pageIds`, by page id then chunk index. With
 * `excludePrivate` a private page the caller may not read gives no rows.
 */
export async function listExactRescanChunks(raw: EngineRawRead, pageIds: readonly number[], opts: { excludePrivate: boolean }): Promise<ExactRescanChunkRow[]> {
  if (!pageIds.length) return [];
  const privacy = trustedSql(opts.excludePrivate ? ` AND ${privatePagesFilterForCaller('p')}` : '');
  const { text, params } = renderFragment(sqlFragment`SELECT cc.page_id, cc.chunk_index, cc.chunk_source, cc.chunk_text
      FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = ANY(${[...pageIds]}::int[]) AND ${trustedSql(chunkVisibleFilter('p', 'cc'))} AND ${trustedSql(safeChunksFilter('p'))}${privacy}
      ORDER BY cc.page_id, cc.chunk_index`);
  const rows = await raw<{ page_id: number | string; chunk_index: number | string; chunk_source: string; chunk_text: string }>(text, params);
  return rows.map(r => ({ page_id: Number(r.page_id), chunk_index: Number(r.chunk_index), chunk_source: r.chunk_source, chunk_text: r.chunk_text }));
}

/** One facts-fence cell of a page's text: its row number (-1 for a fragment), its claim, and whether a chunk boundary cut it. */
export interface HeldFenceCellKey { sourceId: string; slug: string; rowNum: number; claim: string; partial: boolean }
/** A fence cell held from the current caller (fence-overlay.ts `heldRowSql`). */
export interface HeldFenceCellRow { source_id: string; slug: string; row_num: number; claim: string }

/**
 * GST-2891: the fence cells among `keys` held from the current caller, whose fact reads are world-only
 * (fence-overlay.ts `heldRowSql`, rendered for the caller in context: its member page and its private-facts grant). One
 * row per distinct held (source, slug, row number, claim); the order is not defined.
 */
export async function listHeldFenceCells(raw: EngineRawRead, keys: readonly HeldFenceCellKey[]): Promise<HeldFenceCellRow[]> {
  if (!keys.length) return [];
  const { text, params } = renderFragment(sqlFragment`SELECT DISTINCT k.source_id, k.slug, k.row_num, k.claim FROM unnest(${keys.map(k => k.sourceId)}::text[], ${keys.map(k => k.slug)}::text[], ${keys.map(k => k.rowNum)}::int[], ${keys.map(k => k.claim)}::text[], ${keys.map(k => (k.partial ? 't' : 'f'))}::text[]) AS k(source_id, slug, row_num, claim, partial)
        WHERE ${trustedSql(heldRowSql('k.source_id', 'k.slug', 'k.row_num', 'k.claim', "k.partial = 't'"))}`);
  const rows = await raw<{ source_id: string; slug: string; row_num: number | string; claim: string }>(text, params);
  return rows.map(r => ({ source_id: r.source_id, slug: r.slug, row_num: Number(r.row_num), claim: r.claim }));
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
