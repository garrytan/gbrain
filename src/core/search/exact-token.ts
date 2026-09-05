/**
 * Exact opaque-identifier precedence (bounded ranking rule).
 *
 * A query that is ONE opaque token (an external record id such as
 * `not_07plSpjDUyKyqT`, `rec_8fA3kQ`, `4f9c2e1ab7`) is a lookup, not a topic.
 * The keyword arm answers it exactly (the chunk carrying the literal), but
 * hybrid fusion scores that keyword-only row against semantic candidates
 * that embed close to the query vector, and the cosine blend plus the
 * metadata boosts (backlinks, salience, recency) can push the literal hit
 * out of the top results behind notes that merely look similar.
 *
 * The rule: when `isOpaqueTokenQuery(query)` holds AND the strict (non
 * relaxed) lexical arms returned rows whose text carries the token as a
 * whole token, those rows take precedence over every semantic-only
 * candidate before the final limit. Rows already in the ranked set are
 * promoted to the top in their fused order; literal rows that fusion or
 * dedup dropped are injected (capped) above the organic set. Everything else
 * is untouched: no new arm, no re-query, no change for multi-word queries,
 * for tokens that match nothing, or for callers that turn the knob off
 * (`search.exact_token_precedence`, per-call `exact_token_precedence`).
 *
 * Source, type and privacy filters are preserved by construction: the only
 * rows this stage can surface are rows the engine's keyword / title arms
 * already returned under the caller's SearchOpts.
 */

import type { SearchResult } from '../types.ts';

/** Minimum token length before a single token is treated as an opaque id. */
export const EXACT_TOKEN_MIN_LENGTH = 8;
/** Cap on rows injected (absent from the ranked set) per query. */
export const MAX_EXACT_TOKEN_INJECT = 3;

/**
 * Prefix shapes commonly minted by external systems (`not_`, `rec_`,
 * `evt_`, `cus_`, ...): a short lowercase alpha prefix, an underscore, then
 * an alphanumeric body. Matched structurally rather than by an allow-list so
 * a new integration's ids qualify without a code change.
 */
