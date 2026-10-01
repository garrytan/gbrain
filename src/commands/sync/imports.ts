/**
 * Incremental sync import lane (refactor wave 1, W4 sync): the add/modify
 * drain, serial or across parallel worker engines, under the shared pacer and
 * the progress-aware stall watchdog.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { AbortError } from '../../core/abort-check.ts';
import { importCompanyBrainFile } from '../../core/company-brain/profile.ts';
import { loadConfig } from '../../core/config.ts';
import { serr } from '../../core/console-prefix.ts';
import { createNoopPacer, createDbPacer, observed } from '../../core/db-pacer.ts';
import type { DbPacer } from '../../core/db-pacer.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { isImageFilePath as isImageImportPath, importImageFile, importFile } from '../../core/import-file.ts';
import { resumeFilter } from '../../core/op-checkpoint.ts';
import { loadPaceModeConfig, readPaceEnv, resolvePaceMode } from '../../core/pace-mode.ts';
import { sortNewestFirst } from '../../core/sort-newest-first.ts';
import {
  autoConcurrency,
  resolveMaxConnections,
  clampWorkersForConnectionBudget,
  shouldRunParallel,
} from '../../core/sync-concurrency.ts';
import { isPathSafe } from '../../core/sync-git.ts';
import { resolveStallAbortSeconds, composeAbortSignals } from '../../core/sync-reconcile.ts';
import { sanitizePathForDisplay } from '../../core/sync.ts';
import type { SyncOpts, SyncResult } from '../sync.ts';
import { partial, markCompleted, noteTypeWarning, maybeYield } from './sync-run.ts';
import type { SyncPlan, SyncProgress, SyncRun } from './sync-run.ts';

type ImportPlan = Pick<SyncPlan, 'opts' | 'filtered' | 'lastCommit' | 'pin' | 'company' | 'gitContextRoot' | 'syncImportRoot' | 'syncActivePack'>;

type ImportContext = {
  opts: SyncOpts;
  company: SyncPlan['company'];
  gitContextRoot: string;
  syncRepoPath: string;
  syncActivePack: SyncPlan['syncActivePack'];
  noEmbed: boolean;
  pacer: DbPacer;
  progressAt: { last: number };
  progress: SyncProgress;
};

/** The add/modify drain. Returns a partial result when the run aborts. */
export async function runImportsPhase(
  run: SyncRun,
  plan: ImportPlan,
  progress: SyncProgress,
  noEmbed: boolean,
): Promise<SyncResult | undefined> {
  const { engine, completed } = run;
  const { filtered, company, gitContextRoot, syncImportRoot, syncActivePack } = plan;
  let { opts } = plan;
  // Process adds and modifies.
  //
  // NOTE: do NOT wrap this loop in engine.transaction(). importFromContent
  // already opens its own inner transaction per file, and PGLite transactions
  // are not reentrant — they acquire the same _runExclusiveTransaction mutex,
  // so a nested call from inside a user callback queues forever on the mutex
  // the outer transaction is still holding. Result: incremental sync hangs in
  // ep_poll whenever the diff crosses the old > 10 threshold that used to
  // trigger the outer wrap. Per-file atomicity is also the right granularity:
  // one file's failure should not roll back the others' successful imports.
  //
  // v0.15.2: per-file progress on stderr via the shared reporter.
  // Bug 9: per-file failures captured in `failedFiles` so the caller can
  // gate `sync.last_commit` advancement and record recoverable errors.
  // v0.41.19.0: `failedFiles` is now hoisted above the delete loop (the
  // delete decompose path appends here too); kept as a comment-pin so
  // future maintainers know to thread additional failure surfaces through
  // the same array.
  const addsAndMods = [...filtered.added, ...filtered.modified];

  // Sort newest-first so date-prefixed brain paths get embedded before older
  // ones. See src/core/sort-newest-first.ts for the policy.
  sortNewestFirst(addsAndMods);

  // v0.42.x (#1794): resume-filter the import set so a resumed run only
  // processes files it hasn't already drained. This is the convergence win —
  // a killed run banks `completed`, the next run skips it (no per-file disk
  // read or content_hash DB lookup for done files).
  const importsToDo = resumeFilter(addsAndMods, [...completed]);

  const { effectiveConcurrency, runParallel } = await resolveImportConcurrency(engine, opts, importsToDo.length);

  if (importsToDo.length > 0) {
    progress.start('sync.imports', importsToDo.length);

    // Core import logic shared by serial and parallel paths.
    // Paths from git diff are relative to gitContextRoot; under #4342's
    // 'source-root' mode the filtered manifest was remapped scope-relative,
    // so the join base moves to syncScopeRoot with it.
    const syncRepoPath = syncImportRoot;
    const pacer = await createImportPacer(engine);
    const watchdog = startStallWatchdog(run, opts);
    opts = watchdog.opts;
    const { stallTimer, progressAt } = watchdog;

    const ctx: ImportContext = { opts, company, gitContextRoot, syncRepoPath, syncActivePack, noEmbed, pacer, progressAt, progress };
    const aborted = await drainImports(run, plan, ctx, importsToDo, effectiveConcurrency, runParallel, stallTimer);
    if (aborted) return aborted;


    progress.finish();

    // v0.41.13.0 (T2): post-parallel-loop abort check. The parallel
    // workers exit via `break` inside their while loop when signal
    // aborts; Promise.all then resolves, and we land here. Without
    // this check, an aborted parallel sync would silently advance to
    // the bookmark write below. By returning partial here, we preserve
    // the D-V3-1 invariant that abort means "never advance last_commit."
    if (opts.signal?.aborted) {
      return await partial(run, plan, run.stallAborted ? 'stall_timeout' : 'timeout');
    }
  }
  return undefined;
}

