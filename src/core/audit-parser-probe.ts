/**
 * Nightly conversation-parser probe audit trail.
 *
 * One event per REAL probe run lands in
 * `~/.gbrain/audit/parser-probe-YYYY-Www.jsonl` (ISO-week rotation via the
 * shared audit-writer primitive; honors `GBRAIN_AUDIT_DIR`).
 * Scheduler-cadence skips (`rate_limited`) are NOT logged — the autopilot
 * loop ticks every few minutes, so logging every skip would flood the
 * audit file with rows that carry no signal.
 *
 * Read by `gbrain doctor`'s `conversation_parser_probe_health` check and
 * by the autopilot wiring's 24h rate-limit gate (`parserProbeRanWithin`).
 */

import { createAuditWriter } from './audit/audit-writer.ts';
import type { NightlyProbeResult } from './conversation-parser/nightly-probe.ts';

export type ParserProbeAuditEvent = NightlyProbeResult;

const writer = createAuditWriter<ParserProbeAuditEvent>({
  featureName: 'parser-probe',
  errorLabel: 'gbrain',
  errorMessagePrefix: 'parser-probe audit ',
  errorTrailer: '; probe continues',
});

/** Append one parser-probe event. Best-effort; never throws. */
export function logParserProbeEvent(event: ParserProbeAuditEvent): void {
  writer.log(event);
}

/**
 * Read recent parser-probe events (current + previous ISO week, filtered
 * to the window). Missing files and corrupt rows are skipped silently.
 */
export function readRecentParserProbeEvents(
  days = 7,
  now: Date = new Date(),
): ParserProbeAuditEvent[] {
  // Chronological order (oldest → newest). The shared reader walks the
  // CURRENT week's file first, then the previous week's, so without sorting
  // the array tail is the OLDEST in-window event whenever last week's file
  // has entries — and doctor's "latest" (which reads the tail) reported a
  // days-old run while counts included the newest one.
  return writer.readRecent(days, now)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** Exposed for tests pinning the rotation edge cases. */
export function computeParserProbeAuditFilename(now: Date = new Date()): string {
  return writer.computeFilename(now);
}

/**
 * 24h rate-limit gate for the autopilot wiring: true when any audited run
 * happened within `windowMs` of `now`. Only REAL outcomes are audited (see
 * module header), so a pass/fail today blocks re-runs until tomorrow while
 * scheduler-cadence skips never extend the window.
 */
export function parserProbeRanWithin(
  windowMs: number,
  now: Date = new Date(),
): boolean {
  const cutoff = now.getTime() - windowMs;
  return readRecentParserProbeEvents(2, now).some((ev) => {
    const ts = Date.parse(ev.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });
}
