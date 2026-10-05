/**
 * Upstream observation for remote-tracking sources (#5255/#5176, O-DX-8).
 *
 * Sync records, from the checkout's own Git state, the last time anything
 * observed the upstream (a fetch, pull or push by any process: FETCH_HEAD and
 * the upstream ref's reflog), the upstream commit it saw, and how many of its
 * commits the source's synced commit lacks. doctor `sync_freshness` reads the
 * three `sources.upstream_*` columns, so a remote doctor needs no subprocess.
 * A missing or older-than-24 h observation is "upstream unknown", never fresh.
 */
import { execFileSync } from './spawn.ts';
import { statSync } from 'node:fs';
import type { BrainEngine } from './engine.ts';
import { ERROR_CATALOGUE } from './error-catalogue.ts';
import { parseSourceConfig, sourceConfigHasRemoteUrl } from './sources-load.ts';

export const UPSTREAM_OBSERVATION_MAX_AGE_HOURS = 24;

/** How a cycle's sync phase treated the requested upstream refresh (cycle sync `details.upstream_refresh`). */
export type UpstreamRefresh = 'pulled' | 'failed' | 'skipped_managed' | 'not_requested';

export interface UpstreamObservation { checkedAt: Date; commit: string; behind: number | null }

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function mtime(path: string | null): number {
  if (!path) return 0;
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

/** Whether the checkout's branch tracks an upstream (a `git pull` would have something to refresh). */
export function tracksUpstream(root: string): boolean {
  return git(root, ['rev-parse', '--verify', '-q', '@{upstream}']) !== null;
}

/** Reads the checkout's upstream state; null when it has no upstream or none was ever fetched or pushed. */
export function observeUpstream(root: string, syncedCommit: string | null): UpstreamObservation | null {
  const commit = git(root, ['rev-parse', '--verify', '-q', '@{upstream}^{commit}']);
  const ref = commit && git(root, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
  if (!commit || !ref) return null;
  const checkedMs = Math.max(
    mtime(git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'FETCH_HEAD'])),
    mtime(git(root, ['rev-parse', '--path-format=absolute', '--git-path', `logs/${ref}`])),
  );
  if (checkedMs === 0) return null;
  const count = syncedCommit ? git(root, ['rev-list', '--count', `${syncedCommit}..${commit}`]) : null;
  return { checkedAt: new Date(checkedMs), commit, behind: count === null ? null : Number(count) };
}

/** Best-effort: never fails a sync. Compares the upstream with the source's synced commit as stored after the run. */
export async function recordUpstreamObservation(engine: BrainEngine, sourceId: string, repoPath?: string): Promise<void> {
  try {
    const [source] = await engine.executeRaw<{ local_path: string | null; last_commit: string | null }>(
      'SELECT local_path,last_commit FROM sources WHERE id=$1', [sourceId]);
    const root = repoPath ?? source?.local_path;
    if (!source || !root) return;
    const observed = observeUpstream(root, source.last_commit);
    if (!observed) return;
    await engine.executeRaw('UPDATE sources SET upstream_checked_at=$2::timestamptz,upstream_commit=$3,upstream_behind=$4 WHERE id=$1',
      [sourceId, observed.checkedAt.toISOString(), observed.commit, observed.behind]);
  } catch {
    // Pre-migration brain or unreadable checkout: freshness stays "upstream unknown".
  }
}

/** The managed refresh: a drained, worktree-wide fast-forward of the checkout followed by the managed sync (F0). */
const managedRefreshFix = (sourceId: string) => `gbrain sources refresh ${sourceId}`;

export interface ManagedPullWarning { code: string; cause: string; fix: string; docs: string }

/** #5255: the cycle warn for a skipped pull, only when the checkout tracks an upstream a pull would have refreshed. */
export function managedPullWarning(sourceId: string, checkout: string): ManagedPullWarning | undefined {
  if (!tracksUpstream(checkout)) return undefined;
  return {
    code: ERROR_CATALOGUE.managed_pull_skipped.code,
    cause: 'Managed brains do not run git pull inside a cycle; this sync imported the checkout as it is, so new upstream commits are not in the brain.',
    fix: managedRefreshFix(sourceId),
    docs: ERROR_CATALOGUE.managed_pull_skipped.docs,
  };
}

/**
 * O-DX-8: doctor's "upstream checked" verdict, separate from "local projection
 * current". A Git source (no connector `kind`) with a `remote_url` and no
 * observation, or one older than 24 h, is upstream unknown; any source whose last observation saw upstream
 * commits its synced commit lacks is behind. Null when neither applies.
 */
export function upstreamFreshness(
  source: { id: string; local_path: string | null; config: unknown; upstream_checked_at: Date | null; upstream_behind: number | null },
  display: string, now: number, managed: boolean,
): { state: 'unknown' | 'behind'; issue: string } | null {
  const checkedMs = source.upstream_checked_at ? new Date(source.upstream_checked_at).getTime() : null;
  const behind = source.upstream_behind ?? 0;
  const ageHours = checkedMs === null ? null : Math.floor((now - checkedMs) / 3_600_000);
  const gitRemote = sourceConfigHasRemoteUrl(source.config) && parseSourceConfig(source.config).kind == null;
  const unknown = gitRemote && (ageHours === null || ageHours >= UPSTREAM_OBSERVATION_MAX_AGE_HOURS);
  if (!unknown && behind <= 0) return null;
  const fix = managed ? managedRefreshFix(source.id) : `gbrain sync --source ${source.id}`;
  const fact = unknown
    ? `upstream unknown (${ageHours === null ? 'never checked' : `last checked ${ageHours}h ago`})`
    : `upstream ${behind} commit(s) ahead of the synced commit`;
  return {
    state: unknown ? 'unknown' : 'behind',
    issue: `Source ${display} ${fact}; local projection is not proof of freshness. Fix: ${fix} (${ERROR_CATALOGUE.managed_pull_skipped.docs})`,
  };
}
