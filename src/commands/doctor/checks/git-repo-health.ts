/**
 * `git_repo_health` (Wave C 1C, G7): for each strict source (`config.canonical = "git"`) with a checkout on this host, the
 * Git object store gbrain maintains (`src/core/git/maintenance.ts`): loose bytes, pack count, packed size and the last
 * recorded maintenance run (automatic or `gbrain git maintenance --apply`). Warns above 256 MiB loose or 50 packs, on a
 * failed last run, and at 2 GB packed when a remote is on github.com (GitHub's soft repository limits); says when the
 * user scheduled git's own maintenance there (the cycle skips it) or `git.maintenance` is off. The fix previews and
 * then runs the maintenance, which runs without the writer lock. Counts and sizes only, never a path.
 *
 * It also runs `git fsck --connectivity-only` on each repository and FAILS with `git_objects_missing` when an object
 * that HEAD, a ref or the index needs is gone (the after-the-fact check for prune's own race window, docs below). That
 * walk reads every reachable object, so it shares one bound across sources (`GBRAIN_DOCTOR_GIT_FSCK_TIMEOUT_MS`, default
 * 20 s, and never past the entry's deadline); a repository it did not finish is reported as not checked, never as whole.
 */
import { existsSync } from 'node:fs';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, doctorVerify } from '../check-fix.ts';
import { isGitCheckout } from '../../../core/persistence/git-gap.ts';
import { gitAsync } from '../../../core/sync-git.ts';
import { GIT_MAINTENANCE_KEY, GITHUB_PACKED_WARN_BYTES, LOOSE_REPACK_BYTES, PACK_COUNT_WARN, gitCommonDir, readMaintenanceRecord, repoStats,
  userScheduledMaintenance, type MaintenanceRecord, type RepoStats, type UserScheduled } from '../../../core/git/maintenance.ts';

const DOCS = 'docs/guides/shared-checkout-git.md#git-maintenance';
const GIT_OBJECTS_MISSING_DOCS = 'docs/guides/shared-checkout-git.md#missing-git-objects';

