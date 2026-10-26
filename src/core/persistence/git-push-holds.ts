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
import { join } from 'node:path';
import { readIntegrateConflict, type IntegrateConflictState } from '../git/commit-push.ts';
import { SCAN_ALLOW_FILENAME } from '../secret-scan-allowlist.ts';
import { GITHUB_PUSH_MAX_BYTES, PUSH_MAX_PACK_BYTES_KEY } from './push-preflight.ts';

/** The error codes of a Git effect whose commit is local but whose push did not land. */
export const GIT_PUSH_CODES = ['git_push_unavailable', 'push_unconfirmed', 'integrate_conflict', 'git_push_in_progress', 'git_push_secret_found', 'git_push_pack_too_large'] as const;
/** Wave C 1A: push holds parked at once, whose fix asks the user first (push-scan.ts, push-preflight.ts). */
const ASK_FIRST_CODES = ['git_push_secret_found', 'git_push_pack_too_large'];

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
  /** What a parked secret or over-cap hold recorded: the commit, path, rule and fingerprint, or the commit's bytes and the cap. */
  held: Record<string, unknown> | null;
  fix: Action;
}

export async function readGitPushHolds(engine: BrainEngine, sourceIds?: string[]): Promise<GitPushHold[]> {
  const rows = await engine.executeRaw<{ source_id: string; root: string | null; retrying: number; parked: number; codes: string[]; oldest_at: string | Date; held: string | null }>(
    `WITH held AS (
       SELECT e.source_id, e.worktree_id, e.state, r.created_at,
              CASE WHEN e.error_code='targets_parked' THEN (SELECT p->>'error_code' FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) p
                WHERE p->>'error_code'=ANY($1::text[]) LIMIT 1) ELSE e.error_code END AS code,
              (SELECT p->>'rule' FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) p
                WHERE p->>'error_code'=ANY($3::text[]) LIMIT 1) AS held
         FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
        WHERE e.kind='git' AND e.state IN ('queued','running','failed') AND e.recovery IS NULL
          AND ($2::text[] IS NULL OR e.source_id=ANY($2::text[])))
     SELECT h.source_id, (SELECT b.local_path FROM persistence_host_bindings b WHERE b.worktree_id=h.worktree_id ORDER BY b.local_path LIMIT 1) AS root,
            count(*) FILTER (WHERE h.state<>'failed')::int AS retrying, count(*) FILTER (WHERE h.state='failed')::int AS parked,
            array_agg(DISTINCT h.code ORDER BY h.code) AS codes, min(h.created_at) AS oldest_at, min(h.held) AS held
       FROM held h WHERE h.code=ANY($1::text[])
      GROUP BY h.source_id, h.worktree_id ORDER BY h.source_id`, [[...GIT_PUSH_CODES], sourceIds ?? null, ASK_FIRST_CODES]);
  return rows.map(row => {
    const conflict = row.root ? readIntegrateConflict(row.root) : null;
    const hold = { source_id: row.source_id, root: row.root, retrying: Number(row.retrying), parked: Number(row.parked), codes: row.codes,
      oldest_at: new Date(row.oldest_at).toISOString(), conflict, held: parseHeld(row.held) };
    return { ...hold, fix: gitPushFix(hold) };
  });
}

function parseHeld(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try { const doc = JSON.parse(raw); return doc && typeof doc === 'object' ? doc as Record<string, unknown> : null; } catch { return null; }
}

/**
 * Wave C 1A (§17 default 3): a parked secret hold asks the user to rotate the credential and allowlist its fingerprint
 * through `gbrain git commit-push`, never a history rewrite; a parked over-cap hold asks the host owner to raise
 * `git.push_max_pack_bytes`. Both then retry the parked pushes.
 */
function askFirstFix(hold: Omit<GitPushHold, 'fix'>): Action | null {
  const held = hold.held ?? {};
  const text = (key: string) => typeof held[key] === 'string' ? held[key] as string : null;
  const retry = `gbrain sources writer retry-effects ${hold.source_id} --parked-pushes`;
  if (hold.codes.includes('git_push_secret_found')) {
    const commit = text('commit')?.slice(0, 12) ?? 'an unpushed commit';
    const fingerprint = text('fingerprint') ?? 'the fingerprint gbrain sources writer status shows';
    const allowFile = hold.root ? join(hold.root, SCAN_ALLOW_FILENAME) : SCAN_ALLOW_FILENAME;
    return {
      ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
      ...(hold.root ? { argv: ['gbrain', 'git', 'commit-push', '--path', hold.root, '-m', 'gbrain: allow a rotated credential fingerprint', '--', SCAN_ALLOW_FILENAME] } : {}),
      why: 'The commit and its credential belong to the user: only they can rotate it and decide it may stay in history, and gbrain never rewrites history.',
      user_message: `Commit ${commit} adds ${text('path') ?? 'a large file'} with a credential-shaped value (rule ${text('rule') ?? 'unknown'}, fingerprint ${fingerprint}), so ${hold.parked} Git backup(s) of page writes in source ${hold.source_id} are held and nothing is pushed (nothing is lost). Please rotate that credential, then add the line ${fingerprint} to ${allowFile} and commit it with the command shown. Afterwards run ${retry}.`,
      verify: statusVerify(hold.source_id), docs: 'docs/guides/memory-boundaries.md#pushing-large-pages',
    };
  }
  if (!hold.codes.includes('git_push_pack_too_large')) return null;
  const bytes = Number(held.bytes) || 0;
  const mib = Math.ceil(bytes / 1024 ** 2);
  return {
    ask_user: true, consent: [], actor: 'host_admin', requires_exclusive: false,
    argv: ['gbrain', 'config', 'set', PUSH_MAX_PACK_BYTES_KEY, bytes ? String(Math.min(bytes + 1024 ** 2, GITHUB_PUSH_MAX_BYTES)) : '<bytes>'],
    why: 'A larger cap sends a larger single pack, which the remote and its host limits must accept, so the host owner decides.',
    user_message: `A commit ${text('commit')?.slice(0, 12) ?? ''} adds ${mib ? `${mib} MiB` : 'more'} in one pack, over the push cap (git.push_max_pack_bytes), so ${hold.parked} Git backup(s) in source ${hold.source_id} are held (nothing is lost). Raise the cap to at least that (GitHub refuses over 2 GiB), then run ${retry}?`,
    verify: statusVerify(hold.source_id), docs: 'docs/guides/memory-boundaries.md#pushing-large-pages',
  };
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
  const asked = hold.parked ? askFirstFix(hold) : null;
  if (asked) return asked;
  if (hold.parked) return {
    argv: ['gbrain', 'sources', 'writer', 'retry-effects', hold.source_id, '--parked-pushes'], consent: [], actor: 'agent', requires_exclusive: false,
    why: `${hold.parked} Git effect(s) of source ${hold.source_id} parked after repeated push failures (${hold.codes.join(', ')}); this authorizes one more push attempt for each. A push the remote rejected because it moved is merged in memory and pushed without moving the checkout. Preview with --dry-run.`,
    verify: statusVerify(hold.source_id),
  };
  return readFix(`${hold.retrying} Git effect(s) of source ${hold.source_id} retry their push on their own (${hold.codes.join(', ')}); the owner status shows their next attempt. If they keep failing, check the remote and its credentials with git push --dry-run in the checkout.`,
    { argv: statusVerify(hold.source_id).argv });
}
