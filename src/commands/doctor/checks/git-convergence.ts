/**
 * #5063: `git_convergence`, whether each Git checkout the brain syncs from has
 * reached its upstream. Probes every non-archived filesystem source root plus
 * `sync.repo_path` (connector sources and roots without an upstream are
 * skipped and listed; with no upstream anywhere the check emits nothing) with `git status --porcelain` and ahead/behind against
 * the local `@{u}` ref. It never fetches, so it is only as fresh as the last
 * fetch, and every git call is time-bounded so doctor stays fast and offline.
 *
 * Commits not on the upstream warn once the oldest is older than 6 hours and
 * fail past 24 hours. Uncommitted changes warn once the oldest changed file is
 * older than 6 hours, never fail (they may be deliberate work in progress).
 * Being behind is reported, not judged: sync pulls.
 *
 * #7089: a managed canonical checkout this host owns, with Git durability on,
 * whose commits are not on the upstream while no Git effect of its worktree is
 * queued, running or parked, warns at once (`stranded`): nothing will push
 * them, so the fix pushes them with the keep-checkout publish. #7091: so does
 * one with tracked files modified under its source root (a root below the
 * toplevel included): no effect will commit them, so the fix asks the user to
 * commit them, then pushes.
 *
 * The same entry emits `tracked_ownership_marker` (#5186) for the same roots.
 */
import { execFileSync } from '../../../core/spawn.ts';
import { realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import type { Action } from '../../../core/agent-output.ts';
import { parseSourceConfig } from '../../../core/sources-load.ts';
import { isConnectorSourceKind } from '../../../core/persistence/connector-identity.ts';
import { isPhysicalRootMetadata } from '../../../core/persistence/root-metadata.ts';
import { isManagedFilesystemPath } from '../../../core/persistence/filesystem-guard.ts';
import { existingLocalHostId } from '../../../core/persistence/identity.ts';
import { gitDurabilityPolicy } from '../../../core/persistence/git-durability-policy.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { doctorVerify } from '../check-fix.ts';
import { readPorcelain, readUnpushedCommits, type CheckoutCommit, type CheckoutPorcelain } from '../../../core/persistence/checkout-state.ts';
import { boundUnknownDetails } from '../bounded-unknown.ts';

export const GIT_CONVERGENCE_WARN_MS = 6 * 3_600_000;
export const GIT_CONVERGENCE_FAIL_MS = 24 * 3_600_000;
const GIT_TIMEOUT_MS = 5_000;
const MAX_ROOTS = 50;
const MAX_DIRTY_PATHS = 200;

interface RootReport { root: string; source_ids: string[]; branch: string | null; ahead: number; behind: number; dirty: number;
  oldest_unpushed_at: string | null; oldest_dirty_at: string | null; status: 'ok' | 'warn' | 'fail'; stranded?: true; uncommitted_pages?: string[];
  managed?: true; diverged?: true; unpushed_commits?: CheckoutCommit[]; porcelain?: CheckoutPorcelain }

const canonicalPath = (path: string) => { try { return realpathSync(path); } catch { return path; } };

/**
 * #7089: the canonical checkouts this host owns with Git durability on and no Git effect of their worktree queued,
 * running or parked: commits there that are not on the upstream have no effect left to push them. Keyed by the
 * checkout's toplevel (#7091: a binding's local_path may sit below it), each with its source roots' toplevel-relative prefixes.
 */
async function unwatchedDurableRoots(engine: BrainEngine): Promise<Map<string, string[]>> {
  const hostId = existingLocalHostId();
  if (!hostId) return new Map();
  const bindings = await engine.executeRaw<{ local_path: string; git_durability: 'enabled' | 'disabled' | null; relative_paths: string[] | null }>(
    `SELECT h.local_path,h.git_durability,
       (SELECT array_agg(b.relative_path) FROM persistence_source_bindings b WHERE b.worktree_id=h.worktree_id) AS relative_paths
     FROM persistence_host_bindings h JOIN persistence_worktrees w ON w.id=h.worktree_id
     WHERE h.host_id=$1::uuid AND w.owner_host_id=$1::uuid AND w.state='active' AND NOT EXISTS (
       SELECT 1 FROM persistence_effects e WHERE e.worktree_id=h.worktree_id AND e.kind='git' AND e.state IN ('queued','running','failed') AND NOT (e.data ? 'settled'))`,
    [hostId]).catch(() => []);
  const roots = new Map<string, string[]>();
  for (const binding of bindings) {
    const durable = await gitDurabilityPolicy(binding, binding.local_path).then(policy => policy.durable, () => false);
    const top = durable ? git(binding.local_path, ['rev-parse', '--show-toplevel'])?.trim() : undefined;
    if (!top) continue;
    const prefixes = (binding.relative_paths?.length ? binding.relative_paths : ['']).map(path =>
      relative(canonicalPath(top), canonicalPath(join(binding.local_path, path))).split(sep).join('/'));
    roots.set(canonicalPath(top), [...roots.get(canonicalPath(top)) ?? [], ...prefixes]);
  }
  return roots;
}

/** `timedOut` collects the roots where a git call ran past GIT_TIMEOUT_MS (#7145: a timeout is not an empty answer). */
function git(root: string, args: string[], timedOut?: Set<string>): string | null {
  try { return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS }).toString(); }
  catch (error) {
    if ((error as { code?: string }).code === 'ETIMEDOUT') timedOut?.add(root);
    return null;
  }
}

