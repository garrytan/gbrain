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
 *
 * 2026-05-16 refactored to use the shared `createAuditLogger` primitive from
 * `~/Projects/gbrain/src/core/audit-jsonl.ts`. `resolveAuditDir` and
 * `computeAuditFilename` moved out; both are re-exported here for backward
 * compatibility with the original callers.
 */

import {
  createAuditLogger,
  resolveAuditDir as resolveAuditDirShared,
  computeIsoWeekFilename,
} from '../../audit-jsonl.ts';

export interface ShellAuditEvent {
  ts: string;
  caller: 'cli' | 'mcp';
  remote: boolean;
  job_id: number;
  cwd: string;
  cmd_display?: string;        // first 80 chars of cmd; may contain inline tokens
  argv_display?: string[];     // each arg truncated individually to preserve separation
}

const logger = createAuditLogger<ShellAuditEvent>({
  prefix: 'shell-jobs',
  stderrTag: '[shell-audit]',
  continueMessage: 'submission continues',
});

/**
 * Compute `shell-jobs-YYYY-Www.jsonl` using ISO-8601 week numbering.
 * Re-exported under the original name (callers may still import this directly).
 */
export function computeAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('shell-jobs', now);
}

/** Resolve the audit dir. Honors `GBRAIN_AUDIT_DIR`. Re-exported from the
 *  shared module so legacy callers (audit-slug-fallback, rerank-audit) still
 *  resolve through the same primitive. New callers should import directly
 *  from `~/Projects/gbrain/src/core/audit-jsonl.ts`. */
export function resolveAuditDir(): string {
  return resolveAuditDirShared();
}

export function logShellSubmission(event: Omit<ShellAuditEvent, 'ts'>): void {
  logger.log(event);
}
