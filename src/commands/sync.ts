import { type ManagedSyncFailure } from '../core/persistence/sync-failures.ts';
import type { BrainEngine } from '../core/engine.ts';
import { DEFAULT_PARALLEL_SOURCES } from '../core/sync-concurrency.ts';
import { withHumanLogsToStderr, withSourcePrefix } from '../core/console-prefix.ts';
import { msysToNativePath } from '../core/path-confine.ts';
import { performSync } from './sync/perform.ts';
import { runSyncInner } from './sync/run.ts';

// Refactor wave 1 (W4 sync): the implementation lives in src/commands/sync/.
// This file keeps the SyncResult / SyncOpts types and every export, so
// existing importers need no change (CLAUDE.md façade rule).
export { shouldNudgeAfterSync, printSyncResult } from './sync/report.ts';
export { runSyncTrigger } from './sync/trigger.ts';
export { performSync } from './sync/perform.ts';
export { parseMissingPathMode, partitionMissingPathSources, type MissingPathMode } from './sync/missing-path.ts';
export { __resetPGLiteTierWarn, manageGitignore } from './sync/gitignore.ts';

export interface SyncResult {
  failures?: ManagedSyncFailure[];
  runId?: string;
  managedWrite?: import('../core/persistence/sync-run.ts').ManagedSyncWriteDiagnostic;
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
  pagesAffected: string[]; /** #5867: a Google sweep's loops_extract enqueue (sweep plus managed catch-up). */ loops_enqueue?: { enqueued: number; deferred: number; skipped_reason: string | null };
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
  /** #5751: unchanged managed working-tree files skipped although a no-op publication cannot resolve their admit reason. */
  legacySkips?: { contextualMode: number; canonicalBytes: number }; /** #5984: managed entries advanced without a write (DX-A7), and how a still-unfinished managed write's wait ended (DX-A3). */ waived?: { imports: number; deletes: number }; writeWait?: import('../core/persistence/sync-run.ts').ManagedSyncWriteWait;
  /** Managed sync: files skipped because another origin keeps their slug, and links derived after the checkpoint. */
  slugCollisions?: import('../core/persistence/sync-discovery.ts').SyncSlugCollision[];
  fileRefusals?: import('../core/persistence/sync-discovery.ts').SyncFileRefusal[]; links?: import('../core/persistence/links-maintenance.ts').ManagedLinkExtraction;
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
  /** Post-sync link/timeline extraction failure (A15); the affected pages stay stale. */
  extract_error?: string;
  /** #5050: full sync re-sealed unchanged pages at the safe-chunk fence (see RunImportResult.resealed). */
  resealed?: import('./import.ts').RunImportResult['resealed'];
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
   * cron operators can disambiguate timeout vs pull-timeout in monitoring; connector item failures / early stop exit 1 (isFailedPartial).
   */
  filesImported?: number;
  reason?: 'timeout' | 'pull_timeout' | 'pull_failed' | 'stall_timeout' | 'checkpoint_unavailable' | 'writer_pending' | 'writer_yield' | 'connector_item_failures' | 'connector_partial';
  /**
   * v0.42.x (#1794): cumulative file paths durably banked to the checkpoint
   * across THIS run + prior resumed runs. Surfaced on every partial/blocked
   * exit so an operator who kills a sync can see progress was banked — instead
   * of reading only `last_commit` (unchanged by design) and concluding "lost
   * everything," the exact misdiagnosis in the #1794 recurrence report.
   */
  bankedFiles?: number;
  /** #5984: the managed drain's verdict and the next step for the agent (see sync-drain.ts). */
  drain?: import('../core/persistence/sync-drain.ts').DrainReport;
  /** #5984: managed cursor position (`index` of `total` manifest entries) and its active drain window. */
  managedCursor?: { index: number; total: number; progress?: import('../core/persistence/sync-run.ts').CursorProgress };
  /** Fix wave 4: connector items held after repeated item-scoped failures (not blocking freshness). */
  connectorHolds?: { held: number; newly_held: number; retry_command: string; status_command: string };
  /**
   * #5988 Git holds: files held this run instead of blocking (detail capped at
   * `sync.hold_cap`), their count, the source's outstanding total and the
   * exact inspect and repair commands. Remote callers get `held_count` and
   * `holds_fix` (a host-operator relay) only.
   */
  held?: import('../core/persistence/sync-holds.ts').GitHoldItem[];
  held_count?: number;
  holds_outstanding?: number;
  holds_escalated?: boolean;
  holds_truncated?: boolean;
  /** A sliced run (`writer_yield`) has not screened every entry yet. */
  holds_pending_screen?: boolean;
  holds_fix?: import('../core/agent-output.ts').Action;
  /** Requests of a blocked cursor this run converted in place (held, or re-frozen after the file was fixed). */
  converted_from_failed?: string[];
  /** Files imported by quoting unquoted frontmatter values, cumulative for the run. */
  recovered_frontmatter?: import('../core/persistence/sync-holds.ts').RecoveredFrontmatter;
  /** Dry run: files the run would hold, and entries the screen could not judge (never holds). */
  dry_run?: true;
  would_hold?: import('../core/persistence/sync-holds.ts').GitHoldItem[];
  would_hold_count?: number;
  screen_skipped?: Array<{ path: string; code: string }>;
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
  /** Managed connector sources: discard the connector checkpoint and re-walk the window once (CLI --reset-checkpoint). */
  resetCheckpoint?: boolean;
  /**
   * v0.41.37.0 #1569 — skip loading the active schema pack during sync. When set,
   * `loadActivePack` is not called, so no user-supplied pack page-type regex
   * (markdown.ts subtype path_pattern) runs during import. Pages fall back to
   * legacy prefix typing. Escape hatch for completing a sync when a suspect
   * pack regex is the suspected cause of a wedge; re-run extraction later.
   * Threaded through performSync AND syncOneSource so `sync --all` honors it.
   */
  noSchemaPack?: boolean;
  /** Processing options this caller set; an unfinished managed cursor supplies the rest (unset = all explicit). */
  explicitProcessing?: Array<'noEmbed' | 'noExtract' | 'noSchemaPack'>;
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
   *
   * Unioned with the persisted `sync.include_hidden` config key (same dialect
   * and trailing-`/` normalization as `sync.exclude`), so callers that never
   * touch the CLI — `sync --all`, autopilot, the dream cycle — inherit the
   * waiver. Union, not override; unset admits nothing.
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
  onProgress?: (p: { phase: string; bankedFiles?: number; total?: number; waived?: boolean; group?: number;
    /** #5984 lanes (phase `managed_sync.lanes`). */ lanes?: { effective: number; stepDown: string | null; overlapped: number; fallbacks: number } }) => void;
  /**
   * #5984: managed sync only. Re-enter the single-pass managed sync until the
   * cursor is done, the caller's signal/deadline stops it, or it is blocked
   * (src/core/persistence/sync-drain.ts). Set by the CLI; jobs and library
   * callers keep the single-pass contract.
   */
  drain?: boolean;
  /** #5984: wall-clock ms the current drain started; managed cursors measure their rate from it. */
  drainStartedAt?: number;
  /** #5984: `--no-bulk`; and the drain's resolved bulk settings (internal; absent = one request per pass step). */ noBulk?: boolean; bulk?: import('../core/persistence/sync-group.ts').BulkSettings;
  /** #5984 lanes: `--lanes N` (1..8) or `--no-lanes` (1). */ lanes?: number;
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

// The lock layer minus performSync (SyncLockBusyError, formatLockBusyMessage,
// runBreakLock, buildPartialResult) was peeled to src/core/sync-lock.ts
// (pure move). Re-exported so existing importers keep working.
export { SyncLockBusyError, runBreakLock } from '../core/sync-lock.ts';

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

export async function runSync(engine: BrainEngine, args: string[]) {
  // #4888: under --json, stdout is reserved for the ONE JSON envelope (#4684:
  // the cost-gate status object rides inside it as `cost_gate`); every slog()
  // human line from performSync and its callees routes to stderr instead.
  // serr/progress are stderr already, and the envelope's own
  // console.log(JSON.stringify(..)) site is untouched by the wrap.
  return args.includes('--json')
    ? withHumanLogsToStderr(() => runSyncInner(engine, args))
    : runSyncInner(engine, args);
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
