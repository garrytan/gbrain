/**
 * v0.35.0.0+ — reranker call-site abstraction.
 *
 * Slots into hybridSearch after `dedupResults()` and before
 * `enforceTokenBudget()`. Takes the top `topNIn` candidates by current RRF
 * order, sends them to `gateway.rerank()`, and re-orders by the
 * cross-encoder's relevance score. The un-reranked long tail keeps its
 * original RRF order — preserves recall vs. truncating to topNIn.
 *
 * Fail-open posture: every error class (auth, network, timeout, rate-limit,
 * payload-too-large, unknown) logs to the rerank-audit JSONL and returns
 * the original RRF order unchanged. Search reliability beats reranker
 * quality; a flaky upstream must never break search.
 *
 * Caller (hybridSearch) decides whether the reranker fires via
 * `opts.reranker?.enabled`. Mode-bundle resolution defaults this to `true`
 * for tokenmax and `false` for conservative/balanced.
 */

import { createHash } from 'crypto';
import type { SearchResult } from '../types.ts';
import { rerank as gatewayRerank, RerankError, type RerankInput, type RerankResult } from '../ai/gateway.ts';
import { BudgetExhausted } from '../budget/budget-tracker.ts';
import { logRerankFailure, type RerankFailureReason } from '../rerank-audit.ts';
import { warnOncePerProcess } from '../utils.ts';

/** #4648: the two audited success-shaped pass-through causes. */
export type RerankPassThroughReason = 'empty_result_set' | 'malformed_shape';

export interface RerankerOpts {
  enabled: boolean;
  /** How many of the top results to send to the reranker (default 30). */
  topNIn: number;
  /** Truncate the reranked output to this many (null = no truncate). */
  topNOut: number | null;
  /** Provider:model override. When undefined, gateway uses configured default. */
  model?: string;
  /** Per-call timeout in ms (default 5000 — propagates to gateway.rerank). */
  timeoutMs?: number;
  /**
   * #4648: fired when the provider answered SUCCESSFULLY but with an
   * empty/malformed result set for a non-empty document batch, so the
   * results passed through in raw RRF order unscored. hybridSearch uses it
   * to stamp the response meta's degraded[] channel so callers can tell
   * "reranker off" from "reranker died silently". Best-effort: a throwing
   * callback never breaks search.
   */
  onPassThrough?: (reason: RerankPassThroughReason) => void;
  /**
   * Test seam — when set, applyReranker calls this instead of gateway.rerank.
   * Production must NEVER set this.
   */
  rerankerFn?: (input: RerankInput) => Promise<RerankResult[]>;
}

/** SHA-256 prefix (8 chars) of the query text for privacy-preserving audit. */
function hashQuery(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 8);
}

function classifyRerankFailure(err: unknown): RerankFailureReason {
  if (err instanceof RerankError) return err.reason;
  if (
    err instanceof BudgetExhausted ||
    (err && typeof err === 'object' && (err as { tag?: unknown }).tag === 'BUDGET_EXHAUSTED')
  ) {
    return 'budget';
  }
  return 'unknown';
}

/**
 * Reorder the top `topNIn` results by reranker relevance score. The
 * un-reranked tail (any rows past topNIn) preserves its original RRF
 * position — appended after the reordered head in the same order it had
 * coming in.
 *
 * On reranker failure, logs to ~/.gbrain/audit/rerank-failures-* and
 * returns the input array unmodified. Never throws.
 *
 * Empty input passes through immediately (no upstream call).
 */