const PREFIXED_ID = /^[a-z]{2,8}_[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Allowed character set for an opaque token (no whitespace, no path separators). */
const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/;

/**
 * Is the query a single opaque token? True for one whitespace-free token of
 * at least EXACT_TOKEN_MIN_LENGTH characters drawn from [A-Za-z0-9_-] that
 * either mixes letters and digits or carries a known id-prefix shape. Plain
 * words (`photosynthesis`), slugs (`people/alice-example`) and multi-word
 * queries are not opaque tokens.
 */
export function isOpaqueTokenQuery(query: string): boolean {
  const q = query.trim();
  if (q.length < EXACT_TOKEN_MIN_LENGTH) return false;
  if (!TOKEN_CHARS.test(q)) return false;
  const hasLetter = /[A-Za-z]/.test(q);
  const hasDigit = /[0-9]/.test(q);
  if (hasLetter && hasDigit) return true;
  return PREFIXED_ID.test(q);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-token literal test: the token must appear in `text` bounded by the
 * start/end of the text or a character outside [A-Za-z0-9_-], so `rec_8fA3`
 * does not match inside `rec_8fA3kQ`. Case-insensitive, mirroring the FTS
 * arm's case folding.
 */
export function containsLiteralToken(text: string | null | undefined, token: string): boolean {
  if (!text) return false;
  const re = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(token)}(?=$|[^A-Za-z0-9_-])`, 'i');
  return re.test(text);
}

export interface ExactTokenDecision {
  token: string;
  /** Literal rows already in the ranked set that were moved to the top. */
  promoted: number;
  /** Literal rows absent from the ranked set that were injected at the top. */
  injected: number;
}

export interface ExactTokenOpts {
  /** Raw keyword-arm rows (chunk grain), as returned by engine.searchKeyword. */
  keywordResults: SearchResult[];
  /** Raw title-arm rows (page grain), as returned by engine.searchTitles. */
  titleResults?: SearchResult[];
}

function rowKey(r: SearchResult): string {
  return `${r.source_id ?? 'default'}::${r.slug}::${r.chunk_id ?? 0}`;
}
function pageKey(r: SearchResult): string {
  return `${r.source_id ?? 'default'}::${r.slug}`;
}

/**
 * Literal rows from the strict lexical arms for an opaque-token query.
 * Relaxed (OR-fallback) rows never count: they matched other terms.
 */
export function literalTokenRows(query: string, opts: ExactTokenOpts): SearchResult[] {
  const token = query.trim();
  if (!isOpaqueTokenQuery(token)) return [];
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const list of [opts.keywordResults, opts.titleResults ?? []]) {
    for (const r of list) {
      if (r.keyword_relaxed) continue;
      if (!containsLiteralToken(r.chunk_text, token) && !containsLiteralToken(r.title, token)) continue;
      const key = rowKey(r);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

/**
 * Apply the precedence rule to a ranked result set. Returns a NEW array (the
 * input order is preserved for non-literal rows) plus the decision, or
 * `decision: null` when the rule did not fire. Pure and synchronous; runs
 * after the structural exact-lookup tier and before adaptive-return /
 * autocut / the limit slice on every hybrid return path.
 */
export function applyExactTokenPrecedence(
  results: SearchResult[],
  query: string,
  opts: ExactTokenOpts,
): { results: SearchResult[]; decision: ExactTokenDecision | null } {
  const literal = literalTokenRows(query, opts);
  if (literal.length === 0) return { results, decision: null };
  const token = query.trim();

  // Literal identity at both grains: a chunk-grain literal row promotes the
  // exact chunk when present, and otherwise any ranked row of the same page
  // (dedup may have kept a sibling chunk of the page that carries the id).
  const literalRowKeys = new Set(literal.map(rowKey));
  const literalPageKeys = new Set(literal.map(pageKey));

  const promotedRows: SearchResult[] = [];
  const rest: SearchResult[] = [];
  const promotedPages = new Set<string>();
  for (const r of results) {
    const isLiteral = literalRowKeys.has(rowKey(r))
      || (literalPageKeys.has(pageKey(r)) && (containsLiteralToken(r.chunk_text, token) || containsLiteralToken(r.title, token)));
    if (isLiteral) {
      promotedRows.push(r);
      promotedPages.add(pageKey(r));
    } else {
      rest.push(r);
    }
  }

  // Inject literal rows whose page is absent from the ranked set entirely
  // (dropped by fusion / dedup), capped. They are engine rows, so they
  // already honor the caller's source / type / privacy filters.
  const injectedRows: SearchResult[] = [];
  for (const r of literal) {
    if (injectedRows.length >= MAX_EXACT_TOKEN_INJECT) break;
    if (promotedPages.has(pageKey(r))) continue;
    if (injectedRows.some((x) => pageKey(x) === pageKey(r))) continue;
    injectedRows.push({ ...r });
  }

  if (promotedRows.length === 0 && injectedRows.length === 0) return { results, decision: null };

  // Scores: top-of-organic + epsilon (the alias-hop / exact-lookup injection
  // shape), descending so the promoted rows keep their fused order and sort
  // above every organic row. base_score is left as fused so the agent's
  // dedup gate still reads the pre-boost signal; evidence reads exact_token.
  const topScore = results.reduce((m, r) => (Number.isFinite(r.score) && r.score > m ? r.score : m), 0);
  const head = [...promotedRows, ...injectedRows];
  const n = head.length;
  const stamped = head.map((r, i) => ({
    ...r,
    score: (topScore > 0 ? topScore : 1.0) + (n - i) * 1e-6,
    exact_token: true as const,
    keyword_hit: true as const,
  }));

  return {
    results: [...stamped, ...rest],
    decision: { token, promoted: promotedRows.length, injected: injectedRows.length },
  };
}
