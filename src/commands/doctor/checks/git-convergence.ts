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
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { parseSourceConfig } from '../../../core/sources-load.ts';
import { isConnectorSourceKind } from '../../../core/persistence/connector-identity.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

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

export async function gitConvergenceCheck(engine: BrainEngine, now = Date.now()): Promise<Check | null> {
  const sources = await engine.executeRaw<{ id: string; local_path: string | null; config: unknown }>(
    'SELECT id, local_path, config FROM sources WHERE archived IS NOT TRUE AND local_path IS NOT NULL ORDER BY id');
  const roots = new Map<string, string[]>();
  for (const source of sources) {
    if (!source.local_path || isConnectorSourceKind(parseSourceConfig(source.config).kind)) continue;
    roots.set(source.local_path, [...(roots.get(source.local_path) ?? []), source.id]);
  }
  const repoPath = await engine.getConfig('sync.repo_path').catch(() => null);
  if (repoPath && !roots.has(repoPath)) roots.set(repoPath, []);
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

async function runGitConvergence(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  ctx.progress.heartbeat('git_convergence');
  const check = await gitConvergenceCheck(connectedEngine(ctx));
  if (check) checks.push(check);
  return checks;
}

export const gitConvergenceEntry: DoctorEntry = {
  name: 'git_convergence',
  emits: ['git_convergence'],
  run: runGitConvergence,
};
