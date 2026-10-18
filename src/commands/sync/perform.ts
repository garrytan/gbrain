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
import { currentJobSignal, currentSubmissionAuthority } from '../../core/minions/submission-authority.ts';
import { currentCompanyBrainSync, getCompanyBrainProfile } from '../../core/company-brain/profile.ts';
import type { BrainEngine } from '../../core/engine.ts';
import type { OperationContext } from '../../core/ops/contract.ts';
import { refreshProjectionStatistics } from '../../core/search/projection-statistics.ts';
import { withRefreshingLock, LockUnavailableError, LockStolenError, syncLockId } from '../../core/db-lock.ts';
import { readSyncAnchor } from '../../core/sync-anchor.ts';
import { recordUpstreamObservation } from '../../core/sync-upstream.ts';
import { assertSyncApplicable } from '../../core/sync-applicability.ts';
import { noteIdentityDowngrades } from '../../core/sync-identity-downgrades.ts';
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
    return refresh && !opts.dryRun ? noteIdentityDowngrades(engine, opts.sourceId ?? 'default', result, serr) : result;
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
  if (managed) return performManagedBranch(engine, opts);
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

/**
 * The managed branch: the drain (or one pass), its staged stages and the post-sync settles, all under the source's drain
 * lease (#6712 PR 1, persistence/sync-lease.ts). A plain CLI sync follows a live holder within its budget; every other
 * caller gets `SyncLockBusyError` on a busy lease, as the classic per-source lock does.
 */
