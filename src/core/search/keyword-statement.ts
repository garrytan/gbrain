/**
 * Page-grain keyword statements for `search` (Cat 40 Hard F2): the strict
 * keyword match count (`keyword_total` on hybrid calls, `total` with
 * `match: "keyword"`) and the keyword-mode page query. Both read ONE WHERE
 * builder, so a count can never include a page the rows could not return.
 *
 * The match is `engine.searchKeyword`'s strict match, never its OR-of-terms
 * retry: `websearch_to_tsquery` over `content_chunks.search_vector` (the CJK
 * branch: every term as a LIKE/ILIKE substring), text chunks only, with the
 * same page filters (type/types, exclude_slugs, language/symbol kind, dates,
 * source scope, hard-excluded prefixes) and the same visibility predicate
 * (soft delete, archived source, quarantine, current projection, private
 * pages, safe chunks). Safe-chunk pages hold no private takes/facts fence
 * text, so an untrusted caller's count never counts fence text.
 *
 * The page query takes the best chunk of every matching page BEFORE paging
 * (no global chunk cap: one page with hundreds of matching chunks cannot
 * crowd the others out) and orders pages by (score DESC, page_id ASC), the
 * keyset the cursor resumes from. Scores are float8 so a cursor's score
 * round-trips through JSON exactly.
 */
import type { SearchOpts } from '../types.ts';
import { escapeLikePattern, hasCJK, splitCJKQueryTerms } from '../cjk.ts';
import { getFtsLanguage } from '../fts-language.ts';
import { resolveBoostMap, resolveHardExcludes } from './source-boost.ts';
import { buildHardExcludeClause, buildSourceFactorCase, buildVisibilityClause } from './sql-ranking.ts';

/** Counts stop here; a capped count is reported as "10000+". */
export const KEYWORD_COUNT_CAP = 10_000;

/** Where the keyword-mode page query resumes: after this (score, page_id). */
export interface KeywordPageAfter { score: number; page_id: number }

export interface KeywordPageWindow { limit: number; offset?: number; after?: KeywordPageAfter }

interface KeywordMatch { where: string; score: string; params: unknown[] }

const FROM = `content_chunks cc JOIN pages p ON p.id = cc.page_id JOIN sources s ON s.id = p.source_id`;

/** The shared match: WHERE text (with leading predicate) and the chunk score, or null when nothing can match. */
export function buildKeywordMatch(query: string, opts: SearchOpts | undefined): KeywordMatch | null {
  const params: unknown[] = [];
  let predicate: string;
  let rank: string;
  if (hasCJK(query)) {
    const terms = splitCJKQueryTerms(query);
    if (terms.length === 0) return null;
    const likes = terms.map(term => {
      params.push(`%${escapeLikePattern(term)}%`);
      return `cc.chunk_text ${term.toLowerCase() === term.toUpperCase() ? 'LIKE' : 'ILIKE'} $${params.length} ESCAPE '\\'`;
    });
    const freq = terms.map(term => {
      params.push(term);
      return `((LENGTH(cc.chunk_text) - LENGTH(REPLACE(cc.chunk_text, $${params.length}, ''))) / NULLIF(LENGTH($${params.length}), 0)::real)`;
    });
    predicate = likes.join(' AND ');
    rank = freq.join(' + ');
  } else {
    if (query.trim() === '') return null;
    params.push(query);
    const tsq = `websearch_to_tsquery('${getFtsLanguage()}', $${params.length})`;
    predicate = `cc.search_vector @@ ${tsq}`;
    rank = `ts_rank(cc.search_vector, ${tsq})`;
  }
  const add = (value: unknown, clause: (n: string) => string): string => { params.push(value); return ` AND ${clause(`$${params.length}`)}`; };
  let filters = '';
  if (opts?.detail === 'low') filters += ` AND cc.chunk_source = 'compiled_truth'`;
  if (opts?.language) filters += add(opts.language, n => `cc.language = ${n}`);
  if (opts?.symbolKind) filters += add(opts.symbolKind, n => `cc.symbol_type = ${n}`);
  if (opts?.type) filters += add(opts.type, n => `p.type = ${n}`);
  if (opts?.types?.length) filters += add(opts.types, n => `p.type = ANY(${n}::text[])`);
  if (opts?.exclude_slugs?.length) filters += add(opts.exclude_slugs, n => `p.slug != ALL(${n}::text[])`);
  const dated = `COALESCE(p.effective_date, p.updated_at, p.created_at)`;
  if (opts?.afterDate) filters += add(opts.afterDate, n => `${dated} ${opts.afterDateInclusive ? '>=' : '>'} ${n}::text::timestamptz`);
  if (opts?.beforeDate) filters += add(opts.beforeDate, n => `${dated} ${opts.beforeDateInclusive ? '<=' : '<'} ${n}::text::timestamptz`);
  if (opts?.sourceIds?.length) filters += add(opts.sourceIds, n => `p.source_id = ANY(${n}::text[])`);
  else if (opts?.sourceId) filters += add(opts.sourceId, n => `p.source_id = ${n}`);
  const hardExclude = buildHardExcludeClause('p.slug', resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes));
  const factor = buildSourceFactorCase('p.slug', opts?.source_boosts ?? resolveBoostMap(), opts?.detail);
  return {
    where: `${predicate}${filters} ${hardExclude} ${buildVisibilityClause('p', 's', opts)} AND cc.modality = 'text'`,
    score: `((${rank}) * ${factor})::float8`,
    params,
  };
}

