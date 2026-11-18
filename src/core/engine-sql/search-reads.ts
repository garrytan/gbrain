/**
 * Search reads: the ranking-stage statements hybrid search runs after fusion
 * (supersede down-rank, alias boost, collapse, generated-page demotion and
 * the SQL cosine re-score), once for both engines.
 *
 * Every statement here ran through `engine.executeRaw` on master, from
 * src/core/search/{hybrid,collapse,provenance-demotion,cosine-rescore}.ts and
 * hybrid/alias-resolved.ts. They keep master's text and run on master's raw
 * path (`exec.executeRaw`) unscoped, as before. The callers keep their
 * fail-open handling; a refused capability is never swallowed
 * (engine-capability-refusal.ts).
 *
 * One deliberate text change: a read policy's source clause is bound through
 * `sqlFragment` (renderFragment numbers it) instead of `pageReadFilter`'s
 * hand-numbered `$n`, so the remaining clauses render with no values. The
 * predicate and the clause order are master's.
 */
import type { PageReadPolicy, PageReadScope } from '../types.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { rankingLinkSql } from '../link-ranking-policy.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { cosineByChunkIdsStatement } from './chunks.ts';

/**
 * The supersede-edge probe. `link_type` stays a literal so the planner matches the partial index
 * idx_links_supersedes_to (migration links_supersedes_index) by its predicate; a bind parameter can leave a generic plan that does not, and with no matching row the
 * probe would read the whole composite links index (test/e2e/supersedes-probe-index-postgres.test.ts).
 */
export const SUPERSEDE_EDGE_PROBE_SQL = `SELECT 1 AS one FROM links WHERE link_type = 'supersedes' LIMIT 1`;

const POLICY_ALIASES = { p: 'p', pf: 'pf', pt: 'pt', origin: 'origin' } as const;
const SOURCE_COLUMNS = { p: 'p.source_id', pf: 'pf.source_id', pt: 'pt.source_id', origin: 'origin.source_id' } as const;

/** `pageReadFilter(alias, scope, params, live)` as a fragment: the source clause is bound, the rest is master's text. */
function readFilter(alias: keyof typeof POLICY_ALIASES, scope: PageReadScope | undefined, live: boolean): SqlFragment {
  const rest = pageReadFilter(POLICY_ALIASES[alias], scope ? { ...scope, sourceId: undefined, sourceIds: undefined } : undefined, [], live);
  const column = trustedSql(SOURCE_COLUMNS[alias]);
  const source = scope?.sourceIds?.length
    ? sqlFragment`${column} = ANY(${scope.sourceIds}::text[])`
    : scope?.sourceId ? sqlFragment`${column} = ${scope.sourceId}` : null;
  if (!source) return sqlFragment`${trustedSql(rest)}`;
  return rest === 'TRUE' ? source : sqlFragment`${source} AND ${trustedSql(rest)}`;
}

async function rows<R>(exec: LegacyUnscopedRead, fragment: SqlFragment): Promise<R[]> {
  const { text, params } = renderFragment(fragment);
  return exec.executeRaw<R>(text, params);
}

/** Whether the brain has any `supersedes` link (one index probe). */
export async function hasSupersedeEdges(exec: LegacyUnscopedRead): Promise<boolean> {
  return (await exec.executeRaw<{ one: number }>(SUPERSEDE_EDGE_PROBE_SQL)).length > 0;
}

/**
 * Superseded page id → the slug of a live page in the same source that
 * supersedes it, for `pageIds`. Under a policy both pages and the link's
 * origin page must be readable. The first row per id wins.
 */
export async function supersedingPageSlugs(exec: LegacyUnscopedRead, pageIds: number[], policy?: PageReadPolicy): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (pageIds.length === 0) return result;
  const origin = policy
    ? sqlFragment`(l.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM pages origin WHERE origin.id = l.origin_page_id AND ${readFilter('origin', policy, true)}))`
    : sqlFragment`TRUE`;
  const found = await rows<{ to_page_id: number; by_slug: string }>(exec, sqlFragment`SELECT DISTINCT l.to_page_id, pf.slug AS by_slug
         FROM links l
         JOIN pages pf ON pf.id = l.from_page_id
         JOIN pages pt ON pt.id = l.to_page_id
        WHERE l.link_type = 'supersedes'
          AND pf.deleted_at IS NULL
          AND pf.source_id = pt.source_id
          AND l.to_page_id = ANY(${pageIds}::bigint[])
          AND ${readFilter('pf', policy, !!policy)} AND ${readFilter('pt', policy, !!policy)} AND ${origin}`);
  for (const row of found) {
    const id = Number(row.to_page_id);
    if (!result.has(id)) result.set(id, row.by_slug);
  }
  return result;
}

/** The refs (source id + slug) that are the canonical slug of some `slug_aliases` row and whose page the policy may read. */
export async function aliasCanonicalRefs(
  exec: LegacyUnscopedRead, refs: Array<{ slug: string; source_id: string }>, policy?: PageReadPolicy,
): Promise<Array<{ source_id: string; canonical_slug: string }>> {
  if (refs.length === 0) return [];
  return rows(exec, sqlFragment`SELECT DISTINCT a.source_id, a.canonical_slug
       FROM slug_aliases a JOIN pages p ON p.source_id = a.source_id AND p.slug = a.canonical_slug
       WHERE (a.source_id, a.canonical_slug) IN (
         SELECT * FROM unnest(${refs.map(r => r.source_id)}::text[], ${refs.map(r => r.slug)}::text[])
       ) AND ${readFilter('p', policy, !!policy)}`);
}

