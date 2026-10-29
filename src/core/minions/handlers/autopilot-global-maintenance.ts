/**
 * `autopilot-global-maintenance` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import { isAbsolute } from 'node:path';
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import type { CycleReport, PhaseResult } from '../../cycle.ts';
import { CODES } from '../../error-registry.ts';
import { ItemRun, classifyItemFailure } from '../../item-failure.ts';
import { OperationError } from '../../ops/contract.ts';
import { VERSION } from '../../../version.ts';
import { reportJobProgress } from './job-progress.ts';

/**
 * #4578: one pass over the maintenance phases may span several jobs. The
 * handler runs one phase per runCycle call, records which phase is running,
 * and stops starting phases when the job deadline would cut the next one off
 * (using that phase's last measured duration). The next job resumes at the
 * recorded phase. A phase that was running when a job died (timeout or crash)
 * is skipped for the rest of that pass so later phases still run; doctor's
 * `global_maintenance_timeouts` check reports it and names
 * `gbrain dream --phase <name>` to run it without the job deadline.
 *
 * GBRA-130 A-10 (#6837): a phase that blocks the stamp records a streak in the
 * same progress row (`failures[phase]`), counted once per pass. A typed
 * failure (`fail:<code>`) seen in STREAK_BYPASS_PASSES earlier passes stops
 * withholding `last_global_at`, and so does a triage deferral (#7307) whose
 * deferred count did not shrink across STREAK_BYPASS_PASSES passes; a deferral
 * backlog that shrinks keeps withholding it, and budget and child blockers
 * always do.
 * Failing and child kinds back off from their third pass. A streak recorded
 * by another gbrain version is dropped, a new blocker key starts a new streak,
 * and `gbrain autopilot --retry-global` ends the back-off. A job whose
 * failures look systemic (ItemRun breaker) persists no streak.
 *
 * A phase failure classified run-scoped is the phase's typed blocker too
 * (`fail:<code>`), and the job goes on to the next phase, unless it may pass
 * on the next job (RETRY_NEXT_JOB_CODES, or any run-scoped error runCycle
 * threw): then the job stops and the next job retries that phase first, at
 * most STREAK_BYPASS_PASSES jobs in a row (`run_stops`) before it is recorded
 * as the blocker, so the pass can still complete. A job's own stop (abort,
 * cancel, stolen lock) always stops it. A phase skipped for
 * `insufficient_cycle_budget` after another phase ran in the same job is
 * moved to the next job (a deadline deferral) instead of counting as a
 * `budget` blocker, and its skip time is never kept as its duration estimate.
 */
export const GLOBAL_MAINTENANCE_PROGRESS_KEY = 'autopilot.global_maintenance.progress';
/** A phase is not started when its last measured duration would end within this reserve of the job deadline. */
const DEADLINE_RESERVE_MS = 60_000;
/** Minutes between brain-wide passes (config `autopilot.global_floor_min` overrides). */
export const GLOBAL_FLOOR_MIN = 60;
/** Earlier passes with one typed failure before the pass stamps past that phase; also where back-off starts. */
export const STREAK_BYPASS_PASSES = 3;
const MAX_BACKOFF_MS = 24 * 60 * 60_000;
/** Run-scoped codes that may pass on the next job: the job stops and the next one retries the phase first. */
const RETRY_NEXT_JOB_CODES: ReadonlySet<string> = new Set([
  'database_contention', 'connection_lost', 'writer_busy', 'writer_lock_unavailable', 'writer_pool_capacity', 'queue_capacity',
  'write_capacity_backpressure', 'maintenance_backpressure', 'write_claim_lost',
]);
/** Stops that belong to the job itself: always stop it, never counted against the phase. */
const JOB_STOP_CODES: ReadonlySet<string> = new Set(['aborted', 'lock_stolen', 'cancelled']);