/**
 * v0.22.13 (PR #490 Q5) concurrency decision, clamped under
 * GBRAIN_MAX_CONNECTIONS (#1794, 4A).
 */
async function resolveImportConcurrency(
  engine: BrainEngine,
  opts: SyncOpts,
  importCount: number,
): Promise<{ effectiveConcurrency: number; runParallel: boolean }> {
  // v0.22.13 (PR #490 Q5): one source of truth for the concurrency decision.
  // engine.kind === 'pglite' → forced 1; explicit opts.concurrency wins;
  // auto path returns DEFAULT_PARALLEL_WORKERS only when fileCount > 100.
  const explicitConcurrency = opts.concurrency !== undefined;
  let effectiveConcurrency = autoConcurrency(engine, importCount, opts.concurrency);
  // v0.42.x (#1794, 4A): clamp the worker fan-out under GBRAIN_MAX_CONNECTIONS
  // (opt-in; no-op when unset). The parent engine holds ~resolvePoolSize()
  // connections; each parallel worker opens its own pool of
  // min(2, resolvePoolSize(2)). When the budget can't fit even one extra
  // worker, the clamp returns 1 and we fall through to the serial path
  // (parent pool only). The doctor `pool_budget` nudge covers the case where
  // the parent pool alone already exceeds the budget.
  const maxConnections = resolveMaxConnections();
  if (maxConnections !== undefined && engine.kind !== 'pglite') {
    const { resolvePoolSize } = await import('../../core/db.ts');
    const parentPool = resolvePoolSize();
    const perWorkerPool = Math.min(2, resolvePoolSize(2));
    const clampResult = clampWorkersForConnectionBudget(effectiveConcurrency, {
      maxConnections,
      parentPool,
      perWorkerPool,
    });
    if (clampResult.clamped) {
      serr(
        `  [sync] GBRAIN_MAX_CONNECTIONS=${maxConnections}: clamped workers ` +
        `${effectiveConcurrency} -> ${clampResult.workers} ` +
        `(parent ${parentPool} + ${clampResult.workers}x${perWorkerPool} per-worker).`,
      );
    }
    effectiveConcurrency = clampResult.workers;
  }
  const runParallel = shouldRunParallel(effectiveConcurrency, importCount, explicitConcurrency);
  return { effectiveConcurrency, runParallel };
}

