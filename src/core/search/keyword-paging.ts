/**
 * Honest counts and exhaustive paging for `search` (Cat 40 Hard F2).
 *
 * Hybrid rows are a ranked top-K; agents read a full page of them as "this is
 * everything" and re-search instead of paging. So:
 *   - every `search` reports `keyword_total` / `keyword_truncated`: distinct
 *     pages matching the strict keyword query under the call's filters and
 *     visibility (engine.countKeywordPages, never the OR-of-terms retry or a
 *     capped pool), counted in parallel with the search under a deadline and
 *     capped at 10,000 ("10000+"); a count that misses its deadline is the
 *     `keyword_count_unavailable` degraded stage, never a number;
 *   - `match: "keyword"` enumerates exactly that set at page grain in
 *     (score DESC, page_id ASC) order with `total`, `truncated` and `next`
 *     (a ready-to-send argument object holding a keyset cursor), the words
 *     get_backlinks uses. Every enumerated page keeps a row, so `next` never
 *     skips a page the caller did not receive;
 *   - one model-visible line after the rows says which set the count covers
 *     (dispatch renders `searchCountLine` from `_meta.retrieval`).
 *
 * Hybrid `offset` keeps its meaning (rows to skip in the ranked list). Any
 * offset is capped at 10,000; a `cursor` outside keyword mode and a remote
 * `mode` are refused with a fix that names `match: "keyword"`.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { DegradedStageEntry, SearchOpts, SearchResult } from '../types.ts';
import { opError, type OperationContext } from '../ops/contract.ts';
import { invalidParam } from '../ops/op-fix.ts';
import { expandEngineTypeFilters } from '../schema-pack/query-types.ts';
import { KEYWORD_COUNT_CAP, type KeywordPageAfter } from './keyword-statement.ts';

export type SearchMatch = 'hybrid' | 'keyword';

export const SEARCH_OFFSET_CAP = 10_000;
/** The count's deadline: it runs beside the search and never holds the response longer. */
export const KEYWORD_COUNT_TIMEOUT_MS = 2_000;

/** Params a keyword `next` carries over unchanged. */
const CARRIED_PARAMS = ['limit', 'types', 'source_id', 'snippet_chars', 'return_unit', 'return_window', 'token_budget', 'fields'] as const;

interface KeywordCursor extends KeywordPageAfter { shown: number }

export interface SearchPaging { match: SearchMatch; offset: number; cursor: KeywordCursor | null }

/** Binds a cursor to the query and filters it was issued for. */
function fingerprint(p: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify([p.query, p.types ?? null, p.source_id ?? null])).digest('base64url').slice(0, 12);
}

function encodeCursor(after: KeywordPageAfter, shown: number, p: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify({ v: 1, s: after.score, p: after.page_id, n: shown, f: fingerprint(p) })).toString('base64url');
}

function decodeCursor(raw: string, p: Record<string, unknown>): KeywordCursor | 'mismatch' | null {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { v?: unknown; s?: unknown; p?: unknown; n?: unknown; f?: unknown };
    if (c.v !== 1 || typeof c.s !== 'number' || !Number.isFinite(c.s) || !Number.isInteger(c.p) || !Number.isInteger(c.n) || (c.n as number) < 0) return null;
    if (c.f !== fingerprint(p)) return 'mismatch';
    return { score: c.s, page_id: c.p as number, shown: c.n as number };
  } catch {
    return null;
  }
}

