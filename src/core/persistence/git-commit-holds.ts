/**
 * Git effects held before their commit was made. A canonical page write commits in the database first; its Git
 * effect then stages and commits the file. When a commit-phase git step fails (`git_unavailable`: most often a host
 * with no Git identity, or a clean filter or hook that refuses), the effect retries every 30 s and parks after
 * PARK_AFTER_FAILURES, and the file stays uncommitted. This reads, per source and worktree, how many are retrying or
 * parked, the newest failed step with its reason code (git-diagnostic.ts; never git's own words), and the one fix that
 * moves them: the identity for that checkout when git said it has none and this host owns it, a settle preview for a
 * former binding, a retry preview for parked effects, or the owner status while they still retry on their own.
 * Read by `gbrain sync status` (`git_commit_holds`), most urgent first. A push-phase failure is a push hold
 * (git-push-holds.ts), never here.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import { readFix } from '../ops/op-fix.ts';
import { shellQuote } from '../shell-quote.ts';
import { GIT_COMMIT_CODES } from './sync-status-sql.ts';
import { storedGitDiagnostic, type GitDiagnostic } from './git-diagnostic.ts';
import { existingHostIdFor } from './identity.ts';

export interface GitCommitHold {
  source_id: string;
  /** The managed checkout the effects commit in: the owner host's binding path; when this host owns it, only its own (null without one); else, when no owner binding is known, the first binding path. */
  root: string | null;
  /** Whether the worktree's owner is this host (`this_host`), another host, or not known here. */
  owner_host: 'this_host' | 'other_host' | 'unknown';
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

/** This host's id, or null when it has none yet (or the engine was opened without one). */
function thisHost(engine: BrainEngine): string | null {
  try { return existingHostIdFor(engine)?.toLowerCase() ?? null; } catch { return null; }
}

/** Most urgent first: a question for the user (an identity this host can set), a former worktree's parked effects, other parked ones, then retrying. */
const rank = (hold: GitCommitHold) => hold.fix.ask_user ? 0 : hold.parked && hold.former_worktree ? 1 : hold.parked ? 2 : 3;

export async function readGitCommitHolds(engine: BrainEngine, sourceIds?: string[]): Promise<GitCommitHold[]> {
  const rows = await engine.listGitPushHoldRows([...GIT_COMMIT_CODES], sourceIds ?? null);
  const host = rows.length ? thisHost(engine) : null;
  const holds = rows.map(row => {
    const last = storedGitDiagnostic(row.last_error);
    const owner = row.owner_host_id ? row.owner_host_id.toLowerCase() : null;
    const owner_host: GitCommitHold['owner_host'] = !owner || !host ? 'unknown' : owner === host ? 'this_host' : 'other_host';
    // This host's own binding only: another host's path is never the target of a local command.
    const root = owner_host === 'this_host' ? row.owner_root : row.owner_root ?? row.root;
    const hold = { source_id: row.source_id, root, owner_host, retrying: Number(row.retrying), parked: Number(row.parked), codes: row.codes,
      oldest_at: new Date(row.oldest_at).toISOString(), former_worktree: row.former_worktree === true, last_error: last, identity_missing: last?.identity === true };
    return { ...hold, fix: gitCommitFix(hold) };
  });
  // A stable sort: holds of one rank keep the engine's source and worktree order.
  return holds.map((hold, i) => ({ hold, i })).sort((a, b) => rank(a.hold) - rank(b.hold) || a.i - b.i).map(({ hold }) => hold);
}

/** One line for `gbrain sync status`: counts, codes, step and reason code. */
export function gitCommitHoldLine(hold: Omit<GitCommitHold, 'fix'>): string {
  // An effect recorded before steps were kept may have failed after its commit (a push timeout), so it claims nothing.
  if (!hold.last_error) return `git effects blocked, commit state not recorded: ${hold.retrying} retrying, ${hold.parked} parked (${hold.codes.join(', ')}) since ${hold.oldest_at}; step not recorded`;
  // The newest step is a commit step, but older effects in the same group may have failed at a push, so "held", not "not made".
  return `git commits held: ${hold.retrying} retrying, ${hold.parked} parked (${hold.codes.join(', ')}) since ${hold.oldest_at} at step ${hold.last_error.step} (reason: ${hold.last_error.reason})${hold.identity_missing ? '; this checkout has no Git identity (user.name, user.email)' : ''}`;
}

