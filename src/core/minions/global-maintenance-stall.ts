/**
 * Is brain-wide maintenance stalled? (GBRA-130 C-6, #6837)
 *
 * `assessGlobalMaintenanceStall` reads `autopilot.last_global_at`, the phase
 * streaks in `autopilot.global_maintenance.progress` and the
 * `autopilot-global-maintenance` jobs that ended without completing since the
 * stamp. Stalled (warn) means the stamp is older than STALL_WARN_FLOORS global
 * intervals while jobs failed or a phase streak is active; it fails once the
 * stamp is older than STALL_FAIL_MINUTES (or twice the warn age, if longer). A
 * pass that stamps past a phase that keeps failing, or past a triage deferral
 * that stopped shrinking (#7307), also warns; a deferral streak names
 * `gbrain dream retriage` as its fix. Doctor's
 * `global_maintenance_stalled` check reports it, and the autopilot daemon writes
 * the verdict to a file each full-cycle tick so the engine-free
 * `gbrain autopilot --status` exits 1 on it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { autopilotGlobalMaintenanceVerdictPath } from '../autopilot-paths.ts';

export const STALL_WARN_FLOORS = 3;
export const STALL_FAIL_MINUTES = 7 * 24 * 60;
/** A verdict file older than this was written by a daemon that stopped ticking; status ignores it. */
const VERDICT_TTL_MS = 24 * 60 * 60_000;

export interface StalledPhase {
  phase: string; key: string; count: number; first_at: string; last_at: string; retry_at: string | null; stamping_past: boolean;
  /** `deferred` streaks: transcripts deferred in the last pass, and passes in a row the count did not shrink. */
  deferred?: number; stalled?: number;
}

export interface GlobalMaintenanceStall {
  status: 'ok' | 'warn' | 'fail';
  /** `stalled`: no completed pass for too long; `failing_phase`: passes stamp past a phase that keeps failing. */
  reason: 'fresh' | 'stalled' | 'failing_phase';
  checked_at: string;
  last_global_at: string | null;
  age_minutes: number | null;
  warn_after_minutes: number;
  fail_after_minutes: number;
  failed_jobs_since: number;
  last_failed_job: { id: number; status: string; error_text: string | null } | null;
  phases: StalledPhase[];
  resume_phase: string | null;
  message: string;
  /** The next command: run the blocking phase in the foreground, judge a deferred triage backlog (`dream retriage`), or inspect the last failed job. */
  fix: string[] | null;
}

