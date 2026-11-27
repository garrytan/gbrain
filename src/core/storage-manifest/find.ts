/**
 * Ranked lookup on the storage shelf (GST-1943), keyless: exact id, exact alias (page_aliases), exact title, then the words of the
 * phrase over each card's title, aliases and body, then pg_trgm similarity on title and aliases for the closest cards
 * when nothing matches. One statement; the shelf is small (hundreds to thousands of cards).
 */
import type { BrainEngine } from '../engine.ts';
import type { PageReadScope } from '../types.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { STORAGE_SOURCE_ID } from './door.ts';
import type { CardFilters, CardRow } from '../engine-sql/list-reads.ts';
import { accessLabels, cardFromPage, STORED_OBJECT_TYPE, type AccessLabels, type Card } from './schema.ts';

const STOPWORDS = new Set(['a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'for', 'from', 'my', 'our', 'it', 'that', 'this', 'back', 'bring', 'restore', 'find', 'where', 'is', 'was', 'what', 'did', 'go', 'with', 'please']);
const CLOSEST_FLOOR = 0.1;

export type { CardFilters, CardRow } from '../engine-sql/list-reads.ts';
export interface FindHit extends CardRow { match: 'id' | 'alias' | 'title' | 'words'; matched_terms: number; similarity: number }
export interface FindResult { query: string; terms: string[]; hits: FindHit[]; not_found: boolean; closest: Array<CardRow & { similarity: number }> }

export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 12);
}

export { CARD_COLUMNS, cardFilterSql } from '../engine-sql/list-reads.ts';

export async function findCards(engine: BrainEngine, query: string, opts: { limit: number; filters: CardFilters; policy?: PageReadScope }): Promise<FindResult> {
  const terms = queryTerms(query);
  const rows = await engine.findCardRows({ sourceId: STORAGE_SOURCE_ID, type: STORED_OBJECT_TYPE, query: query.trim().toLowerCase(), aliasNorm: normalizeAlias(query), terms, filters: opts.filters, policy: opts.policy });
  const needed = Math.max(1, Math.ceil(terms.length / 2));
  const strip = ({ exact_id: _e, exact_alias: _a, exact_title: _t, matched: _m, rank: _r, similarity: _s, ...card }: (typeof rows)[number]): CardRow => ({ ...card, stores: card.stores ?? [] });
  const hits: FindHit[] = [];
  for (const row of rows) {
    const match = row.exact_id ? 'id' : row.exact_alias ? 'alias' : row.exact_title ? 'title' : terms.length && row.matched >= needed ? 'words' : null;
    if (match) hits.push({ ...strip(row), match, matched_terms: Number(row.matched), similarity: Number(row.similarity) });
  }
  const shown = hits.slice(0, opts.limit);
  const closest = shown.length ? [] : rows.filter((row) => Number(row.similarity) >= CLOSEST_FLOOR || Number(row.matched) > 0)
    .sort((a, b) => Number(b.similarity) - Number(a.similarity) || Number(b.matched) - Number(a.matched))
    .slice(0, 5).map((row) => ({ ...strip(row), similarity: Number(row.similarity) }));
  return { query, terms, hits: shown, not_found: shown.length === 0, closest };
}

export async function listCards(engine: BrainEngine, opts: { limit: number; offset: number; filters: CardFilters; policy?: PageReadScope }): Promise<{ cards: CardRow[]; total: number }> {
  const { total, cards } = await engine.listCardRows({ sourceId: STORAGE_SOURCE_ID, type: STORED_OBJECT_TYPE, ...opts });
  return { cards: cards.map((c) => ({ ...c, stores: c.stores ?? [] })), total };
}

/** Every live page on the shelf, sorted by id, with the card it stores (null when its page holds none) and the page's access labels. Trusted local readers only. */
export async function readShelfCards(engine: BrainEngine): Promise<Array<{ id: string; card: Card | null; labels: AccessLabels }>> {
  const rows = await engine.readShelfPageRows(STORAGE_SOURCE_ID);
  return rows.map((row) => {
    const frontmatter = typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) as Record<string, unknown> : (row.frontmatter ?? {}) as Record<string, unknown>;
    return { id: row.slug, card: row.type === STORED_OBJECT_TYPE ? cardFromPage({ slug: row.slug, title: row.title, frontmatter }) : null, labels: accessLabels(frontmatter) };
  });
}
