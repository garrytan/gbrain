/**
 * Git effects whose commit was not made. A canonical page write commits in the database first; its Git effect then
 * stages and commits the file. When a commit-phase git step fails (`git_unavailable`: most often a host with no Git
 * identity, or a clean filter or hook that refuses), the effect retries every 30 s and parks after
 * PARK_AFTER_FAILURES, and the file stays uncommitted. This reads, per source and worktree, how many are retrying or
 * parked, the newest failed step with git's sanitized first stderr line (git-diagnostic.ts), and the one fix that moves
 * them: the identity for that checkout when git said it has none, a settle preview for a former binding, a retry
 * preview for parked effects, or the owner status while they still retry on their own.
 * Read by `gbrain sync status` (`git_commit_holds`). A push-phase failure is a push hold (git-push-holds.ts), never here.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { readFix } from '../ops/op-fix.ts';
import { GIT_COMMIT_CODES } from './sync-status-sql.ts';
import type { GitDiagnostic } from './git-diagnostic.ts';

export interface GitCommitHold {
  source_id: string;
  /** The managed checkout the effects commit in, when this host has its binding. */
  root: string | null;
  /** Git effects queued for another commit attempt. */
  retrying: number;
  /** Git effects parked after repeated commit failures; only `retry-effects` runs them again. */
  parked: number;
  codes: string[];
  /** When the oldest held effect's write was submitted. */
  oldest_at: string;
  /** The effects belong to a worktree the source is no longer bound to; no retry reaches them. */
  former_worktree: boolean;
  /** The newest held effect's failed step; null for an effect recorded before steps were kept. */
  last_error: GitDiagnostic | null;
  /** git said this checkout has no commit identity (user.name / user.email). */
  identity_missing: boolean;
  fix: Action;
}

/** A stored diagnostic as a fixed-shape object, so every engine prints the same bytes (jsonb reorders keys). */
function diagnostic(value: unknown): GitDiagnostic | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.step !== 'string') return null;
  return { phase: v.phase === 'push' ? 'push' : 'commit', step: v.step, line: typeof v.line === 'string' ? v.line : null, ...(v.identity === true ? { identity: true as const } : {}) };
}

export async function readGitCommitHolds(engine: BrainEngine, sourceIds?: string[]): Promise<GitCommitHold[]> {
  const rows = await engine.listGitPushHoldRows([...GIT_COMMIT_CODES], sourceIds ?? null);
  return rows.map(row => {
    const last = diagnostic(row.last_error);
    const hold = { source_id: row.source_id, root: row.root, retrying: Number(row.retrying), parked: Number(row.parked), codes: row.codes,
      oldest_at: new Date(row.oldest_at).toISOString(), former_worktree: row.former_worktree === true, last_error: last, identity_missing: last?.identity === true };
    return { ...hold, fix: gitCommitFix(hold) };
  });
}

/** One line for `gbrain sync status`: counts, code, step and git's words. */
export function gitCommitHoldLine(hold: Omit<GitCommitHold, 'fix'>): string {
  // An effect recorded before steps were kept may have failed after its commit (a push timeout), so it claims nothing.
  if (!hold.last_error) return `git effects blocked, commit state not recorded: ${hold.retrying} retrying, ${hold.parked} parked (${hold.codes.join(', ')}) since ${hold.oldest_at}; step not recorded`;
  const step = ` at step ${hold.last_error.step}${hold.last_error.line ? `: "${hold.last_error.line}"` : ''}`;
  return `git commits not made: ${hold.retrying} retrying, ${hold.parked} parked (${hold.codes.join(', ')}) since ${hold.oldest_at}${step}${hold.identity_missing ? '; this checkout has no Git identity (user.name, user.email)' : ''}`;
}

const statusVerify = (sourceId: string) => ({ argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });

function gitCommitFix(hold: Omit<GitCommitHold, 'fix'>): Action {
  const held = hold.retrying + hold.parked;
  const code = hold.codes[0] ?? GIT_COMMIT_CODES[0];
  const retry = `gbrain sources writer retry-effects ${hold.source_id} --parked-code ${code} --dry-run`;
  if (hold.parked && hold.former_worktree) return {
    argv: ['gbrain', 'sources', 'writer', 'settle-effects', hold.source_id, '--parked-code', code, '--dry-run'], consent: [], actor: 'agent', requires_exclusive: false,
    why: `${hold.parked} Git effect(s) of source ${hold.source_id} parked on a failed commit (${hold.codes.join(', ')}) in a worktree the source is no longer bound to, so no retry reaches them. This previews settling or retiring each one; it changes nothing.`,
    verify: statusVerify(hold.source_id),
  };
  if (hold.identity_missing && hold.root) return {
    ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
    argv: ['git', '-C', hold.root, 'config', '--show-origin', '--get-regexp', '^user\\.'],
    why: 'Read-only: shows which commit identity this checkout sees (none, which is why its commits fail).',
    user_message: `Git cannot commit page files in ${hold.root}: the checkout has no commit identity (user.name, user.email), so ${held} Git backup(s) of page writes in source ${hold.source_id} are not committed (nothing is lost; the database has every write). Which name and email should commits in this checkout use? Set them with git -C ${hold.root} config user.name "<name>" and git -C ${hold.root} config user.email "<email>"; retrying effects then commit on their own${hold.parked ? `, and ${retry} previews one more attempt for the ${hold.parked} parked one(s)` : ''}.`,
    verify: statusVerify(hold.source_id), docs: 'docs/guides/concurrent-writes.md#managed-git-identity',
  };
  if (hold.parked) return {
    argv: ['gbrain', 'sources', 'writer', 'retry-effects', hold.source_id, '--parked-code', code, '--dry-run'], consent: [], actor: 'agent', requires_exclusive: false,
    why: `${hold.parked} Git effect(s) of source ${hold.source_id} parked after repeated commit failures (${hold.codes.join(', ')})${hold.last_error ? ` at git step ${hold.last_error.step}` : ''}; fix the cause in the checkout first (git -C ${hold.root ?? '<checkout>'} status shows it), then this previews one more attempt for each; it changes nothing.`,
    verify: statusVerify(hold.source_id),
  };
  return readFix(`${hold.retrying} Git effect(s) of source ${hold.source_id} retry their commit on their own (${hold.codes.join(', ')})${hold.last_error ? `, failing at git step ${hold.last_error.step}` : ''}; the owner status shows their next attempt and parks them after 5 failures.`,
    { argv: statusVerify(hold.source_id).argv });
}
