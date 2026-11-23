/**
 * The page-list, slug-source, access and storage-shelf reads their callers ran through `executeRaw`. Each function keeps
 * the statement text its call site ran, byte for byte, so PGLite and Postgres answer exactly as before; a Rust brain
 * answers from its store (rust/docs/store/list-reads.md). Every read runs through the engine's own executeRaw
 * (`EngineRawRead`), as its caller did, so a statement fault, a request abort and a read deadline reach it as before.
 */
import type { PageReadPolicy, PageReadScope } from '../types.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

/** Filters on a storage-shelf card's frontmatter (storage-manifest/find.ts). */
export interface CardFilters { store?: string; status?: string; onSourceMachine?: boolean }
/** A storage-shelf card as `CARD_COLUMNS` selects it. */
export interface CardRow { id: string; title: string; status: string | null; kind: string | null; stores: string[]; original_path: string | null; on_source_machine: boolean | null; updated_at: string }
/** The shelf query of `listCards`: the shelf source and card type, the card filters, the read policy and the page. */
export interface CardListQuery { sourceId: string; type: string; filters: CardFilters; policy?: PageReadScope; limit: number; offset: number }
/** A shelf page as `readShelfCards` reads it. */
export interface ShelfPageRow { slug: string; title: string; type: string | null; frontmatter: unknown }

