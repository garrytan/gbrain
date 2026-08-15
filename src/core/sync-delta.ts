/**
 * Shared sync-delta machinery — ONE implementation of "what changed since
 * last_commit" consumed by BOTH the sync executor (`performSyncInner` in
 * `src/commands/sync.ts`) and the inline-embed cost estimator
 * (`src/core/sync-cost-estimate.ts`). Before this module the executor diffed
 * `last_commit..pin` while the estimator priced the entire tree, so the
 * gate's dollar figure had no relationship to what the sync actually embedded
 * (issue #2139: a 400x overestimate that wedged the daily cron). Routing both
 * through `computeSyncDelta` makes diff/manifest drift between estimate and
 * execution structurally impossible.
 *
 * Shell-injection safe: `execFileSync` with array args (no `/bin/sh -c`), so a
 * `sources.local_path` containing shell metacharacters can never escape — same
 * posture documented at `git-head.ts:14-19`.
 *
 * Fail-open ladder (never throws):
 *
 *   computeSyncDelta(repo, from, to)
 *        │
 *        ├─ `git cat-file -t <from>` throws  → { unavailable, anchor_missing }
 *        │    (bookmark object gc'd after a history rewrite — nothing to diff;
 *        │     caller falls back to a full reconcile / full-tree ceiling)
 *        │
 *        ├─ `git diff --name-status -M from..to` throws → { unavailable, diff_failed }
 *        │    (oversized post-rewrite diff exceeds the 30s / 100 MiB budget)
 *        │
 *        └─ ok → { ok, manifest }   (+ detached working-tree manifest merged in)
 *
 * NOTE: a present-but-non-ancestor `from` (force-push, squash, master→main) is
 * still diffable — `git diff A..B` is an endpoint-tree comparison and does NOT
 * require A to be an ancestor of B (unlike a rev-walk or `A...B` merge-base).
 * That is the #1970 property this module preserves.
 */
import { execFileSync } from 'node:child_process';
import { buildSyncManifest, type SyncManifest } from './sync.ts';

/** Runs a git subcommand in `repoPath` and returns trimmed stdout (throws on failure). */
export type GitRunner = (repoPath: string, args: string[]) => string;

// Mirrors `git()` + `buildGitInvocation()` in commands/sync.ts: `core.quotepath=false`
// so non-ASCII (CJK) paths arrive as UTF-8; 30s timeout; 100 MiB maxBuffer (a
// 100K-file `--name-status` diff tops out ~10-20 MiB — Node's 1 MiB default
// would ENOBUFS-crash the sync with no log line).
const DEFAULT_GIT_RUNNER: GitRunner = (repoPath, args) =>
  execFileSync('git', ['-c', 'core.quotepath=false', '-C', repoPath, ...args], {
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 100 * 1024 * 1024,
  }).trim();

let _gitRunner: GitRunner = DEFAULT_GIT_RUNNER;

/**
 * Test seam (probe-seam pattern, matches `git-head.ts:_setGitHeadProbeForTests`)
 * so tests drive `computeSyncDelta` without mocking child_process or routing
 * through `mock.module` (R2-compliant). Pass `null` to restore the default.
 */
export function _setGitRunnerForTests(fn: GitRunner | null): void {
  _gitRunner = fn ?? DEFAULT_GIT_RUNNER;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * Working-tree manifest for a DETACHED HEAD (relocated from sync.ts:557 so the
 * estimator can price detached sources identically to how the executor imports
 * them). On a detached HEAD, sync syncs from the live working tree: tracked
 * changes (`git diff --name-status -M HEAD`) PLUS untracked files (`ls-files
 * --others --exclude-standard`). Attached HEADs never call this — their
 * incremental path imports ONLY the commit diff (untracked/dirty files are not
 * imported), which is why the estimator must not price dirty files on an
 * attached repo (issue #2139 phantom-cost class).
 */
export function buildDetachedWorkingTreeManifest(
  repoPath: string,
  run: GitRunner = _gitRunner,
): SyncManifest {
  const manifest = buildSyncManifest(run(repoPath, ['diff', '--name-status', '-M', 'HEAD']));
  const untracked = run(repoPath, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(line => line.length > 0);
  return {
    added: unique([...manifest.added, ...untracked]),
    modified: unique(manifest.modified),
    deleted: unique(manifest.deleted),
    renamed: manifest.renamed,
  };
}

export type SyncDeltaResult =
  | { status: 'ok'; manifest: SyncManifest }
  | { status: 'unavailable'; reason: 'anchor_missing' | 'diff_failed' };

export interface ComputeSyncDeltaOpts {
  /**
   * Pre-computed detached working-tree manifest to merge into the commit diff
   * (the executor already builds one for its `up_to_date` gate; pass it to
   * avoid a redundant `git diff HEAD` + `ls-files`). When omitted and
   * `detached` is true, this module builds it.
   */
  detachedManifest?: SyncManifest | null;
  /** Build the detached manifest internally (estimator path). Ignored if `detachedManifest` is provided. */
  detached?: boolean;
}

/**
 * The single source of truth for "what changed between two commits in this
 * repo." Returns the RAW merged manifest (added/modified/deleted/renamed) —
 * callers apply their own `isSyncable` filtering + side effects.
 */
export function computeSyncDelta(
  repoPath: string,
  fromCommit: string,
  toCommit: string,
  opts: ComputeSyncDeltaOpts = {},
): SyncDeltaResult {
  const run = _gitRunner;

  // Reachability: a gc'd bookmark object can't be diffed (#1970).
  try {
    run(repoPath, ['cat-file', '-t', fromCommit]);
  } catch {
    return { status: 'unavailable', reason: 'anchor_missing' };
  }

  let diffOutput: string;
  try {
    diffOutput = run(repoPath, ['diff', '--name-status', '-M', `${fromCommit}..${toCommit}`]);
  } catch {
    return { status: 'unavailable', reason: 'diff_failed' };
  }

  const manifest = buildSyncManifest(diffOutput);

  const detached =
    opts.detachedManifest !== undefined && opts.detachedManifest !== null
      ? opts.detachedManifest
      : opts.detached
        ? buildDetachedWorkingTreeManifest(repoPath, run)
        : null;
  if (detached) {
    manifest.added = unique([...manifest.added, ...detached.added]);
    manifest.modified = unique([...manifest.modified, ...detached.modified]);
    manifest.deleted = unique([...manifest.deleted, ...detached.deleted]);
    manifest.renamed = [...manifest.renamed, ...detached.renamed];
  }

  return { status: 'ok', manifest };
}