/** One phase's consecutive passes blocked by the same kind of blocker. */
export interface PhaseStreak {
  /** `fail:<code>` (the phase failed), `budget`, `child:<outcome>` or `deferred`. */
  key: string;
  count: number;
  first_at: string;
  last_at: string;
  /** The gbrain version that recorded it; another running version drops the streak. */
  version: string;
  /** The pass that last counted it, so a phase rerun within one pass counts once. */
  pass: string;
  /** The phase is not run before this time. */
  retry_at?: string;
  /** `deferred` only: transcripts triage deferred in the pass that last counted it. */
  deferred?: number;
  /** `deferred` only: consecutive passes whose deferred count did not shrink. */
  stalled?: number;
}

export interface GlobalMaintenanceProgress {
  /** Phase the next job starts at; absent at the start of a pass. */
  next_phase?: string;
  /** Phase running right now, and the job running it. Left set when a job dies mid-phase. */
  running_phase?: string;
  running_job?: string;
  /** Last measured duration per phase (ms). */
  durations?: Record<string, number>;
  /** Phases that were running when a job died, with consecutive death counts. Cleared when the phase completes. */
  timeouts?: Record<string, { count: number; last_at: string }>;
  /** Phases skipped in the current pass because they killed a job. */
  skip_this_pass?: string[];
  /** A phase in the current pass blocked the stamp; the pass does not stamp last_global_at. */
  pass_failed?: boolean;
  /** Identity of the current pass. */
  pass_id?: string;
  /** Phases the current pass stamps past (a typed failure with a long enough streak). */
  pass_bypassed?: string[];
  /** Blocker streak per phase; cleared when the phase passes. */
  failures?: Record<string, PhaseStreak>;
  /** Consecutive jobs a phase stopped with the same retryable run-scoped code; cleared when the phase completes. */
  run_stops?: Record<string, { code: string; count: number; last_at: string }>;
}

export async function readGlobalMaintenanceProgress(engine: BrainEngine): Promise<GlobalMaintenanceProgress> {
  try {
    const raw = await engine.getConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed as GlobalMaintenanceProgress : {};
  } catch { return {}; }
}

