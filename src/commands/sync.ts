import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, relative } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { DELETE_BATCH_SIZE } from '../core/engine-constants.ts';
import { importFile } from '../core/import-file.ts';
import { collectSyncableFiles } from './import.ts';
import { createInterface } from 'readline';
import {
  buildSyncManifest,
  isSyncable,
  unsyncableReason,
  resolveSlugForPath,
  recordSyncFailures,
  unacknowledgedSyncFailures,
  acknowledgeSyncFailures,
  formatCodeBreakdown,
} from '../core/sync.ts';
import { estimateTokens, CHUNKER_VERSION } from '../core/chunkers/code.ts';
import {
  estimateEmbeddingCostUsd,
  getEmbeddingModelName,
  currentEmbeddingPricePerMTok,
  currentEmbeddingSignature,
  willEmbedSynchronously,
  shouldBlockSync,
} from '../core/embedding.ts';
import { estimateCostFromChars } from '../core/embedding-pricing.ts';
import { isSourceUnchangedSinceSync } from '../core/git-head.ts';
import { SPEND_CAP_CONFIG_KEY } from '../core/embed-backfill-submit.ts';
import { errorFor, serializeError } from '../core/errors.ts';
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
  tryAcquireDbLock,
  withRefreshingLock,
  LockUnavailableError,
  syncLockId,
  SYNC_LOCK_ID,
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
  clearOpCheckpoint,
  resumeFilter,
  syncFingerprint,
  type OpCheckpointKey,
} from '../core/op-checkpoint.ts';

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

function resolveSyncCheckpointEvery(): number {
  const raw = process.env.GBRAIN_SYNC_CHECKPOINT_EVERY;
  if (!raw) return SYNC_CHECKPOINT_EVERY_DEFAULT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : SYNC_CHECKPOINT_EVERY_DEFAULT;
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
  reason?: 'timeout' | 'pull_timeout';
}

/**
 * Walk ONE source's working tree and sum tokens for every syncable file.
 * Conservative full-tree ceiling (full file content, not the incremental
 * diff) — over-counts, never under-counts, and matches the filesystem set
 * `sync` actually imports (collectSyncableFiles + content_hash, NOT a git
 * commit diff). Best-effort per file and per source: anything unreadable
 * contributes 0 rather than blocking the preview.
 *
 * v0.31.2: routed through collectSyncableFiles (lstat + inode-cycle +
 * max-depth) so the preview walks exactly what the real sync walks.
 */