/** Distinct matching pages, capped at KEYWORD_COUNT_CAP + 1. */
export function buildKeywordCountStatement(query: string, opts: SearchOpts | undefined): { sql: string; params: unknown[] } | null {
  const m = buildKeywordMatch(query, opts);
  if (!m) return null;
  return {
    sql: `SELECT count(*)::int AS n FROM (SELECT DISTINCT cc.page_id FROM ${FROM} WHERE ${m.where} LIMIT ${KEYWORD_COUNT_CAP + 1}) matched`,
    params: m.params,
  };
}

/** One page of matching pages, best chunk each, in keyset order. */
export function buildKeywordPagesStatement(query: string, opts: SearchOpts | undefined, page: KeywordPageWindow): { sql: string; params: unknown[] } | null {
  const m = buildKeywordMatch(query, opts);
  if (!m) return null;
  const params = [...m.params];
  let after = '';
  if (page.after) {
    params.push(page.after.score, page.after.page_id);
    const s = `$${params.length - 1}::float8`;
    after = `WHERE b.score < ${s} OR (b.score = ${s} AND b.page_id > $${params.length}::bigint)`;
  }
  params.push(page.limit, page.offset ?? 0);
  const messageId = `NULLIF(regexp_replace(p.frontmatter->>'message_id', '^[[:space:]]+|[[:space:]]+$', '', 'g'), '') IS NOT NULL`;
  return {
    sql: `WITH matched AS (
        SELECT cc.page_id, cc.id AS chunk_id, ${m.score} AS score FROM ${FROM} WHERE ${m.where}
      ), best AS (
        SELECT DISTINCT ON (page_id) page_id, chunk_id, score FROM matched ORDER BY page_id, score DESC, chunk_id ASC
      )
      SELECT p.slug, p.id AS page_id, p.title, p.type, p.source_id, p.effective_date, p.effective_date_source,
        CASE WHEN ${messageId} THEN p.frontmatter->>'message_id' END AS message_id, p.frontmatter->>'thread_id' AS thread_id,
        CASE WHEN ${messageId} THEN NULLIF(p.frontmatter->>'subject', '') END AS source_subject,
        cc.id AS chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source, b.score, false AS stale
      FROM best b JOIN pages p ON p.id = b.page_id JOIN content_chunks cc ON cc.id = b.chunk_id
      ${after}
      ORDER BY b.score DESC, b.page_id ASC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  };
}
