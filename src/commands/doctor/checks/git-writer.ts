/**
 * #7381 (GBRA-180): writer-safety checks for the Git checkouts the brain's
 * sources live in, next to `git_convergence`. They never fetch, so "behind"
 * is as of the last fetch, and every git call is time-bounded.
 *
 *   checkout_lagging            the checkout is behind its upstream and the
 *                               oldest commit it lacks is over an hour old (a
 *                               dirty file blocking the fast-forward, or no
 *                               writer has pulled); the fix is the locked pull.
 *   dirty_age                   write-through files gbrain wrote but could not
 *                               commit (the pending ledger) older than 30
 *                               minutes, and staged-but-uncommitted files that
 *                               old: a commit without paths by any writer
 *                               would publish them.
 *   commits_outside_source_root unpushed commits that change files outside the
 *                               checkout's brain source roots (a cron's
 *                               `git add <dir>; git commit` sweeps up staged files).
 *   quarantined_changes         local versions of conflicting files the opt-in
 *                               quarantine (git config gbrain.quarantine) parked
 *                               under refs/gbrain/quarantine/ while publishing
 *                               the remote's version; they wait for the user.
 *
 * Managed canonical worktrees are skipped: their owner is the only writer.
 */
import { execFileSync } from '../../../core/spawn.ts';
import { realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Check } from '../../doctor.ts';
import { isManagedFilesystemPath } from '../../../core/persistence/filesystem-guard.ts';
import { configuredSourceRoots, localCommitsOutsideRoots, pendingWriteThroughStillDirty, readQuarantine } from '../../../core/git/commit-push.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { doctorVerify } from '../check-fix.ts';
import { sourceRoots } from './git-convergence.ts';

export const CHECKOUT_LAG_WARN_MS = 60 * 60_000;
export const DIRTY_AGE_WARN_MS = 30 * 60_000;
const GIT_TIMEOUT_MS = 5_000;
const MAX_ROOTS = 50;
const MAX_LISTED = 20;

function git(root: string, args: string[]): string | null {
  try { return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS }).toString(); }
  catch { return null; }
}

const canonical = (path: string) => { try { return realpathSync(path); } catch { return path; } };

interface Checkout { top: string; source_ids: string[]; roots: string[] }

/** Each unmanaged checkout toplevel with an upstream, and the toplevel-relative roots of the sources in it. */
async function checkouts(ctx: DoctorContext): Promise<Checkout[]> {
  const byTop = new Map<string, Checkout>();
  for (const [root, ids] of [...await sourceRoots(connectedEngine(ctx))].slice(0, MAX_ROOTS)) {
    if (isManagedFilesystemPath(root)) continue;
    const top = git(root, ['rev-parse', '--show-toplevel'])?.trim();
    if (!top || git(top, ['rev-parse', '--verify', '--quiet', '@{u}']) === null) continue;
    const rel = relative(canonical(top), canonical(root)).split(sep).join('/');
    const entry = byTop.get(top) ?? { top, source_ids: [], roots: [] };
    entry.source_ids.push(...ids);
    entry.roots.push(rel.startsWith('..') ? '' : rel);
    byTop.set(top, entry);
  }
  return [...byTop.values()];
}

const list = (items: string[]) => `${items.slice(0, 5).join(', ')}${items.length > 5 ? ', ...' : ''}`;

function lagging(found: Checkout[], now: number): Omit<Check, 'name'> {
  const behind = found.flatMap(c => {
    const count = Number(git(c.top, ['rev-list', '--count', 'HEAD..@{u}'])?.trim() ?? 0);
    if (!count) return [];
    const times = (git(c.top, ['log', '--format=%ct', 'HEAD..@{u}']) ?? '').split('\n').filter(Boolean).map(Number);
    const oldest = times.length ? Math.min(...times) * 1000 : now;
    return now - oldest > CHECKOUT_LAG_WARN_MS ? [{ root: c.top, source_ids: c.source_ids, behind: count, oldest_missing_at: new Date(oldest).toISOString() }] : [];
  });
  const details = { checkouts: behind, warn_after_minutes: CHECKOUT_LAG_WARN_MS / 60_000, fetched: false };
  if (!behind.length) return { status: 'ok', details, message: `${found.length} Git checkout(s) are not behind their last fetched upstream by more than ${CHECKOUT_LAG_WARN_MS / 60_000} minutes.` };
  const first = behind[0]!;
  return { status: 'warn', details,
    message: `Git checkouts are behind their upstream: ${behind.map(b => `${b.root}: ${b.behind} commit(s), the oldest from ${b.oldest_missing_at}`).join(' | ')}. Writers there edit files older than the remote's, and a commit made around gbrain can revert the newer remote work. The locked pull fast-forwards (or merges in memory) and never moves a file with a local edit; it names any file that blocks it. This compares with the last fetch.`,
    fix: { argv: ['gbrain', 'git', 'commit-push', '--pull', '--path', first.root], consent: [], actor: 'agent', requires_exclusive: false,
      why: `${first.root} lacks ${first.behind} upstream commit(s); the pull takes the checkout's commit lock and never rebases, stashes or overwrites a local edit.${behind.length > 1 ? ` ${behind.length - 1} other checkout(s) need the same, see details.checkouts.` : ''}`,
      verify: doctorVerify('checkout_lagging') } };
}

