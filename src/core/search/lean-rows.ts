/**
 * Lean `search`/`query` rows for remote callers.
 *
 * A full row averages about 1.2k characters, of which the evidence text is
 * 200-460; the rest is ranking diagnostics (page_id, chunk_index,
 * chunk_source, keyword_hit, cosine, base_score, boosts, rerank and graph
 * signals) that agents do not read but pay for on every later turn. A lean
 * row keeps what an agent acts on:
 *   - identity and text: id (the deep-research fetch key), slug, title, type,
 *     chunk_text, score, effective_date, source_id, chunk_id (assemble_evidence
 *     takes {source_id, slug, chunk_id});
 *   - the duplicate-page guard: evidence and create_safety;
 *   - safety and provenance markers whenever present: injection_suspected,
 *     injection_p, unverified, content_flag, status, superseded, superseded_by,
 *     message_id, thread_id, source_subject; trust_tier and origin (#5575);
 *     modality when not text; stale
 *     only when set (true, or the held-file object from #5988);
 *   - `delivered: { truncated: true }` whenever evidence delivery truncated.
 * `fields: "full"`, the `mcp.result_rows: full` host config and gbrain's own
 * thin client get every field; trusted local callers always do.
 */

import type { OperationContext } from '../ops/contract.ts';

export type ResultRows = 'lean' | 'full';

const KEPT_FIELDS: ReadonlySet<string> = new Set([
  'id', 'slug', 'title', 'type', 'chunk_text', 'score', 'effective_date', 'source_id', 'chunk_id',
  'evidence', 'create_safety',
  'injection_suspected', 'injection_p', 'unverified', 'content_flag', 'status', 'superseded', 'superseded_by',
  'message_id', 'thread_id', 'source_subject', 'relational',
  // #5575 A6: every row says how much it deserves influence.
  'trust_tier', 'origin', 'unconfirmed',
  // Present only when the caller asked for `explain: true`.
  'score_details',
]);

/** Explicit `fields` wins; then trusted local callers get full rows; then the transport's choice (default lean). */
export function resultRowsFor(ctx: Pick<OperationContext, 'remote' | 'resultRows'>, fields: unknown): ResultRows {
  if (fields === 'lean' || fields === 'full') return fields;
  if (ctx.remote === false) return 'full';
  return ctx.resultRows ?? 'lean';
}

export function leanRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined || (value === null && key !== 'effective_date')) continue;
    if (KEPT_FIELDS.has(key)) out[key] = value;
    else if (key === 'stale' && (value === true || (typeof value === 'object' && value !== null))) out[key] = value;
    else if (key === 'modality' && value !== 'text') out[key] = value;
    else if (key === 'delivered' && (value as { truncated?: unknown }).truncated === true) out[key] = { truncated: true };
  }
  return out;
}

export function projectRows<T>(rows: T[], shape: ResultRows): T[] {
  return shape === 'full' ? rows : rows.map(r => leanRow(r as Record<string, unknown>) as T);
}
