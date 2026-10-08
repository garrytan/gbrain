/** `gbrain jobs submit` (dispatched by runJobs in src/commands/jobs.ts). */
import { hasFlag, parseFlag, parseMaxWaitingFlag, type JobsCommandContext } from './shared.ts';
import { isProtectedJobName } from '../../core/minions/protected-names.ts';
import { assertEmbedBackfillQueueAdmission } from '../../core/minions/embed-backfill-admission.ts';
import { clampLockDurationMs } from '../../core/minions/handler-timeouts.ts';
import { MinionWorker } from '../../core/minions/worker.ts';
import { reportInlineWorkerConfiguration } from '../jobs-readiness.ts';
import { intFlagValue, numberFlagValue } from '../../cli/flag-values.ts';
import { spendSubmitSummary, type SpendAuthorization } from '../../core/minions/spend-authorization.ts';

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

  // #5936 (D4): numeric flags are validated strictly (usage error, exit 2) before anything is enqueued.
  const optionalInt = (flag: string, rule: Parameters<typeof intFlagValue>[2]) => {
    const raw = parseFlag(args, flag);
    return raw === undefined ? undefined : intFlagValue(raw, flag, rule);
  };
  const priority = optionalInt('--priority', { example: 0 }) ?? 0;
  const delay = optionalInt('--delay', { min: 0, example: 0 }) ?? 0;
  const maxAttempts = optionalInt('--max-attempts', { min: 1, example: 3 }) ?? 3;
  const maxStalled = optionalInt('--max-stalled', { min: 0, example: 1 });
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
  const backoffDelay = optionalInt('--backoff-delay', { min: 0, example: 1000 });
  const backoffJitterRaw = parseFlag(args, '--backoff-jitter');
  const backoffJitter = backoffJitterRaw === undefined ? undefined : numberFlagValue(backoffJitterRaw, '--backoff-jitter', { min: 0, max: 1, example: 0.2 });
  const timeoutMs = optionalInt('--timeout-ms', { min: 1, example: 60000 });
  // #4145: per-job lock lease. Clamped to [5s,1h] in queue.add via
  // clampLockDurationMs (shared with the MCP op); NULL falls to the
  // handler map, then the worker default.
  const lockDurationMs = optionalInt('--lock-duration-ms', { min: 1, example: 300000 });
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

  // A4: an explicit embedding backfill submitted from the CLI is paid work (the worker-side handlers keep running unattended).
  const { EMBED_BACKFILL_JOB_NAMES, requireEmbedBackfillConsent } = await import('../../core/embed-consent.ts');
  if (EMBED_BACKFILL_JOB_NAMES.has(name)) {
    const { isConsentRefusal, printConsentRefusal } = await import('../../core/consent.ts');
    const { setCliExitVerdict } = await import('../../core/cli-force-exit.ts');
    const argv = ['gbrain', 'jobs', ...args.filter(a => a !== '--yes')];
    try {
      await requireEmbedBackfillConsent(engine, {
        command: 'jobs submit', argv, preview_argv: [...argv, '--dry-run'], args,
        scope: { all: data.all === true, ...(typeof data.sourceId === 'string' ? { sourceId: data.sourceId } : {}), unestimated: Array.isArray(data.slugs) },
      });
    } catch (e) {
      if (!isConsentRefusal(e)) throw e;
      setCliExitVerdict(printConsentRefusal(e, { json: hasFlag(args, '--json') }));
      return;
    }
  }

  // A4 + T8: queued paid enrich/subagent work needs the user's authorization; it is stored on the row and the worker enforces its cap.
  let spendAuthorization: SpendAuthorization | undefined;
  // W4.5: a re-embedding reindex job carries the user's authorization too; its handler refuses a job without one.
  if (name === 'reindex' && data.dryRun !== true && data.noEmbed !== true) {
    const { requireReindexConsent } = await import('../../core/reindex-consent.ts');
    const { countPending } = await import('../reindex.ts');
    const { isConsentRefusal, printConsentRefusal } = await import('../../core/consent.ts');
    const { setCliExitVerdict } = await import('../../core/cli-force-exit.ts');
    const { jobSpendAuthorization } = await import('../../core/minions/spend-authorization.ts');
    const argv = ['gbrain', 'jobs', ...args.filter(a => a !== '--yes')];
    const pending = await countPending(engine, null, false);
    const target = typeof data.limit === 'number' && data.limit > 0 ? Math.min(data.limit, pending) : pending;
    try {
      const gate = await requireReindexConsent(engine, { args, type: null, target, argv, preview_argv: ['gbrain', 'reindex', '--markdown', '--dry-run'] });
      if (gate) spendAuthorization = jobSpendAuthorization(gate.auth, { command: 'jobs submit reindex', of: 1, argv, ...(gate.plan.est_usd !== null ? { est_usd: gate.plan.est_usd } : {}) });
    } catch (e) {
      if (!isConsentRefusal(e)) throw e;
      setCliExitVerdict(printConsentRefusal(e, { json: hasFlag(args, '--json') }));
      return;
    }
  }
  if (PAID_SUBMIT_NAMES.has(name)) {
    const authorized = await authorizePaidSubmit(engine, name, data, args);
    if (!authorized) return;
    spendAuthorization = authorized;
  }

  try { await queue.ensureSchema(); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

  if (engine.kind === 'pglite' && !follow && !hasFlag(args, '--queue-only')) {
    await refuseNoWorker(args, name, queueName);
    return;
  }

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
  }, { ...trusted, ...(spendAuthorization ? { spendAuthorization } : {}) });
  if (spendAuthorization) {
    for (const line of spendSubmitSummary(spendAuthorization, [job], spendAuthorization.argv ?? []).lines) process.stderr.write(`${line}\n`);
  }

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

