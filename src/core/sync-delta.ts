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
import { execFileSync } from './spawn.ts';
import { buildSyncManifest, type SyncManifest } from './sync.ts';
import { GIT_READ_ENV, gitChildEnv } from './git-env.ts';
import { classifyGitPathBytes, displayBytePath, type UnsupportedPathReason } from './sync-byte-paths.ts';

/** Runs a git subcommand in `repoPath` and returns trimmed stdout (throws on failure). */
export type GitRunner = (repoPath: string, args: string[]) => string;

// Mirrors `git()` + `buildGitInvocation()` in commands/sync.ts: `core.quotepath=false`
// so non-ASCII (CJK) paths arrive as UTF-8; 30s timeout; 100 MiB maxBuffer (a
// 100K-file `--name-status` diff tops out ~10-20 MiB — Node's 1 MiB default
// would ENOBUFS-crash the sync with no log line).
const DEFAULT_GIT_RUNNER: GitRunner = (repoPath, args) =>
  execFileSync('git', ['-c', 'core.quotepath=false', '-C', repoPath, ...args], {
    env: gitChildEnv(GIT_READ_ENV),
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

/** Merges a working-tree manifest into a commit-range manifest (paths deduplicated; renames and #6729 downgrades appended). */
export function mergeSyncManifests(into: SyncManifest, from: SyncManifest): SyncManifest {
  const downgradedRenames = [...(into.downgradedRenames ?? []), ...(from.downgradedRenames ?? [])];
  return {
    added: unique([...into.added, ...from.added]),
    modified: unique([...into.modified, ...from.modified]),
    deleted: unique([...into.deleted, ...from.deleted]),
    renamed: [...into.renamed, ...from.renamed],
    ...(downgradedRenames.length ? { downgradedRenames } : {}),
  };
}

/**
 * Working-tree manifest: tracked changes (`git diff --name-status -M HEAD`)
 * PLUS untracked files (`ls-files --others --exclude-standard`). Built for
 * EVERY sync now, not just detached HEADs (the name predates that): detached
 * HEADs always import it; attached HEADs use it to count uncommitted drift
 * (`SyncResult.uncommitted` + stderr warning) and, under `--working-tree` /
 * `sync.include_working_tree`, to import uncommitted state through the same
 * merge path. The ESTIMATOR still prices working-tree files only for detached
 * sources — attached repos import only the commit diff by default, so pricing
 * dirty files there would re-introduce the #2139 phantom-cost class (the
 * --working-tree opt-in is deliberately not priced; see SyncOpts.workingTree).
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
  return { status: 'ok', manifest: detached ? mergeSyncManifests(manifest, detached) : manifest };
}

/** Runs a read-only git subcommand in `repoPath` and returns its stdout bytes untouched (throws on failure). */
export type GitBytesRunner = (repoPath: string, args: string[]) => Buffer;

const DEFAULT_GIT_BYTES_RUNNER: GitBytesRunner = (repoPath, args) =>
  execFileSync('git', ['-C', repoPath, ...args], { env: gitChildEnv(GIT_READ_ENV), timeout: 30_000, maxBuffer: 100 * 1024 * 1024 });

let _gitBytesRunner: GitBytesRunner = DEFAULT_GIT_BYTES_RUNNER;

/** Test seam for the lossless parser; `null` restores the default. */
export function _setGitBytesRunnerForTests(fn: GitBytesRunner | null): void {
  _gitBytesRunner = fn ?? DEFAULT_GIT_BYTES_RUNNER;
}

/** A delta path that is not a usable page path (not UTF-8, or a control character), as its exact bytes. */
export interface UnsupportedGitPath { raw: Buffer; reason: UnsupportedPathReason }

/**
 * Classic sync's delta read as bytes (GBRA-133): the manifest of every path that decodes as UTF-8 without a control
 * character, exactly as Git has it (no trim, no unquoting), plus what the text manifest cannot carry: `unsupported`
 * paths present after the range, `gone` unsupported paths that left the tree, and gitlinks (submodules, embedded
 * repositories) that appeared, which sync does not follow.
 */
export interface LosslessDelta {
  manifest: SyncManifest;
  unsupported: UnsupportedGitPath[];
  gone: Buffer[];
  gitlinks: string[];
}

export type LosslessDeltaResult = ({ status: 'ok' } & LosslessDelta) | { status: 'unavailable'; reason: 'anchor_missing' | 'diff_failed' };

function splitNul(out: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  for (let start = 0; start < out.length;) {
    const end = out.indexOf(0, start);
    if (end === -1) { fields.push(out.subarray(start)); break; }
    fields.push(out.subarray(start, end));
    start = end + 1;
  }
  return fields;
}

/** Parses `git diff --raw -z -M` output. Status letters map as `buildSyncManifest` maps them; a gitlink (mode 160000) never enters the manifest. */
export function parseRawDiffZ(out: Buffer): LosslessDelta {
  const delta: LosslessDelta = { manifest: { added: [], modified: [], deleted: [], renamed: [] }, unsupported: [], gone: [], gitlinks: [] };
  const { manifest } = delta;
  const present = (raw: Buffer, list: string[]) => {
    const parsed = classifyGitPathBytes(raw);
    if ('path' in parsed) list.push(parsed.path);
    else delta.unsupported.push({ raw: Buffer.from(raw), reason: parsed.reason });
  };
  const left = (raw: Buffer) => {
    const parsed = classifyGitPathBytes(raw);
    if ('path' in parsed) manifest.deleted.push(parsed.path);
    else delta.gone.push(Buffer.from(raw));
  };
  const gitlink = (raw: Buffer) => {
    const parsed = classifyGitPathBytes(raw);
    delta.gitlinks.push('path' in parsed ? parsed.path : displayBytePath(raw));
  };
  const fields = splitNul(out);
  for (let i = 0; i < fields.length;) {
    const header = fields[i++]!.toString('latin1');
    if (!header.startsWith(':')) continue;
    const [oldMode, newMode, , , status = ''] = header.slice(1).split(' ');
    const action = status[0];
    const first = fields[i++];
    if (!first) break;
    const oldLink = oldMode === '160000', newLink = newMode === '160000';
    if (action === 'R' || action === 'C') {
      const second = fields[i++];
      if (!second) break;
      if (action === 'C') { present(second, manifest.added); continue; }
      const from = classifyGitPathBytes(first), to = classifyGitPathBytes(second);
      if ('path' in from && 'path' in to) {
        const similarity = Number(status.slice(1));
        manifest.renamed.push({ from: from.path, to: to.path, ...(status.length > 1 && Number.isInteger(similarity) ? { similarity } : {}) });
        continue;
      }
      if (!('path' in from)) delta.gone.push(Buffer.from(first));
      present(second, manifest.added);
      continue;
    }
    if (newLink && !oldLink) {
      gitlink(first);
      if (action !== 'A') left(first);
      continue;
    }
    if (oldLink && newLink) continue;
    if (action === 'A') present(first, manifest.added);
    else if (action === 'M' || action === 'T' || action === 'U') present(first, manifest.modified);
    else if (action === 'D' && !oldLink) left(first);
  }
  return delta;
}

/** `computeSyncDelta` read as bytes (classic sync); the same anchor and diff ladder. */
export function computeLosslessSyncDelta(repoPath: string, fromCommit: string, toCommit: string): LosslessDeltaResult {
  const run = _gitBytesRunner;
  try {
    run(repoPath, ['cat-file', '-t', fromCommit]);
  } catch {
    return { status: 'unavailable', reason: 'anchor_missing' };
  }
  let out: Buffer;
  try {
    out = run(repoPath, ['diff', '--raw', '-z', '-M', `${fromCommit}..${toCommit}`]);
  } catch {
    return { status: 'unavailable', reason: 'diff_failed' };
  }
  return { status: 'ok', ...parseRawDiffZ(out) };
}

/** `buildDetachedWorkingTreeManifest` read as bytes (classic sync): tracked changes against HEAD plus untracked files. */
export function buildLosslessWorkingTreeManifest(repoPath: string): LosslessDelta {
  const run = _gitBytesRunner;
  const delta = parseRawDiffZ(run(repoPath, ['diff', '--raw', '-z', '-M', 'HEAD']));
  for (const raw of splitNul(run(repoPath, ['ls-files', '-z', '--others', '--exclude-standard']))) {
    if (raw.length === 0) continue;
    const parsed = classifyGitPathBytes(raw);
    if ('path' in parsed) delta.manifest.added.push(parsed.path);
    else delta.unsupported.push({ raw: Buffer.from(raw), reason: parsed.reason });
  }
  return { ...delta, manifest: { ...delta.manifest, added: unique(delta.manifest.added), modified: unique(delta.manifest.modified), deleted: unique(delta.manifest.deleted) } };
}
