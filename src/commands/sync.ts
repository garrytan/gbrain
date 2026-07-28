import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { execFileSync, spawn } from 'child_process';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import type { BrainEngine } from '../core/engine.ts';
import { DELETE_BATCH_SIZE } from '../core/engine-constants.ts';
import {
  computeCodeImportHash,
  computeParsedMarkdownContentHash,
  importFile,
  isImageFilePath,
} from '../core/import-file.ts';
import { collectSyncableFiles } from './import.ts';
import { createInterface } from 'readline';
import {
  isCodeFilePath,
  isSyncable,
  unsyncableReason,
  matchesAnyGlob,
  resolveSlugForPath,
  unacknowledgedSyncFailures,
  acknowledgeFailures,
  loadSyncFailures,
  formatCodeBreakdown,
  applySyncFailureGate,
  isSkippablePath,
  resolveAutoSkipThreshold,
  DEFAULT_SOURCE_ID,
} from '../core/sync.ts';
import { parseMarkdown } from '../core/markdown.ts';
import { applyInference } from '../core/frontmatter-inference.ts';
import type { PageType } from '../core/types.ts';
import {
  computeSyncDelta,
  buildDetachedWorkingTreeManifest,
} from '../core/sync-delta.ts';
import { fetchRemote } from '../core/git-remote.ts';
import {
  parseUsdLimit,
  formatUsdLimit,
  resolveSpendPosture,
} from '../core/spend-posture.ts';
import { estimateTokens, CHUNKER_VERSION } from '../core/chunkers/code.ts';
import {
  estimateEmbeddingCostUsd,
  getEmbeddingModelName,
  currentEmbeddingPricePerMTok,
  currentEmbeddingSignature,
  willEmbedSynchronously,
  shouldBlockSync,
  type SyncEmbedMode,
} from '../core/embedding.ts';
import { estimateCostFromChars } from '../core/embedding-pricing.ts';
import { SPEND_CAP_CONFIG_KEY } from '../core/embed-backfill-submit.ts';
import type { SyncManifest } from '../core/sync.ts';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import { loadConfig } from '../core/config.ts';
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
  LockReleaseFailedError,
  getLockReleaseFailure,
  syncLockId,
} from '../core/db-lock.ts';
import {
  withSourcePrefix,
  slog,
  serr,
} from '../core/console-prefix.ts';
import { loadStorageConfig } from '../core/storage-config.ts';
import { getDefaultSourcePath } from '../core/source-resolver.ts';
// v0.41.32.0: stamp the durable newest-COMMIT timestamp at sync time so the
// remote staleness path reads a column instead of shelling out to git.
// lagFromContentMs is the remote/column comparator (buildSyncStatusReport
// backs the get_status_snapshot MCP op — must NOT shell out to git).
import { newestCommitMs, commitTimeMs, lagFromContentMs } from '../core/source-health.ts';
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
import { type DbPacer, createDbPacer, createNoopPacer, observed } from '../core/db-pacer.ts';
import { resolvePaceMode, loadPaceModeConfig, readPaceEnv } from '../core/pace-mode.ts';
import { AbortError } from '../core/abort-check.ts';
import { parseSourceConfig } from '../core/sources-load.ts';
import {
  createSyncPlan,
  type SyncAffectedSummary,
  type SyncPlan,
  type SyncPlanCorpus,
  type SyncPlanOperation,
  type SyncPlanStrategy,
} from '../core/sync-plan.ts';

/**
 * v0.42.x (#1794) -- resumable incremental sync checkpoint.
 *
 * Two op-checkpoint rows back one resumable incremental sync, both keyed by
 * the same syncFingerprint(sourceId, lastCommit):
 *   - op 'sync'        -> completed_keys = repo-relative file paths drained
 *   - op 'sync-target' -> completed_keys = [pinnedTargetCommit]
 *   - op 'sync-target-provenance' -> completed_keys = ['ordinary' | 'exact-target']
 *
 * Splitting the pinned target into its own row keeps the path set free of any
 * sentinel that could collide with a real filename. Provenance prevents a
 * paired exact-target apply from trusting paths checkpointed by an ordinary
 * sync that may have imported mutable working-tree bytes. All three rows clear
 * together on full completion. The fingerprint encodes ONLY (sourceId,
 * lastCommit) -- never the target or live HEAD -- so the checkpoint survives
 * every killed-and-resumed run while lastCommit..HEAD grows underneath it.
 */
const SYNC_CKPT_OP = 'sync';
const SYNC_TARGET_OP = 'sync-target';
const SYNC_TARGET_PROVENANCE_OP = 'sync-target-provenance';
const SYNC_TARGET_PROVENANCE_ORDINARY = 'ordinary';
const SYNC_TARGET_PROVENANCE_EXACT = 'exact-target';

