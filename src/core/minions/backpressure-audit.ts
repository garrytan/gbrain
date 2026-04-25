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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface BackpressureAuditEvent {
  ts: string;
  queue: string;
  name: string;
  waiting_count: number;
  max_waiting: number;
  decision: 'coalesced';
  returned_job_id: number;
}

/** Compute `backpressure-YYYY-Www.jsonl` using ISO-8601 week numbering.
 *
 *  Copy of the shell-audit computeAuditFilename algorithm, parameterized on
 *  the filename prefix. Keeping the math inline (rather than re-exporting from
 *  shell-audit.ts) avoids a cross-module dependency between two best-effort
 *  audit surfaces — one can be rewritten without touching the other.
 */
export function computeAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to Thursday
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `backpressure-${isoYear}-W${ww}.jsonl`;
}

/** Honors `GBRAIN_AUDIT_DIR` for container/sandbox deployments. */
export function resolveAuditDir(): string {
  const override = process.env.GBRAIN_AUDIT_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(os.homedir(), '.gbrain', 'audit');
}

export function logBackpressureCoalesce(event: Omit<BackpressureAuditEvent, 'ts' | 'decision'>): void {
  const dir = resolveAuditDir();
  const filename = computeAuditFilename();
  const fullPath = path.join(dir, filename);
  const line = JSON.stringify({
    ...event,
    decision: 'coalesced' as const,
    ts: new Date().toISOString(),
  }) + '\n';

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fullPath, line, { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[backpressure-audit] write failed (${msg}); submission continues\n`);
  }
}
