/** `gbrain jobs supervisor` (dispatched by runJobs in src/commands/jobs.ts). */
import { hasFlag, parseFlag, parseJobIsolationFlag, parseMaxRssFlag, parseNiceFlag, type JobsCommandContext } from './shared.ts';
import { applyNiceness, formatNice, getEffectiveNiceness } from '../../core/minions/niceness.ts';
import { resolveChildCliInvocation } from '../../core/minions/job-isolation.ts';
import { WORKER_EXIT_CONFIGURATION } from '../../core/minions/worker-exit-codes.ts';
import { writeStdoutFinal } from '../../core/cli-force-exit.ts';
import { opError } from '../../core/ops/contract.ts';
import { usageError, writeCliRefusal } from '../../cli/cli-error.ts';
import type { BrainEngine } from '../../core/engine.ts';

export async function runJobsSupervisor({ args, engine, engineOrNull }: JobsCommandContext): Promise<void> {
  // Dispatcher for supervisor subcommands:
  //   gbrain jobs supervisor                    → foreground start (back-compat)
  //   gbrain jobs supervisor start [--detach]   → foreground or detached start
  //   gbrain jobs supervisor status             → JSON liveness + queue stats
  //   gbrain jobs supervisor stop               → SIGTERM + drain wait
  const { MinionSupervisor, DEFAULT_PID_FILE } = await import('../../core/minions/supervisor.ts');
  const { writeSupervisorEvent } = await import('../../core/minions/handlers/supervisor-audit.ts');

  const supCmd = args[1];
  const isStatusCmd = supCmd === 'status';
  const isStopCmd = supCmd === 'stop';
  const isStartCmd = supCmd === 'start' || supCmd === undefined || supCmd === '--detach' ||
                      (typeof supCmd === 'string' && supCmd.startsWith('--'));
  const jsonMode = hasFlag(args, '--json');
  const pidFile = parseFlag(args, '--pid-file') ?? DEFAULT_PID_FILE;

  // ----- status subcommand -----
  if (isStatusCmd) {
    await showSupervisorStatus({ args, engine, engineOrNull }, pidFile, jsonMode);
    return;
  }

  // ----- stop subcommand -----
  if (isStopCmd) {
    await stopSupervisor(engine, args, pidFile, jsonMode);
    return;
  }

  // ----- start subcommand (default) -----
  // D2: refusals keep their stderr line; under --json the envelope is the stdout document
  // (written directly: the `jobs` record has no record-wide json contract, see runJobsSupervisor's detach branch).
  if (!isStartCmd) {
    process.exit(writeCliRefusal(usageError(`Unknown supervisor subcommand: ${supCmd}. Expected: start, status, stop.`,
      'Example: gbrain jobs supervisor start --detach --json'), 'jobs', { json: jsonMode }));
  }

  const config = (await import('../../core/config.ts')).loadConfig();
  if (config?.engine === 'pglite') {
    process.exit(writeCliRefusal(opError('config_error', 'Supervisor requires Postgres. PGLite uses an exclusive file lock that blocks other processes.',
      'On PGLite, run background maintenance through `gbrain serve` (or run jobs inline with `gbrain jobs submit --follow`).'),
    'jobs', { json: jsonMode, human: 'Error: Supervisor requires Postgres. PGLite uses an exclusive file lock that blocks other processes.' }));
  }

  const { resolveGbrainCliPath } = await import('../autopilot.ts');

  const concurrency = parseInt(parseFlag(args, '--concurrency') ?? '2', 10);
  const queueName = parseFlag(args, '--queue') ?? 'default';
  const maxCrashes = parseInt(parseFlag(args, '--max-crashes') ?? '10', 10);
  // --health-interval (supervisor): validate same as `jobs work` so NaN /
  // negative / sub-1000ms typos fail-fast instead of silently disabling
  // the supervisor's own health probe.
  const supHealthRaw = parseFlag(args, '--health-interval');
  let healthInterval = 60_000;
  if (supHealthRaw !== undefined) {
    const parsed = parseInt(supHealthRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      process.exit(writeCliRefusal(usageError(`--health-interval must be a non-negative integer (ms), got "${supHealthRaw}"`,
        'Example: gbrain jobs supervisor start --health-interval 60000'), 'jobs',
      { json: jsonMode, human: `Error: --health-interval must be a non-negative integer (ms), got "${supHealthRaw}"` }));
    }
    if (parsed > 0 && parsed < 1000) {
      const msg = `--health-interval ${parsed} is suspiciously low (likely a unit-confusion typo). ` +
        `The flag takes milliseconds; for 60-second probes pass 60000. Use 0 to disable.`;
      process.exit(writeCliRefusal(usageError(msg, 'Example: gbrain jobs supervisor start --health-interval 60000'), 'jobs', { json: jsonMode, human: `Error: ${msg}` }));
    }
    healthInterval = parsed;
  }
  const allowShellJobs = hasFlag(args, '--allow-shell-jobs') ||
                         process.env.GBRAIN_ALLOW_SHELL_JOBS === '1'; // same literal the shell handler checks
  const detach = hasFlag(args, '--detach');
  // Supervisor's --max-rss: explicit wins; absent → cgroup-aware auto-size
  // (issue #1678). The supervisor is the main production path, so the
  // watchdog is on by default — but at a realistic, RAM-relative cap
  // instead of the old flat 2048MB footgun.
  const { resolveDefaultMaxRssMb: resolveSupMaxRss } =
    await import('../../core/minions/rss-default.ts');
  const maxRssMb = parseMaxRssFlag(args) ?? resolveSupMaxRss();

  // --nice N (issue #1815): validated here (fail-fast on bad input even for
  // --detach), but APPLIED only in the foreground-start path below — applying
  // before the --detach branch would renice the throwaway parent that forks
  // and exits, not the long-lived re-exec'd child (Codex #1).
  const supNice = parseNiceFlag(args);

  const explicitCliPath = parseFlag(args, '--cli-path');
  const workerInvocation = explicitCliPath
    ? { cmd: explicitCliPath, argsPrefix: [] }
    : resolveChildCliInvocation({}, process.execPath, process.argv[1], resolveGbrainCliPath);
  if (!workerInvocation) {
    writeCliRefusal(opError('config_error', 'Could not resolve this worker installation. Repair the CLI or pass --cli-path.',
      'Pass --cli-path <path to the gbrain CLI>, or reinstall gbrain.'), 'jobs', { json: jsonMode });
    process.exit(WORKER_EXIT_CONFIGURATION);
  }

  // --detach: fork a background supervisor, print PID payload, exit 0.
  // D2: the payload is the one stdout document (writeStdoutFinal works without
  // the guard; the `jobs` record declares no record-wide json because other
  // jobs subcommands stream). status names the outcome; stderr_log is the
  // detached child's log.
  // #4418: the child gets a DURABLE stderr sink (audit-dir log, null-device
  // fallback) instead of inheriting the invoker's stderr — an inherited
  // capture pipe closing killed the worker (SIGPIPE 141) and then the
  // supervisor itself on their next stderr write. See detached-stderr.ts.
  if (detach) {
    const { spawnDetachedSupervisor } = await import('../../core/minions/detached-stderr.ts');
    const started = spawnDetachedSupervisor(
      process.execPath,
      process.argv[1],
      process.argv.slice(2).filter(a => a !== '--detach'),
    );
    if (started.pid === undefined) {
      process.exit(writeCliRefusal(opError('unavailable', 'The detached supervisor process could not be started.',
        `Run \`gbrain jobs supervisor start\` in the foreground to see the error${started.stderrPath ? `, or read ${started.stderrPath}` : ''}.`),
      'jobs', { json: true }));
    }
    const payload = {
      event: 'started',
      status: 'started',
      supervisor_pid: started.pid,
      pid_file: pidFile,
      detached: true,
      ...(started.stderrPath ? { stderr_log: started.stderrPath } : {}),
    };
    await writeStdoutFinal(`${JSON.stringify(payload)}\n`);
    process.exit(0);
  }

  // Foreground start. Renice THIS process (the long-lived supervisor) now,
  // after the --detach fork-and-exit branch (Codex #1). The worker inherits
  // it via the spawn env; the supervisor also passes `--nice` down so the
  // worker re-applies it (see buildWorkerArgs).
  const supervisorPid = process.pid;
  let supNiceResult: ReturnType<typeof applyNiceness> | undefined;
  if (supNice !== undefined) {
    supNiceResult = applyNiceness(supNice);
    if (!supNiceResult.applied) {
      console.error(
        `[gbrain jobs] could not set supervisor niceness to ${supNice}: ${supNiceResult.error ?? 'unknown'}. ` +
        `Negative nice needs privilege; running at niceness ${supNiceResult.effective ?? 'unchanged'}.`,
      );
    }
  }
  const supervisor = new MinionSupervisor(engine, {
    concurrency,
    queue: queueName,
    pidFile,
    maxCrashes,
    healthInterval,
    cliPath: workerInvocation.cmd,
    cliArgsPrefix: workerInvocation.argsPrefix,
    allowShellJobs,
    json: jsonMode,
    maxRssMb,
    jobIsolation: parseJobIsolationFlag(args),
    ...(supNice !== undefined ? { nice_requested: supNice } : {}),
    ...(supNiceResult?.effective != null ? { nice_effective: supNiceResult.effective } : {}),
    ...(supNiceResult?.error ? { nice_error: supNiceResult.error } : {}),
    onEvent: (emission) => writeSupervisorEvent(emission, supervisorPid),
  });

  await supervisor.start();
}