/** `GBRAIN_DOCTOR_GIT_FSCK_TIMEOUT_MS` (default 20 s): the wall-clock bound of the connectivity walks of one doctor run. */
export function gitFsckTimeoutMs(): number {
  const n = parseInt(process.env.GBRAIN_DOCTOR_GIT_FSCK_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

type Connectivity = { state: 'ok' } | { state: 'missing'; objects: string[] } | { state: 'not_checked'; reason: string };

/** Objects HEAD, a ref or the index point at that the object store lacks (`git fsck --connectivity-only`), within `deadline`. */
async function connectivity(repo: string, deadline: number): Promise<Connectivity> {
  const timeoutMs = deadline - Date.now();
  if (timeoutMs <= 0) return { state: 'not_checked', reason: 'the doctor time budget ran out before this repository' };
  try {
    await gitAsync(repo, ['fsck', '--connectivity-only', '--no-dangling', '--no-progress'], { silenceStderr: true, timeoutMs });
    return { state: 'ok' };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; signal?: string | null; message?: string };
    const out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
    const objects = [...new Set(out.split('\n').filter(line => /^missing \w+ |invalid sha1 pointer/.test(line))
      .flatMap(line => line.match(/\b[0-9a-f]{40}(?:[0-9a-f]{24})?\b/g) ?? []))];
    if (objects.length) return { state: 'missing', objects };
    return { state: 'not_checked', reason: e.signal ? `git fsck did not finish within ${Math.round(timeoutMs / 1000)} s` : `git fsck failed: ${(out.trim() || e.message || '').split('\n').pop()}` };
  }
}

interface SourceHealth {
  source_id: string; stats: RepoStats; github: boolean; user_scheduled: UserScheduled | null; connectivity: Connectivity;
  last_run: Pick<MaintenanceRecord, 'at' | 'kind' | 'result' | 'error' | 'pruned_objects'> | null; problems: string[];
}

async function runGitRepoHealth(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  ctx.progress.heartbeat('git_repo_health');
  const checks: Check[] = [];
  try {
    const disabled = (await engine.getConfig(GIT_MAINTENANCE_KEY))?.trim().toLowerCase() === 'off';
    const rows = await engine.executeRaw<{ id: string; local_path: string | null }>(
      "SELECT id, local_path FROM sources WHERE NOT archived AND COALESCE(config->>'canonical','')='git' ORDER BY id");
    const sources: SourceHealth[] = [];
    const fsckDeadline = Math.min(Date.now() + gitFsckTimeoutMs(), ctx.entryDeadlineAt ?? Infinity);
    for (const row of rows) {
      if (!row.local_path || !existsSync(row.local_path) || !isGitCheckout(row.local_path)) continue;
      const commonDir = await gitCommonDir(row.local_path);
      const [stats, userScheduled, remotes] = await Promise.all([repoStats(row.local_path), userScheduledMaintenance(row.local_path, commonDir),
        gitAsync(row.local_path, ['remote', '-v'], { silenceStderr: true }).catch(() => '')]);
      const last = readMaintenanceRecord(commonDir);
      ctx.progress.heartbeat('git_repo_health');
      const reach = await connectivity(row.local_path, fsckDeadline);
      const github = /github\.com[:/]/i.test(remotes);
      const mib = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MiB`;
      const problems = [
        stats.loose_bytes > LOOSE_REPACK_BYTES ? `${mib(stats.loose_bytes)} of loose objects (over ${mib(LOOSE_REPACK_BYTES)})` : '',
        stats.packs > PACK_COUNT_WARN ? `${stats.packs} packs (over ${PACK_COUNT_WARN})` : '',
        last?.result === 'failed' ? `the last maintenance run (${last.at}) failed: ${last.error ?? 'unknown error'}` : '',
        github && stats.packed_bytes > GITHUB_PACKED_WARN_BYTES ? `${(stats.packed_bytes / 1000 ** 3).toFixed(1)} GB packed with a github.com remote, past GitHub's soft repository limits` : '',
      ].filter(Boolean);
      sources.push({ source_id: row.id, stats, github, user_scheduled: userScheduled, connectivity: reach,
        last_run: last ? { at: last.at, kind: last.kind, result: last.result, ...(last.error ? { error: last.error } : {}), pruned_objects: last.pruned_objects } : null, problems });
    }
    const details = { sources, maintenance: disabled ? 'off' : 'auto', docs: DOCS };
    const notes = [
      disabled ? `${GIT_MAINTENANCE_KEY} is off, so the maintenance cycle packs and prunes no repository.` : '',
      ...sources.filter(s => s.user_scheduled).map(s => `${s.source_id}: the user scheduled git's own maintenance (${s.user_scheduled}), so gbrain skips it.`),
      ...sources.flatMap(s => s.connectivity.state === 'not_checked' ? [`${s.source_id}: connectivity not checked (${s.connectivity.reason}; raise GBRAIN_DOCTOR_GIT_FSCK_TIMEOUT_MS to check it).`] : []),
    ].filter(Boolean);
    const broken = sources.flatMap(s => s.connectivity.state === 'missing' ? [{ source_id: s.source_id, objects: s.connectivity.objects }] : []);
    if (broken.length) {
      const first = broken[0]!.source_id;
      checks.push({ name: 'git_repo_health', status: 'fail', details: { ...details, code: 'git_objects_missing', missing: broken.map(b => ({ source_id: b.source_id, count: b.objects.length, sample: b.objects.slice(0, 5) })) },
        message: [`The Git object store of ${broken.map(b => `${b.source_id} lacks ${b.objects.length} object(s) its history needs (${b.objects.slice(0, 3).join(', ')})`).join('; ')}: git fsck --connectivity-only failed, so commits that name them cannot be read or pushed.`, ...notes].join(' '),
        fix: { consent: [], actor: 'user', requires_exclusive: false, docs: GIT_OBJECTS_MISSING_DOCS, verify: doctorVerify('git_repo_health'),
          why: `An object ${first}'s history references is gone from its object store; git cannot recreate it, so it has to come back from a copy that still has it.`,
          user_message: `Source ${first}'s Git repository is missing objects its history needs. Stop writers to it, then restore them from a copy that has them: run git fetch --refetch from its remote (when the commits were pushed), or copy the objects from another clone or a backup. A missing page blob whose file is unchanged in the checkout comes back with git hash-object -w on that file. Then run gbrain doctor --only git_repo_health. Steps: ${GIT_OBJECTS_MISSING_DOCS}.` } });
      return checks;
    }
    const unhealthy = sources.filter(s => s.problems.length);
    if (!unhealthy.length) {
      const summary = sources.map(s => `${s.source_id}: ${s.stats.loose_objects} loose, ${s.stats.packs} pack(s), last run ${s.last_run ? `${s.last_run.at} (${s.last_run.result})` : 'none'}`);
      checks.push({ name: 'git_repo_health', status: 'ok', details,
        message: [sources.length ? `Every strict source's Git object store is within bounds: ${summary.join('; ')}.` : 'No strict source has a Git checkout on this host.', ...notes].join(' ') });
      return checks;
    }
    const first = unhealthy[0]!.source_id;
    checks.push({ name: 'git_repo_health', status: 'warn', details,
      message: [`The Git object store of ${unhealthy.length} strict source(s) needs maintenance: ${unhealthy.map(s => `${s.source_id}: ${s.problems.join('; ')}`).join('. ')}.`, ...notes].join(' '),
      fix: agentFix(['gbrain', 'git', 'maintenance', '--source', first, '--apply'],
        `Packs ${first}'s loose objects and prunes unreachable objects older than git's two-week grace (one-way, approved as G7), without the writer lock; the preview shows the sizes and steps first. A repository past GitHub's size limits needs fewer large pages there, which maintenance does not change.`,
        'git_repo_health', { preview_argv: ['gbrain', 'git', 'maintenance', '--source', first, '--dry-run', '--json'], docs: DOCS }) });
  } catch (error) {
    checks.push({ name: 'git_repo_health', status: 'ok', details: { health: 'unknown', docs: DOCS },
      message: `Could not read the Git object stores of strict sources (${error instanceof Error ? error.message : String(error)}); gbrain git maintenance --source <id> --dry-run shows one.` });
  }
  return checks;
}

export const gitRepoHealthEntry: DoctorEntry = { name: 'git_repo_health', emits: ['git_repo_health'], run: runGitRepoHealth };
