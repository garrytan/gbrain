/**
 * Alias fan-out for `search` and `query`: when the query names an entity,
 * also search under every other name it goes by, so records filed under a
 * nickname or a code are not left for the agent to discover.
 *
 * Resolution: the query's word n-grams (up to 4 tokens, longest first; a
 * shorter n-gram inside a resolved longer one is dropped) go through
 * `resolveAliases` and an exact-title lookup over linkable entity pages. Only
 * capitalized or code-shaped n-grams count, or a multi-word n-gram that
 * resolves to exactly one page, so a lowercase common word never fans out. A
 * case-sensitive alias matches only as written. Several pages for one n-gram
 * resolve only when they are identity siblings (mentions/siblings.ts);
 * otherwise the n-gram is skipped. With no entity resolved, the names the top
 * rows declare (`fallback`) are used, as before.
 *
 * Fan-out: the names of the resolved page and its identity siblings
 * (frontmatter, declared and subject aliases, codes included) that the query
 * does not already use, ordered by origin (frontmatter, declared, subject)
 * and then longest first, capped at `search.alias_fanout_max` (default 4; 0
 * turns fan-out off). Each runs as a keyword-only query that requires the
 * name as a phrase and ranks by the query's other content terms (no embedding
 * or rerank call), 5 rows each; at most 8 new pages are spliced after the top
 * two results, each carrying `matched_alias`. Fan-out never changes offsets
 * or counts. The `fanout` meta says what was searched and skipped.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchOpts, SearchResult } from '../types.ts';
import { normalizeAlias } from './alias-normalize.ts';
import { ALIAS_ORIGIN_RANK, titleName, type AliasOrigin } from '../mentions/aliases.ts';
import { readIdentitySiblings } from '../mentions/siblings.ts';
import { linkableTypesFor, loadSourcePack, readMentionPolicy } from '../mentions/policy.ts';

export const DEFAULT_ALIAS_FANOUT_MAX = 4;
export const FANOUT_ROWS_PER_ALIAS = 5;
export const FANOUT_SPLICE_CAP = 8;
const MAX_NGRAM = 4;
const STOPWORDS = new Set(['the', 'and', 'for', 'who', 'what', 'when', 'where', 'which', 'with', 'from', 'that', 'this', 'are', 'was', 'were',
  'our', 'your', 'their', 'does', 'did', 'has', 'have', 'how', 'any', 'all', 'about', 'into', 'its', 'is', 'of', 'to', 'in', 'on', 'a', 'an', 'at', 'by']);

export interface FanoutMeta {
  resolved_entity: string | null;
  aliases_searched: Array<{ alias: string; page: string; hits: number; truncated: boolean }>;
  aliases_skipped: string[];
  truncated: boolean;
}

interface Token { text: string; start: number; end: number }

function queryTokens(query: string): Token[] {
  const out: Token[] = [];
  for (const m of query.matchAll(/[\p{L}\p{N}][\p{L}\p{N}&'’.-]*/gu)) {
    const text = m[0].replace(/['’]s$/, '').replace(/[.'’-]+$/, '');
    if (text) out.push({ text, start: m.index!, end: m.index! + text.length });
  }
  return out;
}

const shaped = (t: string) => /^[A-Z0-9]/.test(t);

/** A name as a websearch phrase: quotes and websearch operators removed, so codes and punctuation stay literal. */
export function aliasPhrase(alias: string): string {
  const clean = alias.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? `"${clean}"` : '';
}