async function performManagedBranch(engine: BrainEngine, outer: SyncOpts): Promise<SyncResult> {
  const sourceId = outer.sourceId ?? 'default';
  const { withDrainLease } = await import('../../core/persistence/sync-lease.ts');
  const lockKey = syncLockId(sourceId);
  const work = async (leaseSignal: AbortSignal | undefined): Promise<SyncResult> => {
    const opts: SyncOpts = leaseSignal ? { ...outer, signal: outer.signal ? AbortSignal.any([outer.signal, leaseSignal]) : leaseSignal } : outer;
    let result = opts.drain
      ? await (await import('../../core/persistence/sync-drain.ts')).drainManagedSync(engine, opts, true)
      : await (await import('../../core/persistence/sync-run.ts')).performManagedSync(engine, opts);
    // #6349: a delta past the cursor bound syncs in stages; a drain takes the next stage from where the last one landed
    // until it reaches HEAD (each stage freezes its own bounded manifest, and a stop resumes at the stored cursor).
    const { deadlinePassed } = await import('../../core/persistence/sync-drain.ts');
    while (opts.drain && result.staged && result.drain?.outcome === 'synced' && !opts.dryRun && !opts.signal?.aborted) {
      // #6706: a caller deadline ends the catch-up between stages; the stage that landed is kept and the next run takes the next one.
      if (deadlinePassed(opts.deadlineAtMs)) { result = { ...result, drain: { ...result.drain, outcome: 'resumable', stop_reason: 'deadline' } }; break; }
      serr(result.staged.slice
        ? `[sync] sliced catch-up: committed the ${result.staged.slice.phase} slice of ${result.staged.target.slice(0, 12)} through ${result.staged.slice.after ?? '(start)'} (the target exceeds the cursor bound); taking the next slice.`
        : `[sync] staged catch-up: synced to ${result.staged.target.slice(0, 12)}, short of HEAD ${result.staged.head.slice(0, 12)} (the delta exceeds the cursor bound); taking the next stage.`);
      const next = await (await import('../../core/persistence/sync-drain.ts')).drainManagedSync(engine, opts, true);
      const stages = (result.staged.stages ?? 1) + 1, d = result.drain, n = next.drain;
      result = { ...next, fromCommit: result.fromCommit, added: result.added + next.added, modified: result.modified + next.modified, deleted: result.deleted + next.deleted,
        renamed: result.renamed + next.renamed, chunksCreated: result.chunksCreated + next.chunksCreated,
        ...(result.identityDowngrades?.length || next.identityDowngrades?.length ? { identityDowngrades: [...result.identityDowngrades ?? [], ...next.identityDowngrades ?? []] } : {}),
        ...(next.staged ? { staged: { ...next.staged, stages } } : {}),
        ...(n ? { drain: { ...n, passes: d.passes + n.passes, processed: d.processed + n.processed, written: d.written + n.written, waived: d.waived + n.waived } } : {}) };
      if (!next.staged) serr(`[sync] staged catch-up reached HEAD after ${stages} stages.`);
    }
    await printCursorAdoption(result, sourceId);
    if (!opts.dryRun) await recordUpstreamObservation(engine, opts.sourceId ?? 'default', opts.repoPath);
    if (!opts.dryRun && ['synced', 'first_sync', 'up_to_date'].includes(result.status)) await clearSettledFailures(engine, opts.sourceId ?? 'default');
    if (!opts.dryRun) {
      const replayed = await replayImportedRemembers(engine, opts.sourceId ?? 'default');
      if (replayed) result = { ...result, replayedRemembers: replayed };
      const ghosts = await reportSyncGhosts(engine, opts.sourceId ?? 'default');
      if (ghosts) result = { ...result, ghostPages: ghosts };
      // #6712 PR 2: holds that turned needs_human (or file_drift content decisions) since the last count, for the soak counters.
      await (await import('../../core/persistence/soak-counters.ts')).sweepNeedsHumanHolds(engine, opts.sourceId ?? 'default').catch(() => undefined);
    }
    return result;
  };
  // A dry run reads and previews only; it never waits for, or keeps out, a drainer.
  if (outer.dryRun) return work(undefined);
  const { withSyncTail } = await import('../../core/persistence/sync-tail.ts');
  try {
    const { healOriginTwinsAfterManagedSync } = await import('../../core/repair/origin-twins-heal.ts');
    return await healOriginTwinsAfterManagedSync(engine, outer, await (await import('../../core/repair/slug-autoheal.ts')).healAfterManagedSync(engine, outer, await withSyncTail(engine, sourceId, await withDrainLease(engine, sourceId, {
      holder: outer.drainHolder ?? { kind: 'cli', id: null }, remote: currentSubmissionAuthority()?.kind === 'remote_generic',
      ...(outer.followDrainLease ? { follow: { signal: outer.signal, deadlineAtMs: outer.deadlineAtMs } } : {}),
      tty: process.stderr.isTTY === true,
      announce: (holder, phase) => {
        const who = holder ? `a ${holder.kind} drainer (pid ${holder.pid ?? '?'} on ${holder.host ?? '?'}${holder.version ? `, gbrain ${holder.version}` : ''})` : 'another drainer';
        const done = holder?.progress ? `${holder.progress.committed} page(s) committed since it started${holder.progress.last_committed_at ? `, last at ${holder.progress.last_committed_at}` : ''}` : 'progress unknown';
        serr(phase === 'start'
          ? `[sync] source ${sourceId} is being drained by ${who}; following it until it finishes or this run's budget ends (one drainer per source; it resumes the same cursor). Ctrl-C stops following and leaves it running.`
          : `[sync] following ${who}: ${done}.`);
      },
    }, work), { signal: outer.signal, deadlineAtMs: outer.deadlineAtMs })));
  } catch (err) {
    if (err instanceof LockUnavailableError && err.lockId === lockKey) throw new SyncLockBusyError(await formatLockBusyMessage(engine, lockKey), lockKey);
    throw err;
  }
}

/**
 * #6712 PR 1: the one-line notices of a resumed cursor. A run that finished another writer's (or another option set's)
 * unfinished run names that run's own options, and a kept opt-out names the command that settles what it skipped.
 */
