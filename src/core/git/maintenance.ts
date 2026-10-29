/**
 * Git object-store maintenance for strict sources and hosted bare repositories (Wave C 1C, decision G7). The door
 * writes with plumbing (`hash-object`, `commit-tree`, `update-ref`), which never runs `gc --auto`, so every append to a
 * large page leaves a full loose copy of the file it rewrote. This module packs them and prunes unreachable objects
 * past git's own two-week grace.
 *
 * It runs WITHOUT the checkout's writer lock: `repack`, `prune` and `prune-packed` take git's own locks and are safe
 * alongside door writers, so a door write never waits on a repack. A door write that needs an old unreachable object
 * again is protected the way git's own commands are: `hash-object -w` refreshes its mtime past the grace. The window
 * between prune's age check and its unlink is git's own (git-gc NOTES) and is not closed here. It holds only its own
 * maintenance lock (`<git common dir>/gbrain-maintenance.lock`), so two runs never overlap. Each run is recorded in
 * `<git common dir>/gbrain-maintenance.json`, which doctor `git_repo_health` reads. A linked worktree (a hosted source)
 * maintains its bare repository through the shared common dir.
 *
 * Two kinds of run, both never `gc --aggressive` and never a history rewrite:
 * - `repack` (loose bytes past `LOOSE_REPACK_BYTES`, or grown by `LOOSE_GROWTH_BYTES` since the last run, which is
 *   where a large door publication lands): `git repack -d --geometric=2 --write-midx`, then `git prune-packed`.
 * - `daily` (once a day): `git prune --expire=2.weeks.ago` first, so the unreachable loose objects past the grace go
 *   while they still carry their own mtimes, then `git repack -d --cruft --cruft-expiration=2.weeks.ago --write-midx`,
 *   which keeps every younger unreachable object in a cruft pack and drops the older ones, then `git prune-packed`.
 *   `git maintenance run --task=loose-objects` is not used: it packs unreachable loose objects into an ordinary pack,
 *   where their age is lost and no prune would ever reach them.
 *
 * Automatic runs are skipped when `git.maintenance` is `off`, or when the user scheduled git's own maintenance for the
 * repository (`maintenance.auto` or `maintenance.strategy` set, or the repository listed under `maintenance.repo`).
 */
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { gitAsync } from '../sync-git.ts';
import { acquireNativeLock } from '../persistence/native-lock.ts';
import { opError } from '../ops/contract.ts';

export const GIT_MAINTENANCE_KEY = 'git.maintenance';
export const MAINTENANCE_LOCK_NAME = 'gbrain-maintenance.lock';
export const MAINTENANCE_RECORD_NAME = 'gbrain-maintenance.json';
export const PRUNE_EXPIRE = '2.weeks.ago';
export const LOOSE_REPACK_BYTES = 256 * 1024 * 1024;
export const LOOSE_GROWTH_BYTES = 64 * 1024 * 1024;
export const PACK_COUNT_WARN = 50;
export const GITHUB_PACKED_WARN_BYTES = 2 * 1000 ** 3;
export const DAILY_MS = 24 * 60 * 60 * 1000;
const STEP_TIMEOUT_MS = 60 * 60 * 1000;

export type MaintenanceKind = 'repack' | 'daily';
export type MaintenanceTrigger = 'loose_bytes' | 'loose_growth' | 'daily' | 'manual';
export type UserScheduled = 'maintenance.auto' | 'maintenance.strategy' | 'maintenance.repo';

export interface RepoStats { loose_objects: number; loose_bytes: number; packs: number; packed_bytes: number; garbage: number }

export interface MaintenanceRecord {
  at: string;
  kind: MaintenanceKind;
  trigger: MaintenanceTrigger;
  result: 'ok' | 'failed';
  error?: string;
  before: RepoStats;
  after?: RepoStats;
  pruned_objects: number;
  /** When the last daily run finished; carried across repack runs. */
  daily_at: string | null;
}

export interface MaintenancePlan {
  repo: string;
  common_dir: string;
  stats: RepoStats;
  user_scheduled: UserScheduled | null;
  last: MaintenanceRecord | null;
  kind: MaintenanceKind | null;
  trigger: MaintenanceTrigger | null;
  /** Unreachable loose objects older than the grace that a daily run prunes (`git prune --dry-run`); 0 without a daily run, whose traversal is skipped. */
  would_prune: number;
  steps: string[][];
}

const git = (repo: string, args: string[], timeoutMs = 30_000) => gitAsync(repo, args, { silenceStderr: true, timeoutMs });

/** The repository's object store: the common dir a linked worktree shares with its main (or bare) repository. */
export async function gitCommonDir(repo: string): Promise<string> {
  const dir = await git(repo, ['rev-parse', '--git-common-dir']);
  return realpathSync(isAbsolute(dir) ? dir : resolve(repo, dir));
}

/** `git count-objects -v`, in bytes. */
export async function repoStats(repo: string): Promise<RepoStats> {
  const fields = new Map((await git(repo, ['count-objects', '-v'])).split('\n').map(line => {
    const at = line.indexOf(':');
    return [line.slice(0, at).trim(), Number(line.slice(at + 1).trim())] as const;
  }));
  const n = (key: string) => fields.get(key) ?? 0;
  return { loose_objects: n('count'), loose_bytes: n('size') * 1024, packs: n('packs'), packed_bytes: n('size-pack') * 1024, garbage: n('garbage') };
}