export async function applyReranker(
  query: string,
  results: SearchResult[],
  opts: RerankerOpts,
): Promise<SearchResult[]> {
  if (!opts.enabled || results.length === 0) return results;
  // No documents to rerank when topNIn=0 — pass through (defensive; mode
  // bundles never set 0 in practice).
  if (opts.topNIn <= 0) return results;

  const head = results.slice(0, opts.topNIn);
  const tail = results.slice(opts.topNIn);

  // Document text — chunk_text is the matched span. Fall back to title if
  // empty (shouldn't happen in practice; defensive). Empty docs would
  // confuse the reranker, but we still send them — the upstream model decides.
  const documents = head.map(r => r.chunk_text || r.title || '');

  let reranked: RerankResult[];
  try {
    const rerankerFn = opts.rerankerFn ?? gatewayRerank;
    reranked = await rerankerFn({
      query,
      documents,
      timeoutMs: opts.timeoutMs,
      ...(opts.model ? { model: opts.model } : {}),
    });
  } catch (err) {
    const reason = classifyRerankFailure(err);
    // #3657 post-sunset short-circuit: the gateway already wrote the ONE
    // per-process-per-model audit row (and the once-per-process stderr line)
    // when it skipped the HTTP call — a per-query row here would flood the
    // audit file on every search until the user migrates. Fail open at once.
    if (reason === 'sunset_short_circuit') return results;
    const errorSummary = err instanceof Error ? err.message : String(err);
    try {
      logRerankFailure({
        model: opts.model ?? 'unknown',
        reason,
        query_hash: hashQuery(query),
        doc_count: documents.length,
        error_summary: errorSummary,
      });
    } catch {
      // Audit logging must never break search.
    }
    return results;
  }

  // Defensive: if the reranker returned a malformed shape, pass through —
  // but never silently (#4648). A provider that answers HTTP 200 with an
  // empty/malformed result set for a non-empty batch (verified live against
  // an OpenAI-shaped endpoint answering `{"results":[]}`) previously took
  // this branch with NO audit row while the throw path above was audited —
  // so an empty failure log falsely implied every search was reranked.
  // Same fail-open posture as the catch: audit + one stderr note per
  // process per reason, then return the input unchanged.
  if (!Array.isArray(reranked) || reranked.length === 0) {
    const reason: RerankPassThroughReason = Array.isArray(reranked)
      ? 'empty_result_set'
      : 'malformed_shape';
    try {
      logRerankFailure({
        model: opts.model ?? 'unknown',
        reason,
        query_hash: hashQuery(query),
        doc_count: documents.length,
        error_summary: reason === 'empty_result_set'
          ? `provider answered successfully with an empty result set for ${documents.length} document(s); results passed through unreranked`
          : 'provider answered successfully with a non-array result shape; results passed through unreranked',
      });
    } catch {
      // Audit logging must never break search.
    }
    warnOncePerProcess(
      `rerank-passthrough:${reason}`,
      `[gbrain] reranker returned ${reason === 'empty_result_set' ? 'an empty result set' : 'a malformed shape'} — ` +
        'results passed through in RRF order unscored (audited to rerank-failures; further occurrences this process are silent). ' +
        'Check the rerank endpoint and `gbrain doctor`.',
    );
    try {
      opts.onPassThrough?.(reason);
    } catch {
      // Meta stamping must never break search.
    }
    return results;
  }

  // Build the reordered head. We keep ONLY indices the reranker returned
  // (so a top_n response with fewer items than head.length naturally
  // drops the missing ones — but since we don't pass top_n by default,
  // every input gets a score).
  const seen = new Set<number>();
  const reorderedHead: SearchResult[] = [];
  for (const r of reranked) {
    if (r.index >= 0 && r.index < head.length && !seen.has(r.index)) {
      seen.add(r.index);
      const item = head[r.index]!;
      // Stamp the reranker score onto the result so downstream callers
      // (telemetry, debug, autocut) can see the new ordering signal. Doesn't
      // replace `score` — that's RRF and other consumers may depend on it.
      item.rerank_score = r.relevanceScore;
      // v0.40.4 attribution stamp (D12=A) — rank delta. Positive means
      // rank improved (moved closer to top). new_index is the next
      // push position in reorderedHead; original index was r.index.
      item.reranker_delta = r.index - reorderedHead.length;
      reorderedHead.push(item);
    }
  }
  // If the reranker dropped some head items (rare; usually only happens
  // with explicit top_n), preserve their original positions at the end
  // of the head section so we don't silently lose recall.
  for (let i = 0; i < head.length; i++) {
    if (!seen.has(i)) reorderedHead.push(head[i]!);
  }

  const combined = [...reorderedHead, ...tail];
  return opts.topNOut !== null && opts.topNOut > 0
    ? combined.slice(0, opts.topNOut)
    : combined;
}
