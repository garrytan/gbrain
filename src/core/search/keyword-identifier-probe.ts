/**
 * #7491: the identifier probe of the keyword arm. A question naming a page by
 * an identifier ("What did the latest weekly digest (#412) say?") carries
 * filler words no chunk holds together with the identifier, so the strict
 * AND of every word misses the one page holding it: no chunk holds every
 * word and the any-word retry's rows are relaxed (hybrid drops them while the
 * vector arm is healthy, and near-identical template pages tie on vectors),
 * the retry ranks long chunks repeating common words above the short chunk
 * holding the identifier, or an unrelated chunk holds every word and strict
 * never reaches the target.
 *
 * An identifier-shaped token is evidence in its own right: a hash number
 * (#412) or what search/identifier-query.ts recognizes in one token (a long
 * digit run, a hex id, a code like INV-2026-00417, an email, a URL, a phone
 * number). When the query has one and other words besides it, the keyword arm
 * runs one more statement, the arm's own statement with the AND of the
 * identifier tokens as its match query and the any-word query as its rank
 * query, so the probe has the same scope, visibility, chunk predicate and
 * filters as strict, pages holding more query words rank first among its
 * rows, and Postgres bounds it by the same candidate cap. Its rows hold every
 * identifier the question names, so they vote like strict rows: after the
 * strict rows when strict matched, and ahead of the relaxed rows when it did
 * not. Queries without such a token, a paged read (offset), precision callers
 * (no orFallback) and queries with a quoted phrase or a negation run exactly
 * as before. A failed probe adds nothing.
 */
import type { SearchResult } from '../types.ts';
import { parseIdentifier } from './identifier-query.ts';
import { buildOrFallbackWebsearchQuery, orFallbackTokens } from './sql-ranking.ts';
import { slugHandles } from './keyword-handles.ts';

const HASH_NUMBER_RE = /^#(\d+)$/;

/** The query's identifier tokens (a hash number without its `#`), or null when it names none or nothing else. */
export function identifierTokens(query: string): string[] | null {
  const idents = new Set<string>();
  for (const raw of query.split(/\s+/)) {
    const token = raw.replace(/^[(\[{<'\u2018\u201c]+|[)\]}>'\u2019\u201d.,;:!?]+$/gu, '');
    const hash = HASH_NUMBER_RE.exec(token);
    if (hash) idents.add(hash[1]!);
    else if (parseIdentifier(token)) idents.add(token);
  }
  if (idents.size === 0) return null;
  const identTerms = new Set(orFallbackTokens([...idents].join(' ')).map(t => t.toLowerCase()));
  if (orFallbackTokens(query).every(t => identTerms.has(t.toLowerCase()))) return null;
  return [...idents];
}

/** The websearch AND of the query's identifier tokens, or null (identifierTokens). */
export function identifierProbeQuery(query: string): string | null {
  return identifierTokens(query)?.join(' ') ?? null;
}

/** Whether `text` holds every token, each bounded by characters other than letters and digits. */
export function holdsIdentifiers(text: string | null | undefined, tokens: readonly string[]): boolean {
  const hay = (text ?? '').toLowerCase();
  return tokens.every(token => {
    const needle = token.toLowerCase();
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
      if (!/[\p{L}\p{N}]/u.test(hay[at - 1] ?? '') && !/[\p{L}\p{N}]/u.test(hay[at + needle.length] ?? '')) return true;
    }
    return false;
  });
}

/** `rows`, then the rows of `more` on pages `rows` does not hold, up to `limit`. */
function appendPages(rows: SearchResult[], more: SearchResult[], limit: number): SearchResult[] {
  const pages = new Set(rows.map(r => r.page_id));
  return [...rows, ...more.filter(r => !pages.has(r.page_id))].slice(0, limit);
}

/**
 * The keyword arm's rows from its strict rows: with orFallback, the probe's
 * rows (see the module comment) and, when strict found nothing, the any-word
 * retry's rows tagged `keyword_relaxed` (the #3617 follow-up: hybrid drops
 * them while the vector arm is healthy). `runProbe` runs the arm's statement
 * with a match and a rank query; `runRelaxed` runs the engine's retry.
 */
export async function keywordArmRows<R>(a: {
  query: string;
  strict: R[];
  orFallback?: boolean;
  limit: number;
  offset: number;
  toResult: (row: R) => SearchResult;
  runProbe: (matchQuery: string, rankQuery: string) => Promise<R[]>;
  runRelaxed: (orQuery: string) => Promise<R[]>;
  /** GBRA-108: the pages the query's slug handles name (search/keyword-handles.ts); they lead the rows, untagged. */
  runHandles?: (handles: string[]) => Promise<SearchResult[]>;
}): Promise<SearchResult[]> {
  const handles = a.orFallback && a.offset === 0 && a.runHandles ? slugHandles(a.query) : null;
  const named = handles ? await a.runHandles!(handles).catch(() => [] as SearchResult[]) : [];
  const orQuery = a.orFallback ? buildOrFallbackWebsearchQuery(a.query) : null;
  const probeQuery = orQuery && a.offset === 0 ? identifierProbeQuery(a.query) : null;
  const probe = probeQuery ? (await a.runProbe(probeQuery, orQuery!).catch(() => [] as R[])).map(a.toResult) : [];
  if (a.strict.length > 0 || !orQuery) return appendPages(named, appendPages(a.strict.map(a.toResult), probe, a.limit), a.limit);
  const relaxed = (await a.runRelaxed(orQuery)).map(r => ({ ...a.toResult(r), keyword_relaxed: true as const }));
  return appendPages(named, appendPages(probe, relaxed, a.limit), a.limit);
}
