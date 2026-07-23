/**
 * v0.40.1.0 Track D / T6 — nightly quality probe audit trail.
 *
 * Writes one event per nightly cross-modal probe run to
 * `~/.gbrain/audit/quality-probe-YYYY-Www.jsonl` (ISO-week rotation).
 * Mirrors `audit-slug-fallback.ts` for filename + best-effort write
 * semantics. Honors `GBRAIN_AUDIT_DIR` via the shared `resolveAuditDir`.
 *
 * Read by `gbrain doctor`'s `nightly_quality_probe_health` check to
 * surface FAIL / ERROR / BUDGET_EXCEEDED runs from the last 7 days.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAuditDir } from './minions/handlers/shell-audit.ts';

export type QualityProbeOutcome =
  | 'pass'
  | 'fail'
  | 'inconclusive'
  | 'error'
  | 'budget_exceeded'
  | 'rate_limited'
  | 'no_embedding_key';

export interface QualityProbeAuditEvent {
  ts: string;
  /** Verdict from the cross-modal batch summary (or short-circuit reason). */
  outcome: QualityProbeOutcome;
  /** Exit code of the underlying batch (0/1/2/-1 when short-circuited). */
  exit_code: number;
  pass_count: number;
  fail_count: number;
  inconclusive_count: number;
  error_count: number;
  /** Estimated cost in USD (0 when short-circuited before runs). */
  est_cost_usd: number;
  /** Sha-8 of the fixture file content for change detection. */
  fixture_sha8?: string;
  /** Optional human-readable detail (e.g. error message, "no chat provider configured"). */
  detail?: string;
}

/** ISO-week-rotated filename: `quality-probe-YYYY-Www.jsonl`. Mirrors audit-slug-fallback. */
export function computeQualityProbeAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `quality-probe-${isoYear}-W${ww}.jsonl`;
}

/**
 * Append one quality-probe event. Best-effort: write failure logs to stderr
 * but the probe phase continues.
 */
export function logQualityProbeEvent(event: Omit<QualityProbeAuditEvent, 'ts'> & { ts?: string }): void {
  const stamped: QualityProbeAuditEvent = {
    ts: event.ts ?? new Date().toISOString(),
    outcome: event.outcome,
    exit_code: event.exit_code,
    pass_count: event.pass_count,
    fail_count: event.fail_count,
    inconclusive_count: event.inconclusive_count,
    error_count: event.error_count,
    est_cost_usd: event.est_cost_usd,
    ...(event.fixture_sha8 !== undefined ? { fixture_sha8: event.fixture_sha8 } : {}),
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
  };
  const dir = resolveAuditDir();
  const file = path.join(dir, computeQualityProbeAuditFilename());
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(stamped) + '\n', { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] quality-probe audit write failed (${msg}); probe continues\n`);
  }
}

/**
 * Read recent quality-probe events from the current + prior ISO week files.
 * Used by `gbrain doctor`'s nightly_quality_probe_health check. Missing
 * files and corrupt rows are skipped silently.
 */
export function readRecentQualityProbeEvents(
  days = 7,
  now: Date = new Date(),
): QualityProbeAuditEvent[] {
  const dir = resolveAuditDir();
  const cutoff = now.getTime() - days * 86400000;
  const out: QualityProbeAuditEvent[] = [];
  const filenames = [
    computeQualityProbeAuditFilename(now),
    computeQualityProbeAuditFilename(new Date(now.getTime() - 7 * 86400000)),
  ];
  for (const filename of filenames) {
    const file = path.join(dir, filename);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      try {
        const ev = JSON.parse(line) as QualityProbeAuditEvent;
        const ts = Date.parse(ev.ts);
        if (Number.isFinite(ts) && ts >= cutoff) out.push(ev);
      } catch {
        // corrupt row — skip
      }
    }
  }
  // Chronological order (oldest → newest). Events accumulate across two
  // week files read current-week-FIRST, so without sorting the array tail
  // is the OLDEST in-window event whenever last week's file has entries —
  // and doctor's "Latest:" (which reads the tail) reported a days-old run
  // while the counts included the newest one.
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}
