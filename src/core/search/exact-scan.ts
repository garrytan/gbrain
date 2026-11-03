/**
 * #7191 ask 2: `search_exact` (CLI `gbrain search --exact "<phrase>"`), the
 * exhaustive literal scan agents otherwise run with grep. Unranked: every page
 * with a visible text chunk containing the phrase, in page-id order, plus a
 * `complete` flag that is true only when every page in the caller's scope was
 * scanned and none of them had text the scan could not read.
 *
 * Match: the phrase's words in order with any run of whitespace between them
 * (a line break included), case-insensitive unless `caseSensitive`. Nothing
 * else is normalized: no stemming, punctuation and accents are literal.
 *
 * What it reads: `content_chunks.chunk_text` (an image page's chunk holds its OCR text) under the same
 * visibility predicate as ranked search (live page, unarchived source, not
 * quarantined, current text projection, live body generation, the caller's
 * source scope, private pages and the trust floor for an untrusted caller, safe
 * chunks for a remote caller), so a remote caller never matches fence text.
 * Chunks overlap by a sentence-aware margin, so a phrase inside one sentence is
 * always inside one chunk.
 *
 * What makes it incomplete: the deadline or the page limit (both resumable
 * from `resume_after`), and pages in scope whose text the scan cannot read:
 * a page with body text and no visible chunk (`unchunked`, e.g. a page
 * held from chunking), a page whose text projection is behind its revision
 * (`projection_pending`), and for a remote caller a page indexed before the
 * safe-chunk fence (`unsealed`). Those are listed, never silently skipped.
 *
 * Scan shape: keyset batches of pages by id, each one statement, run with JIT
 * off (the private-visibility subplans cost past `jit_above_cost`, and JIT
 * compilation alone took about 1 s per batch on Postgres 16). A statement
 * that times out is retried with half the batch; a single page that still
 * times out is recorded as `scan_timeout` and passed.
 */
import type { BrainEngine } from '../engine.ts';
import type { TrustTier } from '../trust/tier.ts';
import { quarantineFilterFragment } from '../quarantine.ts';
import { privatePagesFilterForCaller } from './private-visibility.ts';
import { pageEligibleSql } from '../eligibility/sql.ts';
import { buildHardExcludeClause } from './sql-ranking.ts';
import { escapeLikePattern } from './sql-ranking.ts';
import { isStatementTimeoutError } from '../retry-matcher.ts';
import { chunkVisibleFilter, currentTextProjectionFilter, safeChunksFilter, SAFE_FENCE_CHUNKER_VERSION } from './safe-chunks.ts';

export const EXACT_DEFAULT_LIMIT = 100;
export const EXACT_MAX_LIMIT = 1000;
export const EXACT_DEFAULT_SECONDS = 30;
export const EXACT_MAX_SECONDS = 120;
export const EXACT_MAX_PHRASE_CHARS = 500;
export const EXACT_SNIPPETS_PER_PAGE = 3;
const SNIPPET_CONTEXT = 80;
const BATCH_PAGES = 2000;
const GAP_SAMPLE = 20;

export type ExactGapReason = 'unchunked' | 'projection_pending' | 'unsealed' | 'scan_timeout';

export interface ExactScanOpts {
  phrase: string;
  caseSensitive?: boolean;
  sourceId?: string;
  sourceIds?: string[];
  types?: string[];
  slugPrefix?: string;
  excludeSlugPrefixes: string[];
  excludePrivate: boolean;
  remote: boolean;
  minTrust?: TrustTier;
  limit: number;
  afterPageId?: number;
  deadlineMs: number;
  /** Test seam: pages per statement. */
  batchPages?: number;
}

export interface ExactMatch {
  page_id: number;
  slug: string;
  source_id: string;
  title: string;
  type: string;
  matching_chunks: number;
  snippets: Array<{ chunk_index: number; chunk_source: string; text: string }>;
}

export interface ExactScanResult {
  matches: ExactMatch[];
  complete: boolean;
  incomplete_reasons: Array<'deadline' | 'limit' | 'unreadable_pages'>;
  resume_after: number | null;
  pages_scanned: number;
  unreadable: { total: number; by_reason: Partial<Record<ExactGapReason, number>>; sample: Array<{ slug: string; source_id: string; reason: ExactGapReason }> };
}

