/**
 * v0.35.5 — phantom-redirect audit trail.
 *
 * Writes one JSONL row per phantom-redirect decision to
 * `~/.gbrain/audit/phantoms-YYYY-Www.jsonl` (ISO-week rotation, mirrors
 * `audit-slug-fallback.ts`). Records BOTH success ('redirected') and
 * informational skip outcomes ('ambiguous', 'drift', 'no_canonical',
 * 'not_phantom_has_residue', 'pass_skipped_lock_busy') so operators can
 * triage what the autopilot cycle saw without re-running it.
 *
 * Sister surface of `src/core/facts/stub-guard-audit.ts` (different
 * consumer — stub-guard logs PREVENTIVE writes that never made it to
 * disk; phantom-audit logs CLEANUP outcomes for pages already on disk).
 * Keeping them separate means each file has a stable schema and the
 * doctor checks don't need to grow a discriminator.
 *
 * Best-effort writes. Failures emit a stderr line but never throw — a
 * disk-full or audit-dir-permission issue must not stall the cycle.
 *
 * v0.40.4.0: internals delegate to the shared
 * `src/core/audit/audit-writer.ts` primitive. Public API preserved
 * (logPhantomEvent, readRecentPhantomEvents, computePhantomAuditFilename).
 * The 6-outcome PhantomOutcome union is unchanged; the schema is what every
 * future doctor check binds to.
 */

import { createAuditWriter, computeIsoWeekFilename } from '../audit/audit-writer.ts';

export type PhantomOutcome =
  | 'redirected'
  | 'ambiguous'
  | 'drift'
  | 'no_canonical'
  | 'not_phantom_has_residue'
  | 'pass_skipped_lock_busy';

export interface PhantomAuditEvent {
  ts: string;
  phantom_slug?: string;
  canonical_slug?: string;
  outcome: PhantomOutcome;
  fact_count?: number;
  source_id: string;
  reason?: string;
  candidates?: Array<{ slug: string; connection_count: number }>;
}

/** ISO-week-rotated filename: `phantoms-YYYY-Www.jsonl`. */
export function computePhantomAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('phantoms', now);
}

const writer = createAuditWriter<PhantomAuditEvent>({
  featureName: 'phantoms',
  errorLabel: 'gbrain',
  errorMessagePrefix: 'phantom audit ',
  errorTrailer: '; cycle continues',
});

/**
 * Append a phantom-redirect event to the current week's audit JSONL.
 *
 * `ts` is stamped at call time (caller-provided overrides honored). Write
 * failure is logged to stderr; the caller's cycle continues either way.
 */
export function logPhantomEvent(event: Omit<PhantomAuditEvent, 'ts'> & { ts?: string }): void {
  // Strip optional undefined fields to preserve the pre-v0.40.4 wire shape
  // (the old impl used a spread-with-conditional to omit absent fields,
  // not surface them as `field: undefined`). JSON.stringify already drops
  // explicit undefined, so this matters only for in-memory shape — which
  // doctor + tests do depend on. Pass through verbatim; downstream
  // JSON.stringify handles the undefined-strip.
  const cleaned: Omit<PhantomAuditEvent, 'ts'> & { ts?: string } = {
    outcome: event.outcome,
    source_id: event.source_id,
    ...(event.phantom_slug !== undefined ? { phantom_slug: event.phantom_slug } : {}),
    ...(event.canonical_slug !== undefined ? { canonical_slug: event.canonical_slug } : {}),
    ...(event.fact_count !== undefined ? { fact_count: event.fact_count } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.candidates !== undefined ? { candidates: event.candidates } : {}),
    ...(event.ts !== undefined ? { ts: event.ts } : {}),
  };
  writer.log(cleaned);
}

/**
 * Read recent phantom-redirect events from the current + previous ISO
 * weeks. Used by future `gbrain doctor` `phantoms_pending` check (T9
 * follow-up) and by tests asserting the audit-write contract.
 *
 * Missing files / corrupt rows are skipped silently — the audit trail is
 * informational and shouldn't block any consumer.
 */
export function readRecentPhantomEvents(days = 7, now: Date = new Date()): PhantomAuditEvent[] {
  return writer.readRecent(days, now);
}
