/**
 * Lock-renewal audit JSONL primitive (v0.41.22.2).
 *
 * Records every per-job lock-renewal fault from the worker's renewal
 * timer so silent PgBouncer outages, hung connections, and the
 * v0.41.22.1 unhandledRejection crash class become observable. The
 * audit channel is the canonical operator-facing trail for the
 * lock-renewal cathedral wave (see plan
 * `~/.claude/plans/system-instruction-you-are-working-humming-nygaard.md`).
 *
 * File: `~/.gbrain/audit/lock-renewal-YYYY-Www.jsonl` (ISO-week
 * rotation, honors `GBRAIN_AUDIT_DIR` via the shared `resolveAuditDir()`
 * helper). Built on the v0.40.4.0 `audit-writer.ts` primitive — same
 * dual-week read window, same best-effort write contract.
 *
 * Four outcomes:
 *   - `failure`              — a single renewLock attempt threw; counter incremented
 *   - `success_after_failure` — renewLock recovered after >=1 failure; emits the recovery count
 *   - `gave_up`               — time-based deadline exceeded; abort fired
 *   - `executeJob_rejected`   — the SECOND unhandledRejection vector from D7;
 *                               the stored executeJob(...).finally(...) promise
 *                               itself rejected (e.g., failJob threw during
 *                               the same DB outage)
 *
 * Privacy:
 *   - NEVER logs `lock_token` (write-side fence; secret).
 *   - NEVER logs `job.data` (could contain user-supplied payloads).
 *   - NEVER logs the successful-on-first-try path (would drown disk;
 *     ~5760 events/day per active job during healthy operation).
 *   - Error summaries route through `redactConnectionInfo` BEFORE
 *     truncation so DSNs / hostnames / credentials / IPs don't leak
 *     into a JSONL that operators routinely paste into GitHub issues.
 *
 * Defense-in-depth: every appendFileSync call inside the audit-writer
 * is best-effort (writes stderr-warn on failure, never throws). The
 * worker.ts catch blocks ADDITIONALLY wrap audit calls in their own
 * inner try/catch (codex C4) so a misbehaving audit primitive can't
 * propagate up to the IIFE's surrounding catch and re-introduce the
 * unhandledRejection bug class via a new path.
 *
 * Doctor wiring + dream-purge wiring are filed as v0.41.22+ follow-up
 * TODOs in TODOS.md. For v0.41.22.2 the operator surface is
 * `tail -F ~/.gbrain/audit/lock-renewal-*.jsonl`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createAuditWriter, resolveAuditDir, computeIsoWeekFilename } from './audit-writer.ts';
import { redactConnectionInfo } from './redact-connection-info.ts';

export type LockRenewalOutcome =
  | 'failure'
  | 'success_after_failure'
  | 'gave_up'
  | 'executeJob_rejected';

export interface LockRenewalAuditEvent {
  ts: string;
  /** Minion queue job id. */
  job_id: number;
  /** Minion job name (e.g. 'sync', 'embed', 'subagent'). */
  job_name: string;
  /**
   * 1-based count of consecutive renewLock failures at the moment this
   * event was emitted. For `success_after_failure`, this is the
   * recovery count (how many failures preceded the recovery). For
   * `executeJob_rejected`, this field is omitted (the rejection comes
   * from a different surface than the renewal counter).
   */
  attempt?: number;
  outcome: LockRenewalOutcome;
  /**
   * First 200 chars of the error message, redacted via
   * `redactConnectionInfo` BEFORE truncation. Omitted for
   * `success_after_failure` (no error to summarize).
   */
  error_message_summary?: string;
  /** Postgres SQLSTATE if present (e.g. '08006' for connection failure). */
  error_code?: string;
}

const FEATURE_NAME = 'lock-renewal';

const writer = createAuditWriter<LockRenewalAuditEvent>({
  featureName: FEATURE_NAME,
  errorLabel: 'lock-renewal-audit',
  errorTrailer: '; continuing',
});

/**
 * Sink interface consumed by `runLockRenewalTick`. Real implementation
 * binds the four functions below; tests inject a fake to assert calls
 * without writing to disk.
 */
export interface LockRenewalAuditSink {
  logFailure(jobId: number, jobName: string, attempt: number, err: unknown): void;
  logSuccessAfterFailure(jobId: number, jobName: string, recoveredAfterAttempts: number): void;
  logGaveUp(jobId: number, jobName: string, totalFailures: number, err: unknown): void;
  logExecuteJobRejected(jobId: number, jobName: string, err: unknown): void;
}

