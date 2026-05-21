/**
 * Backpressure audit log — operational trace for `maxWaiting` coalesce events.
 *
 * Mirrors the shell-audit.ts pattern (ISO-week-rotated JSONL, best-effort writes,
 * failures go to stderr but never block submission). The incident that motivated
 * maxWaiting (autopilot pile-up during a 90+ min queue wedge) was invisible
 * precisely because the coalesce silently dropped repeat submissions. This
 * trail answers "why is queue depth steady at 2 for this name?" without any
 * doctor scan.
 *
 * File: `~/.gbrain/audit/backpressure-YYYY-Www.jsonl` (override dir via
 * `GBRAIN_AUDIT_DIR` for container/sandbox deployments where `$HOME` is read-only).
 *
 * `gbrain jobs stats` will surface coalesce counts from this file in a v0.19.2+
 * follow-up (B4). The audit trail is for operators debugging live queues, not
 * for compliance — a disk-full attacker can silently disable it.
 *
 * 2026-05-16 refactored to use the shared `createAuditLogger` primitive from
 * `~/Projects/gbrain/src/core/audit-jsonl.ts`. The previous `computeAuditFilename`
 * export name collided with `shell-audit.ts`; renamed to
 * `computeBackpressureAuditFilename` for unambiguous imports. Inline
 * `resolveAuditDir` removed — same primitive now lives in the core layer.
 */

import { createAuditLogger, computeIsoWeekFilename } from '../audit-jsonl.ts';

export interface BackpressureAuditEvent {
  ts: string;
  queue: string;
  name: string;
  waiting_count: number;
  max_waiting: number;
  decision: 'coalesced';
  returned_job_id: number;
}

const logger = createAuditLogger<BackpressureAuditEvent>({
  prefix: 'backpressure',
  stderrTag: '[backpressure-audit]',
  continueMessage: 'submission continues',
});

/**
 * Compute `backpressure-YYYY-Www.jsonl` using ISO-8601 week numbering.
 *
 * Renamed from `computeAuditFilename` (2026-05-16 — was a name collision with
 * `shell-audit.ts:computeAuditFilename`). The old name is NOT re-exported;
 * callers that import this filename function must use the renamed export.
 */
export function computeBackpressureAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('backpressure', now);
}

export function logBackpressureCoalesce(event: Omit<BackpressureAuditEvent, 'ts' | 'decision'>): void {
  logger.log({ ...event, decision: 'coalesced' as const });
}