async function createImportPacer(engine: BrainEngine): Promise<DbPacer> {
  // paced-backfill (T3 / C9 / CX4): ONE shared pacer across all worker
  // engines. This is the multi-pool permit case — each parallel worker owns a
  // separate PostgresEngine, so a single worker count can't bound TOTAL
  // concurrent writes; the shared acquire() permit caps them. No-op when
  // pacing is off. Resolved env > config > bundle (env = incident escape
  // hatch); fail-open so pacing never breaks a sync.
  let pacer: DbPacer = createNoopPacer();
  try {
    const pcfg = await loadPaceModeConfig(engine);
    const { envMode, envOverrides } = readPaceEnv();
    const knobs = resolvePaceMode({
      mode: pcfg.mode,
      configOverrides: pcfg.configOverrides,
      envMode,
      envOverrides,
    });
    if (knobs.enabled) pacer = createDbPacer({ bundle: knobs });
  } catch {
    pacer = createNoopPacer();
  }
  return pacer;
}

/**
 * Starts the stall watchdog when enabled; returns the options with its abort
 * signal composed in, the interval to clear on every import-phase exit, and
 * the forward-progress stamp importOnePath bumps.
 */
function startStallWatchdog(
  run: SyncRun,
  opts: SyncOpts,
): { opts: SyncOpts; stallTimer: ReturnType<typeof setInterval> | undefined; progressAt: { last: number } } {
  // #1950: progress-aware stall watchdog for the import drain. The incident
  // was a sync wedged ~29min while ALIVE — so the lock heartbeat kept
  // refreshing (it fires on its own timer) and the wall-clock deadline hadn't
  // hit yet, leaving only a manual `pkill`. This keys off FORWARD IMPORT
  // PROGRESS (progress.tick below bumps `progressAt`), not the heartbeat: if no
  // file completes for `resolveStallAbortSeconds()`, abort. The abort signal is
  // composed into `opts.signal`, so the existing per-iteration abort checks,
  // pacer.acquire/pace, and parallel-worker break-loops all observe it; the
  // drain returns partial() (last_commit unchanged, next run resumes from the
  // checkpoint) and withRefreshingLock's finally releases the lock. Limits
  // (TODOS: #1950 follow-up — thread a cancellation signal through importFile):
  // the abort is observed BETWEEN files (the per-iteration checks + the next
  // importOnePath's pre-acquire check), so a hang INSIDE a single importFile
  // call is not interrupted until that call returns — the watchdog fires and
  // logs, but the in-flight file finishes (or the wall-clock hard deadline is
  // the eventual backstop). This catches the documented #1950 incident shape
  // (a slow-but-progressing drain, many files) and a stalled between-file
  // drain; a single wedged file or a fully starved event loop is out of scope
  // here. stallAborted distinguishes this from a user --timeout/SIGINT so the
  // partial result reports `stall_timeout`, not `timeout`.
  const stallSeconds = resolveStallAbortSeconds();
  const progressAt = { last: Date.now() };
  run.stallAborted = false;
  let stallTimer: ReturnType<typeof setInterval> | undefined;
  if (stallSeconds > 0) {
    const stallMs = stallSeconds * 1000;
    const stallController = new AbortController();
    stallTimer = setInterval(() => {
      if (Date.now() - progressAt.last >= stallMs) {
        serr(
          `[sync] no import progress for ${stallSeconds}s — aborting (stall watchdog). ` +
          `The per-source lock will release; the next 'gbrain sync' resumes from the checkpoint.`,
        );
        run.stallAborted = true;
        stallController.abort();
      }
    }, Math.min(5000, stallMs));
    // Don't keep the process alive on the watchdog alone.
    (stallTimer as unknown as { unref?: () => void }).unref?.();
    opts = { ...opts, signal: composeAbortSignals(opts.signal, stallController.signal) };
  }
  return { opts, stallTimer, progressAt };
}