export const lockRenewalAudit: LockRenewalAuditSink = {
  logFailure(jobId, jobName, attempt, err) {
    writer.log({
      job_id: jobId,
      job_name: jobName,
      attempt,
      outcome: 'failure',
      error_message_summary: summarizeError(err),
      error_code: extractErrorCode(err),
    });
  },
  logSuccessAfterFailure(jobId, jobName, recoveredAfterAttempts) {
    writer.log({
      job_id: jobId,
      job_name: jobName,
      attempt: recoveredAfterAttempts,
      outcome: 'success_after_failure',
      // No error_message_summary or error_code: recovery has no error.
    });
  },
  logGaveUp(jobId, jobName, totalFailures, err) {
    writer.log({
      job_id: jobId,
      job_name: jobName,
      attempt: totalFailures,
      outcome: 'gave_up',
      error_message_summary: summarizeError(err),
      error_code: extractErrorCode(err),
    });
  },
  logExecuteJobRejected(jobId, jobName, err) {
    writer.log({
      job_id: jobId,
      job_name: jobName,
      // No `attempt` — this surface is the stored executeJob promise
      // rejection, unrelated to the per-job renewal counter.
      outcome: 'executeJob_rejected',
      error_message_summary: summarizeError(err),
      error_code: extractErrorCode(err),
    });
  },
};

/**
 * Read recent lock-renewal events plus a corrupted-line count.
 * Default window is 24h (matches batch-retry-audit's "is the breaker
 * hot RIGHT NOW" semantics).
 */
export interface ReadLockRenewalResult {
  events: LockRenewalAuditEvent[];
  corrupted_lines: number;
  files_scanned: number;
  files_unreadable: number;
}

export function readRecentLockRenewalEvents(
  hours = 24,
  now: Date = new Date(),
): ReadLockRenewalResult {
  const dir = resolveAuditDir();
  const cutoff = now.getTime() - hours * 3_600_000;
  const events: LockRenewalAuditEvent[] = [];
  let corruptedLines = 0;
  let filesScanned = 0;
  let filesUnreadable = 0;

  // Walk current + previous ISO week so a 24h window straddling
  // Monday-midnight stays covered (mirrors batch-retry-audit pattern).
  const filenames = [
    computeIsoWeekFilename(FEATURE_NAME, now),
    computeIsoWeekFilename(FEATURE_NAME, new Date(now.getTime() - 7 * 86400_000)),
  ];

  for (const filename of filenames) {
    const file = path.join(dir, filename);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
      filesScanned++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code && code !== 'ENOENT') filesUnreadable++;
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      try {
        const ev = JSON.parse(line) as LockRenewalAuditEvent;
        const ts = Date.parse(ev.ts);
        if (Number.isFinite(ts) && ts >= cutoff) events.push(ev);
      } catch {
        corruptedLines++;
      }
    }
  }
  return {
    events,
    corrupted_lines: corruptedLines,
    files_scanned: filesScanned,
    files_unreadable: filesUnreadable,
  };
}

/**
 * Delete lock-renewal audit files older than `daysToKeep`. Called from
 * the dream cycle's `purge` phase (filed as a v0.41.22+ follow-up TODO
 * — wiring is one line at the existing purge handler).
 */
export function pruneOldLockRenewalAuditFiles(
  daysToKeep = 30,
  now: Date = new Date(),
): { removed: number; kept: number } {
  const dir = resolveAuditDir();
  const cutoff = now.getTime() - daysToKeep * 86400_000;
  let removed = 0;
  let kept = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      process.stderr.write(`[lock-renewal-audit] prune scan failed (${(err as Error).message}); continuing\n`);
    }
    return { removed: 0, kept: 0 };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(`${FEATURE_NAME}-`) || !entry.name.endsWith('.jsonl')) continue;
    const file = path.join(dir, entry.name);
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed++;
      } else {
        kept++;
      }
    } catch (err) {
      process.stderr.write(`[lock-renewal-audit] prune ${entry.name} failed (${(err as Error).message}); continuing\n`);
    }
  }
  return { removed, kept };
}

/**
 * Redact connection info, normalize whitespace, then truncate to 200
 * chars. Order matters: redaction MUST happen before truncation, or a
 * partially-truncated DSN could leak.
 */
function summarizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = redactConnectionInfo(raw);
  return redacted.replace(/\s+/g, ' ').slice(0, 200);
}

/** Pull Postgres SQLSTATE if present (e.g. '08006' for connection failure). */
function extractErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

// Re-export for tests + future doctor wiring.
export { FEATURE_NAME as LOCK_RENEWAL_FEATURE_NAME };
