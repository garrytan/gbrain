/**
 * `SyncRun`: the state of one incremental sync run, and the single owner of
 * its checkpoint and cleanup state (refactor wave 1, W4 sync, A17).
 *
 * The phases (`preflight`, `deletes`, `renames`, `imports`, `finalize`) share
 * this object instead of closure `let`s. Several closures interleave across
 * awaits — the checkpoint flush, the parallel import workers, the stall
 * watchdog and the partial exit — so the rule is: a mutable field is read and
 * written only as `run.<field>`. Copying one into a local (destructuring or
 * `const x = run.field`) snapshots a value another closure may change at the
 * next await. Fields tagged `@checkpoint` are written only by the functions in
 * this module. `scripts/check-sync-run-state.ts` enforces both rules over
 * `src/commands/sync/`.
 *
 * `SyncPlan` is the immutable output of preflight that the later phases read
 * through narrow `Pick<SyncPlan, ...>` inputs.
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { currentCompanyBrainSync } from '../../core/company-brain/profile.ts';
import type { SyncManifest, isSyncable } from '../../core/sync.ts';
import type { TypeWarningCount } from '../../core/schema-pack/type-usage.ts';
import { appendCompleted, appendCompletedOnce, type OpCheckpointKey } from '../../core/op-checkpoint.ts';
import { registerCleanup } from '../../core/process-cleanup.ts';
import { DB_ACCESS_MARKER_PREFIX, shouldEmitDbAccessMarker } from '../../core/pg-access-classify.ts';
import { serr } from '../../core/console-prefix.ts';
import { buildPartialResult } from '../../core/sync-lock.ts';
import type { createProgress } from '../../core/progress.ts';
import type { SyncOpts, SyncResult } from '../sync.ts';
import { resolveSyncCheckpointSeconds, resolveSyncMaxCheckpointFailures, resolveSyncYieldEvery } from './checkpoint.ts';

export type SyncActivePack = { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string>; aliases?: ReadonlyArray<string> }> };
export type SyncFailedFile = { path: string; error: string; line?: number };
export type SyncOptionsForFilter = Parameters<typeof isSyncable>[1];
export type SyncProgress = ReturnType<typeof createProgress>;

/** Immutable result of preflight: what this run drains and how. */
export interface SyncPlan {
  /** Caller options after the persisted `sync.exclude` / `sync.include_hidden` unions. */
  readonly opts: SyncOpts;
  readonly company: ReturnType<typeof currentCompanyBrainSync>;
  /** Absolute repo path (the caller's spelling, resolved). */
  readonly repoPath: string;
  /** Git repo root: every git operation runs here. */
  readonly gitContextRoot: string;
  /** Written back to sync.repo_path / sources.local_path. */
  readonly anchorPath: string;
  /** Join base for manifest paths (#4342: the scope root under 'source-root'). */
  readonly syncImportRoot: string;
  readonly syncActivePack: SyncActivePack | undefined;
  /** The bookmark this run diffs from; never advanced on a partial. */
  readonly lastCommit: string;
  readonly headCommit: string;
  /** The pinned target this run drains to (#1794). */
  readonly pin: string;
  /** #3068: the git pull failed (warn-and-continue); a zero-import run then reports partial. */
  readonly pullFailed: boolean;
  readonly ckpt: { paths: OpCheckpointKey; target: OpCheckpointKey };
  /** Paths a prior run already banked for this (lastCommit, pin). */
  readonly completedPaths: string[];
  readonly checkpointEvery: number;
  /** The raw git delta (post company rename decomposition). */
  readonly manifest: SyncManifest;
  /** The delta after scope / exclude / syncability filters (and #4342 remap). */
  readonly filtered: SyncManifest;
  readonly malformedSkipped: string[];
  readonly totalChanges: number;
  readonly uncommittedDrift: { added: number; modified: number; deleted: number } | undefined;
  readonly inScope: (p: string) => boolean;
  readonly isSelectedForRun: (path: string, options?: SyncOptionsForFilter) => boolean;
  readonly syncOpts: { strategy: SyncOpts['strategy']; includeHidden: SyncOpts['includeHidden'] };
  /** Manifest path -> the mode's canonical page path (slug/source_path base). */
  readonly modePath: (p: string) => string;
}

