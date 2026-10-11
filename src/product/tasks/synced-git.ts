import type { BrainEngine } from '../../core/engine.ts';
import { commitSyncedSourceFiles, type SyncedGitFile, type SyncedGitResult, type SyncedGitOptions } from '../../core/pmbrain-adapters/synced-git.ts';
import type { SyncResult } from '../../commands/sync.ts';
import { executeRawJsonb } from '../../core/sql-query.ts';

export async function recordSyncedGitFile(engine: Pick<BrainEngine, 'executeRaw'>, jobId: number, sourceId: string, file: SyncedGitFile) {
  const key = JSON.stringify([sourceId, file.path]);
  await executeRawJsonb(engine, `UPDATE minion_jobs SET data=jsonb_set(data,'{gitFiles}',
    COALESCE(data->'gitFiles','{}'::jsonb) || $2::jsonb) WHERE id=$1`, [jobId], [{ [key]: { ...file, sourceId } }]);
}

export async function commitQuickMaintenanceSource(engine: BrainEngine, jobId: number, sourceId: string, root: string, sync: SyncResult, options: SyncedGitOptions = {}) {
  if (await engine.getConfig('sync.auto_git_commit') === 'false') return null;
  const job = await engine.executeRaw<{ files: Record<string, SyncedGitFile & { sourceId: string }>; results: Record<string, SyncedGitResult> }>(
    "SELECT COALESCE(data->'gitFiles','{}'::jsonb) AS files, COALESCE(data->'gitResults','{}'::jsonb) AS results FROM minion_jobs WHERE id=$1", [jobId]);
  const files = Object.values(job[0]?.files ?? {}).filter(file => file.sourceId === sourceId);
  let result: SyncedGitResult & { sourceId: string; error?: string };
  try {
    result = { ...await commitSyncedSourceFiles(root, files, options), sourceId };
    if (result.committed && !result.pending.length && !sync.failedFiles && ['synced', 'first_sync', 'up_to_date'].includes(sync.status)) {
      await engine.executeRaw(`UPDATE sources SET last_commit=$3, last_sync_at=now()
        WHERE id=$1 AND last_commit=$2`, [sourceId, sync.toCommit, result.commit]);
    }
  } catch (error) {
    options.signal?.throwIfAborted();
    result = { sourceId, repository: true, committed: false, commit: null, previousCommit: null, files: [], pending: files.map(file => ({ path: file.path, reason: 'Git 提交失败，保留待提交记录' })), error: error instanceof Error ? error.message : String(error) };
  }
  const previous = job[0]?.results[sourceId];
  if (previous?.committed) result = { ...result, committed: true, commit: result.commit ?? previous.commit,
    previousCommit: previous.previousCommit, files: [...new Set([...previous.files, ...(result.committed ? result.files : [])])] };
  await executeRawJsonb(engine, `UPDATE minion_jobs SET data=jsonb_set(data,'{gitResults}',
    COALESCE(data->'gitResults','{}'::jsonb) || $2::jsonb) WHERE id=$1`, [jobId], [{ [sourceId]: result }]);
  return result;
}
