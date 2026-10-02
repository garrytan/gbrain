/** `gbrain jobs submit` (dispatched by runJobs in src/commands/jobs.ts). */
import { hasFlag, parseFlag, parseMaxWaitingFlag, type JobsCommandContext } from './shared.ts';
import { isProtectedJobName } from '../../core/minions/protected-names.ts';
import { assertEmbedBackfillQueueAdmission } from '../../core/minions/embed-backfill-admission.ts';
import { clampLockDurationMs } from '../../core/minions/handler-timeouts.ts';
import { MinionWorker } from '../../core/minions/worker.ts';
import { reportInlineWorkerConfiguration } from '../jobs-readiness.ts';

export async function runJobsSubmit({ args, engine, queue }: JobsCommandContext): Promise<void> {
  // Lazy: jobs.ts imports this module statically, so a static import back would be a cycle.
  const { registerBuiltinHandlers } = await import('../jobs.ts');
  const name = args[1]?.trim();
  if (!name) {
    console.error('Error: job name required. Usage: gbrain jobs submit <name>');
    process.exit(1);
  }

  const paramsStr = parseFlag(args, '--params');
  let data: Record<string, unknown> = {};
  if (paramsStr) {
    try { data = JSON.parse(paramsStr); }
    catch { console.error('Error: --params must be valid JSON'); process.exit(1); }
  }

  const priority = parseInt(parseFlag(args, '--priority') ?? '0', 10);
  const delay = parseInt(parseFlag(args, '--delay') ?? '0', 10);
  const maxAttempts = parseInt(parseFlag(args, '--max-attempts') ?? '3', 10);
  const maxStalledRaw = parseFlag(args, '--max-stalled');
  const maxStalled = maxStalledRaw !== undefined ? parseInt(maxStalledRaw, 10) : undefined;
  // --max-waiting N: submission-time backpressure cap. Mirrors --max-stalled
  // clamp [1, 100]. Feature is usable from CLI as of v0.19.1; pre-v0.19.1
  // only programmatic callers reached it.
  let maxWaiting: number | undefined;
  try { maxWaiting = parseMaxWaitingFlag(args); }
  catch (e) { console.error(`Error: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); }
  // v0.13.1 field audit: expose retry/backoff/timeout/idempotency knobs so
  // users can tune Minions behavior without dropping into TypeScript.
  const backoffTypeRaw = parseFlag(args, '--backoff-type');
  const backoffType = backoffTypeRaw === 'fixed' || backoffTypeRaw === 'exponential'
    ? backoffTypeRaw
    : undefined;
  const backoffDelayRaw = parseFlag(args, '--backoff-delay');
  const backoffDelay = backoffDelayRaw !== undefined ? parseInt(backoffDelayRaw, 10) : undefined;
  const backoffJitterRaw = parseFlag(args, '--backoff-jitter');
  const backoffJitter = backoffJitterRaw !== undefined ? parseFloat(backoffJitterRaw) : undefined;
  const timeoutMsRaw = parseFlag(args, '--timeout-ms');
  const timeoutMs = timeoutMsRaw !== undefined ? parseInt(timeoutMsRaw, 10) : undefined;
  if (timeoutMsRaw !== undefined && (isNaN(timeoutMs!) || timeoutMs! <= 0)) {
    console.error('Error: --timeout-ms must be a positive integer (milliseconds)');
    process.exit(1);
  }
  // #4145: per-job lock lease. Clamped to [5s,1h] in queue.add via
  // clampLockDurationMs (shared with the MCP op); NULL falls to the
  // handler map, then the worker default.
  const lockDurationMsRaw = parseFlag(args, '--lock-duration-ms');
  const lockDurationMs = lockDurationMsRaw !== undefined ? parseInt(lockDurationMsRaw, 10) : undefined;
  if (lockDurationMsRaw !== undefined && (isNaN(lockDurationMs!) || lockDurationMs! <= 0)) {
    console.error('Error: --lock-duration-ms must be a positive integer (milliseconds)');
    process.exit(1);
  }
  const idempotencyKey = parseFlag(args, '--idempotency-key');
  const queueName = parseFlag(args, '--queue') ?? 'default';
  const dryRun = hasFlag(args, '--dry-run');
  const follow = hasFlag(args, '--follow');
  // v0.36.5.0: --redact-secrets merges the equivalent --params JSON convenience.
  if (hasFlag(args, '--redact-secrets') && name === 'shell') {
    data.redact_secrets = true;
  }

  // Dry-run reports real admission; follow starts and awaits an inline worker.
  const trusted = {
    ...(isProtectedJobName(name) ? { allowProtectedSubmit: true } : {}),
    ...(follow && name === 'embed-backfill' ? { allowPgliteInlineWorker: true } : {}),
  };
  try { assertEmbedBackfillQueueAdmission(engine, name, data, trusted); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

  if (dryRun) {
    console.log(`[DRY RUN] Would submit job:`);
    console.log(`  Name: ${name}`);
    console.log(`  Queue: ${queueName}`);
    console.log(`  Priority: ${priority}`);
    console.log(`  Max attempts: ${maxAttempts}`);
    if (maxStalled !== undefined) console.log(`  Max stalled: ${maxStalled}`);
    if (maxWaiting !== undefined) console.log(`  Max waiting: ${maxWaiting}`);
    if (backoffType) console.log(`  Backoff type: ${backoffType}`);
    if (backoffDelay !== undefined) console.log(`  Backoff delay: ${backoffDelay}ms`);
    if (backoffJitter !== undefined) console.log(`  Backoff jitter: ${backoffJitter}`);
    if (timeoutMs !== undefined) console.log(`  Timeout: ${timeoutMs}ms`);
    if (lockDurationMs !== undefined) {
      // Echo what will actually be STORED (queue.add clamps to [5s,1h]);
      // a dry-run that prints the raw out-of-range input lies.
      const stored = clampLockDurationMs(lockDurationMs);
      console.log(`  Lock lease: ${stored}ms${stored !== lockDurationMs ? ` (clamped from ${lockDurationMs}ms)` : ''}`);
    }
    if (idempotencyKey) console.log(`  Idempotency key: ${idempotencyKey}`);
    if (delay > 0) console.log(`  Delay: ${delay}ms`);
    console.log(`  Data: ${JSON.stringify(data)}`);
    return;
  }

  try { await queue.ensureSchema(); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

  // v0.35.8.0: pre-enqueue shell-job validation. Validates `inherit:`
  // closed enum, rejects secret env-keys, fail-fasts on missing config.
  // Throws UnrecoverableError BEFORE `queue.add` so a bad payload never
  // lands in `minion_jobs.data`. Defense-in-depth re-validation happens
  // in the worker handler. See: src/core/minions/handlers/shell-validate.ts
  if (name === 'shell') {
    try {
      const { validateShellJobParams } = await import('../../core/minions/handlers/shell-validate.ts');
      validateShellJobParams(data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  }

  const job = await queue.add(name, data, {
    priority,
    delay: delay > 0 ? delay : undefined,
    max_attempts: maxAttempts,
    max_stalled: maxStalled,
    maxWaiting,
    backoff_type: backoffType,
    backoff_delay: backoffDelay,
    backoff_jitter: backoffJitter,
    timeout_ms: timeoutMs,
    lock_duration_ms: lockDurationMs,
    idempotency_key: idempotencyKey,
    queue: queueName,
  }, trusted);

  // Submission audit log (operational trace, not forensic insurance).
  try {
    const { logShellSubmission } = await import('../../core/minions/handlers/shell-audit.ts');
    if (name === 'shell') {
      const inheritNames = Array.isArray(data.inherit)
        ? (data.inherit as unknown[]).filter((s): s is string => typeof s === 'string')
        : undefined;
      logShellSubmission({
        caller: 'cli',
        remote: false,
        job_id: job.id,
        cwd: typeof data.cwd === 'string' ? data.cwd : '',
        cmd_display: typeof data.cmd === 'string' ? data.cmd.slice(0, 80) : undefined,
        argv_display: Array.isArray(data.argv)
          ? (data.argv as unknown[]).filter((a): a is string => typeof a === 'string').map((a) => a.slice(0, 80))
          : undefined,
        inherit: inheritNames && inheritNames.length > 0 ? inheritNames : undefined,
      });
    }
  } catch { /* audit failures never block submission */ }

  // Starvation warning (DX polish). Fire for every non-`--follow` shell submit
  // regardless of the submitter's own `GBRAIN_ALLOW_SHELL_JOBS` — submitter env
  // is a weak proxy for worker env. Two outcomes: no worker → the job waits;
  // an UNFLAGGED worker → the always-registered guarded handler dead-letters it.
  if (!follow && name === 'shell') {
    process.stderr.write(
      `\n⚠  Shell jobs require the shell handler enabled on the worker process\n` +
      `   (--allow-shell-jobs, or GBRAIN_ALLOW_SHELL_JOBS=1 exported from your shell).\n` +
      `   Your job was queued (id=${job.id}). It waits until a worker starts; a worker\n` +
      `   WITHOUT shell jobs enabled dead-letters it immediately (no retries). To run now:\n\n` +
      `     GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit shell \\\n` +
      `       --params '...' --follow\n\n` +
      `   Or start a persistent worker (Postgres only — PGLite uses --follow):\n\n` +
      `     gbrain jobs work --allow-shell-jobs\n\n`,
    );
  }

  if (follow) {
    console.log(`Job #${job.id} submitted (${name}). Executing inline...`);
    // Inline execution: run the job in this process. Disable the
    // self-health-check timer — inline flows are one-shot and don't have
    // a process manager to restart them. With the timer enabled and no
    // 'unhealthy' listener, a DB blip would trip emitUnhealthy's
    // no-listener fallback and call process.exit(1) from inside the
    // library, killing the user's CLI session.
    const worker = new MinionWorker(engine, {
      queue: queueName, pollInterval: 100, healthCheckInterval: 0,
    });

    // Register built-in handlers
    await registerBuiltinHandlers(worker, engine);

    if (!worker.registeredNames.includes(name)) {
      console.error(`Error: Unknown job type '${name}'.`);
      console.error(`Available types: ${worker.registeredNames.join(', ')}`);
      console.error(`Register custom types with worker.register('${name}', handler).`);
      process.exit(1);
    }

    // Run worker for one job then stop
    const startTime = Date.now();
    const workerPromise = worker.start();
    // Poll until this job completes
    const pollInterval = setInterval(async () => {
      const updated = await queue.getJob(job.id);
      if (updated && ['completed', 'failed', 'dead', 'cancelled'].includes(updated.status)) {
        worker.stop();
        clearInterval(pollInterval);
      }
    }, 200);
    await workerPromise;
    clearInterval(pollInterval);

    const final = await queue.getJob(job.id);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (final?.status === 'completed') {
      console.log(`Job #${job.id} completed in ${elapsed}s`);
      if (final.result) console.log(`Result: ${JSON.stringify(final.result)}`);
    } else {
      console.error(`Job #${job.id} ${final?.status}: ${final?.error_text}`);
      if (worker.configurationError) reportInlineWorkerConfiguration(worker.configurationError);
      process.exit(1);
    }
  } else {
    console.log(JSON.stringify(job, null, 2));
  }
}