export interface SyncRun {
  /** The parent engine: checkpoint writes always use it, even from worker engines. */
  readonly engine: BrainEngine;
  readonly ckptPaths: OpCheckpointKey;
  readonly onProgress: SyncOpts['onProgress'];
  /** Cross-run skip set, seeded from the resume load. */
  readonly completed: Set<string>;
  /** The not-yet-flushed checkpoint delta (V4). */
  readonly pendingCheckpointPaths: Set<string>;
  readonly checkpointEvery: number;
  readonly checkpointSeconds: number;
  readonly maxFlushFailures: number;
  readonly yieldEvery: number;
  /** Pages the un-syncable-modified sweep soft-deleted before the checkpoint opened (#4786). */
  readonly swept: number;
  readonly pagesAffected: string[];
  /** #1284: slugs deleted this run; never handed to auto-embed. */
  readonly deletedSlugs: Set<string>;
  /** issue #1939: paths that imported cleanly (the gate clears their ledger rows). */
  readonly succeededPaths: string[];
  /** Every failure that gates `last_commit` (imports, deletes, renames, `<head>`). */
  readonly failedFiles: SyncFailedFile[];
  readonly typeWarningCounts: Map<string, TypeWarningCount>;
  /** @checkpoint Files flushed since the last checkpoint write (count cadence). */
  sinceFlush: number;
  /** @checkpoint Wall-clock ms of the last checkpoint flush (time cadence). */
  lastFlushAt: number;
  /** @checkpoint Consecutive failed flushes; reaching the cap kills the checkpoint. */
  consecutiveFlushFailures: number;
  /** @checkpoint Paths durably banked to the checkpoint (resumed + this run). */
  bankedFiles: number;
  /** @checkpoint Single-flight guard for the checkpoint flush. */
  flushing: boolean;
  /** @checkpoint Persistence gave up; the run stops and reports `checkpoint_unavailable`. */
  checkpointDead: boolean;
  /** @checkpoint Deregisters the SIGTERM checkpoint flush; a no-op until registered. */
  deregisterCheckpointCleanup: () => void;
  /** @checkpoint Imported files since the last event-loop yield. */
  sinceYield: number;
  /** Add/modify files persisted this run (partial `filesImported`). */
  filesImported: number;
  /** Chunks written this run. */
  chunksCreated: number;
  /** The stall watchdog fired (partial reason `stall_timeout`). */
  stallAborted: boolean;
}

/**
 * Open the run's checkpoint state. Called where the checkpoint begins (after
 * the pin is persisted), so the time cadence starts at the same instant.
 */
export function createSyncRun(
  engine: BrainEngine,
  init: { ckptPaths: OpCheckpointKey; onProgress: SyncOpts['onProgress']; completedPaths: string[]; checkpointEvery: number; swept: number },
): SyncRun {
  // v0.42.x (#1794): durable, race-safe, bankable checkpoint state.
  //  - `completed`: the cross-run skip set (seeded from the resume load).
  //  - `pendingCheckpointPaths`: the not-yet-flushed delta (V4). Workers add to
  //    BOTH. The flush single-flight-swaps pending into an in-flight batch and
  //    re-merges it on failure, so no path is "banked" before a durable write.
  //  - cadence (D): flush after the FIRST file, then every `checkpointEvery`
  //    files OR every `checkpointSeconds` seconds — bounds worst-case loss
  //    regardless of import throughput.
  //  - fail-loud (C): `maxFlushFailures` consecutive failed flushes (each
  //    already retried ~12s by withRetry) set `checkpointDead`; the loops' abort
  //    checks then exit and partial() reports `checkpoint_unavailable`. A FLAG,
  //    not a throw — importOnePath's per-file catch would swallow a throw.
  return {
    engine,
    ckptPaths: init.ckptPaths,
    onProgress: init.onProgress,
    completed: new Set<string>(init.completedPaths),
    pendingCheckpointPaths: new Set<string>(),
    checkpointEvery: init.checkpointEvery,
    checkpointSeconds: resolveSyncCheckpointSeconds(),
    maxFlushFailures: resolveSyncMaxCheckpointFailures(),
    yieldEvery: resolveSyncYieldEvery(),
    swept: init.swept,
    pagesAffected: [],
    deletedSlugs: new Set<string>(),
    succeededPaths: [],
    failedFiles: [],
    typeWarningCounts: new Map<string, TypeWarningCount>(),
    sinceFlush: 0,
    lastFlushAt: Date.now(),
    consecutiveFlushFailures: 0,
    bankedFiles: init.completedPaths.length,
    flushing: false,
    checkpointDead: false,
    // Assigned at registration (after the pinPersisted gate); called on every
    // normal return so a later operation's SIGTERM doesn't fire this stale flush.
    deregisterCheckpointCleanup: () => {},
    sinceYield: 0,
    // v0.41.13.0 (T2): tracks add+modify files actually persisted so far.
    // Only bumped from inside importOnePath's success path. partial() reports
    // this as `filesImported` so cron operators can see how much work the
    // aborted run completed before --timeout fired.
    filesImported: 0,
    chunksCreated: 0,
    stallAborted: false,
  };
}