/** Filters on the card's frontmatter, appended to `where` with bound params. */
export function cardFilterSql(alias: string, filters: CardFilters, params: unknown[]): string {
  const clauses: string[] = [];
  if (filters.status) { params.push(filters.status); clauses.push(`${alias}.frontmatter->'storage'->>'status' = $${params.length}`); }
  if (filters.store) { params.push(filters.store); clauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${alias}.frontmatter->'storage'->'locations') = 'array' THEN ${alias}.frontmatter->'storage'->'locations' ELSE '[]'::jsonb END) loc WHERE loc->>'store' = $${params.length})`); }
  if (filters.onSourceMachine !== undefined) { params.push(String(filters.onSourceMachine)); clauses.push(`${alias}.frontmatter->'storage'->>'on_source_machine' = $${params.length}`); }
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
}

export const CARD_COLUMNS = `p.slug AS id, p.title, p.frontmatter->'storage'->>'status' AS status, p.frontmatter->'storage'->>'kind' AS kind,
  COALESCE((SELECT array_agg(DISTINCT loc->>'store') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.frontmatter->'storage'->'locations') = 'array' THEN p.frontmatter->'storage'->'locations' ELSE '[]'::jsonb END) loc), ARRAY[]::text[]) AS stores,
  p.frontmatter->'storage'->>'original_path' AS original_path,
  CASE p.frontmatter->'storage'->>'on_source_machine' WHEN 'true' THEN true WHEN 'false' THEN false END AS on_source_machine,
  p.updated_at::text AS updated_at`;

/** A link's two pages by slug and title (`readCompanyBrainEvidenceRows`). */
export interface EvidenceLinkRow { from_slug: string; from_title: string; to_slug: string; to_title: string }

/** The three picks of the company-brain evidence read, each a row or null. */
export interface CompanyBrainEvidenceRows { owner: EvidenceLinkRow | null; decision: EvidenceLinkRow | null; page: { slug: string; title: string } | null }

/** A page id and its source (`resolveChainAnchorRows`). */
export interface PageSourceIdRow { id: number; source_id: string }

/** One readable live copy of a slug as `explain_target` probes it, counts as the driver returns them (`probeTargetRows`). */
export interface TargetProbeSqlRow { source_id: string; chunks: number; embedded: number; current: boolean; chunker_version: number | null }

/**
 * The sources holding a live page at `slug`, by id in byte order: the ambiguity check of a page ref with no source
 * (trust/refs.ts resolvePageRef), `gbrain quarantine clear` and `extract-conversation-facts --grammar`.
 */
export async function listLiveSlugSourceIds(raw: EngineRawRead, slug: string): Promise<string[]> {
  const rows = await raw<{ source_id: string }>(
    'SELECT source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL ORDER BY source_id COLLATE "C"', [slug]);
  return rows.map(r => r.source_id);
}

/** Every live copy of `slug` the read policy admits, by source id (search/relational-chain.ts resolveChainAnchors). */
export async function resolveChainAnchorRows(raw: EngineRawRead, slug: string, policy: PageReadPolicy): Promise<PageSourceIdRow[]> {
  const params: unknown[] = [slug];
  const filter = pageReadFilter('p', policy, params, true);
  return raw<PageSourceIdRow>(
    `SELECT p.id, p.source_id FROM pages p WHERE p.slug = $1 AND ${filter} ORDER BY p.source_id COLLATE "C"`, params);
}

/**
 * Every readable live copy of `slug` under the caller's policy, with its live-body chunk and vector counts, whether its
 * text projection is current, and its chunker version, by source id (search/explain-target.ts probeTarget).
 */
export async function probeTargetRows(raw: EngineRawRead, slug: string, policy: PageReadPolicy, chunkManifest = true): Promise<TargetProbeSqlRow[]> {
  const params: unknown[] = [slug];
  const filter = pageReadFilter('p', policy, params, true);
  return raw<TargetProbeSqlRow>(
    `SELECT p.source_id,
       (SELECT COUNT(*)::int FROM content_chunks cc WHERE cc.page_id = p.id AND ${chunkGenerationFilter('p', 'cc', chunkManifest)}) AS chunks,
       (SELECT COUNT(*)::int FROM content_chunks cc WHERE cc.page_id = p.id AND cc.embedding IS NOT NULL AND ${chunkGenerationFilter('p', 'cc', chunkManifest)}) AS embedded,
       ((p.text_projection_revision = p.knowledge_revision) IS TRUE) AS current,
       p.chunker_version
     FROM pages p WHERE p.slug = $1 AND ${filter} ORDER BY p.source_id COLLATE "C"`, params);
}

/**
 * The company-brain evidence picks of a source (company-brain/evidence.ts): the first ownership link (a customer page
 * first), the first decision supersession, and the first live page, each by slug in byte order.
 */
export async function readCompanyBrainEvidenceRows(raw: EngineRawRead, sourceId: string): Promise<CompanyBrainEvidenceRows> {
  const [owner] = await raw<EvidenceLinkRow>(
    `SELECT f.slug AS from_slug,f.title AS from_title,t.slug AS to_slug,t.title AS to_title
     FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
     WHERE f.source_id=$1 AND t.source_id=$1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL
       AND l.link_type='owned_by' AND l.link_source IN ('frontmatter','markdown')
       AND (l.origin_page_id=f.id OR (l.origin_page_id IS NULL AND l.link_source='markdown'))
     ORDER BY CASE WHEN f.type='customer' THEN 0 ELSE 1 END,f.slug COLLATE "C",t.slug COLLATE "C" LIMIT 1`, [sourceId]);
  const [decision] = await raw<EvidenceLinkRow>(
    `SELECT f.slug AS from_slug,f.title AS from_title,t.slug AS to_slug,t.title AS to_title
     FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
     WHERE f.source_id=$1 AND t.source_id=$1 AND f.deleted_at IS NULL AND t.deleted_at IS NULL
       AND f.type='decision' AND t.type='decision' AND l.link_type='supersedes'
       AND l.link_source IN ('frontmatter','markdown')
       AND (l.origin_page_id=f.id OR (l.origin_page_id IS NULL AND l.link_source='markdown'))
     ORDER BY f.slug COLLATE "C",t.slug COLLATE "C" LIMIT 1`, [sourceId]);
  const [page] = await raw<{ slug: string; title: string }>(
    'SELECT slug,title FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug COLLATE "C" LIMIT 1', [sourceId]);
  return { owner: owner ?? null, decision: decision ?? null, page: page ?? null };
}

/** The shelf's card count and one page of its cards, by slug in byte order (storage-manifest/find.ts listCards). */
export async function listCardRows(raw: EngineRawRead, query: CardListQuery): Promise<{ total: number; cards: CardRow[] }> {
  const params: unknown[] = [query.sourceId, query.type];
  const where = `p.source_id = $1 AND p.type = $2 AND ${pageReadFilter('p', query.policy, params, true)}${cardFilterSql('p', query.filters, params)}`;
  const [{ n }] = await raw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p WHERE ${where}`, params) as [{ n: number }];
  params.push(query.limit, query.offset);
  const cards = await raw<CardRow>(`SELECT ${CARD_COLUMNS} FROM pages p WHERE ${where} ORDER BY p.slug COLLATE "C" LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { total: Number(n), cards };
}

/** Every live page of the shelf source, by slug in byte order (storage-manifest/find.ts readShelfCards). */
export async function readShelfPageRows(raw: EngineRawRead, sourceId: string): Promise<ShelfPageRow[]> {
  return raw<ShelfPageRow>(
    'SELECT p.slug, p.title, p.type, p.frontmatter FROM pages p WHERE p.source_id = $1 AND p.deleted_at IS NULL ORDER BY p.slug COLLATE "C"', [sourceId]);
}
