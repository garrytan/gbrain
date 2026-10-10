/** `performSync`: the library entrypoint (dispatch, filesystem lock, writer lock). */
import { serr } from '../../core/console-prefix.ts';
import {
  assertSyncDispatchActive,
  resolveSyncPersistenceMode,
} from '../../core/persistence/sync-authority.ts';
import {
  hasSourceFilesystemLock,
  withSourceFilesystemLock,
  currentSourceFilesystemSignal,
  assertSourceFilesystemActive,
} from '../../core/minions/source-filesystem.ts';
import { currentJobSignal } from '../../core/minions/submission-authority.ts';
import { currentCompanyBrainSync, getCompanyBrainProfile } from '../../core/company-brain/profile.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { refreshProjectionStatistics } from '../../core/search/projection-statistics.ts';
import { withRefreshingLock, LockUnavailableError, LockStolenError, syncLockId } from '../../core/db-lock.ts';
import { readSyncAnchor } from '../../core/sync-anchor.ts';
import { recordUpstreamObservation } from '../../core/sync-upstream.ts';
import { assertSyncApplicable } from '../../core/sync-applicability.ts';
import { SyncLockBusyError, formatLockBusyMessage, buildPartialResult } from '../../core/sync-lock.ts';
import type { SyncOpts, SyncResult } from '../sync.ts';
import { runConnectorSync } from './connector.ts';
import { performSyncInner } from './incremental.ts';

export async function performSync(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  assertSyncDispatchActive();
  const inheritedSignal = currentSourceFilesystemSignal();
  if (inheritedSignal) opts = { ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, inheritedSignal]) : inheritedSignal };
  await assertSyncApplicable(engine, opts);
  const managed = await resolveSyncPersistenceMode(engine, opts);
  const finish = async (result: SyncResult, refresh = false): Promise<SyncResult> => {
    assertSyncDispatchActive();
    if (refresh && (result.pagesAffected.length > 0 || result.deleted > 0)) {
      await refreshProjectionStatistics(engine, result.pagesAffected.length + result.deleted);
    }
    if (refresh && !opts.dryRun) await recordUpstreamObservation(engine, opts.sourceId ?? 'default', opts.repoPath);
    return result;
  };
  const interruptedBeforeWork = async (): Promise<SyncResult> => {
    assertSourceFilesystemActive(true);
    const lastCommit = opts.full ? null : await readSyncAnchor(engine, opts.sourceId, 'last_commit');
    return buildPartialResult({
      fromCommit: lastCommit, toCommit: lastCommit ?? '', filesImported: 0,
      pagesAffected: [], chunksCreated: 0, added: 0, modified: 0, deleted: 0, renamed: 0,
      reason: 'timeout',
    });
  };
  const company = !opts.signal?.aborted && opts.sourceId && !currentCompanyBrainSync(opts.sourceId) && await getCompanyBrainProfile(engine, opts.sourceId);
  assertSyncDispatchActive();
  if (company) {
    if (opts.signal?.aborted) return finish(await interruptedBeforeWork());
    return (await import('../../core/company-brain/runtime.ts')).performCompanyBrainSync(engine, opts);
  }
  if (managed) {
    const connector = await runConnectorSync(engine, opts, true);
    if (connector) return connector;
  }
  if (opts.signal?.aborted) return finish(await interruptedBeforeWork());
  if (managed) {
    let result = opts.drain
      ? await (await import('../../core/persistence/sync-drain.ts')).drainManagedSync(engine, opts, true)
      : await (await import('../../core/persistence/sync-run.ts')).performManagedSync(engine, opts);
    // #6349: a delta past the cursor bound syncs in stages; a drain takes the next stage from where the last one landed
    // until it reaches HEAD (each stage freezes its own bounded manifest, and a stop resumes at the stored cursor).
    while (opts.drain && result.staged && result.drain?.outcome === 'synced' && !opts.dryRun && !opts.signal?.aborted) {
      serr(`[sync] staged catch-up: synced to ${result.staged.target.slice(0, 12)}, short of HEAD ${result.staged.head.slice(0, 12)} (the delta exceeds the cursor bound); taking the next stage.`);
      const next = await (await import('../../core/persistence/sync-drain.ts')).drainManagedSync(engine, opts, true);
      const stages = (result.staged.stages ?? 1) + 1, d = result.drain, n = next.drain;
      result = { ...next, fromCommit: result.fromCommit, added: result.added + next.added, modified: result.modified + next.modified, deleted: result.deleted + next.deleted,
        renamed: result.renamed + next.renamed, chunksCreated: result.chunksCreated + next.chunksCreated,
        ...(next.staged ? { staged: { ...next.staged, stages } } : {}),
        ...(n ? { drain: { ...n, passes: d.passes + n.passes, processed: d.processed + n.processed, written: d.written + n.written, waived: d.waived + n.waived } } : {}) };
      if (!next.staged) serr(`[sync] staged catch-up reached HEAD after ${stages} stages.`);
    }
    if (!opts.dryRun) await recordUpstreamObservation(engine, opts.sourceId ?? 'default', opts.repoPath);
    if (!opts.dryRun && ['synced', 'first_sync', 'up_to_date'].includes(result.status)) await clearSettledFailures(engine, opts.sourceId ?? 'default');
    return result;
  }
  const filesystemRoot = opts.repoPath || await readSyncAnchor(engine, opts.sourceId, 'repo_path');
  if (filesystemRoot && !hasSourceFilesystemLock(filesystemRoot)) {
    let entered = false;
    let result: SyncResult | undefined;
    try {
      return finish(await withSourceFilesystemLock(engine, filesystemRoot, async () => {
        entered = true;
        return result = await performSync(engine, opts);
      }, { signal: opts.signal }));
    } catch (err) {
      if (err instanceof LockStolenError) throw err;
      const isCallerAbort = err === opts.signal?.reason || (err instanceof Error && err.name === 'AbortError');
      if (opts.signal?.aborted && isCallerAbort && !currentJobSignal()?.aborted) {
        if (result?.status === 'partial') return finish(result);
        if (!entered) return finish(await interruptedBeforeWork());
      }
      if (err instanceof LockUnavailableError) throw new SyncLockBusyError(await formatLockBusyMessage(engine, err.lockId), err.lockId);
      throw err;
    }
  }
  // Per-source leases protect the commit/bookmark window. A caller may
  // skip this lease only when its broader scope already serializes the work.
  if (opts.skipLock) {
    return finish(await performSyncInner(engine, opts), true);
  }

  const lockKey = opts.lockId ?? syncLockId(opts.sourceId ?? 'default');

  // Renewal loss aborts the import loop and prevents a successful bookmark
  // result, including callers that did not supply their own cancellation.
  try {
    return finish(await withRefreshingLock(engine, lockKey, signal => performSyncInner(engine, {
      ...opts, signal: opts.signal ? AbortSignal.any([opts.signal, signal]) : signal,
    })), true);
  } catch (err) {
    if (err instanceof LockUnavailableError) {
      throw new SyncLockBusyError(await formatLockBusyMessage(engine, lockKey), lockKey);
    }
    throw err;
  }
}

/** #6288: a successful managed sync clears this source's recorded failures its imported commit already settles; best effort. */
async function clearSettledFailures(engine: BrainEngine, sourceId: string): Promise<void> {
  try {
    const { clearSettledManagedSyncFailures, readManagedSyncImported } = await import('../../core/persistence/sync-failures.ts');
    const imported = await readManagedSyncImported(engine, sourceId);
    if (imported) await clearSettledManagedSyncFailures(engine, imported);
  } catch { }
}
