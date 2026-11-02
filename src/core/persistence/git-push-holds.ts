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

/** The error codes of a Git effect whose commit is local but whose push did not land. */
export const GIT_PUSH_CODES = ['git_push_unavailable', 'push_unconfirmed', 'integrate_conflict'] as const;

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
  const rows = await engine.executeRaw<{ source_id: string; root: string | null; former_worktree: boolean; retrying: number; parked: number; codes: string[]; oldest_at: string | Date }>(
    `WITH held AS (
       SELECT e.source_id, e.worktree_id, e.state, r.created_at,
              CASE WHEN e.error_code='targets_parked' THEN (SELECT p->>'error_code' FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) p
                WHERE p->>'error_code'=ANY($1::text[]) LIMIT 1) ELSE e.error_code END AS code
         FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
        WHERE e.kind='git' AND e.state IN ('queued','running','failed') AND e.recovery IS NULL AND NOT (e.data ? 'settled')
          AND ($2::text[] IS NULL OR e.source_id=ANY($2::text[])))
     SELECT h.source_id, (SELECT b.local_path FROM persistence_host_bindings b WHERE b.worktree_id=h.worktree_id ORDER BY b.local_path LIMIT 1) AS root,
            NOT EXISTS (SELECT 1 FROM persistence_source_bindings s WHERE s.source_id=h.source_id AND s.worktree_id=h.worktree_id) AS former_worktree,
            count(*) FILTER (WHERE h.state<>'failed')::int AS retrying, count(*) FILTER (WHERE h.state='failed')::int AS parked,
            array_agg(DISTINCT h.code ORDER BY h.code) AS codes, min(h.created_at) AS oldest_at
       FROM held h WHERE h.code=ANY($1::text[])
      GROUP BY h.source_id, h.worktree_id ORDER BY h.source_id`, [[...GIT_PUSH_CODES], sourceIds ?? null]);
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
    argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', hold.root, '--expect-remote', hold.conflict.remote,
      ...hold.conflict.paths.flatMap(path => ['--resolve', `${path}=<ours|theirs>`])],
    why: 'Choosing which version of a file wins discards the other side; ask the user before resolving.',
    user_message: `This machine and the remote both changed ${hold.conflict.paths.join(', ')} in ${hold.root}, so ${held} Git backup(s) of page writes in source ${hold.source_id} are held (nothing is lost; the database has every write). Which version should win: this machine's (ours) or the remote's (theirs)? Afterwards run gbrain sources writer retry-effects ${hold.source_id} --parked-pushes, then gbrain sources refresh ${hold.source_id}.`,
    verify: statusVerify(hold.source_id), docs: 'docs/guides/shared-checkout-git.md#conflicts',
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