function dirtyAge(found: Checkout[], now: number): Omit<Check, 'name'> {
  const reports = found.flatMap(c => {
    const pending = pendingWriteThroughStillDirty(c.top).filter(e => now - Date.parse(e.since) > DIRTY_AGE_WARN_MS);
    const staged = (git(c.top, ['diff', '--cached', '--no-renames', '--name-only', '-z']) ?? '').split('\0').filter(Boolean).filter(path => {
      try { return now - statSync(join(c.top, path)).mtimeMs > DIRTY_AGE_WARN_MS; } catch { return true; }
    });
    return pending.length || staged.length ? [{ root: c.top, source_ids: c.source_ids, pending: pending.slice(0, MAX_LISTED), pending_count: pending.length, staged: staged.slice(0, MAX_LISTED), staged_count: staged.length }] : [];
  });
  const details = { checkouts: reports, warn_after_minutes: DIRTY_AGE_WARN_MS / 60_000 };
  if (!reports.length) return { status: 'ok', details, message: `No write-through file has waited more than ${DIRTY_AGE_WARN_MS / 60_000} minutes for a commit, and nothing has sat staged that long, in ${found.length} Git checkout(s).` };
  const lines = reports.map(r => `${r.root}: ${[r.pending_count ? `${r.pending_count} write-through file(s) not committed (${list(r.pending.map(p => p.path))})` : '', r.staged_count ? `${r.staged_count} staged file(s) not committed (${list(r.staged)})` : ''].filter(Boolean).join('; ')}`);
  const pending = reports.find(r => r.pending_count);
  if (pending) {
    return { status: 'warn', details,
      message: `Files have waited more than ${DIRTY_AGE_WARN_MS / 60_000} minutes for a commit: ${lines.join(' | ')}. A write-through file waits when another writer held the checkout's commit lock past gbrain's short wait, or git refused the commit; it is not on the remote until committed, and a staged file rides along with the next commit made without paths by any writer.`,
      fix: { argv: ['gbrain', 'git', 'commit-push', '--pending', '--path', pending.root], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Commits and pushes only the files gbrain itself wrote and could not commit, under the commit lock; another writer\'s files are never staged.',
        verify: doctorVerify('dirty_age') } };
  }
  const first = reports[0]!;
  return { status: 'warn', details,
    message: `Files have sat staged but uncommitted for more than ${DIRTY_AGE_WARN_MS / 60_000} minutes: ${lines.join(' | ')}. The next commit made without paths by any writer (a cron's git add plus git commit) publishes them, stale or not.`,
    fix: { ask_user: true, argv: ['git', '-C', first.root, 'restore', '--staged', '--', ...first.staged], consent: [], actor: 'user', requires_exclusive: false,
      why: 'Another writer staged these files and never committed them; unstaging keeps their bytes on disk, committing them publishes that writer\'s work.',
      user_message: `${first.staged_count} file(s) in ${first.root} have been staged but not committed for a while (${list(first.staged)}). Commit them by name with gbrain git commit-push, or unstage them (their bytes stay on disk)?`,
      verify: doctorVerify('dirty_age') } };
}

