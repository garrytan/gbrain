/** `gbrain jobs work` (dispatched by runJobs in src/commands/jobs.ts). */
import { hasFlag, parseFlag, parseJobIsolationFlag, parseMaxRssFlag, parseNiceFlag, resolveWorkerConcurrency, type JobsCommandContext } from './shared.ts';
import { applyNiceness, formatNice } from '../../core/minions/niceness.ts';
import { resolveChildCliInvocation } from '../../core/minions/job-isolation.ts';
import { checkWorkerStartup, reportWorkerConfiguration, reportWorkerReady, reportWorkerStarting } from '../jobs-readiness.ts';
import { LocalConfigurationError, isLocalConfigurationError } from '../../core/minions/configuration-error.ts';
import { WORKER_EXIT_CONFIGURATION, WORKER_EXIT_RSS_WATCHDOG } from '../../core/minions/worker-exit-codes.ts';
import { MinionWorker, type UnhealthyReason } from '../../core/minions/worker.ts';
import type { MinionQueue } from '../../core/minions/queue.ts';
import type { BrainEngine } from '../../core/engine.ts';

export async function maybeRunWorkerStartupRecovery(
  queue: MinionQueue,
  env: NodeJS.ProcessEnv = process.env,
  readinessVerified = false,
): Promise<void> {
  if (env.GBRAIN_SUPERVISED === '1' && !readinessVerified) return;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const recovered = await Promise.race([
      queue.reconcileOrphanedPrivateQueues({
        reason: 'worker startup recovery: orphaned dream-inline private queue',
      }),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('private-queue startup recovery did not settle within 30 seconds; recovery is unconfirmed')), 30_000);
      }),
    ]);
    if (recovered.cancelled_jobs > 0) {
      console.error(
        `[gbrain jobs] private-queue startup recovery: cancelled ${recovered.cancelled_jobs} ` +
        `job(s) across ${recovered.cancelled_queues} orphaned queue(s)`,
      );
    }
  } catch (e) {
    if (isLocalConfigurationError(e)) throw e;
    console.error(`[gbrain jobs] private-queue startup recovery failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

export async function runJobsWork({ args, engine, queue }: JobsCommandContext): Promise<void> {
  // Lazy: jobs.ts imports this module statically, so a static import back would be a cycle.
  const { registerBuiltinHandlers } = await import('../jobs.ts');
  // --allow-shell-jobs (supervisor pass-through, see buildWorkerArgs): the
  // startup cwd-.env quarantine drops GBRAIN_ALLOW_SHELL_JOBS when a .env
  // in this worker's cwd assigns it, so the flag re-asserts the operator's
  // opt-in AFTER preflight. Read sites keep checking the env var.
  if (hasFlag(args, '--allow-shell-jobs')) process.env.GBRAIN_ALLOW_SHELL_JOBS = '1';

  const queueName = parseFlag(args, '--queue') ?? 'default';
  if (engine.kind === 'pglite') {
    await drainPgliteQueue(engine, queue, queueName, registerBuiltinHandlers);
    return;
  }
  const concurrency = resolveWorkerConcurrency(args);
  // --max-rss: explicit value wins (including 0 to disable the watchdog).
  // Absent → cgroup-aware auto-size (issue #1678): the flat 2048MB default
  // killed legit embed work (~10GB) on every cycle and produced a silent
  // ~400×/24h respawn loop. See src/core/minions/rss-default.ts.
  const maxRssExplicit = parseMaxRssFlag(args);
  const { resolveDefaultMaxRssMb, describeDefaultMaxRss } =
    await import('../../core/minions/rss-default.ts');
  const maxRssMb = maxRssExplicit ?? resolveDefaultMaxRssMb();

  // --health-interval: self-health-check period in ms. 0 disables. Default: 60_000 (60s).
  // Provides DB liveness probes + stall detection for bare workers.
  // Automatically skipped when running under a supervisor (GBRAIN_SUPERVISED=1).
  // Validated aggressively (parity with --max-rss): reject NaN/negative/non-integer
  // values, and reject suspicious sub-1000ms values that are likely a unit-confusion
  // typo (e.g. "--health-interval 60" thinking the unit is seconds).
  const healthRaw = parseFlag(args, '--health-interval');
  let healthCheckInterval = 60_000;
  if (healthRaw !== undefined) {
    const parsed = parseInt(healthRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      console.error(`Error: --health-interval must be a non-negative integer (ms), got "${healthRaw}"`);
      process.exit(1);
    }
    if (parsed > 0 && parsed < 1000) {
      console.error(
        `Error: --health-interval ${parsed} is suspiciously low (likely a unit-confusion typo). ` +
        `The flag takes milliseconds; for 60-second probes pass 60000. Use 0 to disable.`,
      );
      process.exit(1);
    }
    healthCheckInterval = parsed;
  }

  // --nice N (issue #1815): renice this worker process so background work
  // yields CPU to foreground tasks without sacrificing concurrency. Applied
  // at the CLI layer (worker.ts stays embeddable). Niceness inherits to the
  // worker's spawned children (shell jobs / subagents) automatically.
  const niceVal = parseNiceFlag(args);
  let niceResult: ReturnType<typeof applyNiceness> | undefined;
  if (niceVal !== undefined) {
    niceResult = applyNiceness(niceVal);
    if (!niceResult.applied) {
      console.error(
        `[gbrain jobs] could not set niceness to ${niceVal}: ${niceResult.error ?? 'unknown'}. ` +
        `Negative nice needs privilege; running at niceness ${niceResult.effective ?? 'unchanged'}.`,
      );
    }
  }

  // issue #5: per-job process isolation. Resolve + validate the child CLI
  // invocation ONCE at startup and refuse to start on failure — a bad
  // path discovered per-job would release every claim as infra failures
  // (never dead-lettering, but never progressing either).
  const jobIsolation = parseJobIsolationFlag(args);
  let childCliInvocation: { cmd: string; argsPrefix: string[] } | null = null;
  let childTiniPath = '';
  if (jobIsolation === 'process') {
    const { resolveGbrainCliPath } = await import('../autopilot.ts');
    const inv = resolveChildCliInvocation(
      process.env,
      process.execPath,
      process.argv[1],
      () => resolveGbrainCliPath(),
    );
    if (!inv) {
      reportWorkerConfiguration(new LocalConfigurationError('child_executable_invalid', 'No child CLI could be resolved.'));
      process.exit(WORKER_EXIT_CONFIGURATION);
    }
    // Canonicalize BEFORE validating: existsSync on a relative name checks
    // cwd while spawn() resolves via PATH — the validated file and the
    // executed binary could differ (security review). Resolving to an
    // absolute path makes the fail-fast check and the spawn agree.
    const { existsSync: childCliExists } = await import('node:fs');
    const { resolve: resolveCliPath } = await import('node:path');
    inv.cmd = resolveCliPath(inv.cmd);
    if (!childCliExists(inv.cmd)) {
      reportWorkerConfiguration(new LocalConfigurationError('child_executable_invalid', 'The selected child CLI does not exist.'));
      process.exit(WORKER_EXIT_CONFIGURATION);
    }
    childCliInvocation = inv;
    const { detectTini } = await import('../../core/minions/spawn-helpers.ts');
    childTiniPath = detectTini();
    if (maxRssMb > 0) {
      console.error(
        '[gbrain jobs] note: with process isolation on, the --max-rss watchdog covers the ' +
        'WORKER process only — handler memory now lives in job children. Per-child caps are ' +
        'a filed follow-up; size host memory for concurrency x handler footprint.',
      );
    }
  }

  let childIdentity: Awaited<ReturnType<typeof checkWorkerStartup>>;
  try {
    childIdentity = await checkWorkerStartup(engine, childCliInvocation, childTiniPath);
  } catch (error) {
    if (isLocalConfigurationError(error)) {
      reportWorkerConfiguration(error);
      process.exit(WORKER_EXIT_CONFIGURATION);
    }
    console.error('[health] Worker readiness is temporarily unavailable; no jobs were admitted. The supervisor will retry.');
    process.exit(1);
  }

  try {
    await queue.ensureSchema();
    await maybeRunWorkerStartupRecovery(queue, process.env, true);
  } catch (error) {
    if (isLocalConfigurationError(error)) {
      reportWorkerConfiguration(error);
      process.exit(WORKER_EXIT_CONFIGURATION);
    }
    console.error('[gbrain jobs] Worker schema readiness failed; no jobs were admitted. Inspect doctor before retrying.');
    process.exit(1);
  }

  // issue #6: the direct-pool kill switch collapses lock renewal, health
  // probes, and handler workload onto ONE shared pool — silently. Make
  // the collapse loud at startup so a later 'pool_starved' incident has
  // an obvious prior warning instead of a mystery.
  {
    const { getConnectionRouting } = await import('../../core/minions/db-probe.ts');
    const cm = getConnectionRouting(engine);
    if (cm?.isDualPoolActive && !cm.isDualPoolActive()) {
      const killSwitched = cm.describeMode?.().kill_switch_active === true;
      console.error(
        `[gbrain jobs] single-pool mode: lock renewal, health probes and handler workload share ` +
        `one connection pool${killSwitched ? ' (direct-lane kill switch is active)' : ''}. ` +
        `Under heavy handler load this pool can starve the lock heartbeat. For Supabase brains, ` +
        `ensure the direct (5432) host is reachable or set GBRAIN_DIRECT_DATABASE_URL.`,
      );
    }
  }

  const worker = new MinionWorker(engine, {
    queue: queueName, concurrency, maxRssMb, healthCheckInterval,
    jobIsolation, childCliInvocation, childTiniPath,
  });
  try {
    await registerBuiltinHandlers(worker, engine);
  } catch (error) {
    if (!isLocalConfigurationError(error)) throw error;
    reportWorkerConfiguration(error);
    process.exit(WORKER_EXIT_CONFIGURATION);
  }

  // Subscribe to self-health failures emitted by the worker. Library code
  // (worker.ts) never calls process.exit directly so it stays embeddable;
  // this CLI layer is the right place to terminate the process and let
  // the external PM (systemd, Docker, cron watchdog) restart cleanly.
  worker.on('unhealthy', exitOnUnhealthy);

  const isSupervisedChild = process.env.GBRAIN_SUPERVISED === '1';
  let watchdogNote = '';
  if (maxRssMb > 0) {
    if (maxRssExplicit !== undefined) {
      watchdogNote = `, watchdog: ${maxRssMb}MB (explicit)`;
    } else {
      const d = describeDefaultMaxRss();
      watchdogNote = `, watchdog: ${maxRssMb}MB (auto-sized from ${Math.round(d.basisMb / 1024)}GB ${d.source} RAM)`;
    }
  }
  // issue #1801 (fix #2): the DB-liveness probe runs under supervision too;
  // only stall detection is supervised-off. Report accordingly.
  const healthNote = healthCheckInterval > 0
    ? (isSupervisedChild
        ? `, db-probe: ${Math.round(healthCheckInterval / 1000)}s`
        : `, health-check: ${Math.round(healthCheckInterval / 1000)}s`)
    : '';
  const niceNote = niceResult ? `, nice: ${formatNice(niceResult.effective ?? niceVal!)}` : '';
  const isolationNote = jobIsolation === 'process'
    ? `, isolation: process (child cli: ${childCliInvocation?.cmd}${childTiniPath ? ', tini' : ''})`
    : '';
  console.log(`Minion worker started (queue: ${queueName}, concurrency: ${concurrency}${watchdogNote}${healthNote}${niceNote}${isolationNote})`);
  console.log(`Registered handlers: ${worker.registeredNames.join(', ')}`);

  // Register in the live worker registry (issue #1815) so jobs stats / doctor
  // can report this worker's effective niceness. Cleanup runs on BOTH the
  // finally below AND process.on('exit') — the unhealthy handler's
  // process.exit(1) bypasses the awaited finally (Codex #10).
  const { registerWorker } = await import('../../core/minions/worker-registry.ts');
  const unregisterWorker = registerWorker({
    pid: process.pid,
    queue: queueName,
    nice_requested: niceVal ?? null,
    nice_effective: niceResult ? niceResult.effective : null,
    started_at: Date.now(),
  });
  process.on('exit', () => unregisterWorker());

  try {
    reportWorkerStarting('worker_startup');
    worker.once('ready', () => reportWorkerReady(childIdentity));
    await worker.start();
  } finally {
    unregisterWorker();
    if (worker.configurationError) {
      const releases = worker.configurationReleaseResults;
      const unconfirmed = releases.filter(result => result.outcome === 'unconfirmed').length;
      console.error(`[health] Configuration shutdown settled ${releases.length} claim(s); ${unconfirmed} release(s) unconfirmed.`);
      if (unconfirmed > 0) {
        console.error('[health] release-unconfirmed: execution or database release could not be confirmed. Lease expiry may consume stall budget or allow duplicate side effects; inspect affected jobs before retrying.');
      }
    }
    // Release the DB connection pool immediately on shutdown so
    // PgBouncer slots are freed rather than waiting for TCP keepalive
    // (~minutes). Disconnect failure is best-effort but logged loudly:
    // a silent shutdown disconnect error is exactly the bug class the
    // v0.26.9 D14 direction (isUndefinedColumnError, oauth-provider)
    // was created to surface. The CLI is the engine owner here, not
    // the worker — keeping disconnect at this layer preserves the
    // "engine ownership stays with the creator" invariant that broke
    // tests in earlier waves of this branch.
    try { await engine.disconnect(); }
    catch (e) { console.error('[gbrain jobs work] engine disconnect failed during shutdown:', e); }

    if (worker.configurationError) {
      process.exit(WORKER_EXIT_CONFIGURATION);
    }

    // If the RSS watchdog (not a normal SIGTERM) drained the worker, exit
    // with the distinct WORKER_EXIT_RSS_WATCHDOG code so the supervisor
    // classifies the drain as `rss_watchdog` (cause-keyed backoff + loud
    // alert) instead of a silent `clean_exit`. The worker exposes the
    // intent; the CLI owns process.exit (same ownership boundary as the
    // engine-disconnect above). Explicit process.exit also guarantees the
    // code even if a lingering handle would otherwise keep the process
    // alive past natural exit (issue #1678, Codex #7).
    if (worker.rssWatchdogTriggered) {
      process.exit(WORKER_EXIT_RSS_WATCHDOG);
    }
  }
}

/**
 * PGLite has no background worker (the brain is single-writer, so a daemon
 * would lock every other command out). There `gbrain jobs work` drains (agent-
 * first operator wave E5): it runs the queue's waiting jobs in the foreground,
 * registered as a live worker, and exits once none it can run are waiting or
 * active. Jobs scheduled for a later retry stay queued and are named.
 */
export async function drainPgliteQueue(
  engine: BrainEngine,
  queue: MinionQueue,
  queueName: string,
  registerHandlers: (worker: MinionWorker, engine: BrainEngine) => Promise<void>,
): Promise<{ delayed: number }> {
  await queue.ensureSchema();
  const worker = new MinionWorker(engine, { queue: queueName, pollInterval: 200, healthCheckInterval: 0 });
  await registerHandlers(worker, engine);
  const names = worker.registeredNames;
  const count = async (statuses: string[]): Promise<number> => {
    const [row] = await engine.executeRaw<{ n: number }>(
      'SELECT count(*)::int AS n FROM minion_jobs WHERE queue = $1 AND status = ANY($2::text[]) AND name = ANY($3::text[])',
      [queueName, statuses, names]);
    return Number(row?.n ?? 0);
  };
  const { registerWorker } = await import('../../core/minions/worker-registry.ts');
  const unregister = registerWorker({ pid: process.pid, queue: queueName, nice_requested: null, nice_effective: null, started_at: Date.now() });
  console.log(`Draining queue '${queueName}' in the foreground (PGLite has no background worker): ${await count(['waiting', 'active'])} runnable job(s).`);
  const running = worker.start();
  const poll = setInterval(() => {
    count(['waiting', 'active']).then(n => { if (n === 0) worker.stop(); }, () => worker.stop());
  }, 500);
  try {
    await running;
  } finally {
    clearInterval(poll);
    unregister();
  }
  const delayed = await count(['delayed']);
  console.log(`Queue '${queueName}' drained.${delayed > 0 ? ` ${delayed} job(s) are scheduled for a later retry; run \`gbrain jobs work${queueName === 'default' ? '' : ` --queue ${queueName}`}\` again after their backoff.` : ''}`);
  return { delayed };
}

/**
 * `jobs work` listener for the worker's self-health failures: report the
 * failing layer and exit so the process manager restarts the worker.
 */
function exitOnUnhealthy(info: UnhealthyReason): void {
  if (info.reason === 'client_misconfigured') {
    reportWorkerConfiguration(info.error);
    setTimeout(() => {
      console.error('[health] release-unconfirmed: shutdown exceeded its deadline; lease expiry may consume stall budget.');
      process.exit(WORKER_EXIT_CONFIGURATION);
    }, 31_000);
    return;
  }
  if (info.reason === 'db_dead') {
    // issue #6: name the failing LAYER, not just "DB unreachable" —
    // that message sent operators chasing database capacity while the
    // real fault was client-side pool exhaustion. Exiting is still
    // correct recovery either way (it frees every client-held slot).
    if (info.verdict === 'pool_starved') {
      console.error(
        `[health] FATAL: connection-pool path saturated after ${info.consecutiveFailures} probes — ` +
        `the database server itself is reachable. (${info.message}) ` +
        `Likely causes: long-running handler queries holding pool slots, or too-small GBRAIN_POOL_SIZE ` +
        `for this workload. Consider --job-isolation process for long-running handlers ` +
        `(handler connections then die with each job's child process). ` +
        `Exiting for process-manager restart (frees all client-held slots).`,
      );
    } else if (info.verdict === 'server_unreachable') {
      console.error(
        `[health] FATAL: database server unreachable after ${info.consecutiveFailures} probes ` +
        `(both pooler and direct lanes failed). (${info.message}) ` +
        `Exiting for process-manager restart.`,
      );
    } else {
      console.error(
        `[health] FATAL: DB probe failed ${info.consecutiveFailures} consecutive times (${info.message}). ` +
        `Exiting for process-manager restart.`,
      );
    }
  } else if (info.reason === 'child_spawn_failing') {
    console.error(
      `[health] FATAL: ${info.consecutiveFailures} consecutive job-child spawn/bootstrap ` +
      `failures (${info.message}). The child CLI is deterministically broken — fix the ` +
      `worker's child CLI configuration (or GBRAIN_JOB_CHILD_CLI). Exiting for ` +
      `process-manager restart.`,
    );
  } else {
    console.error(
      `[health] FATAL: Worker stalled — ${info.waitingCount} waiting job(s) for ` +
      `registered handlers, ${info.idleMinutes}m idle. Exiting for process-manager restart.`,
    );
  }
  process.exit(1);
}