/** Validates `match`, `cursor`, `offset` and a remote `mode` before any search runs. */
export function parseSearchPaging(ctx: OperationContext, p: Record<string, unknown>): SearchPaging {
  if (p.match !== undefined && p.match !== 'hybrid' && p.match !== 'keyword') {
    throw invalidParam(ctx, 'search', 'match', `\`match\` must be "hybrid" or "keyword" (got ${JSON.stringify(p.match)}).`, { choices: ['hybrid', 'keyword'], example: 'keyword' });
  }
  const match: SearchMatch = p.match === 'keyword' ? 'keyword' : 'hybrid';
  if (ctx.remote !== false && typeof p.mode === 'string' && p.mode !== '') {
    const { mode: _mode, ...rest } = p;
    throw opError('search_mode_local_only', 'search: mode is set by the brain\'s operator and cannot be chosen per call.',
      'Omit mode. For keyword-only matching with a total and a next page, pass match: "keyword".',
      { fix: { mcp: { tool: 'search', arguments: { ...rest, ...(/keyword|lexical|exact|fts|text/i.test(p.mode) ? { match: 'keyword' } : {}) } },
        consent: [], actor: 'agent', requires_exclusive: false, why: 'The same search without mode.' } });
  }
  const offset = typeof p.offset === 'number' && Number.isFinite(p.offset) ? Math.max(0, Math.floor(p.offset)) : 0;
  if (offset > SEARCH_OFFSET_CAP) {
    throw opError('search_offset_over_cap', `search: offset ${offset} is over the ${SEARCH_OFFSET_CAP.toLocaleString('en-US')} limit.`,
      'Page with match: "keyword" and send the next object each response returns; a cursor has no depth limit.');
  }
  if (p.cursor === undefined) return { match, offset, cursor: null };
  if (match !== 'keyword') {
    throw opError('search_cursor_requires_keyword', 'search: cursor continues a match: "keyword" listing; this call is hybrid.',
      'Send the next object from the previous response unchanged (it carries match: "keyword"). Hybrid rows are a ranked top-K with no next page.',
      { fix: { mcp: { tool: 'search', arguments: { ...p, match: 'keyword' } }, consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Continues the keyword listing from the cursor.' } });
  }
  if (offset > 0) throw invalidParam(ctx, 'search', 'offset', 'search: pass cursor or offset, not both.', { example: 0 });
  const cursor = typeof p.cursor === 'string' ? decodeCursor(p.cursor, p) : null;
  if (cursor === null) throw invalidParam(ctx, 'search', 'cursor', 'search: cursor is not one this tool returned.', { example: 'the next object from the previous response' });
  if (cursor === 'mismatch') {
    throw invalidParam(ctx, 'search', 'cursor', 'search: this cursor belongs to a different query, types or source_id.', { example: 'the next object from the previous response' });
  }
  return { match, offset, cursor };
}

export type KeywordCount = { total: number; capped: boolean } | { unavailable: 'timeout' | 'error' };

const isTimeout = (e: unknown) => /statement timeout|canceling statement/i.test(e instanceof Error ? e.message : String(e))
  || (e as { code?: unknown } | null)?.code === '57014';

/** The strict keyword count under a deadline; a late or failed count is unavailable, never a number. */
export async function countKeywordMatches(engine: BrainEngine, query: string, opts: SearchOpts, timeoutMs = KEYWORD_COUNT_TIMEOUT_MS): Promise<KeywordCount> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<KeywordCount>(resolve => { timer = setTimeout(() => resolve({ unavailable: 'timeout' }), timeoutMs); });
  const count = engine.countKeywordPages(query, { ...opts, timeoutMs })
    .then((n): KeywordCount => ({ total: Math.min(n, KEYWORD_COUNT_CAP), capped: n > KEYWORD_COUNT_CAP }))
    .catch((e): KeywordCount => ({ unavailable: isTimeout(e) ? 'timeout' : 'error' }));
  try {
    return await Promise.race([count, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The hybrid path's count, started before the search so both run at once.
 * Types expand the way hybridSearch expands them; a filter that expands to
 * nothing matches nothing.
 */
export function startKeywordCount(engine: BrainEngine, query: string, types: string[] | undefined, opts: SearchOpts): Promise<KeywordCount> {
  return (async (): Promise<KeywordCount> => {
    const expanded = types ? (await expandEngineTypeFilters(engine, { types, ...opts })).types : undefined;
    if (expanded?.length === 0) return { total: 0, capped: false };
    return countKeywordMatches(engine, query, { ...opts, ...(expanded ? { types: expanded } : {}) });
  })().catch((): KeywordCount => ({ unavailable: 'error' }));
}

/** Adds count fields (and the unavailable stage) to a built retrieval meta. */
export function withCountMeta(meta: Record<string, unknown>, extra: { meta: Record<string, unknown>; degraded?: DegradedStageEntry }): Record<string, unknown> {
  if (!extra.degraded) return { ...meta, ...extra.meta };
  return { ...meta, ...extra.meta, degraded: [...((meta.degraded as unknown[] | undefined) ?? []), extra.degraded] };
}

/** Response meta for the hybrid path: `keyword_total` / `keyword_truncated`, or the unavailable stage. */
export function keywordCountMeta(count: KeywordCount, shownThrough: number): { meta: Record<string, unknown>; degraded?: DegradedStageEntry } {
  if ('unavailable' in count) {
    return { meta: { keyword_total: null }, degraded: { stage: 'keyword_count_unavailable', ...(count.unavailable === 'timeout' ? { reason: 'timeout' as const } : {}) } };
  }
  return { meta: { keyword_total: count.total, keyword_truncated: count.capped || count.total > shownThrough, ...(count.capped ? { keyword_total_capped: true } : {}) } };
}

export interface KeywordPage {
  rows: SearchResult[];
  meta: Record<string, unknown>;
  degraded?: DegradedStageEntry;
}

/**
 * One `match: "keyword"` page: limit + 1 rows probe `truncated` (so `next`
 * never depends on the count), the count runs beside them.
 */
export async function readKeywordPage(engine: BrainEngine, p: Record<string, unknown>, opts: SearchOpts, paging: SearchPaging, limit: number): Promise<KeywordPage> {
  const queryText = String(p.query);
  const [probe, count] = await Promise.all([
    engine.searchKeywordPages(queryText, opts, { limit: limit + 1, ...(paging.cursor ? { after: paging.cursor } : { offset: paging.offset }) }),
    countKeywordMatches(engine, queryText, opts),
  ]);
  const rows = probe.slice(0, limit);
  const start = paging.cursor ? paging.cursor.shown : paging.offset;
  const truncated = probe.length > limit;
  const last = rows[rows.length - 1];
  let next: Record<string, unknown> | undefined;
  if (truncated && last) {
    next = { query: queryText, match: 'keyword' };
    for (const key of CARRIED_PARAMS) if (p[key] !== undefined) next[key] = p[key];
    next.cursor = encodeCursor({ score: last.score, page_id: last.page_id }, start + rows.length, p);
  }
  const counted = 'unavailable' in count ? null : count;
  const degraded = counted ? undefined : keywordCountMeta(count, 0).degraded;
  return {
    rows,
    meta: {
      match: 'keyword',
      total: counted ? counted.total : null,
      ...(counted?.capped ? { total_capped: true } : {}),
      truncated,
      shown_from: start + 1,
      shown_to: start + rows.length,
      ...(next ? { next } : {}),
    },
    ...(degraded ? { degraded } : {}),
  };
}

/**
 * Enumeration is separate from evidence: every enumerated page keeps its row
 * in order. A page whose text did not fit the evidence budget (or could not
 * be read for it) comes back without text and with `evidence_omitted: true`.
 */
export function keepEnumeratedRows<T extends SearchResult>(enumerated: SearchResult[], delivered: T[]): Array<T | SearchResult> {
  const byPage = new Map(delivered.map(r => [r.page_id, r]));
  return enumerated.map(r => byPage.get(r.page_id) ?? { ...r, chunk_text: '', evidence_omitted: true });
}

const countWords = (n: number, capped: boolean | undefined) => `${capped ? `${n}+` : n} page${n === 1 && !capped ? '' : 's'}`;

/**
 * The model-visible line after the rows (null when the call carries no
 * count): which set the rows are, which set the count covers, and the next
 * call. Reads only `_meta.retrieval` keys this module writes.
 */
export function searchCountLine(rows: unknown, retrieval: unknown): string | null {
  if (retrieval === null || typeof retrieval !== 'object') return null;
  const r = retrieval as Record<string, unknown>;
  const stage = Array.isArray(r.degraded) ? r.degraded.find(d => (d as { stage?: unknown })?.stage === 'keyword_count_unavailable') : undefined;
  const reason = (stage as { reason?: unknown } | undefined)?.reason === 'timeout' ? 'timed out' : 'failed';
  if (r.match === 'keyword') {
    const total = typeof r.total === 'number'
      ? `Keyword matches: ${countWords(r.total, r.total_capped === true)}`
      : `Keyword match count unavailable (${reason}; not a count of zero)`;
    const omitted = Array.isArray(rows) ? rows.filter(x => (x as { evidence_omitted?: unknown })?.evidence_omitted === true).length : 0;
    const shown = Number(r.shown_to) < Number(r.shown_from) ? 'none on this page' : `showing ${r.shown_from}-${r.shown_to}, keyword-score order`;
    return `[gbrain search] ${total}; ${shown}.`
      + (omitted ? ` ${omitted} row(s) have evidence_omitted: true (text did not fit token_budget; read with get_page).` : '')
      + (r.next ? ` More: call search with next = ${JSON.stringify(r.next)}` : ' No more keyword matches.');
  }
  if (!('keyword_total' in r)) return null;
  const count = typeof r.keyword_total === 'number'
    ? `Keyword matches: ${countWords(r.keyword_total, r.keyword_total_capped === true)} (pages matching the query's keywords, not a count of these rows)`
    : `Keyword match count unavailable (${reason}; not a count of zero)`;
  return `[gbrain search] Rows are a ranked top-K, not proof of coverage. ${count}. List every keyword match with match: "keyword".`;
}
