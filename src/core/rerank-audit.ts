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
 * 2026-05-16 refactored to use the shared `createAuditLogger` primitive
 * from `audit-jsonl.ts`. Per-domain transform handles `error_summary`
 * truncation (200 chars max) + severity stamping.
 */

import { createAuditLogger, computeIsoWeekFilename } from './audit-jsonl.ts';

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

const MAX_ERROR_SUMMARY = 200;

const logger = createAuditLogger<RerankFailureEvent>({
  prefix: 'rerank-failures',
  stderrTag: '[gbrain]',
  continueMessage: 'search continues',
  transform: (event) => {
    // Truncate error_summary; stamp severity.
    const summary = event.error_summary;
    const truncated = summary.length <= MAX_ERROR_SUMMARY
      ? summary
      : summary.slice(0, MAX_ERROR_SUMMARY - 1) + '…';
    return {
      ...event,
      error_summary: truncated,
      severity: 'warn',
    };
  },
});

/** ISO-week-rotated filename: `rerank-failures-YYYY-Www.jsonl`. */
export function computeRerankAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('rerank-failures', now);
}

/**
 * Append a rerank-failure event. Best-effort: write failure logs to stderr
 * but never throws. Callers don't need to set `ts` or `severity` — the
 * factory stamps `ts` and the transform stamps `severity`.
 */
export function logRerankFailure(event: Omit<RerankFailureEvent, 'ts' | 'severity'>): void {
  // The factory's transform expects the full pre-`ts` shape (including
  // severity). Stamp it here so the type system is honest about the
  // intermediate shape.
  logger.log({ ...event, severity: 'warn' });
}

/**
 * Read recent (`days` window, default 7) rerank-failure events. Used by
 * `gbrain doctor`'s `reranker_health` check. Missing file / corrupt rows
 * are skipped silently — the audit trail is informational.
 */
export function readRecentRerankFailures(days = 7, now: Date = new Date()): RerankFailureEvent[] {
  return logger.readRecent(days, now);
}