/** The ranking query: the phrase OR each other content term. */
export function aliasRankQuery(phrase: string, terms: string[]): string {
  return [phrase, ...terms.map(t => t.replace(/["\\-]/g, ''))].filter(Boolean).join(' OR ');
}

/** Keyword rows that contain `alias` (required phrase), ranked by `terms`. */
export async function searchAliasRequired(engine: BrainEngine, alias: string, terms: string[], opts: SearchOpts): Promise<SearchResult[]> {
  const phrase = aliasPhrase(alias);
  if (!phrase) return [];
  return engine.searchKeyword(phrase, { ...opts, orFallback: false, offset: 0, rankQuery: aliasRankQuery(phrase, terms) });
}

interface Scope { sourceId?: string; sourceIds?: string[]; excludePrivate: boolean }

/** The entity the query names: its pages (one, or an identity-sibling group) and the n-gram that named it. */
export async function resolveQueryEntity(engine: BrainEngine, query: string, scope: Scope):
  Promise<{ pages: Array<{ slug: string; source_id: string }>; tokens: [number, number] } | null> {
  const tokens = queryTokens(query);
  if (!tokens.length) return null;
  const grams: Array<{ text: string; norm: string; from: number; to: number }> = [];
  for (let n = Math.min(MAX_NGRAM, tokens.length); n >= 1; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const text = query.slice(tokens[i]!.start, tokens[i + n - 1]!.end);
      grams.push({ text, norm: normalizeAlias(text), from: i, to: i + n - 1 });
    }
  }
  const norms = [...new Set(grams.map(g => g.norm))];
  const aliasHits = await engine.resolveAliases(norms, scope).catch(() => new Map<string, Array<{ slug: string; source_id: string }>>());
  const sources = scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? 'default'];
  const policy = await readMentionPolicy(engine);
  const types = [...new Set((await Promise.all(sources.map(async s => linkableTypesFor(await loadSourcePack(engine, s), policy)))).flat())];
  const { privatePagesFilterFragment } = await import('./private-visibility.ts');
  const titleRows = await engine.executeRaw<{ slug: string; source_id: string; t: string }>(
    `SELECT slug, source_id, lower(title) AS t FROM pages
      WHERE lower(title) = ANY($1::text[]) AND source_id = ANY($2::text[]) AND type = ANY($3::text[]) AND deleted_at IS NULL
      ${scope.excludePrivate ? `AND ${privatePagesFilterFragment('pages')}` : ''}`, [norms, sources, types]).catch(() => []);
  const caseRows = await engine.executeRaw<{ slug: string; alias_norm: string; alias_text: string | null }>(
    `SELECT slug, alias_norm, alias_text FROM page_aliases WHERE alias_norm = ANY($1::text[]) AND case_sensitive AND source_id = ANY($2::text[])`,
    [norms, sources]).catch(() => []);
  const covered = new Set<number>();
  for (const g of grams) {
    if ([...Array(g.to - g.from + 1).keys()].some(k => covered.has(g.from + k))) continue;
    const titled = titleRows.filter(r => r.t === g.norm).map(r => ({ slug: r.slug, source_id: r.source_id }));
    const aliased = (aliasHits.get(g.norm) ?? []).filter(h => !caseRows.some(c => c.slug === h.slug && c.alias_norm === g.norm && c.alias_text !== g.text));
    const hits = titled.length ? titled : aliased;
    if (!hits.length) continue;
    const gramTokens = tokens.slice(g.from, g.to + 1).map(t => t.text);
    if (!(shaped(gramTokens[0]!) && shaped(gramTokens[gramTokens.length - 1]!)) && !(gramTokens.length > 1 && hits.length === 1)) continue;
    covered.add(g.from);
    for (let k = g.from; k <= g.to; k++) covered.add(k);
    if (hits.length === 1) return { pages: hits, tokens: [g.from, g.to] };
    const [first] = hits;
    const sib = await readIdentitySiblings(engine, first!.source_id, { slug: first!.slug, title: await titleOf(engine, first!) }, { excludePrivate: scope.excludePrivate });
    const group = new Set([first!.slug, ...sib.pages.map(p => p.slug)]);
    if (hits.every(h => h.source_id === first!.source_id && group.has(h.slug))) return { pages: hits, tokens: [g.from, g.to] };
  }
  return null;
}

async function titleOf(engine: BrainEngine, ref: { slug: string; source_id: string }): Promise<string | null> {
  const [row] = await engine.executeRaw<{ title: string | null }>('SELECT title FROM pages WHERE source_id = $1 AND slug = $2', [ref.source_id, ref.slug]).catch(() => []);
  return row?.title ?? null;
}

/** The names to fan out over: every alias of `pages` and their identity siblings, ordered by origin then length. */
async function namesOf(engine: BrainEngine, pages: Array<{ slug: string; source_id: string }>, scope: Scope): Promise<Array<{ alias: string; page: string; origin: string }>> {
  const all = new Map<string, { slug: string; source_id: string; title: string | null }>();
  for (const p of pages) {
    const title = await titleOf(engine, p);
    all.set(`${p.source_id}\0${p.slug}`, { ...p, title });
    const sib = await readIdentitySiblings(engine, p.source_id, { slug: p.slug, title }, { excludePrivate: scope.excludePrivate });
    for (const s of sib.pages) all.set(`${p.source_id}\0${s.slug}`, { slug: s.slug, source_id: p.source_id, title: s.title });
  }
  const refs = [...all.values()];
  const rows = await engine.executeRaw<{ slug: string; source_id: string; alias_norm: string; alias_text: string | null; origin: string | null }>(
    `SELECT slug, source_id, alias_norm, alias_text, origin FROM page_aliases
      WHERE source_id = ANY($1::text[]) AND slug = ANY($2::text[])`, [[...new Set(refs.map(r => r.source_id))], refs.map(r => r.slug)]).catch(() => []);
  const names = new Map<string, { alias: string; page: string; origin: string; rank: number }>();
  const add = (alias: string, page: string, origin: string) => {
    const norm = normalizeAlias(alias);
    const rank = ALIAS_ORIGIN_RANK[origin as AliasOrigin] ?? 3;
    const prev = names.get(norm);
    if (norm && (!prev || rank < prev.rank)) names.set(norm, { alias, page, origin, rank });
  };
  for (const r of rows) add(r.alias_text ?? r.alias_norm, r.slug, r.origin ?? 'frontmatter');
  for (const r of refs) if (r.title) add(titleName(r.title), r.slug, 'title');
  return [...names.values()].sort((a, b) => a.rank - b.rank || b.alias.length - a.alias.length);
}

export async function aliasFanoutMax(engine: BrainEngine): Promise<number> {
  const raw = await engine.getConfig('search.alias_fanout_max').catch(() => null);
  const n = raw == null || raw === '' ? DEFAULT_ALIAS_FANOUT_MAX : Number(raw);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 16) : DEFAULT_ALIAS_FANOUT_MAX;
}

/**
 * Splice rows found under the entity's other names into `results`. `fallback`
 * supplies (name, alias) pairs the top rows declare, used when no entity
 * resolves. Fail-soft: any error returns `results` unchanged.
 */
export async function withAliasFanOut(engine: BrainEngine, results: SearchResult[], queryText: string, scope: Scope, searchOpts: SearchOpts,
  fallback: () => Array<{ name: string; alias: string; slug: string }>): Promise<{ results: SearchResult[]; fanout?: FanoutMeta }> {
  try {
    const max = await aliasFanoutMax(engine);
    if (max === 0) return { results };
    const queryLc = ` ${queryText.toLowerCase()} `;
    const inQuery = (name: string) => new RegExp(`(?<![\\p{L}\\p{N}])${normalizeAlias(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(normalizeAlias(queryLc));
    const resolved = await resolveQueryEntity(engine, queryText, scope);
    let names: Array<{ alias: string; page: string }>;
    let usedTokens: [number, number] | null = null;
    if (resolved) {
      names = (await namesOf(engine, resolved.pages, scope)).filter(n => !inQuery(n.alias));
      usedTokens = resolved.tokens;
    } else {
      names = fallback().map(d => inQuery(d.name) ? { alias: d.alias, page: d.slug } : { alias: d.name, page: d.slug }).filter(n => !inQuery(n.alias));
    }
    const seenNames = new Set<string>();
    names = names.filter(n => { const k = normalizeAlias(n.alias); if (seenNames.has(k)) return false; seenNames.add(k); return true; });
    if (!names.length) return { results };
    const tokens = queryTokens(queryText);
    const terms = tokens.filter((_, i) => !usedTokens || i < usedTokens[0] || i > usedTokens[1]).map(t => t.text)
      .filter(t => !STOPWORDS.has(t.toLowerCase()) && t.length >= 2 && !names.some(n => normalizeAlias(n.alias).split(' ').includes(t.toLowerCase())));
    const searched = names.slice(0, max);
    const skipped = names.slice(max).map(n => n.alias);
    const found = await Promise.all(searched.map(n => searchAliasRequired(engine, n.alias, terms, { ...searchOpts, limit: FANOUT_ROWS_PER_ALIAS })
      .catch(() => [] as SearchResult[])));
    const seen = new Set(results.map(r => `${r.source_id ?? ''}\0${r.slug}`));
    const fresh: SearchResult[] = [];
    searched.forEach((n, i) => {
      for (const r of found[i]!) {
        const key = `${r.source_id ?? ''}\0${r.slug}`;
        if (seen.has(key) || fresh.length >= FANOUT_SPLICE_CAP) continue;
        seen.add(key);
        fresh.push({ ...r, matched_alias: n.alias });
      }
    });
    const fanout: FanoutMeta = {
      resolved_entity: resolved ? resolved.pages[0]!.slug : null,
      aliases_searched: searched.map((n, i) => ({ alias: n.alias, page: n.page, hits: found[i]!.length, truncated: found[i]!.length >= FANOUT_ROWS_PER_ALIAS })),
      aliases_skipped: skipped,
      truncated: skipped.length > 0,
    };
    if (!fresh.length) return { results, fanout };
    return { results: [...results.slice(0, 2), ...fresh, ...results.slice(2)], fanout };
  } catch {
    return { results };
  }
}