/** Core import logic shared by the serial and parallel paths. */
async function importOnePath(run: SyncRun, ctx: ImportContext, eng: BrainEngine, path: string): Promise<void> {
  const { failedFiles, succeededPaths, pagesAffected, deletedSlugs } = run;
  const { opts, company, gitContextRoot, syncRepoPath, syncActivePack, noEmbed, pacer, progressAt, progress } = ctx;
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `path` is a git-diff path from the synced repo (repo content can be hostile), but the joined path is checked by isPathSafe(filePath, gitContextRoot) realpath containment below before any read
  const filePath = join(syncRepoPath, path);
  if (!company && !existsSync(filePath)) {
    // v0.42.x (#1794, Codex #3): the diff is against the PINNED target, but
    // importFile reads the live working tree. A file added in lastCommit..pin
    // that's gone from disk was deleted by a commit AFTER the pin (normal
    // forward progress from the enrich process). It genuinely doesn't exist
    // at live HEAD, so there's nothing to import — SKIP and mark it
    // completed rather than failing the run. The post-loop pin-reachability
    // gate catches a real history REWRITE (the dangerous drift); a benign
    // forward delete is handled by the next sync's pin..HEAD diff (which
    // will show this path deleted). The pre-v0.42 "record as failure" was
    // correct only when the gate compared HEAD == captured; under pinning a
    // forward delete must not block.
    await markCompleted(run, path);
    // issue #1939 adversarial finding #1: a file that previously failed to
    // parse (open ledger row) and is now gone from disk is resolved — clear
    // its row so it can't age doctor to a permanent FAIL. (This covers the
    // net-zero add-then-delete range where the path isn't in filtered.deleted.)
    succeededPaths.push(path);
    progressAt.last = Date.now(); // #1950: forward progress → reset stall watchdog
    progress.tick(1, `skip:${path}`);
    return;
  }
  // #774 NAV-1 TOCTOU: re-validate the file's realpath at import time so a
  // committed symlink pointing outside the repo (or one swapped in after
  // the scope-entry check) is never read. Recorded as a failure —
  // fail-closed: the bookmark won't advance past a symlink escape.
  if (!company && !isPathSafe(filePath, gitContextRoot)) {
    failedFiles.push({ path, error: 'path resolves outside git repo (symlink escape)' });
    progressAt.last = Date.now();
    progress.tick(1, `skip:${path}`);
    return;
  }
  // v0.41.37.0 #1569: per-file BEGIN heartbeat, emitted BEFORE importFile so a
  // hang names the stalling file (the progress.tick below only fires AFTER
  // importFile returns — useless when one file wedges). Off by default
  // (GBRAIN_SYNC_TRACE=1) to avoid a line per file on huge brains. serr is
  // source-prefix-aware, so under --workers>1 / --all the stuck file is the
  // begin-line with no matching completion in the in-flight set.
  if (process.env.GBRAIN_SYNC_TRACE) serr(`[sync] begin import: ${path}`);
  // paced-backfill: acquire a DB-write permit (caps total concurrent writes
  // across all worker engines). Throws AbortError on cancel while waiting —
  // treat as a clean skip; the worker loop sees signal.aborted next tick.
  let permit;
  try {
    permit = await pacer.acquire(opts.signal);
  } catch (e) {
    if (e instanceof AbortError) return;
    throw e;
  }
  try {
    // v0.18.0+ multi-source: thread `opts.sourceId` so per-page tx writes
    // (putPage / getTags / addTag / removeTag / deleteChunks / upsertChunks
    // / addLink) target (sourceId, slug). Pre-fix the schema DEFAULT
    // 'default' was applied even for non-default sources, fabricating
    // duplicate rows that crashed bare-slug subqueries with Postgres 21000.
    // #2683: incremental adds/modifies dispatch images to importImageFile
    // when multimodal is on (same gate as import.ts's full-sync walker).
    // Pre-fix, a committed .png went through importFile's UTF-8 text read
    // and failed — images only ever landed via `sync --full`.
    const result = await observed(pacer, () =>
      isImageImportPath(path) && process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true'
        ? importImageFile(eng, filePath, path, { noEmbed, sourceId: opts.sourceId })
        : company ? importCompanyBrainFile(eng, filePath, opts.sourceId!) : importFile(eng, filePath, path, { noEmbed, sourceId: opts.sourceId, activePack: syncActivePack }));
    noteTypeWarning(run, result.type_warning);
    if (result.status === 'imported') {
      run.chunksCreated += result.chunks;
      pagesAffected.push(result.slug);
      deletedSlugs.delete(result.slug); // #1284: deleted-then-re-added in the same run → embeddable again
      // issue #1939: record the file path (not slug) so the gate clears any
      // prior failure-ledger row — success resets the auto-skip attempt streak.
      succeededPaths.push(path);
      // v0.41.13.0 (T2): bump filesImported on every successful
      // persist. partial() reports this so cron operators see how
      // much actually landed before --timeout fired.
      run.filesImported++;
      // v0.42.x (#1794): checkpoint this path so a kill banks it.
      await markCompleted(run, path);
    } else if (result.status === 'skipped' && result.skip_reason === 'malformed_path') {
      // Informational skip (bracket/control-char filename): never a
      // failure, and stable across runs — checkpoint it as done so a
      // resumed sync doesn't re-attempt it forever.
      serr(`  Skipped (malformed filename — rename to import): ${sanitizePathForDisplay(path)}`);
      await markCompleted(run, path);
    } else if (result.status === 'skipped' && (result as any).error) {
      failedFiles.push({ path, error: String((result as any).error) });
    } else if (result.status === 'error') {
      // status 'error' (frontmatter validation, importImageFile OCR/read
      // failures) must feed the failure ledger like a thrown error — the
      // fall-through below would checkpoint the path as DONE and the file
      // would never be re-attempted.
      failedFiles.push({ path, error: String((result as any).error ?? 'import error') });
    } else {
      // status 'skipped' with no error == content_hash short-circuit
      // (already imported, unchanged). It IS done for checkpoint purposes,
      // so mark it completed (matches import-checkpoint's posture).
      await markCompleted(run, path);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    serr(`  Warning: skipped ${path}: ${msg}`);
    failedFiles.push({ path, error: msg });
  } finally {
    permit.release();
  }
  progressAt.last = Date.now(); // #1950: forward progress → reset stall watchdog
  progress.tick(1, path);
  // v0.42.x (#1794): keep the lock-refresh heartbeat alive on big imports.
  await maybeYield(run);
  // paced-backfill: cooperative DB-contention pace between files (no-op when
  // unpaced). pace() throws AbortError on cancel; the loops break on
  // signal.aborted, so swallow it here.
  try {
    await pacer.pace(opts.signal);
  } catch (e) {
    if (!(e instanceof AbortError)) throw e;
  }
}

/** Drain `importsToDo`; returns a partial result when the run aborts between files. */
async function drainImports(
  run: SyncRun,
  plan: ImportPlan,
  ctx: ImportContext,
  importsToDo: string[],
  effectiveConcurrency: number,
  runParallel: boolean,
  stallTimer: ReturnType<typeof setInterval> | undefined,
): Promise<SyncResult | undefined> {
  const { engine } = run;
  const { opts, pacer, progress } = ctx;
  const importOne = (eng: BrainEngine, path: string) => importOnePath(run, ctx, eng, path);
    try {
    if (runParallel) {
      // A1 (v0.22.13): use engine.kind discriminator instead of config?.engine
      // string compare or constructor.name sniff. Q3: belt-and-suspenders fall
      // back to serial when database_url is unset, so we never crash on a null
      // assertion if config is missing.
      const config = loadConfig();
      if (engine.kind === 'pglite' || !config?.database_url) {
        for (const path of importsToDo) {
          // v0.41.13.0 (T2 / D-V3-2): per-iteration abort check. PGLite
          // serial fallback inside the parallel branch (database_url unset).
          if (opts.signal?.aborted) {
            progress.finish();
            return await partial(run, plan, run.stallAborted ? 'stall_timeout' : 'timeout');
          }
          await importOne(engine, path);
        }
      } else {
        const { PostgresEngine } = await import('../../core/postgres-engine.ts');
        const { resolvePoolSize } = await import('../../core/db.ts');
        const workerPoolSize = Math.min(2, resolvePoolSize(2));
        const workerCount = Math.min(effectiveConcurrency, importsToDo.length);
        const databaseUrl = config.database_url;

        // Q4 (v0.22.13): banner on stderr so stdout stays clean for --json.
        serr(`  Parallel sync: ${workerCount} workers for ${importsToDo.length} files`);

        const workerEngines: InstanceType<typeof PostgresEngine>[] = [];
        try {
          // Connect workers one-by-one rather than Promise.all so a partial
          // failure leaves us with the connected ones in workerEngines for
          // the finally-block cleanup. The original code lost track of
          // already-connected engines on any one failure.
          for (let i = 0; i < workerCount; i++) {
            const eng = new PostgresEngine();
            await eng.connect({ database_url: databaseUrl, poolSize: workerPoolSize });
            workerEngines.push(eng);
          }

          // Atomic queue index — JS is single-threaded; the read-then-increment
          // happens between awaits, so no lock is needed.
          let queueIndex = 0;
          await Promise.all(
            workerEngines.map(async (eng) => {
              while (true) {
                // v0.41.13.0 (T2 / D-V3-2): per-iteration abort check.
                // Each worker exits its while loop cleanly when --timeout
                // fires. In-flight importOnePath() calls complete
                // naturally (no mid-transaction kill).
                if (opts.signal?.aborted || run.checkpointDead) break;
                const idx = queueIndex++;
                if (idx >= importsToDo.length) break;
                await importOne(eng, importsToDo[idx]);
              }
            }),
          );
        } finally {
          // A2 (v0.22.13): try/finally guarantees connection cleanup even when
          // the worker loop throws (partial connect failure, OOM, mid-import
          // signal). Each disconnect is best-effort — one worker failing to
          // disconnect must not strand the others.
          await Promise.all(
            workerEngines.map((e) =>
              e.disconnect().catch((err: unknown) =>
                serr(`  worker disconnect failed: ${err instanceof Error ? err.message : String(err)}`),
              ),
            ),
          );
        }
      }
    } else {
      // Serial path (small auto diffs or explicit --workers 1).
      for (const path of importsToDo) {
        // v0.41.13.0 (T2 / D-V3-2): per-iteration abort check at the
        // primary serial site.
        if (opts.signal?.aborted) {
          progress.finish();
          return await partial(run, plan, run.stallAborted ? 'stall_timeout' : 'timeout');
        }
        await importOne(engine, path);
      }
    }
    } finally {
      // paced-backfill: release any blocked acquirers + clear pacer state on
      // every exit path (including the early partial('timeout') returns above).
      pacer.dispose();
      // #1950: tear down the stall watchdog on every import-phase exit (normal,
      // partial('timeout'), or throw). The try wrapping the import loop guarantees
      // this runs before any post-import bookmark/anchor work.
      if (stallTimer) clearInterval(stallTimer);
    }
  return undefined;
}
