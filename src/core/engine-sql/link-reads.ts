
import type { LegacyUnscopedRead } from './brands.ts';
import { rows } from './search-reads.ts';
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


/** One returned link context worldLinkContexts checks (eligibility/fence-overlay.ts): its row index, stored edge and text. */
export interface LinkContextAsk { i: number; fromSourceId: string; fromSlug: string; toSourceId: string; toSlug: string; linkType: string; context: string }
/** A stored link row whose context is an ask's text or a read's truncation of it, with its live origin page (null when gone). */
export interface LinkContextMatch { i: number; link_source: string | null; context: string; page_id: number | null }
/** An origin page body worldLinkContexts reads; a segmented page is never returned. */
export interface LinkContextOriginPage { id: number; source_id: string; slug: string; compiled_truth: string | null; timeline: string | null }

const LINK_CONTEXT_MATCH_SQL = `SELECT u.i, l.link_source, l.context, e.id AS page_id
       FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS u(i, fs, fslug, ts, tslug, lt, ctx)
       JOIN pages f ON f.source_id = u.fs AND f.slug = u.fslug
       JOIN pages t ON t.source_id = u.ts AND t.slug = u.tslug
       JOIN links l ON l.from_page_id = f.id AND l.to_page_id = t.id AND l.link_type = u.lt
         AND (l.context = u.ctx OR (right(u.ctx, 1) = '…' AND left(l.context, char_length(u.ctx) - 1) = left(u.ctx, char_length(u.ctx) - 1)))
       LEFT JOIN pages e ON e.id = COALESCE(l.origin_page_id, l.from_page_id) AND e.deleted_at IS NULL`;

const LINK_CONTEXT_ORIGIN_SQL = `SELECT id, source_id, slug, compiled_truth, timeline FROM pages
       WHERE id = ANY($1::bigint[]) AND body_storage IS DISTINCT FROM 'segmented'`;

/**
 * The stored link rows behind each ask (worldLinkContexts): every row of the ask's edge whose context is the ask's text,
 * or, for a text ending in `…`, starts with the text before it. The SQL leaves the row order to the plan.
 */
export async function readLinkContextMatches(exec: LegacyUnscopedRead, asks: readonly LinkContextAsk[]): Promise<LinkContextMatch[]> {
  if (asks.length === 0) return [];
  const rows = await exec.executeRaw<LinkContextMatch>(LINK_CONTEXT_MATCH_SQL,
    [asks.map(a => a.i), asks.map(a => a.fromSourceId), asks.map(a => a.fromSlug), asks.map(a => a.toSourceId),
      asks.map(a => a.toSlug), asks.map(a => a.linkType), asks.map(a => a.context)]);
  return rows.map(r => ({ ...r, i: Number(r.i), page_id: r.page_id == null ? null : Number(r.page_id) }));
}

/** The bodies of the pages in `ids` that are not stored in segments, deleted or not (worldLinkContexts). */
export async function readLinkContextOriginPages(exec: LegacyUnscopedRead, ids: readonly number[]): Promise<LinkContextOriginPage[]> {
  if (ids.length === 0) return [];
  const rows = await exec.executeRaw<LinkContextOriginPage>(LINK_CONTEXT_ORIGIN_SQL, [[...ids]]);
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}

/** The live pages LINK_ENDPOINTS_SQL names: the origin source's rows first (automatic link preparation). */
export async function listLinkEndpointPages(exec: LegacyUnscopedRead, sourceId: string, slugs: string[], crossSourceSlugs: string[]): Promise<LinkEndpointPage[]> {
  return exec.executeRaw<LinkEndpointPage>(LINK_ENDPOINTS_SQL, [sourceId, slugs, crossSourceSlugs]);
}
