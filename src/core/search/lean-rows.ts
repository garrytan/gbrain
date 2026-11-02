/**
 * Lean `search`/`query` rows for remote callers.
 *
 * A full row averages about 1.2k characters, of which the evidence text is
 * 200-460; the rest is ranking diagnostics (page_id, chunk_index,
 * chunk_source, keyword_hit, cosine, base_score, boosts, rerank and graph
 * signals) that agents do not read but pay for on every later turn. A lean
 * row keeps what an agent acts on:
 *   - identity and text: slug, title, type, chunk_text, score (rounded to 4
 *     significant digits), effective_date (with effective_date_source, which
 *     says what kind of date it is), source_id, chunk_id (assemble_evidence
 *     takes {source_id, slug, chunk_id}); id (the deep-research fetch key,
 *     base64 of source_id and slug) only when `fetch` is callable on the
 *     caller's surface at call time (`ctx.isCallable`, unset = kept);
 *   - the duplicate-page guard: evidence and create_safety;
 *   - safety and provenance markers whenever present: injection_suspected,
 *     injection_p, unverified, content_flag, status, superseded, superseded_by,
 *     message_id, thread_id, source_subject, matched_alias (the other name the
 *     alias fan-out searched); trust_tier and origin (#5575); quoted (a
 *     fenced conversation excerpt, search/transcript-quote.ts); `provenance`
 *     only as `generated` (a machine-written page); modality when not text; stale
 *     only when set (true, or the held-file object from #5988);
 *   - `delivered: { truncated: true }` whenever evidence delivery truncated;
 *     on a long page `search.long_page_unit` considered, `delivered: { unit,
 *     reason }` (plus `truncated: true` when cut): `reason` is `long_page`
 *     when the page came back in that unit, `long_page_chunk` when it kept
 *     its ranked chunk;
 *   - `evidence_omitted` on a keyword-mode row whose text did not fit.
 * `fields: "full"`, the `mcp.result_rows: full` host config and gbrain's own
 * thin client get every field; trusted local callers always do.
 */

import type { OperationContext } from '../ops/contract.ts';

export type ResultRows = 'lean' | 'full';

const KEPT_FIELDS: ReadonlySet<string> = new Set([
  'slug', 'title', 'type', 'chunk_text', 'effective_date', 'effective_date_source', 'source_id', 'chunk_id',
  'evidence', 'create_safety',
  'injection_suspected', 'injection_p', 'unverified', 'content_flag', 'status', 'superseded', 'superseded_by',
  'message_id', 'thread_id', 'source_subject', 'relational', 'matched_alias', 'result_type', 'fact_id', 'page_slug', 'follow_up',
  // `match: "keyword"`: an enumerated page whose text did not fit the evidence budget.
  'evidence_omitted',
  // #5575 A6: every row says how much it deserves influence.
  'trust_tier', 'origin', 'unconfirmed',
  // #7600: a conversation page's row is a quoted excerpt.
  'quoted',
  // Result-time collapse and rank priors: folded pages, an unfollowed redirect, an image page's text row.
  'collapsed', 'redirect_to', 'image_page',
  // Present only when the caller asked for `explain: true`.
  'score_details',
]);

/** Explicit `fields` wins; then trusted local callers get full rows; then the transport's choice (default lean). */
export function resultRowsFor(ctx: Pick<OperationContext, 'remote' | 'resultRows'>, fields: unknown): ResultRows {
  if (fields === 'lean' || fields === 'full') return fields;
  if (ctx.remote === false) return 'full';
  return ctx.resultRows ?? 'lean';
}

/** Lean rows carry `id` only for a caller that can pass it to `fetch`; a caller without the predicate keeps it. */
export function leanRowsKeepId(ctx: Pick<OperationContext, 'isCallable'>): boolean {
  return ctx.isCallable?.('fetch') ?? true;
}

/** 4 significant digits: RRF-scale scores are small, so fixed decimals would collapse them. */
export function leanScore(score: unknown): unknown {
  return typeof score === 'number' && Number.isFinite(score) ? Number(score.toPrecision(4)) : score;
}

export function leanRow(row: Record<string, unknown>, opts: { keepId?: boolean } = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined || (value === null && key !== 'effective_date')) continue;
    if (key === 'id') { if (opts.keepId !== false) out[key] = value; }
    else if (key === 'score') out[key] = leanScore(value);
    else if (KEPT_FIELDS.has(key)) out[key] = value;
    else if (key === 'stale' && (value === true || (typeof value === 'object' && value !== null))) out[key] = value;
    else if (key === 'modality' && value !== 'text') out[key] = value;
    else if (key === 'provenance' && value === 'generated') out[key] = value;
    else if (key === 'delivered') {
      const d = value as { unit?: unknown; reason?: unknown; truncated?: unknown };
      const truncated = d.truncated === true ? { truncated: true } : {};
      if (d.reason === 'long_page' || d.reason === 'long_page_chunk') out[key] = { unit: d.unit, reason: d.reason, ...truncated };
      else if (d.truncated === true) out[key] = truncated;
    }
  }
  return out;
}

export function projectRows<T>(rows: T[], shape: ResultRows, opts: { keepId?: boolean } = {}): T[] {
  return shape === 'full' ? rows : rows.map(r => leanRow(r as Record<string, unknown>, opts) as T);
}
