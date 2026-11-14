/**
 * Ranked lookup on the storage shelf (GST-1943), keyless: exact id, exact alias (page_aliases), then the words of the
 * phrase over each card's title, aliases and body, then pg_trgm similarity on title and aliases for the closest cards
 * when nothing matches. One statement; the shelf is small (hundreds to thousands of cards).
 */
import type { BrainEngine } from '../engine.ts';
import type { PageReadScope } from '../types.ts';
import { pageReadFilter } from '../search/read-policy-sql.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { boundedBodyPrefixSql } from '../page-window/bounded-lead.ts';
import { STORAGE_SOURCE_ID } from './door.ts';
import { accessLabels, cardFromPage, STORED_OBJECT_TYPE, type AccessLabels, type Card } from './schema.ts';

const STOPWORDS = new Set(['a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'for', 'from', 'my', 'our', 'it', 'that', 'this', 'back', 'bring', 'restore', 'find', 'where', 'is', 'was', 'what', 'did', 'go', 'with', 'please']);
const CLOSEST_FLOOR = 0.1;

export interface CardFilters { store?: string; status?: string; onSourceMachine?: boolean }
export interface CardRow { id: string; title: string; status: string | null; kind: string | null; stores: string[]; original_path: string | null; on_source_machine: boolean | null; updated_at: string }
export interface FindHit extends CardRow { match: 'id' | 'alias' | 'words'; matched_terms: number; similarity: number }
export interface FindResult { query: string; terms: string[]; hits: FindHit[]; not_found: boolean; closest: Array<CardRow & { similarity: number }> }

export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 12);
}

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

export async function findCards(engine: BrainEngine, query: string, opts: { limit: number; filters: CardFilters; policy?: PageReadScope }): Promise<FindResult> {
  const terms = queryTerms(query);
  const params: unknown[] = [STORAGE_SOURCE_ID, STORED_OBJECT_TYPE, query.trim().toLowerCase(), normalizeAlias(query), terms];
  const policy = pageReadFilter('p', opts.policy, params, true);
  const filters = cardFilterSql('p', opts.filters, params);
  const rows = await engine.executeRaw<CardRow & { exact_id: boolean; exact_alias: boolean; matched: number; rank: number; similarity: number }>(`
    SELECT ${CARD_COLUMNS},
      p.slug = $3 AS exact_id,
      EXISTS (SELECT 1 FROM page_aliases a WHERE a.source_id = p.source_id AND a.slug = p.slug AND a.alias_norm = $4) AS exact_alias,
      (SELECT count(*) FROM unnest($5::text[]) t WHERE d.doc @@ plainto_tsquery('simple', t))::int AS matched,
      GREATEST(word_similarity($3, lower(p.title)),
        COALESCE((SELECT max(word_similarity($3, a.alias_norm)) FROM page_aliases a WHERE a.source_id = p.source_id AND a.slug = p.slug), 0))::float8 AS similarity
    FROM pages p
    CROSS JOIN LATERAL (SELECT to_tsvector('simple', p.title || ' ' || COALESCE((SELECT string_agg(a.alias_norm, ' ') FROM page_aliases a WHERE a.source_id = p.source_id AND a.slug = p.slug), '')
      || ' ' || p.slug || ' ' || ${boundedBodyPrefixSql('p')}) AS doc) d
    WHERE p.source_id = $1 AND p.type = $2 AND ${policy}${filters}
    ORDER BY exact_id DESC, exact_alias DESC, matched DESC, similarity DESC, p.slug
    LIMIT 500`, params);
  const needed = Math.max(1, Math.ceil(terms.length / 2));
  const strip = ({ exact_id: _e, exact_alias: _a, matched: _m, rank: _r, similarity: _s, ...card }: (typeof rows)[number]): CardRow => ({ ...card, stores: card.stores ?? [] });
  const hits: FindHit[] = [];
  for (const row of rows) {
    const match = row.exact_id ? 'id' : row.exact_alias ? 'alias' : terms.length && row.matched >= needed ? 'words' : null;
    if (match) hits.push({ ...strip(row), match, matched_terms: Number(row.matched), similarity: Number(row.similarity) });
  }
  const shown = hits.slice(0, opts.limit);
  const closest = shown.length ? [] : rows.filter((row) => Number(row.similarity) >= CLOSEST_FLOOR || Number(row.matched) > 0)
    .sort((a, b) => Number(b.similarity) - Number(a.similarity) || Number(b.matched) - Number(a.matched))
    .slice(0, 5).map((row) => ({ ...strip(row), similarity: Number(row.similarity) }));
  return { query, terms, hits: shown, not_found: shown.length === 0, closest };
}

export async function listCards(engine: BrainEngine, opts: { limit: number; offset: number; filters: CardFilters; policy?: PageReadScope }): Promise<{ cards: CardRow[]; total: number }> {
  const params: unknown[] = [STORAGE_SOURCE_ID, STORED_OBJECT_TYPE];
  const where = `p.source_id = $1 AND p.type = $2 AND ${pageReadFilter('p', opts.policy, params, true)}${cardFilterSql('p', opts.filters, params)}`;
  const [{ n }] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages p WHERE ${where}`, params);
  params.push(opts.limit, opts.offset);
  const cards = await engine.executeRaw<CardRow>(`SELECT ${CARD_COLUMNS} FROM pages p WHERE ${where} ORDER BY p.slug LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return { cards: cards.map((c) => ({ ...c, stores: c.stores ?? [] })), total: Number(n) };
}

/** Every live page on the shelf, sorted by id, with the card it stores (null when its page holds none) and the page's access labels. Trusted local readers only. */
export async function readShelfCards(engine: BrainEngine): Promise<Array<{ id: string; card: Card | null; labels: AccessLabels }>> {
  const rows = await engine.executeRaw<{ slug: string; title: string; type: string | null; frontmatter: unknown }>(
    'SELECT p.slug, p.title, p.type, p.frontmatter FROM pages p WHERE p.source_id = $1 AND p.deleted_at IS NULL ORDER BY p.slug', [STORAGE_SOURCE_ID]);
  return rows.map((row) => {
    const frontmatter = typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) as Record<string, unknown> : (row.frontmatter ?? {}) as Record<string, unknown>;
    return { id: row.slug, card: row.type === STORED_OBJECT_TYPE ? cardFromPage({ slug: row.slug, title: row.title, frontmatter }) : null, labels: accessLabels(frontmatter) };
  });
}
