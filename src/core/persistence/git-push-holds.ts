/**
 * #7010: Git effects whose push is held. A canonical page write commits in the database and in a local commit of the
 * managed checkout; its Git effect then pushes. A push that keeps failing leaves those commits on this host only:
 * the effect retries (`queued` with the push code) and parks after five failures (`targets_parked`). This reads,
 * per source, how many Git effects are retrying or parked on a push code, the oldest, and the integrate conflict the
 * shared publish recorded for the checkout, with the one fix that moves them: the user's choice for a true conflict,
 * one more attempt for parked pushes, or a read of the owner status while they still retry on their own.
 * Read by doctor (`git_push_holds`) and `gbrain sync status`.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { readFix } from '../ops/op-fix.ts';
import { readIntegrateConflict, type IntegrateConflictState } from '../git/commit-push.ts';

/** The error codes of a Git effect whose commit is local but whose push did not land (defined beside the sync status SQL that embeds them). */
import { GIT_PUSH_CODES } from './sync-status-sql.ts';
export { GIT_PUSH_CODES };

export interface GitPushHold {
  source_id: string;
  /** The managed checkout the effects push from, when this host has its binding. */
  root: string | null;
  /** Git effects queued for another push attempt after a push failure. */
  retrying: number;
  /** Git effects parked after repeated push failures; only `retry-effects` runs them again. */
  parked: number;
  codes: string[];
  /** When the oldest held effect's write was submitted. */
  oldest_at: string;
  /** The unresolved conflict the last publish recorded for the checkout (both sides changed these paths). */
  conflict: IntegrateConflictState | null;
  /** #7378: the effects belong to a worktree the source is no longer bound to; no retry reaches them, settle-effects accounts for them. */
  former_worktree: boolean;
  fix: Action;
}

export async function readGitPushHolds(engine: BrainEngine, sourceIds?: string[]): Promise<GitPushHold[]> {
  const rows = await engine.listGitPushHoldRows([...GIT_PUSH_CODES], sourceIds ?? null);
  return rows.map(row => {
    const conflict = row.root ? readIntegrateConflict(row.root) : null;
    const hold = { source_id: row.source_id, root: row.root, retrying: Number(row.retrying), parked: Number(row.parked), codes: row.codes,
      oldest_at: new Date(row.oldest_at).toISOString(), conflict, former_worktree: row.former_worktree === true };
    return { ...hold, fix: gitPushFix(hold) };
  });
}

const statusVerify = (sourceId: string) => ({ argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });

function gitPushFix(hold: Omit<GitPushHold, 'fix'>): Action {
  const held = hold.retrying + hold.parked;
  if (hold.conflict && hold.root) return {
    ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
    argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--scan-secrets', '--path', hold.root, '--expect-remote', hold.conflict.remote,
      ...hold.conflict.paths.flatMap(path => ['--resolve', `${path}=<ours|theirs>`])],
    why: 'Choosing which version of a file wins discards the other side; ask the user before resolving.',
    user_message: `This machine and the remote both changed ${hold.conflict.paths.join(', ')} in ${hold.root}, so ${held} Git backup(s) of page writes in source ${hold.source_id} are held (nothing is lost; the database has every write). Which version should win: this machine's (ours) or the remote's (theirs)? Afterwards run gbrain sources writer retry-effects ${hold.source_id} --parked-pushes, then gbrain sources refresh ${hold.source_id}.`,
    verify: statusVerify(hold.source_id), docs: 'docs/guides/shared-checkout-git.md#conflicts',
  };
  if (hold.codes.includes('publish_secret_found') && hold.root) return {
    ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
    argv: ['git', '-C', hold.root, 'log', '--stat', '@{upstream}..HEAD'],
    why: 'Lists the unpublished commits the secret scan refused; read-only. A secret pushed to the remote stays in its history.',
    user_message: `Unpublished commits in ${hold.root} hold values that look like secrets (or text too large to scan), so ${held} Git backup(s) of page writes in source ${hold.source_id} are held and nothing was pushed (nothing is lost; the database has every write). Remove the values from those commits, or confirm a false positive so its fingerprint can go in .gbrain-scan-allow? Afterwards run gbrain sources writer retry-effects ${hold.source_id} --parked-pushes.`,
    verify: statusVerify(hold.source_id), docs: 'docs/guides/shared-checkout-git.md#publish_secret_found',
  };
  if (hold.codes.includes('publish_scan_unreadable') && hold.root) return {
    ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
    argv: ['git', '-C', hold.root, 'fsck'],
    why: 'Read-only: names missing or corrupt objects in the unpublished commits, the usual reason the secret scan cannot read them.',
    user_message: `The secret scan could not read the unpublished commits in ${hold.root} (or the remote no longer has the checkout's upstream branch, which git -C ${hold.root} ls-remote --heads shows), so ${held} Git backup(s) of page writes in source ${hold.source_id} are held and nothing was pushed (nothing is lost; the database has every write). Check the checkout with git fsck and fix what it reports? Afterwards run gbrain sources writer retry-effects ${hold.source_id} --parked-pushes.`,
    verify: statusVerify(hold.source_id), docs: 'docs/guides/shared-checkout-git.md#publish_scan_unreadable',
  };
  if (hold.parked && hold.former_worktree) return {
    argv: ['gbrain', 'sources', 'writer', 'settle-effects', hold.source_id, '--parked-code', hold.codes[0]!, '--dry-run'], consent: [], actor: 'agent', requires_exclusive: false,
    why: `${hold.parked} Git effect(s) of source ${hold.source_id} failed on a push (${hold.codes.join(', ')}) in a worktree the source is no longer bound to, so no retry reaches them. This previews settling each one whose current bytes the fetched remote already holds; it changes nothing.`,
    verify: statusVerify(hold.source_id),
  };
  if (hold.parked) return {
    argv: ['gbrain', 'sources', 'writer', 'retry-effects', hold.source_id, '--parked-pushes'], consent: [], actor: 'agent', requires_exclusive: false,
    why: `${hold.parked} Git effect(s) of source ${hold.source_id} parked after repeated push failures (${hold.codes.join(', ')}); this authorizes one more push attempt for each. A push the remote rejected because it moved is merged in memory and pushed without moving the checkout. Preview with --dry-run.`,
    verify: statusVerify(hold.source_id),
  };
  return readFix(`${hold.retrying} Git effect(s) of source ${hold.source_id} retry their push on their own (${hold.codes.join(', ')}); the owner status shows their next attempt. If they keep failing, check the remote and its credentials with git push --dry-run in the checkout.`,
    { argv: statusVerify(hold.source_id).argv });
}