/** The phrase as a POSIX ARE: each word escaped literally, words joined by one or more whitespace characters. */
export function phrasePattern(phrase: string): { regex: string; longest: string } | null {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const regex = words.map(w => w.replace(/[\\^$.|?*+()[\]{}]/g, ch => '\\' + ch)).join('[[:space:]]+');
  const longest = words.reduce((a, b) => (b.length > a.length ? b : a));
  return { regex, longest };
}

interface BatchRow {
  page_id: number;
  slug: string | null;
  source_id: string | null;
  title: string | null;
  type: string | null;
  gap: ExactGapReason | null;
  matching_chunks: number | null;
  snippets: unknown;
}

/** One batch statement: every page of the next `batchPages` in scope after `after`, in id order, with its matches or the reason its text could not be read. */
export function buildExactBatchStatement(opts: ExactScanOpts, after: number, batchPages: number): { sql: string; params: unknown[] } | null {
  const pattern = phrasePattern(opts.phrase);
  if (!pattern) return null;
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return '$' + params.length; };
  const afterP = add(after);
  const limitP = add(batchPages);
  const flags = opts.caseSensitive ? "''" : "'i'";
  const re = add(pattern.regex);
  const snippetRe = add('.{0,' + SNIPPET_CONTEXT + '}' + pattern.regex + '.{0,' + SNIPPET_CONTEXT + '}');
  const like = add('%' + escapeLikePattern(pattern.longest) + '%');
  const op = opts.caseSensitive ? '~' : '~*';
  const likeOp = opts.caseSensitive ? 'LIKE' : 'ILIKE';
  const pageFilters: string[] = [
    'p.id > ' + afterP + '::int',
    'p.deleted_at IS NULL',
    'NOT s.archived',
    quarantineFilterFragment('p'),
    "NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'pinned_question')",
  ];
  if (opts.sourceIds?.length) pageFilters.push('p.source_id = ANY(' + add(opts.sourceIds) + '::text[])');
  else if (opts.sourceId) pageFilters.push('p.source_id = ' + add(opts.sourceId));
  if (opts.types?.length) pageFilters.push('p.type = ANY(' + add(opts.types) + '::text[])');
  if (opts.slugPrefix) pageFilters.push('p.slug LIKE ' + add(escapeLikePattern(opts.slugPrefix) + '%') + " ESCAPE '\\'");
  if (opts.excludePrivate) pageFilters.push(privatePagesFilterForCaller('p'));
  if (opts.minTrust) pageFilters.push(pageEligibleSql('p', { floor: opts.minTrust }));
  const hardExclude = buildHardExcludeClause('p.slug', opts.excludeSlugPrefixes);
  const safe = opts.remote ? ` AND ${safeChunksFilter('p')}` : '';
  const unsealed = opts.remote ? `WHEN p.chunker_version < ${SAFE_FENCE_CHUNKER_VERSION} THEN 'unsealed'` : '';
  // Sizes only (octet_length reads the stored length, never the body): does the page have text to index?
  const hasBody = `(octet_length(p.compiled_truth) > 0 OR octet_length(p.timeline) > 0 OR (p.body_storage = 'segmented' AND p.body_bytes > 0))`;
  const sql = `WITH batch AS MATERIALIZED (
  SELECT p.id FROM pages p JOIN sources s ON s.id = p.source_id
   WHERE ${pageFilters.join('\n     AND ')} ${hardExclude}
   ORDER BY p.id LIMIT ${limitP}::int
), hits AS (
  SELECT cc.page_id, cc.chunk_index, cc.chunk_source,
         (regexp_match(cc.chunk_text, ${snippetRe}, ${flags}))[1] AS snippet,
         row_number() OVER (PARTITION BY cc.page_id ORDER BY cc.chunk_index) AS rn
    FROM batch b JOIN pages p ON p.id = b.id JOIN content_chunks cc ON cc.page_id = b.id
   WHERE ${chunkVisibleFilter('p', 'cc')}${safe}
     AND cc.chunk_text ${likeOp} ${like} ESCAPE '\\' AND cc.chunk_text ${op} ${re}
), per_page AS (
  SELECT h.page_id, count(*)::int AS matching_chunks,
         json_agg(json_build_object('chunk_index', h.chunk_index, 'chunk_source', h.chunk_source, 'text', h.snippet) ORDER BY h.chunk_index)
           FILTER (WHERE h.rn <= ${EXACT_SNIPPETS_PER_PAGE}) AS snippets
    FROM hits h GROUP BY h.page_id
)
SELECT p.id AS page_id, p.slug, p.source_id, p.title, p.type, pp.matching_chunks, pp.snippets,
       CASE WHEN pp.page_id IS NOT NULL THEN NULL ${unsealed}
            WHEN NOT ${currentTextProjectionFilter('p')} THEN 'projection_pending'
            WHEN NOT EXISTS (SELECT 1 FROM content_chunks vc WHERE vc.page_id = p.id AND ${chunkVisibleFilter('p', 'vc')}) AND ${hasBody} THEN 'unchunked'
            ELSE NULL END AS gap
  FROM batch b JOIN pages p ON p.id = b.id LEFT JOIN per_page pp ON pp.page_id = b.id
 ORDER BY p.id`;
  return { sql, params };
}