export async function resolveGlobalFloorMin(engine: BrainEngine): Promise<number> {
  const n = parseInt((await engine.getConfig('autopilot.global_floor_min')) ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : GLOBAL_FLOOR_MIN;
}

/** The command that ends a phase's back-off so the next pass runs it. */
export function phaseRetryCommand(phase: string): string {
  return `gbrain autopilot --retry-global --phase ${phase}`;
}

/** Judges every transcript triage keeps deferring, without the dream.triage.max_ms window (#7307). */
export const DEFERRED_TRIAGE_FIX = 'gbrain dream retriage';

/** The next command for a phase streak: retriage for a triage deferral, else the back-off release. */
export function phaseStreakFix(phase: string, streak: Pick<PhaseStreak, 'key'>): string {
  return streak.key === 'deferred' ? DEFERRED_TRIAGE_FIX : phaseRetryCommand(phase);
}

/** Whether a pass stamps past this streak: a typed failure or a non-shrinking deferral, STREAK_BYPASS_PASSES passes long. */
export function streakStampsPast(streak: Pick<PhaseStreak, 'key' | 'stalled'>, earlierPasses: number): boolean {
  if (streak.key.startsWith('fail:')) return earlierPasses >= STREAK_BYPASS_PASSES;
  return streak.key === 'deferred' && (streak.stalled ?? 0) >= STREAK_BYPASS_PASSES;
}

/** The stamp gate: the blocker kind when this phase result means the pass did not finish its work, else null. */
function phaseBlocker(phase: PhaseResult): string | null {
  if (phase.status === 'fail') return `fail:${phase.code ?? phase.error?.code ?? 'unknown'}`;
  if (phase.phase !== 'synthesize' && phase.phase !== 'patterns') return null;
  if (phase.details.reason === 'insufficient_cycle_budget') return 'budget';
  if (phase.phase === 'patterns') {
    const outcome = phase.details.child_outcome;
    return typeof outcome === 'string' && outcome !== 'completed' ? `child:${outcome}` : null;
  }
  const synthesis = phase.details.synthesis as { non_completed_jobs?: number } | undefined;
  const triage = phase.details.triage as { deferred?: number } | undefined;
  if ((synthesis?.non_completed_jobs ?? 0) > 0) return 'child:non_completed';
  if (Array.isArray(phase.details.budget_deferred_transcripts) && phase.details.budget_deferred_transcripts.length > 0) return 'budget';
  return (triage?.deferred ?? 0) > 0 ? 'deferred' : null;
}

/** A failed phase result as the error the item classifier reads. */
function phaseFailureError(result: PhaseResult): Error {
  const code = result.code ?? result.error?.code;
  const message = result.error?.message ?? result.summary;
  if (code && code in CODES) return new OperationError(code as never, message, result.error?.hint ?? 'Rerun the phase with gbrain dream --phase ' + result.phase + ' once the cause is fixed.');
  return Object.assign(new Error(message), code ? { code } : {});
}

function backoffUntil(key: string, count: number, lastAt: string, floorMin: number): string | undefined {
  if (!(key.startsWith('fail:') || key.startsWith('child:')) || count < STREAK_BYPASS_PASSES) return undefined;
  const ms = Math.min(MAX_BACKOFF_MS, floorMin * 60_000 * 2 ** (count - STREAK_BYPASS_PASSES + 1));
  return new Date(Date.parse(lastAt) + ms).toISOString();
}

/**
 * Brain-wide maintenance. Runs mixed + global phases ONCE per window instead
 * of repeating cross-source transcript/reflection reads in every source.
 * No source_id → uses the legacy global cycle lock; stamps autopilot.last_global_at
 * when a pass completes without a blocking phase so the dispatch gate backs off.
 */
export function makeAutopilotGlobalMaintenanceHandler(engine: BrainEngine, deps: { runCycle?: typeof import('../../cycle.ts').runCycle } = {}): MinionHandler {
  return async (job) => {
    const cycle = await import('../../cycle.ts');
    const { MAINTENANCE_PHASES, LAST_GLOBAL_AT_KEY } = cycle;
    const runCycle = deps.runCycle ?? cycle.runCycle;
    // #7630: a relative path names whatever directory the worker runs from, so it is no checkout.
    const configured: string | null = typeof job.data.repoPath === 'string'
      ? job.data.repoPath
      : (await engine.getConfig('sync.repo_path')) ?? null;
    const repoPath = configured && isAbsolute(configured) ? configured : null;

    // #4250: queued maintenance payloads are machine-authored too — intersect
    // with MAINTENANCE_PHASES so a stale (or remote-submitted) payload can't
    // run source-scoped phases through the global lane, symmetric with the
    // per-source normalization in the autopilot-cycle handler.
    const maintenanceSet = new Set<string>(MAINTENANCE_PHASES);
    const requested = Array.isArray(job.data.phases)
      ? (job.data.phases as string[]).filter((p) => maintenanceSet.has(p))
      : MAINTENANCE_PHASES;
    const phases = (requested.length > 0 ? requested : MAINTENANCE_PHASES) as typeof MAINTENANCE_PHASES;

    const progress = await readGlobalMaintenanceProgress(engine);
    const save = async () => {
      try { await engine.setConfig(GLOBAL_MAINTENANCE_PROGRESS_KEY, JSON.stringify(progress)); }
      catch (e) { console.warn(`[autopilot-global-maintenance] failed to record progress: ${e instanceof Error ? e.message : String(e)}`); }
    };
    progress.durations ??= {};
    progress.timeouts ??= {};
    progress.skip_this_pass ??= [];
    progress.failures ??= {};
    progress.run_stops ??= {};
    for (const [phase, streak] of Object.entries(progress.failures)) {
      if (streak.version !== VERSION) delete progress.failures[phase];
    }
    const failuresAtStart = JSON.stringify(progress.failures);
    const floorMin = await resolveGlobalFloorMin(engine);
    const runToken = `${job.id}:${job.attempts_made ?? 0}`;
    const recordTimeout = (phase: string) => {
      const prev = progress.timeouts![phase];
      progress.timeouts![phase] = { count: (prev?.count ?? 0) + 1, last_at: new Date().toISOString() };
      if (!progress.skip_this_pass!.includes(phase)) progress.skip_this_pass!.push(phase);
    };
    const died = progress.running_phase;
    if (died && progress.running_job !== runToken) {
      recordTimeout(died);
      console.warn(`[autopilot-global-maintenance] phase ${died} was running when an earlier job died; skipping it for this pass. Run it alone with: gbrain dream --phase ${died}`);
    }
    const resumeAt = progress.next_phase ? phases.indexOf(progress.next_phase as never) : -1;
    const start = resumeAt >= 0 ? resumeAt : 0;
    if (start === 0) {
      progress.pass_failed = false;
      progress.pass_id = `${runToken}@${new Date().toISOString()}`;
      progress.pass_bypassed = [];
    }
    progress.pass_bypassed ??= [];
    const passId = progress.pass_id ?? runToken;

    const itemRun = new ItemRun('autopilot.global_maintenance');
    /** Stops the job: a run-scoped error, or (breaker) a job whose failures look systemic, which records no streak. */
    const stopRun = async (error: unknown, phase: string | undefined): Promise<never> => {
      if (error instanceof OperationError && error.code === 'item_failures_systemic') progress.failures = JSON.parse(failuresAtStart);
      progress.running_phase = undefined;
      progress.running_job = undefined;
      progress.next_phase = phase;
      progress.pass_failed = true;
      await save();
      throw error;
    };
    const recordBlocker = (phase: string, key: string, deferredCount?: number): PhaseStreak => {
      const prev = progress.failures![phase];
      const same = prev?.key === key;
      if (same && prev.pass === passId) return prev;
      const now = new Date().toISOString();
      const count = same ? prev.count + 1 : 1;
      const retryAt = backoffUntil(key, count, now, floorMin);
      const stalled = same && deferredCount !== undefined && prev.deferred !== undefined && deferredCount >= prev.deferred ? (prev.stalled ?? 0) + 1 : 0;
      const streak: PhaseStreak = { key, count, first_at: same ? prev.first_at : now, last_at: now, version: VERSION, pass: passId,
        ...(retryAt ? { retry_at: retryAt } : {}), ...(key === 'deferred' && deferredCount !== undefined ? { deferred: deferredCount, stalled } : {}) };
      progress.failures![phase] = streak;
      return streak;
    };
    /** Whether a run-scoped failure stops the job (the next job retries the phase first) rather than becoming the phase's blocker. */
    const stopsJob = (phase: string, code: string, thrown: boolean): boolean => {
      if (JOB_STOP_CODES.has(code)) return true;
      if (!thrown && !RETRY_NEXT_JOB_CODES.has(code)) return false;
      const prev = progress.run_stops![phase];
      const count = prev?.code === code ? prev.count : 0;
      if (count >= STREAK_BYPASS_PASSES) return false;
      progress.run_stops![phase] = { code, count: count + 1, last_at: new Date().toISOString() };
      return true;
    };
    /** A run-scoped failure recorded as the phase's own: counted by the breaker, never rethrown by it. */
    const contained = (phase: string, code: string) => new Error(`phase ${phase} failed with run-scoped ${code}; recorded as its blocker`);
    const blockStamp = (phase: string, streak: PhaseStreak, earlierPasses: number) => {
      if (!streakStampsPast(streak, earlierPasses)) { progress.pass_failed = true; return; }
      if (!progress.pass_bypassed!.includes(phase)) progress.pass_bypassed!.push(phase);
    };

    const deadline = typeof job.deadlineAtMs === 'number' ? job.deadlineAtMs : null;
    const phaseDeadline = deadline !== null ? deadline - DEADLINE_RESERVE_MS : null;
    const reports: CycleReport[] = [];
    const ran: PhaseResult[] = [];
    let deferred: string[] = [];
    let stopReason: string | undefined;

    for (let i = start; i < phases.length; i++) {
      const phase = phases[i]!;
      if (progress.skip_this_pass.includes(phase)) {
        progress.pass_failed = true;
        ran.push({ phase, status: 'skipped', duration_ms: 0, summary: `skipped: killed an earlier job; run gbrain dream --phase ${phase}`,
          details: { reason: 'timed_out_previous_job', recovery: `gbrain dream --phase ${phase}` } });
        continue;
      }
      const streak = progress.failures[phase];
      if (streak?.retry_at && Date.parse(streak.retry_at) > Date.now()) {
        blockStamp(phase, streak, streak.count);
        ran.push({ phase, status: 'skipped', duration_ms: 0,
          summary: `skipped: blocked ${streak.count} passes in a row (${streak.key}); backing off until ${streak.retry_at}. Retry it now with: ${phaseRetryCommand(phase)}`,
          details: { reason: 'phase_backoff', blocker: streak.key, count: streak.count, retry_at: streak.retry_at, recovery: phaseRetryCommand(phase) } });
        continue;
      }
      const estimate = progress.durations[phase] ?? 0;
      if (i > start && phaseDeadline !== null && Date.now() + estimate > phaseDeadline) {
        deferred = phases.slice(i);
        stopReason = 'deadline';
        progress.next_phase = phase;
        break;
      }
      progress.running_phase = phase;
      progress.running_job = runToken;
      await save();
      await reportJobProgress(job, { phase, phase_index: i, phase_count: phases.length, started_at: new Date().toISOString() });
      let report: CycleReport;
      try {
        report = await runCycle(engine, {
        brainDir: repoPath,
        pull: false, // brain-wide DB/maintenance work never git-pulls
        signal: job.signal,
        deadlineAtMs: job.deadlineAtMs, // #2781: phases budget sub-work from remaining time
        // The maintenance lane is where synthesize/patterns actually run on
        // multi-source brains (per-source payloads normalize down to the
        // freshness phases) — without the owner id its private queues would be
        // owner-less and recovery would degrade to lease-expiry only.
        privateQueueOwnerJobId: job.id,
        phases: [phase],
        forceGlobalOrphans: true,
        yieldBetweenPhases: async () => { await new Promise<void>((r) => setImmediate(r)); },
        });
      } catch (e) {
        const classified = classifyItemFailure(e);
        const runScoped = classified.scope === 'run';
        if (runScoped && stopsJob(phase, classified.code, true)) return stopRun(e, phase);
        let failure;
        try { failure = itemRun.fail(phase, runScoped ? contained(phase, classified.code) : e); } catch (stop) { return stopRun(stop, phase); }
        const code = runScoped ? classified.code : failure.code;
        const message = runScoped ? classified.message.slice(0, 500) : failure.message;
        progress.running_phase = undefined;
        progress.running_job = undefined;
        ran.push({ phase, status: 'fail', duration_ms: 0, summary: `error: ${message}`, details: {},
          error: { class: 'InternalError', code, message } });
        const blocked = recordBlocker(phase, `fail:${code}`);
        blockStamp(phase, blocked, blocked.count - 1);
        continue;
      }
      progress.running_phase = undefined;
      progress.running_job = undefined;
      if (i > start && report.phases.some(r => r.phase === phase && r.details.reason === 'insufficient_cycle_budget')) {
        deferred = phases.slice(i);
        stopReason = 'deadline';
        progress.next_phase = phase;
        break;
      }
      reports.push(report);
      if (report.status === 'skipped' || report.reason === 'aborted' || report.reason === 'lock_stolen') {
        // A phase cut off by the job deadline would be cut off again next run.
        if (report.reason === 'aborted' && deadline !== null && Date.now() >= phaseDeadline!) {
          recordTimeout(phase);
          progress.pass_failed = true;
        }
        deferred = phases.slice(i);
        stopReason = report.reason ?? report.status;
        progress.next_phase = phase;
        break;
      }
      for (const result of report.phases) {
        ran.push(result);
        if (result.phase !== phase) continue;
        if (result.details.reason !== 'insufficient_cycle_budget') progress.durations[phase] = result.duration_ms;
        delete progress.timeouts[phase];
        if (result.status === 'fail') {
          const error = phaseFailureError(result);
          const classified = classifyItemFailure(error);
          if (classified.scope === 'run' && stopsJob(phase, classified.code, false)) return stopRun(error, phase);
          try { itemRun.fail(phase, classified.scope === 'run' ? contained(phase, classified.code) : error); } catch (stop) { return stopRun(stop, phase); }
        } else {
          delete progress.run_stops[phase];
          itemRun.succeed();
        }
        const key = phaseBlocker(result);
        if (!key) { delete progress.failures[phase]; continue; }
        const deferredCount = (result.details.triage as { deferred?: unknown } | undefined)?.deferred;
        const blocked = recordBlocker(phase, key, key === 'deferred' && typeof deferredCount === 'number' ? deferredCount : undefined);
        blockStamp(phase, blocked, blocked.count - 1);
      }
    }
    const systemic = itemRun.systemic();
    if (systemic) return stopRun(systemic, undefined);

    const passComplete = deferred.length === 0;
    if (passComplete) {
      progress.next_phase = undefined;
      progress.skip_this_pass = [];
    }
    await save();

    const totals = { ...(reports[0]?.totals ?? {}) } as CycleReport['totals'];
    for (const report of reports.slice(1)) {
      for (const [key, value] of Object.entries(report.totals)) {
        if (typeof value === 'number') (totals as Record<string, number>)[key] = ((totals as Record<string, number>)[key] ?? 0) + value;
      }
    }
    const last = reports[reports.length - 1];
    const statuses = reports.filter(r => r.status !== 'skipped').map(r => r.status);
    const status: CycleReport['status'] = statuses.length === 0
      ? (ran.some(p => p.details.reason === 'timed_out_previous_job') ? 'partial' : 'skipped')
      : deferred.length > 0 || ran.some(p => p.details.reason === 'timed_out_previous_job') ? 'partial'
        : statuses.every(st => st === 'failed') ? 'failed'
          : statuses.some(st => st === 'failed' || st === 'partial') ? 'partial'
            : statuses.some(st => st === 'ok') ? 'ok' : 'clean';
    const report: CycleReport & { deferred_phases?: string[]; resume_phase?: string } = {
      ...(last ?? { schema_version: '1', timestamp: new Date().toISOString(), brain_dir: repoPath }),
      duration_ms: reports.reduce((n, r) => n + r.duration_ms, 0),
      status,
      ...(stopReason ? { reason: stopReason } : {}),
      phases: ran,
      totals,
      ...(deferred.length ? { deferred_phases: deferred, resume_phase: progress.next_phase } : {}),
    } as CycleReport & { deferred_phases?: string[]; resume_phase?: string };
    if (deferred.length > 0 && stopReason === 'deadline') {
      console.warn(`[autopilot-global-maintenance] stopping before the job deadline; ${deferred.length} phase(s) resume at ${progress.next_phase} on the next run`);
    }

    let stamped = false;
    if (passComplete && !progress.pass_failed && reports.length > 0
      && (status === 'ok' || status === 'clean' || status === 'partial')
      && report.reason !== 'aborted' && report.reason !== 'lock_stolen') {
      try {
        await engine.setConfig(LAST_GLOBAL_AT_KEY, new Date().toISOString());
        stamped = true;
      } catch (e) {
        console.warn(`[autopilot-global-maintenance] failed to stamp last_global_at: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const streaks = Object.entries(progress.failures).map(([phase, s]) => ({ phase, ...s, fix: phaseStreakFix(phase, s) }));
    const stampedPast = stamped ? streaks.filter(s => progress.pass_bypassed!.includes(s.phase)) : [];

    return {
      partial: report.status === 'partial' || report.status === 'failed',
      status: report.status,
      report,
      ...(streaks.length > 0 ? { phase_streaks: streaks } : {}),
      ...(stampedPast.length > 0 ? { pass_completed_with_failing_phase: stampedPast } : {}),
    };
  };
}