export async function assessGlobalMaintenanceStall(engine: BrainEngine, nowMs = Date.now()): Promise<GlobalMaintenanceStall> {
  const { LAST_GLOBAL_AT_KEY } = await import('../cycle.ts');
  const { readGlobalMaintenanceProgress, resolveGlobalFloorMin, phaseRetryCommand, streakStampsPast, DEFERRED_TRIAGE_FIX } = await import('./handlers/autopilot-global-maintenance.ts');
  const lastMs = Date.parse((await engine.getConfig(LAST_GLOBAL_AT_KEY)) ?? '');
  const last = Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null;
  const floorMin = await resolveGlobalFloorMin(engine);
  const progress = await readGlobalMaintenanceProgress(engine);
  const [job] = await engine.executeRaw<{ id: number; status: string; error_text: string | null; total: number; since: string | null }>(
    `SELECT id, status, error_text, count(*) OVER ()::int AS total, min(finished_at) OVER ()::text AS since FROM minion_jobs
      WHERE name = 'autopilot-global-maintenance' AND status IN ('failed', 'dead', 'cancelled')
        AND ($1::timestamptz IS NULL OR finished_at > $1::timestamptz)
      ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`, [last]);
  const phases: StalledPhase[] = Object.entries(progress.failures ?? {})
    .map(([phase, s]) => ({ phase, key: s.key, count: s.count, first_at: s.first_at, last_at: s.last_at, retry_at: s.retry_at ?? null,
      stamping_past: streakStampsPast(s, s.count), ...(s.deferred !== undefined ? { deferred: s.deferred, stalled: s.stalled ?? 0 } : {}) }))
    .sort((a, b) => b.count - a.count);
  const warnAfter = floorMin * STALL_WARN_FLOORS;
  const failAfter = Math.max(STALL_FAIL_MINUTES, warnAfter * 2);
  const firstSigns = [job?.since, ...phases.map(p => p.first_at)].map(t => Date.parse(t ?? '')).filter(Number.isFinite);
  const sinceMs = last ? lastMs : firstSigns.length > 0 ? Math.min(...firstSigns) : null;
  const ageMin = sinceMs === null ? null : Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  const failedJobs = Number(job?.total ?? 0);
  const stalled = (failedJobs > 0 || phases.length > 0) && ageMin !== null && ageMin > warnAfter;
  const status: GlobalMaintenanceStall['status'] = stalled ? (ageMin! >= failAfter ? 'fail' : 'warn') : phases.some(p => p.stamping_past) ? 'warn' : 'ok';
  const reason: GlobalMaintenanceStall['reason'] = stalled ? 'stalled' : status === 'warn' ? 'failing_phase' : 'fresh';
  const lastJob = job ? { id: Number(job.id), status: job.status, error_text: job.error_text } : null;
  const top = reason === 'failing_phase' ? phases.find(p => p.stamping_past) : phases[0];
  const deferral = top?.key === 'deferred';
  const blocker = top
    ? `phase ${top.phase} has been blocked ${top.count} pass(es) in a row (${top.key}${top.retry_at ? `, backing off until ${top.retry_at}` : ''}${
      deferral && top.deferred !== undefined ? `, ${top.deferred} transcript(s) left untriaged last pass, not shrinking for ${top.stalled ?? 0} pass(es)` : ''})`
    : '';
  const jobs = failedJobs > 0
    ? `${failedJobs} autopilot-global-maintenance job(s) ended without completing since then (last #${lastJob!.id} ${lastJob!.status}: ${(lastJob!.error_text ?? 'no error recorded').slice(0, 200)})`
    : '';
  const fix = deferral ? DEFERRED_TRIAGE_FIX.split(' ') : top ? ['gbrain', 'dream', '--phase', top.phase] : lastJob ? ['gbrain', 'jobs', 'get', String(lastJob.id)] : null;
  const next = deferral
    ? `Triage stops at its dream.triage.max_ms window each pass; judge the backlog in one run without that window: preview with ${DEFERRED_TRIAGE_FIX} --dry-run, then ${DEFERRED_TRIAGE_FIX} (paid; it asks before spending more than a few dollars).`
    : top
      ? `Run it in the foreground to see the error: gbrain dream --phase ${top.phase}; after fixing the cause, retry it now with: ${phaseRetryCommand(top.phase)}.`
      : lastJob ? `Inspect the failed job: gbrain jobs get ${lastJob.id}.` : '';
  const message = status === 'ok'
    ? last ? `Brain-wide maintenance completed a pass at ${last}.` : 'Brain-wide maintenance has not run yet.'
    : reason === 'stalled'
      ? `Brain-wide maintenance has not completed a pass since ${last ?? 'it first ran'} (${Math.floor(ageMin! / 60)}h ago; warn after ${warnAfter / 60}h, fail after ${Math.round(failAfter / 1440)}d): ${[blocker, jobs].filter(Boolean).join('; ')}. ${next}`
      : `Brain-wide maintenance passes complete, but ${blocker}, so each pass stamps past it. ${next}`;
  return { status, reason, checked_at: new Date(nowMs).toISOString(), last_global_at: last, age_minutes: ageMin, warn_after_minutes: warnAfter,
    fail_after_minutes: failAfter, failed_jobs_since: failedJobs, last_failed_job: lastJob, phases, resume_phase: progress.next_phase ?? null, message, fix };
}

/** The daemon's tick: assess and write the verdict file the status command reads. */
export async function recordGlobalMaintenanceStallStatus(engine: BrainEngine): Promise<GlobalMaintenanceStall> {
  const verdict = await assessGlobalMaintenanceStall(engine);
  const path = autopilotGlobalMaintenanceVerdictPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(verdict) + '\n');
  renameSync(`${path}.tmp`, path);
  return verdict;
}

/** The latest verdict a ticking daemon wrote, or null (none, unreadable, or older than a day). */
export function readGlobalMaintenanceVerdict(nowMs = Date.now()): GlobalMaintenanceStall | null {
  try {
    const verdict = JSON.parse(readFileSync(autopilotGlobalMaintenanceVerdictPath(), 'utf-8')) as GlobalMaintenanceStall;
    return nowMs - Date.parse(verdict.checked_at) <= VERDICT_TTL_MS ? verdict : null;
  } catch { return null; }
}
