/**
 * Shell-job submission audit log (operational trace, NOT forensic insurance).
 *
 * Writes a JSONL line per shell-job submission to `~/.gbrain/audit/shell-jobs-YYYY-Www.jsonl`
 * (ISO week rotation, override via `GBRAIN_AUDIT_DIR`). Best-effort: write failures go
 * to stderr and never block submission, which means a disk-full attacker could silently
 * disable the trail. CHANGELOG calls this out honestly: it's for debugging "what did
 * this cron submit last Tuesday?", not for security-critical forensics.
 *
 * Never logs `env` values (may contain secrets). Does log `cmd` and `argv` truncated to
 * 80 chars for cmd / stored as JSON array for argv — the command text itself can contain
 * inline tokens (`curl -H 'Authorization: Bearer ...'`) and the guide explicitly tells
 * operators to put secrets in `env:` instead of embedding them in the command line.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { gbrainPath } from '../../config.ts';

export interface ShellAuditEvent {
  ts: string;
  caller: 'cli' | 'mcp';
  remote: boolean;
  job_id: number;
  cwd: string;
  cmd_display?: string;        // first 80 chars of cmd; may contain inline tokens
  argv_display?: string[];     // each arg truncated individually to preserve separation
}

/** Compute `shell-jobs-YYYY-Www.jsonl` using ISO-8601 week numbering.
 *
 *  Year-boundary edge: 2027-01-01 is ISO week 53 of year 2026, so the correct
 *  filename is `shell-jobs-2026-W53.jsonl`. This matches the ISO week standard
 *  (week containing the first Thursday of the year is W1; week containing Dec 28
 *  is always W52 or W53 of that year).
 */
export function computeAuditFilename(now: Date = new Date()): string {
  // Copy date and move to nearest Thursday (ISO week anchor).
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to Thursday
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `shell-jobs-${isoYear}-W${ww}.jsonl`;
}

/** Resolve the audit dir. Honors `GBRAIN_AUDIT_DIR` for container/sandbox deployments
 *  where `$HOME` is read-only. Defaults to `~/.gbrain/audit/`. */
export function resolveAuditDir(): string {
  const override = process.env.GBRAIN_AUDIT_DIR;
  if (override && override.trim().length > 0) return override;
  return gbrainPath('audit');
}

export function logShellSubmission(event: Omit<ShellAuditEvent, 'ts'>): void {
  const dir = resolveAuditDir();
  const filename = computeAuditFilename();
  const fullPath = path.join(dir, filename);
  const line = JSON.stringify({ ...event, ts: new Date().toISOString() }) + '\n';

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(fullPath, line, { encoding: 'utf8' });
  } catch (err) {
    // Best-effort: log to stderr and keep going. A disk-full or EACCES attacker
    // can silently disable this trail, which is why CHANGELOG calls it an
    // operational trace, not forensic insurance.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[shell-audit] write failed (${msg}); submission continues\n`);
  }
}