/** Paid job names a CLI submit must authorize (the consent-gated producers' job types). */
const PAID_SUBMIT_NAMES = new Set(['enrich', 'subagent']);

/**
 * The same consent gate the producing commands run: `--yes` (derived or
 * default cap), `--max-usd <usd>`, a preapproval or tokenmax authorize it,
 * `--max-usd off` is the explicit uncapped choice; otherwise exit 3 with the
 * consent payload and nothing queued. Returns the record to store, or null.
 */
async function authorizePaidSubmit(engine: JobsCommandContext['engine'], name: string, data: Record<string, unknown>, args: string[]): Promise<SpendAuthorization | null> {
  const { consentGate, engineConsentEnv } = await import('../../core/consent-cli.ts');
  const { jobSpendAuthorization } = await import('../../core/minions/spend-authorization.ts');
  const argv = ['gbrain', 'jobs', ...args.filter(a => a !== '--yes')];
  const maxUsd = parseFlag(args, '--max-usd');
  if (maxUsd !== undefined && ['off', 'unlimited', 'none'].includes(maxUsd.trim().toLowerCase())) {
    return jobSpendAuthorization({ uncapped: true, via: 'max_usd' }, { command: `jobs submit ${name}`, of: 1, argv });
  }
  const { DEFAULT_LIMIT } = await import('../enrich.ts');
  const estUsd = name === 'enrich'
    ? Math.ceil((typeof data.limit === 'number' && data.limit > 0 ? data.limit : DEFAULT_LIMIT) * 0.01 * 100) / 100
    : null;
  const auth = await consentGate({
    command: `jobs submit ${name}`, effects: ['paid'], actor: 'agent',
    what: `Queue a paid ${name} job`,
    why: name === 'enrich'
      ? 'An enrich job writes model-generated summaries into thin pages and pays the chat model provider per page.'
      : 'A subagent job runs a model tool loop and pays the model provider for every turn.',
    risk: estUsd !== null
      ? `Spends about $${estUsd.toFixed(2)} with the chat model provider once a worker runs it. Without --max-usd, a model with no known price runs unmetered under the derived or default cap.`
      : 'Spends with the model provider once a worker runs it; with no estimate the default $5 cap applies unless --max-usd sets one. Without --max-usd, a model with no known price runs unmetered under the derived or default cap.',
    user_message: estUsd !== null
      ? `Queue an enrich job that spends about $${estUsd.toFixed(2)}?`
      : `Queue a subagent job that spends up to $5 unless you set another cap?`,
    argv, preview_argv: [...argv, '--dry-run'], est_usd: estUsd, args,
  }, { json: hasFlag(args, '--json'), env: engineConsentEnv(engine) });
  return auth ? jobSpendAuthorization(auth, { command: `jobs submit ${name}`, of: 1, argv, ...(estUsd !== null ? { est_usd: estUsd } : {}) }) : null;
}

/**
 * Queue honesty (agent-first operator wave E5): PGLite has no background
 * worker, so a plain submit would leave the job waiting with no error. Refuse
 * with `no_worker` and the exact `--follow` command; `--queue-only` queues it
 * deliberately for a later `gbrain jobs work` drain.
 */
async function refuseNoWorker(args: string[], name: string, queueName: string): Promise<void> {
  const { opError } = await import('../../core/ops/contract.ts');
  const { renderCliError } = await import('../../core/agent-output.ts');
  const { setCliExitVerdict, writeStdoutFinal } = await import('../../core/cli-force-exit.ts');
  const err = opError('no_worker',
    `PGLite has no background worker, so job '${name}' would wait in queue '${queueName}' until something runs it. Nothing was queued.`,
    'Run it now with --follow, or pass --queue-only to queue it for a later `gbrain jobs work` drain.',
    { why: 'PGLite brains have no background worker (the database is single-writer), so a queued job waits with no error until a `gbrain jobs work` drain runs it.',
      fix: { argv: ['gbrain', 'jobs', ...args, '--follow'], consent: [], actor: 'agent', requires_exclusive: true,
      why: '--follow runs the job in this process and waits for its result; it needs the brain to itself, so any running `gbrain serve` must stop first.' } });
  const out = renderCliError(err, { json: hasFlag(args, '--json'), command: 'jobs submit', tty: !!process.stderr.isTTY });
  if (out.stdout) await writeStdoutFinal(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  setCliExitVerdict(out.exitCode);
}