/** Which of the user's own git maintenance settings covers this repository, or null when gbrain owns it. */
export async function userScheduledMaintenance(repo: string, commonDir: string): Promise<UserScheduled | null> {
  const get = (args: string[]) => git(repo, ['config', ...args]).catch(() => '');
  if (await get(['--get', 'maintenance.auto'])) return 'maintenance.auto';
  if (await get(['--get', 'maintenance.strategy'])) return 'maintenance.strategy';
  const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const mine = new Set([real(repo), commonDir, real(join(commonDir, '..'))]);
  const registered = (await get(['--get-all', 'maintenance.repo'])).split('\n').filter(Boolean);
  return registered.some(path => mine.has(real(path))) ? 'maintenance.repo' : null;
}

export function readMaintenanceRecord(commonDir: string): MaintenanceRecord | null {
  const path = join(commonDir, MAINTENANCE_RECORD_NAME);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')) as MaintenanceRecord; } catch { return null; }
}

function writeMaintenanceRecord(commonDir: string, record: MaintenanceRecord): void {
  const path = join(commonDir, MAINTENANCE_RECORD_NAME);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(record)}\n`);
  renameSync(`${path}.tmp`, path);
}

const STEPS: Record<MaintenanceKind, string[][]> = {
  repack: [['repack', '-d', '-q', '--geometric=2', '--write-midx'], ['prune-packed']],
  daily: [['prune', `--expire=${PRUNE_EXPIRE}`], ['repack', '-d', '-q', '--cruft', `--cruft-expiration=${PRUNE_EXPIRE}`, '--write-midx'], ['prune-packed']],
};

const prunableCount = async (repo: string) => (await git(repo, ['prune', '--dry-run', `--expire=${PRUNE_EXPIRE}`])).split('\n').filter(Boolean).length;

/**
 * What a run would do now. `manual` (the CLI) always plans a daily run; an automatic run (the maintenance cycle) plans
 * the run its triggers call for, or none, and never one where the user scheduled their own maintenance.
 */
export async function planMaintenance(repo: string, opts: { manual: boolean; now?: number }): Promise<MaintenancePlan> {
  const commonDir = await gitCommonDir(repo);
  const [stats, userScheduled] = await Promise.all([repoStats(repo), userScheduledMaintenance(repo, commonDir)]);
  const last = readMaintenanceRecord(commonDir);
  const now = opts.now ?? Date.now();
  const dailyDue = !last?.daily_at || now - Date.parse(last.daily_at) >= DAILY_MS;
  const grown = last?.after ? stats.loose_bytes - last.after.loose_bytes >= LOOSE_GROWTH_BYTES : false;
  const [kind, trigger]: [MaintenanceKind | null, MaintenanceTrigger | null] = opts.manual ? ['daily', 'manual']
    : userScheduled ? [null, null]
    : dailyDue ? ['daily', 'daily']
    : stats.loose_bytes > LOOSE_REPACK_BYTES ? ['repack', 'loose_bytes']
    : grown ? ['repack', 'loose_growth'] : [null, null];
  return { repo, common_dir: commonDir, stats, user_scheduled: userScheduled, last, kind, trigger, would_prune: kind === 'daily' ? await prunableCount(repo) : 0, steps: kind ? STEPS[kind] : [] };
}

/**
 * Run a plan under the maintenance lock (never the writer lock). Returns null when another run holds the lock. A failed
 * git step is recorded (`result: 'failed'`) and rethrown as `git_maintenance_failed`. A cycle passes its `signal` and
 * `deadlineAtMs`: no step starts once either is reached, and each step's timeout ends at the deadline, so a stopped run
 * is recorded as failed and the next run starts over (every step leaves the repository valid). `afterLock` is a test
 * seam that runs once the lock is held.
 */
export async function runMaintenance(plan: MaintenancePlan, opts: { now?: () => number; afterLock?: () => Promise<void>; signal?: AbortSignal; deadlineAtMs?: number } = {}): Promise<MaintenanceRecord | null> {
  if (!plan.kind || !plan.trigger) throw new Error('runMaintenance needs a plan with a kind');
  const lock = await acquireNativeLock(join(plan.common_dir, MAINTENANCE_LOCK_NAME), { timeoutMs: 0 });
  if (!lock) return null;
  const now = opts.now ?? Date.now;
  try {
    await opts.afterLock?.();
    const before = await repoStats(plan.repo);
    const pruned = plan.kind === 'daily' ? await prunableCount(plan.repo) : 0;
    const record: MaintenanceRecord = { at: '', kind: plan.kind, trigger: plan.trigger, result: 'ok', before, pruned_objects: 0, daily_at: plan.last?.daily_at ?? null };
    try {
      for (const step of STEPS[plan.kind]) {
        const left = opts.deadlineAtMs === undefined ? STEP_TIMEOUT_MS : Math.min(STEP_TIMEOUT_MS, opts.deadlineAtMs - now());
        if (opts.signal?.aborted || left <= 0) throw new Error(`stopped before git ${step[0]}: the maintenance cycle was ${opts.signal?.aborted ? 'cancelled' : 'past its deadline'}`);
        await git(plan.repo, step, left);
      }
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr || (error as Error).message || '').trim().split('\n').slice(-3).join(' ');
      writeMaintenanceRecord(plan.common_dir, { ...record, at: new Date(now()).toISOString(), result: 'failed', error: stderr });
      throw opError('git_maintenance_failed', `git maintenance of ${plan.repo} failed: ${stderr}`,
        'Nothing was rewritten past the failed step; read the git error, fix its cause, then run gbrain git maintenance again.');
    }
    const at = new Date(now()).toISOString();
    const done: MaintenanceRecord = { ...record, at, after: await repoStats(plan.repo), pruned_objects: pruned, daily_at: plan.kind === 'daily' ? at : record.daily_at };
    writeMaintenanceRecord(plan.common_dir, done);
    return done;
  } finally {
    await lock.release();
  }
}
