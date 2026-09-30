/**
 * Supervisor and worker health: supervisor liveness, singleton + max-rss, scheduling priority, worker OOM loop and DB pool reap health.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { computeWorkerOomLoopCheck, computePoolReapHealthCheck } from './pglite-worker.ts';
import type { Check } from '../../doctor.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';

async function runSupervisor(ctx: DoctorContext): Promise<Check[]> {
  const { engine, fastMode } = ctx;
  const checks: Check[] = [];

  // 3b-bis. Supervisor health (filesystem-only: PID liveness + audit log).
  // Reads the default PID file (`~/.gbrain/supervisor.pid` unless the user
  // overrode with GBRAIN_SUPERVISOR_PID_FILE) and the latest audit file
  // written by src/core/minions/handlers/supervisor-audit.ts. Surfaces
  // supervisor_running / last_start / crashes_24h / max_crashes_exceeded.
  // Does NOT run the supervisor itself — this is a read-only health check.
  try {
    const { DEFAULT_PID_FILE } = await import('../../../core/minions/supervisor.ts');
    const { readSupervisorEvents, summarizeCrashes } = await import('../../../core/minions/handlers/supervisor-audit.ts');
    const { readSupervisorPid } = await import('../../../core/minions/supervisor-pid.ts');

    const pidStatus = readSupervisorPid(DEFAULT_PID_FILE);
    const supervisorPid = pidStatus.pid;
    const pidfileRunning = pidStatus.running;

    // issue #2227 fix #1/#3: DEFAULT_PID_FILE is HOME-derived, so a supervisor
    // started under a different $HOME reads as "not running" even when healthy.
    // Consult the queue-scoped DB singleton lock (#1849, HOME-independent) before
    // warning. PID-reuse-safe (isLockHolderLive keys on lock freshness).
    let detectedViaDbLock = false;
    if (!pidfileRunning && engine) {
      try {
        const { inspectLock, isLockHolderLive } = await import('../../../core/db-lock.ts');
        const { supervisorLockId, SUPERVISOR_LOCK_TTL_MIN } = await import('../../../core/minions/supervisor.ts');
        const snap = await inspectLock(engine, supervisorLockId('default'));
        if (snap && isLockHolderLive(snap, SUPERVISOR_LOCK_TTL_MIN)) detectedViaDbLock = true;
      } catch { /* pre-migration / transient: pidfile-only */ }
    }
    const running = pidfileRunning || detectedViaDbLock;
    // #4518: under --fast, `engine` is null (the CLI dispatcher never
    // connects — see cli.ts's `if (args.includes('--fast'))` branch), so the
    // #1849 DB-lock fallback above is structurally unreachable. A supervisor
    // running the documented multi-queue pattern (distinct --pid-file per
    // named queue, e.g. `supervisor-cron.pid` + `supervisor-default.pid`)
    // never writes DEFAULT_PID_FILE either, so `running` is always false for
    // that install shape under --fast — not because it's actually down, but
    // because the ONE check that could prove otherwise was never attempted.
    // Don't assert "not running" on a check we know is inconclusive here.
    const dbLockCheckSkippedUnderFast = fastMode && !pidfileRunning && !engine;

    const events = readSupervisorEvents({ sinceMs: 24 * 60 * 60 * 1000 });
    const lastStart = events.filter(e => e.event === 'started').pop()?.ts ?? null;
    // Shared classifier — same code path runs in `gbrain jobs supervisor
    // status` (src/commands/jobs.ts). Counts only events whose `likely_cause`
    // is NOT in the clean denylist (clean_exit, graceful_shutdown). Pre-v0.34
    // entries lacking `likely_cause` fall back to `code !== 0`. Supersedes
    // v0.35.4.0's binary `classifyWorkerExit({code})` on this surface: the
    // `likely_cause` read correctly classifies SIGTERM (code=null,
    // likely_cause='graceful_shutdown') as clean, and produces per-cause
    // buckets so operators triage memory pressure (oom) vs code bugs
    // (runtime) without grep'ing JSONL. `classifyWorkerExit` is still
    // used by the supervisor's internal restart policy where the binary
    // shape is the right contract.
    const summary = summarizeCrashes(events);
    const crashes24h = summary.total;
    const causeStr = `runtime=${summary.by_cause.runtime_error} oom=${summary.by_cause.oom_or_external_kill} rss=${summary.by_cause.rss_watchdog} unknown=${summary.by_cause.unknown} legacy=${summary.by_cause.legacy}${summary.by_cause.rss_watchdog > 0 ? ' (see worker_oom_loop)' : ''}`;
    const maxCrashesEvent = events.filter(e => e.event === 'max_crashes_exceeded').pop() ?? null;

    // Only surface a Check if the supervisor was ever observed (stops the
    // "never used the supervisor" install from getting a warn about it).
    if (supervisorPid !== null || events.length > 0) {
      if (maxCrashesEvent) {
        checks.push({
          name: 'supervisor',
          status: 'fail',
          message: `Supervisor gave up at ${maxCrashesEvent.ts} (max_crashes_exceeded). Restart with: gbrain jobs supervisor start --detach`,
        });
      } else if (!running && dbLockCheckSkippedUnderFast && events.length > 0) {
        // #4518: pidfile check found nothing at the HOME-derived default
        // path, but under --fast we never got to try the #1849 DB-lock
        // fallback that would prove a per-queue --pid-file supervisor is
        // actually alive. Say so instead of asserting a liveness verdict
        // this run structurally couldn't determine.
        checks.push({
          name: 'supervisor',
          status: 'ok',
          message: `Not found at the default pidfile path (last_start=${lastStart ?? 'unknown'}) — inconclusive under --fast (DB-lock fallback needs a connection). Run \`gbrain doctor\` without --fast to verify a per-queue --pid-file supervisor.`,
        });
      } else if (!running && events.length > 0) {
        checks.push({
          name: 'supervisor',
          status: 'warn',
          message: `Supervisor not running (last_start=${lastStart ?? 'unknown'}). Restart with: gbrain jobs supervisor start --detach`,
        });
      } else if (crashes24h >= 1) {
        // Threshold dropped from `>3` (pre-fix, inflated by clean exits being
        // miscounted) to `>=1` (any real crash is signal). Per-cause breakdown
        // gives operators triage context without grep'ing the JSONL.
        checks.push({
          name: 'supervisor',
          status: 'warn',
          message: `Worker crashed ${crashes24h}x in last 24h (${causeStr}). Check ~/.gbrain/audit/supervisor-*.jsonl for context.`,
        });
      } else {
        checks.push({
          name: 'supervisor',
          status: 'ok',
          message: `running=true${detectedViaDbLock ? ' (detected via DB lock; pidfile not at the HOME-derived path)' : ` pid=${supervisorPid}`} last_start=${lastStart ?? 'unknown'} crashes_24h=${crashes24h} clean_exits_24h=${summary.clean_exits}`,
        });
      }
    }
  } catch {
    // Audit read / import failure is best-effort; skip silently.
  }

  // 3b-bis-2. Supervisor SINGLETON + effective max-rss (#1849). Separate check
  // from `supervisor` above (same Codex #11 precedent as the niceness split) so
  // a singleton-divergence warn can't clobber the crash/liveness precedence.
  //
  // The #1849 fix makes a queue-scoped DB lock the real singleton authority. A
  // second supervisor on the same (db, queue) now fails fast at start — but if
  // a rogue one slipped in BEFORE upgrade (or someone ran one with an explicit
  // --pid-file on a pre-fix binary), the lock holder's (host, pid) won't match
  // the local pidfile. Surface that mismatch + the effective --max-rss (the cap
  // a rogue supervisor would have fought over). Bare pid is meaningless across
  // hosts/containers, so we compare host+pid (Codex #25).
  try {
    const { DEFAULT_PID_FILE, supervisorLockId, classifySupervisorSingleton } = await import('../../../core/minions/supervisor.ts');
    const { readSupervisorEvents } = await import('../../../core/minions/handlers/supervisor-audit.ts');
    const { readSupervisorPid } = await import('../../../core/minions/supervisor-pid.ts');
    const { hostname } = await import('os');

    const events = readSupervisorEvents({ sinceMs: 24 * 60 * 60 * 1000 });
    const lastStarted = events.filter(e => e.event === 'started').pop() as
      | (Record<string, unknown> & { ts?: string })
      | undefined;

    // Only run when a supervisor was actually observed (no noise on installs
    // that never used it) and we have a live engine to read the lock row.
    if (lastStarted && engine) {
      const queue = typeof lastStarted.queue === 'string' ? lastStarted.queue : 'default';
      const effectiveMaxRss = typeof lastStarted.max_rss_mb === 'number' ? lastStarted.max_rss_mb : null;
      // The 'started' event already records the pid-file path actually in use
      // (this.opts.pidFile, which reflects a custom --pid-file). Prefer that
      // over re-deriving DEFAULT_PID_FILE locally so a custom --pid-file
      // deployment doesn't false-positive a singleton mismatch against itself.
      // Falls back to DEFAULT_PID_FILE when the event carries no usable value.
      const pidFilePath = typeof lastStarted.pid_file === 'string' && lastStarted.pid_file.length > 0
        ? lastStarted.pid_file
        : DEFAULT_PID_FILE;
      const localPid = readSupervisorPid(pidFilePath).pid;
      const localHost = hostname();

      // Read the DB singleton lock holder for this queue.
      const lockRows = await engine.executeRaw<{ holder_pid: number; holder_host: string; live: boolean }>(
        `SELECT holder_pid, holder_host, ttl_expires_at > now() AS live
           FROM gbrain_cycle_locks WHERE id = $1`,
        [supervisorLockId(queue)],
      );
      const lock = lockRows[0] ?? null;
      const rssStr = effectiveMaxRss !== null ? `${effectiveMaxRss}MB` : 'unknown';

      const verdict = classifySupervisorSingleton({
        lockLive: !!lock?.live,
        lockHolderHost: lock?.holder_host ?? null,
        lockHolderPid: lock?.holder_pid ?? null,
        localHost,
        localPid,
      });
      if (verdict === 'mismatch') {
        checks.push({
          name: 'supervisor_singleton',
          status: 'warn',
          message:
            `Queue '${queue}' singleton lock is held by ${lock!.holder_host}:${lock!.holder_pid}, ` +
            `but the local pidfile points to ${localHost}:${localPid ?? 'none'}. A second supervisor may be ` +
            `running with a different --max-rss (effective cap here: ${rssStr}). Stop the extra one ` +
            `and keep a single supervisor per queue: gbrain jobs supervisor stop.`,
          details: { queue, lock_holder: `${lock!.holder_host}:${lock!.holder_pid}`, local: `${localHost}:${localPid ?? 'none'}`, effective_max_rss_mb: effectiveMaxRss },
        });
      } else if (verdict === 'single') {
        checks.push({
          name: 'supervisor_singleton',
          status: 'ok',
          message: `Single supervisor on queue '${queue}' (holder=${lock!.holder_host}:${lock!.holder_pid}, max_rss=${rssStr}).`,
          details: { queue, effective_max_rss_mb: effectiveMaxRss },
        });
      }
    }
  } catch {
    // Best-effort (lock table may not exist on a very old brain); skip silently.
  }

  // 3b-sexies. Supervisor/worker scheduling priority (niceness, issue #1815).
  // SEPARATE check from `supervisor` above so a niceness divergence warn can
  // never clobber the supervisor check's max_crashes_exceeded fail/warn
  // precedence (Codex #11). Only surfaces when --nice was actually used (a live
  // worker exists or the supervisor recorded a niceness), so installs that never
  // touched --nice get no noise.
  try {
    const { DEFAULT_PID_FILE } = await import('../../../core/minions/supervisor.ts');
    const { readSupervisorPid } = await import('../../../core/minions/supervisor-pid.ts');
    const { readWorkers } = await import('../../../core/minions/worker-registry.ts');
    const { getEffectiveNiceness, formatNice } = await import('../../../core/minions/niceness.ts');

    const sup = readSupervisorPid(DEFAULT_PID_FILE);
    const supervisorNice = sup.running && sup.pid !== null ? getEffectiveNiceness(sup.pid) : null;
    const workers = readWorkers().map(w => ({
      pid: w.pid,
      queue: w.queue,
      brain_id: w.brain_id,
      nice_requested: w.nice_requested,
      nice_effective: w.nice_now,
    }));

    if (workers.length > 0 || supervisorNice !== null) {
      // Divergence: a worker (or the supervisor) asked for a niceness it didn't
      // get — usually negative nice without privilege, or an RLIMIT_NICE clamp.
      const diverged = workers.filter(
        w => w.nice_requested !== null && w.nice_effective !== null && w.nice_requested !== w.nice_effective,
      );

      const workerSummary = workers
        .map(w => `pid ${w.pid}=${w.nice_effective !== null ? formatNice(w.nice_effective) : '?'}`)
        .join(', ');
      const supPart = supervisorNice !== null ? `supervisor=${formatNice(supervisorNice)}` : '';
      const okMsg = [supPart, workerSummary && `workers: ${workerSummary}`].filter(Boolean).join('; ');

      if (diverged.length > 0) {
        const detail = diverged
          .map(w => `pid ${w.pid} requested ${formatNice(w.nice_requested!)} but running at ${formatNice(w.nice_effective!)}`)
          .join('; ');
        checks.push({
          name: 'supervisor_niceness',
          status: 'warn',
          message: `Niceness not applied as requested (${detail}). Negative nice needs privilege; the OS may also clamp to RLIMIT_NICE. Workers run at their inherited priority.`,
          details: { supervisor_nice: supervisorNice, workers },
        });
      } else {
        checks.push({
          name: 'supervisor_niceness',
          status: 'ok',
          message: okMsg || 'No niceness override active',
          details: { supervisor_nice: supervisorNice, workers },
        });
      }
    }
  } catch {
    // Registry / import failure is best-effort; skip silently.
  }

  // 3b-quater. Worker OOM-loop (issue #1685 GAP A) — the single authoritative
  // "is the worker OOM-looping" line, unioning supervised (supervisor audit)
  // and bare-worker (minion_jobs watchdog-abort) kills. Returns null when the
  // worker never OOM'd, so clean installs see nothing.
  try {
    const oomCheck = await computeWorkerOomLoopCheck(engine);
    if (oomCheck) checks.push(oomCheck);
  } catch {
    // best-effort.
  }

  // 3b-quinquies. DB pool reap health (issue #1685 GAP B) — Postgres pooler
  // reap frequency + recovered-vs-stuck split. Quiet unless reaps thrash or
  // reconnect is failing.
  try {
    const reapCheck = await computePoolReapHealthCheck(engine);
    if (reapCheck) checks.push(reapCheck);
  } catch {
    // best-effort.
  }
  return checks;
}

export const supervisorEntry: DoctorEntry = {
  name: 'supervisor',
  emits: ['supervisor', 'supervisor_singleton', 'supervisor_niceness', 'worker_oom_loop', 'pool_reap_health'],
  run: runSupervisor,
};