function outsideRoots(found: Checkout[]): Omit<Check, 'name'> {
  const reports = found.flatMap(c => {
    const configured = configuredSourceRoots(c.top);
    const roots = [...new Set([...c.roots, ...(configured.includes('') ? [] : configured)])];
    const commits = localCommitsOutsideRoots(c.top, 'HEAD', '@{u}', roots) ?? [];
    return commits.length ? [{ root: c.top, source_ids: c.source_ids, roots, configured: !configured.includes(''), commits: commits.slice(0, MAX_LISTED).map(o => ({ sha: o.sha, paths: o.paths.slice(0, MAX_LISTED) })) }] : [];
  });
  const details = { checkouts: reports };
  if (!reports.length) return { status: 'ok', details, message: `No unpushed commit changes files outside its brain source root in ${found.length} Git checkout(s).` };
  const first = reports[0]!;
  const shas = first.commits.map(c => c.sha.slice(0, 12));
  return { status: 'warn', details,
    message: `Unpushed commits change files outside the brain's source root: ${reports.map(r => `${r.root} (roots ${r.roots.join(', ')}): ${r.commits.map(c => `${c.sha.slice(0, 12)} ${list(c.paths)}`).join('; ')}`).join(' | ')}. A commit made without gbrain git commit-push can carry files other writers had staged, and publishing it can overwrite newer work on the remote.${reports.some(r => !r.configured) ? ' The checkout has no gbrain.sourceRoot set, so gbrain git commit-push would still publish them; gbrain sources harden <source> records the root.' : ' gbrain git commit-push refuses to publish them until the user agrees.'}`,
    fix: { ask_user: true, argv: ['gbrain', 'git', 'commit-push', '--push-only', '--allow-outside-source-root', '--path', first.root], consent: [], actor: 'user', requires_exclusive: false,
      why: 'Only the user can say whether these files belong on the remote; show them git show --stat <sha> for each commit first.',
      user_message: `Unpushed commit(s) ${shas.join(', ')} in ${first.root} change files outside the brain's folder. Publish them as they are, or should they be reviewed first?`,
      verify: doctorVerify('commits_outside_source_root') } };
}

function quarantined(found: Checkout[]): Omit<Check, 'name'> {
  const reports = found.flatMap(c => {
    const entries = readQuarantine(c.top);
    return entries.length ? [{ root: c.top, source_ids: c.source_ids, entries: entries.slice(0, MAX_LISTED), count: entries.length }] : [];
  });
  const details = { checkouts: reports };
  if (!reports.length) return { status: 'ok', details, message: `No quarantined local change is waiting in ${found.length} Git checkout(s).` };
  const first = reports[0]!;
  const entry = first.entries[0]!;
  return { status: 'warn', details,
    message: `Local changes were quarantined instead of merged: ${reports.map(r => `${r.root}: ${r.entries.map(e => `${e.ref} (${list(e.paths)})`).join('; ')}`).join(' | ')}. Both this machine and the remote changed these files; the remote's version was published and this machine's version is kept under the ref. Compare with git diff ${entry.remote.slice(0, 12)} ${entry.ref} -- <path>, bring back what should stay with a normal commit (gbrain git commit-push -m "<msg>" -- <path>), then delete the ref.`,
    fix: { ask_user: true, argv: ['git', '-C', first.root, 'update-ref', '-d', entry.ref], consent: [], actor: 'user', requires_exclusive: false,
      why: 'Deleting the ref says the parked version was reviewed; until then it is the only named copy of this machine\'s side of the conflict.',
      user_message: `This machine's version of ${list(entry.paths)} in ${first.root} was parked under ${entry.ref} because the remote changed the same file(s). Review it and keep what you need, then may I delete the ref?`,
      verify: doctorVerify('quarantined_changes') } };
}

async function runGitWriter(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('checkout_lagging');
  const found = await checkouts(ctx);
  if (!found.length) return checks;
  const now = Date.now();
  checks.push({ name: 'checkout_lagging', ...lagging(found, now) });
  ctx.progress.heartbeat('dirty_age');
  checks.push({ name: 'dirty_age', ...dirtyAge(found, now) });
  ctx.progress.heartbeat('commits_outside_source_root');
  checks.push({ name: 'commits_outside_source_root', ...outsideRoots(found) });
  ctx.progress.heartbeat('quarantined_changes');
  checks.push({ name: 'quarantined_changes', ...quarantined(found) });
  return checks;
}

export const gitWriterEntry: DoctorEntry = {
  name: 'checkout_lagging',
  emits: ['checkout_lagging', 'dirty_age', 'commits_outside_source_root', 'quarantined_changes'],
  run: runGitWriter,
};
