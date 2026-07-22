/**
 * Batch-retry audit JSONL primitive (v0.41.18.0).
 *
 * Records every batch-retry event from the engine-level retry wrap so silent
 * connection-blip recoveries (and the cases that lose rows when retries
 * exhaust) become observable. Doctor's `batch_retry_health` check reads
 * these to surface sustained breaker incidents.
 *
 * Schema is intentionally narrow: SITE label + ATTEMPT count + OUTCOME +
 * delay + error message summary. We NEVER log row contents, slugs, or page
 * IDs — the audit answers "is the retry path healthy?" not "what got
 * retried?". Mirrors `shell-audit.ts` privacy posture from v0.20+.
 *
 * File: `~/.gbrain/audit/batch-retry-YYYY-Www.jsonl` (ISO-week rotation,
 * honors `GBRAIN_AUDIT_DIR` via the shared `resolveAuditDir()` helper).
 *
 * Pruning (codex H-8): `pruneOldBatchRetryAuditFiles(30)` deletes files
 * older than 30 days. Called from `gbrain dream --phase purge` (the cycle's
 * 9th GC phase that already prunes op_checkpoints).
 */

import * as fs from 'fs';
import * as path from 'path';
import { createAuditWriter, resolveAuditDir, computeIsoWeekFilename } from './audit-writer.ts';
import { redactConnectionInfo } from './redact-connection-info.ts';
import type { BatchAuditSite } from '../retry.ts';

export interface BatchRetryAuditEvent {
  ts: string;
  /** Where the retry fired (from the typed BATCH_AUDIT_SITES enum). */
  site: BatchAuditSite;
  /** Number of rows in the batch when the retry attempt fired. */
  batch_size: number;
  /** 1-based attempt count (1 = first retry, 2 = second, etc.). */
  attempt: number;
  /**
   * 'success' = a retry attempt succeeded and the batch completed.
   * 'exhausted' = all retries failed; batch rows were lost.
   */
  outcome: 'success' | 'exhausted';
  /** Computed delay in ms before this retry attempt. */
  delay_ms: number;
  /** First 200 chars of the error message (privacy posture). */
  error_message_summary: string;
  /** Optional Postgres SQLSTATE code if present. */
  error_code?: string;
}

const FEATURE_NAME = 'batch-retry';

const writer = createAuditWriter<BatchRetryAuditEvent>({
  featureName: FEATURE_NAME,
  errorLabel: 'batch-retry-audit',
  errorTrailer: '; continuing',
});

/**
 * Log a successful retry recovery (retries fired but the batch eventually
 * completed). Best-effort write; never throws.
 */
export function logBatchRetry(
  site: BatchAuditSite,
  batchSize: number,
  attempt: number,
  delayMs: number,
  err: unknown,
): void {
  writer.log({
    site,
    batch_size: batchSize,
    attempt,
    outcome: 'success',
    delay_ms: delayMs,
    error_message_summary: summarizeError(err),
    error_code: extractErrorCode(err),
  });
}

/**
 * Log an exhausted-retry event (all attempts failed; rows lost). This is
 * the high-signal case that drives doctor warnings.
 */
export function logBatchExhausted(
  site: BatchAuditSite,
  batchSize: number,
  totalAttempts: number,
  err: unknown,
): void {
  writer.log({
    site,
    batch_size: batchSize,
    attempt: totalAttempts,
    outcome: 'exhausted',
    delay_ms: 0,
    error_message_summary: summarizeError(err),
    error_code: extractErrorCode(err),
  });
}

/**
 * Read recent batch-retry events plus a corrupted-line count.
 *
 * `corrupted_lines` is the codex-H-9 finding: doctor needs to surface
 * truncated/malformed audit data instead of silently skipping it. Default
 * window is 24h (NOT 7d) because doctor uses these for "is the breaker
 * hot RIGHT NOW" detection — week-old blips are noise.
 */
export interface ReadBatchRetryResult {
  events: BatchRetryAuditEvent[];
  corrupted_lines: number;
  files_scanned: number;
  files_unreadable: number;
}

export function readRecentBatchRetryEvents(
  hours = 24,
  now: Date = new Date(),
): ReadBatchRetryResult {
  const dir = resolveAuditDir();
  const cutoff = now.getTime() - hours * 3_600_000;
  const events: BatchRetryAuditEvent[] = [];
  let corruptedLines = 0;
  let filesScanned = 0;
  let filesUnreadable = 0;

  // Walk current + previous ISO week to cover boundary cases (window
  // straddles Monday-midnight). Mirrors createAuditWriter.readRecent.
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
      // ENOENT is expected when no events have fired for this window;
      // count actual permission / IO failures separately so doctor can
      // surface them (codex H-9).
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code && code !== 'ENOENT') filesUnreadable++;
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      try {
        const ev = JSON.parse(line) as BatchRetryAuditEvent;
        const ts = Date.parse(ev.ts);
        if (Number.isFinite(ts) && ts >= cutoff) events.push(ev);
      } catch {
        corruptedLines++;
      }
    }
  }
  return { events, corrupted_lines: corruptedLines, files_scanned: filesScanned, files_unreadable: filesUnreadable };
}

/**
 * Delete batch-retry audit files older than `daysToKeep`. Called from the
 * dream cycle's `purge` phase (9th, runs after `orphans`). Returns the
 * number of files removed. Best-effort — never throws, logs to stderr on
 * unexpected failure.
 *
 * Codex H-8: the v0.41.17 plan said "30-day pruning is convention" without
 * actually implementing it. This is the real pruning.
 */
export function pruneOldBatchRetryAuditFiles(
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
      process.stderr.write(`[batch-retry-audit] prune scan failed (${(err as Error).message}); continuing\n`);
    }
    return { removed: 0, kept: 0 };
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Filename shape: batch-retry-YYYY-Www.jsonl
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
      // File raced away between readdir + stat / unlink — skip silently.
      process.stderr.write(`[batch-retry-audit] prune ${entry.name} failed (${(err as Error).message}); continuing\n`);
    }
  }
  return { removed, kept };
}

/**
 * Truncate error messages to 200 chars + strip newlines (privacy +
 * grep-friendly). Routes through `redactConnectionInfo` (v0.41.22.2,
 * D9 privacy backfill) BEFORE truncation so DSNs / hostnames /
 * credentials / IPv4 octets can't leak into operator-shared JSONL
 * dumps. Order matters: redaction MUST happen before truncation, or a
 * partially-truncated DSN could leak.
 */
function summarizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const redacted = redactConnectionInfo(raw);
  return redacted.replace(/\s+/g, ' ').slice(0, 200);
}

/** Pull Postgres SQLSTATE if present (e.g. '57014' for statement_timeout). */
function extractErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

// Re-export for test-side helpers and future doctor wiring.
export { FEATURE_NAME as BATCH_RETRY_FEATURE_NAME };