/** #7145: what a bounded probe could not read, as a sentence, plus the matching unknown-health details. */
function boundReport(timedOut: Set<string>, notProbed: number, total: number) {
  if (!timedOut.size && !notProbed) return null;
  const parts = [timedOut.size ? `git did not answer within ${GIT_TIMEOUT_MS / 1000} s in ${[...timedOut].join(', ')}` : '',
    notProbed ? `only the first ${MAX_ROOTS} of ${total} source checkouts were probed` : ''].filter(Boolean);
  return { note: `${parts.join('; ')} (no setting), so what those checkouts hold was not read`,
    details: { ...boundUnknownDetails(timedOut.size ? 'time' : 'roots'), limit: timedOut.size ? GIT_TIMEOUT_MS : MAX_ROOTS, timed_out: [...timedOut] } };
}

/** `tracked` collects each probed toplevel's modified tracked paths (toplevel-relative). */
function probe(root: string, sourceIds: string[], now: number, tracked: Map<string, string[]>, timedOut: Set<string>): RootReport | { root: string; source_ids: string[]; skipped: string } {
  const top = git(root, ['rev-parse', '--show-toplevel'], timedOut)?.trim();
  if (!top) return { root, source_ids: sourceIds, skipped: timedOut.has(root) ? 'git timed out' : 'not a git checkout' };
  const counts = git(top, ['rev-list', '--left-right', '--count', '@{u}...HEAD'], timedOut)?.trim().split(/\s+/).map(Number);
  if (!counts || counts.length !== 2 || counts.some(n => !Number.isFinite(n))) return { root: top, source_ids: sourceIds, skipped: timedOut.has(top) ? 'git timed out' : 'no upstream branch' };
  const [behind, ahead] = counts as [number, number];
  const oldestUnpushed = ahead > 0 ? Number(git(top, ['log', '@{u}..HEAD', '--reverse', '--format=%ct'], timedOut)?.split('\n')[0]) * 1000 : NaN;
  const changed: string[] = [];
  const entries = (git(top, ['status', '--porcelain', '-z'], timedOut) ?? '').split('\0');
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].length < 4) continue;
    changed.push(entries[i].slice(3));
    if (!entries[i].startsWith('??') && !entries[i].startsWith('!!')) tracked.set(top, [...tracked.get(top) ?? [], entries[i].slice(3)]);
    if (/^[RC]/.test(entries[i])) i++;
  }
  const mtimes = changed.slice(0, MAX_DIRTY_PATHS).flatMap(path => { try { return [statSync(join(top, path)).mtimeMs]; } catch { return []; } });
  const oldestDirty = mtimes.length ? Math.min(...mtimes) : NaN;
  const unpushedAge = Number.isFinite(oldestUnpushed) ? now - oldestUnpushed : 0;
  const dirtyAge = Number.isFinite(oldestDirty) ? now - oldestDirty : 0;
  const status = unpushedAge > GIT_CONVERGENCE_FAIL_MS ? 'fail'
    : unpushedAge > GIT_CONVERGENCE_WARN_MS || dirtyAge > GIT_CONVERGENCE_WARN_MS ? 'warn' : 'ok';
  return { root: top, source_ids: sourceIds, branch: git(top, ['branch', '--show-current'])?.trim() || null, ahead, behind, dirty: changed.length,
    oldest_unpushed_at: Number.isFinite(oldestUnpushed) ? new Date(oldestUnpushed).toISOString() : null,
    oldest_dirty_at: Number.isFinite(oldestDirty) ? new Date(oldestDirty).toISOString() : null, status };
}

