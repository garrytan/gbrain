/**
 * v0.41.27.0 — git HEAD freshness probe for `gbrain doctor`.
 *
 * Single primitive. Returns true iff a `local_path` directory is a git repo
 * whose current HEAD matches the `last_commit` SHA the DB recorded at last
 * sync completion. When `requireCleanWorkingTree` is set, also requires the
 * working tree to be clean — mirroring `gbrain sync`'s force-walk gate at
 * sync.ts:1075 so doctor and sync agree on "is there work to do?".
 *
 * Fail-open contract: any error (missing path, not a git repo, git not
 * installed, timeout, NULL inputs, dirty probe errored) returns `false`,
 * which preserves the caller's prior time-based behavior. We never raise.
 *
 * Shell-injection safe: uses execFileSync with array args so a `local_path`
 * containing `$(...)`, backticks, or other shell metacharacters can never
 * escape to a shell. The PR #1564 community version used
 * `execSync(`git -C ${JSON.stringify(path)} ...`)`, which runs through
 * `/bin/sh -c` — `JSON.stringify` escapes for JSON, not shell, so a
 * mutable `sources.local_path` was an RCE-style surface.
 *
 * Designed for reuse: autopilot's per-source dispatch will want the same
 * gate. See plan note "v0.41.27.1+ TODOs" in
 * ~/.claude/plans/system-instruction-you-are-working-eager-bird.md.
 */
import { execFileSync } from 'node:child_process';

export type GitHeadProbe = (localPath: string) => string | null;
// `null` distinguishes probe error from known-dirty (false). Doctor treats
// both as "do not short-circuit", but tests need to assert which path fired.
// `ignoreUntracked` (v0.41.32.0): when true, untracked files (`git status`
// `??` rows) do NOT count as dirty — they are not part of the repo and sync's
// incremental path (commit-diff at sync.ts:1057) never imports them, so a
// quiet repo with stray untracked dirs is still "unchanged".
export type GitCleanProbe = (localPath: string, ignoreUntracked?: boolean) => boolean | null;

const DEFAULT_HEAD_PROBE: GitHeadProbe = (localPath) => {
  try {
    const out = execFileSync('git', ['-C', localPath, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
};

const DEFAULT_CLEAN_PROBE: GitCleanProbe = (localPath, ignoreUntracked) => {
  try {
    // `--untracked-files=no` makes `git status --porcelain` emit ONLY tracked
    // changes. Empty output then means "clean ignoring untracked." This is the
    // v0.41.32.0 fix for the false-SEVERE bug: untracked dirs (`?? companies/`,
    // `?? media/`) on an otherwise-caught-up repo previously made the tree look
    // dirty and defeated the short-circuit.
    const args = ['-C', localPath, 'status', '--porcelain'];
    if (ignoreUntracked) args.push('--untracked-files=no');
    const out = execFileSync('git', args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length === 0;
  } catch {
    return null;
  }
};

let _headProbe: GitHeadProbe = DEFAULT_HEAD_PROBE;
let _cleanProbe: GitCleanProbe = DEFAULT_CLEAN_PROBE;

// Test seam. Matches the `_setChatTransportForTests` precedent at
// src/core/last-retrieved.ts so tests can drive the public function
// without mocking child_process or routing through mock.module (R2-compliant).
export function _setGitHeadProbeForTests(fn: GitHeadProbe | null): void {
  _headProbe = fn ?? DEFAULT_HEAD_PROBE;
}

export function _setGitCleanProbeForTests(fn: GitCleanProbe | null): void {
  _cleanProbe = fn ?? DEFAULT_CLEAN_PROBE;
}

export interface GitFreshnessOpts {
  /**
   * Working-tree cleanliness requirement on top of the HEAD==lastCommit check:
   *   - `false`/omitted: HEAD comparison only.
   *   - `true`: require a fully clean tree (tracked AND untracked) — the
   *     v0.41.27.0 posture mirroring `gbrain sync`'s gate at sync.ts:1075.
   *   - `'ignore-untracked'` (v0.41.32.0): require no TRACKED changes but allow
   *     untracked files. This is what doctor/sources should use: sync's
   *     incremental path keys off the commit diff and never imports untracked
   *     files, so a quiet repo with stray untracked dirs is genuinely caught up.
   *     Fixes the false-SEVERE bug without weakening the commit-hash gate.
   */
  requireCleanWorkingTree?: boolean | 'ignore-untracked';
}

/**
 * Returns true iff `localPath` is a git repo whose current HEAD matches
 * `lastCommit`, AND (when `requireCleanWorkingTree`) the working tree
 * is clean.
 *
 * This is NOT a full mirror of `gbrain sync`'s "do work?" predicate.
 * Chunker-version match is computed by the caller because it depends on
 * engine state (`sources.chunker_version` vs `CURRENT_CHUNKER_VERSION`).
 * See `src/commands/doctor.ts:checkSyncFreshness` for the AND
 * combination at the call site.
 */
export function isSourceUnchangedSinceSync(
  localPath: string | null | undefined,
  lastCommit: string | null | undefined,
  opts?: GitFreshnessOpts,
): boolean {
  if (!localPath || !lastCommit) return false;
  const head = _headProbe(localPath);
  if (head === null || head !== lastCommit) return false;
  if (opts?.requireCleanWorkingTree) {
    const ignoreUntracked = opts.requireCleanWorkingTree === 'ignore-untracked';
    const isClean = _cleanProbe(localPath, ignoreUntracked);
    // null (probe error) AND false (known dirty) both fail the gate.
    if (isClean !== true) return false;
  }
  return true;
}