const STATUS_REDIRECT = `lower(COALESCE(frontmatter->>'status', '')) ~ '(^|[^a-z])(alias|redirect|redirected)([^a-z]|$)'`;
/** Identical bodies shorter than this (empty templates, one-line stubs) say nothing about a shared document. */
const IDENTICAL_BODY_MIN_CHARS = '200';
/** Body prefix compared for word overlap. */
const OVERLAP_PREFIX_CHARS = '4000';
const BODY = `btrim(COALESCE(${boundedBodyPrefixSql('p')}, ''))`;

export interface PageCollapseFactRow { id: number; target: string | null; body: string | null; body_chars: number | null; lead: string | null }

/**
 * Collapse facts per page id in `ids` (missing pages have no row): the
 * frontmatter redirect target, the bounded body's length and, for
 * `bodyIds`, an md5 of a substantial body and its leading characters.
 */
export async function pageCollapseFacts(exec: LegacyUnscopedRead, ids: number[], bodyIds: number[]): Promise<PageCollapseFactRow[]> {
  return rows(exec, sqlFragment`SELECT p.id,
            COALESCE(NULLIF(btrim(p.frontmatter->>'redirect_to'), ''), NULLIF(btrim(p.frontmatter->>'redirect'), ''),
                     NULLIF(btrim(p.frontmatter->>'merged_into'), ''),
                     CASE WHEN ${trustedSql(STATUS_REDIRECT)} THEN NULLIF(btrim(p.frontmatter->>'superseded_by'), '') END) AS target,
            length(${trustedSql(BODY)}) AS body_chars,
            CASE WHEN p.id = ANY(${bodyIds}::int[]) AND length(${trustedSql(BODY)}) >= ${trustedSql(IDENTICAL_BODY_MIN_CHARS)} THEN md5(${trustedSql(BODY)}) END AS body,
            CASE WHEN p.id = ANY(${bodyIds}::int[]) THEN left(${trustedSql(BODY)}, ${trustedSql(OVERLAP_PREFIX_CHARS)}) END AS lead
       FROM pages p WHERE p.id = ANY(${ids}::int[])`);
}

/** Up to two live slugs in `sourceId` that are `word` or end in `/word` (LIKE-escaped). */
export async function slugsEndingIn(exec: LegacyUnscopedRead, sourceId: string, word: string): Promise<string[]> {
  const found = await rows<{ slug: string }>(exec, sqlFragment`SELECT slug FROM pages WHERE source_id = ${sourceId} AND deleted_at IS NULL AND (slug = ${word} OR slug LIKE ${`%/${word.replace(/[%_\\]/g, '\\$&')}`}) LIMIT 2`);
  return found.map(r => r.slug);
}

export type GeneratedPageRow = { id: number; frontmatter: Record<string, unknown> | null; compiled_truth: string | null };

/** The pages among `ids` gbrain generated (frontmatter `dream_generated: true` or type `extract_receipt`). */
export async function generatedPagesIn(exec: LegacyUnscopedRead, ids: number[]): Promise<GeneratedPageRow[]> {
  return rows(exec, sqlFragment`SELECT id, frontmatter, compiled_truth FROM pages
        WHERE id = ANY(${ids}::int[]) AND (frontmatter->>'dream_generated' = 'true' OR type = 'extract_receipt')`);
}

/** Ids of the live pages at `refs` (source id + slug). */
export async function livePageIdsAt(exec: LegacyUnscopedRead, refs: Array<{ slug: string; source_id: string }>): Promise<number[]> {
  const found = await rows<{ id: number }>(exec, sqlFragment`SELECT id FROM pages WHERE deleted_at IS NULL AND (source_id, slug) IN (SELECT * FROM unnest(${refs.map(r => r.source_id)}::text[], ${refs.map(r => r.slug)}::text[]))`);
  return found.map(r => Number(r.id));
}

/** The pages among `fromIds` with a ranking link to a page in `toIds`. */
export async function pagesLinkingTo(exec: LegacyUnscopedRead, fromIds: number[], toIds: number[]): Promise<number[]> {
  const found = await rows<{ id: number }>(exec, sqlFragment`SELECT DISTINCT l.from_page_id AS id FROM links l WHERE l.from_page_id = ANY(${fromIds}::int[]) AND l.to_page_id = ANY(${toIds}::int[]) AND ${trustedSql(rankingLinkSql('l'))}`);
  return found.map(r => Number(r.id));
}

/** Text-space cosine per visible chunk id with an embedding in `column` (cosineByChunkIdsStatement); absent ids did not hydrate. */
export async function cosinesByChunkIds(exec: LegacyUnscopedRead, ids: number[], column: string, query: Float32Array): Promise<Map<number, number>> {
  const { text, params } = cosineByChunkIdsStatement(ids, column, query);
  const found = await exec.executeRaw<{ id: number; cosine: number }>(text, params);
  return new Map(found.map(row => [Number(row.id), Number(row.cosine)]));
}