export async function flushCheckpoint(run: SyncRun): Promise<void> {
  if (run.pendingCheckpointPaths.size === 0 || run.flushing) return;
  run.flushing = true;
  // Synchronous swap (atomic under single-threaded JS): take the current
  // pending set as this flush's batch; workers accumulate into a fresh set.
  const batch = [...run.pendingCheckpointPaths];
  run.pendingCheckpointPaths.clear();
  try {
    const ok = await appendCompleted(run.engine, run.ckptPaths, batch);
    if (ok) {
      run.consecutiveFlushFailures = 0;
      run.bankedFiles += batch.length;
      run.onProgress?.({ phase: 'import', bankedFiles: run.bankedFiles });
    } else {
      // Not durably banked — re-merge so the next flush retries this batch.
      for (const p of batch) run.pendingCheckpointPaths.add(p);
      if (++run.consecutiveFlushFailures >= run.maxFlushFailures) run.checkpointDead = true;
    }
  } finally {
    run.flushing = false;
  }
}

/**
 * v0.42.x (#1794): yield the event loop every N files so the refreshing-lock
 * heartbeat timer can fire mid-import (otherwise the CPU loop starves it and
 * the live lock gets stolen — the thrash this fixes).
 */
export async function maybeYield(run: SyncRun): Promise<void> {
  if (++run.sinceYield >= run.yieldEvery) {
    run.sinceYield = 0;
    // setTimeout(0), NOT setImmediate: the lock-refresh heartbeat is a
    // setInterval (timers phase). In Bun a tight setImmediate loop starves
    // the timers phase, so the heartbeat would never fire. setTimeout(0)
    // enters the timers phase where setInterval callbacks also run.
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

export async function markCompleted(run: SyncRun, path: string): Promise<void> {
  run.completed.add(path);
  run.pendingCheckpointPaths.add(path);
  const dueByCount = ++run.sinceFlush >= run.checkpointEvery;
  const dueByTime = Date.now() - run.lastFlushAt >= run.checkpointSeconds * 1000;
  const firstFile = run.completed.size === 1; // bank early on a fresh run
  if (dueByCount || dueByTime || firstFile) {
    run.sinceFlush = 0;
    run.lastFlushAt = Date.now();
    await flushCheckpoint(run);
  }
}

/**
 * v0.42.x (#1794): an external SIGTERM (watchdog/launcher timeout — the exact
 * incident shape) exits through process-cleanup, NOT this function's control
 * flow, so it would skip every flush and bank zero. Register a best-effort,
 * NO-RETRY one-shot flush of the unflushed delta (the registry's 3s deadline
 * is shorter than withRetry's ~12s budget, so a retrying flush would be cut
 * off). Flushes paths ONLY — never clears the checkpoint or advances
 * last_commit, so the D4 invariant holds. Deregistered on every normal return.
 */
export function registerCheckpointCleanup(run: SyncRun): void {
  run.deregisterCheckpointCleanup = registerCleanup('sync-checkpoint', async () => {
    await appendCompletedOnce(run.engine, run.ckptPaths, [...run.pendingCheckpointPaths]);
  });
}

export type PartialReason = 'timeout' | 'pull_timeout' | 'stall_timeout';

/**
 * v0.41.13.0 (T2 + D-V3-1): the partial-return path.
 * v0.42.x (#1794): now ASYNC — it banks the unflushed delta before returning
 * so a clean --timeout/SIGINT abort doesn't drop the last sub-cadence batch
 * (best-effort; skipped when checkpointDead — the pool is gone). `reason` is
 * overridden to 'checkpoint_unavailable' when the checkpoint died, and
 * `bankedFiles` is surfaced so a killed run shows banked progress instead of
 * looking like total loss. toCommit reports the PINNED target; last_commit is
 * never advanced on a partial (the next run resumes from the checkpoint).
 */
export async function partial(
  run: SyncRun,
  plan: Pick<SyncPlan, 'lastCommit' | 'pin' | 'filtered'>,
  reason: PartialReason,
): Promise<SyncResult> {
  const { lastCommit, pin, filtered } = plan;
  run.deregisterCheckpointCleanup();
  if (!run.checkpointDead) {
    try { await flushCheckpoint(run); } catch { /* best effort — we're aborting */ }
  }
  serr(
    `[sync] banked ${run.bankedFiles} file(s) this run; next 'gbrain sync' resumes from ` +
    `the checkpoint (last_commit unchanged at ${(lastCommit ?? '').slice(0, 8)}).`,
  );
  // db-availability loop (4b): a dead checkpoint IS a DB-access failure by
  // construction — the checkpoint writer only gives up after exhausting the
  // retry-matcher's connection-class retries (#1794), so `conn_dropped` is
  // asserted structurally, not parsed from an error. The marker lets the
  // bundled skills/db-repair skill pick this up from an agent-run sync.
  if (run.checkpointDead && shouldEmitDbAccessMarker()) {
    serr(`${DB_ACCESS_MARKER_PREFIX} conn_dropped`);
    serr('The sync checkpoint pool died mid-run. Run: gbrain db-repair');
  }
  return buildPartialResult({
    fromCommit: lastCommit,
    toCommit: pin,
    filesImported: run.filesImported,
    pagesAffected: [...run.pagesAffected],
    chunksCreated: run.chunksCreated,
    added: filtered.added.length,
    modified: filtered.modified.length,
    deleted: filtered.deleted.length + run.swept,
    renamed: filtered.renamed.length,
    reason: run.checkpointDead ? 'checkpoint_unavailable' : reason,
    bankedFiles: run.bankedFiles,
  });
}

/**
 * v0.42.x (#1794): the pin write IS the mint of this run's checkpoint. If it
 * can't persist, the pool is dead and nothing has drained — abort with zero
 * loss; the next run retries the whole range (content_hash short-circuits).
 */
export async function abortUnpersistedPin(run: SyncRun, plan: Pick<SyncPlan, 'lastCommit' | 'pin' | 'filtered'>): Promise<SyncResult> {
  serr('[sync] checkpoint target write failed (pool unavailable) — aborting before import; nothing drained, next run retries.');
  run.checkpointDead = true;
  return await partial(run, plan, 'timeout'); // reason → checkpoint_unavailable
}

/**
 * Alias-footgun visibility (schema.type_warnings, default on): aggregate
 * per-file type_warning results ONCE per distinct type per run — an
 * N-thousand-file sync must warn in O(distinct types) lines, not O(files).
 */
export function noteTypeWarning(
  run: SyncRun,
  w: { kind: 'alias_of' | 'undeclared'; type: string; canonical?: string; directory?: string } | undefined,
): void {
  if (!w) return;
  const key = `${w.kind}\t${w.type}`;
  const cur = run.typeWarningCounts.get(key);
  if (cur) cur.count++;
  else run.typeWarningCounts.set(key, { ...w, count: 1 });
}