/** `gbrain jobs supervisor status`: liveness + queue stats; always exits the process. */
async function showSupervisorStatus(
  { args, engine, engineOrNull }: Pick<JobsCommandContext, 'args' | 'engine' | 'engineOrNull'>,
  pidFile: string,
  jsonMode: boolean,
): Promise<void> {
  const { readSupervisorEvents, summarizeCrashes } = await import('../../core/minions/handlers/supervisor-audit.ts');
  const { readSupervisorPid } = await import('../../core/minions/supervisor-pid.ts');
  const { readWorkers } = await import('../../core/minions/worker-registry.ts');

  const pidStatus = readSupervisorPid(pidFile);
  const supervisorPid = pidStatus.pid;
  const pidfileRunning = pidStatus.running;

  const events = readSupervisorEvents({ sinceMs: 24 * 60 * 60 * 1000 });
  const lastStart = events.filter(e => e.event === 'started').pop()?.ts ?? null;

  // issue #2227 fix #1/#3: the pidfile is HOME-derived, so a supervisor
  // started under a different $HOME (keeper=/root vs ops=/data) reads as
  // "not running" here even when it is healthy — the false signal that
  // makes an operator spawn a duplicate. Fall back to the queue-scoped DB
  // singleton lock (#1849), the HOME-independent authority. PID-reuse-safe:
  // isLockHolderLive keys on lock freshness, never process.kill.
  const supQueue = parseFlag(args, '--queue') ?? 'default';
  let detectedViaDbLock = false;
  let dbLockHolder: { holder_pid: number; holder_host: string } | null = null;
  if (!pidfileRunning && engineOrNull) {
    try {
      const { inspectLock, isLockHolderLive } = await import('../../core/db-lock.ts');
      const { supervisorLockId, SUPERVISOR_LOCK_TTL_MIN } = await import('../../core/minions/supervisor.ts');
      const snap = await inspectLock(engine, supervisorLockId(supQueue));
      if (snap && isLockHolderLive(snap, SUPERVISOR_LOCK_TTL_MIN)) {
        detectedViaDbLock = true;
        dbLockHolder = { holder_pid: snap.holder_pid, holder_host: snap.holder_host };
      }
    } catch {
      // Pre-migration brains / transient DB errors: fall back to pidfile-only.
    }
  }
  const running = pidfileRunning || detectedViaDbLock;
  // Surface the supervisor's recorded config from the latest `started`
  // event (concurrency + effective --max-rss) so split-$HOME deployments
  // see what the live-but-pidfile-invisible supervisor is running.
  const startedEvt = events.filter(e => e.event === 'started').pop() ?? null;
  // Shared classifier — same code path runs in `gbrain doctor` so the
  // two surfaces cannot drift on what counts as a crash. Supersedes
  // v0.35.4.0's binary `classifyWorkerExit({code})` on this surface;
  // see doctor.ts for the layering rationale.
  const summary = summarizeCrashes(events);
  const maxCrashesEvent = events.filter(e => e.event === 'max_crashes_exceeded').pop() ?? null;

  // Niceness (issue #1815): measure live workers + the supervisor itself.
  const workers = readWorkers().map(w => ({
    pid: w.pid,
    queue: w.queue,
    nice_requested: w.nice_requested,
    nice: w.nice_now,
  }));
  const supervisorNice = pidfileRunning && supervisorPid !== null
    ? getEffectiveNiceness(supervisorPid)
    : null;
  const { readOwnerProcessingStatus } = await import('../../core/minions/processing-state.ts');
  const { resolve: resolvePidPath } = await import('node:path');
  const processing = pidfileRunning && supervisorPid !== null
    ? readOwnerProcessingStatus('supervisor', resolvePidPath(pidFile), supervisorPid)
    : null;

  const status = {
    running,
    processing_ready: processing?.processing_ready ?? false,
    processing_state: processing?.processing_state ?? (running ? 'unknown' : 'stopped'),
    processing_stage: processing?.processing_stage ?? (running ? 'unknown' : 'stopped'),
    retry_at: processing?.retry_at ?? null,
    reason_code: processing?.reason_code ?? null,
    blocked_since: processing?.blocked_since ?? null,
    worker_identity: processing?.worker_identity ?? null,
    child_identity: processing?.child_identity ?? null,
    detected_via: detectedViaDbLock ? 'db_lock' : (pidfileRunning ? 'pidfile' : null),
    supervisor_pid: supervisorPid ?? dbLockHolder?.holder_pid ?? null,
    db_lock_holder: dbLockHolder,
    pid_file: pidFile,
    queue: supQueue,
    last_start: lastStart,
    concurrency: typeof startedEvt?.concurrency === 'number' ? startedEvt.concurrency : null,
    max_rss_mb: typeof startedEvt?.max_rss_mb === 'number' ? startedEvt.max_rss_mb : null,
    crashes_24h: summary.total,
    clean_exits_24h: summary.clean_exits,
    crashes_by_cause: summary.by_cause,
    max_crashes_exceeded: !!maxCrashesEvent,
    nice: supervisorNice,
    workers,
  };

  if (jsonMode) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    const via = detectedViaDbLock ? ' (detected via DB lock; pidfile not found at the configured path)' : '';
    console.log(`Supervisor: ${running ? 'running' : 'not running'}${via}`);
    console.log(`  Processing:    ${status.processing_state}`);
    console.log(`  Stage:         ${status.processing_stage}${status.retry_at ? `; next retry ${status.retry_at}` : ''}`);
    if (status.processing_state === 'configuration_blocked') {
      console.log(`  Repair:        ${status.reason_code ?? 'local configuration failure'}; repair the installation and restart the supervisor. See docs/guides/minions-fix.md.`);
    }
    if (status.supervisor_pid) console.log(`  PID:           ${status.supervisor_pid}${detectedViaDbLock ? ` @ ${dbLockHolder?.holder_host}` : ''}`);
    console.log(`  PID file:      ${pidFile}`);
    if (detectedViaDbLock && status.concurrency !== null) console.log(`  Concurrency:   ${status.concurrency}${status.max_rss_mb !== null ? ` (max-rss ${status.max_rss_mb}MB)` : ''}`);
    if (lastStart) console.log(`  Last start:    ${lastStart}`);
    console.log(`  Crashes (24h):     ${summary.total} (runtime=${summary.by_cause.runtime_error} oom=${summary.by_cause.oom_or_external_kill} unknown=${summary.by_cause.unknown} legacy=${summary.by_cause.legacy})`);
    console.log(`  Clean exits (24h): ${summary.clean_exits}`);
    if (supervisorNice !== null) console.log(`  Nice (supervisor): ${formatNice(supervisorNice)}`);
    for (const w of workers) {
      const req = w.nice_requested !== null && w.nice !== null && w.nice_requested !== w.nice
        ? ` (requested ${formatNice(w.nice_requested)})` : '';
      console.log(`  Worker pid ${w.pid} [${w.queue}]: nice ${w.nice !== null ? formatNice(w.nice) : '?'}${req}`);
    }
    if (maxCrashesEvent) console.log(`  ⚠ Max crashes exceeded at ${maxCrashesEvent.ts}`);
  }
  process.exit(running ? 0 : 1);
}

