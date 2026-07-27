/**
 * v0.35.0.0+ — rerank-failure audit trail.
 *
 * Writes warn-severity rows to `~/.gbrain/audit/rerank-failures-YYYY-Www.jsonl`
 * (ISO-week rotation, mirrors slug-fallback-audit.ts). Fired when
 * `applyReranker` in src/core/search/rerank.ts catches a RerankError from
 * the gateway. Failure is fail-open at the search layer (results pass
 * through in RRF order); the audit row is the cross-process signal that
 * `gbrain doctor reranker_health` reads.
 *
 * Success events are intentionally NOT logged here. Per the plan (CDX2-F22):
 *   1) writing once per tokenmax search is hot-path I/O churn — the
 *      slug-fallback pattern is rare-event-only.
 *   2) success events leak query volume + timing into a local audit file
 *      that previously held only failures.
 * The doctor check reads `search.reranker.enabled` first to interpret
 * "no events in window" correctly (enabled + no events = healthy;
 * disabled = no failures expected).
 *
 * Best-effort writes. Write failures go to stderr but search continues.
 *
 * v0.40.4.0: internals delegate to the shared `src/core/audit/audit-writer.ts`
 * primitive. Public API (logRerankFailure, readRecentRerankFailures,
 * computeRerankAuditFilename) preserved bit-for-bit for the existing test
 * suite at `test/rerank-audit.test.ts`.
 */

import { createAuditWriter, computeIsoWeekFilename } from './audit/audit-writer.ts';

/** Stable error-classification union; matches RerankError.reason. */
export type RerankFailureReason =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'payload_too_large'
  | 'unknown';

export interface RerankFailureEvent {
  ts: string;
  /** Provider:model — e.g. `'zeroentropyai:zerank-2'`. */
  model: string;
  /** Classified failure mode (see RerankFailureReason). */
  reason: RerankFailureReason;
  /** SHA-256 prefix of the rerank query (8 hex chars). Privacy: never log
   *  query text. Lets doctor dedupe repeat failures on the same query. */
  query_hash: string;
  /** Number of documents that were being reranked when failure fired. */
  doc_count: number;
  /**
   * Truncated upstream error message (first 200 chars). Useful for
   * diagnosing flaky providers without leaking PII; query text is hashed
   * separately so this string never carries it.
   */
  error_summary: string;
  /** Always 'warn' — matches RerankError's "all failures degrade UX". */
  severity: 'warn';
}

/** ISO-week-rotated filename: `rerank-failures-YYYY-Www.jsonl`. */
export function computeRerankAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('rerank-failures', now);
}

/**
 * Truncate a string for audit logging. Plain length cut — error messages
 * from the gateway are already free of caller-controlled prefixes.
 */
function truncateErrorSummary(msg: string, max = 200): string {
  if (msg.length <= max) return msg;
  return msg.slice(0, max - 1) + '…';
}

const writer = createAuditWriter<RerankFailureEvent>({
  featureName: 'rerank-failures',
  errorLabel: 'gbrain',
  errorMessagePrefix: 'rerank-failure audit ',
  errorTrailer: '; search continues',
});

/**
 * Append a rerank-failure event. Best-effort: write failure logs to stderr
 * but never throws.
 */
export function logRerankFailure(event: Omit<RerankFailureEvent, 'ts' | 'severity'>): void {
  writer.log({
    severity: 'warn',
    ...event,
    error_summary: truncateErrorSummary(event.error_summary),
  } as Omit<RerankFailureEvent, 'ts'>);
}

/**
 * Read recent (`days` window, default 7) rerank-failure events. Used by
 * `gbrain doctor`'s `reranker_health` check. Missing file / corrupt rows
 * are skipped silently — the audit trail is informational.
 */
export function readRecentRerankFailures(days = 7, now: Date = new Date()): RerankFailureEvent[] {
  return writer.readRecent(days, now);
}

// stderr label "gbrain" + qualifier "rerank-failure audit " preserve the
// pre-v0.40.4 message byte-for-byte:
//
//   `[gbrain] rerank-failure audit write failed (${msg}); search continues`
//
// The `errorMessagePrefix` option on createAuditWriter restores the
// qualifier that would otherwise be dropped by the refactor. Operators
// grepping logs for "rerank-failure audit write failed" keep working.
