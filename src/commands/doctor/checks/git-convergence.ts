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
 * The same entry emits `tracked_ownership_marker` (#5186) for the same roots.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { parseSourceConfig } from '../../../core/sources-load.ts';
import { isConnectorSourceKind } from '../../../core/persistence/connector-identity.ts';
import { isPhysicalRootMetadata } from '../../../core/persistence/root-metadata.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { doctorVerify } from '../check-fix.ts';

export const GIT_CONVERGENCE_WARN_MS = 6 * 3_600_000;
export const GIT_CONVERGENCE_FAIL_MS = 24 * 3_600_000;
const GIT_TIMEOUT_MS = 5_000;
const MAX_ROOTS = 50;
const MAX_DIRTY_PATHS = 200;

interface RootReport { root: string; source_ids: string[]; branch: string | null; ahead: number; behind: number; dirty: number;
  oldest_unpushed_at: string | null; oldest_dirty_at: string | null; status: 'ok' | 'warn' | 'fail' }

function git(root: string, args: string[]): string | null {
  try { return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: GIT_TIMEOUT_MS }).toString(); }
  catch { return null; }
}

function probe(root: string, sourceIds: string[], now: number): RootReport | { root: string; source_ids: string[]; skipped: string } {
  const top = git(root, ['rev-parse', '--show-toplevel'])?.trim();
  if (!top) return { root, source_ids: sourceIds, skipped: 'not a git checkout' };
  const counts = git(top, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])?.trim().split(/\s+/).map(Number);
  if (!counts || counts.length !== 2 || counts.some(n => !Number.isFinite(n))) return { root: top, source_ids: sourceIds, skipped: 'no upstream branch' };
  const [behind, ahead] = counts as [number, number];
  const oldestUnpushed = ahead > 0 ? Number(git(top, ['log', '@{u}..HEAD', '--reverse', '--format=%ct'])?.split('\n')[0]) * 1000 : NaN;
  const changed: string[] = [];
  const entries = (git(top, ['status', '--porcelain', '-z']) ?? '').split('\0');
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].length < 4) continue;
    changed.push(entries[i].slice(3));
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
async function sourceRoots(engine: BrainEngine): Promise<Map<string, string[]>> {
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
  for (const [root, ids] of [...roots].slice(0, MAX_ROOTS)) {
    const report = probe(root, ids, now);
    const prior = byTop.get(report.root);
    byTop.set(report.root, prior ? { ...prior, source_ids: [...prior.source_ids, ...ids] } : report);
  }
  const reports = [...byTop.values()].filter((r): r is RootReport => !('skipped' in r));
  const skipped = [...byTop.values()].filter((r): r is { root: string; source_ids: string[]; skipped: string } => 'skipped' in r);
  const details = { roots: reports, skipped, ...(roots.size > MAX_ROOTS ? { not_probed: roots.size - MAX_ROOTS } : {}),
    warn_after_hours: GIT_CONVERGENCE_WARN_MS / 3_600_000, fail_after_hours: GIT_CONVERGENCE_FAIL_MS / 3_600_000, fetched: false };
  if (!reports.length) return null;
  const bad = reports.filter(r => r.status !== 'ok');
  if (!bad.length) {
    return { name: 'git_convergence', status: 'ok', details,
      message: `${reports.length} Git checkout(s) have no unpushed commits or stale uncommitted changes (compared with the last fetched upstream).` };
  }
  const lines = bad.map(r => `${r.root}${r.source_ids.length ? ` (${r.source_ids.join(', ')})` : ''}: `
    + [r.ahead ? `${r.ahead} commit(s) not on the upstream since ${r.oldest_unpushed_at}` : '', r.dirty && r.oldest_dirty_at ? `${r.dirty} uncommitted change(s), oldest from ${r.oldest_dirty_at}` : '']
      .filter(Boolean).join('; '));
  return { name: 'git_convergence', status: bad.some(r => r.status === 'fail') ? 'fail' : 'warn', details,
    message: `Git checkouts have not converged with their upstream: ${lines.join(' | ')}. Commit and push them (gbrain sources push --path <root> for a bootstrap workspace, or git push in the checkout); this compares with the last fetched upstream and does not fetch.` };
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
  for (const [root, ids] of [...roots].slice(0, MAX_ROOTS)) {
    const top = git(root, ['rev-parse', '--show-toplevel'])?.trim();
    if (!top || seen.has(top)) continue;
    seen.add(top);
    checkouts++;
    const paths = (git(top, ['ls-files', '-z', '--cached']) ?? '').split('\0').filter(path => path && isPhysicalRootMetadata(path.slice(path.lastIndexOf('/') + 1)));
    if (paths.length) tracked.push({ root: top, source_ids: ids, paths });
  }
  const details = { checkouts, tracked, ...(roots.size > MAX_ROOTS ? { not_probed: roots.size - MAX_ROOTS } : {}) };
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
