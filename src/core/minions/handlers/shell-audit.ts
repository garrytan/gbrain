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
 * v0.40.4.0: internals delegate to the shared `src/core/audit/audit-writer.ts`
 * primitive. The public surface (logShellSubmission, computeAuditFilename,
 * resolveAuditDir) is preserved bit-for-bit because every other audit module
 * AND callers across `gbrain-home-isolation.test.ts`, `minions.test.ts`,
 * `minions-shell.test.ts` import these by name.
 */

import { createAuditWriter, computeIsoWeekFilename, resolveAuditDir as sharedResolveAuditDir } from '../../audit/audit-writer.ts';

export interface ShellAuditEvent {
  ts: string;
  caller: 'cli' | 'mcp';
  remote: boolean;
  job_id: number;
  cwd: string;
  cmd_display?: string;        // first 80 chars of cmd; may contain inline tokens
  argv_display?: string[];     // each arg truncated individually to preserve separation
  /** Names of inheritable secrets requested via `inherit:` (v0.35.8.0).
   *  Names only — values never appear here. */
  inherit?: string[];
}

/** Compute `shell-jobs-YYYY-Www.jsonl` using ISO-8601 week numbering.
 *
 *  Year-boundary edge: 2027-01-01 is ISO week 53 of year 2026, so the correct
 *  filename is `shell-jobs-2026-W53.jsonl`. This matches the ISO week standard
 *  (week containing the first Thursday of the year is W1; week containing Dec 28
 *  is always W52 or W53 of that year).
 */
export function computeAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('shell-jobs', now);
}

/** Resolve the audit dir. Honors `GBRAIN_AUDIT_DIR` for container/sandbox deployments
 *  where `$HOME` is read-only. Defaults to `~/.gbrain/audit/`.
 *
 *  v0.40.4.0: re-exported from `src/core/audit/audit-writer.ts` so the single
 *  source of truth lives in the shared primitive. Existing imports (every
 *  refactored audit module, plus tests) keep working unchanged.
 */
export function resolveAuditDir(): string {
  return sharedResolveAuditDir();
}

// Module-scoped writer instance. featureName matches the pre-v0.40.4 filename
// prefix, errorLabel matches the pre-v0.40.4 stderr label, errorTrailer matches
// the pre-v0.40.4 trailing phrase. Byte-identical operator-visible behavior.
const writer = createAuditWriter<ShellAuditEvent>({
  featureName: 'shell-jobs',
  errorLabel: 'shell-audit',
  errorTrailer: '; submission continues',
});

export function logShellSubmission(event: Omit<ShellAuditEvent, 'ts'>): void {
  writer.log(event);
}