/** #5062: supervisor's own 35s worker drain + 5s SIGKILL confirmation + slack. */
const STOP_WAIT_MS = 45_000;

/**
 * `gbrain jobs supervisor stop`: SIGTERM, wait for the exit, then verify the
 * stop before calling it drained; always exits the process. #5062: "the pid
 * is gone" is not enough. Success also needs the supervisor's own `stopped`
 * audit row (after its `shutting_down`) saying the worker drained, every
 * worker it spawned gone, and its queue lock row released. Anything less is
 * reported with the failing check and exits 1. W9F item 7: the audit rows are
 * the run's own (from its `started` row, searched back across weekly files);
 * a worker is live only when its pid is alive with the start time recorded at
 * spawn; a run with no `started` row on record is `unverified`, never
 * `drained`; and a PID file whose pid now belongs to a different process
 * (start time mismatch) is reported `stale_pid_file` without signaling it.
 */
async function stopSupervisor(engine: BrainEngine, args: string[], pidFile: string, jsonMode: boolean): Promise<void> {
  const { existsSync, readFileSync } = await import('fs');
  const { hostname } = await import('os');
  const { readSupervisorRun } = await import('../../core/minions/handlers/supervisor-audit.ts');
  const { supervisorLockId } = await import('../../core/minions/supervisor.ts');
  const { inspectLock } = await import('../../core/db-lock.ts');
  const { processStartTime } = await import('../../core/pglite-lock.ts');
  const report = (payload: Record<string, unknown>, human: string, ok: boolean): never => {
    if (jsonMode) console.log(JSON.stringify(payload));
    else if (ok) console.log(human);
    else console.error(human);
    process.exit(ok ? 0 : 1);
  };
  const isAlive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  };
  // W9F item 7: a live pid whose kernel start time differs from the recorded
  // one is a different (recycled) process. Unknown start times compare equal.
  const sameProcess = (pid: number, recordedStart: unknown): boolean => {
    if (!isAlive(pid)) return false;
    const current = processStartTime(pid);
    return typeof recordedStart !== 'string' || current === null || current === recordedStart;
  };

  if (!existsSync(pidFile)) {
    report({ stopped: false, reason: 'pid_file_missing', pid_file: pidFile }, `No PID file at ${pidFile}; supervisor not running.`, false);
  }
  let supervisorPid: number;
  let recordedStart: string | null;
  try {
    const [pidLine, startLine] = readFileSync(pidFile, 'utf8').trim().split('\n');
    supervisorPid = parseInt(pidLine, 10);
    if (isNaN(supervisorPid) || supervisorPid <= 0) throw new Error('invalid pid');
    recordedStart = /^\d+$/.test(startLine?.trim() ?? '') ? startLine!.trim() : null;
  } catch (err) {
    return report({ stopped: false, reason: 'pid_file_corrupt', error: String(err) }, `PID file corrupt: ${err}`, false);
  }

  const before = readSupervisorRun(supervisorPid, { supervisorStart: recordedStart });
  const supervisorStart = recordedStart ?? before.started?.supervisor_start;
  if (isAlive(supervisorPid) && !sameProcess(supervisorPid, supervisorStart)) {
    report({ stopped: false, reason: 'stale_pid_file', supervisor_pid: supervisorPid, pid_file: pidFile },
      `PID file ${pidFile} names pid ${supervisorPid}, which now belongs to a different process; the supervisor is not running and nothing was signaled.`, true);
  }
  const queue = (typeof before.started?.queue === 'string' ? before.started.queue : undefined) ?? parseFlag(args, '--queue') ?? 'default';

  try { process.kill(supervisorPid, 'SIGTERM'); }
  catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const payload = {
      stopped: false,
      reason: code === 'ESRCH' ? 'process_gone' : 'kill_failed',
      supervisor_pid: supervisorPid,
    };
    if (jsonMode) console.log(JSON.stringify(payload));
    else console.error(`Cannot signal PID ${supervisorPid}: ${err}`);
    process.exit(code === 'ESRCH' ? 0 : 1);
  }

  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline && isAlive(supervisorPid)) {
    await new Promise(r => setTimeout(r, 250));
  }
  if (isAlive(supervisorPid)) {
    report({ stopped: false, supervisor_pid: supervisorPid, reason: 'timeout', waited_ms: STOP_WAIT_MS },
      `Supervisor ${supervisorPid} did not exit within ${STOP_WAIT_MS / 1000}s.`, false);
  }

  const run = readSupervisorRun(supervisorPid, { supervisorStart: typeof supervisorStart === 'string' ? supervisorStart : null });
  if (!run.started) {
    report({ stopped: true, supervisor_pid: supervisorPid, queue, reason: 'unverified', drained: false, audit_files: run.files },
      `Supervisor ${supervisorPid} exited, but its audit trail has no record of the run (missing, pruned or corrupt; searched ${run.files.length ? run.files.join(', ') : 'no existing audit files'}), so the drain cannot be verified. ` +
      'Inspect in-flight jobs with `gbrain jobs list --status active`.', false);
  }
  const events = run.events;
  const shuttingIdx = events.map(e => e.event).lastIndexOf('shutting_down');
  const stoppedEvt = shuttingIdx >= 0 ? events.slice(shuttingIdx + 1).find(e => e.event === 'stopped') : undefined;
  // The live set: spawns with no later exit. An exit row carries the child's
  // pid (null: no process was created); a row written before exits carried
  // one (no `pid` key) pairs with the oldest open spawn.
  const open: Array<{ pid: number; start: unknown }> = [];
  let legacyPairing = false;
  for (const e of events) {
    if (e.event === 'worker_spawned' && typeof e.pid === 'number') open.push({ pid: e.pid, start: e.pid_start });
    if (e.event !== 'worker_exited' || e.pid === null) continue;
    if (!('pid' in e)) legacyPairing = true;
    const idx = typeof e.pid === 'number' ? open.findIndex(w => w.pid === e.pid) : 0;
    if (idx >= 0) open.splice(idx, 1);
  }
  const liveWorkers = open.filter(w => sameProcess(w.pid, w.start)).map(w => w.pid);
  let lockReleased: boolean | null;
  try {
    const snap = await inspectLock(engine, supervisorLockId(queue));
    lockReleased = !(snap && snap.holder_pid === supervisorPid && snap.holder_host === hostname());
  } catch {
    lockReleased = null;
  }
  const checks = {
    process_exited: true,
    stopped_event: stoppedEvt !== undefined,
    worker_drained: stoppedEvt?.drained === true,
    workers_exited: liveWorkers.length === 0,
    lock_released: lockReleased,
  };
  const reason = !checks.stopped_event ? 'no_stopped_event'
    : !checks.workers_exited ? 'worker_still_running'
      : lockReleased === null ? 'lock_unverified'
        : !lockReleased ? 'lock_still_held'
          : !checks.worker_drained ? 'forced'
            : 'drained';
  const drained = reason === 'drained';
  const human = drained
    ? `Supervisor ${supervisorPid} stopped; worker drained.`
    : `Supervisor ${supervisorPid} exited but the stop is not verified as drained (${reason}): ` +
      `${JSON.stringify(checks)}${liveWorkers.length > 0 ? `; live worker pid(s): ${liveWorkers.join(', ')}` : ''}. ` +
      'Inspect in-flight jobs with `gbrain jobs list --status active`.';
  if (legacyPairing) console.error('Warning: audit rows written before worker exits carried a pid were paired with spawns by order.');
  report({ stopped: true, supervisor_pid: supervisorPid, queue, reason, drained, checks,
    ...(liveWorkers.length > 0 ? { live_worker_pids: liveWorkers } : {}),
    ...(legacyPairing ? { warnings: ['legacy_exit_pairing'] } : {}) }, human, drained);
}
