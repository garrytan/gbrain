/** `gbrain jobs supervisor` (dispatched by runJobs in src/commands/jobs.ts). */
import { hasFlag, parseFlag, parseJobIsolationFlag, parseMaxRssFlag, parseNiceFlag, type JobsCommandContext } from './shared.ts';
import { applyNiceness, formatNice, getEffectiveNiceness } from '../../core/minions/niceness.ts';
import { resolveChildCliInvocation } from '../../core/minions/job-isolation.ts';
import { WORKER_EXIT_CONFIGURATION } from '../../core/minions/worker-exit-codes.ts';

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
    await stopSupervisor(pidFile, jsonMode);
    return;
  }

  // ----- start subcommand (default) -----
  if (!isStartCmd) {
    console.error(`Unknown supervisor subcommand: ${supCmd}. Expected: start, status, stop.`);
    process.exit(1);
  }

  const config = (await import('../../core/config.ts')).loadConfig();
  if (config?.engine === 'pglite') {
    console.error('Error: Supervisor requires Postgres. PGLite uses an exclusive file lock that blocks other processes.');
    process.exit(1);
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
      console.error(`Error: --health-interval must be a non-negative integer (ms), got "${supHealthRaw}"`);
      process.exit(1);
    }
    if (parsed > 0 && parsed < 1000) {
      console.error(
        `Error: --health-interval ${parsed} is suspiciously low (likely a unit-confusion typo). ` +
        `The flag takes milliseconds; for 60-second probes pass 60000. Use 0 to disable.`,
      );
      process.exit(1);
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
    console.error('Could not resolve this worker installation. Repair the CLI or pass --cli-path.');
    process.exit(WORKER_EXIT_CONFIGURATION);
  }

  // --detach: fork a background supervisor, print PID payload, exit 0.
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
    const payload = {
      event: 'started',
      supervisor_pid: started.pid,
      pid_file: pidFile,
      detached: true,
      ...(started.stderrPath ? { stderr_log: started.stderrPath } : {}),
    };
    console.log(JSON.stringify(payload));
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

/** `gbrain jobs supervisor stop`: SIGTERM + drain wait; always exits the process. */
async function stopSupervisor(pidFile: string, jsonMode: boolean): Promise<void> {
  const { existsSync, readFileSync } = await import('fs');
  if (!existsSync(pidFile)) {
    const payload = { stopped: false, reason: 'pid_file_missing', pid_file: pidFile };
    if (jsonMode) console.log(JSON.stringify(payload));
    else console.error(`No PID file at ${pidFile}; supervisor not running.`);
    process.exit(1);
  }
  let supervisorPid: number;
  try {
    supervisorPid = parseInt(readFileSync(pidFile, 'utf8').trim().split('\n')[0], 10);
    if (isNaN(supervisorPid) || supervisorPid <= 0) throw new Error('invalid pid');
  } catch (err) {
    const payload = { stopped: false, reason: 'pid_file_corrupt', error: String(err) };
    if (jsonMode) console.log(JSON.stringify(payload));
    else console.error(`PID file corrupt: ${err}`);
    process.exit(1);
  }

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

  // Poll for up to 40s (supervisor's own 35s drain + 5s slack).
  const deadline = Date.now() + 40_000;
  let stoppedCleanly = false;
  while (Date.now() < deadline) {
    try { process.kill(supervisorPid, 0); }
    catch { stoppedCleanly = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }

  const payload = {
    stopped: stoppedCleanly,
    supervisor_pid: supervisorPid,
    reason: stoppedCleanly ? 'drained' : 'timeout_40s',
  };
  if (jsonMode) console.log(JSON.stringify(payload));
  else console.log(stoppedCleanly ? `Supervisor ${supervisorPid} stopped.` : `Supervisor ${supervisorPid} did not exit within 40s.`);
  process.exit(stoppedCleanly ? 0 : 1);
}
