/**
 * v0.31.2 — facts:absorb writer.
 *
 * D5 contract from /plan-ceo-review: every absorbed failure in the facts
 * extraction pipeline writes one row to the existing ingest_log table.
 * Cross-process visible (doctor + admin dashboard read the same query),
 * scoped per source (codex P1 #3 — migration v50 added source_id), grouped
 * by stable reason codes so future tooling can categorize failures.
 *
 * Mirrors the eval_capture_failures precedent (CLAUDE.md cites this exact
 * shape for the eval_capture doctor check). No new infrastructure; one
 * helper + a stable reason-code constant set.
 *
 * Reasons:
 *   - 'gateway_error'   — HTTP 429/5xx, timeout, network blip on chat() or embed().
 *   - 'parse_failure'   — LLM returned malformed JSON, all 4 parser fallback strategies failed.
 *   - 'queue_overflow'  — getFactsQueue() cap hit; oldest entry dropped.
 *   - 'queue_shutdown'  — queue rejected the enqueue because shutdown is in progress.
 *   - 'embed_failure'   — gateway down on embedOne; row inserts with NULL embedding.
 *   - 'pipeline_error'  — anything else absorbed inside runFactsBackstop's catch.
 *   - eligibility_skip is intentionally NOT logged (high cardinality, low signal).
 *
 * The writer is best-effort — a failure to log SHOULDN'T blow up the
 * caller's actual work. Errors here are caught and stderr-warned; the
 * caller proceeds.
 */

import type { BrainEngine } from '../engine.ts';
import { GBrainError } from '../types.ts';

export const FACTS_ABSORB_REASONS = [
  'gateway_error',
  'parse_failure',
  'queue_overflow',
  'queue_shutdown',
  'embed_failure',
  'pipeline_error',
] as const;

// v0.39.3.0 WARN-4 + CV13 — module-scoped flag so the first-occurrence
// diagnostic log fires ONCE per process. Subsequent occurrences of the
// same 'No database connection' class are suppressed (keeps captures
// quiet) but the first one prints enough context to triage why the
// facts subsystem is calling logIngest on a disconnected engine.
// Exported as a test seam so the assertion can reset between runs.
let _hasLoggedDisconnectedFactsAbsorb = false;
/** @internal — test seam */
export function _resetFactsAbsorbDisconnectedFlagForTests(): void {
  _hasLoggedDisconnectedFactsAbsorb = false;
}

export type FactsAbsorbReason = typeof FACTS_ABSORB_REASONS[number];

/**
 * Write one row to ingest_log for a facts:absorb event. The row's shape:
 *
 *   source_type   = 'facts:absorb'
 *   source_id     = caller's brain source id (default 'default')
 *   source_ref    = page slug or session id the failure was tied to
 *   summary       = `<reason>: <terse detail truncated to 240 chars>`
 *   pages_updated = []
 *
 * Best-effort: any error here is caught and stderr-warned; the caller's
 * pipeline keeps running. The doctor's facts_extraction_health check
 * (PR1 commit 12) reads these rows and warns when any reason exceeds the
 * threshold over a 24h window.
 */
export async function writeFactsAbsorbLog(
  engine: BrainEngine,
  ref: string,
  reason: FactsAbsorbReason,
  detail: string,
  sourceId: string = 'default',
): Promise<void> {
  try {
    const cleanedDetail = (detail ?? '').toString().slice(0, 240);
    await engine.logIngest({
      source_id: sourceId,
      source_type: 'facts:absorb',
      source_ref: ref,
      pages_updated: [],
      summary: `${reason}: ${cleanedDetail}`,
    });
  } catch (e) {
    // v0.39.3.0 WARN-4 + CQ1 — typed access via instanceof + .problem field
    // (NOT string-match on e.message). The 'No database connection' class
    // fires after every `gbrain capture` invocation because the facts
    // subsystem opens its own engine handle that isn't connected in the
    // CLI capture path. Per-capture noise is suppressed; CV13 prints
    // ONE first-occurrence stack trace so the next user reporting it
    // gives us the call site to fix in v0.38.4.
    if (e instanceof GBrainError && e.problem === 'No database connection') {
      if (!_hasLoggedDisconnectedFactsAbsorb) {
        _hasLoggedDisconnectedFactsAbsorb = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[facts:absorb] suppressed: 'No database connection' fires on a separate engine handle ` +
          `(known WARN-4 in v0.38; subsequent occurrences silent this process). ` +
          `First-occurrence trace for v0.38.4 diagnosis:\n${e.stack ?? '<no stack>'}`,
        );
      }
      // Subsequent occurrences silent — the page write itself succeeded;
      // the facts:absorb log is a courtesy that the doctor health check
      // reads. A connection-bound log site already filed the v0.38.4 TODO
      // (see TODOS.md).
      return;
    }
    // All other failures keep the loud warn. Don't let logging failures
    // cascade — observability can't break the runtime path — but DO let
    // the operator see real subsystem errors (PgBouncer crash, schema
    // drift, etc.) instead of suppressing them globally.
    // eslint-disable-next-line no-console
    console.warn(
      `[facts:absorb] failed to log ${reason} for ${ref}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Classify an arbitrary error into one of the stable reason codes. Heuristic
 * pattern match on error name + message; falls back to 'pipeline_error' when
 * nothing matches. Public so callers can route the same way the helper does
 * (e.g. tests, future telemetry consumers).
 */
export function classifyFactsAbsorbError(err: unknown): FactsAbsorbReason {
  if (!err) return 'pipeline_error';
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';

  // Anthropic / OpenAI / Voyage all surface 4xx/5xx + timeouts in similar shapes.
  if (/timeout|timed?\s?out|ETIMEDOUT/i.test(msg)) return 'gateway_error';
  if (/429|rate[\s-]?limit|too many requests/i.test(msg)) return 'gateway_error';
  if (/5\d\d|server error|internal server|bad gateway|service unavail/i.test(msg)) return 'gateway_error';
  if (/ECONNRESET|ECONNREFUSED|EAI_AGAIN|getaddrinfo/i.test(msg)) return 'gateway_error';

  // Parser failures from extract.ts's 4-strategy fallback.
  if (/JSON.parse|unexpected token|invalid json|not valid JSON/i.test(msg)) return 'parse_failure';

  // Queue counter increments — currently bubble through specific paths but
  // could surface here if a caller routes them.
  if (name === 'QueueOverflowError' || /queue.*overflow|cap.*hit/i.test(msg)) return 'queue_overflow';
  if (name === 'QueueShutdownError' || /queue.*shutdown|shutting down/i.test(msg)) return 'queue_shutdown';

  // Embed-specific: extract.ts catches embedOne errors and stores NULL embedding.
  // If a caller surfaces it explicitly, route to embed_failure.
  if (/embed/i.test(msg) && /(fail|error)/i.test(msg)) return 'embed_failure';

  return 'pipeline_error';
}
