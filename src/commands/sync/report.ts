/** Post-sync human reporting and best-effort nudges for the sync CLI. */
import { formatManagedSyncFailure, managedSyncRetryCommand } from '../../core/persistence/sync-failures.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { isEmbeddingInfraCode } from '../../core/sync.ts';
import { serr } from '../../core/console-prefix.ts';
import { printManagedSyncDiagnostic, printManagedSyncNotes } from '../sync-diagnostics.ts';
import type { SyncResult } from '../sync.ts';

/**
 * v0.42.7 (#1696, D5): which terminal sync statuses warrant the end-of-sync
 * extraction-lag nudge. Fires on every non-error completion — crucially
 * `first_sync` (a fresh / --full import is the BIGGEST un-extracted backlog) and
 * `up_to_date` (a no-op sync over a brain with a pre-existing backlog still
 * warrants the nudge). Excludes `dry_run` (preview) / `blocked_by_failures` /
 * `partial` (inconsistent state). Pure so D5's contract is unit-testable
 * without driving the CLI.
 */
export function shouldNudgeAfterSync(status: SyncResult['status']): boolean {
  return status === 'synced' || status === 'first_sync' || status === 'up_to_date';
}

/**
 * #3068 / #5012: partials that do not converge on a plain retry exit
 * non-zero so cron and monitoring see them: a failed pull, connector items
 * that failed to import, and a connector that stopped early without a cause.
 * Timeout-class partials keep exit 0 (the next run continues).
 */
export function isFailedPartial(result: Pick<SyncResult, 'status' | 'reason'>): boolean {
  return result.status === 'partial'
    && (result.reason === 'pull_failed' || result.reason === 'connector_item_failures' || result.reason === 'connector_partial');
}

/**
 * Post-sync backup-coverage refresh (monthly, stale-only). The sync CLI is a
 * trusted local engine holder (D4), so the compute piggybacks here; the
 * shared choke point (getBackupStatus) makes a fresh cache a no-op file read.
 * Best-effort — never blocks or fails a sync.
 */
export async function maybeBackupCoverageRefresh(engine: BrainEngine): Promise<void> {
  try {
    const { backupCheckDisabled, isBackupStatusStale, loadBackupStatus } = await import(
      '../../core/backup/status-file.ts'
    );
    if (backupCheckDisabled() || !isBackupStatusStale(loadBackupStatus())) return;
    const { getBackupStatus } = await import('../../core/backup/coverage.ts');
    await getBackupStatus(engine, { localGitProbes: true, computedBy: 'sync' });
  } catch {
    /* best-effort — never block sync on it */
  }
}

/**
 * v0.42.7 (#1696): one-line end-of-sync nudge when the brain (or a source)
 * carries a meaningful link/timeline extraction backlog. Reuses the same warn
 * threshold (GBRAIN_EXTRACTION_LAG_WARN_PCT, default 20%) the doctor check uses
 * so the nudge fires iff doctor would warn — one source of truth. Always
 * stderr (never stdout — keeps `--json` clean), suppressible via
 * GBRAIN_SYNC_NO_EXTRACT_NUDGE, best-effort (never throws). Source-prefix-aware
 * via serr when called inside a withSourcePrefix scope.
 */
