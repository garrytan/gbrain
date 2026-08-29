import { existsSync, readFileSync, writeFileSync, statSync, lstatSync, realpathSync } from 'fs';
import { join, relative, resolve as pathResolve } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { DELETE_BATCH_SIZE } from '../core/engine-constants.ts';
import { importFile, importImageFile, isImageFilePath as isImageImportPath, MAX_FILE_SIZE } from '../core/import-file.ts';
import { parseMarkdown } from '../core/markdown.ts';
import { validateSlug } from '../core/utils.ts';
import { collectSyncableFiles, shouldLogIngest } from './import.ts';
import {
  isSyncable,
  isPoisonedPath,
  sanitizePathForDisplay,
  unsyncableReason,
  matchesAnyGlob,
  resolveSlugForPath,
  isCodeFilePath,
  unacknowledgedSyncFailures,
  acknowledgeFailures,
  loadSyncFailures,
  formatCodeBreakdown, formatFailedFileList,
  applySyncFailureGate,
  isSkippablePath,
  resolveAutoSkipThreshold,
  summarizeFailuresByCode,
  isEmbeddingInfraCode,
  DEFAULT_SOURCE_ID,
  RENAME_SENTINEL_PREFIX,
  renameSentinelPath,
  renameReconcileErrorMessage,
  parseRenameReconcileFrom,
  clearFailures,
  restoreFailures,
} from '../core/sync.ts';
import {
  computeSyncDelta,
  buildDetachedWorkingTreeManifest,
} from '../core/sync-delta.ts';
import { CHUNKER_VERSION } from '../core/chunkers/code.ts';
import type { SyncManifest, SyncFailure } from '../core/sync.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { loadConfig } from '../core/config.ts';
import { DB_ACCESS_MARKER_PREFIX, shouldEmitDbAccessMarker } from '../core/pg-access-classify.ts';
import {
  autoConcurrency,
  shouldRunParallel,
  parseWorkers,
  parseDurationSeconds,
  DEFAULT_PARALLEL_SOURCES,
  resolveMaxConnections,
  clampWorkersForConnectionBudget,
} from '../core/sync-concurrency.ts';
import {
  withRefreshingLock,
  LockUnavailableError,
  syncLockId,
} from '../core/db-lock.ts';
import {
  withSourcePrefix,
  slog,
  serr,
} from '../core/console-prefix.ts';
import { loadStorageConfig, findDbOnlyCollisions } from '../core/storage-config.ts';
// #2788: collector-output vs db_only collision warning at .gitignore-write
// time. integrations.ts is side-effect-free at module load (pure recipe I/O
// helpers), so a static import is safe here.
import { getConfiguredCollectorOutputs } from './integrations.ts';
import { getDefaultSourcePath } from '../core/source-resolver.ts';
// v0.41.32.0: stamp the durable newest-COMMIT timestamp at sync time so the
// remote staleness path reads a column instead of shelling out to git.
import { newestCommitMs, commitTimeMs } from '../core/source-health.ts';
import { sortNewestFirst } from '../core/sort-newest-first.ts';
import {
  loadOpCheckpoint,
  recordCompleted,
  appendCompleted,
  appendCompletedOnce,
  clearOpCheckpoint,
  resumeFilter,
  syncFingerprint,
  type OpCheckpointKey,
} from '../core/op-checkpoint.ts';
import { registerCleanup } from '../core/process-cleanup.ts';
import { msysToNativePath } from '../core/path-confine.ts';
import { type DbPacer, createDbPacer, createNoopPacer, observed } from '../core/db-pacer.ts';
import { resolvePaceMode, loadPaceModeConfig, readPaceEnv } from '../core/pace-mode.ts';
import { AbortError } from '../core/abort-check.ts';
// Peeled sync clusters (containment sprint C13-C14) — pure moves. Each module
// below also has a re-export block at its original site in this file so
// existing importers keep working; these imports are the symbols the code
// remaining here still uses directly.
import {
  buildSingleSyncJsonEnvelope,
  formatSyncEmbedBackfillOutcome,
  resolveSingleSyncEmbedPlan,
  resolveSyncAllEmbedPlan,
  resolveSyncEmbedBackfill,
  type SyncEmbedBackfillOutcome,
} from '../core/sync-embed-backfill.ts';
import {
  git,
  gitRawOutput,
  isPathSafe,
  hasOriginRemote,
  isDetachedHead,
  unique,
  resolveSlugByPathOrSourcePath,
  resolveSlugsForRemovedPaths,
  resolveRemovedPathSlug,
  refusedRemovedPathMessage,
  createSyncBaselineCommit,
  isWithinRoot,
  resolveNoEmbed,
  discoverGitRoot,
} from '../core/sync-git.ts';
import {
  readSyncAnchor,
  isAnchorOwnedSyncPath,
  writeSyncAnchor,
  readChunkerVersion,
  writeChunkerVersion,
  resolveSlugRootMode,
  type SlugRootMode,
} from '../core/sync-anchor.ts';
import {
  SyncLockBusyError,
  formatLockBusyMessage,
  runBreakLock,
  buildPartialResult,
} from '../core/sync-lock.ts';
import {
  MASS_RECONCILE_RATIO,
  planReconcileDeletes,
  listEverCommittedPaths,
  massReconcileAllowed,
  resolveStallAbortSeconds,
  composeAbortSignals,
} from '../core/sync-reconcile.ts';

/**
 * v0.42.x (#1794) -- resumable incremental sync checkpoint.
 *
 * Two op-checkpoint rows back one resumable incremental sync, both keyed by
 * the same syncFingerprint(sourceId, lastCommit):
 *   - op 'sync'        -> completed_keys = repo-relative file paths drained
 *   - op 'sync-target' -> completed_keys = [pinnedTargetCommit]
 *
 * Splitting the pinned target into its own row keeps the path set free of any
 * sentinel that could collide with a real filename, and both rows clear
 * together on full completion. The fingerprint encodes ONLY (sourceId,
 * lastCommit) -- never the target or live HEAD -- so the checkpoint survives
 * every killed-and-resumed run while lastCommit..HEAD grows underneath it.
 */
const SYNC_CKPT_OP = 'sync';
const SYNC_TARGET_OP = 'sync-target';

function syncCheckpointKeys(
  sourceId: string | undefined,
  lastCommit: string,
): { paths: OpCheckpointKey; target: OpCheckpointKey } {
  const fp = syncFingerprint({ sourceId, lastCommit });
  return {
    paths: { op: SYNC_CKPT_OP, fingerprint: fp },
    target: { op: SYNC_TARGET_OP, fingerprint: fp },
  };
}

/**
 * Files flushed to the checkpoint per batch. Larger = fewer JSONB rewrites
 * (less write amplification on huge backlogs) at the cost of more re-done
 * import work on a kill (cheap -- content_hash short-circuits the re-import).
 */
const SYNC_CHECKPOINT_EVERY_DEFAULT = 1000;
const SYNC_CHECKPOINT_SECONDS_DEFAULT = 10;
const SYNC_MAX_CHECKPOINT_FAILURES_DEFAULT = 3;

function resolveSyncCheckpointEvery(): number {
  const raw = process.env.GBRAIN_SYNC_CHECKPOINT_EVERY;
  if (!raw) return SYNC_CHECKPOINT_EVERY_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : SYNC_CHECKPOINT_EVERY_DEFAULT;
}

/**
 * v0.42.x (#1794): time-based flush ceiling. Bank the checkpoint at least every
 * N seconds regardless of file throughput, so a kill loses at most ~N seconds of
 * import work even when `checkpointEvery` files haven't accumulated yet.
 */
function resolveSyncCheckpointSeconds(): number {
  const raw = process.env.GBRAIN_SYNC_CHECKPOINT_SECONDS;
  if (!raw) return SYNC_CHECKPOINT_SECONDS_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : SYNC_CHECKPOINT_SECONDS_DEFAULT;
}

/**
 * v0.42.x (#1794): how many consecutive checkpoint-flush failures (each already
 * retried by withRetry across the ~12s Supavisor recovery window) before the
 * sync aborts rather than burning CPU importing work it can never bank.
 */
function resolveSyncMaxCheckpointFailures(): number {
  const raw = process.env.GBRAIN_SYNC_MAX_CHECKPOINT_FAILURES;
  if (!raw) return SYNC_MAX_CHECKPOINT_FAILURES_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : SYNC_MAX_CHECKPOINT_FAILURES_DEFAULT;
}

const SYNC_YIELD_EVERY_DEFAULT = 64;

/**
 * v0.42.x (#1794): how many imported files between event-loop yields. The import
 * loop is CPU-heavy (chunking, hashing); without yielding it starves the
 * `withRefreshingLock` setInterval heartbeat, so the lock's `last_refreshed_at`
 * never bumps, its TTL lapses mid-run, and a competing launch steals the live
 * lock (the #1794 thrash). A `setImmediate` every N files lets the timer fire.
 */
function resolveSyncYieldEvery(): number {
  const raw = process.env.GBRAIN_SYNC_YIELD_EVERY;
  if (!raw) return SYNC_YIELD_EVERY_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : SYNC_YIELD_EVERY_DEFAULT;
}

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

export interface SyncResult {
  status: 'up_to_date' | 'synced' | 'first_sync' | 'dry_run' | 'blocked_by_failures' | 'partial';
  fromCommit: string | null;
  toCommit: string;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  chunksCreated: number;
  /** Pages re-embedded during this sync's auto-embed step. 0 if --no-embed or skipped. */
  embedded: number;
  embedDeferralReason?: 'large_sync';
  pagesAffected: string[];
  failedFiles?: number; // count of parse failures (Bug 9)
  /**
   * #3875: code breakdown of the blocking failures (set on
   * `blocked_by_failures` only). Lets printSyncResult (and --json consumers)
   * distinguish provider-infra failures (EMBEDDING_TIMEOUT / RATE_LIMIT /
   * QUOTA — retry after fixing the provider) from genuine file poison
   * (--skip-failed territory).
   */
  failureCodes?: Array<{ code: string; count: number }>;
  /**
   * Files skipped because their FILENAME contains bracket/control characters
   * (SyncableReason 'malformed-path'). Informational — these never gate
   * bookmark advancement; rename the files to import them.
   */
  malformedSkipped?: number;
  /**
   * Aggregated alias/undeclared explicit-type warnings (schema.type_warnings,
   * default on) — one entry per distinct non-canonical type this run.
   * Carried on the RESULT (not just stderr) so worker-driven syncs surface it
   * in job results where daemon stderr is invisible.
   */
  type_warnings?: Array<{ kind: 'alias_of' | 'undeclared'; type: string; canonical?: string; directory?: string; count: number }>;
  /**
   * Working-tree files invisible to commit-driven sync (attached HEAD without
   * --working-tree): untracked/added, modified, and deleted counts AFTER the
   * same scope/exclude/isSyncable filters imports use. Uncommitted renames are
   * decomposed as add(new path) + delete(old path). Absent when zero, or when
   * the working tree was imported (detached HEAD or --working-tree).
   */
  uncommitted?: { added: number; modified: number; deleted: number };
  /**
   * v0.41.13.0 partial-sync fields (only set when status === 'partial').
   *
   * D-V3-1 (honest scope): --timeout aborts ONLY in pre-bookmark phases
   * (pull, delete, rename, import). Extract + embed run to completion if
   * reached. By construction, partial fires BEFORE the bookmark write at
   * sync.ts:1261 so last_commit is never advanced on partial — the D4
   * invariant is enforced by checkpoint-topology, not by post-write
   * rollback.
   *
   * `files_imported` reflects ACTUAL persisted count (not the
   * not-yet-attempted set). `reason` distinguishes the partial cause so
   * cron operators can disambiguate timeout vs pull-timeout in monitoring.
   */
  filesImported?: number;
  reason?: 'timeout' | 'pull_timeout' | 'pull_failed' | 'stall_timeout' | 'checkpoint_unavailable';
  /**
   * v0.42.x (#1794): cumulative file paths durably banked to the checkpoint
   * across THIS run + prior resumed runs. Surfaced on every partial/blocked
   * exit so an operator who kills a sync can see progress was banked — instead
   * of reading only `last_commit` (unchanged by design) and concluding "lost
   * everything," the exact misdiagnosis in the #1794 recurrence report.
   */
  bankedFiles?: number;
}

// The cost-gate / token-estimate cluster (estimateSourceTreeTokens,
// estimateInlineNewTokens, runInlineCostGate, ...) was peeled to
// src/core/sync-cost-gate.ts (pure move). Re-exported so existing importers
// keep working.
export {
  estimateSourceTreeTokens,
  estimateInlineNewTokens,
  type EstimateKind,
  type InlineEstimate,
} from '../core/sync-cost-gate.ts';

export interface SyncOpts {
  repoPath?: string;
  dryRun?: boolean;
  full?: boolean;
  noPull?: boolean;
  noEmbed?: boolean;
  noExtract?: boolean;
  /**
   * #3969: opt back into per-poll ingest_log rows. By default a sync that
   * landed nothing (no pages written, no chunks, no failures acknowledged)
   * skips the ingest_log write — mirrors runImport's shouldLogIngest gate.
   */
  logNoop?: boolean;
  /** Bug 9 — acknowledge + skip past current failure set (CLI --skip-failed). */
  skipFailed?: boolean;
  /** Bug 9 — re-attempt unacknowledged failures explicitly (CLI --retry-failed). */
  retryFailed?: boolean;
  /**
   * v0.41.37.0 #1569 — skip loading the active schema pack during sync. When set,
   * `loadActivePack` is not called, so no user-supplied pack page-type regex
   * (markdown.ts subtype path_pattern) runs during import. Pages fall back to
   * legacy prefix typing. Escape hatch for completing a sync when a suspect
   * pack regex is the suspected cause of a wedge; re-run extraction later.
   * Threaded through performSync AND syncOneSource so `sync --all` honors it.
   */
  noSchemaPack?: boolean;
  /**
   * v0.18.0 Step 5 — sync a specific named source. When set, sync reads
   * local_path + last_commit from the sources table (not the global
   * config.sync.* keys) and writes last_commit + last_sync_at back to
   * the same row. Backward compat: when undefined, sync uses the
   * pre-v0.17 global-config path unchanged.
   */
  sourceId?: string;
  /**
   * github source kind: refresh exactly one item (webhook path).
   * When set, sync skips the sweep and re-fetches this single issue/PR.
   */
  githubItem?: { repo: string; number: number; kind: 'issue' | 'pr'; deleted?: boolean };
  /** Multi-repo: sync strategy override (markdown, code, auto). */
  strategy?: 'markdown' | 'code' | 'auto';
  /**
   * #753/#774 — sync only files under this subdirectory of the git repo.
   * Git operations (pull, diff, rev-parse) still run against the repo root
   * (discovered via `git rev-parse --show-toplevel`); file walking, imports,
   * deletes and renames are scoped to the subpath. Slugs are git-root-relative
   * (`wiki/page1.md` → slug `wiki/page1`) so full and incremental syncs of
   * the same scope agree. Enables N logical sources in one git repo.
   *
   * SECURITY (NAV-1/NAV-2): the resolved subpath must realpath-resolve inside
   * the git root — `../escape` and symlinked subdirs pointing outside the repo
   * are rejected before any git op runs.
   */
  srcSubpath?: string;
  /**
   * #753/#774 — glob patterns for files to exclude from sync (repeatable
   * `--exclude` on the CLI). Matched against the scope-relative path in both
   * the full-sync and incremental paths. Excluded files are never imported;
   * exclusion does NOT delete previously-imported pages (conservative,
   * matching the #1433 metafile posture).
   *
   * Unioned with the persisted `sync.exclude` config key (comma- or
   * newline-separated; a trailing `/` is normalized to a `/**` subtree glob),
   * so callers that never touch the CLI — autopilot, minion sync jobs, the
   * dream cycle — inherit the same indexing scope. Union, not override: an
   * ad-hoc flag narrows further but never silently re-opens a scope the
   * operator persisted. Best-effort read, as with `sync.include_working_tree`.
   */
  exclude?: string[];
  /**
   * Repeatable `--include-hidden <glob>` on the CLI — same glob dialect as
   * `exclude`, but waives the leading-dot part of `pruneDir`'s exclusion
   * (`.git`, `.obsidian`, and any other dot-prefixed directory) for paths
   * that match, instead of removing paths. See `isPathPruned` in
   * core/sync.ts for exactly what is and isn't waivable, and its doc
   * comment for the one gap (non-git directory imports via the FS-walk
   * fallback aren't covered). Unlike `exclude`, this has to reach the
   * collection step itself — a pruned path is never collected in the first
   * place, so there's nothing for a post-collection filter to add back.
   */
  includeHidden?: string[];
  /**
   * Include files matched by .gitignore. Git cannot report untracked ignored
   * changes in diffs, so sync uses the full filesystem walker when this is set.
   */
  includeGitignored?: boolean;
  /**
   * Import uncommitted working-tree state (untracked files + uncommitted
   * tracked edits/deletes) on an ATTACHED HEAD, via the same manifest-merge
   * path detached-HEAD syncs have always used. Off by default: commit-driven
   * sync stays the contract, and uncommitted drift is counted + reported
   * either way (see SyncResult.uncommitted). CLI `--working-tree`; persist
   * with config `sync.include_working_tree=true`. NOTE: the inline cost
   * estimator does not price working-tree files on attached repos, so the
   * gate can underestimate an explicit --working-tree run.
   */
  workingTree?: boolean;
  /**
   * Number of parallel workers for the import phase. When > 1, each worker
   * gets its own small Postgres connection pool and files are dispatched via
   * an atomic queue index (same pattern as `import --workers N`).
   *
   * Deletes and renames remain serial (order-dependent).
   * Default: undefined → auto-concurrency picks (`src/core/sync-concurrency.ts`).
   *
   * v0.22.13 (PR #490 Q1): when this is explicitly set, the >50-file floor
   * is bypassed — explicit user intent beats the auto-path safety net.
   */
  concurrency?: number;
  /**
   * Internal: skip acquiring the gbrain-sync DB lock. Set by the cycle
   * handler (cycle.ts) which already holds gbrain-cycle and therefore
   * already serializes against other cycle runs. CLI sync, jobs handler,
   * and any external caller leave this undefined so they take the lock.
   *
   * v0.22.13 (PR #490 CODEX-2). Not part of the public CLI surface.
   */
  skipLock?: boolean;
  /**
   * Internal: override the DB lock id taken around the writer window.
   * Not part of the public CLI surface — explicit escape hatch for
   * callers that already know which lock id they want.
   *
   * Defaults to:
   *   - `gbrain-sync:<sourceId>` when `opts.sourceId` is set
   *     (multi-source / federated brains; the per-source invariant)
   *   - `gbrain-sync` (the legacy global lock) when `sourceId` is unset
   *     (single-default-source brains; preserves bit-for-bit behavior
   *      for installs that never set up multiple sources)
   *
   * Why source-id keyed by default (v0.40.3.0):
   *   PR #1314 originally only changed the lock id inside the parallel
   *   `sync --all` fan-out. That introduced a worse race than the global
   *   lock fixes — `gbrain sync --all` (per-source lock) running
   *   concurrently with `gbrain sync --source foo` (global lock) would
   *   both write source foo simultaneously. The fix: every source-scoped
   *   sync (CLI, --all fan-out, cycle, jobs handler) defaults to the
   *   per-source lock. Same source = same lock id, always.
   *
   * For the per-source path, `performSync` ALSO switches from bare
   * `tryAcquireDbLock` to `withRefreshingLock` so long-running sources
   * (the PR's whole motivation — media-corpus, 250K+ chunks) don't lose
   * their lock at the 30-minute TTL mid-run. The legacy global-lock
   * path keeps bare `tryAcquireDbLock` for back-compat (no caller
   * depends on the global lock surviving past 30 minutes today).
   *
   * Total live Postgres connections per parallel `sync --all` wave:
   *   parallel  ×  workers  ×  2 (per-file pool inside each worker)
   *   + parent pool. See DEFAULT_PARALLEL_SOURCES in sync-concurrency.ts.
   */
  lockId?: string;
  /**
   * v0.41.13.0 — graceful self-termination signal (PR closing #1472).
   *
   * When set, performSyncInner checks `signal.aborted` at the top of every
   * pre-bookmark iteration (pull, delete loop, rename loop, serial import
   * loop, parallel worker while loop). On abort the function returns
   * `SyncResult { status: 'partial', filesImported, reason: 'timeout' }`,
   * releases the lock cleanly, and the CLI exits 0 so cron doesn't
   * classify the run as failure.
   *
   * D-V3-1 (honest scope): abort checks fire ONLY in pre-bookmark phases.
   * The `last_commit` bookmark writes at sync.ts:1261 BEFORE extract +
   * embed phases run; checking after that line would advance the bookmark
   * for a partial sync. By construction, partial fires before the write,
   * so the D4 invariant "never advance last_commit on partial" is
   * enforced by topology, not by post-write rollback.
   *
   * D-V3-3 (per-source budgets for --all): the CLI's --timeout --all path
   * creates ONE AbortController per source inside `runOne` (sync.ts:1823)
   * so each source gets its own --timeout countdown starting when its
   * runOne invocation starts. NOT a shared global controller.
   *
   * Precedent: CycleOpts.signal at src/core/cycle.ts (v0.22.1 #403).
   */
  signal?: AbortSignal;
  /**
   * Serve-delegated sync progress seam: fired at phase boundaries and on every
   * durable checkpoint flush (cumulative bankedFiles). Sync-fire, never
   * awaited — the delegated-job runner mirrors these into the record that
   * `sync_status` IPC polls read. Absent for direct CLI runs (stderr
   * breadcrumbs already cover that surface).
   */
  onProgress?: (p: { phase: string; bankedFiles?: number }) => void;
}

// The git-plumbing cluster (git(), discoverGitRoot, createSyncBaselineCommit,
// path-containment guards, ...) was peeled to src/core/sync-git.ts (pure
// move). Re-exported so existing importers keep working.
export {
  resolveSlugByPathOrSourcePath,
  buildGitInvocation,
  buildAutoEmbedArgs,
  resolveNoEmbed,
  discoverGitRoot,
  classifyHeadProbeError,
  createSyncBaselineCommit,
  isWithinRoot,
} from '../core/sync-git.ts';

// The anchor / chunker-version cluster (readSyncAnchor, writeSyncAnchor,
// readChunkerVersion, ...) was peeled to src/core/sync-anchor.ts (pure move).
export { writeSyncAnchor } from '../core/sync-anchor.ts';

/**
 * v0.40 Federated Sync v2: `gbrain sync trigger --source <id> [--priority high|normal|low]`
 *
 * Push-trigger entry point. Wraps `queue.add('sync', ...)` with priority -10
 * (above autopilot's 0) so push-triggered syncs preempt scheduled ones.
 * Use cases: GitHub webhook handler (POST /webhooks/github), CLI nudge after
 * a manual git pull, scripted dispatch from `gbrain sources federate`.
 *
 * Sets `auto_embed_backfill: true` so the extended sync handler (T6/T7)
 * auto-enqueues an embed-backfill job after the sync settles.
 *
 * Output: prints `job_id=N` to stdout for shell composition. Errors exit 1.
 */