/** Every non-archived filesystem source root plus `sync.repo_path`, with the source ids that name each root. */
export async function sourceRoots(engine: BrainEngine): Promise<Map<string, string[]>> {
  const sources = await engine.executeRaw<{ id: string; local_path: string | null; config: unknown }>(
    'SELECT id, local_path, config FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL ORDER BY id');
  const roots = new Map<string, string[]>();
  for (const source of sources) {
    if (!source.local_path || isConnectorSourceKind(parseSourceConfig(source.config).kind)) continue;
    roots.set(source.local_path, [...(roots.get(source.local_path) ?? []), source.id]);
  }
  const repoPath = await engine.getConfig('sync.repo_path').catch(() => null);
  if (repoPath && !roots.has(repoPath)) roots.set(repoPath, []);
  return roots;
}

export async function gitConvergenceCheck(engine: BrainEngine, now = Date.now()): Promise<Check | null> {
  const roots = await sourceRoots(engine);
  if (!roots.size) return null;
  const byTop = new Map<string, RootReport | { root: string; source_ids: string[]; skipped: string }>();
  const tracked = new Map<string, string[]>();
  const timedOut = new Set<string>();
  for (const [root, ids] of [...roots].slice(0, MAX_ROOTS)) {
    const report = probe(root, ids, now, tracked, timedOut);
    const prior = byTop.get(report.root);
    byTop.set(report.root, prior ? { ...prior, source_ids: [...prior.source_ids, ...ids] } : report);
  }
  const reports = [...byTop.values()].filter((r): r is RootReport => !('skipped' in r));
  const unwatched = reports.some(r => r.ahead > 0 || tracked.has(r.root)) ? await unwatchedDurableRoots(engine) : new Map<string, string[]>();
  // Q1 (shape A): on a managed canonical checkout, name each commit the upstream lacks and break the porcelain down; a
  // diverged one blocks gbrain sources refresh (refresh_diverged), so it warns at once.
  for (const report of reports) {
    if (!isManagedFilesystemPath(report.root)) continue;
    report.managed = true;
    if (report.ahead) report.unpushed_commits = readUnpushedCommits(report.root);
    if (report.dirty) report.porcelain = readPorcelain(report.root);
    if (report.ahead && report.behind) { report.diverged = true; if (report.status === 'ok') report.status = 'warn'; }
  }
  for (const report of reports) {
    const prefixes = unwatched.get(canonicalPath(report.root));
    if (!prefixes) continue;
    const pages = [...new Set(tracked.get(report.root) ?? [])].filter(path => prefixes.some(prefix => !prefix || path.startsWith(`${prefix}/`))).slice(0, MAX_DIRTY_PATHS);
    if (report.ahead === 0 && !pages.length) continue;
    report.stranded = true;
    if (pages.length) report.uncommitted_pages = pages;
    if (report.status === 'ok') report.status = 'warn';
  }
  const skipped = [...byTop.values()].filter((r): r is { root: string; source_ids: string[]; skipped: string } => 'skipped' in r);
  const details = { roots: reports, skipped, ...(roots.size > MAX_ROOTS ? { not_probed: roots.size - MAX_ROOTS } : {}),
    warn_after_hours: GIT_CONVERGENCE_WARN_MS / 3_600_000, fail_after_hours: GIT_CONVERGENCE_FAIL_MS / 3_600_000, fetched: false };
  const bound = boundReport(timedOut, Math.max(0, roots.size - MAX_ROOTS), roots.size);
  if (!reports.length && !bound) return null;
  const bad = reports.filter(r => r.status !== 'ok');
  if (!bad.length && bound) {
    return { name: 'git_convergence', status: 'warn', details: { ...details, ...bound.details },
      message: `Git convergence unknown: ${bound.note}; ${reports.filter(r => !timedOut.has(r.root)).length} other checkout(s) have no unpushed commits or stale uncommitted changes. `
        + 'Run git status and git log @{u}..HEAD in each checkout named here to read what it holds.' };
  }
  if (!bad.length) {
    return { name: 'git_convergence', status: 'ok', details,
      message: `${reports.length} Git checkout(s) have no unpushed commits or stale uncommitted changes (compared with the last fetched upstream).` };
  }
  const boundNote = bound ? ` Not every checkout was read: ${bound.note}.` : '';
  if (bound) Object.assign(details, { exact: false, limit: bound.details.limit, timed_out: bound.details.timed_out });
  const lines = bad.map(r => `${r.root}${r.source_ids.length ? ` (${r.source_ids.join(', ')})` : ''}: `
    + [r.ahead ? `${r.ahead} commit(s) not on the upstream since ${r.oldest_unpushed_at}` : '', r.diverged ? `diverged (${r.behind} upstream commit(s) not in HEAD)` : '',
      r.unpushed_commits?.length ? `newest ${r.unpushed_commits[0]!.sha.slice(0, 7)} by ${r.unpushed_commits[0]!.author} at ${r.unpushed_commits[0]!.date} (${r.unpushed_commits[0]!.paths.slice(0, 3).join(', ') || 'no files'})` : '',
      r.dirty && r.oldest_dirty_at ? `${r.dirty} uncommitted change(s), oldest from ${r.oldest_dirty_at}` : '']
      .filter(Boolean).join('; '));
  // #5808 (#5606 residue): a managed canonical worktree has no bulk push; its owner pushes page writes and the operator pushes the rest.
  const remedy = bad.some(r => isManagedFilesystemPath(r.root))
    ? 'Commit and push them: on a managed canonical worktree the persistence owner commits and pushes page writes (gbrain sources writer status <source> --json shows parked pushes; gbrain sources writer git-durability <source> --enable turns them on), and files that are not pages are committed and pushed with plain git in the checkout, never pulled or rebased; elsewhere gbrain sources push --path <root> for a bootstrap workspace, or git push in the checkout'
    : 'Commit and push them (gbrain sources push --path <root> for a bootstrap workspace, or git push in the checkout)';
  const stranded = bad.filter(r => r.stranded);
  const status = bad.some(r => r.status === 'fail') ? 'fail' : 'warn';
  const uncommitted = stranded.find(r => r.uncommitted_pages);
  if (uncommitted) {
    const pages = uncommitted.uncommitted_pages!;
    const push: Action = { argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', uncommitted.root], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Publishes the commit just made without moving the checkout.', verify: doctorVerify('git_convergence') };
    return { name: 'git_convergence', status, details,
      message: `Git checkouts have not converged with their upstream: ${lines.join(' | ')}. ${uncommitted.root} is a managed checkout with Git durability on, ${pages.length} tracked file(s) modified under its source root (${pages.slice(0, 5).join(', ')}${pages.length > 5 ? ', ...' : ''}) and no Git effect queued, running or parked, so no effect will commit them (#7091: earlier releases committed no edits to tracked pages when the source root sits below the repository top). Review and commit them with plain git, then push with the keep-checkout publish. ${remedy}; this compares with the last fetched upstream and does not fetch.${boundNote}`,
      fix: { ask_user: true, argv: ['git', '-C', uncommitted.root, 'commit', '-m', 'gbrain: persist canonical memory update', '--', ...pages], consent: [], actor: 'user', requires_exclusive: false,
        why: `These tracked files under a durable managed source root differ from the last commit and no Git effect will commit them; committing writes them to the checkout's history, so the user reviews them first.${stranded.length > 1 ? ` ${stranded.length - 1} other checkout(s) are stranded too, see details.roots (stranded).` : ''}`,
        user_message: `${pages.length} page file(s) in ${uncommitted.root} were edited but never committed (${pages.slice(0, 5).join(', ')}${pages.length > 5 ? ', ...' : ''}), so they are not on the remote. Commit them and push?`,
        verify: doctorVerify('git_convergence'), then: push } };
  }
  if (stranded.length) {
    const first = stranded[0]!;
    return { name: 'git_convergence', status, details,
      message: `Git checkouts have not converged with their upstream: ${lines.join(' | ')}. ${stranded.map(r => r.root).join(', ')} ${stranded.length === 1 ? 'is a managed checkout' : 'are managed checkouts'} with Git durability on and no Git effect queued, running or parked, so no effect will push ${stranded.length === 1 ? 'its' : 'their'} commits; push them with the keep-checkout publish, which merges a moved remote in memory and never moves the checkout. ${remedy}; this compares with the last fetched upstream and does not fetch.${boundNote}`,
      fix: { argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', first.root], consent: [], actor: 'agent', requires_exclusive: false,
        why: `${first.root} has ${first.ahead} commit(s) not on its upstream and no Git effect left to push them (#7089); this publishes the commits already on the branch and commits nothing. A conflict with the remote is reported with the user's choice as its fix.${stranded.length > 1 ? ` ${stranded.length - 1} other checkout(s) need the same, see details.roots (stranded).` : ''}`,
        verify: doctorVerify('git_convergence') } };
  }
  const diverged = bad.find(r => r.diverged);
  if (diverged) {
    return { name: 'git_convergence', status, details,
      message: `Git checkouts have not converged with their upstream: ${lines.join(' | ')}. ${diverged.root} is a managed checkout that diverged from its upstream, so gbrain sources refresh refuses (refresh_diverged) until its local commits are published merged with the upstream; details.roots lists each one (sha, author, date, paths). ${remedy}; this compares with the last fetched upstream and does not fetch.${boundNote}`,
      fix: { ask_user: true, argv: ['gbrain', 'git', 'commit-push', '--push-only', '--keep-checkout', '--path', diverged.root, '--json'], consent: [], actor: 'user', requires_exclusive: false,
        why: `${diverged.root} holds ${diverged.ahead} commit(s) its upstream lacks while the upstream moved on; this merges the upstream into HEAD in memory, refuses on a conflict, pushes the merge and never moves the checkout, after which gbrain sources refresh fast-forwards. It publishes those commits, so the user reviews them first.`,
        user_message: `${diverged.root} has ${diverged.ahead} local commit(s) that were never pushed (newest ${diverged.unpushed_commits?.[0]?.sha.slice(0, 7) ?? 'unknown'} by ${diverged.unpushed_commits?.[0]?.author ?? 'unknown'}) while its remote moved on. Push them, merged with the remote, so gbrain can bring the checkout up to date?`,
        verify: doctorVerify('git_convergence') } };
  }
  return { name: 'git_convergence', status, details,
    message: `Git checkouts have not converged with their upstream: ${lines.join(' | ')}. ${remedy}; this compares with the last fetched upstream and does not fetch.${boundNote}` };
}

