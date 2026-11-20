/**
 * Exact widening (`search.exact_widen`, default on), for `search` and `query`.
 * Ranked retrieval can miss a page whose only mention sits in a chunk the
 * ranked arms did not surface (a stale or missing search vector, a degraded
 * pipeline, a stemming mismatch). When a result is degraded or thin, the op
 * also runs the literal scan `search_exact` uses (search/exact-scan.ts, under
 * the caller's own read policy) for the query's content terms as a phrase, and
 * merges the pages it finds that the result does not hold.
 *
 * Degraded: any stage that affects recall (`affectsRecall`), except the two a brain's own configuration causes on
 * every search (embeddings turned off, or no provider: a keyword-only brain is not a fault to repair per call). Thin: no returned
 * row's text holds every query content term. A result with at least one row
 * that holds them all is neither, so it never pays for the scan, and only a
 * short query (EXACT_WIDEN_MAX_WORDS) gets a phrase at all. Merged rows are
 * marked `widened: 'exact'` and score below the rows they follow; they fill free
 * rows under the caller's row count first, and a thin result (not merely a
 * degraded one) lets them replace up to EXACT_WIDEN_MAX_PAGES of its lowest page
 * rows. This file is the pure part; ops/search-widen.ts runs the scan.
 */
import { affectsRecall, type SearchResult } from '../types.ts';
import { queryTerms } from './fact-relevance.ts';

export const EXACT_WIDEN_KEY = 'search.exact_widen';
/** Pages merged at most. */
export const EXACT_WIDEN_MAX_PAGES = 3;
/** A raw query with more words than this, or more characters than EXACT_WIDEN_MAX_CHARS, gets no phrase. */
export const EXACT_WIDEN_MAX_WORDS = 8;
export const EXACT_WIDEN_MAX_CHARS = 120;
/** The scan's own deadline: widening is an addition to a ranked answer, never a long wait. */
export const EXACT_WIDEN_SECONDS = 3;

/** `search.exact_widen` is on by default; 'false' | 'off' | '0' | 'no' turns it off, and so does any read error. */
export async function exactWidenEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    const raw = (await engine.getConfig(EXACT_WIDEN_KEY))?.trim().toLowerCase();
    return !(raw === 'false' || raw === 'off' || raw === '0' || raw === 'no');
  } catch {
    return false;
  }
}

/** The query's content terms as the literal phrase to scan, or null for a long query or one with no content term. */
export function widenPhrase(query: string): { phrase: string; terms: string[] } | null {
  const raw = query.trim();
  if (!raw || raw.length > EXACT_WIDEN_MAX_CHARS || raw.split(/\s+/).length > EXACT_WIDEN_MAX_WORDS) return null;
  const terms = queryTerms(raw);
  return terms.length ? { phrase: terms.join(' '), terms } : null;
}

const fold = (text: string) => text.toLowerCase().replace(/[‘’]/g, "'");

/** Whether `text` holds every term (a possessive's 's aside). */
export function holdsEveryTerm(text: string, terms: readonly string[]): boolean {
  const folded = fold(text);
  return terms.every(t => folded.includes(t.replace(/'s$/, '')));
}

/** Stage and reason pairs a brain's configuration causes on every search (as the notice ledger's configuration-persistent set). */
const CONFIGURED_KEYWORD_ONLY: ReadonlySet<string> = new Set(['embed_unavailable:embedding_disabled', 'embed_unavailable:no_provider']);

/** Why a result is widened: a degraded stage that affects recall, rows that never hold every query term, or null. */
export function widenReason(rows: readonly Pick<SearchResult, 'chunk_text'>[], terms: readonly string[], degraded: ReadonlyArray<{ stage?: string; reason?: string }> | undefined): 'degraded' | 'thin' | null {
  if (!rows.some(r => holdsEveryTerm(r.chunk_text ?? '', terms))) return 'thin';
  return degraded?.some(d => affectsRecall(d) && !CONFIGURED_KEYWORD_ONLY.has(`${d.stage}:${d.reason ?? ''}`)) ? 'degraded' : null;
}

const pageKey = (r: Pick<SearchResult, 'source_id' | 'slug'>) => JSON.stringify([r.source_id ?? 'default', r.slug]);
const isPage = (r: SearchResult) => !r.fact_row && r.result_type !== 'fact';

/**
 * The rows with the exact hits that are not already there merged in: free rows under `cap` first, then, for a thin
 * result, in place of the lowest-scoring page rows (never an exact slug, title or alias hit), at most EXACT_WIDEN_MAX_PAGES.
 * `added` is the hits that got a row.
 */
export function mergeExactHits(rows: SearchResult[], hits: SearchResult[], cap: number, replace: boolean): { rows: SearchResult[]; added: SearchResult[] } {
  const held = new Set(rows.filter(isPage).map(pageKey));
  const fresh = hits.filter(h => !held.has(pageKey(h))).slice(0, EXACT_WIDEN_MAX_PAGES);
  const free = Math.max(0, cap - rows.length);
  const take = replace ? fresh.length : Math.min(fresh.length, free);
  const movable = rows.map((r, i) => ({ r, i })).filter(({ r }) => isPage(r) && !r.exact_lookup && !r.alias_hit);
  const drop = new Set(movable.sort((a, b) => (Number.isFinite(a.r.score) ? a.r.score : -Infinity) - (Number.isFinite(b.r.score) ? b.r.score : -Infinity) || b.i - a.i)
    .slice(0, Math.min(Math.max(0, take - free), movable.length)).map(m => m.i));
  const kept = rows.filter((_, i) => !drop.has(i));
  const added = fresh.slice(0, Math.min(take, free + drop.size));
  if (!added.length) return { rows, added: [] };
  const floor = kept.reduce((m, r) => (Number.isFinite(r.score) && r.score < m ? r.score : m), kept.find(r => Number.isFinite(r.score))?.score ?? 1);
  const marked = added.map((h, i) => ({ ...h, score: floor - (i + 1) * 1e-6 }));
  return { rows: [...kept, ...marked], added: marked };
}

const widened = new WeakSet<object>();
/** Record that widening ran for the call whose timings object this is (meta reads it back). */
export const markExactWidened = (callKey: object): void => { widened.add(callKey); };
export const exactWidenRan = (callKey: object): boolean => widened.has(callKey);