export async function runSyncTrigger(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain sync trigger --source <id> [--priority high|normal|low]

Queue a push-triggered sync job for one source. Prints the resulting job id
on stdout. The autopilot worker picks it up and runs performSync against the
named source; if the sync added/modified pages, an embed-backfill job is
auto-enqueued (subject to D6 budget cap + D19 source-level cooldown).

Use cases:
  - GitHub webhook → 'gbrain sync trigger --source <repo>'
  - Manual nudge after 'git pull' inside a federated source
  - Programmatic triggers from CI / shell automation

See also:
  gbrain sources webhook set <id>   Set up GitHub-signed push webhook
  gbrain sources status             Per-source sync + embed coverage
`);
    return;
  }

  const sourceIdArg = args.find((a, i) => args[i - 1] === '--source') ?? null;
  if (!sourceIdArg) {
    console.error('Error: --source <id> is required');
    console.error("Usage: gbrain sync trigger --source <id> [--priority high|normal|low]");
    process.exit(2);
  }

  const priorityArg = args.find((a, i) => args[i - 1] === '--priority') ?? 'high';
  const priorityMap: Record<string, number> = { high: -10, normal: 0, low: 5 };
  const priority = priorityMap[priorityArg];
  if (priority === undefined) {
    console.error(`Invalid --priority value: "${priorityArg}". Must be high|normal|low.`);
    process.exit(2);
  }

  // Verify source exists before submitting
  const { fetchSource } = await import('../core/sources-load.ts');
  const source = await fetchSource(engine, sourceIdArg);
  if (!source) {
    console.error(`Source "${sourceIdArg}" not found. List with: gbrain sources list`);
    process.exit(1);
  }

  const { MinionQueue } = await import('../core/minions/queue.ts');
  const queue = new MinionQueue(engine);
  const job = await queue.add(
    'sync',
    {
      sourceId: sourceIdArg,
      repoPath: source.local_path,
      noExtract: false,
      auto_embed_backfill: true,
      embed_reason: 'sync_trigger',
    },
    {
      priority,
      idempotency_key: `sync-trigger:${sourceIdArg}:${Math.floor(Date.now() / 30_000)}`,
      maxWaiting: 1,
    },
  );

  console.log(`job_id=${job.id}`);
}

// The lock layer minus performSync (SyncLockBusyError, formatLockBusyMessage,
// runBreakLock, buildPartialResult) was peeled to src/core/sync-lock.ts
// (pure move). Re-exported so existing importers keep working.
export { SyncLockBusyError, runBreakLock } from '../core/sync-lock.ts';

export async function performSync(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  // v0.22.13 CODEX-2: cross-process writer lock prevents two concurrent
  // syncs from racing on the same last_commit anchor (last writer wins,
  // bookmark regresses, silent corruption).
  //
  // v0.40.5.0: per-source DB lock via `syncLockId(sourceId)`. Two sources
  // (default + zion-brain) take distinct lock rows and don't serialize.
  // SYNC_LOCK_ID is now a back-compat alias for syncLockId('default').
  //
  // v0.40.6.0 (D11 from PR #1314 review): pair the per-source lock with
  // `withRefreshingLock` so long-running sources (media-corpus, 250K+
  // chunks) don't lose their lock at the 30-minute TTL mid-run. Closes
  // the bug class where a >30min sync could let a parallel acquire steal
  // the lock and race on the final commit + bookmark write.
  //
  // skipLock is reserved for callers that already serialize via another
  // mechanism (e.g. cycle.ts holds gbrain-cycle for the broader scope).
  if (opts.skipLock) {
    return await performSyncInner(engine, opts);
  }

  const lockKey = opts.lockId ?? syncLockId(opts.sourceId ?? 'default');

  // v0.42.x (#1794): ALL non-skipLock syncs use the TTL-refreshing lock — the
  // bare `gbrain sync` path (no --source/--lockId) included. The pre-v0.42 code
  // gave that path a NON-refreshing tryAcquireDbLock, so a long hand-run sync
  // (exactly what you'd run during an incident on the 204K brain) could have its
  // lock TTL lapse and be stolen mid-run. withRefreshingLock keeps the heartbeat
  // alive (the import loop's event-loop yields ensure the timer fires), and the
  // heartbeat-aware takeover refuses to steal a live, refreshing holder.
  try {
    return await withRefreshingLock(engine, lockKey, () => performSyncInner(engine, opts));
  } catch (err) {
    if (err instanceof LockUnavailableError) {
      throw new SyncLockBusyError(await formatLockBusyMessage(engine, lockKey), lockKey);
    }
    throw err;
  }
}


/**
 * Source-scoped ACTIVE slugs for the given source_paths, considering EVERY
 * matching row. `source_path` has only a non-unique index and
 * `resolveSlugsByPaths` collapses to one arbitrary row per path — through
 * that collapse a soft-deleted row could mask a live duplicate sharing the
 * same path (#3479 review), so the rename-reconcile paths query all rows
 * with an explicit `deleted_at IS NULL` instead.
 */
async function activeSlugsBySourcePath(
  engine: BrainEngine,
  paths: string[],
  sourceId: string,
  signal?: AbortSignal,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < paths.length; i += DELETE_BATCH_SIZE) {
    // gate 17 (timeout responsiveness): a large rename manifest runs many
    // batches; stop between them once aborted. The partial map is safe for
    // both consumers — the rename loop's own per-iteration check returns
    // `partial` before consuming it, and a smaller map only ever degrades
    // toward skipping cheap renames, never toward moving a guessed row.
    if (signal?.aborted) break;
    const batch = paths.slice(i, i + DELETE_BATCH_SIZE);
    const rows = await engine.executeRaw<{ slug: string; source_path: string }>(
      `SELECT slug, source_path FROM pages
        WHERE source_path = ANY($1::text[]) AND source_id = $2 AND deleted_at IS NULL`,
      [batch, sourceId],
    );
    for (const r of rows) {
      const arr = out.get(r.source_path);
      if (arr) arr.push(r.slug);
      else out.set(r.source_path, [r.slug]);
    }
  }
  return out;
}

/**
 * #3583 review (data-loss blocker): every tracked working-tree file, indexed
 * by the slug it derives to. `updateSlug` never rewrites `source_path` and an
 * unchanged-content re-import is a no-write skip, so after an ordinary cheap
 * rename the LIVE row still carries its OLD path — `source_path = from`
 * therefore matches live pages, not just stale ones. A reconcile candidate is
 * only genuinely stale when NO tracked file derives to its CURRENT slug.
 *
 * Derivation mirrors the import path exactly, in both of its regimes:
 *   - Ordinary paths: resolveSlugForPath. Import's anti-spoof check rejects
 *     any frontmatter slug that disagrees with the path-derived one, so for
 *     these files the path IS the slug authority (case folding and spaces
 *     included — a naive `slug + '.md'` inversion would misclassify those).
 *   - CJK-wave frontmatter fallback (#598): a markdown file whose path
 *     derives NO slug (emoji / exotic-script filename) imports under its
 *     frontmatter `slug:` — resolveSlugForPath cannot see that slug, so
 *     resolve it the way import does end to end: parseMarkdown on the
 *     content (working tree first, git index blob when the working-tree
 *     copy is absent, e.g. a sparse checkout), then the same validateSlug
 *     chokepoint importFromContent runs (which lowercases). Every non-code
 *     file with an empty derived slug is a candidate — importFromFile has
 *     no extension gate; see fallbackSlugsForFile.
 *
 * `complete` goes false when some fallback-regime file's content could not
 * be read at all: its true slug is then unknowable, so absence from the
 * index no longer PROVES staleness — callers must treat an index miss as
 * unknown and spare the row, never delete on it. That same fail-safe
 * absorbs the awkward index states: an unmerged path (no stage-0 blob →
 * cat-file throws) and an undecodable filename (utf-8 replacement mangles
 * the name → both reads miss) both land on `complete = false`, not on a
 * delete. Deliberately BROADER than the sync scope: every working-tree file
 * counts (submodule interiors never appear — ls-files lists the gitlink
 * only, and the walker never imports them — and scope/exclude-filtered
 * files still register). Over-inclusion can only delay a cleanup, never
 * delete a live page.
 *
 * Post-review fix: the listing MUST match `collectSyncableFiles`' git-aware
 * fast path (`git ls-files --cached --others --exclude-standard`, tracked
 * PLUS untracked-not-ignored — see `gitListSyncableFiles` in import.ts), not
 * a bare `git ls-files` (tracked only). A file added to the working tree but
 * not yet `git add`-ed still gets imported by `collectSyncableFiles`, so a
 * plain tracked-only listing here would treat its slug as absent from the
 * index and reconcile could hard-delete the LIVE page that import just
 * created. `--exclude-standard` keeps `.gitignore`d files out of the index
 * exactly as it keeps them out of import, so the two enumerations stay in
 * lockstep.
 *
 * Built at most once per sync run, and only when a fallback rename actually
 * has reconcile candidates. Throws on git ls-files failure: the caller's
 * catch records the `<rename:…>` sentinel (fail-closed) instead of guessing.
 */
interface TrackedSlugIndex {
  /**
   * The slugs some tracked file derives to. A SET, not a slug -> paths map:
   * liveness only ever asks "does any file still derive to this slug"
   * (`has`), so the paths were accurate but unread — state a later reader
   * would have had to re-derive the purpose of.
   */
  slugs: Set<string>;
  complete: boolean;
}

function trackedSlugIndex(gitContextRoot: string, anchorCommit?: string): TrackedSlugIndex {
  const slugs = new Set<string>();
  let complete = true;
  const addSlug = (slug: string): void => { slugs.add(slug); };
  // --cached --others --exclude-standard mirrors gitListSyncableFiles (see
  // docstring above): tracked-only would miss an unstaged new file that
  // collectSyncableFiles already imported, misclassifying its live page as
  // stale.
  const listing = gitRawOutput(gitContextRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  for (const rel of listing.split('\u0000')) {
    if (!rel) continue;
    const slug = resolveSlugForPath(rel);
    addSlug(slug);
    // Fallback-regime candidates are every non-code file whose path derives
    // no slug. NOT just `.md`/`.mdx`: importFromFile has no extension gate —
    // an extensionless emoji-named file imports under its frontmatter slug
    // all the same, so skipping it here deleted its live row. Reads are
    // bounded by the size gates inside fallbackSlugsForFile, so a multi-GB
    // punctuation-named artifact costs one lstat, never a read.
    if (slug === '' && !isCodeFilePath(rel)) {
      try {
        const fallback = fallbackSlugsForFile(gitContextRoot, rel);
        for (const fmSlug of fallback.slugs) addSlug(fmSlug);
        if (!fallback.proofIntact) {
          complete = false;
          serr(
            `  [sync] rename reconcile: could not fully resolve the slug of ` +
            `tracked file ${rel} (unreadable, unmerged, or over the import ` +
            `size gate); staleness is unprovable this run, so reconcile will ` +
            `not delete any row missing from the index.`,
          );
        }
      } catch {
        complete = false;
        serr(
          `  [sync] rename reconcile: could not resolve the slug of tracked ` +
          `file ${rel}; staleness is unprovable this run, so reconcile will ` +
          `not delete any row missing from the index.`,
        );
      }
    }
  }
  // The anchor commit (`last_commit`, what the brain actually reflects) is
  // enumerated as ITS OWN tree, not looked up through current paths: a
  // commit that RENAMES a fallback-regime file (and drops its slug) leaves
  // the anchor's content at the OLD path, which no current-path lookup can
  // reach — the anchor-imported row was deleted while the index still
  // claimed to be complete. Registration is purely spare-side (extra
  // liveness can only delay a cleanup), so enumerating the whole anchor
  // tree is safe; reads stay bounded by the same size gates and only fire
  // for fallback-regime paths.
  if (anchorCommit && anchorCommit !== 'HEAD') {
    try {
      const epochs = attributeEpochCommits(gitContextRoot, anchorCommit);
      const historicalFilter = epochs === null || anyFilterAtAttributeEpochs(gitContextRoot, epochs);
      const anchorListing = gitRawOutput(gitContextRoot, ['ls-tree', '-r', '-z', '--name-only', anchorCommit]);
      for (const rel of anchorListing.split('\u0000')) {
        if (!rel) continue;
        if (resolveSlugForPath(rel) !== '' || isCodeFilePath(rel)) continue;
        const res = anchorBlobSlugs(gitContextRoot, anchorCommit, rel, historicalFilter);
        for (const s of res.slugs) addSlug(s);
        if (!res.proofIntact) {
          complete = false;
          serr(
            `  [sync] rename reconcile: could not resolve the slug of ${rel} at ` +
            `the sync anchor; staleness is unprovable this run, so reconcile ` +
            `will not delete any row missing from the index.`,
          );
        }
      }
    } catch {
      complete = false;
      serr(
        `  [sync] rename reconcile: could not enumerate the sync anchor tree; ` +
        `staleness is unprovable this run, so reconcile will not delete any ` +
        `row missing from the index.`,
      );
    }
  }
  return { slugs, complete };
}

/**
 * The frontmatter-slug shapes a content state can own a row under: the
 * validateSlug chokepoint importFromContent runs (lowercases), or — when
 * the current chokepoint REJECTS the slug — both raw casings, since a
 * legacy row imported under older validation rules may still carry it
 * (purely spare-side registration).
 */
function frontmatterSlugShapes(content: string, rel: string): string[] {
  const fmSlug = parseMarkdown(content, rel).slug;
  if (!fmSlug) return [];
  try {
    return [validateSlug(fmSlug)];
  } catch {
    return [fmSlug, fmSlug.toLowerCase()];
  }
}

/**
 * Size-gated read + slug extraction of one anchor-tree blob. When a
 * content filter is in effect for the path under TODAY's attributes, or
 * ANY reachable attribute epoch assigns a filter to ANYTHING
 * (`historicalFilter`, computed once per index build), the read still
 * registers what it can (spare-side) but the proof is NOT intact:
 * `cat-file --filters` reconstructs the historical blob with TODAY's
 * filter definitions, and the row's content was imported under whatever
 * filter was active — at ITS import-time anchor, under ITS path AT THAT
 * TIME. The historical side is deliberately repo-wide rather than
 * per-path: the file can have been RENAMED since the import, so its
 * import-time filter was keyed to a path no current tree names, and a
 * per-path history walk would put git's rename-detection heuristics on
 * the DELETE side of the proof. `!filter` resets, entries deleted
 * outright, and interval-only filters all land on the spare side. The
 * remaining residual is an UNVERSIONED attribute source
 * (info/attributes, core.attributesFile) whose filter entry was removed
 * since the import, or an import-time state force-pushed out of the
 * reachable history — invisible to every git surface.
 */
function anchorBlobSlugs(
  gitContextRoot: string,
  anchorCommit: string,
  rel: string,
  historicalFilter: boolean,
): { slugs: string[]; proofIntact: boolean } {
  try {
    const filtered = historicalFilter || pathHasContentFilter(gitContextRoot, rel);
    const size = Number(git(gitContextRoot, ['cat-file', '-s', `${anchorCommit}:${rel}`]));
    if (Number.isFinite(size) && size > MAX_FILE_SIZE) return { slugs: [], proofIntact: false };
    // BOTH the raw blob and the filter-converted view register (union,
    // spare-side): a smudge filter that STRIPS the slug line hides it from
    // the converted view while the raw blob still carries it. The
    // injection direction (a drifted smudge that ADDED the slug at import
    // time) is invisible to every git surface — that is what the
    // filter-presence proof downgrade below is for.
    const slugs = new Set<string>();
    const raw = git(gitContextRoot, ['cat-file', 'blob', `${anchorCommit}:${rel}`]);
    if (raw.length > MAX_FILE_SIZE) return { slugs: [], proofIntact: false };
    for (const s of frontmatterSlugShapes(raw, rel)) slugs.add(s);
    const converted = git(gitContextRoot, ['cat-file', '--filters', `${anchorCommit}:${rel}`]);
    if (converted.length <= MAX_FILE_SIZE) {
      for (const s of frontmatterSlugShapes(converted, rel)) slugs.add(s);
    }
    return { slugs: [...slugs], proofIntact: !filtered };
  } catch {
    return { slugs: [], proofIntact: false };
  }
}

/**
 * Every reachable commit that CHANGED an attributes file (root or nested
 * .gitattributes), walked from BOTH the current HEAD and the anchor (a
 * blocked past sync can have imported at a commit ahead of the anchor;
 * multiple start points cover both ancestries even after a force-push
 * moved one aside). The attribute state at any past import-time anchor is
 * the state at its nearest attribute-epoch ancestor, so checking the
 * filter attribute at every epoch covers every historical state a live
 * row can have been imported under. The anchor itself is appended so the
 * check never depends on the epoch enumeration being exhaustive for it.
 * Returns null when the enumeration fails — the caller downgrades every
 * anchor proof (spare-side).
 */
function attributeEpochCommits(gitContextRoot: string, anchorCommit: string): string[] | null {
  try {
    // A shallow clone's history is truncated: an import-time filter epoch
    // can sit below the shallow boundary where no enumeration reaches it.
    // Unprovable, not absent.
    if (git(gitContextRoot, ['rev-parse', '--is-shallow-repository']) === 'true') return null;
    // --full-history: the default path-simplified walk prunes a side line
    // whose attribute change was discarded at a merge (`-s ours` of an
    // experiment branch is TREESAME to the kept parent) — but a sync
    // anchored ON that side line imported under the pruned filter state.
    const out = git(gitContextRoot, [
      'log', '--full-history', '--format=%H', 'HEAD', anchorCommit, '--',
      '.gitattributes', ':(glob)**/.gitattributes',
    ]);
    const epochs = out.split('\n').filter(Boolean);
    if (!epochs.includes(anchorCommit)) epochs.push(anchorCommit);
    return epochs;
  } catch {
    return null;
  }
}

/**
 * Is a `filter` attribute in effect for this path under TODAY's
 * attributes? `check-attr --all` omits genuinely-unspecified attributes
 * from its output entirely, so ANY `filter` line — whatever its value,
 * including the magic-looking `unspecified`/`unset` tokens that a literal
 * driver name can produce, and regardless of whether a driver is still
 * configured (a removed driver leaves the attribute behind and may have
 * converted content back when it was imported) — counts as filtered.
 * Explicit `-filter` lands here too: spare-side only, never delete-side.
 * Any failure counts as filtered (fail toward unprovable, never a delete).
 */
function pathHasContentFilter(gitContextRoot: string, rel: string): boolean {
  try {
    const out = gitRawOutput(gitContextRoot, ['check-attr', '--all', '-z', '--', rel]);
    if (out === '') return false;
    // -z output is a flat sequence of NUL-terminated <path> <attr> <value>
    // triplets; the attribute name sits at every 3k+1 position.
    const fields = out.split('\u0000');
    for (let i = 1; i + 1 < fields.length; i += 3) {
      if (fields[i] === 'filter') return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Do the attributes files at ANY reachable attribute epoch assign a
 * content filter to ANYTHING? Deliberately repo-wide, not per-path: a
 * fallback-regime file can have been RENAMED since its import, so its
 * import-time filter was keyed to a path no current tree names — a
 * per-path history walk would put git's rename-detection heuristics on
 * the DELETE side of the proof. Text-level `filter=` detection
 * over-approximates (a commented-out assignment still counts), which is
 * purely spare-side; `-filter`/`!filter` lines assign nothing and
 * convert nothing, and git rejects `filter` inside `[attr]` macros, so
 * the token cannot be introduced without the literal `filter=` text.
 * A grep failure that is not a clean no-match counts as filtered.
 */
function anyFilterAtAttributeEpochs(gitContextRoot: string, epochs: string[]): boolean {
  for (const epoch of epochs) {
    try {
      git(gitContextRoot, [
        'grep', '-l', '-F', 'filter=', epoch, '--',
        '.gitattributes', ':(glob)**/.gitattributes',
      ]);
      return true;
    } catch (err) {
      if ((err as { status?: unknown }).status === 1) continue;
      return true;
    }
  }
  return false;
}

/**
 * The slugs a fallback-regime file (path derives no slug) can own a row
 * under, resolved the way import resolves them — parseMarkdown for the
 * frontmatter `slug:`, then the SAME validateSlug chokepoint
 * importFromContent runs, which lowercases (a `slug: Party-Notes` row is
 * stored as `party-notes`; an index carrying the raw casing would miss it
 * and misclassify the live row as stale). A slug the current chokepoint
 * REJECTS still registers in both casings: a legacy row imported under
 * older validation rules may carry it, and extra entries are purely
 * spare-side.
 *
 * THREE current-path content states are consulted and their slugs unioned
 * (the fourth state — the sync anchor commit — is enumerated as its own
 * tree by trackedSlugIndex, since a rename moves its content to a path no
 * current-path lookup can reach):
 *   - the working tree — what the next import would read; never followed
 *     through a symlink (import rejects symlinks via lstat before reading,
 *     and following one would read an arbitrary out-of-repo target);
 *   - the git index (staging) blob — what an in-flight `git add` holds;
 *   - the HEAD blob — the last committed content. An uncommitted edit
 *     that removes or changes the `slug:` line must not un-prove the slug
 *     the imported row still carries — and STAGING that edit changes the
 *     first two states at once, so HEAD keeps proving it.
 *
 * `proofIntact` goes false when either side that might name a slug could
 * not be examined — an unreadable file (EACCES; plain working-tree absence
 * is normal, the blob covers it), a side over the import size gate (a row
 * imported while the file was under the gate stays live, and an unread
 * file must never supply a staleness proof), a smudge filter expanding the
 * blob past the gate after the raw-size check, or a path with no stage-0
 * index entry (unmerged). The caller then marks the whole index incomplete
 * and every miss is spared as unknown.
 */
function fallbackSlugsForFile(
  gitContextRoot: string,
  rel: string,
): { slugs: string[]; proofIntact: boolean } {
  const contents: string[] = [];
  let proofIntact = true;
  try {
    // `rel` comes from `git ls-files`/`git ls-tree` (trackedSlugIndex, above) —
    // paths git itself tracked, never external input — but reject any `..`
    // segment before it reaches join() rather than trust that invariant
    // silently (semgrep path-join-resolve-traversal; belt-and-braces
    // alongside the symlink guard below, which covers the OTHER
    // out-of-repo-read vector this function's own docstring calls out).
    if (rel.split('/').includes('..')) {
      proofIntact = false;
    } else {
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
      const abs = join(gitContextRoot, rel);
      const st = lstatSync(abs);
      if (!st.isSymbolicLink()) {
        if (st.size > MAX_FILE_SIZE) proofIntact = false;
        else contents.push(readFileSync(abs, 'utf-8'));
      }
    }
    // A symlink's own registrable content is its index blob (the target
    // path text, read below) — matching both git's view and import's
    // refusal to follow it.
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') proofIntact = false;
  }
  try {
    const blobSize = Number(git(gitContextRoot, ['cat-file', '-s', `:${rel}`]));
    if (Number.isFinite(blobSize) && blobSize > MAX_FILE_SIZE) {
      proofIntact = false;
    } else {
      // git()'s trim() can only ADD a frontmatter parse (leading
      // whitespace stripped) — spare side. Re-check the size AFTER the
      // read: a smudge filter can expand output past the raw blob size.
      const c = git(gitContextRoot, ['cat-file', '--filters', `:${rel}`]);
      if (c.length > MAX_FILE_SIZE) proofIntact = false;
      else contents.push(c);
    }
  } catch {
    // No stage-0 entry (unmerged path) or another repo oddity: the
    // committed side could not be examined.
    proofIntact = false;
  }
  // HEAD blob — the last COMMITTED content, the state sync's own imports
  // actually came from. `:${rel}` above is the STAGING index, so staging
  // an uncommitted edit that removes the slug: line changed BOTH other
  // states at once — and un-proved (deleted) the row imported from HEAD.
  try {
    const inHead = git(gitContextRoot, ['ls-tree', 'HEAD', '--', rel]);
    if (inHead !== '') {
      const headSize = Number(git(gitContextRoot, ['cat-file', '-s', `HEAD:${rel}`]));
      if (Number.isFinite(headSize) && headSize > MAX_FILE_SIZE) {
        proofIntact = false;
      } else {
        const c = git(gitContextRoot, ['cat-file', '--filters', `HEAD:${rel}`]);
        if (c.length > MAX_FILE_SIZE) proofIntact = false;
        else contents.push(c);
      }
    }
    // Absent from HEAD (a newly added file) is normal — nothing to prove.
  } catch {
    proofIntact = false;
  }
  // No frontmatter slug in a content state → that state derives nothing
  // (the import path refuses it). Residual, accepted: a row from a content
  // revision older than EVERY consulted state carries a slug this pass
  // cannot recover — it would also need drifted source_path bookkeeping to
  // ever become a reconcile candidate.
  const slugs = new Set<string>();
  for (const content of contents) {
    for (const s of frontmatterSlugShapes(content, rel)) slugs.add(s);
  }
  return { slugs: [...slugs], proofIntact };
}

/**
 * #3479 blocker 2 — find open `<rename:…>` sentinels with nothing left to
 * reconcile. A sentinel is orphaned when NO active row carries the rename's
 * OLD source_path (read back out of the sentinel's own error text) anymore:
 * the duplicate it guarded against is gone — hard-deleted, or soft-deleted
 * by the operator's `gbrain delete` — so keeping the row open only ages
 * doctor toward a permanent FAIL.
 *
 * Fail-closed on every uncertain branch: a sentinel that failed again THIS
 * run (in `excludePaths`), one whose error text doesn't parse, or a probe
 * that throws leaves the row open — only a positive "no active row has the
 * old path" clears. ANY surviving active row keeps its sentinel: the
 * duplicate is real, and the operator remedy (`gbrain delete <stale-slug>`)
 * or a converging retry is the way out, not silent bookkeeping cleanup.
 */
async function orphanedRenameSentinels(
  engine: BrainEngine,
  sourceId: string,
  excludePaths: ReadonlySet<string>,
): Promise<string[]> {
  const candidates: Array<{ path: string; from: string }> = [];
  for (const row of loadSyncFailures()) {
    if (row.source_id !== sourceId || row.state !== 'open') continue;
    if (!row.path.startsWith(RENAME_SENTINEL_PREFIX)) continue;
    if (excludePaths.has(row.path)) continue;
    const from = parseRenameReconcileFrom(row.error);
    if (from === undefined) continue;
    candidates.push({ path: row.path, from });
  }
  if (candidates.length === 0) return [];
  try {
    const active = await activeSlugsBySourcePath(
      engine, [...new Set(candidates.map(c => c.from))], sourceId,
    );
    const firstPass = candidates.filter(c => !active.has(c.from));
    if (firstPass.length === 0) return [];
    // Second probe, immediately before the verdict leaves this function: a
    // writer outside the sync lock (a raw import, restore_page) can
    // materialize an active row with the old path between probe and clear.
    // Requiring two consecutive positive "no active row" verdicts shrinks
    // that window to the clear itself. Full atomicity is unreachable here —
    // the file ledger and the DB share no transaction — and a duplicate
    // re-created AFTER the clear is out of any sentinel's reach by design:
    // the sentinel is a one-shot failure record of a specific reconcile,
    // not a continuously re-derived invariant.
    const recheck = await activeSlugsBySourcePath(
      engine, [...new Set(firstPass.map(c => c.from))], sourceId,
    );
    return firstPass.filter(c => !recheck.has(c.from)).map(c => c.path);
  } catch {
    // Probe unavailable — leave every row open rather than guess.
    return [];
  }
}

/**
 * The quiet-run half of the #3479 blocker-2 fix: the up_to_date early
 * returns never reach the failure gate, and the reviewer's exact probe was
 * a `synced` then `up_to_date` run pair that left the orphaned sentinel
 * open forever. Clears directly through the ledger; a no-op (including the
 * no-ledger-file case) costs one small file read.
 *
 * Clear-then-verify: after the clear, verifyOrRestoreClearedSentinels runs
 * the probe once more and restores any sentinel whose old path re-acquired
 * an active row in the window.
 */
async function sweepOrphanedRenameSentinels(
  engine: BrainEngine,
  sourceId: string,
  excludePaths: ReadonlySet<string> = new Set(),
): Promise<void> {
  const orphaned = await orphanedRenameSentinels(engine, sourceId, excludePaths);
  if (orphaned.length === 0) return;
  const orphanSet = new Set(orphaned);
  // Captured BEFORE the clear so a restore can reproduce the exact row.
  const clearedRows = loadSyncFailures().filter(
    r => r.source_id === sourceId && orphanSet.has(r.path),
  );
  clearFailures(sourceId, orphaned);
  serr(
    `  [sync] cleared ${orphaned.length} orphaned rename sentinel(s) — ` +
    `the stale row(s) they guarded no longer resolve.`,
  );
  await verifyOrRestoreClearedSentinels(engine, sourceId, clearedRows);
}

/**
 * The verify half of clear-then-verify (#3583), shared by every path that
 * clears `<rename:…>` sentinels on an orphan verdict (the quiet-run sweeps
 * AND both failure gates): probe once more AFTER the clear and RESTORE —
 * verbatim, via restoreFailures, so attempts / first_seen / commit survive
 * — any sentinel whose old path re-acquired an active row. A writer
 * outside the sync lock (a raw import, restore_page) landing between
 * probe and clear thereby converts from silently-lost to
 * detected-and-repaired.
 *
 * Fail-closed: when the verify probe itself is unavailable, EVERY cleared
 * row is restored — a premature restore is self-healing (the next quiet
 * run re-clears a genuinely-orphaned sentinel), a lost sentinel is not.
 * restoreFailures skips rows that are already present, so this can never
 * double-record or fight a gate that did not actually clear. A writer
 * landing after the verify probe is indistinguishable from one landing a
 * second after a legitimate clear — out of any sentinel's reach by design
 * (the sentinel is a one-shot failure record, not a continuously
 * re-derived invariant), and the file ledger and the DB share no
 * transaction that could close it.
 */
async function verifyOrRestoreClearedSentinels(
  engine: BrainEngine,
  sourceId: string,
  clearedRows: SyncFailure[],
): Promise<void> {
  if (clearedRows.length === 0) return;
  let revived: SyncFailure[];
  try {
    const froms = new Map<string, string>();
    for (const row of clearedRows) {
      const from = parseRenameReconcileFrom(row.error);
      if (from !== undefined) froms.set(row.path, from);
    }
    const active = await activeSlugsBySourcePath(
      engine, [...new Set(froms.values())], sourceId,
    );
    revived = clearedRows.filter(r => {
      const from = froms.get(r.path);
      return from !== undefined && active.has(from);
    });
  } catch {
    revived = clearedRows;
  }
  const restored = restoreFailures(sourceId, revived);
  if (restored > 0) {
    serr(
      `  [sync] restored ${restored} rename sentinel(s) — an active row ` +
      `re-acquired the old path after the clear, or verification was unavailable.`,
    );
  }
}

async function performSyncInner(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  // v0.41.8.0 (D9 / #1342): phase breadcrumbs. The #1342 reporter saw
  // ZERO stderr output before their sync hang, which made the bug
  // impossible to triage. Mirror the existing `[gbrain phase] sync.git_pull`
  // pattern at the major phase boundaries so the next #1342-shaped
  // report names WHICH phase spun. Doesn't fix #1342 but converts
  // "hung with no output" into actionable diagnostic data.
  serr(`[gbrain phase] sync.resolve_repo`);
  opts.onProgress?.({ phase: 'resolve_repo' });
  // Resolve repo path
  const rawRepoPath = opts.repoPath || await readSyncAnchor(engine, opts.sourceId, 'repo_path');
  if (!rawRepoPath) {
    const hint = opts.sourceId
      ? `Source "${opts.sourceId}" has no local_path. Run: gbrain sources add ${opts.sourceId} --path <path>`
      : `No repo path specified. Use --repo or run gbrain init with --repo first.`;
    throw new Error(hint);
  }
  // #3696: resolve to ABSOLUTE at entry. A relative path (legacy relative
  // sources.local_path row, or a caller-passed `--repo .`) breaks the moment
  // any consumer runs from a different cwd (launchd daemon at cwd=/). Since
  // writeSyncAnchor('repo_path', anchorPath) re-persists this value below,
  // one successful sync from the right cwd self-heals a legacy relative row
  // to absolute.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- rawRepoPath is the local operator's --repo CLI arg or the operator-written sync anchor (sync.repo_path / sources.local_path); the sync_brain op is localOnly:true so no remote caller reaches this path, and absolutizing it here IS the #3696 fix
  const repoPath = pathResolve(rawRepoPath);

  serr(`[gbrain phase] sync.load_active_pack`);
  // v0.39 T1.5: load active pack ONCE at sync entry; pass to every per-file
  // importFile call below. Codex perf finding #7: per-file loadActivePack adds
  // disk/YAML/hash overhead × thousands of files. Best-effort: pack load
  // failure falls through to legacy inferType (parity preserved).
  let syncActivePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string>; aliases?: ReadonlyArray<string> }> } | undefined;
  try {
    // v0.41.37.0 #1569: --no-schema-pack escape hatch. Skip pack load entirely so
    // no user-supplied pack regex (markdown.ts subtype path_pattern) runs during
    // sync; pages fall back to legacy prefix typing.
    if (opts.noSchemaPack) {
      serr('[sync] --no-schema-pack: skipping schema pack; pages use legacy prefix typing');
      throw new Error('schema-pack-skipped');
    }
    const { loadActivePack } = await import('../core/schema-pack/load-active.ts');
    const { loadConfig } = await import('../core/config.ts');
    const resolved = await loadActivePack({
      cfg: loadConfig(),
      remote: false, // sync is always a trusted CLI / autopilot caller
      sourceId: opts.sourceId,
    });
    syncActivePack = { page_types: resolved.manifest.page_types };
  } catch {
    syncActivePack = undefined;
  }

  // v0.46: github source kind. A source registered with kind=github is
  // API-backed, not git-backed: the sync engine materializes issues/PRs
  // into the managed dir and hands off to the standard import pipeline.
  // Everything below (git anchors, diff, reconcile) is git-specific and
  // does not apply. Also handles opts.githubItem (webhook single-item
  // refresh) when the source is github-kind.
  if (opts.sourceId || opts.githubItem) {
    const srcId = opts.sourceId ?? 'default';
    const cfgRows = await engine.executeRaw<{ local_path: string | null; config: unknown }>(
      `SELECT local_path, config FROM sources WHERE id = $1`,
      [srcId],
    );
    if (cfgRows.length > 0) {
      const rawCfg = typeof cfgRows[0].config === 'string'
        ? (JSON.parse(cfgRows[0].config as string) as Record<string, unknown>)
        : ((cfgRows[0]?.config ?? {}) as Record<string, unknown>);
      if (rawCfg.kind === 'github') {
        serr(`[gbrain phase] sync.github_materialize`);
        const { parseGitHubSourceConfig, runGitHubSync } = await import('../core/github-source.ts');
        const { defaultCloneDir } = await import('../core/sources-ops.ts');
        const fallbackDir = cfgRows[0].local_path ?? defaultCloneDir(`${srcId}-github`);
        const cfg = parseGitHubSourceConfig(rawCfg, fallbackDir);
        return await runGitHubSync(engine, srcId, cfg, opts);
      }
      // v0.47: google source kind (Gmail/Calendar/Contacts). Same shape as
      // the github branch: API-backed materializer, standard import pipeline.
      if (rawCfg.kind === 'google') {
        serr(`[gbrain phase] sync.google_materialize`);
        const { parseGoogleSourceConfig, runGoogleSync } = await import('../core/google/google-source.ts');
        const { defaultCloneDir } = await import('../core/sources-ops.ts');
        const fallbackDir = cfgRows[0].local_path ?? defaultCloneDir(`${srcId}-google`);
        const cfg = parseGoogleSourceConfig(rawCfg, fallbackDir);
        return await runGoogleSync(engine, srcId, cfg, opts);
      }
      if (opts.githubItem) {
        throw new Error(
          `github_item refresh requires a github-kind source, but "${srcId}" is not github-kind.`,
        );
      }
    } else if (opts.githubItem) {
      throw new Error(`github_item refresh requires a github-kind source; source "${srcId}" not found.`);
    }
  }

  // v0.28: source-aware re-clone branch. When the source has a remote_url
  // recorded (i.e. it was registered via `sources add --url`), the on-disk
  // clone is auto-managed. validateRepoState classifies the on-disk state;
  // we recover from missing/no-git/not-a-dir by re-cloning, refuse on
  // url-drift or corruption with structured hints.
  if (opts.sourceId) {
    serr(`[gbrain phase] sync.validate_repo_state`);
    const { validateRepoState } = await import('../core/git-remote.ts');
    const { recloneIfMissing, isOwnedClone, unownedHint } = await import(
      '../core/sources-ops.ts'
    );
    const cfgRows = await engine.executeRaw<{ local_path: string | null; config: unknown }>(
      `SELECT local_path, config FROM sources WHERE id = $1`,
      [opts.sourceId],
    );
    const cfg =
      typeof cfgRows[0]?.config === 'string'
        ? (JSON.parse(cfgRows[0].config as string) as Record<string, unknown>)
        : ((cfgRows[0]?.config ?? {}) as Record<string, unknown>);
    const remoteUrl = typeof cfg.remote_url === 'string' ? cfg.remote_url : null;
    if (remoteUrl) {
      const ownSrc = {
        id: opts.sourceId,
        local_path: cfgRows[0]?.local_path ?? repoPath,
        config: cfg,
      };
      const state = validateRepoState(repoPath, remoteUrl);
      switch (state) {
        case 'healthy':
          // No per-sync warning for an unowned-but-healthy source — it would
          // spam every sync. The misconfig is surfaced by the doctor check
          // (TODO1) instead. Healthy unowned paths sync read-only and are safe.
          break;
        case 'missing':
        case 'no-git':
        case 'not-a-dir':
          // #1881: only re-clone a clone gbrain owns. An unowned local_path
          // (the user's working tree) is refused loudly, never deleted.
          if (!isOwnedClone(ownSrc)) {
            throw new Error(unownedHint(ownSrc, state));
          }
          serr(
            `[gbrain] auto-recovery: re-cloning "${opts.sourceId}" (clone state: ${state}).`,
          );
          await recloneIfMissing(engine, opts.sourceId);
          break;
        case 'corrupted':
          throw new Error(
            `Source "${opts.sourceId}" clone at ${repoPath} is corrupted ` +
              `(\`git remote get-url origin\` failed). Run: ` +
              `gbrain sources remove ${opts.sourceId} --confirm-destructive && ` +
              `gbrain sources add ${opts.sourceId} --url ${remoteUrl}`,
          );
        case 'url-drift':
          throw new Error(
            `Source "${opts.sourceId}" clone at ${repoPath} has a remote ` +
              `that differs from config.remote_url=${remoteUrl}. ` +
              `Re-clone with: gbrain sources rebase-clone ${opts.sourceId} ` +
              `(if available, else: sources remove + sources add).`,
          );
      }
    }
  }

  // #753/#774: discover the git root instead of requiring `.git` at repoPath
  // directly. Supports subdir-of-git-repo sources (monorepo pattern): either
  // an explicit `--src-subpath` under a git-root repoPath, or a repoPath that
  // IS a subdirectory (auto-discovery). Two axes fall out:
  //   - gitContextRoot: ALL git operations (pull, rev-parse, diff, cat-file)
  //   - syncScopeRoot:  file walking, imports, deletes, renames
  // In the common case (repoPath == git root, no subpath) they are identical.
  serr(`[gbrain phase] sync.discover_git_root`);
  // #2964: a legacy `sync.repo_path`-anchored default brain can reach here
  // having never been `git init`-ed — e.g. a brain-pages dir that predates
  // git-backed sync, or one rsync'd from another machine without its
  // `.git`. gbrain owns that directory outright, so self-heal by
  // initializing it in place instead of failing the sync phase every
  // single run. Mirrors the recloneIfMissing self-recovery above for
  // owned remote clones. Ownership is proven by VALUE (resolved repoPath
  // equals gbrain's persisted anchor) via `isAnchorOwnedSyncPath`, not by
  // the mere absence of `opts.sourceId`/`opts.repoPath` — see that
  // function's docstring. `!opts.dryRun`: a preview must never write.
  let gitContextRoot: string;
  try {
    gitContextRoot = realpathSync(discoverGitRoot(repoPath));
  } catch (err) {
    if (
      opts.dryRun ||
      opts.signal?.aborted ||
      !existsSync(repoPath) ||
      !(await isAnchorOwnedSyncPath(engine, opts, repoPath))
    ) {
      throw err;
    }
    // 2026-08-10 incident guard. `discoverGitRoot` is a 30s-bounded
    // `git rev-parse --show-toplevel` that walks UP; it can throw for reasons
    // OTHER than "no git repo" — a transient timeout on a large brain, or a
    // concurrent `gbrain-sync` holding a git lock — on a directory that IS a
    // git repo, whether the repo root is `repoPath` itself OR an ANCESTOR
    // (subdir-anchored brain, the #753/#774 monorepo pattern). Trusting a
    // single throw and running `git init` (a no-op reinit at repoPath, or a
    // NEW nested repo shadowing the ancestor) + baseline-commit stacks a
    // spurious auto-init commit and re-cases the tree on a case-insensitive
    // filesystem. So do NOT self-heal on one throw — re-probe once:
    //   - re-probe SUCCEEDS => the first throw was transient and the repo
    //     (own or ancestor) is real; use it, never init/commit.
    //   - re-probe THROWS but `.git` is present at repoPath => a real but
    //     unreadable repo (corrupt, broken gitlink, or a persistent transient)
    //     — NEVER init/commit over it; surface the original error.
    //   - re-probe THROWS and no `.git` at repoPath => genuinely not a git
    //     repo anywhere up the tree; self-heal.
    // The createSyncBaselineCommit chokepoint is the fail-closed backstop if
    // this ever reaches a baseline on a repo that turns out to have commits.
    let reprobedRoot: string | null = null;
    try {
      reprobedRoot = discoverGitRoot(repoPath);
    } catch {
      reprobedRoot = null;
    }
    if (reprobedRoot !== null) {
      gitContextRoot = realpathSync(reprobedRoot);
    } else if (existsSync(join(repoPath, '.git'))) {
      throw err;
    } else {
      serr(`[gbrain] auto-recovery: git-initializing brain dir ${repoPath} (no git repo found).`);
      git(repoPath, ['init', '--quiet']);
      createSyncBaselineCommit(repoPath);
      gitContextRoot = realpathSync(discoverGitRoot(repoPath));
    }
  }
  const rawScopeRoot = opts.srcSubpath ? join(repoPath, opts.srcSubpath) : repoPath;
  if (!existsSync(rawScopeRoot)) {
    throw new Error(`Sync scope does not exist: ${rawScopeRoot}`);
  }
  const syncScopeRoot = realpathSync(rawScopeRoot);
  // NAV-1/NAV-2 scope-entry guard: the realpath-resolved scope must live
  // inside the realpath-resolved git root. Catches `--src-subpath ../escape`
  // AND a symlinked subdir pointing outside the repo, before any git op runs.
  if (!isWithinRoot(syncScopeRoot, gitContextRoot)) {
    throw new Error(
      `Sync scope ${syncScopeRoot} resolves outside git repo ${gitContextRoot}. ` +
      `Refusing to sync: possible path traversal via --src-subpath.`,
    );
  }
  // Relative path from git root to sync scope ('' when scope == root).
  const syncScopeRelPath = syncScopeRoot === gitContextRoot ? '' : relative(gitContextRoot, syncScopeRoot);
  const scoped = syncScopeRelPath !== '';
  // Anchor written back to sync state (sources.local_path / sync.repo_path):
  // the SCOPE path, so a follow-up bare `gbrain sync` auto-discovers the same
  // scope. Unchanged (the caller's repoPath spelling) when no --src-subpath.
  const anchorPath = opts.srcSubpath ? rawScopeRoot : repoPath;
  // #4342 — explicit + STICKY slug namespace for scoped syncs. Pre-fix the
  // namespace was implicit: a local_path that happened to sit inside a bigger
  // git repo silently produced git-root-PREFIXED slugs (`notes/foo` instead
  // of `foo`), diverging from what `gbrain import <dir>` of the same tree
  // creates. The mode is decided once (resolveSlugRootMode: stored pin >
  // explicit --src-subpath > auto-pin when existing pages already carry the
  // prefix > local_path-relative) and persisted, so a live install never
  // re-slugs and every later sync agrees.
  let slugRootMode: SlugRootMode = 'git-root';
  if (scoped) {
    // Probe prefix in SLUG spelling (resolveSlugForPath), not raw path
    // spelling — the auto-pin LIKE must match how slugs were actually minted.
    // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- syncScopeRelPath is relative() of the realpath'd scope already proven inside the realpath'd git root by the isWithinRoot guard above (so it carries no ..); the join output only mints an in-memory slug probe string, no fs operation
    const probeSlug = resolveSlugForPath(join(syncScopeRelPath, 'x.md'));
    const slugPrefix = probeSlug.slice(0, probeSlug.length - '/x'.length);
    slugRootMode = await resolveSlugRootMode(engine, {
      sourceId: opts.sourceId,
      explicitGitRoot: opts.srcSubpath !== undefined,
      slugPrefix,
      // #4342 review fix: a --dry-run must not persist the sticky pin —
      // resolve in-memory only; the first real sync writes it.
      dryRun: opts.dryRun === true,
    });
  }
  const fullSyncRoots = { gitContextRoot, syncScopeRoot, anchorPath, slugRootMode };

  serr(`[gbrain phase] sync.detect_head`);
  // Detect detached HEAD up front so the working-tree fallback fires for both
  // the default sync and `--no-pull` callers. Only the actual git pull is
  // gated on opts.noPull or opts.dryRun.
  const detachedHead = isDetachedHead(gitContextRoot);
  if (detachedHead && !opts.noPull) {
    // Print the caller's repoPath spelling (not the realpathed git root) —
    // it's what the operator recognizes, and tests pin it.
    serr(`Detached HEAD on ${repoPath}; skipping git pull. Syncing from local working tree.`);
  }

  // Git pull (unless --no-pull or --dry-run). v0.28.1 codex finding (HIGH): the legacy
  // git() helper at sync.ts:192 spawns git without GIT_SSRF_FLAGS, so
  // every steady-state pull was bypassing the redirect/submodule/protocol
  // hardening that cloneRepo applies. Route through pullRepo from
  // git-remote.ts so the flag set is consistent across initial clone and
  // ongoing pulls — single source of truth for the defensive flags.
  const originRemotePresent = !opts.noPull && !detachedHead ? hasOriginRemote(gitContextRoot) : false;
  if (!opts.noPull && !detachedHead && !originRemotePresent) {
    serr(`No origin remote on ${repoPath}; skipping git pull. Syncing from local working tree.`);
  }

  // v0.41.13.0 (T2 + T3): read the bookmark BEFORE pull so the pull-phase
  // abort/partial path has a real `fromCommit` value to report. lastCommit
  // is a pure DB read — pull doesn't change the bookmark — so the read
  // order doesn't matter for correctness. Ancestry validation below still
  // happens AFTER pull (so a `git pull` that brings in missing commits
  // can restore a valid ancestor chain).
  const lastCommit = opts.full ? null : await readSyncAnchor(engine, opts.sourceId, 'last_commit');

  // v0.41.13.0 (T2): pre-pull abort check. If --timeout already fired
  // (e.g. cron invoked sync after the previous run took the full budget),
  // return partial without invoking the pull subprocess. fromCommit and
  // toCommit both report the prior bookmark since we never advanced past it.
  if (opts.signal?.aborted) {
    return buildPartialResult({
      fromCommit: lastCommit,
      toCommit: lastCommit ?? '',
      filesImported: 0,
      pagesAffected: [],
      chunksCreated: 0,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      reason: 'timeout',
    });
  }

  // #3068: remember a warn-and-continue pull failure. The fall-through-to-
  // working-tree design stays (local commits still import when the remote is
  // unreachable), but a ZERO-import sync after a failed pull must not report
  // `up_to_date` / bump the freshness heartbeat — that is what made a
  // permanently-failing pull (e.g. a local-path origin rejected by
  // protocol.file.allow=never, #1315) invisible forever: every nightly run
  // exited 0 with "Already up to date" and doctor's sync_freshness never
  // fired because last_sync_at kept advancing.
  let pullFailed = false;
  if (!opts.dryRun && !opts.noPull && !detachedHead && originRemotePresent) {
    const _t0 = Date.now();
    serr(`[gbrain phase] sync.git_pull start`);
    opts.onProgress?.({ phase: 'git_pull' });
    try {
      const { pullRepo } = await import('../core/git-remote.ts');
      // v0.41.13.0 (T3 / D-V4-mech-7): if the operator set --timeout,
      // bound the pull subprocess to a fraction of the remaining budget.
      // We pass a safe default (the operator's full --timeout if set, else
      // pullRepo's own 300s default). The catch below distinguishes
      // timeout (ETIMEDOUT / SIGTERM on err.cause) from ordinary pull
      // failure. Pull applies to the whole git repo (gitContextRoot), not
      // just the sync scope — git has no per-subdir pull.
      pullRepo(gitContextRoot);
      serr(`[gbrain phase] sync.git_pull done ${Date.now() - _t0}ms`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      serr(`[gbrain phase] sync.git_pull error ${Date.now() - _t0}ms (${msg.slice(0, 200)})`);
      // v0.41.13.0 (T3 / D-V4-mech-7): pullRepo wraps execFileSync errors
      // in GitOperationError, so `error.code === 'ETIMEDOUT'` and
      // `error.signal === 'SIGTERM'` live on `.cause`, NOT on the top-
      // level error. Inspect `.cause` to distinguish a real timeout
      // (return partial reason='pull_timeout') from ordinary failure
      // (keep the existing warn-and-continue R2 invariant).
      const cause: unknown = e instanceof Error && 'cause' in e ? (e as { cause?: unknown }).cause : undefined;
      const causeCode = (cause && typeof cause === 'object' && 'code' in cause)
        ? (cause as { code?: unknown }).code
        : undefined;
      const causeSignal = (cause && typeof cause === 'object' && 'signal' in cause)
        ? (cause as { signal?: unknown }).signal
        : undefined;
      const isTimeout = causeCode === 'ETIMEDOUT' || causeSignal === 'SIGTERM';
      if (isTimeout) {
        return buildPartialResult({
          fromCommit: lastCommit,
          toCommit: lastCommit ?? '',
          filesImported: 0,
          pagesAffected: [],
          chunksCreated: 0,
          added: 0, modified: 0, deleted: 0, renamed: 0,
          reason: 'pull_timeout',
        });
      }
      pullFailed = true;
      if (msg.includes('non-fast-forward') || msg.includes('diverged')) {
        serr(`Warning: git pull failed (remote diverged). Syncing from local state.`);
      } else {
        serr(`Warning: git pull failed: ${msg.slice(0, 200)}`); // #1315 stderr-first
      }
    }
  }

  // Get current HEAD
  let headCommit: string;
  try {
    headCommit = git(gitContextRoot, ['rev-parse', 'HEAD']);
  } catch {
    // #2964: unborn-HEAD recovery. `.git` exists (discoverGitRoot succeeded
    // above) but there are zero commits — e.g. a prior self-heal `git init`
    // ran but the process died before the baseline commit landed, leaving
    // this brain permanently wedged on "No commits in repo" every night
    // thereafter. Finish the same baseline-commit self-heal the
    // discoverGitRoot catch above would have done, gated the same way
    // (ownership proven by value, never on a dry-run preview) PLUS a scope
    // check: `discoverGitRoot` walks UP from `repoPath`, so it can resolve
    // to an ANCESTOR repo, not `repoPath` itself (most plausible for a
    // `--src-subpath` sync, but `isAnchorOwnedSyncPath` already refuses
    // that case — kept here too as defense in depth against any other path
    // where gitContextRoot could diverge from repoPath). Committing at an
    // ancestor (`git add -A` at gitContextRoot) would capture sibling
    // files well outside the sync scope — refuse instead of guessing.
    if (
      opts.dryRun ||
      opts.signal?.aborted ||
      gitContextRoot !== realpathSync(repoPath) ||
      !(await isAnchorOwnedSyncPath(engine, opts, repoPath))
    ) {
      throw new Error(`No commits in repo ${repoPath}. Make at least one commit before syncing.`);
    }
    serr(`[gbrain] auto-recovery: repo has no commits yet, creating baseline commit ${gitContextRoot}.`);
    createSyncBaselineCommit(gitContextRoot);
    headCommit = git(gitContextRoot, ['rev-parse', 'HEAD']);
  }

  // #2964: self-heal deliberately does NOT special-case db_only/.gitignore
  // interaction beyond the COMMIT itself (createSyncBaselineCommit's
  // pathspec exclusion, which stands on its own regardless of what
  // .gitignore says). db_only content is documented as DB-sourced ("bulk
  // machine-generated content... written to disk as a local cache", see
  // docs/storage-tiering.md) — it reaches the database via ingest-specific
  // paths, never via gbrain sync's git-diff-based file collection, and
  // `.gitignore` management there is entirely about keeping db_only out of
  // git history, not about what sync imports. An earlier version of this
  // fix (Codex review rounds 6-7) tried to also guarantee db_only markdown
  // gets imported on this first sync and that .gitignore gets written
  // post-success even when called outside runSync — solving a problem
  // that, per the docs above, isn't actually in scope for what sync is
  // for. Reverted in round 8 review discussion in favor of this simpler
  // design: after self-heal, the import + any subsequent .gitignore
  // management behave EXACTLY the same as for any other brain, self-healed
  // or not (runSync's existing post-success manageGitignoreAtGitRoot call
  // covers the CLI path identically either way; the dream cycle not
  // calling it is a separate, pre-existing characteristic of the dream
  // cycle in general, not something this fix introduces or worsens).

  // Same reasoning as the `sync.include_working_tree` config fallback further
  // down, applied to the indexing scope: `--exclude` is a per-invocation flag,
  // so only callers that go through the CLI can narrow what gets indexed.
  // autopilot, minion sync jobs and the dream cycle call sync internally with
  // no place to put exclusions — a repo whose indexing scope is narrower than
  // its git tree is honored on one path and silently ignored on the others.
  //
  // Silently is the operative word: not excluding something is not an error
  // for an indexer, so the gap surfaces as content quietly reappearing in the
  // index, never as a failure. Resolving the config HERE gives every caller
  // the same scope. The read is best-effort, exactly like that one.
  //
  // UNION rather than flag-wins, which is where this departs from that
  // boolean: a persisted scope is a property of the repo ("this is not
  // indexable material"), and an ad-hoc `--exclude tmp/` must not silently
  // re-open it — that would reintroduce the very failure this closes. A
  // boolean has no union; a pattern list does. Narrowing further always
  // works; widening is deliberate, by editing the config.
  //
  // Directory prefixes are normalized to subtree globs (`raw/` → `raw/**`):
  // without the `**` the pattern matches the directory entry and none of the
  // files inside it, which is the same gap wearing a different shape.
  //
  // POSITION IS LOAD-BEARING: this union must run ABOVE the three
  // performFullSync early returns below (gc'd anchor, first sync,
  // --include-gitignored). The first sync is exactly where exclusion
  // pollution is permanent — a full walk that ignores the persisted scope
  // imports every excluded derivative file, and no later incremental sync
  // ever revisits them.
  try {
    const stored = await engine.getConfig('sync.exclude');
    const storedPatterns = (stored ?? '')
      .split(/[\n,]/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => (p.endsWith('/') ? `${p}**` : p));
    if (storedPatterns.length > 0) {
      opts = { ...opts, exclude: [...new Set([...(opts.exclude ?? []), ...storedPatterns])] };
    }
  } catch { /* config unreadable — never break a sync over the scope read */ }

  // #1970: bookmark reachability. The ONLY thing that should force a full
  // reconcile is a truly-absent object; a present-but-non-ancestor bookmark
  // (history rewrite: force-push, master→main consolidation, squash) is still
  // diffable. `git diff A..B` is an endpoint-tree comparison and does NOT
  // require A to be an ancestor of B (unlike rev-walk commands or `A...B`,
  // which use merge-base). So we diff DIRECTLY against the orphaned-but-on-disk
  // bookmark for the exact delta instead of a blind full re-walk that never
  // finishes cross-region (#1958) and never advances the bookmark.
  //
  //   lastCommit (orphan)        HEAD
  //        o ─────── x ─────── x   (old line, dropped by the rewrite)
  //         \
  //          o ─────── o ─────── ●  HEAD (new line)
  //   git diff orphan..HEAD == net tree delta — ancestry irrelevant.
  if (lastCommit) {
    let objectPresent = true;
    try {
      git(gitContextRoot, ['cat-file', '-t', lastCommit]);
    } catch {
      objectPresent = false;
    }
    if (!objectPresent) {
      // Object gc'd after a history rewrite — nothing to diff against, so fall
      // back to the authoritative full reconcile (which now also purges stale
      // pages for deleted files; see performFullSync's delete-reconcile pass).
      serr(`Sync anchor ${lastCommit.slice(0, 8)} object missing (gc'd after history rewrite). Running full reimport.`);
      return performFullSync(engine, fullSyncRoots, headCommit, opts);
    }

    // Observability only — NOT control flow. A non-ancestor bookmark is still
    // diffed directly below; we just announce the rewrite so the silent-staleness
    // failure mode (#1970) is visible in the logs.
    let isAncestor = true;
    try {
      git(gitContextRoot, ['merge-base', '--is-ancestor', lastCommit, headCommit]);
    } catch {
      isAncestor = false;
    }
    if (!isAncestor) {
      slog(
        `[sync] last_commit ${lastCommit.slice(0, 8)} not an ancestor of HEAD ` +
        `(history rewritten) — diffing tree-to-tree against the orphaned bookmark; ` +
        `advancing to HEAD on completion.`,
      );
    }
  }

  // First sync
  if (!lastCommit) {
    return performFullSync(engine, fullSyncRoots, headCommit, opts);
  }

  if (opts.includeGitignored) {
    slog(
      `[sync] --include-gitignored: running full filesystem reconcile because ` +
      `git diff cannot report untracked ignored files.`,
    );
    return performFullSync(engine, fullSyncRoots, headCommit, opts);
  }

  // v0.42.x (#1794): resumable incremental sync — resolve the PINNED target.
  // last_commit advances only at FULL import completion, so a killed run keeps
  // lastCommit fixed and the checkpoint key stable across every resume even as
  // the enrich process races HEAD forward underneath us. We drain
  // `lastCommit..pin`; commits past the pin are a clean next-sync diff (this is
  // what kills the staleness window — see plan).
  //   - valid in-flight checkpoint (pin still reachable from HEAD) → resume it.
  //   - rewrite / force-push (pin no longer an ancestor) → discard, re-pin to HEAD.
  //   - no checkpoint → pin = HEAD (the normal single-shot case).
  const ckpt = syncCheckpointKeys(opts.sourceId, lastCommit);
  const checkpointEvery = resolveSyncCheckpointEvery();
  let pin = headCommit;
  let completedPaths: string[] = [];
  {
    const storedTargetArr = await loadOpCheckpoint(engine, ckpt.target);
    const storedTarget = storedTargetArr[0] ?? null;
    if (storedTarget) {
      let pinReachable = false;
      try {
        git(gitContextRoot, ['merge-base', '--is-ancestor', storedTarget, headCommit]);
        pinReachable = true;
      } catch {
        pinReachable = false;
      }
      if (pinReachable) {
        pin = storedTarget;
        completedPaths = await loadOpCheckpoint(engine, ckpt.paths);
        slog(
          `[sync] resuming checkpoint: ${completedPaths.length} file(s) already done; ` +
          `draining ${lastCommit.slice(0, 8)}..${pin.slice(0, 8)} (pinned target).`,
        );
      } else {
        slog(
          `[sync] checkpoint target ${storedTarget.slice(0, 8)} no longer reachable ` +
          `(history rewritten); restarting against HEAD.`,
        );
        // #3583 review: NOT under --dry-run — this hygiene clear is a
        // persistent write, and the real run re-detects the unreachable
        // pin and clears it itself; a preview only reports.
        if (!opts.dryRun) {
          await clearOpCheckpoint(engine, ckpt.paths);
          await clearOpCheckpoint(engine, ckpt.target);
        }
      }
    }
  }

  // v0.20.0 Cathedral II Layer 12 (codex SP-1 fix): before returning
  // 'up_to_date' on git-HEAD equality, check the chunker version gate.
  // If sources.chunker_version mismatches CURRENT_CHUNKER_VERSION, force
  // a full re-walk so existing chunks get re-chunked under the new
  // pipeline (qualified symbol names, parent scope, doc-comment column
  // population, etc.). Without this, upgraded brains silently stay on
  // the old chunks — the whole reason we bumped the version.
  const storedVersion = await readChunkerVersion(engine, opts.sourceId);
  const currentVersion = String(CHUNKER_VERSION);
  const versionMismatch = storedVersion !== null && storedVersion !== currentVersion;
  const versionNeverSet = storedVersion === null && opts.sourceId !== undefined;
  // Untracked-gap fix: the working-tree manifest is now built for attached
  // HEADs too, not just detached ones. Detached HEAD (pre-existing semantics)
  // or a resolved workingTree opt-in → the manifest merges into the delta
  // below and uncommitted state IMPORTS. Attached without the opt-in → NOT
  // imported, but counted through the same scope/exclude/isSyncable filters
  // imports use and reported as `uncommitted` drift + a stderr warning.
  // Before this, "Already up to date." printed while untracked files sat
  // invisible — sync reported convergence it had not achieved.
  //
  // The config fallback resolves HERE (not the CLI layer) so EVERY caller —
  // dream cycle, minion sync jobs, sync_brain — honors the persisted
  // `sync.include_working_tree` the warnings recommend. Per-call flag wins;
  // the config read is best-effort (a config error never breaks a sync).
  let workingTreeResolved = opts.workingTree;
  if (workingTreeResolved === undefined) {
    try {
      workingTreeResolved = (await engine.getConfig('sync.include_working_tree')) === 'true';
    } catch { workingTreeResolved = false; }
  }
  const importWorkingTree = detachedHead || workingTreeResolved === true;
  // Fail-open guard: the manifest builder shells out under a 30s/100MiB git
  // budget and THROWS on breach; a monster untracked dir must not convert
  // every previously-working up-to-date sync into a hard error. Drift
  // counting degrades to empty with a stderr note; an EXPLICIT working-tree
  // import request fails closed with the reason (importing without the
  // manifest would silently skip the very files the caller asked for).
  let workingTreeManifest: SyncManifest;
  try {
    workingTreeManifest = buildDetachedWorkingTreeManifest(gitContextRoot);
  } catch (e) {
    if (importWorkingTree) {
      throw new Error(
        `working-tree manifest unavailable (${e instanceof Error ? e.message.slice(0, 160) : String(e)}) — ` +
        `cannot import uncommitted state; re-run without --working-tree or fix the repo state`,
      );
    }
    serr('[sync] working-tree drift probe failed — drift counting skipped this run.');
    workingTreeManifest = { added: [], modified: [], deleted: [], renamed: [] };
  }

  // #753/#774 scope filter (hoisted above the up_to_date gate so the drift
  // counter here and the delta filter below apply IDENTICAL predicates):
  // git-diff paths are git-root-relative; when a subpath scope is active, only
  // paths under it participate. Back-compat: syncScopeRelPath is '' when
  // scope == root, so inScope is always true and the filters reduce to the
  // pre-#774 behavior exactly.
  const inScope = (p: string): boolean =>
    !scoped || p === syncScopeRelPath || p.startsWith(syncScopeRelPath + '/');
  // --exclude patterns match the SCOPE-relative path (what the user of a
  // scoped source thinks in), same form runImport matches on full sync.
  const scopeRel = (p: string): string =>
    scoped && p.startsWith(syncScopeRelPath + '/') ? p.slice(syncScopeRelPath.length + 1) : p;
  const excluded = (p: string): boolean =>
    opts.exclude !== undefined && opts.exclude.length > 0 && matchesAnyGlob(scopeRel(p), opts.exclude);
  // #4027: includeHidden must ride along wherever isSyncable() consults these
  // opts — dropping it here silently disables --include-hidden on the whole
  // delta path (and the #3974 drift counter) while the flag still parses.
  const syncOpts = { strategy: opts.strategy, includeHidden: opts.includeHidden };

  // Filtered working-tree counts. Renames decompose as add(to) + delete(from)
  // — the same decomposition the import path applies — so a rename-only dirty
  // tree still reports drift instead of reproducing the silent gap this
  // counter exists to close (a staged `git mv` populates only `renamed`).
  const wtCounts = {
    added: workingTreeManifest.added.filter(p => inScope(p) && !excluded(p) && isSyncable(p, syncOpts)).length +
      workingTreeManifest.renamed.filter(r => inScope(r.to) && !excluded(r.to) && isSyncable(r.to, syncOpts)).length,
    modified: workingTreeManifest.modified.filter(p => inScope(p) && !excluded(p) && isSyncable(p, syncOpts)).length,
    deleted: workingTreeManifest.deleted.filter(p => inScope(p) && isSyncable(p, syncOpts)).length +
      workingTreeManifest.renamed.filter(r => inScope(r.from) && isSyncable(r.from, syncOpts)).length,
  };
  const wtSyncableTotal = wtCounts.added + wtCounts.modified + wtCounts.deleted;
  // Fast-path gate: detached HEADs keep the pre-existing RAW-manifest gate;
  // attached repos gate on SYNCABLE changes so a stray unsyncable scratch
  // file can't defeat the up_to_date fast path on every scheduled run.
  const hasWorkingTreeChanges = detachedHead
    ? (workingTreeManifest.added.length > 0 ||
        workingTreeManifest.modified.length > 0 ||
        workingTreeManifest.deleted.length > 0 ||
        workingTreeManifest.renamed.length > 0)
    : wtSyncableTotal > 0;

  let uncommittedDrift: { added: number; modified: number; deleted: number } | undefined;
  if (!importWorkingTree && wtSyncableTotal > 0) {
    uncommittedDrift = wtCounts;
    serr(
      `[sync] ${wtSyncableTotal} uncommitted file(s) are invisible to ` +
      `commit-driven sync (${wtCounts.added} untracked/added, ${wtCounts.modified} modified, ${wtCounts.deleted} deleted). ` +
      `Commit them, or run 'gbrain sync --working-tree' to import uncommitted state.`,
    );
  }

  if (lastCommit === headCommit && !versionMismatch && !versionNeverSet && !(importWorkingTree && hasWorkingTreeChanges)) {
    // #3068: the pull failed and nothing local advanced — this run imported
    // NOTHING and the remote may hold commits we could not fetch. Reporting
    // `up_to_date` here (and bumping the heartbeat below) is exactly the
    // silent-wedge from the issue: every scheduled sync exits 0 forever while
    // the source is stale. Return `partial` instead (not a clean status, and
    // last_sync_at stays frozen so doctor/sources-status staleness fires).
    // The anchor is untouched; the next sync retries the pull from the same
    // bookmark.
    if (pullFailed) {
      serr(
        `[sync] git pull failed and no local changes imported — reporting partial ` +
        `(not up_to_date); sync anchor unchanged at ${lastCommit.slice(0, 8)}.`,
      );
      return buildPartialResult({
        fromCommit: lastCommit,
        toCommit: lastCommit,
        filesImported: 0,
        pagesAffected: [],
        chunksCreated: 0,
        added: 0, modified: 0, deleted: 0, renamed: 0,
        reason: 'pull_failed',
      });
    }
    // v0.42.52.0 (PR #22xx): bump last_sync_at as a heartbeat on every successful
    // 0-changes sync. D4 invariant ("never advance last_commit on partial") is
    // preserved: last_sync_at is a monitoring signal (doctor sync_freshness
    // reads it), separate from the import-converged bookmark. Without this,
    // a cron-driven `*/15 sync` over a quiet vault leaves last_sync_at pinned
    // to the last real commit, so doctor falsely flags the source as stale.
    // #3583 review: NOT under --dry-run — a preview that bumps the freshness
    // heartbeat masks real staleness from doctor.
    if (opts.sourceId && !opts.dryRun) {
      await engine.executeRaw(
        `UPDATE sources SET last_sync_at = now() WHERE id = $1`,
        [opts.sourceId],
      );
    }
    // #3479 blocker 2: quiet runs bypass the failure gate below, and an
    // orphaned `<rename:…>` sentinel would otherwise sit open forever.
    // #3583 review: NOT under --dry-run — the sweep rewrites the failure
    // ledger, and this early return sits ABOVE the dry-run gate, so an
    // unguarded sweep here made a preview clear the operator's only wedge
    // signal. (The sibling site below already sits after the dry-run
    // return, and performFullSync's dry-run return precedes both of its
    // sweep sites.)
    if (!opts.dryRun) {
      await sweepOrphanedRenameSentinels(engine, opts.sourceId ?? DEFAULT_SOURCE_ID);
    }
    return {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
      ...(uncommittedDrift ? { uncommitted: uncommittedDrift } : {}),
    };
  }

  if ((versionMismatch || versionNeverSet) && lastCommit === headCommit) {
    slog(
      `[sync] chunker_version gate: stored=${storedVersion ?? 'unset'}, current=${currentVersion}. ` +
      `Forcing full re-chunk pass (git HEAD unchanged but pipeline version advanced).`,
    );
    // #3583 gate13: NO unconditional version write here. performFullSync's
    // own gated advance writes the version exactly when the re-chunk
    // actually completed — writing it here acknowledged the version on a
    // BLOCKED run (losing the retry signal: the next run said up_to_date
    // and the failed re-walk never re-ran) and on a --dry-run PREVIEW
    // (persistent brain-state write from a preview).
    return await performFullSync(engine, fullSyncRoots, headCommit, opts);
  }

  // Diff using git diff (net result, not per-commit). v0.42.x (#1794): diff
  // against the PINNED target, not live HEAD. With a fixed (lastCommit, pin)
  // both endpoints are stable across every resume, so the manifest is
  // deterministic and resumeFilter maps cleanly onto completed paths.
  //
  // v0.42.42.0 (#2139): the diff + detached-working-tree merge now route
  // through `computeSyncDelta` (src/core/sync-delta.ts) — the SAME helper the
  // inline cost estimator uses, so the gate's dollar figure can't drift from
  // what this sync actually imports. `detachedWorkingTreeManifest` (computed
  // above for the `up_to_date` gate) is passed through to avoid recomputing it.
  //
  // #1970 (F-B): a non-ancestor diff against a wildly divergent tree (e.g. a
  // force-push to unrelated history) can exceed git()'s 30s timeout / 100 MiB
  // buffer, and a gc'd anchor object can't be diffed at all. On either
  // `unavailable`, fall back to the authoritative full reconcile instead of
  // throwing — a slow correct reconcile beats a hard error or a silent walk.
  const delta = computeSyncDelta(gitContextRoot, lastCommit, pin, {
    detachedManifest: importWorkingTree ? workingTreeManifest : null,
  });
  if (delta.status === 'unavailable') {
    serr(
      `[sync] delta ${lastCommit.slice(0, 8)}..${pin.slice(0, 8)} unavailable ` +
      `(${delta.reason}) — falling back to full reconcile.`,
    );
    return performFullSync(engine, fullSyncRoots, headCommit, opts);
  }
  const manifest = delta.manifest;

  // Scope/exclude/isSyncable filter lambdas (`inScope`/`scopeRel`/`excluded`/
  // `syncOpts`) are hoisted above the up_to_date gate — the untracked-gap
  // drift counter shares them so both apply identical predicates.
  // #1970 (F-C): a rename whose DESTINATION is unsyncable drops out of BOTH
  // `renamed` (only `r.to` is kept below) AND `deleted` (git emits it as `R`,
  // not `D`), leaving the OLD page stale. Fold the source side into the delete
  // set. isSyncable(r.from) excludes metafiles automatically, so a rename of a
  // metafile is left untouched (matching the #1433 metafile-skip invariant).
  // #774: a rename whose destination LEFT the scope is the same class — the
  // old page's backing file is gone from this source's slice of the repo.
  const renamedToUnsyncable = manifest.renamed
    .filter(r => inScope(r.from) && isSyncable(r.from, syncOpts) &&
      !(inScope(r.to) && isSyncable(r.to, syncOpts)) &&
      // A rename onto a NON-poison malformed destination (`foo.md` →
      // `notes [draft].md`) keeps the old row: the content still exists on
      // disk under the new name, it just can't re-import until renamed —
      // deleting the row here would be the rename-lane variant of the
      // reconcile data-loss class (codex re-review P1). Poisoned
      // destinations (`](`/control chars) still sweep.
      !(unsyncableReason(r.to, syncOpts) === 'malformed-path' && !isPoisonedPath(r.to)))
    .map(r => r.from);
  const filtered: SyncManifest = {
    added: manifest.added.filter(p => inScope(p) && !excluded(p) && isSyncable(p, syncOpts)),
    modified: manifest.modified.filter(p => inScope(p) && !excluded(p) && isSyncable(p, syncOpts)),
    deleted: unique([
      // 'malformed-path' deletions MUST still process: the classifier makes
      // junk filenames unsyncable, but their previously-ingested DB rows are
      // exactly what a delete event is supposed to remove — filtering them
      // out here would orphan those rows (searchable forever). Mirror of the
      // metafile carve-out, in the opposite direction.
      ...manifest.deleted.filter(p => inScope(p) &&
        (isSyncable(p, syncOpts) || unsyncableReason(p, syncOpts) === 'malformed-path')),
      ...renamedToUnsyncable,
    ]),
    renamed: manifest.renamed.filter(r => inScope(r.to) && !excluded(r.to) && isSyncable(r.to, syncOpts)),
  };

  // Surface malformed-filename skips: they were silently dropped from the
  // `filtered` manifest above, and a skip nobody can see reads as "synced".
  // Rename DESTINATIONS count too (the rename lane keeps the old row for
  // non-poison destinations, but the new name still can't import).
  const malformedSkipped = unique([
    ...[...manifest.added, ...manifest.modified]
      .filter(p => inScope(p) && unsyncableReason(p, syncOpts) === 'malformed-path'),
    ...manifest.renamed
      .filter(r => inScope(r.to) && unsyncableReason(r.to, syncOpts) === 'malformed-path')
      .map(r => r.to),
  ]);

  // #4342 'source-root' mode: translate the (git-root-relative) manifest to
  // SOURCE-relative paths so every downstream consumer — slugs, source_path,
  // deletes, renames, checkpoints — names pages the way `gbrain import
  // <local_path>` would. Under 'git-root' (or an unscoped sync) this is a
  // no-op and the pre-#4342 behavior is byte-for-byte. The file-join base
  // below (`syncImportRoot`) moves with it so `join(base, path)` still lands
  // on the same file.
  const sourceRootMode = scoped && slugRootMode === 'source-root';
  const syncImportRoot = sourceRootMode ? syncScopeRoot : gitContextRoot;
  /** Manifest path → the mode's canonical page path (slug/source_path base). */
  const modePath = (p: string): string => (sourceRootMode ? scopeRel(p) : p);
  if (sourceRootMode) {
    filtered.added = filtered.added.map(scopeRel);
    filtered.modified = filtered.modified.map(scopeRel);
    filtered.deleted = filtered.deleted.map(scopeRel);
    filtered.renamed = filtered.renamed.map(r => ({ from: scopeRel(r.from), to: scopeRel(r.to) }));
  }

  // Working-tree mass-delete valve: merged working-tree deletes bypass the
  // full-reconcile valve (#2828), but the hazard is the same — a transient
  // uncommitted tree state (mid-rebase checkout, accidental rm -rf) hit by a
  // scheduled --working-tree/config sync must not sweep the source. Same
  // ratio + same env escape hatch. Deletes are skipped loudly; adds and
  // modifies still import, and committing the deletions (or
  // GBRAIN_ALLOW_MASS_RECONCILE=1) re-enables them.
  if (importWorkingTree && !detachedHead && filtered.deleted.length >= 10 && !massReconcileAllowed()) {
    try {
      const rows = await engine.executeRaw<{ count: number }>(
        opts.sourceId
          ? `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL AND source_id = $1`
          : `SELECT count(*)::int AS count FROM pages WHERE deleted_at IS NULL`,
        opts.sourceId ? [opts.sourceId] : [],
      );
      const pageCount = Number(rows[0]?.count ?? 0);
      if (pageCount > 0 && filtered.deleted.length > pageCount * MASS_RECONCILE_RATIO) {
        serr(
          `\n  WARNING: refusing to delete ${filtered.deleted.length} page(s) from a working-tree ` +
          `sync (> ${Math.round(MASS_RECONCILE_RATIO * 100)}% of ${pageCount} page(s)). An uncommitted ` +
          `tree deleting this much is almost always transient (mid-rebase, accidental rm) — commit the ` +
          `deletions to apply them, or re-run with GBRAIN_ALLOW_MASS_RECONCILE=1. Adds/modifies still import.\n`,
        );
        filtered.deleted = [];
      }
    } catch { /* valve is best-effort — a count failure must not block the sync */ }
  }

  // NAV-4: warn when --exclude filtered out every candidate change — almost
  // always a mistyped pattern, and otherwise indistinguishable from
  // "up to date" in the output.
  if (opts.exclude && opts.exclude.length > 0) {
    const excludeCandidates = [...manifest.added, ...manifest.modified]
      .filter(p => inScope(p) && isSyncable(p, syncOpts));
    if (excludeCandidates.length > 0 && excludeCandidates.every(excluded)) {
      console.warn(
        `[gbrain sync] No files matched after applying ${opts.exclude.length} --exclude pattern(s). ` +
        `Check your --exclude flags. Patterns: ${JSON.stringify(opts.exclude)}`,
      );
    }
  }

  const totalChanges = filtered.added.length + filtered.modified.length +
    filtered.deleted.length + filtered.renamed.length;

  // Dry run
  if (opts.dryRun) {
    slog(`Sync dry run: ${lastCommit.slice(0, 8)}..${headCommit.slice(0, 8)}`);
    if (filtered.added.length) slog(`  Added: ${filtered.added.join(', ')}`);
    if (filtered.modified.length) slog(`  Modified: ${filtered.modified.join(', ')}`);
    if (filtered.deleted.length) slog(`  Deleted: ${filtered.deleted.join(', ')}`);
    if (filtered.renamed.length) slog(`  Renamed: ${filtered.renamed.map(r => `${r.from} -> ${r.to}`).join(', ')}`);
    if (malformedSkipped.length) {
      slog(`  Skipped (malformed filename — brackets/control chars; rename to import): ${malformedSkipped.map(sanitizePathForDisplay).join(', ')}`);
    }
    if (totalChanges === 0) slog(`  No syncable changes.`);
    return {
      status: 'dry_run',
      malformedSkipped: malformedSkipped.length,
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: filtered.added.length,
      modified: filtered.modified.length,
      deleted: filtered.deleted.length,
      renamed: filtered.renamed.length,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
    };
  }

  // Delete pages that became un-syncable (modified but filtered out).
  // v0.20.0 Cathedral II SP-5: resolveSlugForPath picks the right slug shape
  // (markdown vs code) based on the chunker's classifier, so a Rust file that
  // became un-syncable (e.g., moved under `.gitignore` or filtered by
  // strategy=markdown) deletes the actual code-slug page, not a ghost
  // markdown-slug that never existed.
  //
  // v0.41.13 (#1433): the original cleanup loop deleted EVERY pre-existing
  // page for unsyncable-modified paths, including `log.md`, `schema.md`,
  // `index.md`, `README.md` — files that fail `isSyncable` precisely
  // because they're metafiles by convention, not because the user
  // "removed" them from the strategy. infiniteGameExp's domain `log.md`
  // pages had been indexed by an older gbrain version (or via direct
  // put_page) and were silently dropped on every subsequent sync. The
  // fix uses `unsyncableReason` (factored from `isSyncable` so they
  // cannot drift) to skip the delete when the reason is `'metafile'`.
  //
  // Honest scope: this guard only fixes the `manifest.modified` case.
  // `manifest.deleted` is filtered upstream at sync.ts:757 via the same
  // `isSyncable` call, so `rm log.md` followed by sync also doesn't
  // delete the page. That's the same pre-fix behavior — removing the
  // page requires `gbrain pages purge-deleted` or a direct MCP delete.
  // Filed as v0.42+ follow-up for a `gbrain pages remove <slug>` surface.
  const unsyncableModified = manifest.modified.filter(p => inScope(p) && !isSyncable(p, syncOpts));
  // v0.18.0+ multi-source: scope getPage + deletePage to opts.sourceId so
  // unsyncable cleanup in source A doesn't accidentally sweep same-slug
  // pages in sources B/C/D.
  const pageOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;
  for (const path of unsyncableModified) {
    // v0.41.13 #1433: never delete on metafile classification.
    // #2404 hardening: same for 'pruned-dir' — a page under a pruned
    // directory can only exist via a deliberate put_page (sync never
    // imports those paths), so "the file was modified" is not evidence
    // the page is stale. Deleting here silently destroyed put-created
    // pages every time their materialized file landed in a commit.
    const reason = unsyncableReason(path, syncOpts);
    if (reason === 'metafile' || reason === 'pruned-dir') continue;
    // Bare-bracket markdown (pre-gate imports like `notes [draft].md`) keeps
    // its row — only the poison signature (`](`/control chars) is sweepable.
    // Deleting a legit page's row while its file sits on disk is data loss.
    if (reason === 'malformed-path' && !isPoisonedPath(path)) continue;
    // #3942: guarded resolver — never delete a page whose recorded origin is
    // a DIFFERENT file just because this path re-slugifies onto its slug.
    // #4342: resolve in the mode's namespace (source-relative under
    // 'source-root'; git-root-relative otherwise).
    const slug = await resolveRemovedPathSlug(engine, modePath(path), opts.sourceId, serr);
    if (slug === undefined) continue;
    try {
      const existing = await engine.getPage(slug, pageOpts);
      if (existing) {
        // #3583 review: this loop sits ABOVE the dry-run return below, so
        // an unguarded delete made a preview under a narrower strategy
        // hard-delete previously-imported pages. A preview only reports.
        if (opts.dryRun) {
          slog(`  [dry-run] would delete un-syncable page: ${slug}`);
        } else {
          // #4587: soft-delete (72h recovery window) instead of hard delete.
          // Scope falls back to DEFAULT_SOURCE_ID to preserve deletePage's
          // old 'default' fallback; softDeletePages requires an explicit
          // sourceId. The purge phase owns the eventual hard delete.
          await engine.softDeletePages([slug], { sourceId: opts.sourceId ?? DEFAULT_SOURCE_ID });
          slog(`  Soft-deleted un-syncable page (recoverable 72h): ${slug}`);
        }
      }
    } catch { /* ignore */ }
  }

  if (totalChanges === 0) {
    // #3068: same guard as the git-HEAD-equality gate above — a failed pull
    // plus zero imports must not produce a clean `up_to_date` (and must not
    // advance the anchor past commits this run never looked at remotely).
    // Reached when local-only commits landed with no syncable content while
    // the pull kept failing. Nothing is written; the next sync re-diffs the
    // same trivial range and retries the pull.
    if (pullFailed) {
      serr(
        `[sync] git pull failed and no syncable changes imported — reporting partial ` +
        `(not up_to_date); sync anchor unchanged at ${lastCommit.slice(0, 8)}.`,
      );
      return buildPartialResult({
        fromCommit: lastCommit,
        toCommit: lastCommit,
        filesImported: 0,
        pagesAffected: [],
        chunksCreated: 0,
        added: 0, modified: 0, deleted: 0, renamed: 0,
        reason: 'pull_failed',
      });
    }
    // Update sync state even with no syncable changes (git advanced). v0.42.x
    // (#1794): advance to the PINNED target, and clear any checkpoint (a resume
    // whose remaining range turned out to have no syncable changes still
    // completes cleanly here).
    await writeSyncAnchor(engine, opts.sourceId, 'last_commit', pin, commitTimeMs(gitContextRoot, pin), gitContextRoot);
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
    await clearOpCheckpoint(engine, ckpt.paths);
    await clearOpCheckpoint(engine, ckpt.target);
    // A commit whose ONLY changes are malformed filenames lands here with
    // totalChanges === 0 — the anchor advances past those files forever, so
    // this early return must surface the skips too (structured-review P2).
    if (malformedSkipped.length > 0) {
      serr(
        `  ${malformedSkipped.length} file(s) skipped: malformed filename ` +
        `(brackets/control chars; rename to import): ` +
        malformedSkipped.map(sanitizePathForDisplay).join(', '),
      );
    }
    // #3479 blocker 2: this early return also bypasses the failure gate —
    // sweep orphaned `<rename:…>` sentinels here too.
    await sweepOrphanedRenameSentinels(engine, opts.sourceId ?? DEFAULT_SOURCE_ID);
    return {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: pin,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
      ...(malformedSkipped.length > 0 ? { malformedSkipped: malformedSkipped.length } : {}),
    };
  }

  const noEmbed = opts.noEmbed || totalChanges > 100;
  if (totalChanges > 100) {
    slog(`Large sync (${totalChanges} files). Importing text, deferring embeddings.`);
  }

  // v0.42.x (#1794): we have real work — persist the PIN now so a crash before
  // the first path-flush still resumes to THIS target (not re-pin to a newer
  // HEAD). recordCompleted is durable (executeRawDirect + retry); a false return
  // means the pool is genuinely dead. Nothing is imported yet, so we abort
  // cleanly (zero loss) rather than draining work we could never anchor — see
  // the !pinPersisted gate just after the partial() closure below.
  const pinPersisted = await recordCompleted(engine, ckpt.target, [pin]);

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
  const completed = new Set<string>(completedPaths);
  const pendingCheckpointPaths = new Set<string>();
  const checkpointSeconds = resolveSyncCheckpointSeconds();
  const maxFlushFailures = resolveSyncMaxCheckpointFailures();
  let sinceFlush = 0;
  let lastFlushAt = Date.now();
  let consecutiveFlushFailures = 0;
  let bankedFiles = completedPaths.length;
  let flushing = false;
  let checkpointDead = false;
  // Assigned at registration (after the pinPersisted gate); called on every
  // normal return so a later operation's SIGTERM doesn't fire this stale flush.
  let deregisterCheckpointCleanup: () => void = () => {};
  const flushCheckpoint = async (): Promise<void> => {
    if (pendingCheckpointPaths.size === 0 || flushing) return;
    flushing = true;
    // Synchronous swap (atomic under single-threaded JS): take the current
    // pending set as this flush's batch; workers accumulate into a fresh set.
    const batch = [...pendingCheckpointPaths];
    pendingCheckpointPaths.clear();
    try {
      const ok = await appendCompleted(engine, ckpt.paths, batch);
      if (ok) {
        consecutiveFlushFailures = 0;
        bankedFiles += batch.length;
        opts.onProgress?.({ phase: 'import', bankedFiles });
      } else {
        // Not durably banked — re-merge so the next flush retries this batch.
        for (const p of batch) pendingCheckpointPaths.add(p);
        if (++consecutiveFlushFailures >= maxFlushFailures) checkpointDead = true;
      }
    } finally {
      flushing = false;
    }
  };
  // v0.42.x (#1794): yield the event loop every N files so the refreshing-lock
  // heartbeat timer can fire mid-import (otherwise the CPU loop starves it and
  // the live lock gets stolen — the thrash this fixes).
  const yieldEvery = resolveSyncYieldEvery();
  let sinceYield = 0;
  const maybeYield = async (): Promise<void> => {
    if (++sinceYield >= yieldEvery) {
      sinceYield = 0;
      // setTimeout(0), NOT setImmediate: the lock-refresh heartbeat is a
      // setInterval (timers phase). In Bun a tight setImmediate loop starves
      // the timers phase, so the heartbeat would never fire. setTimeout(0)
      // enters the timers phase where setInterval callbacks also run.
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  };
  const markCompleted = async (path: string): Promise<void> => {
    completed.add(path);
    pendingCheckpointPaths.add(path);
    const dueByCount = ++sinceFlush >= checkpointEvery;
    const dueByTime = Date.now() - lastFlushAt >= checkpointSeconds * 1000;
    const firstFile = completed.size === 1; // bank early on a fresh run
    if (dueByCount || dueByTime || firstFile) {
      sinceFlush = 0;
      lastFlushAt = Date.now();
      await flushCheckpoint();
    }
  };

  const pagesAffected: string[] = [];
  // #1284: slugs deleted this run (delete loop, or renamed-away old slugs are
  // NOT pushed — only confirmed deletes land here). pagesAffected stays the
  // full manifest for extract/report paths, but the auto-embed at the end
  // must NOT be handed deleted slugs: embedPage throws 'Page not found' for
  // each one and serr-logs noise. A slug re-imported later in the same run
  // (delete + re-add) is removed from this set at its push site.
  const deletedSlugs = new Set<string>();
  // issue #1939: file paths that imported cleanly this run. The failure-ledger
  // gate clears these so a previously-failing file's `attempts` streak resets
  // on success (consecutive-failure semantics for the auto-skip valve).
  const succeededPaths: string[] = [];
  let chunksCreated = 0;
  // v0.41.13.0 (T2): tracks add+modify files actually persisted so far.
  // Only bumped from inside importOnePath's success path. partial() reports
  // this as `filesImported` so cron operators can see how much work the
  // aborted run completed before --timeout fired.
  let filesImported = 0;
  const start = Date.now();

  // v0.41.13.0 (T2 + D-V3-1): closure for the partial-return path.
  // v0.42.x (#1794): now ASYNC — it banks the unflushed delta before returning
  // so a clean --timeout/SIGINT abort doesn't drop the last sub-cadence batch
  // (best-effort; skipped when checkpointDead — the pool is gone). `reason` is
  // overridden to 'checkpoint_unavailable' when the checkpoint died, and
  // `bankedFiles` is surfaced so a killed run shows banked progress instead of
  // looking like total loss. toCommit reports the PINNED target; last_commit is
  // never advanced on a partial (the next run resumes from the checkpoint).
  const partial = async (reason: 'timeout' | 'pull_timeout' | 'stall_timeout'): Promise<SyncResult> => {
    deregisterCheckpointCleanup();
    if (!checkpointDead) {
      try { await flushCheckpoint(); } catch { /* best effort — we're aborting */ }
    }
    const banked = bankedFiles;
    serr(
      `[sync] banked ${banked} file(s) this run; next 'gbrain sync' resumes from ` +
      `the checkpoint (last_commit unchanged at ${(lastCommit ?? '').slice(0, 8)}).`,
    );
    // db-availability loop (4b): a dead checkpoint IS a DB-access failure by
    // construction — the checkpoint writer only gives up after exhausting the
    // retry-matcher's connection-class retries (#1794), so `conn_dropped` is
    // asserted structurally, not parsed from an error. The marker lets the
    // bundled skills/db-repair skill pick this up from an agent-run sync.
    if (checkpointDead && shouldEmitDbAccessMarker()) {
      serr(`${DB_ACCESS_MARKER_PREFIX} conn_dropped`);
      serr('The sync checkpoint pool died mid-run. Run: gbrain db-repair');
    }
    return buildPartialResult({
      fromCommit: lastCommit,
      toCommit: pin,
      filesImported,
      pagesAffected: [...pagesAffected],
      chunksCreated,
      added: filtered.added.length,
      modified: filtered.modified.length,
      deleted: filtered.deleted.length,
      renamed: filtered.renamed.length,
      reason: checkpointDead ? 'checkpoint_unavailable' : reason,
      bankedFiles,
    });
  };

  // v0.42.x (#1794): the pin write IS the mint of this run's checkpoint. If it
  // can't persist, the pool is dead and nothing has drained — abort with zero
  // loss; the next run retries the whole range (content_hash short-circuits).
  if (!pinPersisted) {
    serr('[sync] checkpoint target write failed (pool unavailable) — aborting before import; nothing drained, next run retries.');
    checkpointDead = true;
    return await partial('timeout'); // reason → checkpoint_unavailable
  }

  // v0.42.x (#1794): an external SIGTERM (watchdog/launcher timeout — the exact
  // incident shape) exits through process-cleanup, NOT this function's control
  // flow, so it would skip every flush and bank zero. Register a best-effort,
  // NO-RETRY one-shot flush of the unflushed delta (the registry's 3s deadline
  // is shorter than withRetry's ~12s budget, so a retrying flush would be cut
  // off). Flushes paths ONLY — never clears the checkpoint or advances
  // last_commit, so the D4 invariant holds. Deregistered on every normal return.
  deregisterCheckpointCleanup = registerCleanup('sync-checkpoint', async () => {
    await appendCompletedOnce(engine, ckpt.paths, [...pendingCheckpointPaths]);
  });

  // Per-file progress on stderr so agents see each step of a big sync.
  // Phases: sync.deletes, sync.renames, sync.imports.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  // v0.41.19.0: hoisted out of the import block so the delete decompose
  // path (per-batch try-catch fallback) can append unrecoverable delete
  // failures here too. Same canonical surface that gates `sync.last_commit`
  // advancement at the bottom of this function.
  const failedFiles: Array<{ path: string; error: string; line?: number }> = [];

  // Alias-footgun visibility (schema.type_warnings, default on): aggregate
  // per-file type_warning results ONCE per distinct type per run — an
  // N-thousand-file sync must warn in O(distinct types) lines, not O(files).
  const typeWarningCounts = new Map<string, import('../core/schema-pack/type-usage.ts').TypeWarningCount>();
  const noteTypeWarning = (w: { kind: 'alias_of' | 'undeclared'; type: string; canonical?: string; directory?: string } | undefined): void => {
    if (!w) return;
    const key = `${w.kind}\t${w.type}`;
    const cur = typeWarningCounts.get(key);
    if (cur) cur.count++;
    else typeWarningCounts.set(key, { ...w, count: 1 });
  };
  let typeWarningsEnabled = true;
  try {
    const v = await engine.getConfig('schema.type_warnings');
    typeWarningsEnabled = !(v === 'false' || v === '0' || v === 'off');
  } catch { /* config unavailable → default on */ }

  // v0.41.19.0 (T2/D6/D7/D16/D18 via /plan-eng-review + codex outside-voice):
  // batched delete loop. Replaces the per-file N+1 that PR #1538 originally
  // batched on Postgres only. See plan file:
  //   ~/.claude/plans/system-instruction-you-are-working-ethereal-narwhal.md
  // #4587: the lanes below SOFT-delete (deleted_at = now(), 72h recovery
  // window) via softDeletePages; the autopilot purge phase owns the eventual
  // hard delete and a re-import within the window revives via upsert.
  //
  // SHAPE (interleaved per-batch resolve + delete; caller owns chunking):
  //
  //   filtered.deleted (e.g. 73K paths)
  //       │
  //       ▼
  //   slice into batches of DELETE_BATCH_SIZE (500)
  //       │
  //       ▼  for each batch:
  //   abort-check ──► partial('timeout')
  //       │
  //       ▼
  //   resolveSlugsForRemovedPaths(batch)             ◀── exact source_path,
  //       │                                              then VERIFIED fallback;
  //       ▼                                              foreign-origin refusals
  //   slugs = deletable.map(...)                         (#3942) warned + skipped
  //       │
  //       ▼
  //   try {
  //     deleted = engine.softDeletePages(slugs, opts) ◀── 1 SQL round-trip
  //     pagesAffected.push(...deleted)                ◀── D6: only confirmed
  //   } catch {                                           transitions, not phantoms
  //     // D7 decompose: one-element softDeletePages per slug,
  //     // unrecoverable failures → failedFiles, run continues
  //   }
  //
  // ROUND-TRIP COUNTS (73K deletes):
  //   pre-fix:   73,000 SELECTs + 73,000 DELETEs = 146,000 (~5 hours)
  //   post-fix:     146 SELECTs +     146 UPDATEs =     292 (~2 minutes)
  //
  // ATOMICITY (D3): each batch is one transaction. A mid-batch abort or
  // transient connection failure rolls back up to DELETE_BATCH_SIZE - 1
  // successful deletes. Sync is idempotent — the next run picks them up
  // via git diff regenerating the deletion list.
  //
  // NO-SOURCEID FALLBACK: when opts.sourceId is undefined (legacy unscoped
  // callers, rare post-v0.34.1 source-resolution wiring), fall back to the
  // OLD per-path loop. The batch engine surface requires sourceId per D5
  // (multi-source-bug-class defense at the type level). Production callers
  // that thread sourceId via resolveSourceWithTier get the new fast path.
  // v0.42.x (#1794): resume-filter the delete set so a resumed run skips paths
  // already drained in a prior run (deletes are idempotent, but skipping avoids
  // re-resolving + re-deleting tens of thousands of already-gone pages).
  const deletesToDo = resumeFilter(filtered.deleted, [...completed]);
  if (deletesToDo.length > 0) {
    progress.start('sync.deletes', deletesToDo.length);
    if (opts.sourceId) {
      const sid = opts.sourceId;
      const deleteScopedOpts = { sourceId: sid };
      for (let i = 0; i < deletesToDo.length; i += DELETE_BATCH_SIZE) {
        if (opts.signal?.aborted) {
          progress.finish();
          return await partial('timeout');
        }
        const batch = deletesToDo.slice(i, i + DELETE_BATCH_SIZE);

        // Phase A: guarded batch slug resolution (#3942 — a re-slugified
        // fallback can name a DIFFERENT page; refusals are logged + skipped).
        const resolution = await resolveSlugsForRemovedPaths(engine, batch, sid);
        for (const r of resolution.refused) {
          serr(refusedRemovedPathMessage(r));
          // Deliberately handled — checkpoint so a resume doesn't re-refuse.
          await markCompleted(r.path);
        }
        const deletable = batch.filter(p => resolution.slugs.has(p));
        const slugs = deletable.map(p => resolution.slugs.get(p) as string);

        // Phase B: batch soft-delete (1 round-trip per batch). #4587: the
        // removed-file drain honors the 72h recovery window — deleted_at is
        // set, the purge phase hard-deletes later, and a re-import within
        // the window revives via putPage's upsert.
        try {
          const deleted = await engine.softDeletePages(slugs, deleteScopedOpts);
          // D6: only push slugs that actually transitioned. Filters phantom
          // slugs (paths in filtered.deleted but with no DB row — or rows
          // already soft-deleted) so downstream extract/embed don't waste
          // lookups.
          pagesAffected.push(...deleted);
          for (const s of deleted) deletedSlugs.add(s);
          // v0.42.x (#1794): the whole batch is handled (soft-deleted,
          // already gone, or refused above); checkpoint every path so a
          // resume skips it.
          for (const p of deletable) await markCompleted(p);
        } catch (err) {
          // D7 decompose: a transient blip on this batch shouldn't lose all
          // 500 deletes. Fall back to one-element softDeletePages batches
          // for THIS batch only (per-slug isolation, same primitive);
          // unrecoverable per-slug failures land in failedFiles and the run
          // CONTINUES (--skip-failed semantics), matching the existing
          // import-loop pattern.
          for (let j = 0; j < slugs.length; j++) {
            try {
              await engine.softDeletePages([slugs[j]], deleteScopedOpts);
              pagesAffected.push(slugs[j]);
              deletedSlugs.add(slugs[j]);
              await markCompleted(deletable[j]);
            } catch (perSlugErr) {
              failedFiles.push({
                path: deletable[j],
                error: `delete failed: ${perSlugErr instanceof Error ? perSlugErr.message : String(perSlugErr)} (batch error: ${err instanceof Error ? err.message : String(err)})`,
              });
            }
          }
        }
        progress.tick(batch.length, `deletes ${Math.min(i + DELETE_BATCH_SIZE, deletesToDo.length)}/${deletesToDo.length}`);
        await maybeYield();
      }
    } else {
      // Legacy no-sourceId path. The engine batch methods require sourceId
      // per D5 (kills the multi-source-bug-class on the new surface); when
      // sourceId is unset, fall back to the original per-path loop. Slow
      // but correct; production callers all thread sourceId so this branch
      // is functionally dead post-v0.34.1.
      for (const path of deletesToDo) {
        if (opts.signal?.aborted) {
          progress.finish();
          return await partial('timeout');
        }
        // #3942: same guarded resolver as the batched lane (single-path call).
        const slug = await resolveRemovedPathSlug(engine, path, undefined, serr);
        if (slug === undefined) {
          await markCompleted(path);
          progress.tick(1, path);
          continue;
        }
        try {
          // #4587: soft-delete with the same 'default' fallback the old
          // optional-opts deletePage call applied on this legacy lane
          // (opts.sourceId is undefined here by construction).
          await engine.softDeletePages([slug], { sourceId: opts.sourceId ?? DEFAULT_SOURCE_ID });
          pagesAffected.push(slug);
          deletedSlugs.add(slug);
          await markCompleted(path);
        } catch (err) {
          failedFiles.push({
            path,
            error: `delete failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        progress.tick(1, slug);
      }
    }
    progress.finish();
  }

  // Process renames (updateSlug preserves page_id, chunks, embeddings).
  // SP-5: both old and new slugs use resolveSlugForPath so a .ts → .ts
  // rename (code→code), .md → .md (markdown→markdown), or cross-kind rename
  // all resolve to the right slug shape for each side.
  //
  // v0.41.19.0 (T4): pre-batched slug resolution per Phase 3 of the plan.
  // Renames' per-file cost is dominated by importFile() (file IO + chunking
  // + embedding), so the per-iteration updateSlug + importFile loop stays;
  // only the upfront slug-resolve N+1 gets batched. The try/catch around
  // updateSlug for slug-doesn't-exist preserves verbatim.
  // v0.42.x (#1794): resume-filter renames on the destination path.
  const renamesToDo = filtered.renamed.filter(r => !completed.has(r.to));
  if (renamesToDo.length > 0) {
    progress.start('sync.renames', renamesToDo.length);
    // v0.18.0+ multi-source: scope updateSlug so the rename only touches the
    // source-A row, not every same-slug row across sources (which would
    // either sweep them all OR violate (source_id, slug) UNIQUE).
    const renameOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;

    // #3583 review: lazily-built (at most once per run) tracked-file slug
    // index for the live-row filter in the reconcile below. A throw from the
    // index build surfaces inside the reconcile's own try/catch, where it
    // records the `<rename:…>` sentinel — fail-closed, never a guessed delete.
    // Liveness = tracked in the git index, deliberately NOT "present on
    // disk": sync's ground truth is git, and in a sparse/partial checkout a
    // tracked file is intentionally absent from the working tree — an
    // on-disk check would misclassify its live page as stale and delete it,
    // the same failure shape this filter exists to prevent.
    // Three-way verdict, not boolean: when the index is incomplete (an
    // unreadable fallback-regime file — see trackedSlugIndex), an index miss
    // proves nothing, so the row is spared as 'unknown' rather than deleted.
    let treeSlugIndex: TrackedSlugIndex | undefined;
    const slugLiveness = (s: string): 'live' | 'stale' | 'unknown' => {
      // lastCommit = the commit the brain reflects; its blob is one of the
      // consulted content states (see fallbackSlugsForFile).
      treeSlugIndex ??= trackedSlugIndex(gitContextRoot, lastCommit);
      if (treeSlugIndex.slugs.has(s)) return 'live';
      return treeSlugIndex.complete ? 'stale' : 'unknown';
    };

    // #3583 review (GATE6): the old slug of EVERY rename in this diff. A
    // row can be CARRIED by a different rename in the same diff whose
    // destination derives no slug (ordinary path → exotic path, frontmatter
    // absent): no current path, blob, or anchor state names its slug, but
    // the rename pair itself proves the content is still tracked. The
    // reconcile of rename R therefore spares candidates that are ANOTHER
    // rename's old slug; R's OWN old slug stays deletable — that is
    // exactly the duplicate the reconcile exists to remove once the
    // destination materializes. Built over the RAW manifest — not the
    // scope/exclude/resume-filtered list — so a carried row is protected
    // even when its own rename was filtered out of processing (an
    // --exclude'd or out-of-scope destination still proves the content is
    // tracked; registration is purely spare-side).
    // Each from-path maps to a SET of slugs, never one: source_path is
    // non-unique, so a DB resolve can return an UNRELATED row's slug
    // (stale bookkeeping naming the same path) and silently displace the
    // path-derived slug the carried-spare depends on — the carried row
    // then lost its protection and the GATE6 delete came back. The set
    // always holds the path-derived slug (when the path derives one)
    // PLUS every active row's slug under that source_path; registration
    // is purely spare-side, so over-inclusion only delays a cleanup.
    // Spare-side only: a resolve failure merely shrinks the DB half of the
    // set, and the path-derived entries still protect the carried row.
    let dbSlugsByFrom = new Map<string, string[]>();
    try {
      dbSlugsByFrom = await activeSlugsBySourcePath(
        engine, manifest.renamed.map(r => r.from), opts.sourceId ?? DEFAULT_SOURCE_ID,
        opts.signal,
      );
    } catch { /* see above — both consumers degrade safely */ }
    const renameOldSlugs = new Map<string, Set<string>>();
    for (const r of manifest.renamed) {
      const shapes = new Set<string>();
      const derived = resolveSlugForPath(r.from);
      if (derived !== '') shapes.add(derived);
      for (const s of dbSlugsByFrom.get(r.from) ?? []) shapes.add(s);
      renameOldSlugs.set(r.from, shapes);
    }

    // T4: pre-resolve ALL `from` slugs in batches before iterating. Falls
    // back to per-path resolveSlugByPathOrSourcePath when sourceId is
    // unset (matches the delete loop's legacy posture). For large rename
    // commits (rare but possible: prefix sweep, reorganization), this drops
    // the slug-resolve round-trips from O(renames) to O(renames/500).
    const fromSlugByPath = new Map<string, string>();
    if (opts.sourceId) {
      const sid = opts.sourceId;
      const fromPaths = renamesToDo.map(r => r.from);
      for (let i = 0; i < fromPaths.length; i += DELETE_BATCH_SIZE) {
        if (opts.signal?.aborted) {
          progress.finish();
          return await partial('timeout');
        }
        const batch = fromPaths.slice(i, i + DELETE_BATCH_SIZE);
        let m: Map<string, string>;
        try {
          m = await engine.resolveSlugsByPaths(batch, { sourceId: sid });
        } catch {
          m = new Map();
        }
        for (const p of batch) {
          fromSlugByPath.set(p, m.get(p) ?? resolveSlugForPath(p));
        }
      }
    }

    // Is a `<rename:…>` sentinel for this destination already open from an
    // earlier run? Read once per run: the ledger is only rewritten at the
    // gate, after this loop.
    const openRenameSentinels = new Set(
      loadSyncFailures()
        .filter(f => f.source_id === (opts.sourceId ?? DEFAULT_SOURCE_ID) && f.state === 'open')
        .map(f => f.path),
    );
    const renameSentinelAlreadyOpen = (to: string): boolean =>
      openRenameSentinels.has(renameSentinelPath(to));

    for (const { from, to } of renamesToDo) {
      // v0.41.13.0 (T2 / D-V4-2): per-iteration abort check. Renames call
      // importFile() at line 1173-style sites which can be slow on big files;
      // refactor commits with 200+ renames must respect --timeout.
      if (opts.signal?.aborted) {
        progress.finish();
        return await partial('timeout');
      }
      // T4: the batch-resolved slug for `from` (see fromSlugByPath above).
      const oldSlug = opts.sourceId
        ? (fromSlugByPath.get(from) ?? resolveSlugForPath(from))
        : await resolveSlugByPathOrSourcePath(engine, from, undefined);
      // The new path doesn't yet have a row, so resolve from path only.
      const newSlug = resolveSlugForPath(to);
      // #3056: the cheap rename is OBSERVED, not assumed. A zero-row UPDATE
      // doesn't throw, and a thrown collision used to be swallowed by an
      // empty catch — both fell through to importFile, which created/updated
      // the row at the new path while the old row stayed behind live. Both
      // shapes now fall through to the reconcile below.
      let renameApplied = false;
      if (oldSlug !== '') {
        try {
          renameApplied = (await engine.updateSlug(oldSlug, newSlug, renameOpts)) > 0;
        } catch {
          // Destination slug occupied or invalid — treat as add; the
          // reconcile below removes the stale old row once the destination
          // materialized.
        }
      }
      if (renameApplied) {
        // #3583 gate13: the cheap rename moves the ROW but updateSlug never
        // rewrites source_path — and the unchanged-content reimport below is
        // a no-write skip, so the stale bookkeeping survived indefinitely
        // and the full-sync purge later read it as "source file removed"
        // and hard-deleted the LIVE renamed page. Repair the bookkeeping at
        // the moment the rename lands. Best-effort, and nothing downstream
        // covers a miss: rows renamed BEFORE this repair — and rows whose
        // repair query fails — keep the stale path and stay exposed to the
        // full-sync purge exactly as they are on master. That exposure is
        // pre-existing (verified against the merge base) and out of scope
        // here; this repair stops the shape being manufactured going
        // forward.
        try {
          // Scope EXACTLY the way updateSlug scoped the move it repairs:
          // no sourceId means the DEFAULT source, never every source — an
          // unqualified UPDATE rewrote a matching (slug, source_path) row
          // in ANOTHER source, and that source's later fallback reconcile
          // probed the rewritten path, found nothing, and advanced without
          // its rename sentinel (gate 14).
          await engine.executeRaw(
            `UPDATE pages SET source_path = $1 WHERE source_id = $2 AND slug = $3 AND source_path = $4`,
            [to, opts.sourceId ?? DEFAULT_SOURCE_ID, newSlug, from],
          );
        } catch { /* bookkeeping only — never fail the rename over it */ }
      }
      // Reimport at new path (picks up content changes). Wrapped to match the
      // deletes/adds loops: a malformed renamed file is recorded to failedFiles
      // and skipped, NOT thrown uncaught. importFile still throws on content
      // sanity-block, duplicate-slug, and missing-link endpoints; an uncaught
      // throw here crashes the whole sync mid-run and freezes the checkpoint,
      // defeating --skip-failed. A `skipped` result carrying an error is also
      // captured so the failure is recorded rather than silently dropped.
      // Paths from git diff are relative to gitContextRoot — except under
      // #4342's 'source-root' mode, where the filtered manifest (this loop's
      // source) was remapped scope-relative; the join base moves with it.
      // NAV-1 TOCTOU: refuse a destination that realpath-resolves outside the
      // repo (committed symlink pointing out).
      // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal -- `to` is a git-diff rename path from the synced repo (repo content can be hostile), but the joined path is used ONLY inside the isPathSafe(filePath, gitContextRoot) realpath containment check on the next line — a path escaping the repo root (dot-dot or committed symlink) is refused before any read
      const filePath = join(syncImportRoot, to);
      let importResult: Awaited<ReturnType<typeof importFile>> | undefined;
      // #2683 residual: a failed destination import (status 'error' OR a
      // throw) must not checkpoint `to` — the resume filter would skip the
      // rename forever, leaving the target permanently unimported.
      let importErrored = false;
      if (existsSync(filePath) && isPathSafe(filePath, gitContextRoot)) {
        try {
          // #2683: dispatch renamed images to importImageFile (binary bytes
          // through importFile threw UTF-8 errors). Same gate as import.ts.
          const result = isImageImportPath(to) && process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true'
            ? await importImageFile(engine, filePath, to, { noEmbed, sourceId: opts.sourceId })
            : await importFile(engine, filePath, to, { noEmbed, sourceId: opts.sourceId, activePack: syncActivePack });
          importResult = result;
          noteTypeWarning(result.type_warning);
          if (result.status === 'imported') chunksCreated += result.chunks;
          else if (result.status === 'skipped' && result.skip_reason === 'malformed_path') {
            // Informational skip — a bracket/control-char filename can never
            // import; counting it as a failure would gate the bookmark forever.
            serr(`  Skipped (malformed filename): ${sanitizePathForDisplay(to)}`);
          } else if (result.status === 'skipped' && (result as { error?: string }).error) {
            // An errored skip (frontmatter slug-authority rejection, invalid
            // YAML, symlink refusal, oversize file, ...) means the
            // destination never materialized — same as status 'error' below,
            // this must gate the success sentinel + markCompleted(to), or a
            // resumed sync would treat the rename as permanently done.
            importErrored = true;
            failedFiles.push({ path: to, error: String((result as { error?: string }).error) });
          } else if (result.status === 'error') {
            // importImageFile (and importFile's frontmatter gate) report
            // failures as status 'error', which no branch above recorded —
            // the rename silently succeeded with a dead target.
            importErrored = true;
            failedFiles.push({ path: to, error: String((result as { error?: string }).error ?? 'import error') });
          }
        } catch (e: unknown) {
          importErrored = true;
          failedFiles.push({ path: to, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // #3056 reconcile: the rename fell back to add semantics, so the row
      // that still represents the OLD path is the stale half of the rename
      // (git reported the old path gone; a plain delete of that path would
      // remove this row). Two safety rails, both from the #3252 review:
      //
      //   1. Delete only after the destination demonstrably materialized —
      //      `imported`, or an errorless `skipped` AT the new slug. Identity
      //      dedup can skip against the OLD row (result.slug === oldSlug),
      //      in which case nothing landed at newSlug and deleting the old
      //      row would destroy the only copy.
      //   2. Locate the stale row POSITIVELY by `source_path = from`, never
      //      by the oldSlug guess — after a collision, a path-derived
      //      fallback slug could name an unrelated (e.g. manually curated)
      //      row. No source_path match → nothing is deleted (this also means
      //      code-strategy imports, which don't populate source_path, fall
      //      back safely to leaving the old row rather than guessing).
      //
      // A failed delete records a `<rename:…>` SENTINEL (not an ordinary
      // path failure): the gate hard-blocks the bookmark, and — unlike a
      // plain path row — the auto-skip valve can never chronic-skip it after
      // N attempts, which would advance the bookmark and make a transient
      // delete outage a permanent duplicate. The sentinel clears through the
      // ordinary success path once the rename converges on a later run.
      let reconcileFailed = false;
      if (!renameApplied && importResult !== undefined) {
        const destMaterialized = importResult.status === 'imported' ||
          (importResult.status === 'skipped' && !importResult.error && importResult.slug === newSlug);
        if (destMaterialized) {
          // Hoisted above the try so the failure record can name the exact
          // row `gbrain delete` should remove when the DELETE itself failed
          // (still unknown — recorded as `?` — when the probe threw first).
          //
          // ACTIVE rows only, considering EVERY row with the old path:
          // source_path is non-unique, and a one-row resolve could hand back
          // a soft-deleted row while a live duplicate sharing the path hides
          // behind it (#3479 review). Skipping already-soft-deleted rows is
          // also what makes `gbrain delete` (a soft delete) the documented
          // operator exit from a permanent delete-failure wedge (blocker 1):
          // retrying the hard delete against a row the operator already
          // removed would just re-fail and keep the sync blocked.
          // Rows whose CURRENT slug a working-tree file still derives to are
          // LIVE, not stale, and are filtered out before any delete (#3583
          // review) — so `staleSlug` below (and the sentinel/remedy text it
          // feeds) can only ever name a genuinely-stale row.
          let staleSlug: string | undefined;
          try {
            const active = await activeSlugsBySourcePath(
              engine, [from], opts.sourceId ?? DEFAULT_SOURCE_ID,
            );
            // #3583 review (data-loss blocker): `source_path = from` also
            // matches LIVE pages — after an ordinary cheap rename the
            // surviving row keeps the OLD path (updateSlug never rewrites
            // source_path; an unchanged-content re-import writes nothing).
            // Delete only rows whose CURRENT slug no tracked file derives
            // to; spare the rest — 'live' when a tracked file still derives
            // to the slug, 'unknown' when staleness could not be proven.
            const candidates = (active.get(from) ?? []).filter(s => s !== newSlug);
            const staleSlugs: string[] = [];
            const unprovable: string[] = [];
            for (const s of candidates) {
              // Carried by ANOTHER rename in this diff (see renameOldSlugs):
              // its content is still tracked even when no slug state names
              // it anymore — never a reconcile target of THIS rename.
              let carriedByOtherRename = false;
              for (const [rFrom, rOldSlugs] of renameOldSlugs) {
                if (rFrom !== from && rOldSlugs.has(s)) { carriedByOtherRename = true; break; }
              }
              if (carriedByOtherRename) {
                serr(
                  `  [sync] rename reconcile: skipping row ${s} — another rename in ` +
                  `this diff still carries it (source_path ${from} is stale bookkeeping).`,
                );
                continue;
              }
              const verdict = slugLiveness(s);
              if (verdict === 'live') {
                serr(
                  `  [sync] rename reconcile: skipping live row ${s} — a tracked ` +
                  `file still derives to it (source_path ${from} is stale bookkeeping).`,
                );
              } else if (verdict === 'unknown') {
                // An unreadable tracked file could own this slug, so the row
                // is NOT deleted. What happens to the RENAME depends on
                // whether it was already unresolved (see the check after this
                // loop): a first unprovable run is accepted and banks
                // normally — the usual cause is a live row whose slug merely
                // could not be read (content filter, shallow clone, sparse
                // checkout, over-size file), where nothing is pending — but a
                // rename that already carries an open sentinel is not
                // retired on this evidence.
                unprovable.push(s);
                serr(
                  `  [sync] rename reconcile: cannot prove row ${s} stale — an ` +
                  `unreadable tracked file could still own this slug, so it is ` +
                  `spared rather than deleted.`,
                );
              } else {
                // Established bookkeeping cleanup (#3056 → gate 6): a stale
                // claimant is exactly the duplicate the reconcile exists to
                // remove once the destination materialized.
                staleSlugs.push(s);
              }
            }
            if (staleSlugs.length > 0) {
              // Delete every genuinely-stale active row still carrying the
              // old path — with a non-unique source_path there can be more
              // than one, and the rename is checkpointed after this loop, so
              // a survivor would never be retried (#3479 review, the ORDER BY
              // finding).
              //
              // Post-review note: the `slugLiveness(s)` verdict above and this
              // `deletePage` are not one atomic operation — `deletePage` takes
              // only `slug`, not a row id or updated_at, so it can't express
              // "delete iff still the row I just proved stale". Under
              // `performSync`'s per-source writer lock this window is closed
              // for every normal caller (no other sync/import for this source
              // can run concurrently); it only opens for a write that bypasses
              // the lock entirely (e.g. a direct `put_page` racing this run).
              // Closing it for real needs a conditional DELETE (id/source_path/
              // updated_at) added to `BrainEngine.deletePage` on both engines —
              // out of scope for this fix; tracked as a known gap rather than
              // silently assumed safe.
              for (const s of staleSlugs) {
                staleSlug = s;
                // #4587: soft-delete the stale claimant (72h recovery) —
                // candidates come from activeSlugsBySourcePath, so every s
                // is an ACTIVE row and the flip always applies. Same scope
                // fallback updateSlug/renameOpts use ('default' when the
                // caller threads no sourceId).
                await engine.softDeletePages([s], { sourceId: opts.sourceId ?? DEFAULT_SOURCE_ID });
                deletedSlugs.add(s); // never hand a deleted slug to auto-embed
                serr(`  [sync] rename reconciled: soft-deleted stale row ${s} (recoverable 72h; ${from} -> ${to} fell back to add).`);
              }
            } else if (candidates.length > 0) {
              serr(`  [sync] rename fallback: every active row with source_path ${from} was spared (live or unprovable); nothing stale to reconcile.`);
            } else {
              serr(`  [sync] rename fallback: no active row has source_path ${from}; nothing left to reconcile.`);
            }
            if (unprovable.length > 0 && renameSentinelAlreadyOpen(to)) {
              // Provably-stale rows above were still removed; these were not
              // provable either way. On its own that is an accepted cost (see
              // the verdict comment). But an EARLIER run already recorded a
              // `<rename:…>` sentinel for this rename, so convergence has been
              // denied before — and falling through would hand that sentinel
              // to the success path, which the gate clears before it decides.
              // Clearing a non-convergence marker requires proof of
              // convergence, and 'unprovable' is not proof.
              // Deliberately NOT named: `staleSlug` feeds the sentinel's
              // "stale row X" slot and the blocked-run remedy tells the
              // operator to `gbrain delete X`. An unprovable row may well be
              // LIVE — that is the whole reason it was spared — so naming one
              // here would tell the operator to delete a page this very code
              // just refused to delete. Clearing it also drops whatever
              // actionable slug an earlier failure had recorded. `undefined`
              // renders as `?`, which is the truth: not known.
              staleSlug = undefined;
              throw new Error(
                `staleness unprovable for ${unprovable.length} row(s) ` +
                `(${unprovable.join(', ')}): the tracked-file slug index is ` +
                `incomplete, so no index miss proves a row stale, and this ` +
                `rename was already unresolved. Fix or remove the unreadable ` +
                `tracked file and re-run.`,
              );
            }
          } catch (e: unknown) {
            reconcileFailed = true;
            failedFiles.push({
              path: renameSentinelPath(to),
              error: renameReconcileErrorMessage(
                from, staleSlug, e instanceof Error ? e.message : String(e),
              ),
            });
          }
        } else {
          serr(
            `  [sync] rename fallback: ${from} -> ${to} did not materialize at ${newSlug} ` +
            `(import ${importResult.status}); old row left in place.`,
          );
        }
      }
      // Converged (cheap rename, clean reconcile, or nothing to reconcile):
      // clear any `<rename:…>` sentinel a previous failing run recorded.
      // A run that spared an UNPROVABLE row reaches here too — that is the
      // accepted cost of never deleting without proof — EXCEPT when this
      // rename already had a sentinel open, which the reconcile turns into
      // a failure above precisely so this line cannot retire it. #2683
      // residual (#4496): a failed destination import likewise cannot retire
      // the sentinel — the rename did not converge.
      if (!reconcileFailed && !importErrored) succeededPaths.push(renameSentinelPath(to));
      pagesAffected.push(newSlug);
      deletedSlugs.delete(newSlug); // #1284: rename landed on a previously-deleted slug → embeddable again
      // A failed reconcile OR a failed destination import must NOT checkpoint:
      // banking `to` would make the resume filter skip this rename on the
      // retry run — a permanent duplicate (reconcile) or a permanently
      // unimported target (import error) — the exact bug class being fixed.
      if (!reconcileFailed && !importErrored) await markCompleted(to);
      progress.tick(1, newSlug);
    }
    progress.finish();
  }

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

  // v0.22.13 (PR #490 Q5): one source of truth for the concurrency decision.
  // engine.kind === 'pglite' → forced 1; explicit opts.concurrency wins;
  // auto path returns DEFAULT_PARALLEL_WORKERS only when fileCount > 100.
  const explicitConcurrency = opts.concurrency !== undefined;
  let effectiveConcurrency = autoConcurrency(engine, importsToDo.length, opts.concurrency);
  // v0.42.x (#1794, 4A): clamp the worker fan-out under GBRAIN_MAX_CONNECTIONS
  // (opt-in; no-op when unset). The parent engine holds ~resolvePoolSize()
  // connections; each parallel worker opens its own pool of
  // min(2, resolvePoolSize(2)). When the budget can't fit even one extra
  // worker, the clamp returns 1 and we fall through to the serial path
  // (parent pool only). The doctor `pool_budget` nudge covers the case where
  // the parent pool alone already exceeds the budget.
  const maxConnections = resolveMaxConnections();
  if (maxConnections !== undefined && engine.kind !== 'pglite') {
    const { resolvePoolSize } = await import('../core/db.ts');
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
  const runParallel = shouldRunParallel(effectiveConcurrency, importsToDo.length, explicitConcurrency);

  if (importsToDo.length > 0) {
    progress.start('sync.imports', importsToDo.length);

    // Core import logic shared by serial and parallel paths.
    // Paths from git diff are relative to gitContextRoot; under #4342's
    // 'source-root' mode the filtered manifest was remapped scope-relative,
    // so the join base moves to syncScopeRoot with it.
    const syncRepoPath = syncImportRoot;
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
    let stallAborted = false;
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
          stallAborted = true;
          stallController.abort();
        }
      }, Math.min(5000, stallMs));
      // Don't keep the process alive on the watchdog alone.
      (stallTimer as unknown as { unref?: () => void }).unref?.();
      opts = { ...opts, signal: composeAbortSignals(opts.signal, stallController.signal) };
    }

    async function importOnePath(eng: BrainEngine, path: string): Promise<void> {
      const filePath = join(syncRepoPath, path);
      if (!existsSync(filePath)) {
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
        await markCompleted(path);
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
      if (!isPathSafe(filePath, gitContextRoot)) {
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
            : importFile(eng, filePath, path, { noEmbed, sourceId: opts.sourceId, activePack: syncActivePack }));
        noteTypeWarning(result.type_warning);
        if (result.status === 'imported') {
          chunksCreated += result.chunks;
          pagesAffected.push(result.slug);
          deletedSlugs.delete(result.slug); // #1284: deleted-then-re-added in the same run → embeddable again
          // issue #1939: record the file path (not slug) so the gate clears any
          // prior failure-ledger row — success resets the auto-skip attempt streak.
          succeededPaths.push(path);
          // v0.41.13.0 (T2): bump filesImported on every successful
          // persist. partial() reports this so cron operators see how
          // much actually landed before --timeout fired.
          filesImported++;
          // v0.42.x (#1794): checkpoint this path so a kill banks it.
          await markCompleted(path);
        } else if (result.status === 'skipped' && result.skip_reason === 'malformed_path') {
          // Informational skip (bracket/control-char filename): never a
          // failure, and stable across runs — checkpoint it as done so a
          // resumed sync doesn't re-attempt it forever.
          serr(`  Skipped (malformed filename — rename to import): ${sanitizePathForDisplay(path)}`);
          await markCompleted(path);
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
          await markCompleted(path);
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
      await maybeYield();
      // paced-backfill: cooperative DB-contention pace between files (no-op when
      // unpaced). pace() throws AbortError on cancel; the loops break on
      // signal.aborted, so swallow it here.
      try {
        await pacer.pace(opts.signal);
      } catch (e) {
        if (!(e instanceof AbortError)) throw e;
      }
    }

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
            return await partial(stallAborted ? 'stall_timeout' : 'timeout');
          }
          await importOnePath(engine, path);
        }
      } else {
        const { PostgresEngine } = await import('../core/postgres-engine.ts');
        const { resolvePoolSize } = await import('../core/db.ts');
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
                if (opts.signal?.aborted || checkpointDead) break;
                const idx = queueIndex++;
                if (idx >= importsToDo.length) break;
                await importOnePath(eng, importsToDo[idx]);
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
          return await partial(stallAborted ? 'stall_timeout' : 'timeout');
        }
        await importOnePath(engine, path);
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

    progress.finish();

    // v0.41.13.0 (T2): post-parallel-loop abort check. The parallel
    // workers exit via `break` inside their while loop when signal
    // aborts; Promise.all then resolves, and we land here. Without
    // this check, an aborted parallel sync would silently advance to
    // the bookmark write below. By returning partial here, we preserve
    // the D-V3-1 invariant that abort means "never advance last_commit."
    if (opts.signal?.aborted) {
      return await partial(stallAborted ? 'stall_timeout' : 'timeout');
    }
  }

  // v0.42.x (#1794): if checkpoint persistence died mid-run (pool dead through
  // the whole retry budget), do NOT advance last_commit — return a
  // checkpoint_unavailable partial so the next run re-drains (content_hash
  // short-circuits the re-import). partial() overrides the reason when
  // checkpointDead is set.
  if (checkpointDead) {
    return await partial('timeout');
  }

  // v0.42.x (#1794): bank the final completed set before the gate so a block /
  // rewrite still persists everything drained this run (the next run resumes).
  await flushCheckpoint();
  // Past the final flush we're on a terminal path (blocked or success); both
  // either leave the checkpoint in place (blocked) or clear it (success), so the
  // SIGTERM one-shot flush has nothing left to add. Deregister so a SIGTERM
  // during the success-path git/anchor writes doesn't fire a stale flush.
  deregisterCheckpointCleanup();

  // v0.42.x (#1794, T3): pin-reachability gate, replacing the pre-v0.42 strict
  // "HEAD == captured" head-drift gate. CODEX-3 originally blocked on ANY HEAD
  // movement to catch external `git checkout`/`reset` that would make the
  // imported chunks reflect a different tree. But the #1794 repro has an enrich
  // process committing to the SAME repo every ~2 min, so the strict gate
  // blocked every run — a co-equal cause of non-convergence. Under pinning we
  // drain a FIXED lastCommit..pin range, so:
  //   - HEAD == pin           → nothing moved; advance.
  //   - HEAD is descendant of pin (forward progress) → SAFE. The new commits
  //     are outside this run's range and get picked up by the next sync's
  //     pin..HEAD diff. Advance to pin.
  //   - pin NOT an ancestor of HEAD (history REWRITE / reset / force-push) →
  //     the tree we imported against is gone. Block; do not advance.
  let headVerificationSucceeded = false;
  try {
    const currentHead = git(gitContextRoot, ['rev-parse', 'HEAD']);
    if (currentHead !== pin) {
      let pinStillReachable = false;
      try {
        git(gitContextRoot, ['merge-base', '--is-ancestor', pin, currentHead]);
        pinStillReachable = true;
      } catch {
        pinStillReachable = false;
      }
      if (!pinStillReachable) {
        failedFiles.push({
          path: '<head>',
          error: `git history rewritten during sync: pinned target ${pin.slice(0, 8)} is no longer an ancestor of HEAD ${currentHead.slice(0, 8)}`,
        });
      } else {
        headVerificationSucceeded = true;
      }
      // else: forward progress (enrich committed on top) — safe, advance to pin.
    } else {
      headVerificationSucceeded = true;
    }
  } catch (e) {
    // rev-parse failure is itself a drift signal (worktree disappeared).
    failedFiles.push({
      path: '<head>',
      error: `git HEAD verification failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const elapsed = Date.now() - start;

  // issue #1939 — gate the bookmark through the shared failure ledger.
  //   • Fresh failures still BLOCK (fail-closed): the next sync re-walks the
  //     diff and re-attempts. Escape hatch: --skip-failed.
  //   • A file that fails >= threshold consecutive syncs AUTO-SKIPS so a poison
  //     file can't wedge all indexing forever (recorded, surfaced by doctor).
  //   • A `<head>` SENTINEL (history rewrite) HARD-BLOCKS even with
  //     --skip-failed — advancing would record a commit that no longer matches
  //     the indexed tree.
  // `advance` is the bookmark write; the gate runs it ONLY when advancing, and
  // ALWAYS before marking anything auto-skipped/acknowledged (crash-atomic).
  const advance = async (): Promise<void> => {
    // v0.42.x (#1794): advance to the PINNED target (not live HEAD) — commits
    // past the pin are the next sync's pin..HEAD diff. `commitTimeMs(pin)` stamps
    // newest_content_at against the commit we drained to. `last_sync_at` is bumped
    // HERE and ONLY here so the autopilot scheduler never sees a stuck source as
    // "fresh". The checkpoint rows clear here — CONVERGENCE CONTRACT: sync
    // convergence == IMPORT convergence; downstream extract/facts/embed is
    // decoupled (its own resumable stale sweeps).
    await writeSyncAnchor(engine, opts.sourceId, 'last_commit', pin, commitTimeMs(gitContextRoot, pin), gitContextRoot);
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeSyncAnchor(engine, opts.sourceId, 'repo_path', anchorPath);
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
    await clearOpCheckpoint(engine, ckpt.paths);
    await clearOpCheckpoint(engine, ckpt.target);
  };

  // issue #1939 adversarial finding #1: a file that failed to parse (open ledger
  // row) and is then deleted/renamed-away never re-enters failedFiles and never
  // imports, so its row would never clear and would age doctor to a permanent
  // FAIL. Treat removed paths as resolved so the ledger self-heals.
  const resolvedPaths = [
    ...succeededPaths,
    ...filtered.deleted,
    ...filtered.renamed.map(r => r.from),
    // A prior transient rev-parse timeout records a hard-blocking sentinel that
    // operators cannot acknowledge manually. Once pin ancestry is verified on
    // a later run, clear that stale sentinel through the ordinary success path.
    ...(headVerificationSucceeded ? ['<head>'] : []),
  ];

  const gate = await applySyncFailureGate({
    sourceId: opts.sourceId ?? DEFAULT_SOURCE_ID,
    failedFiles,
    succeededPaths: resolvedPaths,
    commit: pin,
    skipFailed: opts.skipFailed === true,
    advance,
  });
  // #3479 blocker 2 — self-heal for orphaned `<rename:…>` sentinels: a
  // force-push that invalidates the pinned target means the rename never
  // re-enters the diff, so the ordinary convergence path above can never
  // clear the row and doctor ages it to a permanent FAIL no CLI can fix.
  // Deliberately AFTER the gate and OUTSIDE it (#3583): the gate used to
  // clear these via succeededPaths, which cleared BEFORE advance() — a
  // throwing advance then lost the sentinel with the verify never reached.
  // Out here, a gate that throws never clears anything (fail-closed), and
  // the sweep carries the full clear-then-verify-restore semantics.
  await sweepOrphanedRenameSentinels(
    engine, opts.sourceId ?? DEFAULT_SOURCE_ID, new Set(failedFiles.map(f => f.path)),
  );

  if (!gate.advanced) {
    const codeBreakdown = formatCodeBreakdown(failedFiles);
    // Two sentinel classes block here: `<head>` (pin ancestry broken) and
    // `<rename:…>` (#3056 — a rename-reconcile delete failed and advancing
    // would permanently bank the duplicate). Pick the message by which fired —
    // and when BOTH fired, the rename detail is appended to the head message
    // rather than silently losing to it (#3479 review).
    const renameRows = failedFiles.filter(f => f.path.startsWith(RENAME_SENTINEL_PREFIX));
    // The failing rows verbatim (path + error): the error names the stale
    // slug and the old path, which the operator remedy below points at —
    // a code-count breakdown alone can't tell them which row to delete.
    const renameDetail = renameRows.map(f => `  ${f.path}: ${f.error}`).join('\n');
    // #3479 blocker 1 — the sentinel hard-blocks even --skip-failed by
    // design, so an environment where the DELETE can never succeed (RLS
    // denying DELETE, an FK RESTRICT) needs a documented exit or a cosmetic
    // duplicate becomes a total sync outage. The remedy is deliberately NOT
    // pitched at a fully read-only database: 'gbrain delete' soft-deletes
    // via UPDATE, so it unwedges exactly the environments where writes work
    // but this DELETE does not.
    const renameRemedy =
      `The next 'gbrain sync' retries the reconcile from the same diff. If the delete ` +
      `keeps failing in your environment (RLS denying DELETE, an FK RESTRICT — anywhere ` +
      `UPDATE still works), remove the stale row yourself: 'gbrain delete <stale-slug>' ` +
      `with the stale slug named above (the reconcile only names rows whose backing file ` +
      `is gone from the working tree — never a live page). A sentinel reading 'stale row ?' ` +
      `names nothing on purpose: that run could not prove ANY row stale, usually because a ` +
      `tracked file could not be read — fix or remove that file instead of deleting a page. ` +
      `The reconcile then finds nothing left to delete and the sentinel clears on the next run.`;
    if (gate.sentinelBlocked && failedFiles.some(f => f.path === '<head>')) {
      serr(
        `\nSync blocked: repository history changed during sync (force-push / reset).\n` +
        `${codeBreakdown}\n\n` +
        `The pinned target is no longer an ancestor of HEAD; advancing would record ` +
        `a commit that doesn't match the indexed tree. Re-run sync to re-pin against ` +
        `current HEAD.` +
        (renameRows.length > 0
          ? `\n\nA rename also left a stale duplicate that could not be removed:\n` +
            `${renameDetail}\n\n${renameRemedy}`
          : ''),
      );
    } else if (gate.sentinelBlocked) {
      serr(
        `\nSync blocked: a rename left a stale duplicate that could not be removed:\n` +
        `${renameDetail || codeBreakdown}\n\n` +
        renameRemedy,
      );
    } else {
      const fileFailCount = failedFiles.filter(f => isSkippablePath(f.path)).length;
      // #3875: code-aware copy. Provider-infra failures (embed timeout /
      // rate limit / quota) are NOT bad files — suggesting --skip-failed for
      // them acknowledges away perfectly good content. Point at provider
      // health + a plain re-run (or --full to rebuild) instead.
      const infraCodes = summarizeFailuresByCode(failedFiles).filter(c => isEmbeddingInfraCode(c.code));
      if (infraCodes.length > 0) {
        serr(
          `\nSync blocked: ${fileFailCount} file(s) failed — embedding provider errors:\n` +
          `${codeBreakdown}\n\n` +
          `These are provider-health failures (timeout / rate limit / quota), not bad ` +
          `files — do NOT use --skip-failed for them. Check the embedding provider ` +
          `(is it running? out of quota?), then re-run 'gbrain sync' (only the failed ` +
          `files are re-attempted), or 'gbrain sync --full' to rebuild.`,
        );
      } else {
        serr(
          `\nSync blocked: ${fileFailCount} file(s) failed to parse:\n` +
          `${codeBreakdown}\n${formatFailedFileList(failedFiles)}\n\n` +
          `Pinpoint a file with 'gbrain frontmatter validate <path>' (--fix auto-repairs), ` +
          `fix the frontmatter and re-run, or use 'gbrain sync --skip-failed' to ` +
          `acknowledge and move on. A file that keeps failing auto-skips after ` +
          `${resolveAutoSkipThreshold()} consecutive syncs.`,
        );
      }
    }
    // Update last_run + repo_path (progress on infra) but NOT last_commit. The
    // checkpoint is INTENTIONALLY left in place — the banked completed set lets
    // the next run skip the drained files and re-attempt only the failures.
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeSyncAnchor(engine, opts.sourceId, 'repo_path', anchorPath);
    // v0.42.x (#1794): surface banked progress so a blocked run doesn't read as
    // total loss (last_commit is unchanged by design; the checkpoint is banked).
    serr(
      `[sync] banked ${bankedFiles} file(s) this run; next 'gbrain sync' resumes ` +
      `from the checkpoint (last_commit unchanged at ${(lastCommit ?? '').slice(0, 8)}).`,
    );
    return {
      status: 'blocked_by_failures',
      fromCommit: lastCommit,
      toCommit: pin,
      added: filtered.added.length,
      modified: filtered.modified.length,
      deleted: filtered.deleted.length,
      renamed: filtered.renamed.length,
      chunksCreated,
      embedded: 0,
      pagesAffected,
      failedFiles: failedFiles.length,
      failureCodes: summarizeFailuresByCode(failedFiles),
      bankedFiles,
    };
  }

  // Advanced. Surface what the gate did past the failures.
  if (gate.acknowledged > 0) {
    serr(`  Acknowledged ${gate.acknowledged} failure(s) and advanced past them.`);
  }
  if (gate.autoSkipped.length > 0) {
    serr(
      `\n  Auto-skipped ${gate.autoSkipped.length} file(s) that failed >= ` +
      `${resolveAutoSkipThreshold()} consecutive syncs:\n` +
      gate.autoSkipped.map(p => `    ${p}`).join('\n') + '\n' +
      `  Bookmark advanced; these pages are NOT indexed and remain in ` +
      `sync-failures.jsonl. 'gbrain doctor' will warn until they're fixed.`,
    );
  }

  // Log ingest. #3969: mirror runImport's shouldLogIngest gate — a run that
  // landed nothing (no pages written, no chunks, no failures acknowledged or
  // auto-skipped) is a poll, not an ingest event; skip the row unless
  // opts.logNoop opts back in.
  if (shouldLogIngest(
    {
      imported: pagesAffected.length,
      errors: gate.acknowledged + gate.autoSkipped.length,
      chunksCreated,
    },
    opts.logNoop === true,
  )) {
    await engine.logIngest({
      // #3242 (attribution sub-bug): credit the sync to the source it wrote
      // to, not the shared 'default' bucket.
      ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
      source_type: 'git_sync',
      source_ref: `${repoPath} @ ${headCommit.slice(0, 8)}`,
      pages_updated: pagesAffected,
      summary: `Sync: +${filtered.added.length} ~${filtered.modified.length} -${filtered.deleted.length} R${filtered.renamed.length}, ${chunksCreated} chunks, ${elapsed}ms`,
    });
  }

  // Auto-extract links + timeline (cheap CPU, but skip-inline for LARGE syncs).
  // Thread opts.sourceId so the extract phase reconciles edges + timeline
  // entries against the right source — pre-fix (Data R1 HIGH 1) this phase
  // bypassed sourceId entirely and the bare-slug subquery in addTimelineEntry
  // (Data R1 HIGH 2) crashed with 21000 in multi-source brains.
  //
  // v0.42.x (#1794, T4): size-gate inline extract on `totalChanges <= 100`
  // (same threshold as noEmbed). A large sync (the #1794 case) would otherwise
  // run links+timeline extraction over tens of thousands of pages inline,
  // re-coupling a slow pass into the just-decoupled convergence path. Instead we
  // leave `links_extracted_at` UNSTAMPED so the resumable `extract --stale`
  // watermark sweep (run by the autopilot cycle / on demand) picks the pages
  // up. For resumed large syncs, pagesAffected holds only THIS run's slugs, but
  // the stale sweep scans the whole source, so banked-across-runs pages are
  // covered regardless.
  const extractOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;
  if (!opts.noExtract && totalChanges > 100 && pagesAffected.length > 0) {
    // #2849: above the size gate the deferred extraction must be DURABLY
    // QUEUED, not just hinted. The autopilot cycle's extract phase is
    // slug-scoped (an up_to_date follow-up sync hands it an empty
    // pagesAffected), so a webhook-driven large sync left
    // `links_extracted_at` unstamped FOREVER unless an operator ran
    // `gbrain extract --stale` by hand. Submit a source-scoped stale-sweep
    // job bound to the consumed commit (idempotency key) so repeated
    // webhook deliveries / sync retries of the same commit coalesce onto
    // one job. The sweep itself is the watermark scan — it picks up the
    // pages this run imported AND any banked across resumed runs.
    // Best-effort: queue submission failure falls back to the hint-only
    // behavior (the pages stay stale + visible to doctor, never mis-stamped).
    let queuedJobId: number | string | null = null;
    try {
      const { MinionQueue } = await import('../core/minions/queue.ts');
      const { STALE_TIME_BUDGET_MS } = await import('./extract.ts');
      const queue = new MinionQueue(engine);
      const payload = {
        stale: true,
        ...(opts.sourceId ? { sourceId: opts.sourceId } : {}),
        reason: 'sync_size_gate',
        // Bound to the PIN this run drained to (== headCommit unless resuming
        // a stored target), not live HEAD — the sweep covers what we imported.
        deferred_commit: pin,
      };
      // The stale sweep has its own internal wall-clock budget
      // (GBRAIN_EXTRACT_TIME_BUDGET_MS-derived); without an explicit
      // timeout_ms the job would inherit the tight null-default and get
      // wall-clock-killed mid-sweep (#1737 class). 5-min headroom.
      const timeoutMs = STALE_TIME_BUDGET_MS + 5 * 60 * 1000;
      // NO maxWaiting here: with an unscoped (NULL-sourceId) payload the
      // queue's coalesce filter matches ANY waiting 'extract' job (e.g. a
      // remediation-submitted {mode:'links'} row) and returns THAT job —
      // silently dropping the sweep while we log "queued". The idempotency
      // key alone is the dedup for repeat submissions toward the same pin.
      const key = `extract-stale:${opts.sourceId ?? 'default'}:${pin}`;
      const isLiveSweep = (j: { status: string; data: Record<string, unknown> }): boolean =>
        j.data?.stale === true && ['waiting', 'delayed', 'active'].includes(j.status);
      let job = await queue.add('extract', payload, { idempotency_key: key, timeout_ms: timeoutMs });
      if (!isLiveSweep(job)) {
        // The key slot holds a FINISHED row: a prior sweep toward this pin
        // that completed BEFORE this run's pages landed (checkpoint-resume /
        // blocked-advance re-sync of the same target). Those pages went
        // stale after that sweep's watermark pass, so coalescing onto the
        // finished row would strand them — queue a fresh sweep under a
        // run-unique key. (An 'active' sweep is safe to coalesce onto: its
        // end-of-run staleRemaining re-count chains a continuation.)
        job = await queue.add('extract', payload, {
          idempotency_key: `${key}:${Date.now()}`,
          timeout_ms: timeoutMs,
        });
      }
      // Only claim "queued" once we verified the returned row IS a live
      // stale sweep — never trust queue.add's row blind.
      if (isLiveSweep(job)) queuedJobId = job.id;
    } catch { /* best-effort — hint below still tells the operator */ }
    slog(
      `  Large sync: deferring link/timeline extraction` +
      (queuedJobId != null
        ? ` — queued stale-sweep job #${queuedJobId} (source: ${opts.sourceId ?? 'default'}); a running jobs worker will consume it.`
        : `.`) +
      ` Run 'gbrain extract --stale${opts.sourceId ? ` --source-id ${opts.sourceId}` : ''}' to extract now.`,
    );
  }
  if (!opts.noExtract && totalChanges <= 100 && pagesAffected.length > 0) {
    try {
      const { extractLinksForSlugs, extractTimelineForSlugs, stampExtracted } = await import('./extract.ts');
      // #774: pages' source_path is git-root-relative, so extract resolves
      // files from gitContextRoot (== repoPath realpath when unscoped).
      const linksCreated = await extractLinksForSlugs(engine, gitContextRoot, pagesAffected, extractOpts);
      const timelineCreated = await extractTimelineForSlugs(engine, gitContextRoot, pagesAffected, extractOpts);
      if (linksCreated > 0 || timelineCreated > 0) {
        slog(`  Extracted: ${linksCreated} links, ${timelineCreated} timeline entries`);
      }
      // v0.42.7 (#1696, CDX-6): stamp the links_extracted_at watermark for the
      // pages we just extracted, AFTER the import set their updated_at, so
      // links_extracted_at >= updated_at (page is now fresh, not flagged stale).
      // Source-correct via opts.sourceId. Stamp at the CALL SITE (not inside
      // extractLinksForSlugs) so we use the per-source sourceId the sync owns.
      // Best-effort: a stamp miss just means extract --stale re-sweeps later.
      await stampExtracted(
        engine,
        pagesAffected.map((slug) => ({ slug, source_id: opts.sourceId ?? 'default' })),
      );
    } catch { /* extraction is best-effort */ }
  }

  // v0.31.2: facts extraction now routes through the shared
  // src/core/facts/backstop.ts helper (PR1 commit 6). Sync uses
  // queue mode (fire-and-forget) + 'high-only' filter so a 50-page
  // sync doesn't block on N sequential Sonnet calls. The pre-fix
  // inline loop is gone — it carried (a) a dead-code type filter
  // ('conversation'/'transcript'/'therapy'/'call' aren't real
  // PageTypes), (b) a divergent eligibility shape from put_page,
  // and (c) raw extract→insert without dedup/supersede.
  if (!opts.noExtract && pagesAffected.length > 0 && pagesAffected.length <= 50) {
    const { runFactsBackstop } = await import('../core/facts/backstop.ts');
    const factsSourceId = opts.sourceId ?? 'default';
    for (const slug of pagesAffected) {
      try {
        // v0.40 D21: source-scoped getPage. Pre-v0.40 this called
        // engine.getPage(slug) WITHOUT sourceId, then wrote facts under
        // factsSourceId. On a federated brain with the same slug in two
        // sources (e.g. people/garry-tan in default + zion-brain), this
        // would attribute facts to the wrong source. Codex outside-voice
        // catch on the v0.40 plan review.
        const page = await engine.getPage(slug, { sourceId: factsSourceId });
        if (!page) continue;
        await runFactsBackstop(
          {
            slug,
            type: page.type,
            compiled_truth: page.compiled_truth ?? '',
            frontmatter: page.frontmatter ?? {},
          },
          {
            engine,
            sourceId: factsSourceId,
            sessionId: `sync:${slug}`,
            source: 'sync:import',
            mode: 'queue',
            notabilityFilter: 'high-only',
          },
        );
      } catch { /* per-page enqueue is best-effort */ }
    }
  }

  // Auto-embed (skip for large syncs — embedding calls OpenAI).
  // Thread sourceId so incremental source syncs embed the page row they just
  // imported instead of falling back to the default source.
  //
  // v0.37 fix wave (Lane D.3 + CDX2-8): switched from `runEmbed` (which
  // does its own process.exit) to `runEmbedCore` so sync can detect the
  // dim-mismatch class and surface a stderr hint without killing the
  // sync. Non-mismatch errors stay best-effort (rate limits, transient
  // network) — those shouldn't break sync.
  let embedded = 0;
  // #1284: never hand deleted slugs to the embedder — embedPage throws
  // 'Page not found' per deleted slug and logs one error line each. Filter
  // against this run's confirmed-deleted set (slugs re-imported later in the
  // run were removed from it at their push sites).
  const embedSlugs = pagesAffected.filter((s) => !deletedSlugs.has(s));
  if (!noEmbed && embedSlugs.length > 0 && pagesAffected.length <= 100) {
    try {
      const { runEmbedCore } = await import('./embed.ts');
      const embedOpts = opts.sourceId
        ? { slugs: embedSlugs, sourceId: opts.sourceId }
        : { slugs: embedSlugs };
      await runEmbedCore(engine, embedOpts);
      embedded = embedSlugs.length;
    } catch (e: unknown) {
      const { EmbeddingDimMismatchError } = await import('./embed.ts');
      if (e instanceof EmbeddingDimMismatchError) {
        serr('\n' + e.recipeMessage + '\n');
        serr(`Tip: pass --no-embed to sync without embedding, then`);
        serr(`run 'gbrain embed --stale' after fixing the schema.\n`);
      }
      // Other errors stay best-effort — rate limits, transient network.
    }
  } else if (noEmbed || totalChanges > 100) {
    slog(`Text imported. Run 'gbrain embed --stale' to generate embeddings.`);
  }

  if (malformedSkipped.length > 0) {
    serr(
      `\n  ${malformedSkipped.length} file(s) skipped: malformed filename ` +
      `(brackets/control chars) — rename to import. Not counted as failures.`,
    );
  }

  const typeWarnings = [...typeWarningCounts.values()];
  if (typeWarningsEnabled && typeWarnings.length > 0) {
    const { renderTypeWarningSummary } = await import('../core/schema-pack/type-usage.ts');
    for (const line of renderTypeWarningSummary(typeWarnings)) serr(`  ${line}`);
    serr(`  (silence with: gbrain config set schema.type_warnings false)`);
  }

  return {
    status: 'synced',
    fromCommit: lastCommit,
    toCommit: pin,
    added: filtered.added.length,
    modified: filtered.modified.length,
    deleted: filtered.deleted.length,
    renamed: filtered.renamed.length,
    chunksCreated,
    embedded,
    pagesAffected,
    ...(totalChanges > 100 && embedSlugs.length > 0 ? { embedDeferralReason: 'large_sync' as const } : {}),
    malformedSkipped: malformedSkipped.length,
    ...(typeWarningsEnabled && typeWarnings.length > 0 ? { type_warnings: typeWarnings } : {}),
    ...(uncommittedDrift ? { uncommitted: uncommittedDrift } : {}),
  };
}

async function performFullSync(
  engine: BrainEngine,
  // #753/#774: the three roots resolved once at the top of performSyncInner.
  //   gitContextRoot — git repo root (git ops, slug base for scoped syncs)
  //   syncScopeRoot  — where files are walked/imported (== gitContextRoot
  //                    when no subpath scope is active)
  //   anchorPath     — what gets written back to sync.repo_path/local_path
  //   slugRootMode   — #4342 sticky namespace anchor (git-root|source-root)
  roots: { gitContextRoot: string; syncScopeRoot: string; anchorPath: string; slugRootMode: SlugRootMode },
  headCommit: string,
  opts: SyncOpts,
): Promise<SyncResult> {
  const { gitContextRoot, syncScopeRoot, anchorPath, slugRootMode } = roots;
  // Scoped 'git-root' sync → slugs/source_path are git-root-relative (matches
  // the incremental path's git-diff paths). Unscoped OR pinned 'source-root'
  // (#4342) → undefined (dir-relative — local_path IS the slug base).
  const slugRoot =
    syncScopeRoot !== gitContextRoot && slugRootMode === 'git-root' ? gitContextRoot : undefined;
  // Dry-run: walk the scope, count syncable files, return without writing.
  // Fixes the silent-write-on-dry-run bug where performFullSync called
  // runImport unconditionally regardless of opts.dryRun.
  //
  // v0.31.2 (codex C6): use the strategy-aware walker. Pre-fix this
  // hardcoded `collectMarkdownFiles(repoPath)` and filtered with
  // default-markdown `isSyncable(rel)`, so `gbrain sync --strategy
  // code --dry-run` always reported zero files even when ~1500 code
  // files were waiting.
  if (opts.dryRun) {
    const dryRunMalformed: string[] = [];
    let allFiles = collectSyncableFiles(syncScopeRoot, {
      strategy: opts.strategy ?? 'markdown',
      includeGitignored: opts.includeGitignored,
      onExcluded: (rel) => { dryRunMalformed.push(rel); },
      includeHidden: opts.includeHidden,
    });
    if (opts.exclude && opts.exclude.length > 0) {
      allFiles = allFiles.filter(abs => !matchesAnyGlob(relative(syncScopeRoot, abs), opts.exclude));
    }
    slog(
      `Full-sync dry run (strategy=${opts.strategy ?? 'markdown'}): ` +
      `${allFiles.length} file(s) would be imported ` +
      `from ${syncScopeRoot} @ ${headCommit.slice(0, 8)}.`,
    );
    if (dryRunMalformed.length > 0) {
      slog(
        `  ${dryRunMalformed.length} file(s) would be skipped: malformed filename ` +
        `(brackets/control chars; rename to import): ` +
        dryRunMalformed.slice(0, 20).map(sanitizePathForDisplay).join(', ') +
        (dryRunMalformed.length > 20 ? `, … (+${dryRunMalformed.length - 20} more)` : ''),
      );
    }
    return {
      status: 'dry_run',
      fromCommit: null,
      toCommit: headCommit,
      added: allFiles.length,
      modified: 0,
      deleted: 0,
      renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
    };
  }

  // v0.22.13 (PR #490 A1 + Q5): full sync is always "large" by definition
  // (entire working tree). Auto-concurrency fires unconditionally for Postgres;
  // PGLite stays serial because its engine is single-connection. Routes the
  // policy through autoConcurrency() so it stays consistent with incremental
  // sync and the jobs handler.
  const FULL_SYNC_LARGE_MARKER = Number.MAX_SAFE_INTEGER;
  const fullConcurrency = autoConcurrency(engine, FULL_SYNC_LARGE_MARKER, opts.concurrency);
  slog(`Running full import of ${syncScopeRoot}${fullConcurrency > 1 ? ` (${fullConcurrency} workers)` : ''}...`);
  const { runImport } = await import('./import.ts');
  const importArgs = [syncScopeRoot];
  if (opts.noEmbed) importArgs.push('--no-embed');
  if (opts.includeGitignored) importArgs.push('--include-gitignored');
  if (fullConcurrency > 1) importArgs.push('--workers', String(fullConcurrency));
  // v0.31.2: thread strategy through so code-strategy first sync
  // actually enumerates code files (closes bug 1).
  // v0.30.x: thread sourceId so performFullSync routes pages to the named
  // source (incremental path already does this).
  // #753/#774: thread exclude (--exclude CLI) + slugRoot (monorepo subdir).
  const _fullImportT0 = Date.now();
  serr(`[gbrain phase] sync.fullsync.import start strategy=${opts.strategy ?? 'markdown'}`);
  opts.onProgress?.({ phase: 'full_import' });
  const result = await runImport(engine, importArgs, {
    commit: headCommit,
    strategy: opts.strategy,
    sourceId: opts.sourceId,
    exclude: opts.exclude,
    includeHidden: opts.includeHidden,
    includeGitignored: opts.includeGitignored,
    slugRoot,
    // issue #1939: performFullSync owns the failure ledger + bookmark via the
    // shared gate below; don't let runImport double-record or write its own.
    managedBookmark: true,
  });
  serr(
    `[gbrain phase] sync.fullsync.import done ${Date.now() - _fullImportT0}ms ` +
    `imported=${result.imported} skipped=${result.skipped} errors=${result.errors}`,
  );

  // issue #1939 — gate the full-sync bookmark through the SAME shared ledger as
  // the incremental path (Codex #6: a wedge here on first/forced sync was
  // previously unreachable by the valve). A full re-import is authoritative for
  // the whole tree, so any previously-tracked failing path that ISN'T failing
  // now has been resolved → clear it (resets its auto-skip streak); current
  // failures still climb their attempts.
  const fullSourceId = opts.sourceId ?? DEFAULT_SOURCE_ID;
  const fullFailureSet = new Set(result.failures.map(f => f.path));
  const fullSucceeded = loadSyncFailures()
    .filter(e => e.source_id === fullSourceId && isSkippablePath(e.path) && !fullFailureSet.has(e.path))
    .map(e => e.path);
  const advanceFull = async (): Promise<void> => {
    // Persist sync state so the next sync is incremental. Routed through
    // writeSyncAnchor so --source pins the right sources row.
    await writeSyncAnchor(engine, opts.sourceId, 'last_commit', headCommit, newestCommitMs(gitContextRoot), gitContextRoot);
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeSyncAnchor(engine, opts.sourceId, 'repo_path', anchorPath);
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
  };

  const fullGate = await applySyncFailureGate({
    sourceId: fullSourceId,
    failedFiles: result.failures,
    succeededPaths: fullSucceeded,
    commit: headCommit,
    skipFailed: opts.skipFailed === true,
    advance: advanceFull,
  });
  // #3479 blocker 2 — the same orphaned-`<rename:…>`-sentinel self-heal the
  // incremental path applies (a full sync is often exactly the operator's
  // reset move after a wedge). AFTER and OUTSIDE the gate (#3583): a gate
  // that throws never clears anything, and the sweep carries the full
  // clear-then-verify-restore semantics.
  await sweepOrphanedRenameSentinels(engine, fullSourceId, fullFailureSet);

  if (!fullGate.advanced) {
    const codeBreakdown = formatCodeBreakdown(result.failures);
    if (fullGate.sentinelBlocked) {
      // #3479 review — say WHICH sentinel fired: a `<rename:…>` block here
      // used to print the history-changed message, pointing the operator at
      // a force-push that never happened.
      const fullRenameRows = result.failures.filter(f => f.path.startsWith(RENAME_SENTINEL_PREFIX));
      if (fullRenameRows.length > 0) {
        serr(
          `\nFull sync blocked: a rename left a stale duplicate that could not be removed:\n` +
          `${fullRenameRows.map(f => `  ${f.path}: ${f.error}`).join('\n')}\n\n` +
          `If the delete keeps failing in your environment, remove the stale row ` +
          `yourself: 'gbrain delete <stale-slug>' with the stale slug named above ` +
          `(only rows whose backing file is gone are ever named — never a live page). ` +
          `A sentinel reading 'stale row ?' names nothing on purpose: that run could not ` +
          `prove ANY row stale — fix the unreadable tracked file it reports instead. ` +
          `The sentinel then clears on the next sync.`,
        );
      } else {
        serr(`\nFull sync blocked: repository history changed during sync.\n${codeBreakdown}`);
      }
    } else {
      const fileFailCount = result.failures.filter(f => isSkippablePath(f.path)).length;
      // #3875: code-aware copy — provider-infra failures must not be routed
      // to --skip-failed (same rationale as the incremental gate above).
      const infraCodes = summarizeFailuresByCode(result.failures).filter(c => isEmbeddingInfraCode(c.code));
      if (infraCodes.length > 0) {
        serr(
          `\nFull sync blocked: ${fileFailCount} file(s) failed — embedding provider errors:\n` +
          `${codeBreakdown}\n\n` +
          `These are provider-health failures (timeout / rate limit / quota), not bad ` +
          `files — do NOT use --skip-failed for them. Check the embedding provider, ` +
          `then re-run 'gbrain sync --full'.`,
        );
      } else {
        serr(
          `\nFull sync blocked: ${fileFailCount} file(s) failed:\n` +
          `${codeBreakdown}\n${formatFailedFileList(result.failures)}\n\n` +
          `Pinpoint a file with 'gbrain frontmatter validate <path>' (--fix auto-repairs), ` +
          `fix the YAML and re-run, or use '--skip-failed'. A file ` +
          `that keeps failing auto-skips after ${resolveAutoSkipThreshold()} consecutive syncs.`,
        );
      }
    }
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeSyncAnchor(engine, opts.sourceId, 'repo_path', anchorPath);
    return {
      status: 'blocked_by_failures',
      fromCommit: null,
      toCommit: headCommit,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: result.chunksCreated,
      embedded: 0,
      pagesAffected: [],
      failedFiles: result.failures.length,
      failureCodes: summarizeFailuresByCode(result.failures),
    };
  }
  if (fullGate.acknowledged > 0) {
    serr(`  Acknowledged ${fullGate.acknowledged} failure(s) and advanced past them.`);
  }
  if (fullGate.autoSkipped.length > 0) {
    serr(
      `\n  Auto-skipped ${fullGate.autoSkipped.length} file(s) that failed >= ` +
      `${resolveAutoSkipThreshold()} consecutive syncs. These pages are NOT indexed; ` +
      `'gbrain doctor' will warn until they're fixed.`,
    );
  }

  // #1970 (F-A): runImport is import-only — it never purges pages whose backing
  // file was deleted since the last sync. A full re-import is authoritative for
  // the whole tree, so reconcile deletes here too (this is what makes the
  // object-absent fallback at performSyncInner correct for deletes, not just
  // imports). Runs only on an advancing full sync (we're past the
  // !fullGate.advanced early-return).
  //
  // SAFETY — must NOT re-introduce the #1433 stale-page data loss. A page is
  // deleted ONLY when ALL three hold:
  //   1. source_path != null      → file-backed pages only; put_page/manual
  //      pages (null source_path) are never swept.
  //   2. isSyncable(source_path)  → excludes metafiles (README/log.md, the
  //      #1433 class) AND the wrong strategy (a markdown sync can't delete a
  //      code page, and vice versa).
  //   3. source_path ∉ current    → the backing file is genuinely gone from the
  //      working tree (collectSyncableFiles == the same enumeration runImport
  //      used, so paths are in the identical relative form as source_path).
  // Skipped on the legacy no-sourceId path (the batch delete primitives require
  // a sourceId; matches every other source-scoped feature).
  let reconciledDeletes = 0;
  if (opts.sourceId) {
    const sid = opts.sourceId;
    const reconcileSyncOpts = opts.strategy ? { strategy: opts.strategy } : undefined;
    // collectSyncableFiles returns ABSOLUTE paths; source_path is stored
    // repo-relative (importFile uses `relative(dir, filePath)`), so relativize
    // to the same form before membership-testing — otherwise every page looks
    // stale and the reconcile would wrongly delete live pages.
    //
    // #2828: planReconcileDeletes ALSO normalizes path separators on both sides
    // of the membership test. On a Windows checkout `path.relative` yields
    // backslash paths while a stored source_path can hold git-derived forward
    // slashes; without normalization every file-backed page mismatches, looks
    // stale, and the reconcile wipes the whole source.
    // #774: scoped syncs store git-root-relative source_paths (slugRoot), so
    // relativize the walk to the same base — otherwise every page mismatches
    // and the mass-delete valve trips on a perfectly healthy scoped source.
    // includeHidden MUST be threaded here too: if it isn't, any page a
    // --include-hidden full sync just imported would look "gone" on the
    // very next reconcile pass (its file was never in this collection) and
    // the mass-delete valve would remove it.
    const currentFiles = collectSyncableFiles(syncScopeRoot, {
      strategy: opts.strategy ?? 'markdown',
      includeGitignored: opts.includeGitignored,
      includeHidden: opts.includeHidden,
    })
      .map(abs => relative(slugRoot ?? syncScopeRoot, abs));
    const rows = await engine.executeRaw<{ slug: string; source_path: string | null }>(
      `SELECT slug, source_path FROM pages WHERE source_id = $1 AND source_path IS NOT NULL AND deleted_at IS NULL`,
      [sid],
    );
    // #774: a scoped full sync is authoritative ONLY for its scope — pages
    // whose source_path lives outside the subpath (e.g. from an earlier
    // root-level sync of this source) are out of this walk's sight and must
    // not be treated as stale.
    const scopePrefix = slugRoot ? relative(gitContextRoot, syncScopeRoot) + '/' : '';
    // 'malformed-path' rows ARE reconcile-eligible: junk filenames (bracket /
    // control-char paths minted by misbehaving producers) can never be
    // re-imported, so their rows are permanent search pollution unless the
    // reconcile can sweep them. Strategy safety is preserved by classifier
    // ordering — a path that fails the strategy check classifies as
    // 'strategy', never 'malformed-path', so a markdown sync still can't
    // delete code pages. The #1433 metafile protection is likewise untouched.
    const reconcileEligible = (p: string): boolean =>
      isSyncable(p, reconcileSyncOpts) ||
      // Only the poison signature is sweepable; bare-bracket markdown rows
      // from pre-gate releases survive reconcile (their file still exists —
      // deleting the row would be silent data loss; cross-model finding).
      (unsyncableReason(p, reconcileSyncOpts) === 'malformed-path' && isPoisonedPath(p));
    const plan = planReconcileDeletes(
      rows,
      currentFiles,
      p => (scopePrefix === '' || p.startsWith(scopePrefix)) && reconcileEligible(p),
    );
    if (plan.staleSlugs.length > 0 && plan.massDelete && !massReconcileAllowed()) {
      // #2828 mass-delete safety valve: a reconcile that would sweep more than
      // half of the pages this strategy manages, on a source with a non-trivial
      // number of them, is almost always a path-comparison bug or the wrong repo
      // path — NOT a genuine bulk deletion. Skip the delete and warn loudly
      // instead of silently wiping the brain.
      serr(
        `\n  WARNING: refusing to reconcile-delete ${plan.staleSlugs.length} of ` +
        `${plan.reconcilableCount} file-backed page(s) for source '${sid}' ` +
        `(> ${Math.round(MASS_RECONCILE_RATIO * 100)}% of them).\n` +
        `  A full sync removes pages only when their backing file is gone. Deleting\n` +
        `  this many at once almost always means the paths were compared wrong (e.g.\n` +
        `  a path-separator mismatch) or the WRONG repo path was synced — not that\n` +
        `  you actually deleted that many files. No pages were deleted.\n` +
        `  If this bulk removal is genuinely intended, re-run with ` +
        `GBRAIN_ALLOW_MASS_RECONCILE=1 to restore the old behavior.`,
      );
    } else if (plan.staleSlugs.length > 0) {
      // #2426: a stale page whose source_path was NEVER committed to git is
      // DB-only write-through (the file was written into the clone but never
      // committed/pushed, then lost — e.g. a fresh clone). "Absent from git"
      // is the SYMPTOM of that bug, not evidence the content is disposable.
      // Keep those pages and re-export their markdown to the working tree so
      // they're file-backed again; only pages whose file once existed in git
      // history (i.e. was genuinely deleted) are reconcile-deleted.
      const everCommitted = listEverCommittedPaths(gitContextRoot);
      const pathBySlug = new Map(rows.map(r => [r.slug, r.source_path]));
      let deletableSlugs = plan.staleSlugs;
      const dbOnlySlugs: string[] = [];
      if (everCommitted) {
        deletableSlugs = [];
        for (const slug of plan.staleSlugs) {
          const sp = pathBySlug.get(slug);
          if (sp && !everCommitted.has(sp.replace(/\\/g, '/'))) dbOnlySlugs.push(slug);
          else deletableSlugs.push(slug);
        }
      }
      if (dbOnlySlugs.length > 0) {
        let reExported = 0;
        try {
          const { writePageThrough } = await import('../core/write-through.ts');
          for (const slug of dbOnlySlugs) {
            const r = await writePageThrough(engine, slug, { sourceId: sid });
            if (r.written) reExported++;
          }
        } catch { /* best-effort — pages are preserved either way */ }
        serr(
          `\n  Kept ${dbOnlySlugs.length} page(s) whose markdown was never committed to git ` +
          `(DB-only write-through — not deleting).` +
          (reExported > 0 ? ` Re-exported ${reExported} of them to the working tree.` : '') +
          `\n  Commit + push them (e.g. scripts/brain-commit-push.sh, or 'gbrain sources harden') ` +
          `so the next sync sees them as file-backed.`,
        );
      }
      const deleteScopedOpts = { sourceId: sid };
      // Malformed-path rows get their own line: unlike genuinely-deleted
      // files, THEIR backing file is usually still on disk (the walker
      // excludes it), so "source file was removed" would be a lie and the
      // rename-to-rescue path must be stated at the moment of removal, not
      // only in a doctor check the operator may see later (red-team catch).
      const malformedDeleted = deletableSlugs.filter(slug => {
        const sp = pathBySlug.get(slug);
        return sp != null && unsyncableReason(sp, reconcileSyncOpts) === 'malformed-path';
      }).length;
      for (let i = 0; i < deletableSlugs.length; i += DELETE_BATCH_SIZE) {
        const batch = deletableSlugs.slice(i, i + DELETE_BATCH_SIZE);
        try {
          // #4587: reconcile soft-deletes (72h recovery). Already-soft-
          // deleted rows are excluded by the primitive's predicate, so the
          // count only reports real transitions.
          const deleted = await engine.softDeletePages(batch, deleteScopedOpts);
          reconciledDeletes += deleted.length;
        } catch {
          // Per-slug fallback on a batch blip (mirrors the incremental delete
          // loop's decompose). A stale page that won't delete is best-effort,
          // not fatal — the run continues.
          for (const slug of batch) {
            try { reconciledDeletes += (await engine.softDeletePages([slug], deleteScopedOpts)).length; }
            catch { /* best-effort */ }
          }
        }
      }
      if (reconciledDeletes > 0) {
        slog(`  Reconciled ${reconciledDeletes} stale page(s) whose source file was removed (soft-deleted, recoverable 72h).`);
        if (malformedDeleted > 0) {
          slog(
            `  (${malformedDeleted} of them had malformed bracket/control-char filenames — ` +
            `their files may still exist on disk; rename a file to re-import its content.)`,
          );
        }
      }
    }
  }

  // #3479 blocker 2 — the post-gate sweep above ran BEFORE this reconcile,
  // so a `<rename:…>` sentinel whose stale row the reconcile just removed
  // would stay open until the NEXT run. Sweep again afterwards: a full sync
  // is the operator's usual reset move, and it should converge in one run.
  await sweepOrphanedRenameSentinels(engine, fullSourceId, fullFailureSet);

  // Full sync doesn't track pagesAffected, so fall back to embed --stale.
  // v0.37 fix wave (Lane D.3 + CDX2-8): switched to runEmbedCore for the
  // same reason as the incremental path — surface dim-mismatch via hint
  // instead of silently swallowing or killing the process.
  let embedded = 0;
  if (!opts.noEmbed) {
    try {
      const { runEmbedCore } = await import('./embed.ts');
      await runEmbedCore(engine, { stale: true });
      embedded = result.imported;
    } catch (e: unknown) {
      const { EmbeddingDimMismatchError } = await import('./embed.ts');
      if (e instanceof EmbeddingDimMismatchError) {
        serr('\n' + e.recipeMessage + '\n');
        serr(`Tip: pass --no-embed to sync without embedding, then`);
        serr(`run 'gbrain embed --stale' after fixing the schema.\n`);
      }
      // Other errors stay best-effort.
    }
  }

  return {
    status: 'first_sync',
    fromCommit: null,
    toCommit: headCommit,
    added: result.imported,
    modified: 0,
    deleted: reconciledDeletes,
    renamed: 0,
    chunksCreated: result.chunksCreated,
    embedded,
    pagesAffected: [],
    // Warning aggregates ride the result for worker/JSON consumers — a full
    // sync that only prints to a daemon's stderr hides them from cron
    // topologies (codex re-review; same rationale as the incremental path).
    ...(result.malformedSkipped ? { malformedSkipped: result.malformedSkipped } : {}),
    ...(result.type_warnings ? { type_warnings: result.type_warnings } : {}),
  };
}

// The reconcile + deadline cluster (planReconcileDeletes, the #2828
// mass-delete valve, resolveSyncHardDeadline, composeAbortSignals, ...) was
// peeled to src/core/sync-reconcile.ts (pure move). Re-exported so existing
// importers keep working.
export {
  MASS_RECONCILE_RATIO,
  MASS_RECONCILE_MIN_PAGES,
  type ReconcilePlan,
  planReconcileDeletes,
  listEverCommittedPaths,
  massReconcileAllowed,
  HARD_DEADLINE_GRACE_SEC,
  type HardDeadlineResolution,
  DEFAULT_SYNC_STALL_ABORT_SEC,
  resolveStallAbortSeconds,
  resolveSyncHardDeadline,
  composeAbortSignals,
} from '../core/sync-reconcile.ts';

/**
 * #753/#774: `.gitignore` must be managed at the git ROOT — when a source's
 * local_path (or --repo) points at a monorepo subdirectory, writing ignore
 * entries into the subdir would create a stray `.gitignore` git doesn't
 * consult for the repo-level db_only rules. Best-effort: falls back to the
 * given path when git discovery fails (manageGitignore no-ops on non-repos).
 */
function manageGitignoreAtGitRoot(path: string, engineKind?: 'pglite' | 'postgres'): void {
  let root = path;
  try { root = discoverGitRoot(path); } catch { /* best-effort */ }
  manageGitignore(root, engineKind);
}

export async function runSync(engine: BrainEngine, args: string[]) {
  // v0.40 Federated Sync v2: `gbrain sync trigger` subcommand
  // Routes to runSyncTrigger which queues a 'sync' minion job with
  // auto_embed_backfill=true. Falls through to the normal sync path
  // if 'trigger' isn't the first arg.
  if (args[0] === 'trigger') {
    return runSyncTrigger(engine, args.slice(1));
  }

  // v0.37 fix wave (Lane D.4 + CDX2-12): print usage when `--help`/`-h` is
  // passed. Pre-fix this was unreachable because the dispatcher's generic
  // CLI-only short-circuit fired first; sync is now in CLI_ONLY_SELF_HELP.
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain sync [options]

Sync the brain repo's text content into the engine, then embed.

Options:
  --no-embed           Skip the embed step. Use this when the embed
                       provider is misconfigured or you want to defer
                       embedding (run 'gbrain embed --stale' later).
  --no-extract         Skip the link/timeline extraction step. Pages will
                       show as stale in 'gbrain doctor'; run
                       'gbrain extract --stale' later to catch up.
  --workers N          Run the import phase with N parallel workers
                       (alias: --concurrency). Default: 4 when the
                       diff is >100 files, else serial.
  --source <id>        Scope sync to a single source. Defaults to the
                       brain's default source.
  --repo <path>        Path to the brain repo. Defaults to the path
                       saved by 'gbrain init'.
  --full               Force a full re-sync (rare; usually incremental).
  --src-subpath <dir>  Sync only this subdirectory of the git repo (monorepo
                       pattern: N logical sources in one repo). Git pull/diff
                       run at the repo root; imports are scoped to the subdir
                       and slugs stay root-relative (wiki/page1). Passing the
                       subdirectory directly as --repo also works.
  --exclude <glob>     Exclude files matching the glob from sync (repeatable;
                       matched against the scope-relative path).
  --include-hidden <glob>
                       Waive the leading-dot prune (.git, .obsidian, and any
                       other dot-prefixed directory — but NOT node_modules/
                       vendor/dist/build/venv/*.raw, which are never
                       waivable) for paths matching this glob (repeatable).
                       Does not reach a non-git directory's FS-walk import
                       fallback; every git-tracked source (the normal case)
                       is covered. Cannot combine with --all.
  --include-gitignored Include otherwise-syncable files matched by .gitignore.
                       Forces a full filesystem walk so periodic syncs see
                       ignored untracked content.
  --working-tree       Also import uncommitted working-tree state (untracked
                       files + uncommitted edits/deletes). Default: committed
                       changes only — uncommitted drift is counted and warned,
                       never silently ignored. Persist with
                       'gbrain config set sync.include_working_tree true'.
                       Caution: imports untracked files as-is — unignored
                       scratch files and secrets included; review 'git status'
                       before enabling, especially as persisted config.
  --dry-run            Show what would be synced without writing.
  --skip-failed        Acknowledge previously-recorded sync failures so
                       the bookmark can advance past unparseable files.
  --retry-failed       Re-attempt previously-failed files; clear on success.
  --watch              Re-sync continuously on an interval.
  --interval N         Watch-mode interval in seconds (default 60).
  --no-pull            Skip 'git pull' before the sync (useful for tests).
  --no-delegate        On a PGLite brain with a live 'gbrain serve', sync
                       normally delegates the run to the serve process over
                       its IPC socket (the lock owner does the work; embeds
                       defer to serve's background sweep). This flag (or
                       GBRAIN_SYNC_NO_DELEGATE=1) opts out — sync then fails
                       fast if a live serve holds the brain.
  --no-schema-pack     Skip loading the active schema pack (no per-file pack
                       regex runs; pages use legacy prefix typing). Escape
                       hatch if a suspect pack regex is wedging sync.
                       GBRAIN_SYNC_TRACE=1 names the file being imported (hang triage).
  --all                Sync every registered source instead of just the
                       default (multi-source brains).
  --parallel N         (with --all) Run up to N sources concurrently.
                       Default: min(sourceCount, --workers, 4). Each
                       source takes its own per-source DB lock
                       (gbrain-sync:<source_id>) so independent sources
                       sync without contending. Total live Postgres
                       connections per wave ≈ parallel × workers × 2
                       (per-file pool) + parent pool. Pass --parallel 1
                       to force serial.
  --missing-path M     (with --all) What to do when a source's local_path
                       does not exist on this machine: 'fail' (default —
                       loud, current behavior) or 'skip' (classify as
                       skipped_missing_path: ⊘ in the aggregate, excluded
                       from error_count and the rc=1 gate). Use skip on
                       brains whose sources were registered from more
                       than one machine.
  --json               Emit a structured JSON envelope on stdout
                       ({schema_version: 1, sources, parallel,
                       ok_count, error_count, skipped_count}). Sources
                       skipped by --missing-path skip appear with
                       status 'skipped_missing_path' and their
                       local_path. Human banners route to stderr so
                       '--json | jq' parses cleanly.
                       Exit codes: 0 = all sources ok or skipped,
                       1 = any error, 2 = cost-prompt-not-confirmed.
  --yes                Accept any interactive prompts (CI / non-TTY).

See also:
  gbrain embed --stale    Re-embed all stale chunks (post --no-embed).
  gbrain doctor           Diagnose dim mismatches and other sync issues.
`);
    return;
  }

  const repoPath = args.find((a, i) => args[i - 1] === '--repo') || undefined;
  const watch = args.includes('--watch');
  const intervalStr = args.find((a, i) => args[i - 1] === '--interval');
  const interval = intervalStr ? parseInt(intervalStr, 10) : 60;
  const dryRun = args.includes('--dry-run');
  const full = args.includes('--full');
  const noPull = args.includes('--no-pull');
  const noEmbed = resolveNoEmbed(args, loadConfig());
  const noExtract = args.includes('--no-extract'); // v0.42.7 #1696
  const skipFailed = args.includes('--skip-failed');
  const retryFailed = args.includes('--retry-failed');
  const noSchemaPack = args.includes('--no-schema-pack'); // v0.41.37.0 #1569
  const includeGitignored = args.includes('--include-gitignored');
  // Untracked-gap fix: --working-tree imports uncommitted working-tree state.
  // The config fallback (sync.include_working_tree) resolves inside
  // performSync so every caller honors it; the CLI passes undefined when the
  // flag is absent.
  const workingTree = args.includes('--working-tree') ? true : undefined;
  const syncAll = args.includes('--all');
  let missingPathMode: MissingPathMode = 'fail';
  try {
    missingPathMode = parseMissingPathMode(args);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  if (missingPathMode !== 'fail' && !syncAll) {
    // Single-source sync on a missing path should stay loud — an explicit
    // `--source X` naming an absent checkout is an operator error, not a
    // multi-machine artifact. Warn instead of silently ignoring the flag.
    console.error('[gbrain] WARN: --missing-path only applies to `sync --all`; ignored here.');
  }
  const jsonOut = args.includes('--json');
  const yesFlag = args.includes('--yes');
  // v0.41.6.0 D3: lock-recovery flags. --break-lock (safe) verifies the
  // holder is local-host + (TTL-expired OR PID-dead+60s-old) before
  // deleting the row. --force-break-lock skips the liveness check. Both
  // are refused when combined with --all (per-source invocation required;
  // v0.40 lock keys are gbrain-sync:<sourceId>).
  const breakLock = args.includes('--break-lock');
  const forceBreakLock = args.includes('--force-break-lock');

  // v0.41.13.0 (T4 + T16) — --max-age <s>: age-gated lock break via
  // last_refreshed_at semantic (NOT acquired_at — D-V3-4). Only valid with
  // --break-lock; mutually exclusive with --force-break-lock (--force skips
  // every guard; --max-age is one specific extra guard so the two policies
  // can't coexist).
  const maxAgeStr = args.find((a, i) => args[i - 1] === '--max-age');
  let maxAgeSeconds: number | undefined;
  try {
    maxAgeSeconds = parseDurationSeconds(maxAgeStr, '--max-age');
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  if (maxAgeSeconds !== undefined && !breakLock) {
    console.error(`--max-age is only valid with --break-lock.`);
    process.exit(1);
  }
  if (maxAgeSeconds !== undefined && forceBreakLock) {
    console.error(`--max-age cannot be combined with --force-break-lock (force skips all guards).`);
    process.exit(1);
  }

  // v0.41.13.0 (T4 + D1): handle --break-lock / --force-break-lock BEFORE
  // the sync would otherwise contend on the lock. v3's plan dropped the
  // --all refusal at the same point so cron can self-heal across every
  // source in one call; runBreakLock now widens to iterate sources when
  // --all is set and accept maxAgeSeconds for age-gated breaks.
  if (breakLock || forceBreakLock) {
    if (syncAll) {
      const { listSources } = await import('../core/sources-ops.ts');
      const sources = await listSources(engine);
      // listSources omits archived sources by default. We also require
      // local_path because the lock key is per-source; pure-DB sources
      // (no local_path) don't hold sync locks.
      const activeSources = sources.filter((s) => s.local_path);
      if (activeSources.length === 0) {
        if (jsonOut) console.log(JSON.stringify({ status: 'no_sources' }));
        else console.error('No active sources to break-lock against.');
        process.exit(0);
      }
      let worstExit = 0;
      for (const src of activeSources) {
        const lockKey = `gbrain-sync:${src.id}`;
        const exit = await runBreakLock(engine, lockKey, src.id, {
          force: forceBreakLock,
          json: jsonOut,
          maxAgeSeconds,
        });
        if (exit > worstExit) worstExit = exit;
      }
      process.exit(worstExit);
    }
    const sourceArg = args.find((a, i) => args[i - 1] === '--source');
    // #4412: this branch used to hardcode `sourceArg ?? 'default'` while the
    // sync itself resolves through the full ambient chain (--source >
    // GBRAIN_SOURCE > dotfile > cwd > sole-non-default). Under
    // GBRAIN_SOURCE=<src>, `sync --force-break-lock` inspected
    // gbrain-sync:default — absent — printed "nothing to break", exit 0, and
    // left the dead holder's row on gbrain-sync:<src>; the follow-up sync
    // then refused for the 60s takeover grace. Resolve the SAME source the
    // sync would lock. Explicit --source keeps the resolver-free path (no
    // assertSourceExists) so leftover locks of deleted sources stay breakable.
    const { resolveSourceWithTier: resolveBreakSource } = await import('../core/source-resolver.ts');
    const sourceId = sourceArg ?? (await resolveBreakSource(engine, null)).source_id;
    const lockKey = `gbrain-sync:${sourceId}`;
    const exit = await runBreakLock(engine, lockKey, sourceId, {
      force: forceBreakLock,
      json: jsonOut,
      maxAgeSeconds,
    });
    process.exit(exit);
  }

  // v0.41.6.0 D1: preflight embedding credentials BEFORE the import phase
  // so a missing OPENAI_API_KEY exits with one clean line instead of
  // writing N identical entries to sync-failures.jsonl. Skipped when
  // --no-embed (the canonical opt-out) or --dry-run (no provider calls
  // happen in dry-run anyway).
  if (!noEmbed && !dryRun) {
    const { validateEmbeddingCreds, EmbeddingCredentialError } = await import('../core/embed-preflight.ts');
    try {
      validateEmbeddingCreds();
    } catch (e) {
      if (e instanceof EmbeddingCredentialError) {
        if (jsonOut) {
          console.log(JSON.stringify({ status: 'embedding_credentials_missing', diagnosis: e.diagnosis }));
        } else {
          console.error('');
          console.error(e.userMessage);
          console.error('');
        }
        process.exit(1);
      }
      throw e;
    }
  }
  // v0.40 D4+D18: parallel `sync --all` by default; --serial opts back to v1.
  // --no-auto-embed skips the per-source embed-backfill auto-enqueue.
  // --max-sources N caps fan-out (default min(sources.length, 8)).
  const serialFlag = args.includes('--serial');
  const noAutoEmbed = args.includes('--no-auto-embed');
  const maxSourcesStr = args.find((a, i) => args[i - 1] === '--max-sources');
  const maxSources = maxSourcesStr ? parseInt(maxSourcesStr, 10) : undefined;
  if (maxSourcesStr && (!Number.isFinite(maxSources!) || maxSources! < 1)) {
    console.error(`Invalid --max-sources value: "${maxSourcesStr}". Must be a positive integer.`);
    process.exit(1);
  }
  const strategyArg = args.find((a, i) => args[i - 1] === '--strategy') as SyncOpts['strategy'] | undefined;
  // #753/#774: monorepo subdir-source flags. --exclude is repeatable.
  const srcSubpath = args.find((a, i) => args[i - 1] === '--src-subpath') || undefined;
  const excludePatterns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--exclude' && i + 1 < args.length) excludePatterns.push(args[i + 1]);
  }
  // --include-hidden is repeatable, same parsing shape as --exclude.
  const includeHiddenPatterns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--include-hidden' && i + 1 < args.length) includeHiddenPatterns.push(args[i + 1]);
  }
  if (syncAll && (srcSubpath || excludePatterns.length > 0 || includeHiddenPatterns.length > 0)) {
    console.error(
      `--src-subpath/--exclude/--include-hidden scope a single sync invocation; they cannot be combined with --all. ` +
      `For --all runs, register the subdirectory as the source's local_path instead ` +
      `(gbrain sources add <id> --path <repo>/<subdir>).`,
    );
    process.exit(1);
  }
  const concurrencyStr = args.find((a, i) => args[i - 1] === '--concurrency' || args[i - 1] === '--workers');
  const parallelStr = args.find((a, i) => args[i - 1] === '--parallel');
  // v0.22.13 (PR #490 Q2): parseWorkers throws on '0', '-3', 'foo', '1.5' instead
  // of silently falling through to auto-concurrency or NaN. Loud failure beats
  // a 4-worker spawn from a typo. v0.40.3.0: same validation applies to --parallel.
  let concurrency: number | undefined;
  let parallelOverride: number | undefined;
  try {
    concurrency = parseWorkers(concurrencyStr);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  try {
    parallelOverride = parseWorkers(parallelStr);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  // v0.41.13.0 (T16 + T6) — --timeout <s>: graceful self-termination signal
  // threaded into performSync via SyncOpts.signal. D-V3-3 invariant: when
  // combined with --all, each source gets its OWN AbortController + countdown
  // inside runOne so the budget is per-source, not shared across the fan-out.
  //
  // Validation: --timeout requires --source OR --all. Bare `gbrain sync
  // --timeout 60` (no source scope) is rejected at parse time — the natural
  // single-source case requires the user to either name the source or opt
  // into the global fan-out, so the error message tells them which to add.
  const timeoutStr = args.find((a, i) => args[i - 1] === '--timeout');
  let timeoutSeconds: number | undefined;
  try {
    timeoutSeconds = parseDurationSeconds(timeoutStr, '--timeout');
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  const explicitSourceArg = args.find((a, i) => args[i - 1] === '--source');
  if (timeoutSeconds !== undefined && !syncAll && !explicitSourceArg) {
    console.error(`--timeout requires either --source <id> or --all to scope the per-source budget.`);
    process.exit(1);
  }


  // --skip-failed: acknowledge pre-existing unacked failures BEFORE the sync
  // runs, not only ones the current run produces. Without this, the common
  // recovery flow — fix the YAML, re-run sync, then run --skip-failed to
  // clear the log — fails to clear anything: when there are no NEW failures
  // (because the files are now fixed), the inner ack path in performSync is
  // never reached, and "Already up to date." leaves the log untouched. Both
  // doctor and printSyncResult instruct users to run --skip-failed in
  // exactly this case, so the flag has to handle stale entries up-front.

  // v0.18.0 Step 5: --source resolves to a sources(id) row. Falls back
  // to pre-v0.17 global config (sync.repo_path + sync.last_commit) when
  // no flag, no env, no dotfile is present.
  //
  // v0.41.13 (#1434): always call the resolver, not just when explicit/env
  // is set. Pre-fix, `gbrain sync` without --source skipped resolution and
  // left sourceId undefined — which the engine treated as the seeded
  // 'default' source. Users with a single non-default registered source
  // (studiovault, etc.) silently routed every write to a source holding
  // 0 pages, then createVersion threw on the slug lookup.
  //
  // The resolver's new `sole_non_default` tier (5.5) routes those
  // single-source brains to the right place automatically; the nudge
  // surfaces the auto-route to stderr so the user knows what happened
  // and can pass --source to override if needed.
  const explicitSource = args.find((a, i) => args[i - 1] === '--source') || null;
  const { resolveSourceWithTier, resolveSourceForRepoPath, formatSoleNonDefaultNudge } =
    await import('../core/source-resolver.ts');
  // #3765: an explicit --repo anchors source resolution at the REPO dir, not
  // the caller's cwd. Pre-fix, `gbrain sync --repo ~/other-vault` parsed the
  // path but resolved the source from cwd — anchors, page writes, and the
  // per-source lock (`syncLockId(sourceId)`) all followed the WRONG source.
  // Precedence: --source flag > repo-derived (dotfile/local_path at the repo
  // dir) > the ambient chain. A conflicting GBRAIN_SOURCE refuses loudly.
  let resolved: { source_id: string; tier: string; detail?: string } | null = null;
  if (!explicitSource && repoPath) {
    const derived = await resolveSourceForRepoPath(engine, repoPath);
    if (derived) {
      const envSource = process.env.GBRAIN_SOURCE;
      if (envSource && envSource !== derived.source_id) {
        console.error(
          `--repo resolves to source '${derived.source_id}' (via ${derived.tier}) but ` +
          `GBRAIN_SOURCE='${envSource}' is set. Pass --source <id> to disambiguate.`,
        );
        process.exit(1);
      }
      resolved = derived;
      process.stderr.write(
        `[gbrain] routing sync to source '${derived.source_id}' (resolved from --repo via ${derived.tier}).\n`,
      );
    }
  }
  if (!resolved) resolved = await resolveSourceWithTier(engine, explicitSource);
  const sourceId: string = resolved.source_id;
  if (resolved.tier === 'sole_non_default') {
    const nudge = formatSoleNonDefaultNudge(sourceId);
    if (nudge) process.stderr.write(nudge + '\n');
  }

  // --skip-failed: acknowledge pre-existing unacked failures BEFORE the sync
  // runs, not only ones the current run produces. Without this, the common
  // recovery flow — fix the YAML, re-run sync, then run --skip-failed to clear
  // the log — fails to clear anything (no NEW failures → the inner ack path in
  // performSync is never reached, and "Already up to date." leaves the log).
  //
  // v0.42.42.0 (#2139, D13C): scoped PER SOURCE. `--all` clears every source's
  // open failures; single-source clears only its own (don't ack source B's
  // failures when syncing source A). Safe under parallel — the ledger
  // serializes writes via `withLedgerLock` and keys rows by `source_id`
  // (#1939), which is why the old D15 "no --skip-failed under parallel"
  // refusal is lifted below.
  if (skipFailed) {
    const acked = syncAll ? acknowledgeFailures() : acknowledgeFailures(sourceId);
    if (acked.count > 0) console.log(`Acknowledged ${acked.count} pre-existing failure(s).`);
  }

  // v0.19.0 — `sync --all` iterates all registered sources with a
  // local_path. Sources are the canonical v0.18.0 abstraction: per-source
  // last_commit, last_sync_at, config.federated flags. Per-source
  // bookmarks live in the sources table (not ~/.gbrain/config.json),
  // which is why this path replaced Garry's OpenClaw `multi-repo.ts` shim.
  //
  // Only sources with a non-null local_path participate. A GitHub-only
  // source (no checkout) has nothing for `sync` to pull. Sources with
  // syncEnabled=false in config.jsonb are skipped too.
  if (syncAll) {
    // v0.41.31: SELECT carries last_commit + chunker_version so the inline
    // cost preview's "unchanged source → 0" short-circuit can mirror sync's
    // own "do work?" gate (sync.ts:1057+1075) + doctor's sync_freshness.
    // Both columns predate v0.41 (writeSyncAnchor / writeChunkerVersion); no
    // schema migration needed.
    // #3880: archived sources must not re-enter `sync --all`. The archived
    // column is v34+ — fall back to the unfiltered query on older brains
    // (house style per pickSoleNonDefaultSource).
    type SyncAllSourceRow = { id: string; name: string; local_path: string | null; config: Record<string, unknown>; last_commit: string | null; chunker_version: string | null };
    let sources: SyncAllSourceRow[];
    try {
      sources = await engine.executeRaw<SyncAllSourceRow>(
        `SELECT id, name, local_path, config, last_commit, chunker_version FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE`,
      );
    } catch {
      sources = await engine.executeRaw<SyncAllSourceRow>(
        `SELECT id, name, local_path, config, last_commit, chunker_version FROM sources WHERE local_path IS NOT NULL`,
      );
    }
    if (!sources || sources.length === 0) {
      console.log('No sources with local_path configured. Use `gbrain sources add <id> --path <path>` first.');
      return;
    }

    // v0.41.31 — mode-aware cost gate. Resolve federated_v2 ONCE here so both
    // the gate (below) and the fan-out (further down) share it.
    const { isFederatedV2Enabled } = await import('../core/feature-flags.ts');
    const v2Enabled = await isFederatedV2Enabled(engine);

    // v0.40.5.0 Federated Sync v2 (master) + v0.40.6.0 layering (this branch):
    // master added parallel fan-out via pMapAllSettled, embed-backfill auto-
    // submit, --serial / --max-sources / --no-auto-embed flags, and feature-
    // flagged the whole thing behind sync.federated_v2. This branch layers
    // additive improvements on top:
    //   - humanSink swap so `--json` keeps stdout clean (D4)
    //   - --skip-failed / --retry-failed reject under parallel>1 (D15 — the
    //     sync-failures.jsonl is brain-global, parallel acks race)
    //   - connection-budget stderr warning at parallel × workers × 2 > 16 (D10)
    //   - withSourcePrefix wrap inside runOne so slog/serr lines from
    //     performSync get the [<source-id>] prefix under parallel mode (D6)
    //   - stable JSON envelope {schema_version:1, sources, ...} when --json
    // v0.41.31: v2Enabled resolved once above (cost gate). Reused here.
    const activeSources = sources.filter((s) => {
      const cfg = (s.config || {}) as { syncEnabled?: boolean };
      return cfg.syncEnabled !== false;
    });
    const disabledCount = sources.length - activeSources.length;
    const humanSink: NodeJS.WriteStream = jsonOut ? process.stderr : process.stdout;
    const writeHuman = (line: string) => humanSink.write(line + '\n');

    if (disabledCount > 0) {
      writeHuman(`Skipping ${disabledCount} disabled source(s).`);
    }

    // --missing-path skip: classify sources whose checkout is not on this
    // machine instead of failing them (see parseMissingPathMode's rationale).
    // Under the default 'fail' this is a no-op and behavior is unchanged.
    let skippedMissingPath: typeof activeSources = [];
    let runnableSources = activeSources;
    if (missingPathMode === 'skip') {
      const parts = partitionMissingPathSources(activeSources, existsSync);
      runnableSources = parts.runnable;
      skippedMissingPath = parts.missing;
      for (const src of skippedMissingPath) {
        writeHuman(`  ⊘ ${src.name}: skipped — local_path not present on this host (${src.local_path})`);
      }
      if (skippedMissingPath.length > 0) {
        writeHuman(`Skipped ${skippedMissingPath.length} source(s) whose local_path is not present on this host (--missing-path skip).`);
      }
    }

    if (runnableSources.length === 0) {
      if (jsonOut) {
        console.log(JSON.stringify({
          schema_version: 1,
          sources: skippedMissingPath
            .slice()
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((s) => ({
              source_id: s.id,
              name: s.name,
              status: 'skipped_missing_path',
              local_path: s.local_path,
            })),
          parallel: 0,
          ok_count: 0,
          error_count: 0,
          skipped_count: skippedMissingPath.length,
        }));
      }
      return;
    }

    // v0.42.42.0 (#2139) cost gate — shared with single-source sync. Above
    // the floor, non-interactive runs keep importing (never exit 2), but the
    // delivery statement is capability-aware: background queue only when a
    // worker can drain it, otherwise an exact manual command.
    const embedPlan = await resolveSyncAllEmbedPlan(engine, runnableSources, {
      v2Enabled, serialFlag, noEmbed, noAutoEmbed, dryRun, jsonOut, yesFlag, full, includeGitignored,
    });
    if (embedPlan.stop) return;
    const {
      workerSurface: backfillSurface, fanOutEligible, effectiveNoEmbed, shouldBackfill,
    } = embedPlan;

    const embedBackfillBySource = new Map<string, SyncEmbedBackfillOutcome>();

    // Per-source result accumulator for the optional --json envelope.
    type PerSourceResult = {
      sourceId: string;
      sourceName: string;
      status: 'ok' | 'error' | 'skipped_missing_path';
      result?: SyncResult;
      error?: string;
      localPath?: string;
    };
    const perSourceResults: PerSourceResult[] = [];
    for (const src of skippedMissingPath) {
      perSourceResults.push({
        sourceId: src.id,
        sourceName: src.name,
        status: 'skipped_missing_path',
        localPath: src.local_path ?? undefined,
      });
    }

    // #1633 (Part B): one shared SIGINT controller for the whole --all fan-out.
    // process-cleanup.ts doesn't own SIGINT, so without this Ctrl-C hard-cuts the
    // run and can leak per-source locks; here it aborts every in-flight source so
    // each performSync returns `partial` + releases its lock cleanly.
    const allInterrupt = new AbortController();
    const onAllSigint = () => { try { allInterrupt.abort(new Error('SIGINT')); } catch { /* */ } };

    const runOne = async (src: typeof sources[number]): Promise<SyncResult> => {
      const cfg = (src.config || {}) as { strategy?: 'markdown' | 'code' | 'auto' };
      // D18/#2139: planned fan-out or a cost-gate auto-defer skips inline
      // embedding; the post-run delivery below reports/queues each source.
      // v0.41.13.0 (T6 / D-V3-3 / D-V4-mech-6) — per-source AbortController.
      //
      // When the user passes --timeout, each source gets its OWN
      // AbortController + countdown that starts when THIS runOne invocation
      // starts. NOT a shared global controller — codex pass 2 caught that
      // shared shape would starve later sources of their fair budget.
      //
      // try/finally + timer.unref() (D-V4-mech-6):
      //   - finally clearTimeout guarantees cleanup even when performSync
      //     throws (which pMapAllSettled catches outside this closure).
      //     Without finally, a throw would leak the timer and keep the CLI
      //     alive past `setTimeout(..., timeoutMs)`.
      //   - timer.unref() (Node-specific; the optional-chain handles
      //     environments without it) tells the event loop NOT to keep the
      //     process alive solely for this timer. Belt-and-suspenders with
      //     finally — even on a missed clearTimeout, the process can exit
      //     once all real work resolves.
      const controller = timeoutSeconds !== undefined ? new AbortController() : undefined;
      const timer = timeoutSeconds !== undefined
        ? setTimeout(() => controller!.abort(), timeoutSeconds * 1000)
        : undefined;
      timer?.unref?.();
      const repoOpts: SyncOpts = {
        repoPath: msysToNativePath(src.local_path!), // #2955: heal MSYS /c/... before joins
        dryRun, full, noPull,
        noEmbed: effectiveNoEmbed,
        noExtract,
        skipFailed, retryFailed, noSchemaPack,
        includeGitignored,
        workingTree,
        sourceId: src.id,
        strategy: cfg.strategy,
        concurrency,
        signal: composeAbortSignals(allInterrupt.signal, controller?.signal),
      };
      // v0.40.6.0 (D6): wrap performSync in withSourcePrefix so every slog /
      // serr line emitted from inside the sync code path gets prefixed with
      // `[<source-id>] `. Under master's pMapAllSettled fan-out, this is
      // what makes `grep '\[media-corpus\]'` against parallel output work.
      //
      // v0.41.13.0 (T6): wrap the performSync call in try/finally so the
      // per-source timer is always cleared, even on throw.
      let result: SyncResult;
      try {
        result = await withSourcePrefix(src.id, () => performSync(engine, repoOpts));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      // v0.41.13.0 (T7 / D-V3-5): partial joins dry_run + blocked_by_failures
      // in the conservative posture — defer gitignore management to the next
      // clean sync. A partial sync's set of db_only paths isn't fully
      // reconciled, so writing .gitignore entries based on it could leave
      // stale or missing entries.
      if (
        result.status !== 'dry_run' &&
        result.status !== 'blocked_by_failures' &&
        result.status !== 'partial'
      ) {
        manageGitignoreAtGitRoot(src.local_path!, engine.kind);
      }
      // Deliver planned or intrinsic >100-file deferrals. Intrinsic delivery
      // is v2-only on worker-backed engines; no-worker engines still need a
      // manual outcome. This preserves the worker-backed v2-off rollback.
      if (
        (shouldBackfill || (
          result.embedDeferralReason === 'large_sync' &&
          (v2Enabled || backfillSurface.status === 'no_worker_surface')
        )) &&
        !dryRun &&
        result.status !== 'dry_run' &&
        result.status !== 'up_to_date' &&
        result.status !== 'partial'
      ) {
        try {
          const outcome = await resolveSyncEmbedBackfill(engine, src.id, {
            reason: 'sync_all', autoSubmitDisabled: noAutoEmbed,
          });
          embedBackfillBySource.set(src.id, outcome);
          writeHuman(`  → ${formatSyncEmbedBackfillOutcome(outcome, src.name)}`);
        } catch (e) {
          process.stderr.write(`  → embed-backfill submission failed for ${src.name}: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
      return result;
    };

    // v0.42.42.0 (#2139, D13C): the v0.40.6.0 (D15) refusal of --skip-failed /
    // --retry-failed under parallel sync is LIFTED. It existed because the
    // failure ledger was once brain-global with racing acks; #1939 made the
    // ledger per-(source_id, path) and serialized every write through
    // `withLedgerLock`, so parallel per-source acks no longer race. Lifting it
    // also removes the forcing-function that pushed recovery syncs to --serial
    // (and thus armed the inline cost gate) — the root cause behind #2139.

    // Effective parallelism — surfaced in the --json envelope so consumers
    // know how the run was actually dispatched. 1 in the serial fallback,
    // capped at min(sourceCount, --max-sources, 8) in the parallel path.
    const effectiveParallel = fanOutEligible
      ? Math.min(runnableSources.length, maxSources ?? 8)
      : 1;

    process.on('SIGINT', onAllSigint);
    try {
    if (fanOutEligible) {
      const { pMapAllSettled } = await import('../core/parallel.ts');
      const cap = effectiveParallel;

      // v0.40.6.0 (D10): connection-budget stderr warning. Each per-file
      // worker opens its own PostgresEngine with poolSize=2, so the real
      // live-connection ceiling is `cap × workers × 2` per wave plus the
      // parent pool. The original PR understated by 2× — fix the math.
      const effectiveWorkers = concurrency ?? 4;
      const budget = cap * effectiveWorkers * 2;
      if (budget > 16) {
        process.stderr.write(
          `[sync --all] Connection budget: parallel=${cap} × workers=${effectiveWorkers} × 2 ` +
          `(per-file pool) = ${budget} concurrent connections per fan-out wave (+ parent pool). ` +
          `Check pgbouncer/Postgres max_connections (SELECT count(*) FROM pg_stat_activity); ` +
          `raise the cap or lower --max-sources/--workers if you see "too many clients" errors.\n`,
        );
      }

      writeHuman(`\nParallel sync: ${runnableSources.length} sources, ${cap} concurrent workers.\n`);
      const results = await pMapAllSettled(runnableSources, cap, async (src) => {
        const r = await runOne(src);
        return { name: src.name, result: r };
      });
      // Print per-source aggregate at the end. humanSink so --json stays clean.
      writeHuman('\n--- sync --all aggregate ---');
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const src = runnableSources[i];
        if (r.status === 'fulfilled') {
          writeHuman(`  ✓ ${src.name}: ${r.value.result.status} (added=${r.value.result.added}, modified=${r.value.result.modified}, deleted=${r.value.result.deleted})`);
          perSourceResults.push({
            sourceId: src.id,
            sourceName: src.name,
            status: 'ok',
            result: r.value.result,
          });
        } else {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          process.stderr.write(`  ✗ ${src.name}: ${msg}\n`);
          perSourceResults.push({
            sourceId: src.id,
            sourceName: src.name,
            status: 'error',
            error: msg,
          });
        }
      }
    } else {
      for (const src of runnableSources) {
        writeHuman(`\n--- Syncing source: ${src.name} ---`);
        try {
          const result = await runOne(src);
          printSyncResult(result, humanSink);
          perSourceResults.push({
            sourceId: src.id,
            sourceName: src.name,
            status: 'ok',
            result,
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          process.stderr.write(`Error syncing ${src.name}: ${msg}\n`);
          perSourceResults.push({
            sourceId: src.id,
            sourceName: src.name,
            status: 'error',
            error: msg,
          });
        }
      }
    }
    } finally {
      process.off('SIGINT', onAllSigint);
    }

    const okCount = perSourceResults.filter((r) => r.status === 'ok').length;
    const errCount = perSourceResults.filter((r) => r.status === 'error').length;

    if (jsonOut) {
      // Sort by source_id at emit time so the envelope is deterministic
      // even though completion order is not (pMapAllSettled semantics).
      const sortedSources = perSourceResults
        .slice()
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
        .map((r) => ({
          source_id: r.sourceId,
          name: r.sourceName,
          status: r.status,
          ...(r.localPath ? { local_path: r.localPath } : {}),
          ...(r.result ? {
            sync_status: r.result.status,
            // #3068: surface the partial reason (e.g. pull_failed) so JSON
            // consumers can distinguish a self-healing timeout from a wedge.
            ...(r.result.reason ? { reason: r.result.reason } : {}),
            added: r.result.added,
            modified: r.result.modified,
            deleted: r.result.deleted,
            chunks_created: r.result.chunksCreated,
            embedded: r.result.embedded,
            // Warning aggregates (malformed filenames, alias/undeclared
            // types) — the whole point of the result-field plumbing is that
            // JSON/worker consumers can see them (codex re-review).
            ...(r.result.malformedSkipped ? { malformed_skipped: r.result.malformedSkipped } : {}),
            ...(r.result.type_warnings ? { type_warnings: r.result.type_warnings } : {}),
          } : {}),
          ...(r.error ? { error: r.error } : {}),
          ...(embedBackfillBySource.has(r.sourceId)
            ? { embed_backfill: embedBackfillBySource.get(r.sourceId) }
            : {}),
        }));
      console.log(JSON.stringify({
        schema_version: 1,
        sources: sortedSources,
        parallel: effectiveParallel,
        ok_count: okCount,
        error_count: errCount,
        skipped_count: perSourceResults.filter((r) => r.status === 'skipped_missing_path').length,
      }));
    }

    // v0.42.7 (#1696): brain-wide extraction-lag nudge after the --all wave.
    // Best-effort, stderr-only; skipped on dry-run.
    if (!dryRun) await maybeExtractionNudge(engine);
    // Monthly backup-coverage stale-only refresh (trusted local engine holder).
    if (!dryRun) await maybeBackupCoverageRefresh(engine);

    // #3068: any source wedged on a failed pull (partial/pull_failed) makes
    // the whole --all run non-zero — it will not self-heal on retry, so a
    // green exit would hide it from cron/monitoring. Timeout-class partials
    // keep the pre-existing exit-0 behavior (they converge on retry).
    const pullFailedCount = perSourceResults.filter(
      (r) => r.status === 'ok' && r.result?.status === 'partial' && r.result.reason === 'pull_failed',
    ).length;
    if (errCount > 0 || pullFailedCount > 0) process.exit(1);
    return;
  }

  // v0.41.13.0 (T6) — single-source --timeout: same per-source AbortController
  // shape as the --all runOne closure. Timer scoped to this CLI invocation;
  // try/finally clears it after performSync resolves (or throws).
  const singleSourceController = timeoutSeconds !== undefined ? new AbortController() : undefined;
  const singleSourceTimer = timeoutSeconds !== undefined
    ? setTimeout(() => singleSourceController!.abort(), timeoutSeconds * 1000)
    : undefined;
  singleSourceTimer?.unref?.();
  // #1633 (Part B): graceful SIGINT cancel. process-cleanup.ts owns SIGTERM
  // (lock release + exit) and the watchdog owns the hard deadline; SIGINT is
  // deliberately left to callers, so Ctrl-C during a long sync aborts the
  // in-flight import cleanly (performSync returns `partial`, bookmark unadvanced,
  // lock released by its own finally) instead of a hard cut.
  const singleSourceInterrupt = new AbortController();
  const onSingleSourceSigint = () => { try { singleSourceInterrupt.abort(new Error('SIGINT')); } catch { /* */ } };
  const opts: SyncOpts = {
    repoPath, dryRun, full, noPull, noEmbed, noExtract, skipFailed, retryFailed, noSchemaPack, includeGitignored, workingTree, sourceId,
    strategy: strategyArg, concurrency,
    srcSubpath,
    exclude: excludePatterns.length > 0 ? excludePatterns : undefined,
    includeHidden: includeHiddenPatterns.length > 0 ? includeHiddenPatterns : undefined,
    signal: composeAbortSignals(singleSourceInterrupt.signal, singleSourceController?.signal),
  };

  // v0.42.42.0 (#2139, Step 4b): single-source `gbrain sync` gets the SAME
  // inline cost gate as `--all`. Previously single-source embedded inline with
  // NO gate (only rail: the ≤100-file inline cap). Single-source always embeds
  // INLINE (not the parallel-deferred fan-out), so mode is forced 'inline'.
  // Skipped on --no-embed, --dry-run (performSync's own dry-run previews and
  // spends nothing), and watch. Non-TTY above floor AUTO-DEFERS — so adding
  // the gate can never wedge an existing cron; it converts silent ungated
  // inline spend into informed inline-or-deferred spend.
  let singleSourceAutoDefer = false;
  let singleSourceNoWorkerSurface = false;
  if (!noEmbed && !dryRun && !watch) {
    const gateRows = await engine.executeRaw<{ local_path: string | null; config: Record<string, unknown>; last_commit: string | null; chunker_version: string | null }>(
      `SELECT local_path, config, last_commit, chunker_version FROM sources WHERE id = $1`,
      [sourceId],
    );
    if (gateRows.length > 0) {
      const gate = await resolveSingleSyncEmbedPlan(engine, {
        sourceId,
        local_path: gateRows[0].local_path ?? repoPath ?? null,
        config: gateRows[0].config ?? {},
        last_commit: gateRows[0].last_commit,
        chunker_version: gateRows[0].chunker_version,
      }, {
        dryRun: false,
        jsonOut, yesFlag, full, includeGitignored, noAutoEmbed,
      });
      singleSourceNoWorkerSurface = gate.workerSurface.status === 'no_worker_surface';
      if (gate.stop) return;
      if (gate.autoDeferEmbeds) {
        opts.noEmbed = true;
        singleSourceAutoDefer = true;
      }
    }
  }

  // Bug 9 — --retry-failed: before running normal sync, clear acknowledgment
  // flags so the sync picks them up as fresh work. The actual re-attempt
  // happens inside the regular incremental/full loop because once the commit
  // pointer is behind the failures, the diff naturally revisits them.
  if (retryFailed) {
    // v0.42.42.0 (#2139, D13C): scope the retry count to THIS source — rows
    // carry source_id (#1939), so a single-source retry shouldn't report
    // another source's failures.
    const failures = unacknowledgedSyncFailures().filter(f => f.source_id === sourceId);
    if (failures.length === 0) {
      console.log('No unacknowledged sync failures to retry.');
    } else {
      console.log(`Retrying ${failures.length} previously-failed file(s)...`);
      // Don't acknowledge them yet — they must succeed to clear.
    }
  }

  if (!watch) {
    // v0.41.13.0 (T6): try/finally clears the single-source timer so it
    // doesn't fire after performSync resolves OR throws.
    let result: SyncResult;
    process.on('SIGINT', onSingleSourceSigint);
    try {
      result = await performSync(engine, opts);
    } finally {
      if (singleSourceTimer !== undefined) clearTimeout(singleSourceTimer);
      process.off('SIGINT', onSingleSourceSigint);
    }
    printSyncResult(result, jsonOut ? process.stderr : process.stdout);
    // #3068: a pull_failed partial is NOT a success — unlike timeout-class
    // partials (which converge on retry), a failing pull will not self-heal.
    // Exit non-zero so cron/monitoring sees the wedge instead of a green run.
    // Routed through the owned verdict channel (NOT bare `process.exitCode`,
    // which PGLite's Emscripten runtime clobbers mid-run — see
    // src/core/cli-force-exit.ts).
    if (result.status === 'partial' && result.reason === 'pull_failed') {
      const { setCliExitVerdict } = await import('../core/cli-force-exit.ts');
      setCliExitVerdict(1);
    }
    // v0.42.7 (#1696, D5): extraction-lag nudge after a completed single-source
    // sync. Fire on every non-error completion (synced | first_sync | up_to_date)
    // — NOT just 'synced'; a fresh/--full import (`first_sync`) is the biggest
    // un-extracted backlog. Scoped to this source; best-effort, stderr-only.
    if (shouldNudgeAfterSync(result.status)) await maybeExtractionNudge(engine, sourceId);
    // Monthly backup-coverage: the sync CLI legitimately holds the engine
    // (trusted local), so the stale-only compute piggybacks here — covering
    // active CLI users without any serve involvement. Dry-run stays pure.
    if (result.status !== 'dry_run') await maybeBackupCoverageRefresh(engine);
    // Issue #2 + eng-review pass-2 finding #1 + Codex P1: manage .gitignore ONLY
    // on successful sync. Skip on dry-run (don't mutate disk in preview mode)
    // and blocked_by_failures (sync state is inconsistent — defer .gitignore
    // until next clean run). v0.41.13.0 (T7 / D-V3-5): partial also skips —
    // conservative posture matches blocked_by_failures. Resolve the effective
    // repo path so the wire-up fires in the common case where the user runs
    // `gbrain sync` without passing --repo every time.
    if (
      result.status !== 'dry_run' &&
      result.status !== 'blocked_by_failures' &&
      result.status !== 'partial'
    ) {
      const effectiveRepoPath = opts.repoPath ?? (await getDefaultSourcePath(engine));
      if (effectiveRepoPath) {
        manageGitignoreAtGitRoot(effectiveRepoPath, engine.kind);
      }
    }
    // v0.42.42.0 (#2139, Step 4b): the inline gate auto-deferred this run's
    // embeds (non-TTY, above floor) — enqueue a capped backfill job so the
    // NULL-embedded chunks get embedded out of band instead of being stranded.
    let singleEmbedBackfill: SyncEmbedBackfillOutcome | undefined;
    if (
      (singleSourceAutoDefer || (
        singleSourceNoWorkerSurface && result.embedDeferralReason === 'large_sync'
      )) &&
      result.status !== 'dry_run' &&
      result.status !== 'up_to_date' &&
      result.status !== 'partial'
    ) {
      try {
        singleEmbedBackfill = await resolveSyncEmbedBackfill(engine, sourceId, {
          reason: 'sync_autodefer', autoSubmitDisabled: noAutoEmbed,
        });
        process.stderr.write(`  → ${formatSyncEmbedBackfillOutcome(singleEmbedBackfill)}.\n`);
      } catch (e) {
        process.stderr.write(`  → embed-backfill submission failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
    if (jsonOut) {
      console.log(JSON.stringify(buildSingleSyncJsonEnvelope(sourceId, result, singleEmbedBackfill)));
    }
    return;
  }

  // Watch mode
  let consecutiveErrors = 0;
  console.log(`Watching for changes every ${interval}s... (Ctrl+C to stop)`);

  while (true) {
    try {
      const result = await performSync(engine, { ...opts, full: false });
      consecutiveErrors = 0;
      if (result.status === 'synced') {
        const ts = new Date().toISOString().slice(11, 19);
        console.log(`[${ts}] Synced: +${result.added} ~${result.modified} -${result.deleted} R${result.renamed}`);
      }
      // Same gate as non-watch: only manage .gitignore on successful sync.
      // v0.41.13.0 (T7 / D-V3-5): partial joins the deferred posture.
      // Same repo-resolution path so watch mode catches the implicit-resolved case.
      if (
        result.status !== 'dry_run' &&
        result.status !== 'blocked_by_failures' &&
        result.status !== 'partial'
      ) {
        const effectiveRepoPath = opts.repoPath ?? (await getDefaultSourcePath(engine));
        if (effectiveRepoPath) {
          manageGitignoreAtGitRoot(effectiveRepoPath, engine.kind);
        }
      }
    } catch (e: unknown) {
      consecutiveErrors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${new Date().toISOString().slice(11, 19)}] Sync error (${consecutiveErrors}/5): ${msg}`);
      if (consecutiveErrors >= 5) {
        console.error(`5 consecutive sync failures. Stopping watch.`);
        process.exit(1);
      }
    }
    await new Promise(r => setTimeout(r, interval * 1000));
  }
}

/** Mode for `sync --all --missing-path`: what to do when a source's
 * local_path does not exist on this machine. */
export type MissingPathMode = 'fail' | 'skip';

/**
 * Parse `--missing-path <fail|skip>` (default: fail).
 *
 * Why the flag exists: `sources.local_path` is machine-specific state in a
 * brain-wide table. Any brain whose sources were registered from more than
 * one machine — or a sanctioned setup mid-migration (topologies.md Topology 2,
 * or the system-of-record git flow before every repo is cloned here) — has
 * sources whose checkout simply is not present on the machine running
 * `sync --all`. Each used to surface as a hard failure ("Not a git
 * repository: <path>") and force rc=1 on every run; on one observed fleet
 * that was 12 phantom failures per hour, which trains operators to ignore
 * the exit code.
 *
 * The DEFAULT stays `fail`: on a single-machine brain a missing local_path
 * usually means an unmounted volume or a deleted checkout, and silently
 * skipping it would hide real data loss. Skip is an explicit opt-in.
 *
 * Throws on a bad/absent value with a paste-ready hint (caller converts to
 * stderr + exit 2, same as other flag-misuse exits).
 */
export function parseMissingPathMode(args: string[]): MissingPathMode {
  const idx = args.indexOf('--missing-path');
  if (idx === -1) return 'fail';
  const val = args[idx + 1];
  if (val === 'fail' || val === 'skip') return val;
  throw new Error(
    `--missing-path expects 'fail' or 'skip', got: ${val ?? '(nothing)'}. ` +
    `Use \`--missing-path skip\` to classify sources whose local_path is not ` +
    `present on this machine as skipped instead of failed, or \`--missing-path ` +
    `fail\` (the default) to keep them loud.`,
  );
}

/**
 * Partition `--all` sources by whether their local_path exists on THIS
 * machine. Classification is driven only by the injected predicate so tests
 * never touch the filesystem. A null local_path passes through as runnable —
 * pure-DB sources are already excluded from `--all` by the
 * `local_path IS NOT NULL` SELECT; this is defensive, not load-bearing.
 */
export function partitionMissingPathSources<T extends { local_path: string | null }>(
  sources: T[],
  pathExists: (p: string) => boolean,
): { runnable: T[]; missing: T[] } {
  const runnable: T[] = [];
  const missing: T[] = [];
  for (const s of sources) {
    if (s.local_path != null && !pathExists(s.local_path)) missing.push(s);
    else runnable.push(s);
  }
  return { runnable, missing };
}

/**
 * v0.40.3.0 — resolve effective per-source concurrency for `sync --all`.
 *
 * Inputs:
 *   - sourceCount: number of `syncEnabled !== false` sources to walk
 *   - explicitParallel: user's `--parallel N` value (post `parseWorkers`),
 *     `undefined` when the flag was not provided
 *   - workers: user's `--workers N` value, used as a soft cap when no
 *     explicit `--parallel` is given. The per-source budget can't exceed
 *     the per-file worker count because each per-file worker opens its
 *     own PostgresEngine pool — see DEFAULT_PARALLEL_SOURCES in
 *     `src/core/sync-concurrency.ts` for the connection-math story.
 *   - engineKind: PGLite is single-connection → always returns 1.
 *
 * Rules:
 *   - PGLite → always 1
 *   - sourceCount <= 0 → 1 (divide-by-zero guard)
 *   - explicit `--parallel` → wins, clamped to `[1, sourceCount]`
 *   - auto path → `min(sourceCount, workers ?? DEFAULT_PARALLEL_SOURCES)`
 *
 * Returns >= 1. Single-source brains return 1 (no point fanning out).
 */
export function resolveParallelism(input: {
  sourceCount: number;
  explicitParallel?: number;
  workers?: number;
  engineKind: 'pglite' | 'postgres';
}): number {
  if (input.engineKind === 'pglite') return 1;
  if (input.sourceCount <= 0) return 1;
  if (input.explicitParallel !== undefined) {
    return Math.max(1, Math.min(input.explicitParallel, input.sourceCount));
  }
  const ceiling = input.workers && input.workers > 0
    ? Math.min(input.workers, DEFAULT_PARALLEL_SOURCES)
    : DEFAULT_PARALLEL_SOURCES;
  return Math.max(1, Math.min(input.sourceCount, ceiling));
}

/**
 * v0.40.3.0 — per-source sync wrapper for the `--all` worker pool.
 *
 * Three responsibilities:
 *   1. Build the per-source `SyncOpts` from the shared CLI flags.
 *   2. Wrap the call in `withSourcePrefix(src.id, ...)` so every
 *      `slog`/`serr` line emitted from inside `performSync` (and its
 *      callees) gets prefixed with `[<source-id>] ` for greppable
 *      parallel output (D6 + D12 + D13).
 *   3. Pre-render the start banner into the returned `log` string so
 *      the worker pool flushes it (and any subsequent `printSyncResult`)
 *      via the human sink — which `--json` routes to stderr to keep
 *      stdout JSON-only (D4).
 *
 * Note: source.name is shown in the start banner (one-shot, easy to
 * escape) but the prefix on every line uses source.id (slug-validated;
 * no newline-injection risk per D13).
 *
 * The per-source DB lock invariant (D8) fires inside `performSync` —
 * since `repoOpts.sourceId` is set, the per-source lock is the default.
 * `withRefreshingLock` (D11) handles TTL renewal automatically for
 * sources that exceed 30 minutes.
 */
export async function syncOneSource(
  engine: BrainEngine,
  src: { id: string; name: string; local_path: string | null; config: Record<string, unknown> },
  shared: {
    dryRun: boolean;
    full: boolean;
    noPull: boolean;
    noEmbed: boolean;
    skipFailed: boolean;
    retryFailed: boolean;
    concurrency: number | undefined;
    /** v0.41.37.0 #1569: propagate --no-schema-pack into every per-source sync. */
    noSchemaPack?: boolean;
    /** v0.42.7 #1696: propagate --no-extract into every per-source sync. */
    noExtract?: boolean;
    includeGitignored?: boolean;
    /** Untracked-gap fix: propagate --working-tree into every per-source sync. */
    workingTree?: boolean;
  },
): Promise<{ result: SyncResult; log: string }> {
  const cfg = (src.config || {}) as { strategy?: 'markdown' | 'code' | 'auto' };
  const log = `\n--- Syncing source: ${src.name} ---\n`;
  const repoOpts: SyncOpts = {
    repoPath: msysToNativePath(src.local_path!), // #2955: heal MSYS /c/... before joins
    dryRun: shared.dryRun,
    full: shared.full,
    noPull: shared.noPull,
    noEmbed: shared.noEmbed,
    noExtract: shared.noExtract,
    skipFailed: shared.skipFailed,
    retryFailed: shared.retryFailed,
    noSchemaPack: shared.noSchemaPack,
    includeGitignored: shared.includeGitignored,
    workingTree: shared.workingTree,
    sourceId: src.id,
    strategy: cfg.strategy,
    concurrency: shared.concurrency,
    // lockId defaults to `gbrain-sync:${src.id}` via the performSync invariant (sourceId triggers it).
  };
  const result = await withSourcePrefix(src.id, () => performSync(engine, repoOpts));
  return { result, log };
}

// The status-report cluster (buildSyncStatusReport, printSyncStatusReport)
// was peeled to src/core/sync-status-report.ts (pure move). Re-exported so
// existing importers keep working.
export {
  buildSyncStatusReport,
  printSyncStatusReport,
  type SyncStatusReport,
  type SyncStatusReportSource,
} from '../core/sync-status-report.ts';

/**
 * Auto-manage .gitignore entries for db_only directories.
 *
 * Caller invokes ONLY on successful sync — this function trusts that the
 * sync's data state is consistent. See `runSync` for the gating logic.
 *
 * Idempotent: re-running adds no duplicate entries. The managed block has
 * a stable comment header so it's grep-able and editable.
 *
 * Skipped (with actionable warning) when:
 *   - GBRAIN_NO_GITIGNORE=1 — D23 escape hatch for shared-repo setups
 *   - The repo is a git submodule (`.git` is a file not a directory) —
 *     D49 lock; submodule .gitignore changes don't survive parent updates
 *
 * On PGLite (D4): emits a once-per-process soft-warn explaining that
 * tiering has limited effect — but still manages the .gitignore so the
 * config-present user gets the gitignore housekeeping.
 *
 * Failures (write permission denied, EROFS, etc.) are caught, warned, and
 * swallowed (D9 lock). Sync's primary job is moving data; .gitignore
 * management is a side effect — don't kill the main job for the side effect.
 */
let _pgliteTierWarned = false;
export function __resetPGLiteTierWarn(): void {
  _pgliteTierWarned = false;
}

export function manageGitignore(
  repoPath: string,
  engineKind?: 'pglite' | 'postgres',
): void {
  if (process.env.GBRAIN_NO_GITIGNORE === '1') {
    return;
  }

  // Submodule + worktree detection (closes #889 misclassification).
  // Both submodules and worktrees use `.git` as a FILE (not a directory), so
  // statSync.isFile() doesn't discriminate. Discriminator is the gitdir path
  // segment:
  //   - submodule: gitdir contains `/modules/<name>` (skip — managed by parent)
  //   - worktree:  gitdir contains `/worktrees/<name>` (MANAGE — first-class repo)
  // Both contracts are documented Git internal layouts and stable across all 4
  // {relative, absolute} × {modules, worktrees} combinations, including the
  // absorbed-submodule case from `git submodule absorbgitdirs`.
  // Malformed `.git` file (no `gitdir:` prefix, unreadable) → MANAGE (fail-closed
  // toward managing, preserving the pre-#889 catch{} behavior).
  const dotGit = join(repoPath, '.git');
  if (existsSync(dotGit)) {
    try {
      if (statSync(dotGit).isFile()) {
        const content = readFileSync(dotGit, 'utf-8');
        const match = content.match(/gitdir:\s*(.+)/);
        const gitdir = match ? match[1].trim() : '';
        if (gitdir.includes('/modules/')) {
          console.warn(
            `Note: skipping .gitignore management — ${repoPath} is a git submodule. ` +
              `Add db_only directories to your parent repo's .gitignore manually.`,
          );
          return;
        }
        // Worktree (gitdir contains /worktrees/) OR malformed .git falls through
        // to the existing manage path. Worktrees are first-class repos — they
        // need .gitignore management too. Malformed → MANAGE preserves the
        // pre-#889 fail-closed-toward-managing catch behavior.
      }
    } catch {
      // proceed; can't tell, default to managing
    }
  }

  let storageConfig;
  try {
    storageConfig = loadStorageConfig(repoPath);
  } catch (error) {
    // StorageConfigError (overlap) or read error — surface, don't manage.
    console.warn(
      `Skipped .gitignore update: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!storageConfig || storageConfig.db_only.length === 0) {
    return;
  }

  // #2788: a configured collector whose output dir sits inside a db_only
  // path dies silently — the dir is auto-gitignored below, the git-walking
  // sync never sees its files, and `gbrain import` honors .gitignore too.
  // Warn at the moment the config takes effect. Recipe scan failure never
  // blocks the gitignore housekeeping.
  try {
    for (const c of findDbOnlyCollisions(getConfiguredCollectorOutputs(), storageConfig.db_only)) {
      console.warn(
        `WARNING: collector '${c.id}' writes to '${c.output_path}', which is inside db_only path ` +
          `'${c.db_only_dir}'. db_only dirs are auto-gitignored, so gbrain sync and gbrain import ` +
          `will silently skip its files. Remove the prefix from storage.db_only in gbrain.yml, or ` +
          `move the collector output.`,
      );
    }
  } catch {
    // recipes unavailable in this context — the doctor check still covers it
  }

  // D4 soft-warn: storage tiering has limited effect on PGLite, but the
  // .gitignore housekeeping still helps. Warn once per process; proceed.
  if (engineKind === 'pglite' && !_pgliteTierWarned) {
    _pgliteTierWarned = true;
    console.warn(
      `Note: storage tiering has limited effect on PGLite — pages live in your ` +
        `local database file regardless of tier. Managing .gitignore anyway.`,
    );
  }

  const gitignorePath = join(repoPath, '.gitignore');
  let gitignoreContent = '';

  if (existsSync(gitignorePath)) {
    try {
      gitignoreContent = readFileSync(gitignorePath, 'utf-8');
    } catch (error) {
      console.warn(
        `Could not read ${gitignorePath} (${error instanceof Error ? error.message : String(error)}) — ` +
          `skipping .gitignore update. Add db_only directories manually.`,
      );
      return;
    }
  }

  const existingLines = new Set(gitignoreContent.split('\n').map((line) => line.trim()));
  const linesToAdd: string[] = [];

  for (const dir of storageConfig.db_only) {
    if (!existingLines.has(dir) && !existingLines.has(`/${dir}`)) {
      linesToAdd.push(dir);
    }
  }

  if (linesToAdd.length === 0) return;

  if (gitignoreContent && !gitignoreContent.endsWith('\n')) {
    gitignoreContent += '\n';
  }
  gitignoreContent += '\n# Auto-managed by gbrain (db_only directories)\n';
  gitignoreContent += linesToAdd.join('\n') + '\n';

  try {
    writeFileSync(gitignorePath, gitignoreContent);
  } catch (error) {
    console.warn(
      `Could not update ${gitignorePath} (${error instanceof Error ? error.message : String(error)}) — ` +
        `please add db_only directories manually:\n  ${linesToAdd.join('\n  ')}`,
    );
  }
}

/**
 * Post-sync backup-coverage refresh (monthly, stale-only). The sync CLI is a
 * trusted local engine holder (D4), so the compute piggybacks here; the
 * shared choke point (getBackupStatus) makes a fresh cache a no-op file read.
 * Best-effort — never blocks or fails a sync.
 */
async function maybeBackupCoverageRefresh(engine: BrainEngine): Promise<void> {
  try {
    const { backupCheckDisabled, isBackupStatusStale, loadBackupStatus } = await import(
      '../core/backup/status-file.ts'
    );
    if (backupCheckDisabled() || !isBackupStatusStale(loadBackupStatus())) return;
    const { getBackupStatus } = await import('../core/backup/coverage.ts');
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
async function maybeExtractionNudge(engine: BrainEngine, sourceId?: string): Promise<void> {
  if (process.env.GBRAIN_SYNC_NO_EXTRACT_NUDGE) return;
  try {
    const { LINK_EXTRACTOR_VERSION_TS } = await import('../core/link-extraction.ts');
    // D3/C4: resolve the warn threshold + vacuous-skip floor through the SAME
    // helpers the doctor check uses (dynamic import keeps doctor.ts off sync's
    // eager-load path) so "the nudge fires iff doctor would warn" can't drift.
    const { _resolveEnvNumber, EXTRACTION_LAG_WARN_PCT_DEFAULT, EXTRACTION_LAG_MIN_PAGES } = await import('./doctor.ts');
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
    const stale = await engine.countStalePagesForExtraction({ sourceId, versionTs: LINK_EXTRACTOR_VERSION_TS });
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
      write(`Synced ${result.fromCommit?.slice(0, 8)}..${result.toCommit.slice(0, 8)}:`);
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
}