/**
 * #5186: `tracked_ownership_marker`, whether a source checkout has an ownership
 * marker (`.gbrain-owner.json`, the reservation beside the root, a staged stamp)
 * in its Git index. Stamping excludes the markers and `sources push` denies
 * them, but neither un-tracks a file already committed, so the fix is
 * `git rm --cached` run by the user. Markers that are merely on disk are fine.
 */
export async function trackedOwnershipMarkerCheck(engine: BrainEngine): Promise<Check | null> {
  const roots = await sourceRoots(engine);
  if (!roots.size) return null;
  const tracked: Array<{ root: string; source_ids: string[]; paths: string[] }> = [];
  let checkouts = 0;
  const seen = new Set<string>();
  const timedOut = new Set<string>();
  for (const [root, ids] of [...roots].slice(0, MAX_ROOTS)) {
    const top = git(root, ['rev-parse', '--show-toplevel'], timedOut)?.trim();
    if (!top || seen.has(top)) continue;
    seen.add(top);
    checkouts++;
    const paths = (git(top, ['ls-files', '-z', '--cached'], timedOut) ?? '').split('\0').filter(path => path && isPhysicalRootMetadata(path.slice(path.lastIndexOf('/') + 1)));
    if (paths.length) tracked.push({ root: top, source_ids: ids, paths });
  }
  const details = { checkouts, tracked, ...(roots.size > MAX_ROOTS ? { not_probed: roots.size - MAX_ROOTS } : {}) };
  const bound = boundReport(timedOut, Math.max(0, roots.size - MAX_ROOTS), roots.size);
  if (!tracked.length && bound) {
    return { name: 'tracked_ownership_marker', status: 'warn', details: { ...details, ...bound.details },
      message: `Tracked ownership markers unknown: ${bound.note}. Run git ls-files in each checkout named here to read its index.` };
  }
  if (!tracked.length) {
    return { name: 'tracked_ownership_marker', status: 'ok', details,
      message: `${checkouts} Git checkout(s) track no ownership marker (markers on disk stay untracked and are denied on push).` };
  }
  const first = tracked[0]!;
  return { name: 'tracked_ownership_marker', status: 'warn', details,
    message: `Ownership marker file(s) are tracked by Git: ${tracked.map(t => `${t.root}: ${t.paths.join(', ')}`).join(' | ')}. `
      + 'They hold this machine\'s claim on the checkout and are not content; gbrain sources push refuses them, and an ignore rule cannot un-track a file already in the index.',
    fix: { argv: ['git', '-C', first.root, 'rm', '--cached', ...first.paths], consent: [], actor: 'user', requires_exclusive: false,
      why: 'Removes the marker from the Git index and the next commit while leaving the file on disk, where gbrain still reads it.',
      user_message: `${first.root} tracks ownership marker file(s) (${first.paths.join(', ')}). Please run the command shown, commit, and push; `
        + `the files stay on disk.${tracked.length > 1 ? ` ${tracked.length - 1} other checkout(s) need the same, see details.tracked.` : ''}`,
      verify: doctorVerify('tracked_ownership_marker') } };
}

async function runGitConvergence(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const engine = connectedEngine(ctx);
  ctx.progress.heartbeat('git_convergence');
  const check = await gitConvergenceCheck(engine);
  if (check) checks.push(check);
  ctx.progress.heartbeat('tracked_ownership_marker');
  const markers = await trackedOwnershipMarkerCheck(engine);
  if (markers) checks.push(markers);
  return checks;
}

export const gitConvergenceEntry: DoctorEntry = {
  name: 'git_convergence',
  emits: ['git_convergence', 'tracked_ownership_marker'],
  run: runGitConvergence,
};
