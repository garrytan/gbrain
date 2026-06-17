/**
 * v0.18.0 Step 7 — phase B storage backfill loader.
 *
 * Drives the `file_migration_ledger` state machine forward:
 *
 *   pending → copy_done → db_updated → complete
 *
 * Each per-file transition is a separate transaction so a crash
 * between states leaves a recoverable row (resume-on-partial). The
 * ledger is the atomicity backstop for non-atomic object-storage
 * "renames" (S3/Supabase = copy+delete).
 *
 * Crash-point recovery:
 *   - crash AFTER copy, BEFORE DB update → re-run detects
 *     `status='copy_done'`, completes DB update (copy is idempotent
 *     against S3 overwrite so re-copy on same path is fine).
 *   - crash AFTER DB update, BEFORE ledger mark → re-run detects
 *     `status='db_updated'`, marks `complete`.
 *   - crash AFTER ledger mark, BEFORE old-object delete → delete runs
 *     in the explicit "cleanup" sub-phase so old objects are
 *     preserved until a separate operator decision.
 *
 * Scope: v0.18.0 Step 7 DOES rewrite storage_path in the files table
 * and copies the bytes to the new source-prefixed path. It does NOT
 * delete the old objects — that's reserved for a later release once
 * operators have had time to verify the new paths. Old and new
 * objects coexist during the soak period.
 */

import type { BrainEngine } from '../../core/engine.ts';
import type { StorageBackend, StorageConfig } from '../../core/storage.ts';

interface LedgerRow {
  file_id: number;
  storage_path_old: string;
  storage_path_new: string;
  status: 'pending' | 'copy_done' | 'db_updated' | 'complete' | 'failed';
}

export interface BackfillReport {
  total: number;
  alreadyComplete: number;
  nowComplete: number;
  failed: number;
  skipped: number;
  errors: Array<{ file_id: number; error: string }>;
}

/**
 * Process all non-complete ledger rows. Safe to re-run; each row
 * resumes from whichever state it was in. Storage is injected so the
 * caller can pass a real S3/Supabase backend OR a dry-run stub that
 * short-circuits the copy.
 *
 * If storage is null/undefined the function runs as a dry-run: it
 * reports what WOULD be processed without touching objects. This is
 * used by the orchestrator when storage isn't configured.
 */
export async function runStorageBackfill(
  engine: BrainEngine,
  storage: StorageBackend | null,
  opts?: { dryRun?: boolean },
): Promise<BackfillReport> {
  const report: BackfillReport = {
    total: 0,
    alreadyComplete: 0,
    nowComplete: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // Snapshot all ledger rows. We don't paginate because the ledger
  // is bounded by current files count — every gbrain install has
  // at most low-thousands of files.
  const rows = await engine.executeRaw<LedgerRow>(
    `SELECT file_id, storage_path_old, storage_path_new, status
       FROM file_migration_ledger
      ORDER BY file_id`,
  );
  report.total = rows.length;

  for (const row of rows) {
    if (row.status === 'complete') {
      report.alreadyComplete++;
      continue;
    }
    if (row.status === 'failed') {
      report.failed++;
      continue;
    }

    if (opts?.dryRun || !storage) {
      // Dry-run: count pending rows but don't advance state.
      report.skipped++;
      continue;
    }

    // Drive the state machine. Each transition is its own
    // executeRaw call so mid-row crashes leave a recoverable state.
    try {
      let status = row.status;

      // pending → copy_done: COPY the bytes.
      if (status === 'pending') {
        // If the new path is already populated (e.g. from a previous
        // partial run), the copy is redundant but idempotent on S3/
        // Supabase where upload overwrites the key.
        const exists = await storage.exists(row.storage_path_new).catch(() => false);
        if (!exists) {
          const data = await storage.download(row.storage_path_old);
          await storage.upload(row.storage_path_new, data);
        }
        await engine.executeRaw(
          `UPDATE file_migration_ledger
             SET status = 'copy_done', updated_at = now()
           WHERE file_id = $1`,
          [row.file_id],
        );
        status = 'copy_done';
      }

      // copy_done → db_updated: flip files.storage_path to the new
      // path. Once this commits, downloads go through the new path
      // and the old object is orphaned (but still present on disk
      // for rollback within the soak window).
      if (status === 'copy_done') {
        await engine.executeRaw(
          `UPDATE files SET storage_path = $1 WHERE id = $2`,
          [row.storage_path_new, row.file_id],
        );
        await engine.executeRaw(
          `UPDATE file_migration_ledger
             SET status = 'db_updated', updated_at = now()
           WHERE file_id = $1`,
          [row.file_id],
        );
        status = 'db_updated';
      }

      // db_updated → complete: mark terminal. The old-object delete
      // happens in a separate sub-phase (future release) so operators
      // can verify the new paths before we drop the safety net.
      if (status === 'db_updated') {
        await engine.executeRaw(
          `UPDATE file_migration_ledger
             SET status = 'complete', updated_at = now()
           WHERE file_id = $1`,
          [row.file_id],
        );
        report.nowComplete++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      report.failed++;
      report.errors.push({ file_id: row.file_id, error: msg });
      // Mark failed so the next run doesn't retry blindly. Operator
      // can reset to 'pending' via SQL once the root cause is fixed.
      try {
        await engine.executeRaw(
          `UPDATE file_migration_ledger
             SET status = 'failed', error = $1, updated_at = now()
           WHERE file_id = $2`,
          [msg.slice(0, 500), row.file_id],
        );
      } catch {
        // Best-effort: if we can't even write 'failed', report the
        // original error and move on.
      }
    }
  }

  return report;
}