function syncCheckpointKeys(
  sourceId: string | undefined,
  lastCommit: string,
): {
  paths: OpCheckpointKey;
  target: OpCheckpointKey;
  provenance: OpCheckpointKey;
} {
  const fp = syncFingerprint({ sourceId, lastCommit });
  return {
    paths: { op: SYNC_CKPT_OP, fingerprint: fp },
    target: { op: SYNC_TARGET_OP, fingerprint: fp },
    provenance: { op: SYNC_TARGET_PROVENANCE_OP, fingerprint: fp },
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
  preserved?: number;
  chunksCreated: number;
  /** Pages re-embedded during this sync's auto-embed step. 0 if --no-embed or skipped. */
  embedded: number;
  pagesAffected: string[];
  failedFiles?: number; // count of parse failures (Bug 9)
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
  /** Validated, read-only plan evidence returned by a dry run. */
  previewKind?: 'validated_index_plan';
  sourceId?: string;
  strategy?: SyncPlanStrategy;
  lastSuccessfulStrategy?: SyncPlanStrategy | null;
  strategyChanged?: boolean;
  checkpointReset?: boolean;
  affected?: SyncAffectedSummary;
  affectedDigest?: string;
  planDigest?: string;
  planCorpus?: SyncPlanCorpus;
}

/**
 * Walk ONE source's working tree and sum tokens for every syncable file.
 * Conservative full-tree CEILING (full file content, not the incremental
 * diff) — over-counts, never under-counts. Used only on the ceiling rungs of
 * `estimateInlineNewTokens` (first sync, chunker drift, git-unavailable),
 * where the delta is genuinely the whole tree or can't be computed.
 *
 * v0.31.2: routed through collectSyncableFiles (lstat + inode-cycle +
 * max-depth) so the preview walks exactly what the real sync walks.
 *
 * Exported (v0.42.42.0, #2139) for direct unit testing.
 */
export function estimateSourceTreeTokens(
  localPath: string,
  strategy: 'markdown' | 'code' | 'auto',
  opts: { includeGitignored?: boolean } = {},
): { tokens: number; files: number } {
  let tokens = 0;
  let files = 0;
  try {
    const fileList = collectSyncableFiles(localPath, { strategy, includeGitignored: opts.includeGitignored });
    for (const fullPath of fileList) {
      try {
        const stat = statSync(fullPath);
        if (stat.size > 5_000_000) continue; // skip large binaries
        const content = readFileSync(fullPath, 'utf-8');
        tokens += estimateTokens(content);
        files++;
      } catch {
        // Best-effort per file; sync itself tolerates the same.
      }
    }
  } catch {
    // Best-effort: a source whose local_path is gone/unreadable contributes 0.
  }
  return { tokens, files };
}

/** Sum tokens for an explicit set of repo-relative paths read at live working-tree content. */
function estimateDeltaTokens(localPath: string, relPaths: string[]): number {
  let tokens = 0;
  for (const rel of relPaths) {
    try {
      const full = join(localPath, rel);
      const stat = statSync(full);
      if (stat.size > 5_000_000) continue; // skip large binaries (matches tree walk)
      tokens += estimateTokens(readFileSync(full, 'utf-8'));
    } catch {
      // Listed in the diff but unreadable (e.g. since deleted) → 0, like the tree walk.
    }
  }
  return tokens;
}

/**
 * v0.42.42.0 (#2139): resolve the commit the estimate should diff AGAINST.
 *
 * The cost gate runs BEFORE sync's own `git pull`, so a stale local HEAD would
 * make the estimate blind to commits the run is about to pull (codex #1). So
 * we FETCH first (fail-open) and target `origin/<branch>` — the estimate then
 * prices exactly what this run will sync. The subsequent pull fast-forwards
 * the already-fetched objects, so net new network cost ≈ 0.
 *
 *   - detached HEAD → no upstream; target = local HEAD (+ caller merges the
 *     detached working-tree manifest, which sync imports on a detached repo).
 *   - attached + origin remote → fetch origin/<branch> (best-effort), target =
 *     origin/<branch> if resolvable, else local HEAD (offline / no upstream).
 *   - HEAD unresolvable (not a git repo) → null (caller treats as unavailable).
 *
 * NOTE: this makes `--dry-run` perform a network fetch so the preview reflects
 * what a real run would pull. Fail-open: offline dry-run still previews against
 * local HEAD. Uses the shared `git()` 30s budget (the fetch cost is the pull
 * cost paid a few seconds early — a tighter cap would frequently fall back to
 * local HEAD and underestimate the remote delta).
 */
function resolveEstimateTarget(localPath: string): { target: string; detached: boolean } | null {
  let head: string;
  try {
    head = git(localPath, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
  const detached = isDetachedHead(localPath);
  if (detached) return { target: head, detached: true };

  let branch: string | null = null;
  try {
    branch = git(localPath, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || null;
  } catch {
    branch = null;
  }
  if (branch && branch !== 'HEAD' && hasOriginRemote(localPath)) {
    try {
      // v0.42.42.0 (#2139): route through the SSRF-hardened fetch (same flags +
      // no-prompt env as pullRepo) — a cost preview / dry-run must NOT hit a
      // remote through a less-protected path than real sync.
      fetchRemote(localPath, branch, { timeoutMs: 30_000 });
    } catch {
      // fail-open: offline, auth failure, no upstream — fall through to local HEAD.
    }
    try {
      const remoteSha = git(localPath, ['rev-parse', `origin/${branch}`]);
      if (remoteSha) return { target: remoteSha, detached: false };
    } catch {
      // no remote-tracking ref for this branch — use local HEAD.
    }
  }
  return { target: head, detached: false };
}

export type EstimateKind = 'delta' | 'ceiling' | 'mixed' | 'unchanged';

export interface InlineEstimate {
  tokens: number;
  changedSources: number;
  unchangedSources: number;
  estimateKind: EstimateKind;
  /** Per-source ceiling reasons (chunker_drift / first_sync / git_unavailable) for honest labeling. */
  ceilingReasons: string[];
}

/**
 * v0.42.42.0 (#2139) — INLINE-path new-content estimate. The estimate now
 * MIRRORS EXECUTION instead of pricing the whole tree on every dirty sync (the
 * 400x overestimate that wedged the daily cron). Per-source fail-open ladder:
 *
 *   1. syncEnabled === false                  → skip (unchanged)
 *   2. chunker drift (stored !== current)     → full-tree CEILING (a drift forces
 *        performFullSync → full re-chunk → full re-embed; a delta would
 *        underestimate by the whole corpus). kind: ceiling_chunker_drift
 *   3. last_commit === fetch target           → 0 (mirrors `up_to_date` at
 *        sync.ts:1402 — NO clean-working-tree requirement; a dirty tree whose
 *        commits are caught up imports nothing). kind: unchanged
 *   4. last_commit === null (first sync)      → full-tree CEILING. kind: ceiling_first_sync
 *   5. computeSyncDelta ok                    → price added∪modified∪renamed.to
 *        (syncable, live working-tree content); deletes cost 0. kind: delta
 *   6. computeSyncDelta unavailable           → full-tree CEILING. kind: ceiling_git_unavailable
 *
 * The delta rung routes through the SAME `computeSyncDelta` the executor uses
 * (src/core/sync-delta.ts), so the gate's dollar figure can't drift from what
 * the sync imports. `--full`'s extra stale-backlog sweep is added by the gate
 * (it already has `staleCostUsd`), not here — see the call site.
 *
 * Exported for direct unit testing.
 */
export function estimateInlineNewTokens(
  sources: Array<{
    local_path: string | null;
    config: Record<string, unknown>;
    last_commit: string | null;
    chunker_version: string | null;
  }>,
  currentChunkerVersion: string,
  opts: { forceFullTree?: boolean } = {},
): InlineEstimate {
  let tokens = 0;
  let changedSources = 0;
  let unchangedSources = 0;
  let hadDelta = false;
  let hadCeiling = false;
  const ceilingReasons: string[] = [];

  const ceiling = (localPath: string, strategy: 'markdown' | 'code' | 'auto', reason: string) => {
    tokens += estimateSourceTreeTokens(localPath, strategy).tokens;
    changedSources++;
    hadCeiling = true;
    ceilingReasons.push(reason);
  };

  for (const src of sources) {
    if (!src.local_path) continue;
    const cfg = (src.config || {}) as { syncEnabled?: boolean; strategy?: 'markdown' | 'code' | 'auto' };
    if (cfg.syncEnabled === false) continue;
    const strategy = cfg.strategy ?? 'markdown';
    const localPath = src.local_path;

    if (opts.forceFullTree) {
      tokens += estimateSourceTreeTokens(localPath, strategy, { includeGitignored: true }).tokens;
      changedSources++;
      hadCeiling = true;
      ceilingReasons.push('include_gitignored');
      continue;
    }

    // Rung 2: chunker drift forces a full re-chunk → full re-embed. CEILING.
    if (src.chunker_version !== currentChunkerVersion) {
      ceiling(localPath, strategy, 'chunker_drift');
      continue;
    }

    // Rung 4 (early): no bookmark → first sync imports everything. CEILING.
    if (!src.last_commit) {
      ceiling(localPath, strategy, 'first_sync');
      continue;
    }

    const resolved = resolveEstimateTarget(localPath);
    if (!resolved) {
      // HEAD unresolvable (not a git repo / gone) — can't compute a delta. CEILING.
      ceiling(localPath, strategy, 'git_unavailable');
      continue;
    }

    // Rung 3: caught up to the fetch target AND no detached working-tree changes.
    // Mirrors the executor's `up_to_date` predicate — a dirty-but-committed-current
    // tree imports nothing, so it must price $0 (the heart of the false-fire fix).
    const detachedManifest = resolved.detached
      ? buildDetachedWorkingTreeManifest(localPath)
      : null;
    const detachedHasChanges = detachedManifest !== null &&
      (detachedManifest.added.length > 0 ||
        detachedManifest.modified.length > 0 ||
        detachedManifest.deleted.length > 0 ||
        detachedManifest.renamed.length > 0);
    if (src.last_commit === resolved.target && !detachedHasChanges) {
      unchangedSources++;
      continue;
    }

    // Rung 5/6: the delta itself — SAME helper the executor diffs with.
    const delta = computeSyncDelta(localPath, src.last_commit, resolved.target, {
      detachedManifest,
    });
    if (delta.status === 'unavailable') {
      ceiling(localPath, strategy, 'git_unavailable');
      continue;
    }
    const syncOpts = { strategy };
    const changedPaths = unique([
      ...delta.manifest.added.filter(p => isSyncable(p, syncOpts)),
      ...delta.manifest.modified.filter(p => isSyncable(p, syncOpts)),
      ...delta.manifest.renamed.filter(r => isSyncable(r.to, syncOpts)).map(r => r.to),
    ]);
    tokens += estimateDeltaTokens(localPath, changedPaths);
    changedSources++;
    hadDelta = true;
  }

  const estimateKind: EstimateKind =
    hadCeiling && hadDelta ? 'mixed' : hadCeiling ? 'ceiling' : hadDelta ? 'delta' : 'unchanged';
  return { tokens, changedSources, unchangedSources, estimateKind, ceilingReasons };
}

/**
 * Resolve the inline-path cost-gate floor in USD. Config key
 * `sync.cost_gate_min_usd` (DB plane), default $0.50. Below this estimate
 * the inline gate proceeds without blocking. Fail-open to the default on a
 * missing/invalid value or a config-read error (the gate must never crash
 * the sync). Accepts 0 (an operator can set the floor to $0 to make the
 * gate block on any nonzero inline cost).
 */
async function resolveCostGateFloorUsd(engine: BrainEngine): Promise<number> {
  try {
    const raw = await engine.getConfig('sync.cost_gate_min_usd');
    // v0.42.42.0 (#2139): `0` keeps meaning "block on any nonzero spend"
    // (allowZero); `off`/`unlimited`/`none` → Infinity so the gate never
    // blocks (`costUsd > Infinity` is always false).
    return parseUsdLimit(raw, 0.5, { allowZero: true });
  } catch {
    return 0.5;
  }
}

/**
 * Resolve the per-source embed-backfill 24h spend cap (USD) for the deferred
 * notice. Mirrors embed-backfill-submit.ts's own resolution of
 * SPEND_CAP_CONFIG_KEY (default 25). Fail-open to the default.
 */
async function resolveBackfillCapUsd(engine: BrainEngine): Promise<number> {
  try {
    const raw = await engine.getConfig(SPEND_CAP_CONFIG_KEY);
    // v0.42.42.0 (#2139): no allowZero — `0` falls back to the default
    // (off semantics ≠ 0); `off`/`unlimited`/`none` → Infinity (cap disabled).
    return parseUsdLimit(raw, 25);
  } catch {
    return 25;
  }
}

/** Interactive [y/N] prompt. Resolves false on non-y answers or EOF. */
async function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
    rl.on('close', () => resolve(false));
  });
}

// v0.42.42.0 (#2139): paste-ready knobs appended to every gate message so the
// spend-control surface is discoverable at the moment of need (humans + agents),
// not only after reading source. Closes the issue's "takes archaeology" complaint.
const SPEND_HINT =
  'widen: gbrain config set sync.cost_gate_min_usd 5 | ' +
  'never gate: gbrain config set spend.posture tokenmax | ' +
  'docs: docs/operations/spend-controls.md';

/** Honest token label — delta vs full-tree ceiling, with the ceiling reasons. */
function labelEstimate(inline: InlineEstimate): string {
  if (inline.estimateKind === 'unchanged') return '0 new tokens (sources caught up)';
  if (inline.estimateKind === 'delta') {
    return `~${inline.tokens.toLocaleString()} new tokens (delta: changed files since last sync)`;
  }
  // ceiling | mixed — be explicit that this is an over-count, not the real spend.
  const reasons = unique(inline.ceilingReasons).join(', ') || 'unknown';
  return (
    `<=${inline.tokens.toLocaleString()} tokens (full-tree ceiling for ${inline.changedSources} ` +
    `source(s): ${reasons} — unchanged files skip via content_hash at execution)`
  );
}

type CostGateSource = {
  local_path: string | null;
  config: Record<string, unknown>;
  last_commit: string | null;
  chunker_version: string | null;
};

interface CostGateContext {
  sources: CostGateSource[];
  /** Resolved embed mode. Single-source is always 'inline' (not the parallel-deferred fan-out). */
  mode: SyncEmbedMode;
  dryRun: boolean;
  jsonOut: boolean;
  yesFlag: boolean;
  full: boolean;
  includeGitignored?: boolean;
  /** Message prefix ('sync --all' | 'sync'). */
  label: string;
}

interface CostGateReceipt {
  status: string;
  mode: SyncEmbedMode;
  gate: string;
  [key: string]: unknown;
}

type CostGateOutcome =
  | {
      action: 'proceed';
      autoDeferEmbeds: boolean;
      receipt: CostGateReceipt;
    }
  | { action: 'stop'; receipt: CostGateReceipt };

/**
 * v0.42.42.0 (#2139): the inline-embed cost gate, shared by BOTH `sync --all`
 * and single-source `sync` so the spend surface is consistent. Runs at the
 * COMMAND layer (never inside performSync, which `runOne` also calls — that
 * would double-gate `--all`).
 *
 * Behavior:
 *   - deferred mode → FYI only, never blocks (backfill cap is the money gate).
 *   - inline + below floor → proceed quietly.
 *   - inline + spend.posture=tokenmax → informational, proceed inline.
 *   - inline + above floor + TTY → [y/N] prompt.
 *   - inline + above floor + non-TTY/--json → AUTO-DEFER embeds to capped
 *     backfill jobs, exit 0 (NEVER exit 2 — the wedged-cron fix). Caller sets
 *     effectiveNoEmbed and enqueues the backfill.
 *
 * Output format splits on the EXPLICIT `--json` flag only (absorbs the
 * TODOS.md:340 #1784 conflation): JSON envelope iff `--json`, else human text.
 */
async function runInlineCostGate(
  engine: BrainEngine,
  ctx: CostGateContext,
): Promise<CostGateOutcome> {
  const { sources, mode, dryRun, jsonOut, yesFlag, full, label } = ctx;

  // Stale backlog: cheap single SQL; fail-open to 0 so a transient DB hiccup
  // never blocks the sync. Signature-aware (model/dims swap surfaces here).
  let staleChars = 0;
  try {
    staleChars = await engine.sumStaleChunkChars({ signature: currentEmbeddingSignature() });
  } catch {
    staleChars = 0;
  }
  const staleCostUsd = estimateCostFromChars(staleChars, currentEmbeddingPricePerMTok());
  const embeddingModelName = getEmbeddingModelName();
  const floorUsd = await resolveCostGateFloorUsd(engine);
  const posture = await resolveSpendPosture(engine);

  if (mode === 'deferred') {
    // Deferred path: print an FYI, NEVER block. The backfill cap is the real
    // money gate.
    const capUsd = await resolveBackfillCapUsd(engine);
    let queuedBackfills = 0;
    try {
      const r = await engine.executeRaw<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM minion_jobs
          WHERE name = 'embed-backfill'
            AND status IN ('waiting','active','delayed','waiting-children')`,
      );
      queuedBackfills = Number(r[0]?.n) || 0;
    } catch {
      queuedBackfills = 0;
    }
    const deferredMsg =
      `${label}: embedding deferred to backfill jobs ` +
      `(capped $${formatUsdLimit(capUsd)}/source/24h, not charged by this sync). ` +
      `Current backlog ~${staleChars.toLocaleString()} chars (~$${staleCostUsd.toFixed(2)} on ` +
      `${embeddingModelName}) across ${sources.length} source(s); ` +
      `${queuedBackfills} backfill job(s) queued.`;
    if (dryRun) {
      const receipt: CostGateReceipt = {
        status: 'dry_run',
        mode,
        gate: 'dry_run',
        staleChars,
        staleCostUsd,
        capUsd: formatUsdLimit(capUsd),
        floorUsd: formatUsdLimit(floorUsd),
        queuedBackfills,
        model: embeddingModelName,
      };
      if (jsonOut) {
        console.log(JSON.stringify(receipt));
      } else {
        console.log(deferredMsg);
        console.log('--dry-run: exit without syncing.');
      }
      return { action: 'stop', receipt };
    }
    const receipt: CostGateReceipt = {
      status: 'deferred',
      mode,
      gate: 'deferred_notice',
      staleChars,
      staleCostUsd,
      capUsd: formatUsdLimit(capUsd),
      floorUsd: formatUsdLimit(floorUsd),
      queuedBackfills,
      model: embeddingModelName,
    };
    if (jsonOut) {
      console.log(JSON.stringify(receipt));
    } else {
      console.log(deferredMsg);
    }
    return { action: 'proceed', autoDeferEmbeds: false, receipt };
  }

  // ── Inline path ───────────────────────────────────────────────
  const inline = estimateInlineNewTokens(sources, String(CHUNKER_VERSION), {
    forceFullTree: ctx.includeGitignored === true,
  });
  // D7A: `--full` runs `performFullSync` → `runEmbedCore({stale:true})`, which
  // sweeps the pre-existing stale backlog INLINE on top of the delta. Price it.
  const costUsd = estimateEmbeddingCostUsd(inline.tokens) + (full ? staleCostUsd : 0);
  const fullNote = full && staleChars > 0
    ? ` (includes ~${staleChars.toLocaleString()} stale-backlog chars swept by --full)`
    : '';
  const staleNote = !full && staleChars > 0
    ? ` (plus ~${staleChars.toLocaleString()} stale-backlog chars pending \`gbrain embed --stale\`)`
    : '';
  const previewMsg =
    `${label} preview (inline embed): ${inline.changedSources} changed source(s), ` +
    `${inline.unchangedSources} unchanged; ${labelEstimate(inline)}, ` +
    `est. $${costUsd.toFixed(2)} on ${embeddingModelName}${fullNote}${staleNote}.`;

  if (dryRun) {
    const receipt: CostGateReceipt = {
      status: 'dry_run',
      mode,
      gate: 'dry_run',
      newTokens: inline.tokens,
      estimateKind: inline.estimateKind,
      staleChars,
      costUsd,
      floorUsd: formatUsdLimit(floorUsd),
      model: embeddingModelName,
    };
    if (jsonOut) {
      console.log(JSON.stringify(receipt));
    } else {
      console.log(previewMsg);
      console.log('--dry-run: exit without syncing.');
    }
    return { action: 'stop', receipt };
  }

  // --yes bypasses the gate entirely (embed inline, no preview).
  if (yesFlag) {
    return {
      action: 'proceed',
      autoDeferEmbeds: false,
      receipt: {
        status: 'proceeding',
        mode,
        gate: 'accepted_yes',
        newTokens: inline.tokens,
        estimateKind: inline.estimateKind,
        costUsd,
        floorUsd: formatUsdLimit(floorUsd),
        model: embeddingModelName,
      },
    };
  }

  // spend.posture=tokenmax → informational, proceed INLINE (operator declared
  // cost isn't the constraint; don't defer).
  if (posture === 'tokenmax') {
    const receipt: CostGateReceipt = {
      status: 'proceeding',
      mode,
      gate: 'posture_tokenmax',
      newTokens: inline.tokens,
      estimateKind: inline.estimateKind,
      costUsd,
      floorUsd: formatUsdLimit(floorUsd),
      model: embeddingModelName,
      hint: SPEND_HINT,
    };
    if (jsonOut) {
      console.log(JSON.stringify(receipt));
    } else {
      console.log(`${previewMsg} spend.posture=tokenmax: proceeding (informational). ${SPEND_HINT}`);
    }
    return { action: 'proceed', autoDeferEmbeds: false, receipt };
  }

  // Link intent: search.mode=tokenmax but spend posture unset → nudge once.
  let searchModeHint = '';
  try {
    const sm = await engine.getConfig('search.mode');
    if (typeof sm === 'string' && sm.trim().toLowerCase() === 'tokenmax') {
      searchModeHint =
        ` (search.mode=tokenmax detected — \`gbrain config set spend.posture tokenmax\` ` +
        `makes cost gates informational)`;
    }
  } catch {
    /* best-effort */
  }

  if (shouldBlockSync(costUsd, floorUsd, mode, posture)) {
    const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
    if (isTTY && !jsonOut) {
      // Interactive TTY: prompt [y/N].
      console.log(previewMsg + searchModeHint);
      const answer = await promptYesNo('Proceed? [y/N] ');
      if (!answer) {
        console.log('Cancelled.');
        return {
          action: 'stop',
          receipt: {
            status: 'cancelled',
            mode,
            gate: 'confirmation_declined',
            newTokens: inline.tokens,
            estimateKind: inline.estimateKind,
            costUsd,
            floorUsd: formatUsdLimit(floorUsd),
            model: embeddingModelName,
          },
        };
      }
      return {
        action: 'proceed',
        autoDeferEmbeds: false,
        receipt: {
          status: 'proceeding',
          mode,
          gate: 'confirmation_accepted',
          newTokens: inline.tokens,
          estimateKind: inline.estimateKind,
          costUsd,
          floorUsd: formatUsdLimit(floorUsd),
          model: embeddingModelName,
        },
      };
    }
    // Non-TTY or --json: AUTO-DEFER embeds to capped backfill jobs. NEVER exit 2
    // (the wedged-cron fix). Format splits on the explicit --json flag only.
    const receipt: CostGateReceipt = {
      status: 'auto_deferred',
      mode,
      gate: 'auto_deferred_embeds',
      newTokens: inline.tokens,
      estimateKind: inline.estimateKind,
      costUsd,
      floorUsd: formatUsdLimit(floorUsd),
      model: embeddingModelName,
      hint: SPEND_HINT,
    };
    if (jsonOut) {
      console.log(JSON.stringify(receipt));
    } else {
      console.log(
        `${previewMsg} Exceeds floor $${formatUsdLimit(floorUsd)} in a non-interactive ` +
        `session — importing now, deferring embeds to capped backfill jobs. ` +
        `Drain: run the jobs worker or \`gbrain embed --stale\`. Pass --yes to embed inline.\n${SPEND_HINT}`,
      );
    }
    return { action: 'proceed', autoDeferEmbeds: true, receipt };
  }

  // Below floor → proceed without blocking (kills inline-cron noise).
  const receipt: CostGateReceipt = {
    status: 'below_floor',
    mode,
    gate: 'below_floor',
    newTokens: inline.tokens,
    estimateKind: inline.estimateKind,
    staleChars,
    costUsd,
    floorUsd: formatUsdLimit(floorUsd),
    model: embeddingModelName,
  };
  if (jsonOut) {
    console.log(JSON.stringify(receipt));
  } else {
    console.log(`${previewMsg} Below cost gate floor ($${formatUsdLimit(floorUsd)}), proceeding.`);
  }
  return { action: 'proceed', autoDeferEmbeds: false, receipt };
}

export interface SyncOpts {
  repoPath?: string;
  dryRun?: boolean;
  full?: boolean;
  noPull?: boolean;
  noEmbed?: boolean;
  noExtract?: boolean;
  /** Bug 9 — acknowledge + skip past current failure set (CLI --skip-failed). */
  skipFailed?: boolean;
  /** Bug 9 — re-attempt unacknowledged failures explicitly (CLI --retry-failed). */
  retryFailed?: boolean;
  /**
   * Paired preview/apply preconditions. `undefined` means no assertion;
   * `null` for expectedBookmark means the caller requires no bookmark.
   */
  expectedTarget?: string;
  expectedBookmark?: string | null;
  /** Full schema-1 preview commitment required by every paired real apply. */
  expectedPlanDigest?: string;
  requireClean?: boolean;
  /**
   * Internal: this invocation must produce the strict schema-1 receipt.
   * The CLI sets it for --json so receipt preconditions are checked before
   * any page, bookmark, checkpoint, extraction, or embedding mutation.
   */
  schema1Receipt?: boolean;
  /** Internal machine-readable evidence from the command-layer spend gate. */
  costGateReceipt?: CostGateReceipt;
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
  /** Multi-repo: sync strategy override (markdown, code, auto). */
  strategy?: 'markdown' | 'code' | 'auto';
  /**
   * Internal: immutable plan captured under this source lock for a paired
   * preview/apply invocation. Never accepted from CLI input.
   */
  validatedPlan?: SyncPlan;
  /**
   * Internal active pack snapshot used to build validatedPlan. Paired apply
   * imports with this same object so a config flip cannot reopen plan inputs
   * between digest verification and mutation.
   */
  validatedActivePack?: SyncActivePack | null;
  /**
   * Internal: private materialization of the exact paired target commit.
   * Git history and source identity are still read from repoPath; every
   * planner/import filesystem read is redirected here so concurrent worktree
   * writers cannot change the bytes bound to validatedPlan.
   */
  targetTreeRoot?: string;
  /**
   * Internal, invocation-scoped monotonic record for schema-1 error receipts.
   * The transient sync lock is reported separately as lock_only; this journal
   * tracks any repository, checkpoint, page, ledger, bookmark, or enrichment
   * mutation that may have begun.
   */
  mutationJournal?: SyncMutationJournal;
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
   */
  exclude?: string[];
  /**
   * Include files matched by .gitignore. Git cannot report untracked ignored
   * changes in diffs, so sync uses the full filesystem walker when this is set.
   */
  includeGitignored?: boolean;
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
}

interface SyncMutationJournal {
  stateChanged: 'none' | 'partial';
}

function createSyncMutationJournal(): SyncMutationJournal {
  return { stateChanged: 'none' };
}

function markSyncMutation(opts: SyncOpts): void {
  if (opts.dryRun !== true && opts.mutationJournal) {
    opts.mutationJournal.stateChanged = 'partial';
  }
}

function mutationEnvelopeState(
  journal: SyncMutationJournal,
): GBrainSyncErrorEnvelope['state_changed'] | undefined {
  return journal.stateChanged === 'partial' ? 'partial' : undefined;
}

/**
 * v0.32.7 CJK wave (codex post-merge F4): resolve a slug by `pages.source_path`
 * first, falling back to `resolveSlugForPath(path)`.
 *
 * Frontmatter-fallback pages (emoji-only / Thai / Arabic / exotic-script
 * filenames where `slugifyPath` returns empty and the slug came from the
 * frontmatter) have a slug that ISN'T derivable from the path. Delete and
 * rename operations that only know the path would otherwise orphan these
 * pages by trying to delete the path-derived (wrong) slug.
 *
 * Returns the actual stored slug when source_path matches a row, or the
 * path-derived slug when there's no match (normal-case path-derived pages).
 */
export async function resolveSlugByPathOrSourcePath(
  engine: BrainEngine,
  path: string,
  sourceId?: string,
): Promise<string> {
  // v0.41.19.0 (D8): when sourceId is set, delegate to the new batch
  // resolveSlugsByPaths so single-call and batched paths share one SQL
  // owner + one fallback semantic. One Map allocation per single-call;
  // negligible cost. When sourceId is undefined (legacy unscoped callers),
  // fall back to the original executeRaw shape — the batch method
  // requires sourceId to prevent the multi-source-bug-class on its new
  // surface (D5). The unscoped fallback preserves back-compat.
  try {
    if (sourceId) {
      const m = await engine.resolveSlugsByPaths([path], { sourceId });
      const slug = m.get(path);
      if (slug) return slug;
    } else {
      const rows = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages WHERE source_path = $1 LIMIT 1`,
        [path],
      );
      if (rows.length > 0 && rows[0].slug) return rows[0].slug;
    }
  } catch {
    // Fall through — best-effort. Pre-migration brains or query errors
    // shouldn't break delete/rename for path-derived pages.
  }
  return resolveSlugForPath(path);
}

/**
 * git CLI helper.
 *
 * `configs` flags are emitted as `-c key=val` pairs BEFORE `-C repoPath` and
 * BEFORE the subcommand. `core.quotepath=false` is always emitted first so CJK
 * (and other non-ASCII) paths arrive as UTF-8 in `diff --name-status` and
 * sibling commands. Callers that need additional git config should pass via
 * the `configs` parameter; never inline `-c` into `args`.
 *
 * Exported for `test/sync.test.ts` invariant assertion only.
 */
export function buildGitInvocation(repoPath: string, args: string[], configs: string[] = []): string[] {
  const cfg = ['core.quotepath=false', ...configs].flatMap(c => ['-c', c]);
  return [...cfg, '-C', repoPath, ...args];
}

export function buildAutoEmbedArgs(slugs: string[], sourceId?: string): string[] {
  return sourceId ? ['--source', sourceId, '--slugs', ...slugs] : ['--slugs', ...slugs];
}

/**
 * Resolve sync's effective no-embed mode from CLI args + config.
 *
 * The deferred-setup sentinel (`embedding_disabled: true`, written by
 * `gbrain init --no-embedding`) is an implicit `--no-embed`: without this,
 * the embed credential preflight demands provider credentials the user
 * deliberately deferred at init, and every `gbrain sync` on a keyless
 * brain exits 1. See embed-preflight.ts's skip protocol — the sentinel is
 * meant to be honored before the credential check ever runs.
 *
 * Exported for `test/sync-no-embed-sentinel.test.ts`.
 */
export function resolveNoEmbed(
  args: string[],
  cfg: { embedding_disabled?: boolean } | null,
): boolean {
  return args.includes('--no-embed') || cfg?.embedding_disabled === true;
}

/**
 * Shell out to git with a generous maxBuffer.
 *
 * Node's default maxBuffer is 1 MiB.  `git diff --name-status -M` on a
 * 60–100K file repo easily exceeds that, causing an ENOBUFS crash that
 * kills the sync process with no error message in the log.
 *
 * 100 MiB is generous but still bounded — a 100K-file diff with long
 * paths tops out around 10–20 MiB in practice.
 *
 * `silenceStderr`: Node's `execFileSync` writes the child's stderr straight
 * through to the parent's real stderr by default (in addition to attaching
 * it to the thrown error's `.stderr`) *unless* an explicit `stdio` array is
 * given. Callers that treat a failure as an expected, self-handled outcome
 * (rather than a crash to surface) pass `silenceStderr: true` so git's raw
 * `fatal: ...` line never reaches the process's own stderr — only the
 * caller's own (usually friendlier) handling of the caught error does.
 * Default `false` preserves today's passthrough for every other call site.
 */
function git(
  repoPath: string,
  args: string[],
  configs: string[] = [],
  timeoutMs = 30000,
  { silenceStderr = false }: { silenceStderr?: boolean } = {},
): string {
  return execFileSync('git', buildGitInvocation(repoPath, args, configs), {
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 100 * 1024 * 1024,
    ...(silenceStderr ? { stdio: ['ignore', 'pipe', 'pipe'] as const } : {}),
  }).trim();
}

/**
 * #753/#774: walk up from inputPath to the nearest git repo root via
 * `git -C <path> rev-parse --show-toplevel`. Handles worktrees and submodules
 * natively (git itself resolves them). Throws a user-friendly error when no
 * git repo is found.
 *
 * The probe's failure is expected and routine (a non-git-yet brain dir, a
 * scratch dir, a caller checking "is this a repo?") — `sync.ts` self-heals
 * it (git-init) or surfaces the message below, never the raw git stderr.
 * `silenceStderr: true` keeps git's own `fatal: not a git repository ...`
 * off the process's real stderr so operator log-scanning for `fatal:` as a
 * crash signature doesn't false-alarm on every routine probe miss (#2964
 * auto-recovery made the *outcome* self-healing; this keeps the *log* quiet
 * about the expected miss that triggered it).
 */
export function discoverGitRoot(inputPath: string): string {
  try {
    return git(inputPath, ['rev-parse', '--show-toplevel'], [], 30000, { silenceStderr: true });
  } catch {
    throw new Error(
      `Not inside a git repository: ${inputPath}. GBrain sync requires a git-initialized repo (or a subdirectory of one).`,
    );
  }
}

/**
 * #2964: snapshot the CURRENT on-disk state of a gbrain-owned brain dir as
 * a baseline commit — used both right after a self-healing `git init` (no
 * `.git` at all) and to recover a repo left with `.git` but zero commits
 * (an interrupted prior self-heal, or a `git init` from some other source
 * that never got a first commit). Respects `.gitignore` (written first) so
 * future incremental syncs diff against what's actually here rather than
 * an empty tree — an empty initial commit would make every existing file
 * look "added" again on the next sync, even though the full-sync pass that
 * follows already imported them from disk directly.
 *
 * `--no-gpg-sign` + explicit `-c user.name/user.email`: this runs from a
 * headless nightly cron/launchd invocation, which has no reason to have
 * git signing/identity configured, and must not block on an unavailable
 * signing agent or pinentry prompt.
 *
 * db_only exclusion is recomputed directly and passed to `git add` as
 * negative pathspecs, rather than relying solely on `manageGitignore`
 * having written `.gitignore` successfully: that helper is deliberately
 * best-effort (a broken gbrain.yml parse, or an unwritable .gitignore,
 * only warns and returns — the right default for its OTHER callers, where
 * .gitignore management is a side effect that must never kill the sync
 * job). For a commit we are about to create ourselves, "fail open" there
 * would mean silently committing db_only content into git history. Fail
 * closed instead: db_only exclusion doesn't depend on the .gitignore
 * write having succeeded. `loadStorageConfig` throwing (unreadable
 * gbrain.yml, or a semantic overlap) propagates — better to leave this
 * self-heal wedged with a clear error than commit unknown content.
 */
function createSyncBaselineCommit(repoPath: string): void {
  // #2964: db_only exclusion is computed directly from loadStorageConfig
  // and passed to `git add` as pathspecs — deliberately NOT via
  // manageGitignore/.gitignore, for two independent reasons:
  //
  // 1. Ordering (Codex review round 6, P1): `collectSyncableFiles` — the
  //    file enumeration `performFullSync` runs right after this function
  //    returns — honors `.gitignore` via `git ls-files --exclude-standard`.
  //    Writing db_only entries into `.gitignore` BEFORE that first import
  //    would silently exclude those pages from the database entirely.
  //    That's the exact bug class `runSync`'s existing "manage .gitignore
  //    ONLY on successful sync" ordering (this file, `manageGitignoreAtGitRoot`
  //    callers below — itself a prior Codex P1 fix) exists to prevent. Leave
  //    `.gitignore` untouched here; the existing post-sync flow writes it
  //    once this sync completes, same as it does for every other sync.
  // 2. Fail-closed (rounds 5-6): `manageGitignore`'s "warn and return" on a
  //    broken gbrain.yml/unwritable .gitignore is the right default for its
  //    OTHER callers (a side effect that must never kill the sync job), but
  //    wrong for a commit we are creating ourselves — silently committing
  //    db_only content into git history.
  const storageConfig = loadStorageConfig(repoPath);
  const dbOnlyDirs = storageConfig?.db_only ?? [];
  // Sniff-test fail-closed (round 6, P2): `loadStorageConfig` warns-and-
  // returns an EMPTY config for syntactically-valid-but-unsupported YAML
  // (e.g. flow-style `db_only: [dir/]` — the narrow custom parser only
  // handles block-style lists), which would silently resolve zero
  // exclusions from a file that clearly intended some. If gbrain.yml
  // exists and mentions db_only (or its deprecated pre-v0.22.11 alias
  // `supabase_only` — same keep-out-of-git semantics, still a supported
  // backward-compat key per storage-config.ts) but nothing resolved from
  // it, refuse rather than guess "genuinely empty" vs "syntax ignored".
  //
  // Known false-positive (round 8 review): a genuinely, intentionally
  // empty `db_only: []` mentioning the word also refuses, and can't be
  // told apart from the unsupported-syntax case — `loadStorageConfig`
  // returns the IDENTICAL `{db_tracked:[],db_only:[]}` for both (verified
  // directly: flow-style `[dir/]` and literal `[]` both collapse to that
  // same shape). Distinguishing them would mean teaching this function
  // about the parser's internal line-recognition rules, which belongs in
  // storage-config.ts, not here. Accepted trade-off: the false-positive
  // cost is low and self-resolving (the brain stays wedged with a clear,
  // actionable error until the user drops the pointless empty stanza or
  // fixes their syntax; retried on every subsequent sync); the
  // false-negative this guards against — silently committing db_only
  // content into permanent git history — is high-cost and hard to undo.
  if (dbOnlyDirs.length === 0) {
    const yamlPath = join(repoPath, 'gbrain.yml');
    const yamlContent = existsSync(yamlPath) ? readFileSync(yamlPath, 'utf-8') : '';
    // A YAML KEY line (`db_only:` / `supabase_only:`, ignoring leading
    // whitespace and `#` comments), not a bare substring search — round 9,
    // P2: a comment or unrelated prose value that happens to mention the
    // word (e.g. `# db_only handling TBD`) must not trip this guard on an
    // otherwise-genuinely-config-free gbrain.yml.
    const mentionsUnresolvedKey = yamlContent.split('\n').some((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('#') && /^(db_only|supabase_only)\s*:/.test(trimmed);
    });
    if (mentionsUnresolvedKey) {
      throw new Error(
        `${yamlPath} mentions db_only but no directories resolved from it — refusing to ` +
          `auto-commit (cannot tell "genuinely empty" from "unsupported syntax silently ignored"). ` +
          `Fix gbrain.yml's storage.db_only syntax, or git-init this directory manually.`,
      );
    }
  }
  // #2964 (round 9, P1): every db_only dir is ALWAYS pathspec-excluded,
  // unconditionally — never pre-filtered against what an existing
  // `.gitignore` claims to already cover. An earlier version checked
  // `git check-ignore -q dir` first and skipped the pathspec when it
  // already reported "ignored" (to dodge the advisory error below), but
  // `check-ignore` on a directory can say "ignored" even when a
  // pre-existing `.gitignore` re-includes a child via negation (e.g.
  // `private-cache/*` + `!private-cache/index.md`) — the filter would
  // then skip excluding it via pathspec, and `git add -A` would stage
  // that re-included child despite the whole directory being declared
  // db_only. Our OWN pathspec exclusion is unconditional and doesn't
  // consult `.gitignore` at all, so it can't be defeated by ANY
  // .gitignore content, negated or not. `:(exclude,literal)dir` (not the
  // `:!dir` shorthand) so a db_only dir name that itself starts with a
  // pathspec magic character like `:` is excluded literally rather than
  // reinterpreted (round 9, P2).
  const excludePathspecs = dbOnlyDirs.map((dir) => `:(exclude,literal)${dir}`);
  // Clear the index before staging (round 6, P1): the unborn-HEAD
  // recovery site can reach this function with a repo whose index
  // already has entries staged from some OTHER prior operation (a manual
  // `git add`, an interrupted workflow) before gbrain ever touched it.
  // `add -A` only adds/updates — it does not drop an already-staged path
  // that our exclusion pathspecs above now want excluded. `read-tree
  // --empty` resets the index without touching the working tree; a
  // no-op on a freshly-`git init`-ed repo, whose index is already empty.
  git(repoPath, ['read-tree', '--empty']);
  try {
    // #2964: 10 minutes, not the shared git() helper's 30s default — this
    // full-tree `git add -A` walks a legacy brain that may hold years of
    // accumulated content. A 30s timeout would abort staging after `git
    // init` already created `.git`, leaving an unborn repo that every
    // subsequent sync would retry (and time out identically) forever;
    // the unborn-HEAD recovery path exists for OTHER causes of that
    // state, not to be this one's normal first outcome.
    git(repoPath, ['add', '-A', '--', '.', ...excludePathspecs], [], 600_000);
  } catch (err) {
    // Now that exclusion is always applied (never pre-filtered), an
    // explicit pathspec exclusion for a path a pre-existing `.gitignore`
    // ALSO happens to cover trips git's advice.addIgnoredFile: nonzero
    // exit + "paths ignored by one of your .gitignore files, use -f",
    // even though the add otherwise fully succeeded (verified directly:
    // `git status --short` right after this exact error shows every
    // non-excluded path staged correctly). Recognize and swallow ONLY
    // this exact advisory; anything else (timeout, permission denied,
    // real corruption) rethrows.
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String((err as { stderr: unknown }).stderr) : '';
    if (!stderr.includes('ignored by one of your .gitignore files')) throw err;
  }
  git(
    repoPath,
    // --no-verify only skips pre-commit/commit-msg — prepare-commit-msg
    // and (worse, since it runs AFTER the commit object already exists,
    // synchronously inside this same git invocation) post-commit are
    // NOT covered by it. An operator's global core.hooksPath or
    // init.templateDir can wire either, expecting project tooling,
    // prompting interactively, or hanging — none of which a headless
    // self-heal commit can satisfy, and a hanging post-commit hook would
    // burn the 600s budget above without even being the slow step.
    // `-c core.hooksPath=/dev/null` (in configs, below) makes git look
    // for hook scripts inside a location that can't contain any,
    // disabling the entire hooks path for this one invocation — the
    // complete form of what --no-verify only partially covers, kept for
    // explicitness on the two hooks it does name.
    [
      'commit', '--quiet', '--allow-empty', '--no-gpg-sign', '--no-verify',
      '-m', 'gbrain: initial commit (auto-init by sync)',
    ],
    ['user.name=gbrain', 'user.email=gbrain@localhost', 'core.hooksPath=/dev/null'],
  );
}

/**
 * True when `childReal` is `rootReal` itself or lives inside it. Both arguments
 * must already be realpath-resolved. Containment is decided by `relative()`
 * rather than a string prefix, so it holds on Windows too: `realpathSync`
 * returns backslash paths there, and a literal `rootReal + '/'` prefix can
 * never match one. A sibling (`root-evil`) is rejected because `relative`
 * yields `../root-evil`, and a cross-drive path because it yields an absolute.
 */
export function isWithinRoot(childReal: string, rootReal: string): boolean {
  if (childReal === rootReal) return true;
  const rel = relative(rootReal, childReal);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/**
 * #774 NAV-1 TOCTOU: true only if filePath realpath-resolves inside gitRoot.
 * Guards symlink escape at the per-file level (a committed symlink whose
 * target lives outside the repo), not just at scope entry.
 */
function isPathSafe(filePath: string, gitRoot: string): boolean {
  try {
    return isWithinRoot(realpathSync(filePath), realpathSync(gitRoot));
  } catch {
    return false;
  }
}

function hasOriginRemote(repoPath: string): boolean {
  try {
    execFileSync('git', buildGitInvocation(repoPath, ['remote', 'get-url', 'origin']), {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function isDetachedHead(repoPath: string): boolean {
  try {
    git(repoPath, ['symbolic-ref', '--quiet', 'HEAD']);
    return false;
  } catch {
    return true;
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

// v0.42.42.0 (#2139): `buildDetachedWorkingTreeManifest` relocated to
// `src/core/sync-delta.ts` (re-imported below) so the inline cost estimator
// prices detached sources through the same code the executor imports them with.

// v0.18.0 Step 5: source-scoped sync state helpers. When opts.sourceId
// is set, read/write the per-source row instead of the global config
// keys. These wrappers centralize the branch so every read/write site
// picks the right storage — future Step 5 work (failure-tracking per
// source) hooks here too.
async function readSyncAnchor(
  engine: BrainEngine,
  sourceId: string | undefined,
  which: 'repo_path' | 'last_commit',
): Promise<string | null> {
  if (sourceId) {
    const col = which === 'repo_path' ? 'local_path' : 'last_commit';
    const rows = await engine.executeRaw<Record<string, string | null>>(
      `SELECT ${col} AS value FROM sources WHERE id = $1`,
      [sourceId],
    );
    return rows[0]?.value ?? null;
  }
  return await engine.getConfig(`sync.${which}`);
}

/**
 * #2964: is `repoPath` gbrain's own default-brain anchor, as opposed to a
 * path some caller merely happened to pass through unchanged?
 *
 * `!opts.sourceId` alone is NOT sufficient — and neither is rejecting
 * `opts.sourceId` outright: migration `sources_table_additive` (v20)
 * seeds a `'default'` source row whose `local_path` is copied FROM
 * `config.sync.repo_path` on every brain that has ever run it (i.e.
 * effectively all of them by now), and `writeSyncAnchor` keeps that row's
 * `local_path` current on every sync thereafter. So on a real installed
 * brain, `resolveSourceForDir` (dream cycle) and the CLI's bare `gbrain
 * sync` both resolve `sourceId: 'default'`, NOT `undefined` — rejecting
 * all non-empty `sourceId` (an earlier, insufficiently-reviewed version
 * of this check) made self-heal never fire on that real path either,
 * masked in tests only because a freshly-`initSchema()`'d test brain's
 * `'default'` row has a null `local_path` (Codex review round 5).
 *
 * The actual boundary: `'default'` is gbrain's own bootstrap identity,
 * not something a caller names — a DIFFERENT, non-default `sourceId` is
 * what an explicit `sources add <id> --path <dir>` registration (a
 * user's own external directory) looks like, and that's what must keep
 * failing loudly. So: permit `sourceId` when it's exactly `undefined` or
 * `'default'`, reject any other id, and for BOTH permitted cases prove
 * ownership by VALUE — reread the live anchor for that same identity
 * (`sources.default.local_path` when sourceId='default', else
 * `config.sync.repo_path`) and require the resolved `repoPath` to
 * REALPATH-equal it (not raw string equality: `dream`'s `resolveBrainDir`
 * normalizes via `path.resolve`, so a trailing slash or `..` in the
 * stored anchor must not defeat the match — Codex review round 5, P2).
 * An arbitrary caller-supplied path (e.g. an admin-scope
 * `submit_job({name:'sync', data:{repoPath}})`) only passes this check
 * if it already equals gbrain's own anchor by realpath identity — at
 * which point self-healing it is exactly the legitimate case, not an
 * escalation.
 *
 * `opts.srcSubpath` disqualifies unconditionally: a subpath-scoped sync
 * only wants THAT subdirectory captured, but the self-heal baseline
 * commit runs `git add -A` at the git root (there's no file list yet to
 * scope it to — collection happens after this point) — see the P2 review
 * finding on `createSyncBaselineCommit`'s callers.
 */
async function isAnchorOwnedSyncPath(
  engine: BrainEngine,
  opts: SyncOpts,
  repoPath: string,
): Promise<boolean> {
  if (opts.srcSubpath) return false;
  if (opts.sourceId && opts.sourceId !== 'default') return false;
  const anchor = await readSyncAnchor(engine, opts.sourceId, 'repo_path');
  if (anchor === null) return false;
  try {
    return realpathSync(anchor) === realpathSync(repoPath);
  } catch {
    // Anchor or repoPath doesn't realpath-resolve (dangling/nonexistent) —
    // can't prove identity, so don't self-heal.
    return false;
  }
}

async function writeSyncAnchor(
  engine: BrainEngine,
  sourceId: string | undefined,
  which: 'repo_path' | 'last_commit',
  value: string,
  // v0.41.32.0 (supersedes #1623): on `last_commit` advances, also stamp the
  // durable newest-COMMIT timestamp (HEAD committer time, epoch ms) in the SAME
  // atomic UPDATE as last_sync_at — no separate write to leave partial state,
  // no clock-domain split (last_sync_at = DB now(); newest_content_at = the
  // git-intrinsic committer time of the HEAD we just synced). `undefined` keeps
  // the legacy 2-column write; `null` clears the column (git unavailable).
  newestContentEpochMs?: number | null,
  successfulStrategy?: SyncPlanStrategy,
): Promise<void> {
  if (sourceId) {
    const col = which === 'repo_path' ? 'local_path' : 'last_commit';
    const updateSource = async (
      sql: string,
      params: unknown[],
    ): Promise<void> => {
      const rows = await engine.executeRaw<{ id: string }>(
        `${sql}\nRETURNING id`,
        params,
      );
      if (rows.length !== 1 || rows[0]?.id !== sourceId) {
        throw new SyncPreconditionError(
          'source_changed',
          `Source "${sourceId}" disappeared before its ${which} anchor could be updated.`,
          rows.length === 0 ? null : rows.map((row) => row.id).join(','),
          sourceId,
        );
      }
    };
    // last_sync_at bookmarked on every last_commit advance.
    if (which === 'last_commit') {
      if (newestContentEpochMs !== undefined) {
        const iso = newestContentEpochMs === null
          ? null
          : new Date(newestContentEpochMs).toISOString();
        if (successfulStrategy) {
          await updateSource(
            `UPDATE sources
                SET last_commit = $1,
                    last_sync_at = now(),
                    newest_content_at = $3,
                    config = jsonb_set(
                      CASE WHEN jsonb_typeof(config) = 'object'
                        THEN config ELSE '{}'::jsonb END,
                      '{last_successful_strategy}',
                      to_jsonb($4::text),
                      true
                    )
              WHERE id = $2`,
            [value, sourceId, iso, successfulStrategy],
          );
        } else {
          await updateSource(
            `UPDATE sources SET last_commit = $1, last_sync_at = now(), newest_content_at = $3 WHERE id = $2`,
            [value, sourceId, iso],
          );
        }
      } else {
        if (successfulStrategy) {
          await updateSource(
            `UPDATE sources
                SET last_commit = $1,
                    last_sync_at = now(),
                    config = jsonb_set(
                      CASE WHEN jsonb_typeof(config) = 'object'
                        THEN config ELSE '{}'::jsonb END,
                      '{last_successful_strategy}',
                      to_jsonb($3::text),
                      true
                    )
              WHERE id = $2`,
            [value, sourceId, successfulStrategy],
          );
        } else {
          await updateSource(
            `UPDATE sources SET last_commit = $1, last_sync_at = now() WHERE id = $2`,
            [value, sourceId],
          );
        }
      }
    } else {
      await updateSource(
        `UPDATE sources SET ${col} = $1 WHERE id = $2`,
        [value, sourceId],
      );
    }
    return;
  }
  // Legacy no-sourceId path (pre-v0.18 global config). Modern sync always
  // resolves a sourceId (incl. 'default'), so newest_content_at is written via
  // the sourceId branch above; the default source is not stuck on NULL.
  await engine.setConfig(`sync.${which}`, value);
}

/**
 * v0.20.0 Cathedral II Layer 12 (SP-1 fix) — read/write the chunker version
 * last used to sync a given source. When it mismatches CURRENT_CHUNKER_VERSION,
 * `performSync` forces a full walk regardless of git HEAD equality. Without
 * this gate, bumping CHUNKER_VERSION does NOTHING on an unchanged repo
 * because sync short-circuits at `up_to_date` before reaching
 * `importCodeFile`'s content_hash check.
 *
 * Per-source storage matches writeSyncAnchor's shape — sources.chunker_version
 * TEXT column from the v27 migration. No global fallback: non-source syncs
 * (pre-v0.17 brains with no sources table) never had CHUNKER_VERSION
 * version-gating, so they keep the v0.19.0 behavior.
 */
async function readChunkerVersion(
  engine: BrainEngine,
  sourceId: string | undefined,
): Promise<string | null> {
  if (!sourceId) return null;
  const rows = await engine.executeRaw<{ chunker_version: string | null }>(
    `SELECT chunker_version FROM sources WHERE id = $1`,
    [sourceId],
  );
  return rows[0]?.chunker_version ?? null;
}

async function readLastSuccessfulStrategy(
  engine: BrainEngine,
  sourceId: string | undefined,
): Promise<SyncPlanStrategy | null> {
  if (!sourceId) return null;
  const rows = await engine.executeRaw<{ config: unknown }>(
    `SELECT config FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (rows.length !== 1) return null;
  const value = parseSourceConfig(rows[0].config).last_successful_strategy;
  return value === 'markdown' || value === 'code' || value === 'auto'
    ? value
    : null;
}

async function writeChunkerVersion(
  engine: BrainEngine,
  sourceId: string | undefined,
  version: string,
): Promise<void> {
  if (!sourceId) return;
  await engine.executeRaw(
    `UPDATE sources SET chunker_version = $1 WHERE id = $2`,
    [version, sourceId],
  );
}

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

/**
 * v0.42.x (#1794, Part B): typed lock-busy error so callers can distinguish a
 * benign "another sync holds the lock, skip cleanly" from a real failure.
 * Subclasses Error so existing CLI handlers that print `err.message` keep the
 * rich `formatLockBusyMessage` text verbatim. The Minion `sync` handler catches
 * this to mark the job skipped (not failed) — single-flight backpressure: the
 * cron/autopilot sync defers to the holder instead of erroring + retrying noisily.
 */
export class SyncLockBusyError extends Error {
  readonly lockKey: string;
  readonly reasonCode = 'lock_busy' as const;
  constructor(message: string, lockKey: string) {
    super(message);
    this.name = 'SyncLockBusyError';
    this.lockKey = lockKey;
  }
}

export type SyncRefusalReason =
  | 'source_changed'
  | 'target_changed'
  | 'bookmark_changed'
  | 'plan_changed'
  | 'working_tree_dirty'
  | 'managed_clone_missing'
  | 'plan_failed'
  | 'dry_run_modifier_conflict'
  | 'lock_release_failed'
  | 'lock_busy'
  | 'embedding_credentials_missing'
  | 'cost_gate_stopped';

export class SyncPreconditionError extends Error {
  readonly reasonCode: SyncRefusalReason;
  readonly observed: string | null;
  readonly required: string | null;

  constructor(
    reasonCode: SyncRefusalReason,
    problem: string,
    observed: string | null,
    required: string | null,
  ) {
    super(problem);
    this.name = 'SyncPreconditionError';
    this.reasonCode = reasonCode;
    this.observed = observed;
    this.required = required;
  }
}

export interface GBrainSyncEnvelope {
  schema_version: 1;
  result_kind: 'gbrain_sync';
  status: SyncResult['status'];
  preview_kind?: 'validated_index_plan';
  source: { id: string };
  repository: {
    from_commit: string | null;
    target_commit: string;
    bookmark_after: string | null;
    last_successful_strategy: SyncPlanStrategy | null;
  };
  strategy: SyncPlanStrategy;
  strategy_changed: boolean;
  checkpoint_reset: boolean;
  operations: {
    added: number;
    modified: number;
    deleted: number;
    renamed: number;
    preserved: number;
  };
  affected: SyncAffectedSummary;
  affected_digest: string;
  plan_digest: string;
  corpus: {
    markdown_planned_or_applied: number;
    code_pages_before: number;
    code_pages_after: number;
    code_deletions_applied: number;
    image_operations_applied: number;
    image_pages_after: number;
    multimodal_enabled: false;
    embedding_status: 'deferred' | 'complete';
    extraction_status: 'deferred' | 'complete';
    search_ready: boolean;
  };
  cost_gate?: CostGateReceipt;
  reason?: SyncResult['reason'];
}

export interface GBrainSyncErrorEnvelope {
  schema_version: 1;
  result_kind: 'gbrain_sync_error';
  status: 'refused' | 'error';
  reason_code: string;
  state_changed: 'none' | 'lock_only' | 'partial';
  problem: string;
  observed: string | null;
  required: string | null;
  next_action: string;
}

function emptyAffectedEvidence(): Pick<
  SyncPlan,
  'affected' | 'affectedDigest'
> {
  const empty = createSyncPlan({
    mode: 'incremental',
    sourceId: DEFAULT_SOURCE_ID,
    repoPath: '',
    fromCommit: null,
    targetCommit: '',
    strategy: 'markdown',
    operations: [],
  });
  return {
    affected: empty.affected,
    affectedDigest: empty.affectedDigest,
  };
}

export function buildGBrainSyncEnvelope(
  result: SyncResult,
  opts: Pick<
    SyncOpts,
    'sourceId' | 'strategy' | 'noEmbed' | 'noExtract' | 'costGateReceipt'
  >,
): GBrainSyncEnvelope {
  const strategy = result.strategy ?? opts.strategy ?? 'markdown';
  const completed =
    result.status === 'synced' ||
    result.status === 'first_sync' ||
    result.status === 'up_to_date';
  const empty = emptyAffectedEvidence();
  const multimodalEnabled =
    process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true';
  const corpus = result.planCorpus;
  const planDigest = result.planDigest;
  const dryRun = result.status === 'dry_run';
  if (
    !corpus ||
    typeof planDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(planDigest) ||
    (!dryRun && !completed)
  ) {
    throw new SyncPreconditionError(
      'plan_failed',
      'A schema-1 sync receipt requires complete immutable plan and corpus evidence.',
      planDigest ?? result.status,
      'dry_run, up_to_date, synced, or first_sync with a bound lowercase SHA-256 plan digest',
    );
  }
  if (multimodalEnabled) {
    throw new SyncPreconditionError(
      'plan_failed',
      'Schema-1 safe-sync receipts require multimodal indexing to be disabled.',
      'GBRAIN_EMBEDDING_MULTIMODAL=true',
      'GBRAIN_EMBEDDING_MULTIMODAL=false',
    );
  }
  return {
    schema_version: 1,
    result_kind: 'gbrain_sync',
    status: result.status,
    ...(result.previewKind ? { preview_kind: result.previewKind } : {}),
    source: { id: result.sourceId ?? opts.sourceId ?? DEFAULT_SOURCE_ID },
    repository: {
      from_commit: result.fromCommit,
      target_commit: result.toCommit,
      bookmark_after: completed ? result.toCommit : result.fromCommit,
      last_successful_strategy:
        result.lastSuccessfulStrategy ??
        (completed ? strategy : null),
    },
    strategy,
    strategy_changed: result.strategyChanged === true,
    checkpoint_reset: result.checkpointReset === true,
    operations: {
      added: result.added,
      modified: result.modified,
      deleted: result.deleted,
      renamed: result.renamed,
      preserved: result.preserved ?? 0,
    },
    affected: result.affected ?? empty.affected,
    affected_digest: result.affectedDigest ?? empty.affectedDigest,
    plan_digest: planDigest,
    corpus: {
      markdown_planned_or_applied:
        corpus.markdownOperations,
      code_pages_before: corpus.codePagesBefore,
      code_pages_after: corpus.codePagesAfter,
      code_deletions_applied: dryRun
        ? 0
        : corpus.codeDeletions,
      image_operations_applied: dryRun
        ? 0
        : corpus.imageOperations,
      image_pages_after: corpus.imagePagesAfter,
      multimodal_enabled: false,
      embedding_status: 'deferred',
      extraction_status: 'deferred',
      search_ready: false,
    },
    ...(opts.costGateReceipt
      ? { cost_gate: opts.costGateReceipt }
      : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

export function buildGBrainSyncErrorEnvelope(
  error: unknown,
  stateChanged?: GBrainSyncErrorEnvelope['state_changed'],
): GBrainSyncErrorEnvelope {
  const releaseFailure =
    error instanceof LockReleaseFailedError
      ? error
      : getLockReleaseFailure(error);
  const effectiveState =
    stateChanged ?? (releaseFailure ? 'lock_only' : 'none');
  if (releaseFailure) {
    const originalProblem =
      releaseFailure === error
        ? ''
        : ` Original work failure: ${
            error instanceof Error ? error.message : String(error)
          }`;
    return {
      schema_version: 1,
      result_kind: 'gbrain_sync_error',
      status: 'error',
      reason_code: releaseFailure.reasonCode,
      state_changed: effectiveState,
      problem: releaseFailure.message + originalProblem,
      observed: releaseFailure.lockId,
      required: 'the transient sync lock to be released',
      next_action: 'Inspect and safely clear the stale source lock before retrying.',
    };
  }
  if (error instanceof SyncLockBusyError) {
    return {
      schema_version: 1,
      result_kind: 'gbrain_sync_error',
      status: 'refused',
      reason_code: error.reasonCode,
      state_changed: effectiveState,
      problem: error.message,
      observed: error.lockKey,
      required: 'an available per-source sync lock',
      next_action: 'Wait for the current source operation to finish, then retry.',
    };
  }
  if (error instanceof SyncPreconditionError) {
    return {
      schema_version: 1,
      result_kind: 'gbrain_sync_error',
      status: 'refused',
      reason_code: error.reasonCode,
      state_changed: effectiveState,
      problem: error.message,
      observed: error.observed,
      required: error.required,
      next_action: 'Refresh source, bookmark, and Git evidence, then retry.',
    };
  }
  return {
    schema_version: 1,
    result_kind: 'gbrain_sync_error',
    status: 'error',
    reason_code: 'plan_failed',
    state_changed: effectiveState,
    problem: error instanceof Error ? error.message : String(error),
    observed: null,
    required: 'a complete read-only plan or successful sync',
    next_action: 'Inspect the source and retry; use repository files and rg meanwhile.',
  };
}

async function withConsoleLogOnStderr<T>(work: () => Promise<T>): Promise<T> {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    console.error(...args);
  };
  try {
    return await work();
  } finally {
    console.log = originalLog;
  }
}

interface ReadOnlySyncPreflight {
  repoPath: string;
  gitContextRoot: string;
  syncScopeRoot: string;
  syncScopeRelPath: string;
  anchorPath: string;
  slugRoot: string | undefined;
  headCommit: string;
  bookmark: string | null;
  detachedHead: boolean;
}

interface TargetTreeBlob {
  mode: '100644' | '100755';
  oid: string;
  path: string;
}

interface TargetTreeMaterialization {
  root: string;
  deregisterCleanup: () => void;
}

function listTargetTreeBlobs(
  preflight: ReadOnlySyncPreflight,
  targetCommit: string,
  strategy: SyncPlanStrategy,
): TargetTreeBlob[] {
  const raw = execFileSync(
    'git',
    ['ls-tree', '-rz', '--full-tree', targetCommit],
    {
      cwd: preflight.gitContextRoot,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const scope = preflight.syncScopeRelPath.replace(/\\/g, '/');
  const inScope = (path: string): boolean =>
    scope === '' || path.startsWith(scope + '/');
  const result: TargetTreeBlob[] = [];
  for (const record of raw.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    if (tab < 0) {
      throw new SyncPreconditionError(
        'plan_failed',
        'Git returned a malformed target-tree entry.',
        record.slice(0, 120),
        'mode type object<TAB>path',
      );
    }
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (
      path.includes('\\') ||
      isAbsolute(path) ||
      path.split('/').includes('..') ||
      /[\u0000-\u001f\u007f\ufffd]/u.test(path)
    ) {
      throw new SyncPreconditionError(
        'plan_failed',
        'The exact target tree contains a path that cannot be materialized safely.',
        path,
        'a canonical UTF-8 repository-relative path',
      );
    }
    if (!inScope(path) || !isSyncable(path, { strategy })) continue;
    if (
      type !== 'blob' ||
      (mode !== '100644' && mode !== '100755') ||
      !/^[0-9a-f]{40,64}$/i.test(oid ?? '')
    ) {
      throw new SyncPreconditionError(
        'plan_failed',
        'A syncable target path is not a regular Git blob.',
        `${mode ?? '<missing>'} ${type ?? '<missing>'} ${path}`,
        'a regular 100644 or 100755 blob',
      );
    }
    result.push({
      mode,
      oid,
      path,
    });
  }
  return result;
}

async function materializeTargetTree(
  preflight: ReadOnlySyncPreflight,
  targetCommit: string,
  strategy: SyncPlanStrategy,
): Promise<TargetTreeMaterialization> {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-target-tree-'));
  chmodSync(root, 0o700);
  let child: ReturnType<typeof spawn> | undefined;
  let childCompletion: Promise<void> | undefined;
  let cleanupRequested = false;
  const removeTree = (): void => {
    rmSync(root, { recursive: true, force: true });
  };
  const cleanupMaterialization = async (): Promise<void> => {
    cleanupRequested = true;
    // The process-level cleanup registry has a bounded deadline. Remove the
    // private snapshot synchronously before waiting for the git child so a
    // stuck child cannot leave source bytes behind on signal-driven exit.
    removeTree();
    if (
      child &&
      child.exitCode === null &&
      child.signalCode === null
    ) {
      child.kill('SIGTERM');
    }
    try {
      if (childCompletion) {
        await childCompletion.catch(() => {});
      }
    } finally {
      // A streaming callback that was already on the stack when cleanup began
      // cannot recreate the directory, but repeat the removal defensively.
      removeTree();
    }
  };
  // Register immediately after mkdtemp, before streaming any blobs. Signal
  // cleanup can otherwise bypass both this function's catch and the caller's
  // finally, leaking a potentially large private source snapshot in tmp.
  const deregisterCleanup = registerCleanup(
    `sync-target-tree:${preflight.headCommit.slice(0, 12)}`,
    cleanupMaterialization,
  );
  try {
    const scopeRoot = resolve(root, preflight.syncScopeRelPath);
    if (!isWithinRoot(scopeRoot, root)) {
      throw new SyncPreconditionError(
        'plan_failed',
        'The sync scope cannot be represented inside the exact target tree.',
        preflight.syncScopeRelPath,
        'a canonical repository-relative scope',
      );
    }
    mkdirSync(scopeRoot, { recursive: true, mode: 0o700 });
    const entries = listTargetTreeBlobs(
      preflight,
      targetCommit,
      strategy,
    );
    if (entries.length === 0) return { root, deregisterCleanup };

    const spawnedChild = spawn('git', ['cat-file', '--batch'], {
      cwd: preflight.gitContextRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = spawnedChild;
    let stderr = '';
    spawnedChild.stderr.setEncoding('utf8');
    spawnedChild.stderr.on('data', (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    const spawnedChildCompletion = new Promise<void>((resolveCompletion, rejectCompletion) => {
      spawnedChild.once('error', rejectCompletion);
      spawnedChild.once('close', (code, signal) => {
        if (code === 0) {
          resolveCompletion();
        } else {
          rejectCompletion(
            new Error(
              `git cat-file exited with ${code ?? signal ?? 'unknown'}: ` +
                stderr.trim(),
            ),
          );
        }
      });
    });
    childCompletion = spawnedChildCompletion;
    spawnedChild.stdin.end(entries.map((entry) => entry.oid).join('\n') + '\n');

    let buffer = Buffer.alloc(0);
    let entryIndex = 0;
    let expectedSize: number | null = null;
    for await (const chunk of spawnedChild.stdout) {
      if (cleanupRequested) {
        throw new Error('Exact target materialization was interrupted.');
      }
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      while (true) {
        if (cleanupRequested) {
          throw new Error('Exact target materialization was interrupted.');
        }
        if (expectedSize === null) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) break;
          const header = buffer.subarray(0, newline).toString('ascii');
          buffer = buffer.subarray(newline + 1);
          const match = /^([0-9a-f]{40,64}) blob ([0-9]+)$/i.exec(header);
          const entry = entries[entryIndex];
          if (!match || !entry || match[1] !== entry.oid) {
            throw new Error(
              `Unexpected git cat-file response at target entry ${entryIndex}: ${header}`,
            );
          }
          expectedSize = Number(match[2]);
          if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
            throw new Error(`Invalid target blob size: ${match[2]}`);
          }
        }
        if (buffer.length < expectedSize + 1) break;
        if (buffer[expectedSize] !== 0x0a) {
          throw new Error('Git target blob was not newline-delimited.');
        }
        const entry = entries[entryIndex];
        const destination = resolve(root, entry.path);
        if (!isWithinRoot(destination, root)) {
          throw new Error(`Target path escaped materialization root: ${entry.path}`);
        }
        mkdirSync(resolve(destination, '..'), {
          recursive: true,
          mode: 0o700,
        });
        writeFileSync(destination, buffer.subarray(0, expectedSize), {
          mode: 0o600,
        });
        buffer = buffer.subarray(expectedSize + 1);
        expectedSize = null;
        entryIndex++;
      }
    }
    await spawnedChildCompletion;
    if (
      entryIndex !== entries.length ||
      expectedSize !== null ||
      buffer.length !== 0
    ) {
      throw new Error(
        `Incomplete target materialization: ${entryIndex}/${entries.length} blobs`,
      );
    }
    return { root, deregisterCleanup };
  } catch (error) {
    deregisterCleanup();
    await cleanupMaterialization();
    if (error instanceof SyncPreconditionError) throw error;
    throw new SyncPreconditionError(
      'plan_failed',
      `Could not materialize exact target commit: ${
        error instanceof Error ? error.message : String(error)
      }`,
      targetCommit,
      'a readable immutable Git target tree',
    );
  }
}

function canonicalPathForComparison(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function assertRegisteredSourcePath(
  engine: BrainEngine,
  opts: SyncOpts,
  repoPath: string,
): Promise<void> {
  if (!opts.sourceId || !opts.repoPath) return;
  const paired =
    opts.expectedTarget !== undefined ||
    opts.expectedBookmark !== undefined ||
    opts.expectedPlanDigest !== undefined ||
    opts.requireClean === true;
  // Legacy default-source calls can still use the pre-v0.17 config anchor.
  // Once a caller asks for paired exact-state evidence, however, even the
  // default source must prove that --repo is its registered local_path.
  if (opts.sourceId === DEFAULT_SOURCE_ID && !paired) return;
  const rows = await engine.executeRaw<{ local_path: string | null }>(
    `SELECT local_path FROM sources WHERE id = $1`,
    [opts.sourceId],
  );
  if (rows.length !== 1) {
    throw new SyncPreconditionError(
      'source_changed',
      `Source "${opts.sourceId}" no longer has one registered local path.`,
      null,
      repoPath,
    );
  }
  const registeredPath = rows[0]!.local_path;
  if (!registeredPath) {
    // A named source created without --path is bound by its first ordinary
    // programmatic sync. Exact-state callers must still prove a pre-existing
    // source/path association before planning or applying.
    if (!paired) return;
    throw new SyncPreconditionError(
      'source_changed',
      `Source "${opts.sourceId}" no longer has one registered local path.`,
      null,
      repoPath,
    );
  }
  const observed = canonicalPathForComparison(registeredPath);
  const required = canonicalPathForComparison(repoPath);
  if (observed !== required) {
    throw new SyncPreconditionError(
      'source_changed',
      `Source "${opts.sourceId}" changed paths before sync could plan or apply.`,
      observed,
      required,
    );
  }
}

async function readOnlySyncPreflight(
  engine: BrainEngine,
  opts: SyncOpts,
  resolvedRepoPath?: string,
): Promise<ReadOnlySyncPreflight> {
  const repoPath =
    resolvedRepoPath ??
    opts.repoPath ??
    (await readSyncAnchor(engine, opts.sourceId, 'repo_path'));
  if (!repoPath) {
    throw new SyncPreconditionError(
      'managed_clone_missing',
      'The source has no readable repository path; planning cannot re-clone or initialize it.',
      null,
      opts.repoPath ?? null,
    );
  }

  await assertRegisteredSourcePath(engine, opts, repoPath);
  if (!existsSync(repoPath)) {
    throw new SyncPreconditionError(
      'managed_clone_missing',
      `Repository path does not exist: ${repoPath}.`,
      null,
      canonicalPathForComparison(repoPath),
    );
  }

  let gitContextRoot: string;
  try {
    gitContextRoot = realpathSync(discoverGitRoot(repoPath));
  } catch (error) {
    throw new SyncPreconditionError(
      'plan_failed',
      error instanceof Error ? error.message : String(error),
      null,
      'an existing Git repository',
    );
  }

  const rawScopeRoot = opts.srcSubpath ? join(repoPath, opts.srcSubpath) : repoPath;
  if (!existsSync(rawScopeRoot)) {
    throw new SyncPreconditionError(
      'plan_failed',
      `Sync scope does not exist: ${rawScopeRoot}`,
      null,
      'an existing path inside the repository',
    );
  }
  const syncScopeRoot = realpathSync(rawScopeRoot);
  if (!isWithinRoot(syncScopeRoot, gitContextRoot)) {
    throw new SyncPreconditionError(
      'plan_failed',
      `Sync scope ${syncScopeRoot} resolves outside Git repository ${gitContextRoot}.`,
      syncScopeRoot,
      gitContextRoot,
    );
  }
  const syncScopeRelPath =
    syncScopeRoot === gitContextRoot ? '' : relative(gitContextRoot, syncScopeRoot);
  const headCommit = git(gitContextRoot, ['rev-parse', 'HEAD']);
  const bookmark = await readSyncAnchor(engine, opts.sourceId, 'last_commit');

  if (opts.expectedTarget !== undefined && headCommit !== opts.expectedTarget) {
    throw new SyncPreconditionError(
      'target_changed',
      'Git HEAD changed after the caller captured the expected target.',
      headCommit,
      opts.expectedTarget,
    );
  }
  if (opts.expectedBookmark !== undefined && bookmark !== opts.expectedBookmark) {
    throw new SyncPreconditionError(
      'bookmark_changed',
      'The source bookmark changed after the caller captured it.',
      bookmark,
      opts.expectedBookmark,
    );
  }
  if (opts.requireClean) {
    const porcelain = git(gitContextRoot, [
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
    ]);
    if (porcelain.length > 0) {
      throw new SyncPreconditionError(
        'working_tree_dirty',
        'The paired preview/apply requires a clean working tree.',
        porcelain.split('\n')[0] ?? 'dirty',
        'clean',
      );
    }
  }

  return {
    repoPath,
    gitContextRoot,
    syncScopeRoot,
    syncScopeRelPath,
    anchorPath: opts.srcSubpath ? rawScopeRoot : repoPath,
    slugRoot: syncScopeRoot === gitContextRoot ? undefined : gitContextRoot,
    headCommit,
    bookmark,
    detachedHead: isDetachedHead(gitContextRoot),
  };
}

function pairedFinalRepositoryFailure(
  opts: SyncOpts,
  gitContextRoot: string,
  targetCommit: string,
): { path: '<head>'; error: string } | null {
  if (!opts.targetTreeRoot) return null;
  try {
    const currentHead = git(gitContextRoot, ['rev-parse', 'HEAD']);
    if (currentHead !== targetCommit) {
      return {
        path: '<head>',
        error:
          `git HEAD changed during exact-target sync: planned ` +
          `${targetCommit.slice(0, 8)}, observed ${currentHead.slice(0, 8)}`,
      };
    }
    if (opts.requireClean) {
      const porcelain = git(gitContextRoot, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
      ]);
      if (porcelain.length > 0) {
        return {
          path: '<head>',
          error:
            `working tree changed during exact-target sync: ` +
            `${porcelain.split('\n')[0] ?? 'dirty'}`,
        };
      }
    }
    return null;
  } catch (error) {
    return {
      path: '<head>',
      error:
        `git exact-target verification failed: ` +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

async function resolvePlanSlugs(
  engine: BrainEngine,
  paths: string[],
  sourceId: string | undefined,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (sourceId) {
    for (let i = 0; i < paths.length; i += DELETE_BATCH_SIZE) {
      const batch = paths.slice(i, i + DELETE_BATCH_SIZE);
      const resolved = await engine.resolveSlugsByPaths(batch, { sourceId });
      for (const path of batch) {
        result.set(path, resolved.get(path) ?? resolveSlugForPath(path));
      }
    }
    return result;
  }
  for (const path of paths) {
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_path = $1 LIMIT 1`,
      [path],
    );
    result.set(path, rows[0]?.slug ?? resolveSlugForPath(path));
  }
  return result;
}

interface PlannedExistingPage {
  slug: string;
  source_path: string | null;
  content_hash: string | null;
  type: string;
  frontmatter?: unknown;
}

function existingPageSourcePath(
  row: PlannedExistingPage,
): string | null {
  if (row.source_path !== null) {
    return row.source_path.replace(/\\/g, '/');
  }
  if (row.type !== 'code') return null;
  let frontmatter = row.frontmatter;
  if (typeof frontmatter === 'string') {
    try {
      frontmatter = JSON.parse(frontmatter);
    } catch {
      return null;
    }
  }
  const file =
    typeof frontmatter === 'object' &&
    frontmatter !== null &&
    typeof (frontmatter as { file?: unknown }).file === 'string'
      ? (frontmatter as { file: string }).file
      : null;
  return file?.replace(/\\/g, '/') ?? null;
}

function existingPageOwnsSourcePath(
  row: PlannedExistingPage | undefined,
  sourcePath: string,
): row is PlannedExistingPage {
  if (!row) return false;
  return (
    existingPageSourcePath(row) === sourcePath.replace(/\\/g, '/')
  );
}

type SyncActivePack = {
  identity: string;
  page_types: ReadonlyArray<{
    name: string;
    path_prefixes: ReadonlyArray<string>;
  }>;
};

async function loadSyncActivePackReadOnly(
  opts: SyncOpts,
): Promise<SyncActivePack | undefined> {
  if (opts.noSchemaPack) return undefined;
  try {
    const { loadActivePack } = await import(
      '../core/schema-pack/load-active.ts'
    );
    const resolved = await loadActivePack({
      cfg: loadConfig(),
      remote: false,
      sourceId: opts.sourceId,
    });
    return {
      identity: resolved.identity,
      page_types: resolved.manifest.page_types,
    };
  } catch {
    return undefined;
  }
}

function plannedFileIdentity(
  absolutePath: string,
  sourcePath: string,
  existing: PlannedExistingPage | undefined,
  activePack: SyncActivePack | undefined,
): { slug: string; contentHash: string | null } {
  if (isCodeFilePath(sourcePath)) {
    const content = readFileSync(absolutePath, 'utf8');
    return {
      slug: resolveSlugForPath(sourcePath),
      contentHash: computeCodeImportHash(sourcePath, content),
    };
  }

  if (/\.(?:md|mdx)$/i.test(sourcePath)) {
    let content = readFileSync(absolutePath, 'utf8');
    const inferred = applyInference(sourcePath, content);
    if (!inferred.inferred.skipped) content = inferred.content;

    const preliminary = parseMarkdown(content, sourcePath, { activePack });
    const expectedSlug = resolveSlugForPath(sourcePath);
    let slug = expectedSlug;
    if (
      expectedSlug === '' &&
      existing !== undefined &&
      preliminary.slug !== existing.slug
    ) {
      throw new SyncPreconditionError(
        'plan_failed',
        'A fallback frontmatter slug cannot change in place for a path whose filename has no stable slug.',
        preliminary.slug || '<missing>',
        existing.slug,
      );
    }
    if (expectedSlug === '' && preliminary.slug) {
      slug = preliminary.slug;
    } else if (preliminary.slug !== expectedSlug) {
      // importFromFile will reject this path/slug mismatch. Keep it visible
      // as a planned mutation without claiming an unverifiable content hash.
      return {
        slug: existing?.slug ?? expectedSlug,
        contentHash: null,
      };
    }

    const parsed = parseMarkdown(content, slug + '.md', { activePack });
    if (parsed.typeExplicit !== true && existing?.type) {
      parsed.type = existing.type as PageType;
    }
    return {
      slug,
      contentHash: computeParsedMarkdownContentHash(parsed),
    };
  }

  return {
    slug: sourcePath.replace(/[\\/]/g, '/').toLowerCase(),
    contentHash: createHash('sha256')
      .update(readFileSync(absolutePath))
      .digest('hex'),
  };
}

async function createEngineBoundSyncPlan(
  engine: BrainEngine,
  input: Parameters<typeof createSyncPlan>[0],
): Promise<SyncPlan> {
  const rows = await engine.executeRaw<{
    type: string;
    source_path: string | null;
    source_kind: string | null;
  }>(
    `SELECT type, source_path, source_kind
       FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL`,
    [input.sourceId],
  );
  const mutations = input.operations.filter(
    (operation) => operation.kind !== 'preserve',
  );
  const markdownOperations = mutations.filter((operation) =>
    /\.(?:md|mdx)$/i.test(operation.path),
  ).length;
  const codeOperations = mutations.filter((operation) =>
    isCodeFilePath(operation.path),
  );
  const imageOperations = mutations.filter(
    (operation) =>
      isImageFilePath(operation.path) ||
      (
        operation.kind === 'rename' &&
        operation.fromPath !== undefined &&
        isImageFilePath(operation.fromPath)
      ),
  );
  const codePagesBefore = rows.filter(
    (row) =>
      row.type === 'code' ||
      (row.source_path !== null && isCodeFilePath(row.source_path)),
  ).length;
  const imagePagesBefore = rows.filter(
    (row) =>
      row.source_kind === 'image' ||
      (row.source_path !== null && isImageFilePath(row.source_path)),
  ).length;
  const codeAdds = codeOperations.filter(
    (operation) => operation.kind === 'add',
  ).length + mutations.filter(
    (operation) =>
      operation.kind === 'rename' &&
      operation.fromPath !== undefined &&
      !isCodeFilePath(operation.fromPath) &&
      isCodeFilePath(operation.path),
  ).length;
  const codeDeletions = mutations.filter(
    (operation) =>
      (
        operation.kind === 'delete' &&
        isCodeFilePath(operation.path)
      ) ||
      (
        operation.kind === 'rename' &&
        operation.fromPath !== undefined &&
        isCodeFilePath(operation.fromPath) &&
        !isCodeFilePath(operation.path)
      ),
  ).length;
  const imageAdds = mutations.filter(
    (operation) =>
      (
        operation.kind === 'add' &&
        isImageFilePath(operation.path)
      ) ||
      (
        operation.kind === 'rename' &&
        operation.fromPath !== undefined &&
        !isImageFilePath(operation.fromPath) &&
        isImageFilePath(operation.path)
      ),
  ).length;
  const imageDeletions = mutations.filter(
    (operation) => operation.kind === 'delete',
  ).filter(
    (operation) => isImageFilePath(operation.path),
  ).length + mutations.filter(
    (operation) =>
      operation.kind === 'rename' &&
      operation.fromPath !== undefined &&
      isImageFilePath(operation.fromPath) &&
      !isImageFilePath(operation.path),
  ).length;

  return createSyncPlan({
    ...input,
    corpus: {
      markdownOperations,
      codePagesBefore,
      codePagesAfter: Math.max(
        0,
        codePagesBefore + codeAdds - codeDeletions,
      ),
      codeDeletions,
      imagePagesBefore,
      imagePagesAfter: Math.max(
        0,
        imagePagesBefore + imageAdds - imageDeletions,
      ),
      imageOperations: imageOperations.length,
    },
  });
}

async function buildFullTreePlanOperations(
  engine: BrainEngine,
  opts: SyncOpts,
  preflight: ReadOnlySyncPreflight,
  allFiles: string[],
  selectedFiles: string[],
  strategy: SyncPlanStrategy,
  activePack: SyncActivePack | undefined,
): Promise<SyncPlanOperation[]> {
  const sourceId = opts.sourceId ?? DEFAULT_SOURCE_ID;
  const rows = await engine.executeRaw<PlannedExistingPage>(
    `SELECT slug, source_path, content_hash, type, frontmatter
       FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL`,
    [sourceId],
  );
  const normalizePath = (path: string): string => path.replace(/\\/g, '/');
  const ownedRows = rows.map((row) => ({
    ...row,
    source_path: existingPageSourcePath(row),
  }));
  const toSourcePath = (absolutePath: string): string =>
    normalizePath(
      relative(preflight.slugRoot ?? preflight.syncScopeRoot, absolutePath),
    );
  const byPath = new Map(
    ownedRows
      .filter(
        (row): row is PlannedExistingPage & { source_path: string } =>
          row.source_path !== null,
      )
      .map((row) => [normalizePath(row.source_path), row]),
  );
  const bySlug = new Map(ownedRows.map((row) => [row.slug, row]));
  const existingOwnedByPath = (
    path: string,
  ): PlannedExistingPage | undefined => {
    const normalized = normalizePath(path);
    const exact = byPath.get(normalized);
    if (exact) return exact;
    const candidate = bySlug.get(resolveSlugForPath(normalized));
    return existingPageOwnsSourcePath(candidate, normalized)
      ? candidate
      : undefined;
  };
  const allCurrent = new Set(allFiles.map(toSourcePath));
  const selectedCurrent = new Set(selectedFiles.map(toSourcePath));
  const scopePrefix =
    preflight.syncScopeRelPath === ''
      ? ''
      : normalizePath(preflight.syncScopeRelPath) + '/';
  const inScope = (path: string): boolean =>
    scopePrefix === '' || normalizePath(path).startsWith(scopePrefix);
  const scopeRelativePath = (path: string): string => {
    const normalized = normalizePath(path);
    return scopePrefix !== '' && normalized.startsWith(scopePrefix)
      ? normalized.slice(scopePrefix.length)
      : normalized;
  };
  const isCommandExcluded = (path: string): boolean =>
    opts.exclude !== undefined &&
    opts.exclude.length > 0 &&
    matchesAnyGlob(scopeRelativePath(path), opts.exclude);
  const excludedRenameSources = new Map<string, string>();
  const renameByDestination = new Map<
    string,
    { from: string; to: string }
  >();
  if (preflight.bookmark !== null) {
    const delta = computeSyncDelta(
      preflight.gitContextRoot,
      preflight.bookmark,
      preflight.headCommit,
    );
    if (delta.status === 'ok') {
      for (const rename of delta.manifest.renamed) {
        const from = normalizePath(rename.from);
        const to = normalizePath(rename.to);
        renameByDestination.set(to, { from, to });
        if (allCurrent.has(to) && !selectedCurrent.has(to)) {
          excludedRenameSources.set(from, 'renamed-into-command-exclusion');
        } else if (
          inScope(to) &&
          excludedOnlyByStrategy(to, strategy)
        ) {
          excludedRenameSources.set(
            from,
            'renamed-outside-selected-strategy',
          );
        } else if (
          inScope(to) &&
          ['metafile', 'pruned-dir'].includes(
            unsyncableReason(to, { strategy }) ?? '',
          )
        ) {
          excludedRenameSources.set(
            from,
            'renamed-into-protected-unsyncable-path',
          );
        }
      }
    }
  }
  const operations: SyncPlanOperation[] = [];
  const plannedRenameSources = new Set<string>();

  for (const absolutePath of selectedFiles) {
    const sourcePath = toSourcePath(absolutePath);
    const derivedSlug = resolveSlugForPath(sourcePath);
    const rename = renameByDestination.get(sourcePath);
    const renamedExisting = rename
      ? existingOwnedByPath(rename.from)
      : undefined;
    const existing =
      byPath.get(sourcePath) ??
      renamedExisting ??
      bySlug.get(derivedSlug);
    const identity = plannedFileIdentity(
      absolutePath,
      sourcePath,
      existing,
      activePack,
    );
    if (rename && renamedExisting) {
      operations.push({
        kind: 'rename',
        path: sourcePath,
        fromPath: rename.from,
        slug: identity.slug,
        contentHash: identity.contentHash,
      });
      plannedRenameSources.add(rename.from);
    } else if (!existing) {
      operations.push({
        kind: 'add',
        path: sourcePath,
        slug: identity.slug,
        contentHash: identity.contentHash,
      });
    } else if (
      identity.contentHash === null ||
      existing.content_hash !== identity.contentHash
    ) {
      operations.push({
        kind: 'modify',
        path: sourcePath,
        slug: existing.slug,
        contentHash: identity.contentHash,
      });
    }
  }

  const scopedFileRows = ownedRows.filter(
    (row): row is PlannedExistingPage & { source_path: string } =>
      row.source_path !== null && inScope(row.source_path),
  );
  const reconcile = planReconcileDeletes(
    scopedFileRows,
    allCurrent,
    (path) => isSyncable(path, { strategy }),
  );
  const stale = new Set(reconcile.staleSlugs);
  const massDeleteBlocked =
    reconcile.massDelete && !massReconcileAllowed();
  const everCommitted = listEverCommittedPaths(
    preflight.gitContextRoot,
    opts.targetTreeRoot ? preflight.headCommit : undefined,
  );

  for (const row of scopedFileRows) {
    const sourcePath = normalizePath(row.source_path);
    if (selectedCurrent.has(sourcePath)) continue;
    if (plannedRenameSources.has(sourcePath)) continue;

    const excludedRenameReason = excludedRenameSources.get(sourcePath);
    if (excludedRenameReason !== undefined) {
      operations.push({
        kind: 'preserve',
        path: sourcePath,
        slug: row.slug,
        reason: excludedRenameReason,
      });
      continue;
    }

    if (allCurrent.has(sourcePath)) {
      operations.push({
        kind: 'preserve',
        path: sourcePath,
        slug: row.slug,
        reason: 'excluded-by-command',
      });
      continue;
    }

    if (isCommandExcluded(sourcePath)) {
      operations.push({
        kind: 'preserve',
        path: sourcePath,
        slug: row.slug,
        reason: 'excluded-by-command',
      });
      continue;
    }

    if (!isSyncable(sourcePath, { strategy })) {
      operations.push({
        kind: 'preserve',
        path: sourcePath,
        slug: row.slug,
        reason: excludedOnlyByStrategy(sourcePath, strategy)
          ? 'excluded-by-selected-strategy'
          : (unsyncableReason(sourcePath, { strategy }) ?? 'not-syncable'),
      });
      continue;
    }

    if (!stale.has(row.slug)) continue;
    const shouldPreserve =
      opts.sourceId === undefined ||
      massDeleteBlocked ||
      (everCommitted !== null && !everCommitted.has(sourcePath));
    operations.push({
      kind: shouldPreserve ? 'preserve' : 'delete',
      path: sourcePath,
      slug: row.slug,
      ...(shouldPreserve
        ? {
            reason:
              opts.sourceId === undefined
                ? 'legacy-unscoped-reconcile-disabled'
                : massDeleteBlocked
                  ? 'mass-reconcile-guard'
                  : 'db-only-never-committed',
          }
        : {}),
    });
  }

  return operations;
}

function excludedOnlyByStrategy(
  path: string,
  strategy: SyncPlanStrategy,
): boolean {
  return (
    strategy !== 'auto' &&
    !isSyncable(path, { strategy }) &&
    isSyncable(path, { strategy: 'auto' })
  );
}

async function buildReadOnlySyncPlan(
  engine: BrainEngine,
  opts: SyncOpts,
  resolvedRepoPath: string,
  planning?: { activePack: SyncActivePack | undefined },
): Promise<SyncPlan> {
  const livePreflight = await readOnlySyncPreflight(
    engine,
    opts,
    resolvedRepoPath,
  );
  const targetTreeRoot = opts.targetTreeRoot
    ? realpathSync(opts.targetTreeRoot)
    : undefined;
  const targetScopeRoot = targetTreeRoot
    ? realpathSync(resolve(targetTreeRoot, livePreflight.syncScopeRelPath))
    : undefined;
  if (
    targetTreeRoot &&
    targetScopeRoot &&
    !isWithinRoot(targetScopeRoot, targetTreeRoot)
  ) {
    throw new SyncPreconditionError(
      'plan_failed',
      'The immutable target scope escaped its private materialization root.',
      targetScopeRoot,
      targetTreeRoot,
    );
  }
  const preflight: ReadOnlySyncPreflight = targetTreeRoot && targetScopeRoot
    ? {
        ...livePreflight,
        syncScopeRoot: targetScopeRoot,
        slugRoot:
          livePreflight.syncScopeRelPath === '' ? undefined : targetTreeRoot,
      }
    : livePreflight;
  const strategy: SyncPlanStrategy = opts.strategy ?? 'markdown';
  const sourceId = opts.sourceId ?? DEFAULT_SOURCE_ID;
  const activePack =
    planning !== undefined
      ? planning.activePack
      : await loadSyncActivePackReadOnly(opts);
  const lastSuccessfulStrategy = await readLastSuccessfulStrategy(engine, opts.sourceId);
  const strategyChanged =
    opts.sourceId !== undefined && lastSuccessfulStrategy !== strategy;
  const storedVersion = await readChunkerVersion(engine, opts.sourceId);
  const versionMismatch =
    storedVersion !== null && storedVersion !== String(CHUNKER_VERSION);
  const versionNeverSet = storedVersion === null && opts.sourceId !== undefined;
  const forceFull =
    opts.full === true ||
    preflight.bookmark === null ||
    opts.includeGitignored === true ||
    strategyChanged ||
    versionMismatch ||
    versionNeverSet;

  if (forceFull) {
    const allFiles = collectSyncableFiles(preflight.syncScopeRoot, {
      strategy,
      includeGitignored: opts.includeGitignored,
    });
    let files = allFiles;
    if (opts.exclude && opts.exclude.length > 0) {
      files = files.filter((absolutePath) =>
        !matchesAnyGlob(relative(preflight.syncScopeRoot, absolutePath), opts.exclude),
      );
    }
    const operations = await buildFullTreePlanOperations(
      engine,
      opts,
      preflight,
      allFiles,
      files,
      strategy,
      activePack,
    );
    return await createEngineBoundSyncPlan(engine, {
      mode: preflight.bookmark === null ? 'first' : 'full',
      sourceId,
      repoPath: preflight.anchorPath,
      fromCommit: preflight.bookmark,
      targetCommit: preflight.headCommit,
      strategy,
      lastSuccessfulStrategy,
      strategyChanged,
      schemaPackIdentity: activePack?.identity ?? null,
      operations,
    });
  }

  const lastCommit = preflight.bookmark!;
  const checkpoint = syncCheckpointKeys(opts.sourceId, lastCommit);
  let targetCommit = preflight.headCommit;
  let completedPaths: string[] = [];
  let checkpointReset = false;
  const storedTarget = (await loadOpCheckpoint(engine, checkpoint.target))[0] ?? null;
  const storedProvenance =
    (await loadOpCheckpoint(engine, checkpoint.provenance))[0] ?? null;
  if (storedTarget) {
    if (
      opts.expectedTarget !== undefined &&
      (
        storedTarget !== preflight.headCommit ||
        storedProvenance !== SYNC_TARGET_PROVENANCE_EXACT
      )
    ) {
      // A paired exact-target caller can reuse only a checkpoint minted by an
      // earlier exact-target apply for this same captured HEAD. An ordinary
      // sync may have imported dirty working-tree bytes even when its target
      // SHA matches, while an older target can omit later changes entirely.
      // Preview the full exact delta without mutating the checkpoint; the
      // matching apply path clears it under the same lock.
      checkpointReset = true;
    } else {
      try {
        git(preflight.gitContextRoot, [
          'merge-base',
          '--is-ancestor',
          storedTarget,
          preflight.headCommit,
        ]);
        targetCommit = storedTarget;
        completedPaths = await loadOpCheckpoint(engine, checkpoint.paths);
      } catch {
        checkpointReset = true;
      }
    }
  }

  const detachedManifest = preflight.detachedHead && !opts.targetTreeRoot
    ? buildDetachedWorkingTreeManifest(preflight.gitContextRoot)
    : null;
  const delta = computeSyncDelta(
    preflight.gitContextRoot,
    lastCommit,
    targetCommit,
    { detachedManifest },
  );
  if (delta.status === 'unavailable') {
    const allFiles = collectSyncableFiles(preflight.syncScopeRoot, {
      strategy,
      includeGitignored: opts.includeGitignored,
    });
    let files = allFiles;
    if (opts.exclude && opts.exclude.length > 0) {
      files = files.filter((absolutePath) =>
        !matchesAnyGlob(relative(preflight.syncScopeRoot, absolutePath), opts.exclude),
      );
    }
    return await createEngineBoundSyncPlan(engine, {
      mode: 'full',
      sourceId,
      repoPath: preflight.anchorPath,
      fromCommit: lastCommit,
      targetCommit: preflight.headCommit,
      strategy,
      lastSuccessfulStrategy,
      strategyChanged,
      checkpointReset,
      operations: await buildFullTreePlanOperations(
        engine,
        opts,
        preflight,
        allFiles,
        files,
        strategy,
        activePack,
      ),
      schemaPackIdentity: activePack?.identity ?? null,
    });
  }

  const scoped = preflight.syncScopeRelPath !== '';
  const scopePrefix = preflight.syncScopeRelPath.replace(/\\/g, '/');
  const inScope = (path: string): boolean =>
    !scoped || path === scopePrefix || path.startsWith(scopePrefix + '/');
  const scopeRelative = (path: string): string =>
    scoped && path.startsWith(scopePrefix + '/')
      ? path.slice(scopePrefix.length + 1)
      : path;
  const isExcluded = (path: string): boolean =>
    opts.exclude !== undefined &&
    opts.exclude.length > 0 &&
    matchesAnyGlob(scopeRelative(path), opts.exclude);
  const syncOpts = { strategy };
  const renamedToUnsyncable = delta.manifest.renamed
    .filter(
      (rename) =>
        inScope(rename.from) &&
        isSyncable(rename.from, syncOpts) &&
        !(inScope(rename.to) && isSyncable(rename.to, syncOpts)) &&
        (
          !inScope(rename.to) ||
          !excludedOnlyByStrategy(rename.to, strategy) &&
          !['metafile', 'pruned-dir'].includes(
            unsyncableReason(rename.to, syncOpts) ?? '',
          )
        ),
    )
    .map((rename) => rename.from);
  const filtered: SyncManifest = {
    added: delta.manifest.added.filter(
      (path) => inScope(path) && !isExcluded(path) && isSyncable(path, syncOpts),
    ),
    modified: delta.manifest.modified.filter(
      (path) => inScope(path) && !isExcluded(path) && isSyncable(path, syncOpts),
    ),
    deleted: unique([
      ...delta.manifest.deleted.filter(
        (path) =>
          inScope(path) &&
          !isExcluded(path) &&
          isSyncable(path, syncOpts),
      ),
      ...renamedToUnsyncable,
    ]),
    renamed: delta.manifest.renamed.filter(
      (rename) =>
        inScope(rename.to) &&
        !isExcluded(rename.to) &&
        isSyncable(rename.to, syncOpts),
    ),
  };

  const completed = new Set(completedPaths);
  const added = resumeFilter(filtered.added, completedPaths);
  const modified = resumeFilter(filtered.modified, completedPaths);
  const deleted = resumeFilter(filtered.deleted, completedPaths);
  const renamed = filtered.renamed.filter((rename) => !completed.has(rename.to));
  const preserveCandidates = delta.manifest.modified.filter(
    (path) =>
      inScope(path) &&
      (
        isExcluded(path) ||
        !isSyncable(path, syncOpts)
      ),
  );
  const cleanupCandidates: string[] = [];
  const preserves: Array<{ path: string; reason: string }> = [];
  for (const path of preserveCandidates) {
    if (isExcluded(path)) {
      preserves.push({
        path,
        reason: 'excluded-by-command',
      });
      continue;
    }
    const reason = unsyncableReason(path, syncOpts);
    if (
      excludedOnlyByStrategy(path, strategy) ||
      reason === 'metafile' ||
      reason === 'pruned-dir'
    ) {
      preserves.push({
        path,
        reason: reason ?? 'excluded-by-selected-strategy',
      });
    } else {
      cleanupCandidates.push(path);
    }
  }
  for (const rename of delta.manifest.renamed) {
    if (!inScope(rename.from) || !isSyncable(rename.from, syncOpts)) {
      continue;
    }
    if (inScope(rename.to) && isExcluded(rename.to)) {
      preserves.push({
        path: rename.from,
        reason: 'renamed-into-command-exclusion',
      });
      continue;
    }
    if (
      inScope(rename.to) &&
      excludedOnlyByStrategy(rename.to, strategy)
    ) {
      preserves.push({
        path: rename.from,
        reason: 'renamed-outside-selected-strategy',
      });
      continue;
    }
    if (
      inScope(rename.to) &&
      ['metafile', 'pruned-dir'].includes(
        unsyncableReason(rename.to, syncOpts) ?? '',
      )
    ) {
      preserves.push({
        path: rename.from,
        reason: 'renamed-into-protected-unsyncable-path',
      });
    }
  }
  for (const path of delta.manifest.deleted) {
    if (inScope(path) && isExcluded(path)) {
      preserves.push({
        path,
        reason: 'excluded-by-command',
      });
    }
  }

  const existingRows = await engine.executeRaw<PlannedExistingPage>(
    `SELECT slug, source_path, content_hash, type, frontmatter
       FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL`,
    [sourceId],
  );
  const normalizePath = (path: string): string => path.replace(/\\/g, '/');
  const ownedExistingRows = existingRows.map((row) => ({
    ...row,
    source_path: existingPageSourcePath(row),
  }));
  const existingByPath = new Map(
    ownedExistingRows
      .filter(
        (row): row is PlannedExistingPage & { source_path: string } =>
          row.source_path !== null,
      )
      .map((row) => [normalizePath(row.source_path), row]),
  );
  const existingBySlug = new Map(
    ownedExistingRows.map((row) => [row.slug, row]),
  );
  const existingForPath = (path: string): PlannedExistingPage | undefined =>
    existingByPath.get(normalizePath(path)) ??
    existingBySlug.get(resolveSlugForPath(path));
  const existingAtExactPath = (
    path: string,
  ): PlannedExistingPage | undefined => {
    const normalized = normalizePath(path);
    const exact = existingByPath.get(normalized);
    if (exact) return exact;
    const candidate = existingBySlug.get(resolveSlugForPath(normalized));
    return existingPageOwnsSourcePath(candidate, normalized)
      ? candidate
      : undefined;
  };
  const plannedIdentity = (
    path: string,
    existing: PlannedExistingPage | undefined,
  ): { slug: string; contentHash: string | null } | null => {
    const absolutePath = join(
      opts.targetTreeRoot ?? preflight.gitContextRoot,
      path,
    );
    if (!existsSync(absolutePath)) {
      // Ordinary sync plans from a pinned Git delta but imports from the live
      // working tree. A later writer may remove an added/modified path before
      // planning reaches it. Keep that Git operation in the execution plan so
      // the resumable runner can treat the vanished path as drained and advance
      // to its pin, matching the established forward-progress contract. Exact
      // target materializations are immutable; a missing file there is a real
      // plan inconsistency and remains omitted/fail-closed.
      return opts.targetTreeRoot
        ? null
        : {
            slug: existing?.slug ?? resolveSlugForPath(path),
            contentHash: null,
          };
    }
    return plannedFileIdentity(
      absolutePath,
      path,
      existing,
      activePack,
    );
  };
  const operations: SyncPlanOperation[] = [];

  for (const path of added) {
    const existing = existingForPath(path);
    const identity = plannedIdentity(path, existing);
    if (!identity) continue;
    if (!existing) {
      operations.push({
        kind: 'add',
        path,
        slug: identity.slug,
        contentHash: identity.contentHash,
      });
    } else if (
      identity.contentHash === null ||
      existing.content_hash !== identity.contentHash
    ) {
      operations.push({
        kind: 'modify',
        path,
        slug: existing.slug,
        contentHash: identity.contentHash,
      });
    }
  }
  for (const path of modified) {
    const existing = existingForPath(path);
    const identity = plannedIdentity(path, existing);
    if (!identity) continue;
    if (!existing) {
      operations.push({
        kind: 'add',
        path,
        slug: identity.slug,
        contentHash: identity.contentHash,
      });
    } else if (
      identity.contentHash === null ||
      existing.content_hash !== identity.contentHash
    ) {
      operations.push({
        kind: 'modify',
        path,
        slug: existing.slug,
        contentHash: identity.contentHash,
      });
    }
  }
  for (const path of deleted) {
    const existing = existingAtExactPath(path);
    if (!existing) continue;
    operations.push({
      kind: 'delete',
      path,
      slug: existing.slug,
    });
  }
  for (const rename of renamed) {
    const sourceExisting = existingAtExactPath(rename.from);
    const destinationExisting = existingForPath(rename.to);
    const existing = sourceExisting ?? destinationExisting;
    const identity = plannedIdentity(rename.to, existing);
    if (!identity) continue;
    if (sourceExisting) {
      operations.push({
        kind: 'rename',
        path: rename.to,
        fromPath: rename.from,
        slug: identity.slug,
        contentHash: identity.contentHash,
      });
    } else if (!destinationExisting) {
      operations.push({
        kind: 'add',
        path: rename.to,
        slug: identity.slug,
        contentHash: identity.contentHash,
      });
    } else if (
      identity.contentHash === null ||
      destinationExisting.content_hash !== identity.contentHash
    ) {
      operations.push({
        kind: 'modify',
        path: rename.to,
        slug: destinationExisting.slug,
        contentHash: identity.contentHash,
      });
    }
  }
  for (const { path, reason } of preserves) {
    const existing = existingAtExactPath(path);
    if (!existing) continue;
    operations.push({
      kind: 'preserve',
      path,
      slug: existing.slug,
      reason,
    });
  }
  for (const path of cleanupCandidates) {
    const existing = existingAtExactPath(path);
    if (!existing) continue;
    operations.push({
      kind: 'delete',
      path,
      slug: existing.slug,
      reason: unsyncableReason(path, syncOpts) ?? undefined,
    });
  }

  return await createEngineBoundSyncPlan(engine, {
    mode: completedPaths.length > 0 ? 'resumed' : 'incremental',
    sourceId,
    repoPath: preflight.anchorPath,
    fromCommit: lastCommit,
    targetCommit,
    strategy,
    lastSuccessfulStrategy,
    strategyChanged,
    checkpointReset,
    schemaPackIdentity: activePack?.identity ?? null,
    operations,
  });
}

function syncResultFromPlan(plan: SyncPlan): SyncResult {
  return {
    status: 'dry_run',
    fromCommit: plan.fromCommit,
    toCommit: plan.targetCommit,
    added: plan.added,
    modified: plan.modified,
    deleted: plan.deleted,
    renamed: plan.renamed,
    preserved: plan.preserved,
    chunksCreated: 0,
    embedded: 0,
    pagesAffected: [],
    previewKind: 'validated_index_plan',
    sourceId: plan.sourceId,
    strategy: plan.strategy,
    lastSuccessfulStrategy: plan.lastSuccessfulStrategy,
    strategyChanged: plan.strategyChanged,
    checkpointReset: plan.checkpointReset,
    affected: plan.affected,
    affectedDigest: plan.affectedDigest,
    planDigest: plan.planDigest,
    planCorpus: plan.corpus,
  };
}

function attachPlanEvidence(result: SyncResult, plan: SyncPlan): SyncResult {
  const completed =
    result.status === 'synced' ||
    result.status === 'first_sync' ||
    result.status === 'up_to_date';
  return {
    ...result,
    fromCommit: plan.fromCommit,
    toCommit: plan.targetCommit,
    added: plan.added,
    modified: plan.modified,
    deleted: plan.deleted,
    renamed: plan.renamed,
    sourceId: plan.sourceId,
    strategy: plan.strategy,
    lastSuccessfulStrategy: completed
      ? plan.strategy
      : plan.lastSuccessfulStrategy,
    strategyChanged: plan.strategyChanged,
    checkpointReset: plan.checkpointReset,
    affected: plan.affected,
    affectedDigest: plan.affectedDigest,
    planDigest: plan.planDigest,
    planCorpus: plan.corpus,
    preserved: plan.preserved,
  };
}

export async function performSync(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  if (
    opts.expectedPlanDigest !== undefined &&
    !/^[0-9a-f]{64}$/.test(opts.expectedPlanDigest)
  ) {
    throw new SyncPreconditionError(
      'plan_failed',
      'Expected plan digest must be a lowercase 64-character SHA-256 digest.',
      opts.expectedPlanDigest,
      '<64-char-lowercase-sha256>',
    );
  }
  const paired =
    opts.expectedTarget !== undefined ||
    opts.expectedBookmark !== undefined ||
    opts.expectedPlanDigest !== undefined ||
    opts.requireClean === true;
  if (paired && !opts.dryRun && opts.expectedPlanDigest === undefined) {
    throw new SyncPreconditionError(
      'plan_failed',
      'Paired exact-target apply requires the reviewed preview plan digest.',
      null,
      '--expected-plan-digest <64-char-lowercase-sha256>',
    );
  }
  if (paired && opts.skipLock === true) {
    throw new SyncPreconditionError(
      'plan_failed',
      'Paired exact-target sync requires its source lock for plan validation and apply.',
      '--skip-lock',
      'source-scoped refreshing lock',
    );
  }
  if (paired && opts.noPull !== true) {
    throw new SyncPreconditionError(
      'plan_failed',
      'Paired exact-target sync requires --no-pull so Git cannot move after planning.',
      'pull enabled',
      '--no-pull',
    );
  }
  if (paired && opts.includeGitignored === true) {
    throw new SyncPreconditionError(
      'plan_failed',
      'Paired exact-target sync cannot include gitignored content because it is not part of the target commit.',
      '--include-gitignored',
      'tracked regular files from the exact target commit',
    );
  }
  if (paired && opts.skipFailed === true) {
    throw new SyncPreconditionError(
      'plan_failed',
      'Paired exact-target apply cannot acknowledge failed files because its receipt must describe complete target convergence.',
      '--skip-failed',
      'fix every planned file failure and retry the same target',
    );
  }
  if (
    (paired || opts.schema1Receipt === true) &&
    process.env.GBRAIN_EMBEDDING_MULTIMODAL === 'true'
  ) {
    throw new SyncPreconditionError(
      'plan_failed',
      'Schema-1 safe-sync receipts require multimodal indexing to be disabled before work begins.',
      'GBRAIN_EMBEDDING_MULTIMODAL=true',
      'GBRAIN_EMBEDDING_MULTIMODAL=false',
    );
  }
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
  const runLocked = async (): Promise<SyncResult> => {
    let targetTree: TargetTreeMaterialization | undefined;
    try {
      let pairedOpts = opts;
      let repoPath: string | undefined;
      if (paired) {
        repoPath =
          opts.repoPath ??
          (await readSyncAnchor(engine, opts.sourceId, 'repo_path')) ??
          undefined;
        if (!repoPath) {
          throw new SyncPreconditionError(
            'managed_clone_missing',
            'The source has no repository path to plan.',
            null,
            opts.repoPath ?? null,
          );
        }
        const preflight = await readOnlySyncPreflight(engine, opts, repoPath);
        targetTree = await materializeTargetTree(
          preflight,
          preflight.headCommit,
          opts.strategy ?? 'markdown',
        );
        pairedOpts = {
          ...opts,
          // Pin the path resolved from sources.local_path under this source
          // lock. Every later preflight must compare the same canonical path
          // instead of re-resolving a potentially different scoped source.
          // Supported source lifecycle writers share syncLockId(sourceId), so
          // this identity remains stable through plan, apply, and anchor write.
          repoPath,
          expectedTarget: opts.expectedTarget ?? preflight.headCommit,
          targetTreeRoot: targetTree.root,
          // Schema-1 completion evidence deliberately describes indexing
          // convergence only. Defer enrichers so they cannot reopen live
          // worktree bytes after the exact target snapshot was captured.
          noEmbed: true,
          noExtract: true,
        };
      }

      let applyPlan: SyncPlan | null = null;
      let applyActivePack: SyncActivePack | undefined;
      if (!pairedOpts.dryRun && paired) {
        applyActivePack = await loadSyncActivePackReadOnly(pairedOpts);
        applyPlan = await buildReadOnlySyncPlan(
          engine,
          pairedOpts,
          repoPath!,
          { activePack: applyActivePack },
        );
        if (
          opts.expectedPlanDigest !== undefined &&
          applyPlan.planDigest !== opts.expectedPlanDigest
        ) {
          throw new SyncPreconditionError(
            'plan_changed',
            'The current immutable sync plan no longer matches the reviewed preview.',
            applyPlan.planDigest,
            opts.expectedPlanDigest,
          );
        }
      }
      const executionOpts: SyncOpts = {
        ...pairedOpts,
        ...(applyPlan ? { validatedPlan: applyPlan } : {}),
        ...(applyPlan
          ? { validatedActivePack: applyActivePack ?? null }
          : {}),
      };
      const result = await performSyncInner(engine, executionOpts);
      const resultPlan = applyPlan ?? executionOpts.validatedPlan;
      return resultPlan ? attachPlanEvidence(result, resultPlan) : result;
    } finally {
      if (targetTree) {
        targetTree.deregisterCleanup();
        rmSync(targetTree.root, { recursive: true, force: true });
      }
    }
  };

  if (opts.skipLock) {
    return await runLocked();
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
    return await withRefreshingLock(engine, lockKey, runLocked, {
      failOnReleaseError:
        opts.dryRun === true ||
        paired ||
        opts.schema1Receipt === true,
    });
  } catch (err) {
    if (err instanceof LockUnavailableError) {
      throw new SyncLockBusyError(await formatLockBusyMessage(engine, lockKey), lockKey);
    }
    throw err;
  }
}

/**
 * v0.41.6.0 D3: rich "Another sync is in progress" message that names the
 * holder PID, hostname, age, and the right --break-lock invocation to
 * recover. Falls back to the legacy message when inspectLock can't read
 * the row (best-effort — the lock itself was still busy).
 */
async function formatLockBusyMessage(engine: BrainEngine, lockKey: string): Promise<string> {
  const { inspectLock } = await import('../core/db-lock.ts');
  let snap;
  try { snap = await inspectLock(engine, lockKey); }
  catch { snap = null; }

  if (!snap) {
    return (
      `Another sync is in progress (lock ${lockKey} held). ` +
      `Wait for it to finish, or run 'gbrain doctor' if it has been more than 30 minutes.`
    );
  }

  const ageHuman = formatAgeHuman(snap.age_ms);
  const breakHint = lockKey.startsWith('gbrain-sync:')
    ? `gbrain sync --break-lock --source ${lockKey.slice('gbrain-sync:'.length)}`
    : `gbrain sync --break-lock`;
  const ttlNote = snap.ttl_expired ? ' [TTL expired]' : '';
  return (
    `Another sync is in progress (lock ${lockKey} held by pid ${snap.holder_pid} on ${snap.holder_host}, ` +
    `started ${ageHuman} ago${ttlNote}).\n` +
    `If pid ${snap.holder_pid} is dead, re-run with --break-lock to clear it:\n` +
    `  ${breakHint}\n` +
    `Or wait for the holder to finish.`
  );
}

/**
 * v0.41.6.0 D3: `gbrain sync --break-lock` / `--force-break-lock` worker.
 * Returns the process exit code (0 = lock cleared or absent; 1 = refused).
 *
 * Safe path (`force=false`): refuses unless the holder is on this host
 * AND either (a) TTL has expired (the lock is structurally available
 * already) OR (b) the holder PID is dead AND the lock is older than 60s
 * (the age guard defeats PID-reuse coincidence — Linux PID space wraps
 * at 32768 so a 10-day-old lock with pid=12345 may be falsely
 * refused-to-clear because an unrelated process now owns pid 12345; 60s
 * is the codex F7-amended minimum age that makes coincidence unlikely).
 *
 * Force path (`force=true`): skips liveness check, deletes the row,
 * warns loudly that the holder may still be writing.
 *
 * Both paths use the same atomic `DELETE ... RETURNING id` so a race
 * with another break-lock or with TTL-eviction can't produce confusing
 * post-conditions.
 */
export async function runBreakLock(
  engine: BrainEngine,
  lockKey: string,
  sourceId: string,
  opts: { force: boolean; json: boolean; maxAgeSeconds?: number },
): Promise<number> {
  const { inspectLock, deleteLockRow, deleteLockRowIfStale, classifyHolderLiveness } = await import('../core/db-lock.ts');
  const { hostname } = await import('os');
  const localHost = hostname();
  let snap;
  try { snap = await inspectLock(engine, lockKey); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (opts.json) console.log(JSON.stringify({ status: 'error', error: msg, lock: lockKey }));
    else console.error(`Failed to inspect lock ${lockKey}: ${msg}`);
    return 1;
  }

  if (!snap) {
    // BUG 5 (v0.42.x): --force-break-lock used to emit the same terse "not
    // held" line and exit 0 even when a sync was genuinely wedged — sending the
    // operator down a dead end (the wedge was not a held lock). Keep rc=0
    // (breaking a non-existent lock is idempotently successful; flipping the
    // exit code would break automation that treats it as success), but under
    // --force say plainly that nothing was broken and point at the real next
    // step. The non-force path message is unchanged.
    if (opts.force) {
      const wedgeHint =
        `No lock is held on ${lockKey} — nothing to break. If a sync still ` +
        `appears wedged, the cause is not a held lock; inspect checkpoint/resume ` +
        `state with \`gbrain sync --source ${sourceId}\` or \`gbrain doctor\`.`;
      if (opts.json) {
        console.log(JSON.stringify({ status: 'absent', lock: lockKey, source_id: sourceId, wedge_hint: wedgeHint }));
      } else {
        console.log(wedgeHint);
      }
      return 0;
    }
    if (opts.json) console.log(JSON.stringify({ status: 'absent', lock: lockKey, source_id: sourceId }));
    else console.log(`Lock ${lockKey} is not held (nothing to break).`);
    return 0;
  }

  // v0.41.13.0 (T4 / D-V3-4 / D-V4-mech-4) — --max-age path: route through
  // deleteLockRowIfStale which runs a single atomic DELETE keyed on
  // (id, holder_pid, last_refreshed_at < NOW() - maxAge). Healthy refreshing
  // holders survive by construction (their last_refreshed_at is recent).
  // Wedged-but-alive holders (JS interval stopped firing) get broken.
  // No TOCTOU between inspect + delete; the WHERE clause is the gate.
  if (opts.maxAgeSeconds !== undefined && !opts.force) {
    // Cross-host guard preserved from the safe path: --max-age does NOT
    // bypass cross-host refusal because process.kill(pid, 0) is invalid
    // across hosts (PID is meaningful only on the same host). Operators
    // who need to clear a cross-host lock use --force-break-lock.
    if (snap.holder_host !== localHost) {
      if (opts.json) {
        console.log(JSON.stringify({
          status: 'refused', reason: 'cross_host', lock: lockKey, source_id: sourceId,
          snapshot: snap, local_host: localHost,
        }));
      } else {
        console.error(`Lock ${lockKey} is held on a different host (${snap.holder_host}, this host is ${localHost}).`);
        console.error('Cross-host --max-age is unsupported. Use --force-break-lock when certain the remote holder is dead.');
      }
      return 1;
    }
    const { deleted, lastRefreshedAt } = await deleteLockRowIfStale(
      engine, lockKey, snap.holder_pid, opts.maxAgeSeconds,
    );
    if (opts.json) {
      console.log(JSON.stringify({
        status: deleted ? 'broken' : 'refused',
        reason: deleted ? 'max_age_breached' : 'within_max_age',
        lock: lockKey,
        source_id: sourceId,
        snapshot: snap,
        max_age_seconds: opts.maxAgeSeconds,
        last_refreshed_at: lastRefreshedAt ? lastRefreshedAt.toISOString() : null,
      }));
    } else if (deleted) {
      const ageStr = lastRefreshedAt ? formatAgeHuman(Date.now() - lastRefreshedAt.getTime()) : 'unknown';
      console.log(`Broke lock ${lockKey} (pid ${snap.holder_pid} on ${snap.holder_host}; last refresh was ${ageStr} ago, > --max-age=${opts.maxAgeSeconds}s).`);
    } else {
      // last_refreshed_at within --max-age window OR null (pre-v98 brain).
      // Distinguish the two cases for the operator.
      if (snap.last_refreshed_at === null) {
        console.error(`Lock ${lockKey} has NULL last_refreshed_at (pre-v98 brain or migration window).`);
        console.error('Run `gbrain apply-migrations --yes` to land v98, OR use --force-break-lock if you know the holder is dead.');
      } else {
        const ageStr = snap.ms_since_last_refresh != null ? formatAgeHuman(snap.ms_since_last_refresh) : 'unknown';
        console.error(`Refusing to break lock ${lockKey}: last refresh was ${ageStr} ago, within --max-age=${opts.maxAgeSeconds}s window.`);
        console.error('The holder is actively refreshing — likely a healthy long-running sync.');
      }
      return 1;
    }
    return 0;
  }

  // Force path: skip all guards, atomic DELETE, warn.
  if (opts.force) {
    const { deleted } = await deleteLockRow(engine, lockKey, snap.holder_pid);
    if (opts.json) {
      console.log(JSON.stringify({
        status: deleted ? 'force_broken' : 'race_already_cleared',
        lock: lockKey, source_id: sourceId, snapshot: snap,
      }));
    } else if (deleted) {
      console.log(`Force-broke lock ${lockKey} (was held by pid ${snap.holder_pid} on ${snap.holder_host}, age ${formatAgeHuman(snap.age_ms)}).`);
      console.log('WARNING: the holder may still be writing. Verify with `gbrain doctor` before re-running.');
    } else {
      console.log(`Lock ${lockKey} was already cleared by another process between our check and DELETE (race-safe).`);
    }
    return 0;
  }

  // Safe path: must be local host AND (TTL-expired OR (PID-dead AND age >= 60s)).
  if (snap.holder_host !== localHost) {
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'refused',
        reason: 'cross_host',
        lock: lockKey, source_id: sourceId, snapshot: snap, local_host: localHost,
      }));
    } else {
      console.error(`Lock ${lockKey} is held on a different host (${snap.holder_host}, this host is ${localHost}).`);
      console.error('Cross-host PID liveness is unsound. To break anyway, use --force-break-lock');
      console.error('(only safe when you KNOW the holder is dead — verify before forcing).');
    }
    return 1;
  }

  let safe = false;
  let reason: string;
  if (snap.ttl_expired) {
    safe = true;
    reason = 'ttl_expired';
  } else {
    // PID liveness on local host, via the shared predicate (v0.42 #1780 Gap 3).
    // Same gate as tryAcquireDbLock's auto-takeover: same-host + provably-dead
    // (ESRCH) + age >= 60s. EPERM is treated as ALIVE (the PID exists but isn't
    // ours) — never break a live lock. host is already == localHost here (the
    // cross-host branch returned above), so classify never yields 'cross_host'.
    const liveness = classifyHolderLiveness(snap.holder_pid, snap.holder_host, snap.age_ms);
    if (liveness === 'dead_eligible') {
      safe = true;
      reason = 'pid_dead_age_60s';
    } else if (liveness === 'too_young') {
      reason = 'pid_dead_but_lock_too_young';
    } else {
      // 'alive' | 'unknown' | 'cross_host' (the latter unreachable here).
      reason = 'pid_alive';
    }
  }

  if (!safe) {
    if (opts.json) {
      console.log(JSON.stringify({
        status: 'refused', reason, lock: lockKey, source_id: sourceId, snapshot: snap,
      }));
    } else {
      console.error(`Refusing to break lock ${lockKey}: holder pid ${snap.holder_pid} appears alive on ${snap.holder_host} (age ${formatAgeHuman(snap.age_ms)}).`);
      if (reason === 'pid_dead_but_lock_too_young') {
        console.error('(PID is dead but the lock is younger than 60s — the PID may have been reused. Wait or use --force-break-lock if you are certain.)');
      } else {
        console.error('If the holder is wedged, kill it first then re-run --break-lock,');
        console.error('OR use --force-break-lock to clear regardless (the holder may still write afterwards).');
      }
    }
    return 1;
  }

  const { deleted } = await deleteLockRow(engine, lockKey, snap.holder_pid);
  if (opts.json) {
    console.log(JSON.stringify({
      status: deleted ? 'broken' : 'race_already_cleared',
      reason, lock: lockKey, source_id: sourceId, snapshot: snap,
    }));
  } else if (deleted) {
    console.log(`Broke lock ${lockKey} (was held by pid ${snap.holder_pid} on ${snap.holder_host}, age ${formatAgeHuman(snap.age_ms)}; reason: ${reason}).`);
  } else {
    console.log(`Lock ${lockKey} was already cleared by another process between our check and DELETE (race-safe).`);
  }
  return 0;
}

function formatAgeHuman(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

/**
 * v0.41.13.0 — build a SyncResult { status: 'partial' } envelope.
 *
 * D-V3-1 invariant: this is only ever called BEFORE the bookmark write at
 * sync.ts:writeSyncAnchor('last_commit'), so `last_commit` is NEVER advanced
 * on partial. The next sync re-walks last_commit..HEAD and `content_hash`
 * short-circuits already-imported files at ~10ms each. The caller's lock is
 * released by `withRefreshingLock`'s try/finally as soon as this returns.
 */
function buildPartialResult(opts: {
  fromCommit: string | null;
  toCommit: string;
  filesImported: number;
  pagesAffected: string[];
  chunksCreated: number;
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  reason: 'timeout' | 'pull_timeout' | 'pull_failed' | 'stall_timeout' | 'checkpoint_unavailable';
  bankedFiles?: number;
}): SyncResult {
  return {
    status: 'partial',
    fromCommit: opts.fromCommit,
    toCommit: opts.toCommit,
    added: opts.added,
    modified: opts.modified,
    deleted: opts.deleted,
    renamed: opts.renamed,
    chunksCreated: opts.chunksCreated,
    embedded: 0,
    pagesAffected: opts.pagesAffected,
    filesImported: opts.filesImported,
    reason: opts.reason,
    bankedFiles: opts.bankedFiles,
  };
}

async function performSyncInner(engine: BrainEngine, opts: SyncOpts): Promise<SyncResult> {
  // v0.41.8.0 (D9 / #1342): phase breadcrumbs. The #1342 reporter saw
  // ZERO stderr output before their sync hang, which made the bug
  // impossible to triage. Mirror the existing `[gbrain phase] sync.git_pull`
  // pattern at the major phase boundaries so the next #1342-shaped
  // report names WHICH phase spun. Doesn't fix #1342 but converts
  // "hung with no output" into actionable diagnostic data.
  serr(`[gbrain phase] sync.resolve_repo`);
  // Resolve repo path
  const repoPath = opts.repoPath || await readSyncAnchor(engine, opts.sourceId, 'repo_path');
  if (!repoPath) {
    const hint = opts.sourceId
      ? `Source "${opts.sourceId}" has no local_path. Run: gbrain sources add ${opts.sourceId} --path <path>`
      : `No repo path specified. Use --repo or run gbrain init with --repo first.`;
    throw new Error(hint);
  }

  // A validated preview plans from the current local Git/engine snapshot and
  // returns before every sync-domain mutator below: pack-driven import,
  // managed clone recovery, git init/pull, checkpoint cleanup, page cleanup,
  // bookmark/heartbeat/chunker writes, failure-ledger updates, extract, and
  // embed. The outer per-source lock remains intentional and is released by
  // performSync's withRefreshingLock finally.
  if (opts.dryRun) {
    const plan = await buildReadOnlySyncPlan(engine, opts, repoPath);
    serr(
      `VALIDATED INDEX PLAN: source=${plan.sourceId} ` +
      `${plan.fromCommit ?? 'none'}..${plan.targetCommit} ` +
      `strategy=${plan.strategy} affected=${plan.affected.total}`,
    );
    return syncResultFromPlan(plan);
  }

  // Paired real execution repeats target/bookmark/clean/path assertions under
  // the same source lock immediately before entering the mutating pipeline.
  if (
    opts.expectedTarget !== undefined ||
    opts.expectedBookmark !== undefined ||
    opts.requireClean === true
  ) {
    await readOnlySyncPreflight(engine, opts, repoPath);
  }

  const requestedStrategy: SyncPlanStrategy = opts.strategy ?? 'markdown';
  const priorSuccessfulStrategy = await readLastSuccessfulStrategy(
    engine,
    opts.sourceId,
  );
  const forceStrategyReconcile =
    opts.sourceId !== undefined &&
    priorSuccessfulStrategy !== requestedStrategy;
  if (forceStrategyReconcile) {
    serr(
      `[sync] strategy ownership changed ` +
      `${priorSuccessfulStrategy ?? 'unset'} -> ${requestedStrategy}; ` +
      `running a full-tree reconcile for the requested strategy while preserving ` +
      `out-of-strategy pages.`,
    );
  }

  serr(`[gbrain phase] sync.load_active_pack`);
  // v0.39 T1.5: load active pack ONCE at sync entry; pass to every per-file
  // importFile call below. Codex perf finding #7: per-file loadActivePack adds
  // disk/YAML/hash overhead × thousands of files. Best-effort: pack load
  // failure falls through to legacy inferType (parity preserved).
  let syncActivePack:
    | { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> }
    | undefined;
  if (
    opts.validatedPlan &&
    opts.validatedActivePack !== undefined
  ) {
    // Paired apply uses the exact pack object that produced plan_digest.
    // Do not reopen config after the commitment was checked.
    syncActivePack = opts.validatedActivePack ?? undefined;
  } else {
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
          markSyncMutation(opts);
          await recloneIfMissing(engine, opts.sourceId, { skipLock: true });
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
    serr(`[gbrain] auto-recovery: git-initializing brain dir ${repoPath} (no git repo found).`);
    markSyncMutation(opts);
    git(repoPath, ['init', '--quiet']);
    createSyncBaselineCommit(repoPath);
    gitContextRoot = realpathSync(discoverGitRoot(repoPath));
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
  const contentGitRoot = opts.targetTreeRoot ?? gitContextRoot;
  const contentScopeRoot = opts.targetTreeRoot
    ? resolve(opts.targetTreeRoot, syncScopeRelPath)
    : syncScopeRoot;
  if (
    opts.targetTreeRoot &&
    !isWithinRoot(contentScopeRoot, opts.targetTreeRoot)
  ) {
    throw new SyncPreconditionError(
      'plan_failed',
      'The immutable target scope escaped its private materialization root.',
      contentScopeRoot,
      opts.targetTreeRoot,
    );
  }
  const fullSyncRoots = {
    gitContextRoot,
    syncScopeRoot: contentScopeRoot,
    anchorPath,
    slugRoot: scoped ? contentGitRoot : undefined,
  };

  serr(`[gbrain phase] sync.detect_head`);
  // Detect detached HEAD up front so the working-tree fallback fires for both
  // the default sync and `--no-pull` callers. Only the actual git pull is
  // gated on opts.noPull.
  const detachedHead = isDetachedHead(gitContextRoot);
  if (detachedHead && !opts.noPull) {
    // Print the caller's repoPath spelling (not the realpathed git root) —
    // it's what the operator recognizes, and tests pin it.
    serr(`Detached HEAD on ${repoPath}; skipping git pull. Syncing from local working tree.`);
  }

  // Git pull (unless --no-pull). v0.28.1 codex finding (HIGH): the legacy
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
  const lastCommit =
    opts.full || forceStrategyReconcile
      ? null
      : await readSyncAnchor(engine, opts.sourceId, 'last_commit');

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
  if (!opts.noPull && !detachedHead && originRemotePresent) {
    const _t0 = Date.now();
    serr(`[gbrain phase] sync.git_pull start`);
    try {
      const { pullRepo } = await import('../core/git-remote.ts');
      // v0.41.13.0 (T3 / D-V4-mech-7): if the operator set --timeout,
      // bound the pull subprocess to a fraction of the remaining budget.
      // We pass a safe default (the operator's full --timeout if set, else
      // pullRepo's own 300s default). The catch below distinguishes
      // timeout (ETIMEDOUT / SIGTERM on err.cause) from ordinary pull
      // failure. Pull applies to the whole git repo (gitContextRoot), not
      // just the sync scope — git has no per-subdir pull.
      markSyncMutation(opts);
      pullRepo(gitContextRoot);
      serr(`[gbrain phase] sync.git_pull done ${Date.now() - _t0}ms`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      serr(`[gbrain phase] sync.git_pull error ${Date.now() - _t0}ms (${msg.slice(0, 80)})`);
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
        serr(`Warning: git pull failed: ${msg.slice(0, 100)}`);
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
    markSyncMutation(opts);
    createSyncBaselineCommit(gitContextRoot);
    headCommit = git(gitContextRoot, ['rev-parse', 'HEAD']);
  }

  // Capture the immutable operation/corpus evidence after any authorized pull
  // or managed-clone recovery, but before page/chunk/bookmark mutation. Paired
  // callers already supplied the exact locked plan; ordinary real syncs build
  // the same plan here so every terminal JSON receipt has concrete counts.
  if (!opts.validatedPlan) {
    opts.validatedPlan = await buildReadOnlySyncPlan(
      engine,
      { ...opts, noPull: true },
      repoPath,
    );
  }
  if (opts.validatedPlan) {
    // Planning is the authoritative pin for both ordinary and exact applies.
    // buildReadOnlySyncPlan performs its own preflight after the executor's
    // initial HEAD read; a concurrent forward commit can otherwise produce an
    // H2 manifest while execution/bookmark writes remain pinned to H1. Bind
    // execution to the validated plan and let the final drift gate decide
    // whether later live HEAD movement is safe.
    headCommit = opts.validatedPlan.targetCommit;
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
    const storedProvenanceArr = await loadOpCheckpoint(
      engine,
      ckpt.provenance,
    );
    const storedProvenance = storedProvenanceArr[0] ?? null;
    if (storedTarget) {
      if (
        opts.expectedTarget !== undefined &&
        (
          storedTarget !== headCommit ||
          storedProvenance !== SYNC_TARGET_PROVENANCE_EXACT
        )
      ) {
        slog(
          `[sync] exact-target apply supersedes ${
            storedTarget === headCommit ? 'non-exact' : 'older'
          } checkpoint ${storedTarget.slice(0, 8)}; restarting against ` +
          `captured HEAD ${headCommit.slice(0, 8)}.`,
        );
        markSyncMutation(opts);
        await clearOpCheckpoint(engine, ckpt.paths);
        await clearOpCheckpoint(engine, ckpt.target);
        await clearOpCheckpoint(engine, ckpt.provenance);
      } else {
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
          markSyncMutation(opts);
          await clearOpCheckpoint(engine, ckpt.paths);
          await clearOpCheckpoint(engine, ckpt.target);
          await clearOpCheckpoint(engine, ckpt.provenance);
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
  const detachedWorkingTreeManifest =
    detachedHead && !opts.targetTreeRoot
      ? buildDetachedWorkingTreeManifest(gitContextRoot)
      : null;
  const hasDetachedWorkingTreeChanges = detachedWorkingTreeManifest !== null &&
    (detachedWorkingTreeManifest.added.length > 0 ||
      detachedWorkingTreeManifest.modified.length > 0 ||
      detachedWorkingTreeManifest.deleted.length > 0 ||
      detachedWorkingTreeManifest.renamed.length > 0);

  if (lastCommit === headCommit && !versionMismatch && !versionNeverSet && !hasDetachedWorkingTreeChanges) {
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
    const pairedFailure = pairedFinalRepositoryFailure(
      opts,
      gitContextRoot,
      headCommit,
    );
    if (pairedFailure) {
      throw new SyncPreconditionError(
        pairedFailure.error.startsWith('working tree')
          ? 'working_tree_dirty'
          : 'target_changed',
        pairedFailure.error,
        null,
        headCommit,
      );
    }
    // v0.42.52.0 (PR #22xx): bump last_sync_at as a heartbeat on every successful
    // 0-changes sync. D4 invariant ("never advance last_commit on partial") is
    // preserved: last_sync_at is a monitoring signal (doctor sync_freshness
    // reads it), separate from the import-converged bookmark. Without this,
    // a cron-driven `*/15 sync` over a quiet vault leaves last_sync_at pinned
    // to the last real commit, so doctor falsely flags the source as stale.
    if (opts.sourceId) {
      markSyncMutation(opts);
      await engine.executeRaw(
        `UPDATE sources SET last_sync_at = now() WHERE id = $1`,
        [opts.sourceId],
      );
    }
    return {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: headCommit,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
    };
  }

  if ((versionMismatch || versionNeverSet) && lastCommit === headCommit) {
    slog(
      `[sync] chunker_version gate: stored=${storedVersion ?? 'unset'}, current=${currentVersion}. ` +
      `Forcing full re-chunk pass (git HEAD unchanged but pipeline version advanced).`,
    );
    const result = await performFullSync(engine, fullSyncRoots, headCommit, opts);
    await writeChunkerVersion(engine, opts.sourceId, currentVersion);
    return result;
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
    detachedManifest: detachedWorkingTreeManifest,
  });
  if (delta.status === 'unavailable') {
    serr(
      `[sync] delta ${lastCommit.slice(0, 8)}..${pin.slice(0, 8)} unavailable ` +
      `(${delta.reason}) — falling back to full reconcile.`,
    );
    return performFullSync(engine, fullSyncRoots, headCommit, opts);
  }
  const manifest = delta.manifest;

  // #753/#774 scope filter: git-diff paths are git-root-relative; when a
  // subpath scope is active, only paths under it participate. Back-compat:
  // syncScopeRelPath is '' when scope == root, so inScope is always true and
  // the filters below reduce to the pre-#774 behavior exactly.
  const inScope = (p: string): boolean =>
    !scoped || p === syncScopeRelPath || p.startsWith(syncScopeRelPath + '/');
  // --exclude patterns match the SCOPE-relative path (what the user of a
  // scoped source thinks in), same form runImport matches on full sync.
  const scopeRel = (p: string): string =>
    scoped && p.startsWith(syncScopeRelPath + '/') ? p.slice(syncScopeRelPath.length + 1) : p;
  const excluded = (p: string): boolean =>
    opts.exclude !== undefined && opts.exclude.length > 0 && matchesAnyGlob(scopeRel(p), opts.exclude);

  // Filter to syncable files (strategy-aware + scope-aware + exclude-aware)
  const syncOpts = opts.strategy ? { strategy: opts.strategy } : undefined;
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
      (
        !inScope(r.to) ||
        !excludedOnlyByStrategy(r.to, requestedStrategy) &&
        !['metafile', 'pruned-dir'].includes(
          unsyncableReason(r.to, syncOpts) ?? '',
        )
      ))
    .map(r => r.from);
  const filtered: SyncManifest = {
    added: manifest.added.filter(p => inScope(p) && !excluded(p) && isSyncable(p, syncOpts)),
    modified: manifest.modified.filter(p => inScope(p) && !excluded(p) && isSyncable(p, syncOpts)),
    deleted: unique([
      ...manifest.deleted.filter(p => inScope(p) && isSyncable(p, syncOpts)),
      ...renamedToUnsyncable,
    ]),
    renamed: manifest.renamed.filter(r => inScope(r.to) && !excluded(r.to) && isSyncable(r.to, syncOpts)),
  };

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
  const cleanupCandidates: string[] = [];
  for (const path of unsyncableModified) {
    // v0.41.13 #1433: never delete on metafile classification.
    // #2404 hardening: same for 'pruned-dir' — a page under a pruned
    // directory can only exist via a deliberate put_page (sync never
    // imports those paths), so "the file was modified" is not evidence
    // the page is stale. Deleting here silently destroyed put-created
    // pages every time their materialized file landed in a commit.
    const reason = unsyncableReason(path, syncOpts);
    if (
      excludedOnlyByStrategy(path, requestedStrategy) ||
      reason === 'metafile' ||
      reason === 'pruned-dir'
    ) continue;
    cleanupCandidates.push(path);
  }
  // Treat classifier cleanup as an ordinary owned delete. This routes it
  // through the same batched delete/failure gate as Git deletions, so a failed
  // cleanup cannot be swallowed before the bookmark advances and result counts
  // match the validated plan.
  filtered.deleted = unique([
    ...filtered.deleted,
    ...cleanupCandidates,
  ]);

  const plannedDeleteSlugs = new Map<string, string>();
  if (opts.validatedPlan) {
    for (const operation of opts.validatedPlan.operations) {
      if (operation.kind === 'delete') {
        plannedDeleteSlugs.set(operation.path, operation.slug);
      }
    }
    filtered.added = opts.validatedPlan.operations
      .filter((operation) => operation.kind === 'add')
      .map((operation) => operation.path);
    filtered.modified = opts.validatedPlan.operations
      .filter((operation) => operation.kind === 'modify')
      .map((operation) => operation.path);
    filtered.deleted = opts.validatedPlan.operations
      .filter((operation) => operation.kind === 'delete')
      .map((operation) => operation.path);
    filtered.renamed = opts.validatedPlan.operations
      .filter(
        (
          operation,
        ): operation is SyncPlanOperation & { fromPath: string } =>
          operation.kind === 'rename' &&
          operation.fromPath !== undefined,
      )
      .map((operation) => ({
        from: operation.fromPath,
        to: operation.path,
      }));
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
    if (totalChanges === 0) slog(`  No syncable changes.`);
    return {
      status: 'dry_run',
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
    const pairedFailure = pairedFinalRepositoryFailure(
      opts,
      gitContextRoot,
      pin,
    );
    if (pairedFailure) {
      throw new SyncPreconditionError(
        pairedFailure.error.startsWith('working tree')
          ? 'working_tree_dirty'
          : 'target_changed',
        pairedFailure.error,
        null,
        pin,
      );
    }
    // Update sync state even with no syncable changes (git advanced). v0.42.x
    // (#1794): advance to the PINNED target, and clear any checkpoint (a resume
    // whose remaining range turned out to have no syncable changes still
    // completes cleanly here).
    markSyncMutation(opts);
    await writeSyncAnchor(
      engine,
      opts.sourceId,
      'last_commit',
      pin,
      commitTimeMs(gitContextRoot, pin),
      opts.strategy ?? 'markdown',
    );
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
    await clearOpCheckpoint(engine, ckpt.paths);
    await clearOpCheckpoint(engine, ckpt.target);
    await clearOpCheckpoint(engine, ckpt.provenance);
    return {
      status: 'up_to_date',
      fromCommit: lastCommit,
      toCommit: pin,
      added: 0, modified: 0, deleted: 0, renamed: 0,
      chunksCreated: 0,
      embedded: 0,
      pagesAffected: [],
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
  // the !checkpointPersisted gate just after the partial() closure below.
  markSyncMutation(opts);
  const pinPersisted = await recordCompleted(engine, ckpt.target, [pin]);
  const provenancePersisted = pinPersisted &&
    await recordCompleted(
      engine,
      ckpt.provenance,
      [
        opts.targetTreeRoot
          ? SYNC_TARGET_PROVENANCE_EXACT
          : SYNC_TARGET_PROVENANCE_ORDINARY,
      ],
    );
  const checkpointPersisted = pinPersisted && provenancePersisted;

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
  // Assigned at registration (after the checkpointPersisted gate); called on every
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
  if (!checkpointPersisted) {
    serr('[sync] checkpoint target/provenance write failed (pool unavailable) — aborting before import; nothing drained, next run retries.');
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

  // v0.18.0+ multi-source: scope deletePage so we only delete the source-A
  // row, not every same-slug row across all sources.
  const deleteOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;

  // v0.41.19.0 (T2/D6/D7/D16/D18 via /plan-eng-review + codex outside-voice):
  // batched delete loop. Replaces the per-file N+1 that PR #1538 originally
  // batched on Postgres only. See plan file:
  //   ~/.claude/plans/system-instruction-you-are-working-ethereal-narwhal.md
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
  //   engine.resolveSlugsByPaths(batch, {sourceId})  ◀── 1 SQL round-trip
  //       │
  //       ▼
  //   slugs = batch.map(path => map.get(path)
  //                  ?? resolveSlugForPath(path))    ◀── pure-JS fallback for
  //       │                                              frontmatter-fallback
  //       ▼                                              + missing-source-path
  //   try {
  //     deleted = engine.deletePages(slugs, opts)    ◀── 1 SQL round-trip
  //     pagesAffected.push(...deleted)               ◀── D6: only confirmed
  //   } catch {                                          deletes, not phantoms
  //     // D7 decompose: per-slug deletePage,
  //     // unrecoverable failures → failedFiles
  //   }
  //
  // ROUND-TRIP COUNTS (73K deletes):
  //   pre-fix:   73,000 SELECTs + 73,000 DELETEs = 146,000 (~5 hours)
  //   post-fix:     146 SELECTs +     146 DELETEs =     292 (~2 minutes)
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

        // A validated plan already bound each path to the exact source-owned
        // slug observed during planning. Re-resolving here can lose a
        // frontmatter fallback slug on a transient query failure and delete a
        // different path-derived page. Legacy unplanned callers retain the
        // best-effort resolver fallback.
        let slugs: string[];
        if (opts.validatedPlan) {
          slugs = batch.map((path) => {
            const slug = plannedDeleteSlugs.get(path);
            if (slug === undefined) {
              throw new SyncPreconditionError(
                'plan_failed',
                `Validated delete path "${path}" has no planned slug.`,
                path,
                'one immutable delete operation with a bound slug',
              );
            }
            return slug;
          });
        } else {
          let pathSlugMap: Map<string, string>;
          try {
            pathSlugMap = await engine.resolveSlugsByPaths(
              batch,
              deleteScopedOpts,
            );
          } catch {
            // Legacy/unplanned resolution remains best-effort.
            pathSlugMap = new Map();
          }
          slugs = batch.map(
            (path) => pathSlugMap.get(path) ?? resolveSlugForPath(path),
          );
        }

        // Phase B: batch delete (1 round-trip per batch).
        try {
          const deleted = await engine.deletePages(slugs, deleteScopedOpts);
          // D6: only push slugs that were actually deleted. Filters phantom
          // slugs (paths in filtered.deleted but with no DB row) so
          // downstream extract/embed don't waste lookups.
          pagesAffected.push(...deleted);
          for (const s of deleted) deletedSlugs.add(s);
          // v0.42.x (#1794): the whole batch is handled (deleted or already
          // gone); checkpoint every path so a resume skips it.
          for (const p of batch) await markCompleted(p);
        } catch (err) {
          // D7 decompose: a transient blip on this batch shouldn't lose all
          // 500 deletes. Fall back to per-slug deletePage for THIS batch
          // only; unrecoverable per-slug failures land in failedFiles
          // (matching the existing import-loop pattern at sync.ts:~1350).
          for (let j = 0; j < slugs.length; j++) {
            try {
              await engine.deletePage(slugs[j], deleteScopedOpts);
              pagesAffected.push(slugs[j]);
              deletedSlugs.add(slugs[j]);
              await markCompleted(batch[j]);
            } catch (perSlugErr) {
              failedFiles.push({
                path: batch[j],
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
        const slug = await resolveSlugByPathOrSourcePath(engine, path, undefined);
        try {
          await engine.deletePage(slug, deleteOpts);
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

    for (const { from, to } of renamesToDo) {
      // v0.41.13.0 (T2 / D-V4-2): per-iteration abort check. Renames call
      // importFile() at line 1173-style sites which can be slow on big files;
      // refactor commits with 200+ renames must respect --timeout.
      if (opts.signal?.aborted) {
        progress.finish();
        return await partial('timeout');
      }
      const oldSlug = opts.sourceId
        ? (fromSlugByPath.get(from) ?? resolveSlugForPath(from))
        : await resolveSlugByPathOrSourcePath(engine, from, undefined);
      // The immutable plan parses frontmatter fallback slugs for paths whose
      // filename slugifies empty. Reuse that exact identity here; deriving
      // from the destination path alone would turn a valid fallback slug into
      // "" and leave source_path stale after a content-hash short circuit.
      const plannedRename = opts.validatedPlan?.operations.find(
        (operation) =>
          operation.kind === 'rename' &&
          operation.fromPath === from &&
          operation.path === to,
      );
      const newSlug =
        plannedRename?.slug ?? resolveSlugForPath(to);
      try {
        const renamedRows = await engine.updateSlug(
          oldSlug,
          newSlug,
          renameOpts,
        );
        if (
          opts.expectedPlanDigest !== undefined &&
          renamedRows !== 1
        ) {
          throw new Error(
            `source_changed: planned rename source "${from}" ` +
            `updated ${renamedRows} live rows instead of exactly one`,
          );
        }
      } catch (error) {
        if (opts.expectedPlanDigest !== undefined) {
          // Exact paired apply may not reinterpret a reviewed rename as an
          // add/upsert. A destination collision or lost source means the DB
          // pre-state changed; keep both rows and the bookmark untouched.
          failedFiles.push({
            path: to,
            error:
              `planned rename failed: ` +
              (error instanceof Error ? error.message : String(error)),
          });
          progress.tick(1, newSlug);
          continue;
        }
        // Ordinary unpaired compatibility: a missing source slug historically
        // falls through to import-as-add.
      }
      // Reimport at new path (picks up content changes). Wrapped to match the
      // deletes/adds loops: a malformed renamed file is recorded to failedFiles
      // and skipped, NOT thrown uncaught. importFile still throws on content
      // sanity-block, duplicate-slug, and missing-link endpoints; an uncaught
      // throw here crashes the whole sync mid-run and freezes the checkpoint,
      // defeating --skip-failed. A `skipped` result carrying an error is also
      // captured so the failure is recorded rather than silently dropped.
      // Paths from git diff are repository-relative. Paired execution reads
      // them from the immutable target tree; ordinary sync keeps using the
      // live repository.
      const filePath = join(contentGitRoot, to);
      const destinationExists = existsSync(filePath);
      const destinationSafe =
        destinationExists && isPathSafe(filePath, contentGitRoot);
      let renameCompleted = true;
      if (destinationSafe) {
        try {
          const result = await importFile(engine, filePath, to, { noEmbed, sourceId: opts.sourceId, activePack: syncActivePack });
          if (result.status === 'imported') chunksCreated += result.chunks;
          else if (result.status === 'skipped' && (result as { error?: string }).error) {
            failedFiles.push({ path: to, error: String((result as { error?: string }).error) });
            renameCompleted = false;
          }
        } catch (e: unknown) {
          failedFiles.push({ path: to, error: e instanceof Error ? e.message : String(e) });
          renameCompleted = false;
        }
      } else if (destinationExists) {
        failedFiles.push({
          path: to,
          error: 'rename destination resolves outside the repository',
        });
        renameCompleted = false;
      }
      if (renameCompleted && destinationSafe) {
        try {
          // A same-slug rename can content-hash short-circuit in importFile.
          // Persist the Git destination explicitly so a later full reconcile
          // does not mistake the live page's stale source_path for a deletion.
          await engine.executeRaw(
            `UPDATE pages
                SET source_path = $1
              WHERE source_id = $2 AND slug = $3`,
            [to, opts.sourceId ?? DEFAULT_SOURCE_ID, newSlug],
          );
        } catch (error) {
          failedFiles.push({
            path: to,
            error:
              `rename source_path update failed: ` +
              (error instanceof Error ? error.message : String(error)),
          });
          renameCompleted = false;
        }
      }
      pagesAffected.push(newSlug);
      deletedSlugs.delete(newSlug); // #1284: rename landed on a previously-deleted slug → embeddable again
      if (renameCompleted) await markCompleted(to);
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
    // Paths from git diff are relative to gitContextRoot; join from there.
    const syncRepoPath = contentGitRoot;
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
      if (!isPathSafe(filePath, contentGitRoot)) {
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
        const result = await observed(pacer, () =>
          importFile(eng, filePath, path, { noEmbed, sourceId: opts.sourceId, activePack: syncActivePack }));
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
        } else if (result.status === 'skipped' && (result as any).error) {
          failedFiles.push({ path, error: String((result as any).error) });
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
    if (opts.targetTreeRoot) {
      const pairedFailure = pairedFinalRepositoryFailure(
        opts,
        gitContextRoot,
        pin,
      );
      if (pairedFailure) {
        failedFiles.push(pairedFailure);
      } else {
        headVerificationSucceeded = true;
      }
    } else if (currentHead !== pin) {
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
    await writeSyncAnchor(
      engine,
      opts.sourceId,
      'last_commit',
      pin,
      commitTimeMs(gitContextRoot, pin),
      opts.strategy ?? 'markdown',
    );
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeSyncAnchor(engine, opts.sourceId, 'repo_path', anchorPath);
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
    await clearOpCheckpoint(engine, ckpt.paths);
    await clearOpCheckpoint(engine, ckpt.target);
    await clearOpCheckpoint(engine, ckpt.provenance);
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
    // An exact-target receipt is all-or-nothing. The ordinary chronic-failure
    // valve intentionally advances past unindexed files; paired apply must
    // instead remain blocked at every attempt count.
    threshold: opts.targetTreeRoot ? 0 : undefined,
    advance,
  });

  if (!gate.advanced) {
    const codeBreakdown = formatCodeBreakdown(failedFiles);
    if (gate.sentinelBlocked) {
      serr(
        `\nSync blocked: repository history changed during sync (force-push / reset).\n` +
        `${codeBreakdown}\n\n` +
        `The pinned target is no longer an ancestor of HEAD; advancing would record ` +
        `a commit that doesn't match the indexed tree. Re-run sync to re-pin against ` +
        `current HEAD.`,
      );
    } else {
      const fileFailCount = failedFiles.filter(f => isSkippablePath(f.path)).length;
      serr(
        `\nSync blocked: ${fileFailCount} file(s) failed to parse:\n` +
        `${codeBreakdown}\n\n` +
        `Fix the frontmatter and re-run, or use 'gbrain sync --skip-failed' to ` +
        `acknowledge and move on. A file that keeps failing auto-skips after ` +
        `${resolveAutoSkipThreshold()} consecutive syncs.`,
      );
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

  // Log ingest
  await engine.logIngest({
    // #3242 (attribution sub-bug): credit the sync to the source it wrote
    // to, not the shared 'default' bucket.
    ...(opts.sourceId ? { source_id: opts.sourceId } : {}),
    source_type: 'git_sync',
    source_ref: `${repoPath} @ ${headCommit.slice(0, 8)}`,
    pages_updated: pagesAffected,
    summary: `Sync: +${filtered.added.length} ~${filtered.modified.length} -${filtered.deleted.length} R${filtered.renamed.length}, ${chunksCreated} chunks, ${elapsed}ms`,
  });

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
    slog(
      `  Large sync: deferring link/timeline extraction. ` +
      `Run 'gbrain extract --stale${opts.sourceId ? ` --source-id ${opts.sourceId}` : ''}' ` +
      `(or let the autopilot cycle's extract phase sweep it).`,
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
  };
}

async function performFullSync(
  engine: BrainEngine,
  // #753/#774: the three roots resolved once at the top of performSyncInner.
  //   gitContextRoot — git repo root (git ops, slug base for scoped syncs)
  //   syncScopeRoot  — where files are walked/imported (== gitContextRoot
  //                    when no subpath scope is active)
  //   anchorPath     — what gets written back to sync.repo_path/local_path
  roots: {
    gitContextRoot: string;
    syncScopeRoot: string;
    anchorPath: string;
    slugRoot?: string;
  },
  headCommit: string,
  opts: SyncOpts,
): Promise<SyncResult> {
  const { gitContextRoot, syncScopeRoot, anchorPath } = roots;
  // Scoped sync → slugs/source_path are git-root-relative (matches the
  // incremental path's git-diff paths). Unscoped → undefined (dir-relative,
  // the pre-#774 behavior, byte-for-byte).
  const slugRoot = roots.slugRoot;
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
    let allFiles = collectSyncableFiles(syncScopeRoot, {
      strategy: opts.strategy ?? 'markdown',
      includeGitignored: opts.includeGitignored,
    });
    if (opts.exclude && opts.exclude.length > 0) {
      allFiles = allFiles.filter(abs => !matchesAnyGlob(relative(syncScopeRoot, abs), opts.exclude));
    }
    slog(
      `Full-sync dry run (strategy=${opts.strategy ?? 'markdown'}): ` +
      `${allFiles.length} file(s) would be imported ` +
      `from ${syncScopeRoot} @ ${headCommit.slice(0, 8)}.`,
    );
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
  // From this point a full reconcile can write page/chunk state, rename/delete
  // owned pages, update the failure ledger, and advance source anchors. Mark
  // conservatively before the first compound mutator so a thrown sub-step can
  // never be mislabeled as state_changed=none.
  markSyncMutation(opts);

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
  const plannedDeleteFailures: Array<{ path: string; error: string }> = [];
  const plannedRenameFailures: Array<{ path: string; error: string }> = [];
  if (opts.validatedPlan) {
    const plannedRenames = opts.validatedPlan.operations.filter(
      (
        operation,
      ): operation is SyncPlanOperation & { fromPath: string } =>
        operation.kind === 'rename' &&
        operation.fromPath !== undefined,
    );
    const sourceId = opts.sourceId ?? DEFAULT_SOURCE_ID;
    const renameRows = plannedRenames.length > 0
      ? await engine.executeRaw<PlannedExistingPage>(
          `SELECT slug, source_path, content_hash, type, frontmatter
             FROM pages
            WHERE source_id = $1 AND deleted_at IS NULL`,
          [sourceId],
        )
      : [];
    const renameSourceByPath = new Map(
      renameRows
        .map((row) => [existingPageSourcePath(row), row] as const)
        .filter(
          (
            entry,
          ): entry is readonly [string, PlannedExistingPage] =>
            entry[0] !== null,
        ),
    );
    for (const operation of plannedRenames) {
      try {
        const oldSlug =
          renameSourceByPath.get(operation.fromPath)?.slug;
        if (!oldSlug) {
          plannedRenameFailures.push({
            path: operation.path,
            error:
              `source_changed: planned rename source ` +
              `"${operation.fromPath}" no longer exists`,
          });
          continue;
        }
        if (oldSlug !== operation.slug) {
          const renamedRows = await engine.updateSlug(
            oldSlug,
            operation.slug,
            { sourceId },
          );
          if (renamedRows !== 1) {
            throw new Error(
              `source_changed: planned rename source ` +
              `"${operation.fromPath}" updated ${renamedRows} live rows ` +
              `instead of exactly one`,
            );
          }
        }
        const updated = await engine.executeRaw<{ slug: string }>(
          `UPDATE pages
              SET source_path = $1
            WHERE source_id = $2
              AND slug = $3
              AND deleted_at IS NULL
          RETURNING slug`,
          [operation.path, sourceId, operation.slug],
        );
        if (updated.length !== 1) {
          plannedRenameFailures.push({
            path: operation.path,
            error:
              `source_changed: planned rename destination ` +
              `"${operation.slug}" no longer matches one live page`,
          });
        }
      } catch (error) {
        plannedRenameFailures.push({
          path: operation.path,
          error:
            `planned rename failed: ` +
            (error instanceof Error ? error.message : String(error)),
        });
      }
    }
  }
  const _fullImportT0 = Date.now();
  serr(`[gbrain phase] sync.fullsync.import start strategy=${opts.strategy ?? 'markdown'}`);
  const result = await runImport(engine, importArgs, {
    commit: headCommit,
    strategy: opts.strategy,
    sourceId: opts.sourceId,
    exclude: opts.exclude,
    includeGitignored: opts.includeGitignored,
    slugRoot,
    ...(opts.validatedActivePack !== undefined
      ? { activePack: opts.validatedActivePack }
      : {}),
    // issue #1939: performFullSync owns the failure ledger + bookmark via the
    // shared gate below; don't let runImport double-record or write its own.
    managedBookmark: true,
  });
  serr(
    `[gbrain phase] sync.fullsync.import done ${Date.now() - _fullImportT0}ms ` +
    `imported=${result.imported} skipped=${result.skipped} errors=${result.errors}`,
  );

  let reconciledDeletes = 0;
  if (opts.validatedPlan) {
    const plannedDeletes = opts.validatedPlan.operations.filter(
      (operation) => operation.kind === 'delete',
    );
    const deleteOpts = opts.sourceId
      ? { sourceId: opts.sourceId }
      : undefined;
    for (let index = 0; index < plannedDeletes.length; index += DELETE_BATCH_SIZE) {
      const batch = plannedDeletes.slice(index, index + DELETE_BATCH_SIZE);
      if (opts.sourceId) {
        try {
          const deleted = await engine.deletePages(
            batch.map((operation) => operation.slug),
            { sourceId: opts.sourceId },
          );
          reconciledDeletes += deleted.length;
          const deletedSet = new Set(deleted);
          for (const operation of batch) {
            if (!deletedSet.has(operation.slug)) {
              plannedDeleteFailures.push({
                path: operation.path,
                error:
                  `source_changed: planned delete for "${operation.slug}" ` +
                  `was not applied because the page no longer matched the locked plan`,
              });
            }
          }
          continue;
        } catch {
          // Decompose below so every failed planned deletion is visible to the
          // shared failure gate before bookmark/strategy advancement.
        }
      }
      for (const operation of batch) {
        try {
          const existing = await engine.getPage(operation.slug, deleteOpts);
          if (existing) {
            await engine.deletePage(operation.slug, deleteOpts);
            reconciledDeletes++;
          }
        } catch (error) {
          plannedDeleteFailures.push({
            path: operation.path,
            error:
              `planned delete failed: ` +
              (error instanceof Error ? error.message : String(error)),
          });
        }
      }
    }
  }

  // #2426: every real sync now executes a validated plan, so the legacy
  // reconcile block below no longer sees ordinary full-sync DB-only pages.
  // Preserve its durability behavior by re-exporting only the plan entries
  // that were classified as never committed. Exact-target paired runs use a
  // private target tree and must not write preserved DB content into the live
  // checkout (that would dirty it after the initial clean precondition).
  if (opts.validatedPlan && !opts.targetTreeRoot && opts.sourceId) {
    const dbOnlyPreserves = opts.validatedPlan.operations.filter(
      (operation) =>
        operation.kind === 'preserve' &&
        operation.reason === 'db-only-never-committed',
    );
    if (dbOnlyPreserves.length > 0) {
      let reExported = 0;
      try {
        const { writePageThrough } = await import('../core/write-through.ts');
        for (const operation of dbOnlyPreserves) {
          const result = await writePageThrough(engine, operation.slug, {
            sourceId: opts.sourceId,
          });
          if (result.written) reExported++;
        }
      } catch {
        // Best-effort, matching the legacy reconcile path: the database row is
        // still preserved even when filesystem recovery cannot complete.
      }
      serr(
        `\n  Kept ${dbOnlyPreserves.length} page(s) whose markdown was never committed to git ` +
          `(DB-only write-through — not deleting).` +
          (reExported > 0
            ? ` Re-exported ${reExported} of them to the working tree.`
            : '') +
          `\n  Commit + push them (e.g. scripts/brain-commit-push.sh, or 'gbrain sources harden') ` +
          `so the next sync sees them as file-backed.`,
      );
    }
  }

  // issue #1939 — gate the full-sync bookmark through the SAME shared ledger as
  // the incremental path (Codex #6: a wedge here on first/forced sync was
  // previously unreachable by the valve). A full re-import is authoritative for
  // the whole tree, so any previously-tracked failing path that ISN'T failing
  // now has been resolved → clear it (resets its auto-skip streak); current
  // failures still climb their attempts.
  const fullSourceId = opts.sourceId ?? DEFAULT_SOURCE_ID;
  const fullFailures = [
    ...result.failures,
    ...plannedRenameFailures,
    ...plannedDeleteFailures,
  ];
  const pairedFailure = pairedFinalRepositoryFailure(
    opts,
    gitContextRoot,
    headCommit,
  );
  if (pairedFailure) {
    fullFailures.push(pairedFailure);
  }
  const fullFailureSet = new Set(fullFailures.map(f => f.path));
  const fullSucceeded = loadSyncFailures()
    .filter(e => e.source_id === fullSourceId && isSkippablePath(e.path) && !fullFailureSet.has(e.path))
    .map(e => e.path);
  const advanceFull = async (): Promise<void> => {
    // Persist sync state so the next sync is incremental. Routed through
    // writeSyncAnchor so --source pins the right sources row.
    await writeSyncAnchor(
      engine,
      opts.sourceId,
      'last_commit',
      headCommit,
      // Full/first exact-target syncs can finish while the live branch moves.
      // Stamp the immutable target's own time, not whichever commit happens to
      // be live after the final drift check.
      commitTimeMs(gitContextRoot, headCommit),
      opts.strategy ?? 'markdown',
    );
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeSyncAnchor(engine, opts.sourceId, 'repo_path', anchorPath);
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
  };

  const fullGate = await applySyncFailureGate({
    sourceId: fullSourceId,
    failedFiles: fullFailures,
    succeededPaths: fullSucceeded,
    commit: headCommit,
    skipFailed: opts.skipFailed === true,
    threshold: opts.targetTreeRoot ? 0 : undefined,
    advance: advanceFull,
  });

  if (!fullGate.advanced) {
    const codeBreakdown = formatCodeBreakdown(fullFailures);
    if (fullGate.sentinelBlocked) {
      serr(`\nFull sync blocked: repository history changed during sync.\n${codeBreakdown}`);
    } else {
      const fileFailCount = fullFailures.filter(f => isSkippablePath(f.path)).length;
      serr(
        `\nFull sync blocked: ${fileFailCount} file(s) failed:\n` +
        `${codeBreakdown}\n\n` +
        `Fix the YAML in those files and re-run, or use '--skip-failed'. A file ` +
        `that keeps failing auto-skips after ${resolveAutoSkipThreshold()} consecutive syncs.`,
      );
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
      failedFiles: fullFailures.length,
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
  if (!opts.validatedPlan && opts.sourceId) {
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
    const currentFiles = collectSyncableFiles(syncScopeRoot, {
      strategy: opts.strategy ?? 'markdown',
      includeGitignored: opts.includeGitignored,
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
    const plan = planReconcileDeletes(
      rows,
      currentFiles,
      p => (scopePrefix === '' || p.startsWith(scopePrefix)) && isSyncable(p, reconcileSyncOpts),
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
      for (let i = 0; i < deletableSlugs.length; i += DELETE_BATCH_SIZE) {
        const batch = deletableSlugs.slice(i, i + DELETE_BATCH_SIZE);
        try {
          const deleted = await engine.deletePages(batch, deleteScopedOpts);
          reconciledDeletes += deleted.length;
        } catch {
          // Per-slug fallback on a batch blip (mirrors the incremental delete
          // loop). A stale page that won't delete is best-effort, not fatal.
          for (const slug of batch) {
            try { await engine.deletePage(slug, deleteScopedOpts); reconciledDeletes++; }
            catch { /* best-effort */ }
          }
        }
      }
      if (reconciledDeletes > 0) {
        slog(`  Reconciled ${reconciledDeletes} stale page(s) whose source file was removed.`);
      }
    }
  }

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
  };
}

/**
 * #2828 full-sync reconcile safety-valve thresholds. A reconcile that would
 * delete more than MASS_RECONCILE_RATIO of the file-backed pages a strategy
 * manages, on a source that holds more than MASS_RECONCILE_MIN_PAGES of them, is
 * treated as a suspected path-comparison bug rather than a real bulk deletion.
 */
export const MASS_RECONCILE_RATIO = 0.5;
export const MASS_RECONCILE_MIN_PAGES = 20;

/**
 * Normalize path separators so a page whose stored `source_path` was written
 * with a different separator than the local OS's `path.relative` produces (e.g.
 * git-derived forward-slash paths on a Windows checkout) still compares equal.
 * Without this, on Windows every file-backed page looks stale and the reconcile
 * wrongly deletes the whole source (#2828).
 */
function normalizeReconcilePath(p: string): string {
  return p.replace(/\\/g, '/');
}

export interface ReconcilePlan {
  /** Slugs whose backing file is genuinely gone; safe to reconcile-delete. */
  staleSlugs: string[];
  /**
   * File-backed, in-strategy pages the reconcile can act on. This is the
   * denominator for the mass-delete valve (the exact population at risk).
   */
  reconcilableCount: number;
  /**
   * True when `staleSlugs` would sweep more than MASS_RECONCILE_RATIO of
   * `reconcilableCount`, on a source with more than MASS_RECONCILE_MIN_PAGES of
   * them — the mass-delete signal that trips the safety valve.
   */
  massDelete: boolean;
}

/**
 * #2828: decide which file-backed pages a full-sync reconcile should delete, and
 * whether that deletion is suspiciously large. Pure and exported so both the
 * separator normalization and the mass-delete valve are unit-testable without a
 * live engine or a Windows host.
 *
 * @param rows           pages with a non-null `source_path` (deleted_at IS NULL).
 * @param currentFiles   repo-relative paths present in the working tree.
 * @param isSyncablePath predicate excluding metafiles and the wrong strategy.
 */
export function planReconcileDeletes(
  rows: ReadonlyArray<{ slug: string; source_path: string | null }>,
  currentFiles: Iterable<string>,
  isSyncablePath: (p: string) => boolean,
): ReconcilePlan {
  const current = new Set<string>();
  for (const f of currentFiles) current.add(normalizeReconcilePath(f));
  const reconcilable = rows.filter(
    r => r.source_path != null && isSyncablePath(r.source_path),
  );
  const staleSlugs = reconcilable
    .filter(r => !current.has(normalizeReconcilePath(r.source_path as string)))
    .map(r => r.slug);
  const massDelete =
    reconcilable.length > MASS_RECONCILE_MIN_PAGES &&
    staleSlugs.length > reconcilable.length * MASS_RECONCILE_RATIO;
  return { staleSlugs, reconcilableCount: reconcilable.length, massDelete };
}

/**
 * #2426: every repo-relative path that ever appeared as an ADD in git history
 * (rename detection off, so a `git mv` destination still counts as an add).
 * Used by the full-sync reconcile to distinguish "file was committed and later
 * deleted" (genuine delete → reconcile) from "file was NEVER committed"
 * (DB-only write-through → preserve). Returns null when `repoPath` isn't a git
 * work tree or git is unavailable — callers keep the plain-directory behavior.
 * Forward-slash-normalized to match `normalizeReconcilePath` membership tests.
 */
export function listEverCommittedPaths(
  repoPath: string,
  targetCommit?: string,
): Set<string> | null {
  let stdout: string;
  try {
    const revision = targetCommit ?? '--all';
    stdout = execFileSync(
      'git',
      ['-C', repoPath, '-c', 'core.quotepath=off', 'log', revision, '--no-renames',
        '--diff-filter=A', '--format=', '--name-only'],
      { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return null;
  }
  const set = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (line) set.add(line.replace(/\\/g, '/'));
  }
  return set;
}

/**
 * #2828 escape hatch: `GBRAIN_ALLOW_MASS_RECONCILE=1` restores the pre-valve
 * behavior for the rare intentional bulk removal. Env-only (an incident-time
 * override), mirroring `resolveStallAbortSeconds`' pure, env-parameterized shape.
 */
export function massReconcileAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.GBRAIN_ALLOW_MASS_RECONCILE === '1';
}

/**
 * Grace window (seconds) between the watchdog's SIGTERM and SIGKILL. SIGTERM
 * gives a responsive loop a clean shutdown; SIGKILL is the starvation backstop.
 */
export const HARD_DEADLINE_GRACE_SEC = 30;

export interface HardDeadlineResolution {
  deadlineMs: number;
  graceMs: number;
  /** Where the deadline came from (for the armed-log line + tests). */
  reason: string;
}

/**
 * #1950: default no-import-progress window before the in-band stall watchdog
 * aborts the drain. Generous on purpose — it must clear one legitimately large
 * file (cross-region, big page) without false-tripping; one file taking longer
 * than this trips it (documented limit). Distinct from the wall-clock hard
 * deadline (whole-run cap) and the lock heartbeat (refreshes regardless of
 * import progress). Env-tunable; <=0 disables.
 */
export const DEFAULT_SYNC_STALL_ABORT_SEC = 900;

export function resolveStallAbortSeconds(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.GBRAIN_SYNC_STALL_ABORT_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_SYNC_STALL_ABORT_SEC;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SYNC_STALL_ABORT_SEC;
  return n; // n <= 0 disables the watchdog
}

/**
 * Resolve the out-of-band hard-deadline for a `gbrain sync` invocation (#1633).
 * Pure + argv/env-only so it runs BEFORE `connectEngine` (so a connect-phase hang
 * is also bounded — `timeout-layer-vs-connectengine` learning). DB-plane config
 * (`gbrain config set`) is unreadable pre-connect, so the operator knob is the
 * `GBRAIN_SYNC_MAX_RUNTIME_SECONDS` env var; bare cron is covered by the non-TTY
 * default. Returns null when no watchdog should arm (TTY interactive with no
 * flag, or an explicit opt-out / 0).
 *
 * Precedence: --no-hard-deadline > --hard-deadline > --timeout(non-all) > env >
 * non-TTY default (3600s) > none.
 */
export function resolveSyncHardDeadline(
  args: string[],
  opts: { isTty: boolean; env?: Record<string, string | undefined>; defaultNonTtySec?: number },
): HardDeadlineResolution | null {
  const env = opts.env ?? {};
  const graceMs = HARD_DEADLINE_GRACE_SEC * 1000;
  const mk = (sec: number, reason: string): HardDeadlineResolution | null =>
    sec > 0 ? { deadlineMs: sec * 1000, graceMs, reason } : null;

  if (args.includes('--no-hard-deadline')) return null;

  const hardStr = args.find((a, i) => args[i - 1] === '--hard-deadline');
  if (hardStr !== undefined) {
    // Throws on a bad value (cli.ts surfaces it + exits 1) — same posture as --timeout.
    const sec = parseDurationSeconds(hardStr, '--hard-deadline');
    return mk(sec ?? 0, 'flag:--hard-deadline');
  }

  // --timeout auto-arms a hard backstop at timeout(+grace), but ONLY single-source.
  // For --all, per-source budgets don't collapse to one wall-clock; fall through.
  const isAll = args.includes('--all');
  const timeoutStr = args.find((a, i) => args[i - 1] === '--timeout');
  if (timeoutStr !== undefined && !isAll) {
    const sec = parseDurationSeconds(timeoutStr, '--timeout');
    if (sec && sec > 0) return mk(sec, 'flag:--timeout');
  }

  const envRaw = env.GBRAIN_SYNC_MAX_RUNTIME_SECONDS;
  if (envRaw !== undefined && envRaw !== '') {
    const n = Number(envRaw);
    if (Number.isFinite(n)) return mk(n, 'env:GBRAIN_SYNC_MAX_RUNTIME_SECONDS'); // n<=0 disables
  }

  if (!opts.isTty) return mk(opts.defaultNonTtySec ?? 3600, 'default:non-tty');

  return null;
}

/**
 * Compose 1..N AbortSignals into one (CQ2). Undefined inputs are dropped; the
 * result aborts when ANY input aborts. Returns a single signal directly (no
 * wrapper), `undefined` when nothing is set. Used at both performSync call sites
 * so the SIGINT graceful-cancel signal and the per-source `--timeout` signal
 * compose without duplicating `AbortSignal.any` logic.
 */
export function composeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => s !== undefined);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  return AbortSignal.any(live);
}

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

const SYNC_BOOLEAN_FLAGS = new Set([
  '--all',
  '--break-lock',
  '--dry-run',
  '--force-break-lock',
  '--full',
  '--help',
  '--include-gitignored',
  '--json',
  '--no-auto-embed',
  '--no-embed',
  '--no-extract',
  '--no-hard-deadline',
  '--no-pull',
  '--no-schema-pack',
  '--require-clean',
  '--retry-failed',
  '--serial',
  '--skip-failed',
  '--watch',
  '--yes',
  '-h',
]);

const SYNC_VALUE_FLAGS = new Set([
  '--concurrency',
  '--expected-bookmark',
  '--expected-plan-digest',
  '--expected-target',
  '--hard-deadline',
  '--interval',
  '--max-age',
  '--max-sources',
  '--missing-path',
  '--parallel',
  '--repo',
  '--source',
  '--src-subpath',
  '--strategy',
  '--timeout',
  '--workers',
]);

function validateSyncCliArgs(args: string[]): string | null {
  const counts = new Map<string, number>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--exclude') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return '--exclude requires one glob value.';
      }
      index++;
      continue;
    }
    if (SYNC_VALUE_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return `${arg} requires exactly one value.`;
      }
      counts.set(arg, (counts.get(arg) ?? 0) + 1);
      index++;
      continue;
    }
    if (SYNC_BOOLEAN_FLAGS.has(arg)) {
      counts.set(arg, (counts.get(arg) ?? 0) + 1);
      continue;
    }
    return `Unknown sync argument: ${arg}`;
  }

  for (const [flag, count] of counts) {
    if (count > 1) return `${flag} may be specified only once.`;
  }
  if (
    (counts.get('--concurrency') ?? 0) +
      (counts.get('--workers') ?? 0) >
    1
  ) {
    return '--concurrency and --workers are aliases; specify only one.';
  }
  const strategyIndex = args.indexOf('--strategy');
  if (
    strategyIndex >= 0 &&
    !['markdown', 'code', 'auto'].includes(args[strategyIndex + 1] ?? '')
  ) {
    return '--strategy must be markdown, code, or auto.';
  }
  const sourceIndex = args.indexOf('--source');
  if (
    sourceIndex >= 0 &&
    !/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(
      args[sourceIndex + 1] ?? '',
    )
  ) {
    return '--source must be a canonical 1-32 character source id.';
  }
  return null;
}

function exitSyncCliError(
  jsonOut: boolean,
  error: SyncPreconditionError,
  exitCode = 1,
): never {
  if (jsonOut) {
    process.stdout.write(
      JSON.stringify(buildGBrainSyncErrorEnvelope(error)) + '\n',
    );
  } else {
    console.error(`ERROR [${error.reasonCode}] ${error.message}`);
  }
  process.exit(exitCode);
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
  if (
    args.includes('--json') &&
    (args.includes('--help') || args.includes('-h'))
  ) {
    exitSyncCliError(
      true,
      new SyncPreconditionError(
        'plan_failed',
        '--json cannot be combined with help output.',
        '--json --help',
        'either --help or one executable JSON sync invocation',
      ),
    );
  }
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
  --include-gitignored Include otherwise-syncable files matched by .gitignore.
                       Forces a full filesystem walk so periodic syncs see
                       ignored untracked content.
  --dry-run            Build a validated local index plan. No pull, clone,
                       git init, checkpoint/failure change, content write,
                       bookmark, heartbeat, chunker, extract, or embed occurs;
                       the transient per-source DB lock is still used.
  --expected-target S  Refuse unless Git HEAD is the full 40-character SHA S.
  --expected-bookmark B
                       Refuse unless the source bookmark is SHA B, or absent
                       when B is "none".
  --expected-plan-digest D
                       Apply only the exact immutable plan committed by a
                       preview's 64-character lowercase plan_digest.
  --require-clean      Refuse unless tracked and untracked working-tree state
                       is clean. Rechecked under the source lock.
  --skip-failed        Acknowledge previously-recorded sync failures so
                       the bookmark can advance past unparseable files.
  --retry-failed       Re-attempt previously-failed files; clear on success.
  --watch              Re-sync continuously on an interval.
  --interval N         Watch-mode interval in seconds (default 60).
  --no-pull            Skip 'git pull' before the sync (useful for tests).
  --no-schema-pack     Skip loading the active schema pack (no per-file pack
                       regex runs; pages use legacy prefix typing). Escape
                       hatch if a suspect pack regex is wedging sync.
                       PGLite is single-writer: stop 'gbrain serve' before a
                       large sync (see docs/architecture/serve-sync-concurrency.md).
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
  --json               Emit exactly one schema-1 JSON document on stdout.
                       Single-source results use result_kind=gbrain_sync;
                       refusals use result_kind=gbrain_sync_error. --all
                       retains its aggregate sources/parallel envelope. Sources
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

  const jsonOut = args.includes('--json');
  const cliProblem = validateSyncCliArgs(args);
  if (cliProblem !== null) {
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        cliProblem,
        args.join(' '),
        'one unambiguous supported sync invocation',
      ),
    );
  }
  if (jsonOut && args.includes('--watch')) {
    exitSyncCliError(
      true,
      new SyncPreconditionError(
        'plan_failed',
        '--json cannot be combined with --watch because a watch has no single terminal receipt.',
        '--json --watch',
        'one non-watch sync invocation',
      ),
    );
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
  const syncAll = args.includes('--all');
  const mutationJournal = createSyncMutationJournal();
  let missingPathMode: MissingPathMode = 'fail';
  try {
    missingPathMode = parseMissingPathMode(args);
  } catch (e) {
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        e instanceof Error ? e.message : String(e),
        args[args.indexOf('--missing-path') + 1] ?? null,
        'fail or skip',
      ),
      2,
    );
  }
  if (missingPathMode !== 'fail' && !syncAll) {
    // Single-source sync on a missing path should stay loud — an explicit
    // `--source X` naming an absent checkout is an operator error, not a
    // multi-machine artifact. Warn instead of silently ignoring the flag.
    console.error('[gbrain] WARN: --missing-path only applies to `sync --all`; ignored here.');
  }
  const yesFlag = args.includes('--yes');
  // v0.41.6.0 D3: lock-recovery flags. --break-lock (safe) verifies the
  // holder is local-host + (TTL-expired OR PID-dead+60s-old) before
  // deleting the row. --force-break-lock skips the liveness check. Both
  // are refused when combined with --all (per-source invocation required;
  // v0.40 lock keys are gbrain-sync:<sourceId>).
  const breakLock = args.includes('--break-lock');
  const forceBreakLock = args.includes('--force-break-lock');
  const expectedTargetPositions = args
    .map((value, index) => value === '--expected-target' ? index : -1)
    .filter((index) => index >= 0);
  const expectedBookmarkPositions = args
    .map((value, index) => value === '--expected-bookmark' ? index : -1)
    .filter((index) => index >= 0);
  const expectedPlanDigestPositions = args
    .map((value, index) => value === '--expected-plan-digest' ? index : -1)
    .filter((index) => index >= 0);
  const expectedTargetCandidate =
    expectedTargetPositions.length === 1
      ? args[expectedTargetPositions[0] + 1]
      : undefined;
  const expectedBookmarkCandidate =
    expectedBookmarkPositions.length === 1
      ? args[expectedBookmarkPositions[0] + 1]
      : undefined;
  const expectedPlanDigestCandidate =
    expectedPlanDigestPositions.length === 1
      ? args[expectedPlanDigestPositions[0] + 1]
      : undefined;
  const expectedTargetRaw =
    expectedTargetCandidate?.startsWith('--') === false
      ? expectedTargetCandidate
      : undefined;
  const expectedBookmarkRaw =
    expectedBookmarkCandidate?.startsWith('--') === false
      ? expectedBookmarkCandidate
      : undefined;
  const expectedPlanDigestRaw =
    expectedPlanDigestCandidate?.startsWith('--') === false
      ? expectedPlanDigestCandidate
      : undefined;
  const requireClean = args.includes('--require-clean');
  const pairedCli =
    expectedTargetRaw !== undefined ||
    expectedBookmarkRaw !== undefined ||
    expectedPlanDigestRaw !== undefined ||
    requireClean;

  const invalidExpectedTarget =
    expectedTargetPositions.length > 0 &&
    (
      expectedTargetPositions.length !== 1 ||
      expectedTargetRaw === undefined ||
      !/^[0-9a-f]{40}$/i.test(expectedTargetRaw)
    );
  const invalidExpectedBookmark =
    expectedBookmarkPositions.length > 0 &&
    (
      expectedBookmarkPositions.length !== 1 ||
      expectedBookmarkRaw === undefined ||
      (
        expectedBookmarkRaw !== 'none' &&
        !/^[0-9a-f]{40}$/i.test(expectedBookmarkRaw)
      )
    );
  const invalidExpectedPlanDigest =
    expectedPlanDigestPositions.length > 0 &&
    (
      expectedPlanDigestPositions.length !== 1 ||
      expectedPlanDigestRaw === undefined ||
      !/^[0-9a-f]{64}$/.test(expectedPlanDigestRaw)
    );
  if (
    invalidExpectedTarget ||
    invalidExpectedBookmark ||
    invalidExpectedPlanDigest
  ) {
    const error = new SyncPreconditionError(
      'plan_failed',
      invalidExpectedTarget
        ? '--expected-target must be a full 40-character Git SHA.'
        : invalidExpectedBookmark
          ? '--expected-bookmark must be a full 40-character Git SHA or "none".'
          : '--expected-plan-digest must be a lowercase 64-character SHA-256 digest.',
      invalidExpectedTarget
        ? (
            expectedTargetPositions.length > 1
              ? '<duplicate>'
              : expectedTargetRaw ?? '<missing>'
          )
        : invalidExpectedBookmark
          ? (
              expectedBookmarkPositions.length > 1
                ? '<duplicate>'
                : expectedBookmarkRaw ?? '<missing>'
            )
          : (
              expectedPlanDigestPositions.length > 1
                ? '<duplicate>'
                : expectedPlanDigestRaw ?? '<missing>'
            ),
      invalidExpectedTarget
        ? '<40-char-sha>'
        : invalidExpectedBookmark
          ? '<40-char-sha|none>'
          : '<64-char-lowercase-sha256>',
    );
    if (jsonOut) console.log(JSON.stringify(buildGBrainSyncErrorEnvelope(error)));
    else console.error(`ERROR [${error.reasonCode}] ${error.message}`);
    process.exit(1);
  }

  if (pairedCli && !dryRun && expectedPlanDigestRaw === undefined) {
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        'Paired exact-target apply requires --expected-plan-digest from the reviewed dry-run receipt.',
        '<missing>',
        '--expected-plan-digest <preview.plan_digest>',
      ),
    );
  }

  if (pairedCli && skipFailed) {
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        'Paired exact-target apply cannot acknowledge failed files because its receipt must describe complete target convergence.',
        '--skip-failed',
        'fix every planned file failure and retry the same target',
      ),
    );
  }

  const dryRunModifierConflicts = dryRun
    ? [
        ...(breakLock ? ['--break-lock'] : []),
        ...(forceBreakLock ? ['--force-break-lock'] : []),
        ...(skipFailed ? ['--skip-failed'] : []),
        ...(retryFailed ? ['--retry-failed'] : []),
      ]
    : [];
  if (dryRunModifierConflicts.length > 0) {
    const error = new SyncPreconditionError(
      'dry_run_modifier_conflict',
      `Dry-run cannot be combined with mutating maintenance flags: ` +
        dryRunModifierConflicts.join(', '),
      dryRunModifierConflicts.join(','),
      'run preview and maintenance as separate commands',
    );
    if (jsonOut) console.log(JSON.stringify(buildGBrainSyncErrorEnvelope(error)));
    else console.error(`ERROR [${error.reasonCode}] ${error.message}`);
    process.exit(1);
  }
  if (
    syncAll &&
    (
      expectedTargetRaw !== undefined ||
      expectedBookmarkRaw !== undefined ||
      expectedTargetPositions.length > 0 ||
      expectedBookmarkPositions.length > 0 ||
      expectedPlanDigestPositions.length > 0 ||
      requireClean
    )
  ) {
    const error = new SyncPreconditionError(
      'plan_failed',
      'Expected target/bookmark/plan/clean preconditions require one explicit source.',
      '--all',
      '--source <id>',
    );
    if (jsonOut) console.log(JSON.stringify(buildGBrainSyncErrorEnvelope(error)));
    else console.error(`ERROR [${error.reasonCode}] ${error.message}`);
    process.exit(1);
  }

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
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        e instanceof Error ? e.message : String(e),
        maxAgeStr ?? null,
        'a positive duration',
      ),
    );
  }
  if (maxAgeSeconds !== undefined && !breakLock) {
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        '--max-age is only valid with --break-lock.',
        '--max-age',
        '--break-lock --max-age <duration>',
      ),
    );
  }
  if (maxAgeSeconds !== undefined && forceBreakLock) {
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        '--max-age cannot be combined with --force-break-lock.',
        '--force-break-lock --max-age',
        '--break-lock --max-age <duration>',
      ),
    );
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
    const sourceId = sourceArg ?? 'default';
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
          const error = new SyncPreconditionError(
            'embedding_credentials_missing',
            e.userMessage,
            null,
            'configured embedding provider credentials or --no-embed',
          );
          process.stdout.write(
            JSON.stringify(buildGBrainSyncErrorEnvelope(error)) + '\n',
          );
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
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        `Invalid --max-sources value: "${maxSourcesStr}". Must be a positive integer.`,
        maxSourcesStr,
        'a positive integer',
      ),
    );
  }
  const strategyArg = args.find((a, i) => args[i - 1] === '--strategy') as SyncOpts['strategy'] | undefined;
  // #753/#774: monorepo subdir-source flags. --exclude is repeatable.
  const srcSubpath = args.find((a, i) => args[i - 1] === '--src-subpath') || undefined;
  const excludePatterns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--exclude' && i + 1 < args.length) excludePatterns.push(args[i + 1]);
  }
  if (syncAll && (srcSubpath || excludePatterns.length > 0)) {
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        `--src-subpath/--exclude scope a single sync invocation; they cannot be combined with --all. ` +
          `For --all runs, register the subdirectory as the source's local_path instead.`,
        '--all with single-source scope flags',
        'one explicit source',
      ),
    );
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
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        e instanceof Error ? e.message : String(e),
        concurrencyStr ?? null,
        'a positive worker count',
      ),
    );
  }
  try {
    parallelOverride = parseWorkers(parallelStr);
  } catch (e) {
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        e instanceof Error ? e.message : String(e),
        parallelStr ?? null,
        'a positive parallel source count',
      ),
    );
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
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        e instanceof Error ? e.message : String(e),
        timeoutStr ?? null,
        'a positive duration',
      ),
    );
  }
  const explicitSourceArg = args.find((a, i) => args[i - 1] === '--source');
  if (timeoutSeconds !== undefined && !syncAll && !explicitSourceArg) {
    exitSyncCliError(
      jsonOut,
      new SyncPreconditionError(
        'plan_failed',
        '--timeout requires either --source <id> or --all to scope the per-source budget.',
        '--timeout without source scope',
        '--source <id> or --all',
      ),
    );
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
  const { resolveSourceWithTier, formatSoleNonDefaultNudge } = await import('../core/source-resolver.ts');
  let resolved;
  try {
    resolved = await resolveSourceWithTier(engine, explicitSource);
  } catch (cause) {
    const error = new SyncPreconditionError(
      'source_changed',
      cause instanceof Error ? cause.message : String(cause),
      explicitSource,
      'one currently registered source id',
    );
    if (jsonOut) exitSyncCliError(true, error);
    throw error;
  }
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
    if (acked.count > 0) {
      mutationJournal.stateChanged = 'partial';
      const line = `Acknowledged ${acked.count} pre-existing failure(s).`;
      if (jsonOut) process.stderr.write(line + '\n');
      else console.log(line);
    }
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
    const sources = await engine.executeRaw<{ id: string; name: string; local_path: string | null; config: Record<string, unknown>; last_commit: string | null; chunker_version: string | null }>(
      `SELECT id, name, local_path, config, last_commit, chunker_version FROM sources WHERE local_path IS NOT NULL`,
    );
    if (!sources || sources.length === 0) {
      if (jsonOut) {
        process.stdout.write(JSON.stringify({
          schema_version: 1,
          sources: [],
          parallel: 0,
          ok_count: 0,
          error_count: 0,
          skipped_count: 0,
        }) + '\n');
      } else {
        console.log('No sources with local_path configured. Use `gbrain sources add <id> --path <path>` first.');
      }
      return;
    }

    // v0.41.31 — mode-aware cost gate. Resolve federated_v2 ONCE here so both
    // the gate (below) and the fan-out (further down) share it.
    const { isFederatedV2Enabled } = await import('../core/feature-flags.ts');
    const v2Enabled = await isFederatedV2Enabled(engine);

    // v0.42.42.0 (#2139) cost gate — shared `runInlineCostGate`. Under
    // federated_v2 + parallel, embedding is DEFERRED to per-source backfill
    // jobs (own spend cap) so the gate is FYI-only. Inline mode (v2 off, or
    // --serial without --no-embed) gates on the DELTA estimate: below floor
    // proceeds; above floor in a non-TTY/--json session AUTO-DEFERS embeds
    // (exit 0, never exit 2 — the wedged-cron fix); a TTY prompts. Skipped
    // entirely when --no-embed is set.
    let autoDeferEmbeds = false;
    let aggregateCostGate: CostGateReceipt | undefined;
    if (!noEmbed && !dryRun) {
      const mode = willEmbedSynchronously({ v2Enabled, serialFlag, noEmbed });
      const runGate = () => runInlineCostGate(engine, {
        sources, mode, dryRun: false, jsonOut, yesFlag, full, includeGitignored, label: 'sync --all',
      });
      const gate = jsonOut
        ? await withConsoleLogOnStderr(runGate)
        : await runGate();
      if (gate.action === 'stop') return;
      autoDeferEmbeds = gate.autoDeferEmbeds;
      aggregateCostGate = gate.receipt;
    }

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
          ...(aggregateCostGate ? { cost_gate: aggregateCostGate } : {}),
        }));
      }
      return;
    }

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
      // D18: parallel path defers embed; auto-enqueue embed-backfill after.
      // v0.42.42.0 (#2139): `autoDeferEmbeds` (the inline gate tripped in a
      // non-TTY session) ALSO forces deferral — global by design (the gate's
      // decision unit is the aggregate estimate; deferral strictly dominates
      // the exit-2 it replaced for every source).
      const effectiveNoEmbed =
        (v2Enabled && !serialFlag && !noEmbed ? true : noEmbed) || autoDeferEmbeds;
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
        repoPath: src.local_path!,
        dryRun, full, noPull,
        noEmbed: effectiveNoEmbed,
        noExtract,
        skipFailed, retryFailed, noSchemaPack,
        includeGitignored,
        sourceId: src.id,
        strategy: cfg.strategy,
        concurrency,
        signal: composeAbortSignals(allInterrupt.signal, controller?.signal),
      };
      // v0.40.6.0 (D6): human output uses withSourcePrefix so every slog /
      // serr line emitted from inside the sync code path gets prefixed with
      // `[<source-id>] `. JSON mode instead routes the whole fan-out's
      // console output to stderr below, keeping stdout to one aggregate
      // document without nesting concurrent global console swaps.
      //
      // v0.41.13.0 (T6): wrap the performSync call in try/finally so the
      // per-source timer is always cleared, even on throw.
      let result: SyncResult;
      try {
        const performOne = () => performSync(engine, repoOpts);
        result = jsonOut
          ? await performOne()
          : await withSourcePrefix(src.id, performOne);
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
      // D18: auto-enqueue embed-backfill per source (unless opted out).
      // v0.41.13.0 (T7 / D-V3-5): partial excluded — the next clean sync
      // re-walks the diff and re-decides whether to enqueue embed for
      // pages whose content actually changed.
      // v0.42.42.0 (#2139): `autoDeferEmbeds` enqueues even on the v2-OFF
      // legacy path — otherwise the gate's auto-defer would strand
      // NULL-embedded chunks with no queued job to embed them.
      if (
        (v2Enabled || autoDeferEmbeds) &&
        !noAutoEmbed &&
        !dryRun &&
        result.status !== 'dry_run' &&
        result.status !== 'up_to_date' &&
        result.status !== 'partial'
      ) {
        try {
          const { submitEmbedBackfill } = await import('../core/embed-backfill-submit.ts');
          const sub = await submitEmbedBackfill(engine, src.id, { reason: 'sync_all' });
          if (sub.status === 'submitted') {
            writeHuman(`  → embed-backfill job ${sub.jobId} queued for ${src.name}`);
          } else if (sub.status === 'cooldown') {
            writeHuman(`  → embed-backfill skipped (cooldown) for ${src.name}`);
          } else if (sub.status === 'spend_capped') {
            writeHuman(`  → embed-backfill skipped (24h spend cap $${sub.spendCapUsd}) for ${src.name}`);
          }
        } catch (e) {
          process.stderr.write(`  → embed-backfill submission failed for ${src.name}: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
      return result;
    };

    const parallelEligible =
      v2Enabled && !serialFlag && engine.kind !== 'pglite' && runnableSources.length > 1;

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
    const effectiveParallel = parallelEligible
      ? Math.min(runnableSources.length, maxSources ?? 8)
      : 1;

    const runFanout = async (): Promise<void> => {
      process.on('SIGINT', onAllSigint);
      try {
        if (parallelEligible) {
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
    };
    if (jsonOut) {
      await withConsoleLogOnStderr(runFanout);
    } else {
      await runFanout();
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
          } : {}),
          ...(r.error ? { error: r.error } : {}),
        }));
      console.log(JSON.stringify({
        schema_version: 1,
        sources: sortedSources,
        parallel: effectiveParallel,
        ok_count: okCount,
        error_count: errCount,
        skipped_count: perSourceResults.filter((r) => r.status === 'skipped_missing_path').length,
        ...(aggregateCostGate ? { cost_gate: aggregateCostGate } : {}),
      }));
    }

    // v0.42.7 (#1696): brain-wide extraction-lag nudge after the --all wave.
    // Best-effort, stderr-only; skipped on dry-run.
    if (!dryRun) await maybeExtractionNudge(engine);

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
    repoPath,
    dryRun,
    full,
    noPull,
    noEmbed: noEmbed || pairedCli,
    noExtract: noExtract || pairedCli,
    skipFailed,
    retryFailed,
    noSchemaPack,
    includeGitignored,
    sourceId,
    strategy: strategyArg, concurrency,
    schema1Receipt: jsonOut,
    ...(expectedTargetRaw !== undefined
      ? { expectedTarget: expectedTargetRaw.toLowerCase() }
      : {}),
    ...(expectedBookmarkRaw !== undefined
      ? {
          expectedBookmark:
            expectedBookmarkRaw === 'none'
              ? null
              : expectedBookmarkRaw.toLowerCase(),
        }
      : {}),
    ...(expectedPlanDigestRaw !== undefined
      ? { expectedPlanDigest: expectedPlanDigestRaw }
      : {}),
    requireClean,
    mutationJournal,
    srcSubpath,
    exclude: excludePatterns.length > 0 ? excludePatterns : undefined,
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
  if (!noEmbed && !pairedCli && !dryRun && !watch) {
    const gateRows = await engine.executeRaw<{ local_path: string | null; config: Record<string, unknown>; last_commit: string | null; chunker_version: string | null }>(
      `SELECT local_path, config, last_commit, chunker_version FROM sources WHERE id = $1`,
      [sourceId],
    );
    if (gateRows.length > 0) {
      const gateSources = [{
        local_path: gateRows[0].local_path ?? repoPath ?? null,
        config: gateRows[0].config ?? {},
        last_commit: gateRows[0].last_commit,
        chunker_version: gateRows[0].chunker_version,
      }];
      const runGate = () => runInlineCostGate(engine, {
        sources: gateSources, mode: 'inline', dryRun: false, jsonOut, yesFlag, full, includeGitignored, label: 'sync',
      });
      const gate = jsonOut
        ? await withConsoleLogOnStderr(runGate)
        : await runGate();
      opts.costGateReceipt = gate.receipt;
      if (gate.action === 'stop') {
        if (jsonOut) {
          const error = new SyncPreconditionError(
            'cost_gate_stopped',
            'The inline embedding cost gate stopped before sync began.',
            null,
            'an accepted or safely deferred cost-gate outcome',
          );
          process.stdout.write(
            JSON.stringify(buildGBrainSyncErrorEnvelope(error)) + '\n',
          );
          const { setCliExitVerdict } = await import(
            '../core/cli-force-exit.ts'
          );
          setCliExitVerdict(1);
        }
        return;
      }
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
      if (jsonOut) process.stderr.write('No unacknowledged sync failures to retry.\n');
      else console.log('No unacknowledged sync failures to retry.');
    } else {
      const line = `Retrying ${failures.length} previously-failed file(s)...`;
      if (jsonOut) process.stderr.write(line + '\n');
      else console.log(line);
      // Don't acknowledge them yet — they must succeed to clear.
    }
  }

  if (!watch) {
    // v0.41.13.0 (T6): try/finally clears the single-source timer so it
    // doesn't fire after performSync resolves OR throws.
    let result: SyncResult;
    process.on('SIGINT', onSingleSourceSigint);
    try {
      result = jsonOut
        ? await withConsoleLogOnStderr(() => performSync(engine, opts))
        : await performSync(engine, opts);
    } catch (error) {
      if (!jsonOut) throw error;
      process.stdout.write(
        JSON.stringify(
          buildGBrainSyncErrorEnvelope(
            error,
            mutationEnvelopeState(mutationJournal),
          ),
        ) + '\n',
      );
      const { setCliExitVerdict } = await import('../core/cli-force-exit.ts');
      setCliExitVerdict(1);
      return;
    } finally {
      if (singleSourceTimer !== undefined) clearTimeout(singleSourceTimer);
      process.off('SIGINT', onSingleSourceSigint);
    }
    if (jsonOut) {
      try {
        process.stdout.write(
          JSON.stringify(buildGBrainSyncEnvelope(result, opts)) + '\n',
        );
      } catch (error) {
        process.stdout.write(
          JSON.stringify(
            buildGBrainSyncErrorEnvelope(
              error,
              mutationEnvelopeState(mutationJournal),
            ),
          ) + '\n',
        );
        const { setCliExitVerdict } = await import(
          '../core/cli-force-exit.ts'
        );
        setCliExitVerdict(1);
        return;
      }
    } else {
      printSyncResult(result);
    }
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
    // Issue #2 + eng-review pass-2 finding #1 + Codex P1: manage .gitignore ONLY
    // on successful sync. Skip on dry-run (don't mutate disk in preview mode)
    // and blocked_by_failures (sync state is inconsistent — defer .gitignore
    // until next clean run). v0.41.13.0 (T7 / D-V3-5): partial also skips —
    // conservative posture matches blocked_by_failures. Resolve the effective
    // repo path so the wire-up fires in the common case where the user runs
    // `gbrain sync` without passing --repo every time.
    if (
      !pairedCli &&
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
    if (
      singleSourceAutoDefer &&
      result.status !== 'dry_run' &&
      result.status !== 'up_to_date' &&
      result.status !== 'partial'
    ) {
      try {
        const { submitEmbedBackfill } = await import('../core/embed-backfill-submit.ts');
        const sub = await submitEmbedBackfill(engine, sourceId, { reason: 'sync_autodefer' });
        if (sub.status === 'submitted') {
          process.stderr.write(`  → embed-backfill job ${sub.jobId} queued (deferred inline embed).\n`);
        } else if (sub.status === 'cooldown') {
          process.stderr.write(`  → embed-backfill skipped (cooldown); run \`gbrain embed --stale\` to drain now.\n`);
        }
      } catch (e) {
        process.stderr.write(`  → embed-backfill submission failed: ${e instanceof Error ? e.message : String(e)}\n`);
      }
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
  },
): Promise<{ result: SyncResult; log: string }> {
  const cfg = (src.config || {}) as { strategy?: 'markdown' | 'code' | 'auto' };
  const log = `\n--- Syncing source: ${src.name} ---\n`;
  const repoOpts: SyncOpts = {
    repoPath: src.local_path!,
    dryRun: shared.dryRun,
    full: shared.full,
    noPull: shared.noPull,
    noEmbed: shared.noEmbed,
    noExtract: shared.noExtract,
    skipFailed: shared.skipFailed,
    retryFailed: shared.retryFailed,
    noSchemaPack: shared.noSchemaPack,
    includeGitignored: shared.includeGitignored,
    sourceId: src.id,
    strategy: cfg.strategy,
    concurrency: shared.concurrency,
    // lockId defaults to `gbrain-sync:${src.id}` via the invariant in
    // performSync (no explicit override needed — sourceId triggers it).
  };
  const result = await withSourcePrefix(src.id, () => performSync(engine, repoOpts));
  return { result, log };
}