export async function maybeExtractionNudge(engine: BrainEngine, sourceId?: string): Promise<void> {
  if (process.env.GBRAIN_SYNC_NO_EXTRACT_NUDGE) return;
  try {
    const { effectiveLinkExtractorWatermark } = await import('../../core/link-extraction-watermark.ts');
    // D3/C4: resolve the warn threshold + vacuous-skip floor through the SAME
    // helpers the doctor check uses (dynamic import keeps doctor.ts off sync's
    // eager-load path) so "the nudge fires iff doctor would warn" can't drift.
    const { _resolveEnvNumber, EXTRACTION_LAG_WARN_PCT_DEFAULT, EXTRACTION_LAG_MIN_PAGES } = await import('../doctor.ts');
    const totalRows = await engine.executeRaw<{ count: number }>(
      sourceId
        ? `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL AND source_id = $1`
        : `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL`,
      sourceId ? [sourceId] : [],
    );
    const total = Number(totalRows[0]?.count ?? 0);
    // Match doctor's predicate EXACTLY (C4): skip tiny brains only when NOT
    // source-scoped (a small explicit source IS assessed, like orphan_ratio).
    if (total < EXTRACTION_LAG_MIN_PAGES && !sourceId) return;
    const stale = await engine.countStalePagesForExtraction({ sourceId, versionTs: await effectiveLinkExtractorWatermark(engine) });
    const warnPct = _resolveEnvNumber('GBRAIN_EXTRACTION_LAG_WARN_PCT', EXTRACTION_LAG_WARN_PCT_DEFAULT, { unit: '%' });
    if ((stale / total) * 100 > warnPct) {
      serr(`[sync] ${stale} page(s) have un-extracted edges — run 'gbrain extract --stale'`);
    }
  } catch { /* nudge is best-effort — never block sync on it */ }
}

/**
 * Render a SyncResult to a Writable sink.
 *
 * `sink` defaults to `process.stdout` so existing single-source callers
 * see identical output. The `--all` and single-source paths pass
 * `process.stderr` when `--json` is set, so banners stay off stdout and the
 * JSON envelope pipes cleanly through `jq` (D4).
 */