async function printCursorAdoption(result: SyncResult, sourceId: string): Promise<void> {
  const adopted = result.cursorAdopted;
  if (adopted?.sync_options !== undefined) {
    const { managedSyncResumeArgs } = await import('../../core/sync-reconcile.ts');
    serr(`[sync] resumed the unfinished sync run of source ${sourceId}${adopted.writer_changed ? ' that another writer started' : ''}; it finishes under its own frozen options `
      + `(gbrain sync ${managedSyncResumeArgs({ sourceId, processingOptions: adopted.processing_options, syncOptions: adopted.sync_options }).join(' ')}), and the next run uses this run's.`);
  }
  const kept = result.inherited_options ?? [];
  if (!kept.length) return;
  const flags = { noEmbed: '--no-embed', noExtract: '--no-extract', noSchemaPack: '--no-schema-pack' } as const;
  const settle = [...(kept.includes('noEmbed') ? ['gbrain embed --stale'] : []), ...(kept.includes('noExtract') ? ['gbrain extract --stale'] : [])];
  serr(`[sync] kept the unfinished run's ${kept.map(key => flags[key]).join(' ')} for the pages it imports${settle.length ? `; ${settle.join(' and ')} settle${settle.length === 1 ? 's' : ''} them afterwards` : ''}.`);
}

/**
 * #6693: after a managed sync (any outcome: a partial run can still import the file), replay the caller remembers refused while
 * their page's file awaited import or was held, whose page this run brought back in line with its file. Best effort: a failure
 * is one stderr line and never fails the sync. Returns null when nothing was examined.
 */
async function replayImportedRemembers(engine: BrainEngine, sourceId: string): Promise<SyncResult['replayedRemembers'] | null> {
  try {
    const { loadConfig } = await import('../../core/config.ts');
    const { replayImportedRemembers: replay } = await import('../../core/repair/failed-writes.ts');
    const logger = { info: () => {}, warn: (m: string) => serr(m), error: (m: string) => serr(m) };
    const report = await replay({ engine, config: loadConfig() ?? { engine: engine.kind }, logger, remote: false, dryRun: false, sourceId } as OperationContext, sourceId);
    if (!report.examined) return null;
    serr(`[sync] replayed ${report.replayed} of ${report.examined} remember(s) refused while their page's file awaited import`
      + `${report.waiting ? `; ${report.waiting} still waiting` : ''}${report.skipped ? `; ${report.skipped} not replayable (gbrain repair failed-writes --source ${sourceId} lists them)` : ''}`
      + `${report.remaining ? `; ${report.remaining} left for the next sync` : ''}.`);
    return report;
  } catch (error) {
    serr(`[sync] could not replay remembers refused while their page's file awaited import: ${error instanceof Error ? error.message : String(error)} (gbrain repair failed-writes --source ${sourceId} replays them).`);
    return null;
  }
}

/** #6712 PR 2 (L4): the source's ghost pages (live pages whose file is gone), counted and named, never deleted by sync. */
async function reportSyncGhosts(engine: BrainEngine, sourceId: string): Promise<SyncResult['ghostPages'] | null> {
  const ghosts = await (await import('../../core/persistence/sync-ghosts.ts')).countSyncGhosts(engine, sourceId).catch(() => null);
  if (ghosts) serr(`[sync] ${ghosts.count}${ghosts.truncated ? '+' : ''} live page(s) of ${sourceId} have no canonical file (ghost pages${ghosts.samples.length ? `, e.g. ${ghosts.samples.join(', ')}` : ''}); `
    + `sync leaves them in place. Preview with ${ghosts.fix.argv!.join(' ')} (read-only), or restore the files and sync.`);
  return ghosts;
}

/** #6288: a successful managed sync clears this source's recorded failures its imported commit already settles (#6543 D5: legacy ledger rows too); best effort. */
async function clearSettledFailures(engine: BrainEngine, sourceId: string): Promise<void> {
  try {
    const { clearSettledManagedSyncFailures, readManagedSyncImported } = await import('../../core/persistence/sync-failures.ts');
    const imported = await readManagedSyncImported(engine, sourceId);
    if (imported) await clearSettledManagedSyncFailures(engine, imported);
    if (imported) await (await import('../../core/persistence/legacy-sync-failures.ts')).settleLegacySyncFailures(engine, imported);
  } catch { }
}