/**
 * v0.40.3.0 — read-only per-source dashboard for `gbrain sources status`.
 *
 * Aggregates from existing tables (no schema changes):
 *   - sources:        last_commit, last_sync_at, archived, config.syncEnabled
 *                     (filtered: archived=false, local_path IS NOT NULL)
 *   - pages:          per-source page count (excluding soft-deleted)
 *   - content_chunks: per-source total + count of unembedded chunks for
 *                     the ACTIVE embedding column (resolved via the
 *                     registry — see `src/core/search/embedding-column.ts`).
 *                     Voyage / multimodal / non-default-column brains
 *                     see counts against the column they actually use.
 *   - sync-failures.jsonl: unacknowledged failures (brain-global; the
 *     JSONL log isn't per-source. v0.40.4 TODO source-scopes it.)
 *
 * Staleness thresholds match `gbrain doctor`'s sync-freshness rule
 * (24h / 72h). Sources that have NEVER synced (last_sync_at IS NULL)
 * report `staleness_hours: null` so callers can disambiguate "first run
 * pending" from "32h since last successful sync".
 *
 * Errors propagate. Pre-v0.40.3.0 the dashboard swallowed all DB errors
 * and reported zero counts, which lied at exactly the moment it mattered
 * (Q2 sub-fix from Codex review). The dashboard is read-only — a thrown
 * error surfaces the real problem (DB down, permission denied, statement
 * timeout) instead of misleading the operator with a "0 chunks" report.
 */