export function printSyncResult(result: SyncResult, sink: NodeJS.WriteStream = process.stdout) {
  if (printManagedSyncDiagnostic(result, sink)) {
    if (result.runId) sink.write(`  Committed counts are cumulative for run ${result.runId}: added=${result.added}, modified=${result.modified}, deleted=${result.deleted}.\n`);
    return;
  }
  const write = (line: string) => sink.write(line + '\n');
  const writeUncommittedNote = (u: NonNullable<SyncResult['uncommitted']>) =>
    write(
      `  NOTE: ${u.added + u.modified + u.deleted} uncommitted file(s) not synced ` +
      `(${u.added} untracked/added, ${u.modified} modified, ${u.deleted} deleted) — ` +
      `commit them or run 'gbrain sync --working-tree'.`,
    );
  switch (result.status) {
    case 'up_to_date':
      write('Already up to date.');
      if (result.uncommitted) writeUncommittedNote(result.uncommitted);
      break;
    case 'synced':
      // Connector sources have no commit range.
      write(result.toCommit ? `Synced ${result.fromCommit?.slice(0, 8) ?? '<initial>'}..${result.toCommit.slice(0, 8)}:` : 'Synced:');
      write(`  +${result.added} added, ~${result.modified} modified, -${result.deleted} soft-deleted (recoverable 72h), R${result.renamed} renamed`);
      write(`  ${result.chunksCreated} chunks created${result.embedded > 0 ? `, ${result.embedded} pages embedded` : ''}`);
      if (result.uncommitted) writeUncommittedNote(result.uncommitted);
      break;
    case 'first_sync':
      write(`First sync complete. Checkpoint: ${result.toCommit.slice(0, 8)}`);
      write(`  ${result.added} file(s) imported, ${result.chunksCreated} chunks${result.embedded > 0 ? `, ${result.embedded} pages embedded` : ''}`);
      break;
    case 'dry_run':
      break; // already printed in performSync
    case 'blocked_by_failures': {
      if (result.runId) {
        write(`Sync BLOCKED at ${result.toCommit}: committed counts are cumulative for run ${result.runId}.`);
        for (const failure of result.failures ?? []) write(`  ${formatManagedSyncFailure(failure)}`);
        const retries = [...new Set((result.failures ?? []).map(failure => managedSyncRetryCommand(failure)))];
        write(retries.length
          ? `  Fix the cause, then run: ${retries.join(' ; ')} (this admits a fresh run after active work drains).`
          : '  Fix the cause, then run gbrain sync --no-pull --retry-failed with the same source and options; this admits a fresh run after active work drains.');
        break;
      }
      write(`Sync BLOCKED at ${result.toCommit.slice(0, 8)}: ${result.failedFiles ?? 0} file(s) failed.`);
      write(`  See ~/.gbrain/sync-failures.jsonl for details, or run 'gbrain doctor'.`);
      // #3875: code-aware recovery hint — provider-infra failures are not
      // fixed by --skip-failed (that would silently unindex good files).
      const infraCodes = (result.failureCodes ?? []).filter(c => isEmbeddingInfraCode(c.code));
      if (infraCodes.length > 0) {
        write(
          `  Embedding provider errors (${infraCodes.map(c => `${c.code} x${c.count}`).join(', ')}): ` +
          `check provider health, then re-run 'gbrain sync' (or 'gbrain sync --full'). ` +
          `Do NOT use --skip-failed for provider errors.`,
        );
      } else {
        write(`  Pinpoint with 'gbrain frontmatter validate <path>', fix, then re-run 'gbrain sync', or 'gbrain sync --skip-failed' to move on.`);
      }
      break;
    }
    case 'partial':
      // #3068: a failed (non-timeout) pull with zero imports gets its own
      // message — "imported 0 of 0" reads like success, but the local
      // checkout may be behind a remote we could not fetch.
      if (result.reason === 'pull_failed') {
        write(
          `Sync INCOMPLETE at ${result.fromCommit?.slice(0, 8) ?? '<initial>'}: ` +
          `git pull failed — the local checkout may be behind its remote.`,
        );
        write(`  Fix the pull (see the warning above), then re-run 'gbrain sync' (last_commit unchanged; safe to retry).`);
        break;
      }
      if (result.reason === 'connector_item_failures') {
        write(
          `Sync PARTIAL [connector_item_failures]: ${result.failedFiles ?? 0} connector item(s) failed to import; ` +
          `${result.filesImported ?? result.added + result.modified} page(s) written.`,
        );
        write(`  The failure reasons are in the warnings above. Fix the cause, then re-run 'gbrain sync --source <id>' (the cursor did not advance past failed items; see 'gbrain sources status <id>'). Docs: docs/guides/google-connect.md#held-items`);
        break;
      }
      if (result.reason === 'connector_partial') {
        write(
          `Sync PARTIAL [connector_partial]: the connector stopped before finishing and reported no cause; ` +
          `${result.filesImported ?? result.added + result.modified} page(s) written.`,
        );
        write(`  Check the warnings above (expired or revoked credentials print there), fix the cause, then re-run 'gbrain sync --source <id>'.`);
        break;
      }
      // #5984: a managed cursor knows its manifest size; the drain summary prints the next step.
      if (result.managedCursor) {
        write(`Sync PARTIAL at ${result.fromCommit?.slice(0, 8) ?? '<initial>'}: ${result.managedCursor.index} of ${result.managedCursor.total} manifest entries processed, reason=${result.reason ?? 'timeout'} (last_commit unchanged; safe to retry).`);
        break;
      }
      // v0.41.13.0 (T7 / D-V3-5): --timeout fired before the bookmark write
      // so last_commit is UNCHANGED. The next sync re-walks the same diff
      // and content_hash short-circuits already-imported files at ~10ms each.
      // The reason field distinguishes generic timeout (mid-import) from
      // pull_timeout (subprocess wedge / SIGTERM during git pull).
      write(
        `Sync PARTIAL at ${result.fromCommit?.slice(0, 8) ?? '<initial>'}: ` +
        `imported ${result.filesImported ?? 0} of ${result.added + result.modified} file(s), ` +
        `reason=${result.reason ?? 'timeout'}.`,
      );
      write(`  Re-run 'gbrain sync' to continue (last_commit unchanged; safe to retry).`);
      break;
  }
  const holds = result.connectorHolds;
  if (holds) write(`  ${holds.held} connector item(s) held after repeated failures${holds.newly_held ? ` (${holds.newly_held} new)` : ''}; they do not block freshness. See them with '${holds.status_command}', re-attempt with '${holds.retry_command}'.`);
  printManagedSyncNotes(result, write);
}