function estimateSourceTreeTokens(
  localPath: string,
  strategy: 'markdown' | 'code' | 'auto',
): { tokens: number; files: number } {
  let tokens = 0;
  let files = 0;
  try {
    const fileList = collectSyncableFiles(localPath, { strategy });
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

/**
 * v0.41.31 — INLINE-path new-content estimate. Per source, contribute ZERO
 * when the source is provably unchanged since its last sync (HEAD ==
 * last_commit AND clean working tree AND chunker_version matches CURRENT) —
 * `content_hash` short-circuits every file so nothing re-embeds. Otherwise
 * contribute the full-tree ceiling. The unchanged predicate mirrors
 * doctor's `sync_freshness` and sync's own "do work?" gate (sync.ts:1057+
 * 1075). `isSourceUnchangedSinceSync` is fail-open (probe error → false), so
 * a source we can't prove unchanged is conservatively re-estimated rather
 * than silently priced at $0.
 */
function estimateInlineNewTokens(
  sources: Array<{
    local_path: string | null;
    config: Record<string, unknown>;
    last_commit: string | null;
    chunker_version: string | null;
  }>,
  currentChunkerVersion: string,
): { tokens: number; changedSources: number; unchangedSources: number } {
  let tokens = 0;
  let changedSources = 0;
  let unchangedSources = 0;
  for (const src of sources) {
    if (!src.local_path) continue;
    const cfg = (src.config || {}) as { syncEnabled?: boolean; strategy?: 'markdown' | 'code' | 'auto' };
    if (cfg.syncEnabled === false) continue;
    const unchanged =
      isSourceUnchangedSinceSync(src.local_path, src.last_commit, { requireCleanWorkingTree: true }) &&
      src.chunker_version === currentChunkerVersion;
    if (unchanged) {
      unchangedSources++;
      continue;
    }
    changedSources++;
    tokens += estimateSourceTreeTokens(src.local_path, cfg.strategy ?? 'markdown').tokens;
  }
  return { tokens, changedSources, unchangedSources };
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
    if (raw === null || raw === undefined) return 0.5;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0.5;
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
    if (raw === null || raw === undefined) return 25;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 25;
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
 * Shell out to git with a generous maxBuffer.
 *
 * Node's default maxBuffer is 1 MiB.  `git diff --name-status -M` on a
 * 60–100K file repo easily exceeds that, causing an ENOBUFS crash that
 * kills the sync process with no error message in the log.
 *
 * 100 MiB is generous but still bounded — a 100K-file diff with long
 * paths tops out around 10–20 MiB in practice.
 */
function git(repoPath: string, args: string[], configs: string[] = []): string {
  return execFileSync('git', buildGitInvocation(repoPath, args, configs), {
    encoding: 'utf-8',
    timeout: 30000,
    maxBuffer: 100 * 1024 * 1024,
  }).trim();
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

function buildDetachedWorkingTreeManifest(repoPath: string): SyncManifest {
  const manifest = buildSyncManifest(git(repoPath, ['diff', '--name-status', '-M', 'HEAD']));
  const untracked = git(repoPath, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(line => line.length > 0);

  return {
    added: unique([...manifest.added, ...untracked]),
    modified: unique(manifest.modified),
    deleted: unique(manifest.deleted),
    renamed: manifest.renamed,
  };
}

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
): Promise<void> {
  if (sourceId) {
    const col = which === 'repo_path' ? 'local_path' : 'last_commit';
    // last_sync_at bookmarked on every last_commit advance.
    if (which === 'last_commit') {
      if (newestContentEpochMs !== undefined) {
        const iso = newestContentEpochMs === null
          ? null
          : new Date(newestContentEpochMs).toISOString();
        await engine.executeRaw(
          `UPDATE sources SET last_commit = $1, last_sync_at = now(), newest_content_at = $3 WHERE id = $2`,
          [value, sourceId, iso],
        );
      } else {
        await engine.executeRaw(
          `UPDATE sources SET last_commit = $1, last_sync_at = now() WHERE id = $2`,
          [value, sourceId],
        );
      }
    } else {
      await engine.executeRaw(
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
  constructor(message: string, lockKey: string) {
    super(message);
    this.name = 'SyncLockBusyError';
    this.lockKey = lockKey;
  }
}

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

  // When `opts.sourceId` is set OR `opts.lockId` is explicitly overridden,
  // use the TTL-refreshing lock so long sources stay safe. The default
  // path (no sourceId, no lockId) keeps the bare tryAcquireDbLock for
  // bit-for-bit back-compat with single-default-source brains.
  const usePerSourcePath = opts.lockId !== undefined || opts.sourceId !== undefined;

  if (usePerSourcePath) {
    try {
      return await withRefreshingLock(engine, lockKey, () => performSyncInner(engine, opts));
    } catch (err) {
      if (err instanceof LockUnavailableError) {
        throw new SyncLockBusyError(await formatLockBusyMessage(engine, lockKey), lockKey);
      }
      throw err;
    }
  }

  // Legacy global-lock path (single-default-source brains).
  const lockHandle = await tryAcquireDbLock(engine, lockKey);
  if (!lockHandle) {
    throw new SyncLockBusyError(await formatLockBusyMessage(engine, lockKey), lockKey);
  }
  try {
    return await performSyncInner(engine, opts);
  } finally {
    try { await lockHandle.release(); } catch { /* best-effort release */ }
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
async function runBreakLock(
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
  reason: 'timeout' | 'pull_timeout';
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

  serr(`[gbrain phase] sync.load_active_pack`);
  // v0.39 T1.5: load active pack ONCE at sync entry; pass to every per-file
  // importFile call below. Codex perf finding #7: per-file loadActivePack adds
  // disk/YAML/hash overhead × thousands of files. Best-effort: pack load
  // failure falls through to legacy inferType (parity preserved).
  let syncActivePack: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> } | undefined;
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

  // v0.28: source-aware re-clone branch. When the source has a remote_url
  // recorded (i.e. it was registered via `sources add --url`), the on-disk
  // clone is auto-managed. validateRepoState classifies the on-disk state;
  // we recover from missing/no-git/not-a-dir by re-cloning, refuse on
  // url-drift or corruption with structured hints.
  if (opts.sourceId) {
    serr(`[gbrain phase] sync.validate_repo_state`);
    const { validateRepoState } = await import('../core/git-remote.ts');
    const { recloneIfMissing } = await import('../core/sources-ops.ts');
    const cfgRows = await engine.executeRaw<{ config: unknown }>(
      `SELECT config FROM sources WHERE id = $1`,
      [opts.sourceId],
    );
    const cfg =
      typeof cfgRows[0]?.config === 'string'
        ? (JSON.parse(cfgRows[0].config as string) as Record<string, unknown>)
        : ((cfgRows[0]?.config ?? {}) as Record<string, unknown>);
    const remoteUrl = typeof cfg.remote_url === 'string' ? cfg.remote_url : null;
    if (remoteUrl) {
      const state = validateRepoState(repoPath, remoteUrl);
      switch (state) {
        case 'healthy':
          break;
        case 'missing':
        case 'no-git':
        case 'not-a-dir':
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

  // Validate git repo
  if (!existsSync(join(repoPath, '.git'))) {
    throw new Error(`Not a git repository: ${repoPath}. GBrain sync requires a git-initialized repo.`);
  }

  serr(`[gbrain phase] sync.detect_head`);
  // Detect detached HEAD up front so the working-tree fallback fires for both
  // the default sync and `--no-pull` callers. Only the actual git pull is
  // gated on opts.noPull.
  const detachedHead = isDetachedHead(repoPath);
  if (detachedHead && !opts.noPull) {
    serr(`Detached HEAD on ${repoPath}; skipping git pull. Syncing from local working tree.`);
  }

  // Git pull (unless --no-pull). v0.28.1 codex finding (HIGH): the legacy
  // git() helper at sync.ts:192 spawns git without GIT_SSRF_FLAGS, so
  // every steady-state pull was bypassing the redirect/submodule/protocol
  // hardening that cloneRepo applies. Route through pullRepo from
  // git-remote.ts so the flag set is consistent across initial clone and
  // ongoing pulls — single source of truth for the defensive flags.
  const originRemotePresent = !opts.noPull && !detachedHead ? hasOriginRemote(repoPath) : false;
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
      // failure.
      pullRepo(repoPath);
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
    headCommit = git(repoPath, ['rev-parse', 'HEAD']);
  } catch {
    throw new Error(`No commits in repo ${repoPath}. Make at least one commit before syncing.`);
  }

  // Ancestry validation: if lastCommit exists, verify it's still in history
  if (lastCommit) {
    try {
      git(repoPath, ['cat-file', '-t', lastCommit]);
    } catch {
      serr(`Sync anchor commit ${lastCommit.slice(0, 8)} missing (force push?). Running full reimport.`);
      return performFullSync(engine, repoPath, headCommit, opts);
    }

    // Verify ancestry
    try {
      git(repoPath, ['merge-base', '--is-ancestor', lastCommit, headCommit]);
    } catch {
      serr(`Sync anchor ${lastCommit.slice(0, 8)} is not an ancestor of HEAD. Running full reimport.`);
      return performFullSync(engine, repoPath, headCommit, opts);
    }
  }

  // First sync
  if (!lastCommit) {
    return performFullSync(engine, repoPath, headCommit, opts);
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
        git(repoPath, ['merge-base', '--is-ancestor', storedTarget, headCommit]);
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
        await clearOpCheckpoint(engine, ckpt.paths);
        await clearOpCheckpoint(engine, ckpt.target);
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
  const detachedWorkingTreeManifest = detachedHead ? buildDetachedWorkingTreeManifest(repoPath) : null;
  const hasDetachedWorkingTreeChanges = detachedWorkingTreeManifest !== null &&
    (detachedWorkingTreeManifest.added.length > 0 ||
      detachedWorkingTreeManifest.modified.length > 0 ||
      detachedWorkingTreeManifest.deleted.length > 0 ||
      detachedWorkingTreeManifest.renamed.length > 0);

  if (lastCommit === headCommit && !versionMismatch && !versionNeverSet && !hasDetachedWorkingTreeChanges) {
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
    const result = await performFullSync(engine, repoPath, headCommit, opts);
    await writeChunkerVersion(engine, opts.sourceId, currentVersion);
    return result;
  }

  // Diff using git diff (net result, not per-commit). v0.42.x (#1794): diff
  // against the PINNED target, not live HEAD. With a fixed (lastCommit, pin)
  // both endpoints are stable across every resume, so the manifest is
  // deterministic and resumeFilter maps cleanly onto completed paths.
  const diffOutput = git(repoPath, ['diff', '--name-status', '-M', `${lastCommit}..${pin}`]);
  const manifest = buildSyncManifest(diffOutput);
  if (detachedWorkingTreeManifest) {
    manifest.added = unique([...manifest.added, ...detachedWorkingTreeManifest.added]);
    manifest.modified = unique([...manifest.modified, ...detachedWorkingTreeManifest.modified]);
    manifest.deleted = unique([...manifest.deleted, ...detachedWorkingTreeManifest.deleted]);
    manifest.renamed = [...manifest.renamed, ...detachedWorkingTreeManifest.renamed];
  }

  // Filter to syncable files (strategy-aware)
  const syncOpts = opts.strategy ? { strategy: opts.strategy } : undefined;
  const filtered: SyncManifest = {
    added: manifest.added.filter(p => isSyncable(p, syncOpts)),
    modified: manifest.modified.filter(p => isSyncable(p, syncOpts)),
    deleted: manifest.deleted.filter(p => isSyncable(p, syncOpts)),
    renamed: manifest.renamed.filter(r => isSyncable(r.to, syncOpts)),
  };

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
  const unsyncableModified = manifest.modified.filter(p => !isSyncable(p, syncOpts));
  // v0.18.0+ multi-source: scope getPage + deletePage to opts.sourceId so
  // unsyncable cleanup in source A doesn't accidentally sweep same-slug
  // pages in sources B/C/D.
  const pageOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;
  for (const path of unsyncableModified) {
    // v0.41.13 #1433: never delete on metafile classification.
    if (unsyncableReason(path, syncOpts) === 'metafile') continue;
    const slug = await resolveSlugByPathOrSourcePath(engine, path, opts.sourceId);
    try {
      const existing = await engine.getPage(slug, pageOpts);
      if (existing) {
        await engine.deletePage(slug, pageOpts);
        slog(`  Deleted un-syncable page: ${slug}`);
      }
    } catch { /* ignore */ }
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
    // Update sync state even with no syncable changes (git advanced). v0.42.x
    // (#1794): advance to the PINNED target, and clear any checkpoint (a resume
    // whose remaining range turned out to have no syncable changes still
    // completes cleanly here).
    await writeSyncAnchor(engine, opts.sourceId, 'last_commit', pin, commitTimeMs(repoPath, pin));
    await engine.setConfig('sync.last_run', new Date().toISOString());
    await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
    await clearOpCheckpoint(engine, ckpt.paths);
    await clearOpCheckpoint(engine, ckpt.target);
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
  // HEAD). Idempotent on a resume (the row already holds pin). Never on dry-run
  // (returned above).
  await recordCompleted(engine, ckpt.target, [pin]);

  // v0.42.x (#1794): the cross-run completed-path set. Seeded from the loaded
  // checkpoint so a resume skips already-drained files. `markCompleted` flushes
  // every `checkpointEvery` additions; on a kill the worst case lost is one
  // batch of import work (cheap to redo — content_hash short-circuits).
  const completed = new Set<string>(completedPaths);
  let sinceFlush = 0;
  const flushCheckpoint = async (): Promise<void> => {
    // `[...completed]` is a synchronous snapshot (atomic under concurrent
    // worker `completed.add`), so a parallel flush can't observe a torn set.
    await recordCompleted(engine, ckpt.paths, [...completed]);
  };
  const markCompleted = async (path: string): Promise<void> => {
    completed.add(path);
    if (++sinceFlush >= checkpointEvery) {
      sinceFlush = 0;
      await flushCheckpoint();
    }
  };

  const pagesAffected: string[] = [];
  let chunksCreated = 0;
  // v0.41.13.0 (T2): tracks add+modify files actually persisted so far.
  // Only bumped from inside importOnePath's success path. partial() reports
  // this as `filesImported` so cron operators can see how much work the
  // aborted run completed before --timeout fired.
  let filesImported = 0;
  const start = Date.now();

  // v0.41.13.0 (T2 + D-V3-1): closure for the partial-return path. Captures
  // the live mutable state (pagesAffected, chunksCreated, filesImported)
  // and the diff totals so the abort check at each loop site is one line.
  // D-V3-1 invariant: callable ONLY in pre-bookmark phases (pull, delete,
  // rename, import). After the bookmark write at writeSyncAnchor('last_commit'),
  // partial is impossible because extract + embed run to completion.
  // v0.42.x (#1794): toCommit reports the PINNED target (what this run drains
  // to), not live HEAD. The checkpoint is flushed periodically inside the loops
  // (markCompleted), so on abort the banked completed set survives — last_commit
  // stays at lastCommit (unchanged) and the next run resumes from the checkpoint.
  const partial = (reason: 'timeout' | 'pull_timeout'): SyncResult =>
    buildPartialResult({
      fromCommit: lastCommit,
      toCommit: pin,
      filesImported,
      pagesAffected: [...pagesAffected],
      chunksCreated,
      added: filtered.added.length,
      modified: filtered.modified.length,
      deleted: filtered.deleted.length,
      renamed: filtered.renamed.length,
      reason,
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
          return partial('timeout');
        }
        const batch = deletesToDo.slice(i, i + DELETE_BATCH_SIZE);

        // Phase A: batch slug resolution (1 round-trip per batch).
        let pathSlugMap: Map<string, string>;
        try {
          pathSlugMap = await engine.resolveSlugsByPaths(batch, deleteScopedOpts);
        } catch {
          // Resolve failure: fall back to empty map; per-path fallback
          // below will use resolveSlugForPath. Best-effort, matches the
          // existing resolveSlugByPathOrSourcePath swallow-and-fallback
          // semantics.
          pathSlugMap = new Map();
        }
        const slugs = batch.map(p => pathSlugMap.get(p) ?? resolveSlugForPath(p));

        // Phase B: batch delete (1 round-trip per batch).
        try {
          const deleted = await engine.deletePages(slugs, deleteScopedOpts);
          // D6: only push slugs that were actually deleted. Filters phantom
          // slugs (paths in filtered.deleted but with no DB row) so
          // downstream extract/embed don't waste lookups.
          pagesAffected.push(...deleted);
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
          return partial('timeout');
        }
        const slug = await resolveSlugByPathOrSourcePath(engine, path, undefined);
        try {
          await engine.deletePage(slug, deleteOpts);
          pagesAffected.push(slug);
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
          return partial('timeout');
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
        return partial('timeout');
      }
      const oldSlug = opts.sourceId
        ? (fromSlugByPath.get(from) ?? resolveSlugForPath(from))
        : await resolveSlugByPathOrSourcePath(engine, from, undefined);
      // The new path doesn't yet have a row, so resolve from path only.
      const newSlug = resolveSlugForPath(to);
      try {
        await engine.updateSlug(oldSlug, newSlug, renameOpts);
      } catch {
        // Slug doesn't exist or collision, treat as add
      }
      // Reimport at new path (picks up content changes)
      const filePath = join(repoPath, to);
      if (existsSync(filePath)) {
        const result = await importFile(engine, filePath, to, { noEmbed, sourceId: opts.sourceId, activePack: syncActivePack });
        if (result.status === 'imported') chunksCreated += result.chunks;
      }
      pagesAffected.push(newSlug);
      await markCompleted(to);
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
    // repoPath is validated non-null at the top of performSyncInner; narrow for TS.
    const syncRepoPath = repoPath!;
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
      try {
        // v0.18.0+ multi-source: thread `opts.sourceId` so per-page tx writes
        // (putPage / getTags / addTag / removeTag / deleteChunks / upsertChunks
        // / addLink) target (sourceId, slug). Pre-fix the schema DEFAULT
        // 'default' was applied even for non-default sources, fabricating
        // duplicate rows that crashed bare-slug subqueries with Postgres 21000.
        const result = await importFile(eng, filePath, path, { noEmbed, sourceId: opts.sourceId, activePack: syncActivePack });
        if (result.status === 'imported') {
          chunksCreated += result.chunks;
          pagesAffected.push(result.slug);
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
      }
      progress.tick(1, path);
    }

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
            return partial('timeout');
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
                if (opts.signal?.aborted) break;
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
          return partial('timeout');
        }
        await importOnePath(engine, path);
      }
    }

    progress.finish();

    // v0.41.13.0 (T2): post-parallel-loop abort check. The parallel
    // workers exit via `break` inside their while loop when signal
    // aborts; Promise.all then resolves, and we land here. Without
    // this check, an aborted parallel sync would silently advance to
    // the bookmark write below. By returning partial here, we preserve
    // the D-V3-1 invariant that abort means "never advance last_commit."
    if (opts.signal?.aborted) {
      return partial('timeout');
    }
  }

  // v0.42.x (#1794): bank the final completed set before the gate so a block /
  // rewrite still persists everything drained this run (the next run resumes).
  await flushCheckpoint();

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
  try {
    const currentHead = git(repoPath, ['rev-parse', 'HEAD']);
    if (currentHead !== pin) {
      let pinStillReachable = false;
      try {
        git(repoPath, ['merge-base', '--is-ancestor', pin, currentHead]);
        pinStillReachable = true;
      } catch {
        pinStillReachable = false;
      }
      if (!pinStillReachable) {
        failedFiles.push({
          path: '<head>',
          error: `git history rewritten during sync: pinned target ${pin.slice(0, 8)} is no longer an ancestor of HEAD ${currentHead.slice(0, 8)}`,
        });
      }
      // else: forward progress (enrich committed on top) — safe, advance to pin.
    }
  } catch (e) {
    // rev-parse failure is itself a drift signal (worktree disappeared).
    failedFiles.push({
      path: '<head>',
      error: `git HEAD verification failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const elapsed = Date.now() - start;

  // Bug 9 — gate the sync bookmark on success. If any per-file parse
  // failed, record it to ~/.gbrain/sync-failures.jsonl and DO NOT advance
  // sync.last_commit. The next sync re-walks the same diff and re-attempts
  // the failed files. Escape hatches: --skip-failed acknowledges the
  // current set, --retry-failed re-parses before running the normal sync.
  if (failedFiles.length > 0) {
    recordSyncFailures(failedFiles, pin);
    // Emit structured summary grouped by error code so the operator
    // can see *why* files failed, not just how many.
    const codeBreakdown = formatCodeBreakdown(failedFiles);
    if (!opts.skipFailed) {
      serr(
        `\nSync blocked: ${failedFiles.length} file(s) failed to parse:\n` +
        `${codeBreakdown}\n\n` +
        `Fix the YAML frontmatter in the files above and re-run, or use ` +
        `'gbrain sync --skip-failed' to acknowledge and move on.`,
      );
      // Update last_run + repo_path (progress on infra) but NOT last_commit.
      // v0.42.x (#1794): the checkpoint is INTENTIONALLY left in place — the
      // banked `completed` set (flushed above) lets the next run skip the files
      // already drained and re-attempt only the failures.
      await engine.setConfig('sync.last_run', new Date().toISOString());
      await writeSyncAnchor(engine, opts.sourceId, 'repo_path', repoPath);
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
      };
    }
    // --skip-failed: acknowledge the now-recorded set and proceed.
    const acked = acknowledgeSyncFailures();
    if (acked.count > 0) {
      serr(
        `  Acknowledged ${acked.count} failure(s) and advancing past them:\n` +
        `${formatCodeBreakdown(acked.summary)}`,
      );
    }
  }

  // Update sync state AFTER all changes succeed (source-scoped when
  // opts.sourceId is set, global config otherwise). v0.42.x (#1794): advance to
  // the PINNED target (not live HEAD) — commits past the pin are the next
  // sync's pin..HEAD diff. `commitTimeMs(pin)` stamps newest_content_at against
  // the commit we actually drained to. `last_sync_at` is bumped HERE and ONLY
  // here (inside writeSyncAnchor) — never on a killed partial — so the
  // autopilot scheduler never sees a stuck source as "fresh".
  await writeSyncAnchor(engine, opts.sourceId, 'last_commit', pin, commitTimeMs(repoPath, pin));
  await engine.setConfig('sync.last_run', new Date().toISOString());
  await writeSyncAnchor(engine, opts.sourceId, 'repo_path', repoPath);
  // v0.20.0 Cathedral II Layer 12: persist the chunker version we just
  // finished with so the next sync's up_to_date gate respects it. Only
  // source-scoped syncs track this (see readChunkerVersion for rationale).
  await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));
  // v0.42.x (#1794): import drained the full lastCommit..pin range — the anchor
  // is advanced and both checkpoint rows clear here. CONVERGENCE CONTRACT: sync
  // convergence == IMPORT convergence. Downstream (extract/facts/embed below)
  // is DELIBERATELY decoupled from the anchor: it is size-gated (inline only for
  // small syncs) and otherwise handled by its own resumable sweeps
  // (extract --stale watermark, embed --stale / embed-backfill, the extract_facts
  // + conversation_facts_backfill cycle phases). Coupling a 44k-page facts/embed
  // pass into the anchor gate would re-introduce the exact non-convergence this
  // fix exists to kill. A kill mid-downstream just means the banked pages get
  // their links/embeddings/facts from the next stale sweep.
  await clearOpCheckpoint(engine, ckpt.paths);
  await clearOpCheckpoint(engine, ckpt.target);

  // Log ingest
  await engine.logIngest({
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
      const linksCreated = await extractLinksForSlugs(engine, repoPath, pagesAffected, extractOpts);
      const timelineCreated = await extractTimelineForSlugs(engine, repoPath, pagesAffected, extractOpts);
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
  if (!noEmbed && pagesAffected.length > 0 && pagesAffected.length <= 100) {
    try {
      const { runEmbedCore } = await import('./embed.ts');
      const embedOpts = opts.sourceId
        ? { slugs: pagesAffected, sourceId: opts.sourceId }
        : { slugs: pagesAffected };
      await runEmbedCore(engine, embedOpts);
      embedded = pagesAffected.length;
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
    toCommit: headCommit,
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
  repoPath: string,
  headCommit: string,
  opts: SyncOpts,
): Promise<SyncResult> {
  // Dry-run: walk the repo, count syncable files, return without writing.
  // Fixes the silent-write-on-dry-run bug where performFullSync called
  // runImport unconditionally regardless of opts.dryRun.
  //
  // v0.31.2 (codex C6): use the strategy-aware walker. Pre-fix this
  // hardcoded `collectMarkdownFiles(repoPath)` and filtered with
  // default-markdown `isSyncable(rel)`, so `gbrain sync --strategy
  // code --dry-run` always reported zero files even when ~1500 code
  // files were waiting.
  if (opts.dryRun) {
    const allFiles = collectSyncableFiles(repoPath, { strategy: opts.strategy ?? 'markdown' });
    slog(
      `Full-sync dry run (strategy=${opts.strategy ?? 'markdown'}): ` +
      `${allFiles.length} file(s) would be imported ` +
      `from ${repoPath} @ ${headCommit.slice(0, 8)}.`,
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

  // v0.22.13 (PR #490 A1 + Q5): full sync is always "large" by definition
  // (entire working tree). Auto-concurrency fires unconditionally for Postgres;
  // PGLite stays serial because its engine is single-connection. Routes the
  // policy through autoConcurrency() so it stays consistent with incremental
  // sync and the jobs handler.
  const FULL_SYNC_LARGE_MARKER = Number.MAX_SAFE_INTEGER;
  const fullConcurrency = autoConcurrency(engine, FULL_SYNC_LARGE_MARKER, opts.concurrency);
  slog(`Running full import of ${repoPath}${fullConcurrency > 1 ? ` (${fullConcurrency} workers)` : ''}...`);
  const { runImport } = await import('./import.ts');
  const importArgs = [repoPath];
  if (opts.noEmbed) importArgs.push('--no-embed');
  if (fullConcurrency > 1) importArgs.push('--workers', String(fullConcurrency));
  // v0.31.2: thread strategy through so code-strategy first sync
  // actually enumerates code files (closes bug 1).
  // v0.30.x: thread sourceId so performFullSync routes pages to the named
  // source (incremental path already does this).
  const _fullImportT0 = Date.now();
  serr(`[gbrain phase] sync.fullsync.import start strategy=${opts.strategy ?? 'markdown'}`);
  const result = await runImport(engine, importArgs, {
    commit: headCommit,
    strategy: opts.strategy,
    sourceId: opts.sourceId,
  });
  serr(
    `[gbrain phase] sync.fullsync.import done ${Date.now() - _fullImportT0}ms ` +
    `imported=${result.imported} skipped=${result.skipped} errors=${result.errors}`,
  );

  // Bug 9 — gate the full-sync bookmark on success. runImport already
  // writes its own sync.last_commit conditionally (import.ts), but
  // performFullSync is called on first-sync + force-full paths where
  // the sync module owns the last_commit write. Respect the same gate.
  if (result.failures.length > 0) {
    recordSyncFailures(result.failures, headCommit);
    const codeBreakdown = formatCodeBreakdown(result.failures);
    if (!opts.skipFailed) {
      serr(
        `\nFull sync blocked: ${result.failures.length} file(s) failed:\n` +
        `${codeBreakdown}\n\n` +
        `Fix the YAML in those files and re-run, or use '--skip-failed'.`,
      );
      await engine.setConfig('sync.last_run', new Date().toISOString());
      await writeSyncAnchor(engine, opts.sourceId, 'repo_path', repoPath);
      return {
        status: 'blocked_by_failures',
        fromCommit: null,
        toCommit: headCommit,
        added: 0, modified: 0, deleted: 0, renamed: 0,
        chunksCreated: result.chunksCreated,
        embedded: 0,
        pagesAffected: [],
        failedFiles: result.failures.length,
      };
    }
    const acked = acknowledgeSyncFailures();
    if (acked.count > 0) {
      serr(
        `  Acknowledged ${acked.count} failure(s) and advancing past them:\n` +
        `${formatCodeBreakdown(acked.summary)}`,
      );
    }
  }

  // Persist sync state so next sync is incremental (C1 fix: was missing).
  // v0.18.0 Step 5: routed through writeSyncAnchor so --source pins it
  // to the right sources row rather than the global config.
  await writeSyncAnchor(engine, opts.sourceId, 'last_commit', headCommit, newestCommitMs(repoPath));
  await engine.setConfig('sync.last_run', new Date().toISOString());
  await writeSyncAnchor(engine, opts.sourceId, 'repo_path', repoPath);
  // v0.20.0 Cathedral II Layer 12: persist chunker version for the gate.
  await writeChunkerVersion(engine, opts.sourceId, String(CHUNKER_VERSION));

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
    deleted: 0,
    renamed: 0,
    chunksCreated: result.chunksCreated,
    embedded,
    pagesAffected: [],
  };
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
  --dry-run            Show what would be synced without writing.
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
  --json               Emit a structured JSON envelope on stdout
                       ({schema_version: 1, sources, parallel,
                       ok_count, error_count}). Human banners route to
                       stderr so '--json | jq' parses cleanly.
                       Exit codes: 0 = all sources ok, 1 = any error,
                       2 = cost-prompt-not-confirmed.
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
  const noEmbed = args.includes('--no-embed');
  const noExtract = args.includes('--no-extract'); // v0.42.7 #1696
  const skipFailed = args.includes('--skip-failed');
  const retryFailed = args.includes('--retry-failed');
  const noSchemaPack = args.includes('--no-schema-pack'); // v0.41.37.0 #1569
  const syncAll = args.includes('--all');
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
  if (skipFailed) {
    const stale = unacknowledgedSyncFailures();
    if (stale.length > 0) {
      const acked = acknowledgeSyncFailures();
      console.log(`Acknowledged ${acked.count} pre-existing failure(s).`);
    }
  }

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
  const resolved = await resolveSourceWithTier(engine, explicitSource);
  const sourceId: string = resolved.source_id;
  if (resolved.tier === 'sole_non_default') {
    const nudge = formatSoleNonDefaultNudge(sourceId);
    if (nudge) process.stderr.write(nudge + '\n');
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
      console.log('No sources with local_path configured. Use `gbrain sources add <id> --path <path>` first.');
      return;
    }

    // v0.41.31 — mode-aware cost gate. Resolve federated_v2 ONCE here so both
    // the gate (below) and the fan-out (further down) share it.
    const { isFederatedV2Enabled } = await import('../core/feature-flags.ts');
    const v2Enabled = await isFederatedV2Enabled(engine);

    // v0.41.31 cost gate (supersedes the v0.20.0 unconditional gate). Under
    // federated_v2 sync DEFERS embedding to per-source embed-backfill jobs
    // that carry their own $X/source/24h spend cap, so sync itself spends
    // nothing synchronously — the gate is INFORMATIONAL (never exit 2) on
    // that path. The blocking ConfirmationRequired gate fires ONLY when embed
    // runs INLINE (v2 off, or --serial without --no-embed) AND the estimated
    // spend exceeds `sync.cost_gate_min_usd` (default $0.50). Skipped entirely
    // when --no-embed is set (user opted out; will run `embed --stale` later).
    if (!noEmbed) {
      const mode = willEmbedSynchronously({ v2Enabled, serialFlag, noEmbed });
      // Stale backlog: cheap single SQL; fail-open to 0 so a transient DB
      // hiccup never blocks the sync.
      let staleChars = 0;
      try {
        // v0.41.31: signature-aware so a model/dims swap surfaces in the
        // backlog estimate (NULL signature grandfathered → not counted).
        staleChars = await engine.sumStaleChunkChars({ signature: currentEmbeddingSignature() });
      } catch {
        staleChars = 0;
      }
      const rate = currentEmbeddingPricePerMTok();
      const staleCostUsd = estimateCostFromChars(staleChars, rate);
      const embeddingModelName = getEmbeddingModelName();
      const floorUsd = await resolveCostGateFloorUsd(engine);

      if (mode === 'deferred') {
        // Deferred path: print an FYI, NEVER exit 2. The backfill cap is the
        // real money gate (D1/D4).
        const capUsd = await resolveBackfillCapUsd(engine);
        // v0.41.31 (TODO-2): surface already-queued backfill jobs so a cron
        // operator sees work is enqueued, not lost. Best-effort — minion_jobs
        // may not exist on a brain that never ran a worker.
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
          `sync --all: embedding deferred to backfill jobs ` +
          `(capped $${capUsd}/source/24h, not charged by this sync). ` +
          `Current backlog ~${staleChars.toLocaleString()} chars (~$${staleCostUsd.toFixed(2)} on ` +
          `${embeddingModelName}) across ${sources.length} source(s); ` +
          `${queuedBackfills} backfill job(s) queued.`;
        if (dryRun) {
          if (jsonOut) {
            console.log(JSON.stringify({ status: 'dry_run', mode, gate: 'dry_run', staleChars, staleCostUsd, capUsd, floorUsd, queuedBackfills, model: embeddingModelName }));
          } else {
            console.log(deferredMsg);
            console.log('--dry-run: exit without syncing.');
          }
          return;
        }
        if (jsonOut) {
          console.log(JSON.stringify({ status: 'deferred', mode, gate: 'deferred_notice', staleChars, staleCostUsd, capUsd, floorUsd, queuedBackfills, model: embeddingModelName }));
        } else {
          console.log(deferredMsg);
        }
        // fall through to sync — no exit 2.
      } else {
        // Inline path: sync embeds synchronously with no backfill cap to
        // protect it, so the blocking gate applies. The BLOCKING cost is the
        // new-content estimate ONLY (full-tree ceiling for changed sources;
        // unchanged contribute 0) — that's what this sync actually embeds.
        // The pre-existing stale backlog (NULL embeddings + signature drift)
        // is NOT swept by sync; `gbrain embed --stale` clears it. So we show
        // it informationally but never gate on cost this sync won't incur
        // (else a model swap would block the next inline cron — F2).
        const currentChunkerVersion = String(CHUNKER_VERSION);
        const inline = estimateInlineNewTokens(sources, currentChunkerVersion);
        const newCostUsd = estimateEmbeddingCostUsd(inline.tokens);
        const costUsd = newCostUsd;
        const staleNote = staleChars > 0
          ? ` (plus ~${staleChars.toLocaleString()} stale-backlog chars pending \`gbrain embed --stale\`)`
          : '';
        const previewMsg =
          `sync --all preview (inline embed): ${inline.changedSources} changed source(s), ` +
          `${inline.unchangedSources} unchanged; ~${inline.tokens.toLocaleString()} new tokens, ` +
          `est. $${costUsd.toFixed(2)} on ${embeddingModelName}${staleNote}.`;

        if (dryRun) {
          if (jsonOut) {
            console.log(JSON.stringify({ status: 'dry_run', mode, gate: 'dry_run', newTokens: inline.tokens, staleChars, costUsd, floorUsd, model: embeddingModelName }));
          } else {
            console.log(previewMsg);
            console.log('--dry-run: exit without syncing.');
          }
          return;
        }

        if (!yesFlag) {
          if (shouldBlockSync(costUsd, floorUsd, mode)) {
            const isTTY = Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);
            if (!isTTY || jsonOut) {
              // Agent-facing path: emit structured envelope, exit 2.
              const envelope = serializeError(errorFor({
                class: 'ConfirmationRequired',
                code: 'cost_preview_requires_yes',
                message: previewMsg,
                hint: 'Pass --yes to proceed, or --dry-run to see the preview and exit 0.',
              }));
              console.log(JSON.stringify({ error: envelope, mode, gate: 'confirmation_required', newTokens: inline.tokens, staleChars, costUsd, floorUsd, model: embeddingModelName }));
              process.exit(2);
            }
            // Interactive TTY path: prompt [y/N].
            console.log(previewMsg);
            const answer = await promptYesNo('Proceed? [y/N] ');
            if (!answer) {
              console.log('Cancelled.');
              return;
            }
          } else {
            // Below floor → proceed without blocking (kills inline-cron noise).
            if (jsonOut) {
              console.log(JSON.stringify({ status: 'below_floor', mode, gate: 'below_floor', newTokens: inline.tokens, staleChars, costUsd, floorUsd, model: embeddingModelName }));
            } else {
              console.log(`${previewMsg} Below cost gate floor ($${floorUsd.toFixed(2)}), proceeding.`);
            }
          }
        }
      }
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

    if (activeSources.length === 0) {
      if (jsonOut) {
        console.log(JSON.stringify({
          schema_version: 1,
          sources: [],
          parallel: 0,
          ok_count: 0,
          error_count: 0,
        }));
      }
      return;
    }

    // Per-source result accumulator for the optional --json envelope.
    type PerSourceResult = {
      sourceId: string;
      sourceName: string;
      status: 'ok' | 'error';
      result?: SyncResult;
      error?: string;
    };
    const perSourceResults: PerSourceResult[] = [];

    // #1633 (Part B): one shared SIGINT controller for the whole --all fan-out.
    // process-cleanup.ts doesn't own SIGINT, so without this Ctrl-C hard-cuts the
    // run and can leak per-source locks; here it aborts every in-flight source so
    // each performSync returns `partial` + releases its lock cleanly.
    const allInterrupt = new AbortController();
    const onAllSigint = () => { try { allInterrupt.abort(new Error('SIGINT')); } catch { /* */ } };

    const runOne = async (src: typeof sources[number]): Promise<SyncResult> => {
      const cfg = (src.config || {}) as { strategy?: 'markdown' | 'code' | 'auto' };
      // D18: parallel path defers embed; auto-enqueue embed-backfill after.
      const effectiveNoEmbed = v2Enabled && !serialFlag && !noEmbed ? true : noEmbed;
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
        manageGitignore(src.local_path!, engine.kind);
      }
      // D18: auto-enqueue embed-backfill per source (unless opted out).
      // v0.41.13.0 (T7 / D-V3-5): partial excluded — the next clean sync
      // re-walks the diff and re-decides whether to enqueue embed for
      // pages whose content actually changed.
      if (
        v2Enabled &&
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
      v2Enabled && !serialFlag && engine.kind !== 'pglite' && activeSources.length > 1;

    // v0.40.6.0 (D15): refuse --skip-failed / --retry-failed when running
    // parallel. sync-failures.jsonl is brain-global; parallel acks race.
    if (parallelEligible && (skipFailed || retryFailed)) {
      const flag = skipFailed ? '--skip-failed' : '--retry-failed';
      console.error(
        `Error: ${flag} is not supported under parallel sync.\n` +
        `       (the sync-failures log is brain-global and parallel acks race).\n` +
        `       Re-run with --serial for the recovery flow:\n` +
        `         gbrain sync --all --serial ${flag}`,
      );
      process.exit(1);
    }

    // Effective parallelism — surfaced in the --json envelope so consumers
    // know how the run was actually dispatched. 1 in the serial fallback,
    // capped at min(sourceCount, --max-sources, 8) in the parallel path.
    const effectiveParallel = parallelEligible
      ? Math.min(activeSources.length, maxSources ?? 8)
      : 1;

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

      writeHuman(`\nParallel sync: ${activeSources.length} sources, ${cap} concurrent workers.\n`);
      const results = await pMapAllSettled(activeSources, cap, async (src) => {
        const r = await runOne(src);
        return { name: src.name, result: r };
      });
      // Print per-source aggregate at the end. humanSink so --json stays clean.
      writeHuman('\n--- sync --all aggregate ---');
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const src = activeSources[i];
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
      for (const src of activeSources) {
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
          ...(r.result ? {
            sync_status: r.result.status,
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
      }));
    }

    // v0.42.7 (#1696): brain-wide extraction-lag nudge after the --all wave.
    // Best-effort, stderr-only; skipped on dry-run.
    if (!dryRun) await maybeExtractionNudge(engine);

    if (errCount > 0) process.exit(1);
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
    repoPath, dryRun, full, noPull, noEmbed, noExtract, skipFailed, retryFailed, noSchemaPack, sourceId,
    strategy: strategyArg, concurrency,
    signal: composeAbortSignals(singleSourceInterrupt.signal, singleSourceController?.signal),
  };

  // Bug 9 — --retry-failed: before running normal sync, clear acknowledgment
  // flags so the sync picks them up as fresh work. The actual re-attempt
  // happens inside the regular incremental/full loop because once the commit
  // pointer is behind the failures, the diff naturally revisits them.
  if (retryFailed) {
    const failures = unacknowledgedSyncFailures();
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
    printSyncResult(result);
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
      result.status !== 'dry_run' &&
      result.status !== 'blocked_by_failures' &&
      result.status !== 'partial'
    ) {
      const effectiveRepoPath = opts.repoPath ?? (await getDefaultSourcePath(engine));
      if (effectiveRepoPath) {
        manageGitignore(effectiveRepoPath, engine.kind);
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
          manageGitignore(effectiveRepoPath, engine.kind);
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