export interface SyncStatusReportSource {
  source_id: string;
  name: string;
  local_path: string | null;
  sync_enabled: boolean;
  last_sync_at: string | null;
  staleness_hours: number | null;
  staleness_class: 'fresh' | 'stale' | 'severe' | 'unknown';
  last_commit: string | null;
  pages: number;
  chunks_total: number;
  chunks_unembedded: number;
  embedding_coverage_pct: number;
  // v0.41.31: embed-backfill job visibility (federated_v2 defers embedding
  // to these jobs; without this an operator can't see queued/lagging work
  // after `sync --all` exits 0). Best-effort — all 0 / null on brains
  // without the minion_jobs table.
  backfill_queued: number;
  backfill_active: number;
  backfill_last_completed_at: string | null;
}

export interface SyncStatusReport {
  schema_version: 1;
  generated_at: string;
  sources: SyncStatusReportSource[];
  unacknowledged_failures: number;
  /** The embedding column counts were computed against. Useful for
   *  operators verifying their Voyage / multimodal setup is reported
   *  correctly. */
  embedding_column: string;
}

export async function buildSyncStatusReport(
  engine: BrainEngine,
  sources: Array<{ id: string; name: string; local_path: string | null; config: Record<string, unknown> }>,
): Promise<SyncStatusReport> {
  // Resolve the active embedding column via the registry. Brains pointed
  // at Voyage / multimodal / any non-default column get accurate counts
  // for the column they actually use (D16 → A, Codex P2 #10).
  const { resolveEmbeddingColumn, quoteIdentifier } = await import('../core/search/embedding-column.ts');
  // loadConfig() returns null when ~/.gbrain/config.json is missing.
  // resolveEmbeddingColumn handles missing fields via its own
  // gateway-fallback chain, so a minimal stub satisfies the call shape.
  const cfg = loadConfig() ?? ({ engine: engine.kind } as Parameters<typeof resolveEmbeddingColumn>[1]);
  const resolved = resolveEmbeddingColumn(undefined, cfg);
  const embeddingColIdent = quoteIdentifier(resolved.name);

  const sourceIds = sources.map((s) => s.id);
  type SourceRow = {
    id: string;
    last_commit: string | null;
    last_sync_at: string | Date | null;
    // v0.41.32.0: remote staleness reads this column (no git subprocess).
    newest_content_at: string | Date | null;
  };
  type CountRow = {
    source_id: string;
    pages: string | number;
    chunks_total: string | number;
    chunks_unembedded: string | number;
  };

  // Pull last_commit + last_sync_at fresh (caller may have called us
  // with stale rows). Empty source list → skip the round-trip.
  const sourceRows = sourceIds.length === 0
    ? []
    : await engine.executeRaw<SourceRow>(
        `SELECT id, last_commit, last_sync_at, newest_content_at FROM sources WHERE id = ANY($1::text[])`,
        [sourceIds],
      );
  const sourceMap = new Map<string, SourceRow>();
  for (const r of sourceRows) sourceMap.set(r.id, r);

  // Per-source page + chunk + unembedded-chunk counts in a single
  // round-trip. Canonical SQL (verified against
  // src/commands/doctor.ts:2740): content_chunks joined on page_id
  // (NOT page_slug — Codex P0 #1), filtered for non-soft-deleted pages
  // (NOT NULL — soft-delete shipped v0.26.5), unembedded counted
  // against the resolved active embedding column (D16 → A).
  //
  // No try/catch swallow — a thrown error means DB down / permission
  // denied / statement timeout (NOT a schema variant). Surfacing the
  // real error is better than a misleading "0 chunks" report (Q2).
  let countRows: CountRow[] = [];
  if (sourceIds.length > 0) {
    countRows = await engine.executeRaw<CountRow>(
      `WITH s AS (
         SELECT unnest($1::text[]) AS source_id
       )
       SELECT
         s.source_id,
         COALESCE(p.pages, 0) AS pages,
         COALESCE(c.chunks_total, 0) AS chunks_total,
         COALESCE(c.chunks_unembedded, 0) AS chunks_unembedded
       FROM s
       LEFT JOIN (
         SELECT source_id, COUNT(*) AS pages
         FROM pages
         WHERE deleted_at IS NULL
         GROUP BY source_id
       ) p ON p.source_id = s.source_id
       LEFT JOIN (
         SELECT pg.source_id,
                COUNT(*) AS chunks_total,
                COUNT(*) FILTER (WHERE cc.${embeddingColIdent} IS NULL) AS chunks_unembedded
         FROM content_chunks cc
         JOIN pages pg ON pg.id = cc.page_id
         WHERE pg.deleted_at IS NULL
         GROUP BY pg.source_id
       ) c ON c.source_id = s.source_id`,
      [sourceIds],
    );
  }
  const countMap = new Map<string, { pages: number; chunks_total: number; chunks_unembedded: number }>();
  for (const r of countRows) {
    countMap.set(r.source_id, {
      pages: Number(r.pages) || 0,
      chunks_total: Number(r.chunks_total) || 0,
      chunks_unembedded: Number(r.chunks_unembedded) || 0,
    });
  }

  // v0.41.31: per-source embed-backfill job state. Best-effort — the
  // minion_jobs table doesn't exist on every brain (a brain that never ran
  // a worker has the pre-minions schema), and the dashboard must not crash
  // for that. A failure → empty map → all sources report 0/null.
  type BackfillRow = {
    source_id: string | null;
    queued: string | number;
    active: string | number;
    last_completed_at: string | Date | null;
  };
  const backfillMap = new Map<string, { queued: number; active: number; last_completed_at: string | null }>();
  if (sourceIds.length > 0) {
    try {
      const backfillRows = await engine.executeRaw<BackfillRow>(
        `SELECT data->>'sourceId' AS source_id,
                COUNT(*) FILTER (WHERE status IN ('waiting','delayed','waiting-children'))::int AS queued,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active,
                MAX(finished_at) FILTER (WHERE status = 'completed') AS last_completed_at
           FROM minion_jobs
          WHERE name = 'embed-backfill' AND data->>'sourceId' = ANY($1::text[])
          GROUP BY data->>'sourceId'`,
        [sourceIds],
      );
      for (const r of backfillRows) {
        if (!r.source_id) continue;
        const last = r.last_completed_at;
        backfillMap.set(r.source_id, {
          queued: Number(r.queued) || 0,
          active: Number(r.active) || 0,
          last_completed_at: last == null ? null : (last instanceof Date ? last.toISOString() : last),
        });
      }
    } catch {
      // minion_jobs absent / unreadable → leave backfillMap empty.
    }
  }

  const now = Date.now();
  const out: SyncStatusReportSource[] = sources.map((src) => {
    const cfgEntry = (src.config || {}) as { syncEnabled?: boolean };
    const row = sourceMap.get(src.id) || { id: src.id, last_commit: null, last_sync_at: null, newest_content_at: null };
    const counts = countMap.get(src.id) || { pages: 0, chunks_total: 0, chunks_unembedded: 0 };
    const lastSyncMs = row.last_sync_at
      ? (row.last_sync_at instanceof Date ? row.last_sync_at.getTime() : Date.parse(row.last_sync_at))
      : null;
    // v0.41.32.0: commit-relative staleness from the stored column — NO git
    // subprocess (this function backs the remote get_status_snapshot MCP op,
    // so it must honor the v0.41.27.0 trust boundary). A quiet repo whose
    // newest commit predates its last sync reports 0; null column → wall-clock.
    const contentMs = row.newest_content_at
      ? (row.newest_content_at instanceof Date ? row.newest_content_at.getTime() : Date.parse(row.newest_content_at))
      : null;
    const lagSeconds = lagFromContentMs(
      Number.isFinite(contentMs as number) ? (contentMs as number) : null,
      lastSyncMs !== null && Number.isFinite(lastSyncMs) ? lastSyncMs : null,
      now,
    );
    const stalenessHours = lagSeconds === null ? null : lagSeconds / 3600;
    let stalenessClass: 'fresh' | 'stale' | 'severe' | 'unknown' = 'unknown';
    if (stalenessHours !== null) {
      if (stalenessHours < 24) stalenessClass = 'fresh';
      else if (stalenessHours < 72) stalenessClass = 'stale';
      else stalenessClass = 'severe';
    }
    const embeddingCoveragePct = counts.chunks_total === 0
      ? 100
      : Math.round(((counts.chunks_total - counts.chunks_unembedded) / counts.chunks_total) * 1000) / 10;
    const lastSyncIso = row.last_sync_at
      ? (row.last_sync_at instanceof Date ? row.last_sync_at.toISOString() : row.last_sync_at)
      : null;
    return {
      source_id: src.id,
      name: src.name,
      local_path: src.local_path,
      sync_enabled: cfgEntry.syncEnabled !== false,
      last_sync_at: lastSyncIso,
      staleness_hours: stalenessHours === null ? null : Math.round(stalenessHours * 10) / 10,
      staleness_class: stalenessClass,
      last_commit: row.last_commit,
      pages: counts.pages,
      chunks_total: counts.chunks_total,
      chunks_unembedded: counts.chunks_unembedded,
      embedding_coverage_pct: embeddingCoveragePct,
      backfill_queued: backfillMap.get(src.id)?.queued ?? 0,
      backfill_active: backfillMap.get(src.id)?.active ?? 0,
      backfill_last_completed_at: backfillMap.get(src.id)?.last_completed_at ?? null,
    };
  });

  // Unacknowledged sync failures — brain-global (the JSONL log isn't
  // per-source). v0.40.4 TODO will source-scope this. Best-effort:
  // missing file / parse error returns 0, doesn't throw the dashboard.
  let unackedCount = 0;
  try {
    unackedCount = unacknowledgedSyncFailures().length;
  } catch {
    unackedCount = 0;
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    sources: out,
    unacknowledged_failures: unackedCount,
    embedding_column: resolved.name,
  };
}