/** Runs the scan from `afterPageId` until the scope ends, the limit fills or the deadline passes. */
export async function runExactScan(engine: Pick<BrainEngine, 'executeRaw'>, opts: ExactScanOpts): Promise<ExactScanResult> {
  const matches: ExactMatch[] = [];
  const gaps: Array<{ page_id: number; slug: string; source_id: string; reason: ExactGapReason }> = [];
  let after = opts.afterPageId ?? 0;
  let pagesScanned = 0;
  let batch = opts.batchPages ?? BATCH_PAGES;
  let reason: 'deadline' | 'limit' | null = null;
  let done = false;
  while (!done) {
    const remaining = opts.deadlineMs - Date.now();
    if (remaining <= 0) { reason = 'deadline'; break; }
    const stmt = buildExactBatchStatement(opts, after, batch);
    if (!stmt) { done = true; break; }
    let rows: BatchRow[];
    try {
      rows = await engine.executeRaw<BatchRow>(stmt.sql, stmt.params, { timeoutMs: Math.max(1000, remaining), jitOff: true });
    } catch (e) {
      if (!isStatementTimeoutError(e)) throw e;
      if (Date.now() >= opts.deadlineMs) { reason = 'deadline'; break; }
      if (batch > 1) { batch = Math.max(1, Math.floor(batch / 2)); continue; }
      const [next] = await engine.executeRaw<{ id: number; slug: string; source_id: string }>(
        'SELECT id, slug, source_id FROM pages WHERE id > $1::int AND deleted_at IS NULL ORDER BY id LIMIT 1', [after]);
      if (!next) { done = true; break; }
      gaps.push({ page_id: Number(next.id), slug: next.slug, source_id: next.source_id, reason: 'scan_timeout' });
      after = Number(next.id);
      pagesScanned++;
      continue;
    }
    if (rows.length === 0) { done = true; break; }
    for (const row of rows) {
      const id = Number(row.page_id);
      if (row.matching_chunks) {
        if (matches.length >= opts.limit) { reason = 'limit'; break; }
        const snippets = (typeof row.snippets === 'string' ? JSON.parse(row.snippets) : row.snippets) as ExactMatch['snippets'] | null;
        matches.push({ page_id: id, slug: row.slug!, source_id: row.source_id!, title: row.title ?? row.slug!, type: row.type ?? '',
          matching_chunks: Number(row.matching_chunks), snippets: (snippets ?? []).map(s => ({ chunk_index: Number(s.chunk_index), chunk_source: s.chunk_source, text: s.text })) });
      } else if (row.gap) {
        gaps.push({ page_id: id, slug: row.slug!, source_id: row.source_id!, reason: row.gap });
      }
      after = id;
      pagesScanned++;
    }
    if (reason === 'limit') break;
    if (rows.length < batch) done = true;
  }
  const counted = gaps;
  const byReason: Partial<Record<ExactGapReason, number>> = {};
  for (const g of counted) byReason[g.reason] = (byReason[g.reason] ?? 0) + 1;
  const reasons: ExactScanResult['incomplete_reasons'] = [];
  if (reason) reasons.push(reason);
  if (counted.length) reasons.push('unreadable_pages');
  return {
    matches,
    complete: reasons.length === 0,
    incomplete_reasons: reasons,
    resume_after: reason ? after : null,
    pages_scanned: pagesScanned,
    unreadable: { total: counted.length, by_reason: byReason, sample: counted.slice(0, GAP_SAMPLE).map(({ slug, source_id, reason: r }) => ({ slug, source_id, reason: r })) },
  };
}