const statusVerify = (sourceId: string) => ({ argv: ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'] });

function gitCommitFix(hold: Omit<GitCommitHold, 'fix'>): Action {
  const held = hold.retrying + hold.parked;
  const code = hold.codes[0] ?? GIT_COMMIT_CODES[0];
  const retry = `gbrain sources writer retry-effects ${shellQuote(hold.source_id)} --parked-code ${shellQuote(code)} --dry-run`;
  if (hold.parked && hold.former_worktree) return {
    argv: ['gbrain', 'sources', 'writer', 'settle-effects', hold.source_id, '--parked-code', code, '--dry-run'], consent: [], actor: 'agent', requires_exclusive: false,
    why: `${hold.parked} Git effect(s) of source ${hold.source_id} parked on a failed commit (${hold.codes.join(', ')}) in a worktree the source is no longer bound to, so no retry reaches them. This previews settling or retiring each one; it changes nothing.`,
    verify: statusVerify(hold.source_id),
  };
  if (hold.identity_missing && hold.root && hold.owner_host === 'this_host') {
    const root = shellQuote(hold.root);
    return {
      ask_user: true, consent: [], actor: 'user', requires_exclusive: false,
      argv: ['git', '-C', hold.root, 'config', '--show-origin', '--get-regexp', '^user\\.'],
      why: 'Read-only: shows which commit identity this checkout sees (none, which is why its commits fail).',
      user_message: `Git cannot commit page files in ${hold.root}: the checkout has no commit identity (user.name, user.email), so ${held} Git backup(s) of page writes in source ${hold.source_id} are not committed (nothing is lost; the database has every write). Which name and email should commits in this checkout use? Set them with git -C ${root} config user.name "<name>" and git -C ${root} config user.email "<email>"; retrying effects then commit on their own${hold.parked ? `, and ${retry} previews one more attempt for the ${hold.parked} parked one(s)` : ''}.`,
      verify: statusVerify(hold.source_id), docs: 'docs/guides/concurrent-writes.md#managed-git-identity',
    };
  }
  // The owner host makes the commits; an identity set on any other host changes nothing.
  const elsewhere = hold.identity_missing ? ` git said the owner's checkout has no commit identity (user.name, user.email); set it on the owner host${hold.owner_host === 'other_host' ? ' (not this one)' : ''}, which gbrain sources writer status --source ${shellQuote(hold.source_id)} names.` : '';
  if (hold.parked) return {
    argv: ['gbrain', 'sources', 'writer', 'retry-effects', hold.source_id, '--parked-code', code, '--dry-run'], consent: [], actor: 'agent', requires_exclusive: false,
    why: `${hold.parked} Git effect(s) of source ${hold.source_id} parked after repeated commit failures (${hold.codes.join(', ')})${hold.last_error ? ` at git step ${hold.last_error.step} (reason: ${hold.last_error.reason})` : ''};${elsewhere} fix the cause in the checkout first (git -C ${hold.root ? shellQuote(hold.root) : '<checkout>'} status on the owner host shows it), then this previews one more attempt for each; it changes nothing.`,
    verify: statusVerify(hold.source_id),
  };
  return readFix(`${hold.retrying} Git effect(s) of source ${hold.source_id} retry their commit on their own (${hold.codes.join(', ')})${hold.last_error ? `, failing at git step ${hold.last_error.step} (reason: ${hold.last_error.reason})` : ''};${elsewhere} the owner status shows their next attempt and parks them after 5 failures.`,
    { argv: statusVerify(hold.source_id).argv });
}