/**
 * v0.40.3.0 — render a `SyncStatusReport` as a human-readable table.
 *
 * `sink` defaults to `process.stdout` so the bare `gbrain sources status`
 * invocation writes its table to stdout. `--json` callers don't use
 * this — they emit `JSON.stringify(report)` to stdout directly.
 */
export function printSyncStatusReport(
  report: SyncStatusReport,
  sink: NodeJS.WriteStream = process.stdout,
): void {
  const write = (line: string) => sink.write(line + '\n');
  write(`\nSync status — generated ${report.generated_at}`);
  write(`Embedding column: ${report.embedding_column}\n`);
  if (report.sources.length === 0) {
    write('  (no sources registered)');
    return;
  }
  const headers = ['SOURCE', 'STATE', 'STALENESS', 'PAGES', 'EMBEDDED', 'BACKFILL', 'LAST SYNC'];
  const rows = report.sources.map((s) => {
    const stale = s.staleness_hours === null
      ? 'never'
      : `${s.staleness_hours.toFixed(1)}h`;
    const stateBits: string[] = [];
    if (!s.sync_enabled) stateBits.push('disabled');
    stateBits.push(s.staleness_class);
    // BACKFILL: active beats queued beats idle for the at-a-glance cell.
    const backfill = s.backfill_active > 0
      ? `active(${s.backfill_active})`
      : s.backfill_queued > 0
        ? `queued(${s.backfill_queued})`
        : 'idle';
    return [
      s.name,
      stateBits.join(','),
      stale,
      String(s.pages),
      `${s.embedding_coverage_pct}%`,
      backfill,
      s.last_sync_at ?? '(never)',
    ];
  });
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  // Numeric columns (STALENESS=2, PAGES=3, EMBEDDED=4) right-pad-left so
  // digits align cleanly. Text columns (incl. BACKFILL=5) left-pad-right
  // per the existing `sources list` convention.
  const NUMERIC_COLS = new Set([2, 3, 4]);
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (NUMERIC_COLS.has(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ');
  write(fmt(headers));
  write(fmt(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) write(fmt(r));
  write(`\nUnacknowledged sync failures (brain-wide): ${report.unacknowledged_failures}`);
  const severe = report.sources.filter((s) => s.staleness_class === 'severe').length;
  if (severe > 0) {
    write(`WARNING: ${severe} source(s) are SEVERELY stale (>72h). Run \`gbrain sync --all\` to refresh.`);
  }
}

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
 * see identical output. The `--all` parallel path passes `process.stderr`
 * when `--json` is set, so banners stay off stdout and the JSON envelope
 * pipes cleanly through `jq` (D4).
 */
function printSyncResult(result: SyncResult, sink: NodeJS.WriteStream = process.stdout) {
  const write = (line: string) => sink.write(line + '\n');
  switch (result.status) {
    case 'up_to_date':
      write('Already up to date.');
      break;
    case 'synced':
      write(`Synced ${result.fromCommit?.slice(0, 8)}..${result.toCommit.slice(0, 8)}:`);
      write(`  +${result.added} added, ~${result.modified} modified, -${result.deleted} deleted, R${result.renamed} renamed`);
      write(`  ${result.chunksCreated} chunks created${result.embedded > 0 ? `, ${result.embedded} pages embedded` : ''}`);
      break;
    case 'first_sync':
      write(`First sync complete. Checkpoint: ${result.toCommit.slice(0, 8)}`);
      write(`  ${result.added} file(s) imported, ${result.chunksCreated} chunks${result.embedded > 0 ? `, ${result.embedded} pages embedded` : ''}`);
      break;
    case 'dry_run':
      break; // already printed in performSync
    case 'blocked_by_failures':
      write(`Sync BLOCKED at ${result.toCommit.slice(0, 8)}: ${result.failedFiles ?? 0} file(s) failed to parse.`);
      write(`  See ~/.gbrain/sync-failures.jsonl for details, or run 'gbrain doctor'.`);
      write(`  Fix the files then re-run 'gbrain sync', or 'gbrain sync --skip-failed' to move on.`);
      break;
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
