/**
 * CLI handler for `gbrain jobs` subcommands.
 * Thin wrapper around MinionQueue and MinionWorker.
 */

import type { BrainEngine } from '../core/engine.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { MinionWorker } from '../core/minions/worker.ts';
import { WORKER_EXIT_RSS_WATCHDOG } from '../core/minions/worker-exit-codes.ts';
import type { MinionJob, MinionJobStatus } from '../core/minions/types.ts';
import type { PaceKeyOverrides } from '../core/pace-mode.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';
import { parseNiceValue, applyNiceness, getEffectiveNiceness, formatNice } from '../core/minions/niceness.ts';

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Parse `--max-waiting N` from CLI args. Returns undefined if absent.
 *  Throws on malformed input (caller should surface the error and exit).
 *  Clamps to [1, 100] to match the queue-layer clamp in MinionQueue.add.
 *  Exported for unit tests; the CLI handler at `jobs submit` wraps this
 *  with process.exit(1) on throw so operators see 'must be positive integer'. */
export function parseMaxWaitingFlag(args: string[]): number | undefined {
  const raw = parseFlag(args, '--max-waiting');
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error('--max-waiting must be a positive integer (will be clamped to [1, 100])');
  }
  return Math.max(1, Math.min(100, parsed));
}

/** Parse `--max-rss N` (MB). Returns:
 *  - undefined if the flag is absent (caller decides the default)
 *  - 0 if `--max-rss 0` (explicit disable)
 *  - the value if >= 256
 *  Errors and exits the process if the flag is non-numeric, negative, or
 *  positive but < 256 (likely a GB-vs-MB unit-confusion typo). */
export function parseMaxRssFlag(args: string[]): number | undefined {
  const raw = parseFlag(args, '--max-rss');
  if (raw === undefined) return undefined;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Error: --max-rss must be a non-negative integer (MB), got "${raw}"`);
    process.exit(1);
  }
  if (parsed === 0) return 0;
  if (parsed < 256) {
    console.error(
      `Error: --max-rss ${parsed} is too low for production (likely a unit confusion: ` +
      `--max-rss takes megabytes, not gigabytes). Use --max-rss 0 to disable, ` +
      `or set a value >= 256.`
    );
    process.exit(1);
  }
  return parsed;
}

/** Parse `--nice N` (then `GBRAIN_NICE` env). Returns:
 *  - undefined if absent (no priority change — inherit)
 *  - the validated integer in [-20, 19] otherwise
 *  Errors and exits the process on non-integer / out-of-range input (mirrors
 *  parseMaxRssFlag's fail-fast). Flag wins over env. (issue #1815) */
export function parseNiceFlag(args: string[], env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = parseFlag(args, '--nice') ?? env.GBRAIN_NICE;
  if (raw === undefined || raw === '') return undefined;
  try {
    return parseNiceValue(raw);
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

export function resolveWorkerConcurrency(args: string[], env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseFlag(args, '--concurrency') ?? env.GBRAIN_WORKER_CONCURRENCY ?? '1';
  const parsed = parseInt(raw, 10);
  // Without validation, NaN / 0 / negative values flow through to the worker
  // loop where `inFlight.size < concurrency` is always false → the worker
  // claims zero jobs and the queue silently wedges. One typo in a systemd
  // unit reproduces the original production incident. Clamp to ≥1 and surface
  // the misconfig loudly so operators see it at worker startup.
  if (!Number.isFinite(parsed) || parsed < 1) {
    const source = parseFlag(args, '--concurrency') !== undefined
      ? '--concurrency flag'
      : 'GBRAIN_WORKER_CONCURRENCY env';
    process.stderr.write(
      `[gbrain jobs] invalid concurrency from ${source} (${JSON.stringify(raw)}); ` +
      `falling back to 1. Set a positive integer.\n`
    );
    return 1;
  }
  return parsed;
}

function formatJob(job: MinionJob): string {
  const dur = job.finished_at && job.started_at
    ? `${((job.finished_at.getTime() - job.started_at.getTime()) / 1000).toFixed(1)}s`
    : '—';
  const stalled = job.status === 'active' && job.lock_until && job.lock_until < new Date()
    ? ' (stalled?)' : '';
  return `  ${String(job.id).padEnd(6)} ${job.name.padEnd(14)} ${(job.status + stalled).padEnd(20)} ${job.queue.padEnd(10)} ${dur.padEnd(8)} ${job.created_at.toISOString().slice(0, 19)}`;
}

function formatJobDetail(job: MinionJob): string {
  const lines = [
    `Job #${job.id}: ${job.name} (${job.status.toUpperCase()}${job.status === 'dead' ? ` after ${job.attempts_made} attempts` : ''})`,
    `  Queue: ${job.queue} | Priority: ${job.priority}`,
    `  Attempts: ${job.attempts_made}/${job.max_attempts} (started: ${job.attempts_started}, stalled: ${job.stalled_counter}/${job.max_stalled})`,
    `  Backoff: ${job.backoff_type} ${job.backoff_delay}ms (jitter: ${job.backoff_jitter})`,
  ];
  if (job.started_at) lines.push(`  Started: ${job.started_at.toISOString()}`);
  if (job.finished_at) lines.push(`  Finished: ${job.finished_at.toISOString()}`);
  if (job.lock_token) lines.push(`  Lock: ${job.lock_token} (until ${job.lock_until?.toISOString()})`);
  if (job.delay_until) lines.push(`  Delayed until: ${job.delay_until.toISOString()}`);
  if (job.parent_job_id) lines.push(`  Parent: job #${job.parent_job_id} (on_child_fail: ${job.on_child_fail})`);
  if (job.error_text) lines.push(`  Error: ${job.error_text}`);
  if (job.stacktrace.length > 0) {
    lines.push(`  History:`);
    for (const entry of job.stacktrace) lines.push(`    - ${entry}`);
  }
  if (job.progress != null) lines.push(`  Progress: ${JSON.stringify(job.progress)}`);
  if (job.result != null) lines.push(`  Result: ${JSON.stringify(job.result)}`);
  lines.push(`  Data: ${JSON.stringify(job.data)}`);
  return lines.join('\n');
}

export async function runJobs(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`gbrain jobs — Minions job queue

USAGE
  gbrain jobs submit <name> [--params JSON] [--follow] [--priority N]
                            [--delay Nms] [--max-attempts N] [--max-stalled N]
                            [--max-waiting N]
                            [--backoff-type fixed|exponential] [--backoff-delay Nms]
                            [--backoff-jitter 0..1] [--timeout-ms Nms]
                            [--idempotency-key K] [--queue Q] [--dry-run]
                            [--redact-secrets]   (shell only; scrubs inherit
                                                  values from stdout/stderr)
  gbrain jobs list [--status S] [--queue Q] [--limit N]
  gbrain jobs get <id>
  gbrain jobs cancel <id>
  gbrain jobs retry <id>
  gbrain jobs prune [--older-than 30d]
  gbrain jobs delete <id>
  gbrain jobs stats
  gbrain jobs smoke
  gbrain jobs work [--queue Q] [--concurrency N] [--max-rss MB]
                   [--health-interval MS] [--nice N]
  gbrain jobs supervisor [start] [--detach] [--json]
                         [--concurrency N] [--queue Q] [--pid-file PATH]
                         [--max-crashes N] [--health-interval N]
                         [--allow-shell-jobs] [--cli-path PATH]
                         [--max-rss MB] [--nice N]

    --nice N   OS scheduling priority, -20 (highest) to 19 (nicest). Lowers CPU
               priority without cutting concurrency — full throughput when the
               box is idle, yields to foreground work when it's busy. Propagates
               to spawned workers and their children. Env: GBRAIN_NICE (flag
               wins). Effective value shows in 'jobs stats' and 'gbrain doctor'.
               Negative values need root.
  gbrain jobs supervisor status [--json] [--pid-file PATH]
  gbrain jobs supervisor stop [--json] [--pid-file PATH]

    Auto-restarting wrapper around 'gbrain jobs work'. Spawns the worker
    as a child process and restarts on crash with exponential backoff
    (1s -> 60s cap). Writes a PID file to ~/.gbrain/supervisor.pid by
    default (override via --pid-file or GBRAIN_SUPERVISOR_PID_FILE env).
    Lifecycle events are appended to
      \${GBRAIN_AUDIT_DIR:-~/.gbrain/audit}/supervisor-YYYY-Www.jsonl

    SUBCOMMANDS
      start        (default) Launch the supervisor. --detach returns a
                   JSON {event, supervisor_pid, pid_file} payload on
                   stdout and forks; omit for foreground.
      status       Read PID file + audit log, report running / last_start
                   / crashes_24h / max_crashes_exceeded as JSON or human.
                   Exits 0 if running, 1 if not.
      stop         Send SIGTERM to the supervisor, wait up to 40s for
                   graceful drain, report outcome. Exits 0 on clean stop.

    EXIT CODES (start)
      0  clean shutdown (SIGTERM/SIGINT received, worker drained)
      1  max crashes exceeded (worker kept dying)
      2  another supervisor holds the PID lock
      3  PID file unwritable (permission / path error)

    EXAMPLES
      gbrain jobs supervisor --concurrency 4         # foreground (Ctrl-C stops)
      gbrain jobs supervisor start --detach --json   # agent-friendly: fork + return JSON
      gbrain jobs supervisor status --json           # machine-readable health check
      gbrain jobs supervisor stop                    # graceful stop
      gbrain jobs supervisor --json --allow-shell-jobs  # JSONL events + shell-exec on

HANDLER TYPES (built in)
  sync              Pull and embed new pages from the repo
  embed             (Re-)embed pages; --params '{"slug":...}' or '{"all":true}'
  lint              Run page linter; --params '{"dir":"...","fix":true}'
  import            Bulk import markdown; --params '{"dir":"..."}'
  extract           Extract links + timeline entries; '{"mode":"all"}'
  backlinks         Check or fix back-links; '{"action":"fix"}'
  autopilot-cycle   One autopilot pass (sync+extract+embed+backlinks)
  shell             Run a command or argv. Requires GBRAIN_ALLOW_SHELL_JOBS=1
                    on the worker. Params: {cmd?, argv?, cwd, env?}.
                    See: docs/guides/minions-shell-jobs.md
`);
    return;
  }

  const queue = new MinionQueue(engine);

  switch (sub) {
    case 'submit': {
      const name = args[1];
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
      const idempotencyKey = parseFlag(args, '--idempotency-key');
      const queueName = parseFlag(args, '--queue') ?? 'default';
      const dryRun = hasFlag(args, '--dry-run');
      const follow = hasFlag(args, '--follow');
      // v0.36.5.0: --redact-secrets is a CLI convenience that merges
      // `redact_secrets: true` into the params before validation. Equivalent
      // to passing it in --params JSON; flag form is faster to type.
      if (hasFlag(args, '--redact-secrets') && name.trim() === 'shell') {
        data.redact_secrets = true;
      }

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
        if (idempotencyKey) console.log(`  Idempotency key: ${idempotencyKey}`);
        if (delay > 0) console.log(`  Delay: ${delay}ms`);
        console.log(`  Data: ${JSON.stringify(data)}`);
        return;
      }

      try {
        await queue.ensureSchema();
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }

      // The CLI path is a trusted submitter. Pass {allowProtectedSubmit: true}
      // ONLY for protected names, not blanket-set for every submission, so any
      // future protected name forces explicit opt-in at the call site.
      const { isProtectedJobName } = await import('../core/minions/protected-names.ts');
      const trusted = isProtectedJobName(name) ? { allowProtectedSubmit: true } : undefined;

      // v0.35.8.0: pre-enqueue shell-job validation. Validates `inherit:`
      // closed enum, rejects secret env-keys, fail-fasts on missing config.
      // Throws UnrecoverableError BEFORE `queue.add` so a bad payload never
      // lands in `minion_jobs.data`. Defense-in-depth re-validation happens
      // in the worker handler. See: src/core/minions/handlers/shell-validate.ts
      if (name.trim() === 'shell') {
        try {
          const { validateShellJobParams } = await import('../core/minions/handlers/shell-validate.ts');
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
        idempotency_key: idempotencyKey,
        queue: queueName,
      }, trusted);

      // Submission audit log (operational trace, not forensic insurance).
      try {
        const { logShellSubmission } = await import('../core/minions/handlers/shell-audit.ts');
        if (name.trim() === 'shell') {
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
      // regardless of the submitter's own `GBRAIN_ALLOW_SHELL_JOBS` — the submitter
      // env is a weak proxy for the worker env (they may run on different machines),
      // so the warning remains useful any time the job might sit in 'waiting'.
      if (!follow && name.trim() === 'shell') {
        process.stderr.write(
          `\n⚠  Shell jobs require GBRAIN_ALLOW_SHELL_JOBS=1 on the worker process.\n` +
          `   Your job was queued (id=${job.id}) but will sit in 'waiting' until a\n` +
          `   worker with the env flag starts. To run now:\n\n` +
          `     GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs submit shell \\\n` +
          `       --params '...' --follow\n\n` +
          `   Or start a persistent worker (Postgres only — PGLite uses --follow):\n\n` +
          `     GBRAIN_ALLOW_SHELL_JOBS=1 gbrain jobs work\n\n`,
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
          process.exit(1);
        }
      } else {
        console.log(JSON.stringify(job, null, 2));
      }
      break;
    }

    case 'list': {
      const status = parseFlag(args, '--status') as MinionJobStatus | undefined;
      const queueName = parseFlag(args, '--queue');
      const limit = parseInt(parseFlag(args, '--limit') ?? '20', 10);

      // v0.32: thin-client routing. The `list_jobs` MCP op is admin-scoped
      // but not localOnly, so a thin-client install with admin access can
      // see the remote brain's job queue. Without this branch we'd query
      // the empty local PGLite and report "No jobs found" for an actively-
      // running host brain.
      const cfg = loadConfig();
      let jobs: MinionJob[];
      if (isThinClient(cfg)) {
        const raw = await callRemoteTool(cfg!, 'list_jobs', {
          status, queue: queueName, limit,
        }, { timeoutMs: 30_000 });
        jobs = unpackToolResult<MinionJob[]>(raw);
      } else {
        try { await queue.ensureSchema(); }
        catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
        jobs = await queue.getJobs({ status, queue: queueName, limit });
      }

      if (jobs.length === 0) {
        console.log('No jobs found.');
        return;
      }

      console.log(`  ${'ID'.padEnd(6)} ${'Name'.padEnd(14)} ${'Status'.padEnd(20)} ${'Queue'.padEnd(10)} ${'Time'.padEnd(8)} Created`);
      console.log('  ' + '─'.repeat(80));
      for (const job of jobs) console.log(formatJob(job));
      console.log(`\n  ${jobs.length} jobs shown`);
      break;
    }

    case 'get': {
      const id = parseInt(args[1], 10);
      if (isNaN(id)) { console.error('Error: job ID required. Usage: gbrain jobs get <id>'); process.exit(1); }

      // v0.32: thin-client routing (mirrors `list` branch above).
      const cfg = loadConfig();
      let job: MinionJob | null;
      if (isThinClient(cfg)) {
        try {
          const raw = await callRemoteTool(cfg!, 'get_job', { id }, { timeoutMs: 30_000 });
          job = unpackToolResult<MinionJob | null>(raw);
        } catch (e) {
          // The remote op throws `invalid_params` on not-found; surface as
          // the same "Job not found" exit-1 the local path produces.
          const msg = e instanceof Error ? e.message : String(e);
          if (/not found/i.test(msg)) {
            console.error(`Job #${id} not found.`);
            process.exit(1);
          }
          throw e;
        }
      } else {
        try { await queue.ensureSchema(); }
        catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
        job = await queue.getJob(id);
      }
      if (!job) { console.error(`Job #${id} not found.`); process.exit(1); }
      console.log(formatJobDetail(job));
      break;
    }

    case 'cancel': {
      const id = parseInt(args[1], 10);
      if (isNaN(id)) { console.error('Error: job ID required.'); process.exit(1); }

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const cancelled = await queue.cancelJob(id);
      if (cancelled) {
        console.log(`Job #${id} cancelled.`);
      } else {
        console.error(`Could not cancel job #${id} (may already be completed/dead).`);
        process.exit(1);
      }
      break;
    }

    case 'retry': {
      const id = parseInt(args[1], 10);
      if (isNaN(id)) { console.error('Error: job ID required.'); process.exit(1); }

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const retried = await queue.retryJob(id);
      if (retried) {
        console.log(`Job #${id} re-queued for retry.`);
      } else {
        console.error(`Could not retry job #${id} (must be failed or dead).`);
        process.exit(1);
      }
      break;
    }

    case 'delete': {
      const id = parseInt(args[1], 10);
      if (isNaN(id)) { console.error('Error: job ID required.'); process.exit(1); }

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const removed = await queue.removeJob(id);
      if (removed) {
        console.log(`Job #${id} deleted.`);
      } else {
        console.error(`Could not delete job #${id} (must be in a terminal status).`);
        process.exit(1);
      }
      break;
    }

    case 'prune': {
      const olderThanStr = parseFlag(args, '--older-than') ?? '30d';
      const days = parseInt(olderThanStr, 10);
      if (isNaN(days) || days <= 0) {
        console.error('Error: --older-than must be a positive number (days). Example: --older-than 30d');
        process.exit(1);
      }

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const count = await queue.prune({ olderThan: new Date(Date.now() - days * 86400000) });
      console.log(`Pruned ${count} jobs older than ${days} days.`);
      break;
    }

    case 'stats': {
      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const statsQueue = parseFlag(args, '--queue') ?? 'default';
      const stats = await queue.getStats({ queue: statsQueue });

      console.log('Job Stats (last 24h):');
      if (stats.by_type.length > 0) {
        console.log(`  ${'Type'.padEnd(14)} ${'Total'.padEnd(7)} ${'Done'.padEnd(7)} ${'Failed'.padEnd(8)} ${'Dead'.padEnd(6)} Avg Time`);
        for (const t of stats.by_type) {
          const avgTime = t.avg_duration_ms != null ? `${(t.avg_duration_ms / 1000).toFixed(1)}s` : '—';
          console.log(`  ${t.name.padEnd(14)} ${String(t.total).padEnd(7)} ${String(t.completed).padEnd(7)} ${String(t.failed).padEnd(8)} ${String(t.dead).padEnd(6)} ${avgTime}`);
        }
      } else {
        console.log('  No jobs in the last 24 hours.');
      }
      console.log(`\n  Queue health: ${stats.queue_health.waiting} waiting, ${stats.queue_health.active} active, ${stats.queue_health.stalled} stalled`);

      // Scheduling priority (niceness, issue #1815). Best-effort: measures live
      // workers from the registry + the supervisor (if running) — silently skips
      // when nothing is reniced/running, so default stats output stays clean.
      try {
        const { readWorkers } = await import('../core/minions/worker-registry.ts');
        const { readSupervisorPid } = await import('../core/minions/supervisor-pid.ts');
        const { DEFAULT_PID_FILE } = await import('../core/minions/supervisor.ts');
        const liveWorkers = readWorkers();
        const sup = readSupervisorPid(DEFAULT_PID_FILE);
        const supNice = sup.running && sup.pid !== null ? getEffectiveNiceness(sup.pid) : null;
        if (liveWorkers.length > 0 || supNice !== null) {
          console.log(`\n  Scheduling priority (nice):`);
          if (supNice !== null) console.log(`    supervisor (pid ${sup.pid}): ${formatNice(supNice)}`);
          for (const w of liveWorkers) {
            const diverged = w.nice_requested !== null && w.nice_now !== null && w.nice_requested !== w.nice_now
              ? `  ⚠ requested ${formatNice(w.nice_requested)}, not applied` : '';
            console.log(`    worker (pid ${w.pid}, queue ${w.queue}): ${w.nice_now !== null ? formatNice(w.nice_now) : '?'}${diverged}`);
          }
        }
      } catch {
        // Registry/import failure is best-effort; skip silently.
      }

      // issue #1801 — wedged-queue signature (queue-scoped): a worker is alive
      // but claiming nothing while work waits. `active_healthy` (live-lock only)
      // means an expired-lock active row doesn't mask it. Loud line so the
      // operator/agent catches a silent halt in `jobs stats`, not 15h later.
      {
        const w = stats.wedge;
        const mins = w.minutes_since_completion;
        // Same threshold the doctor `wedged_queue` check uses, so the two
        // advisory surfaces agree (issue #1801).
        const wedgeMins = (() => {
          const raw = parseInt(process.env.GBRAIN_WEDGED_QUEUE_WARN_MINUTES ?? '', 10);
          return Number.isFinite(raw) && raw > 0 ? raw : 15;
        })();
        const wedged = w.active_healthy === 0 && w.waiting > 0 && (mins === null || mins > wedgeMins);
        if (wedged) {
          const since = mins === null ? 'no completions on record' : `${mins}m since last completion`;
          console.log(
            `\n  ⚠  WEDGED QUEUE '${w.queue}': ${w.waiting} waiting, 0 active (live-lock), ${since}.\n` +
            `     A worker may be alive but stuck (dead DB pool / stuck handler). Fix:\n` +
            `       gbrain jobs supervisor stop && gbrain jobs supervisor start   # rebuild a fresh pool\n` +
            `       gbrain jobs retry <id>                                        # for dead-lettered jobs`,
          );
        }
      }

      // v0.41 Bug 2 / Eng D8 — surface lease pressure to the operator.
      // Reads minion_lease_pressure_log windowed at 1h. Best-effort: pre-v93
      // brains (no table) silently skip; the queue_health line above is the
      // operator's primary signal in that case.
      try {
        const lpRows = await engine.executeRaw<{ count: string }>(
          `SELECT count(*)::text AS count FROM minion_lease_pressure_log
            WHERE bounced_at > now() - interval '1 hour'`,
        );
        const lpCount = parseInt(lpRows[0]?.count ?? '0', 10);
        if (lpCount > 0) {
          // Also surface whether any of those bounces stalled forward progress.
          // Bounces with rising completed counts = healthy backpressure; bounces
          // with zero completes = real blocker (matches doctor's subagent_health).
          const completedRows = await engine.executeRaw<{ count: string }>(
            `SELECT count(*)::text AS count FROM minion_jobs
              WHERE finished_at > now() - interval '1 hour'
                AND status = 'completed' AND name = 'subagent'`,
          ).catch(() => [{ count: '0' }]);
          const completed = parseInt(completedRows[0]?.count ?? '0', 10);
          const tag = completed > 0
            ? `(${completed} subagent job${completed === 1 ? '' : 's'} completed, throughput healthy)`
            : `(no subagent jobs completed — cap may be too tight; \`export GBRAIN_ANTHROPIC_MAX_INFLIGHT=64\`)`;
          console.log(`  Lease pressure (1h): ${lpCount} bounce${lpCount === 1 ? '' : 's'} ${tag}`);
        } else {
          console.log(`  Lease pressure (1h): 0 bounces`);
        }
      } catch {
        // Pre-v93 brain — no table. Silent skip.
      }

      // v0.41 D3 — error clustering. Optional via --cluster-errors flag so
      // operators only see the breakdown when triaging a fail-heavy batch
      // (default stats output stays scannable). Pulls last 24h of dead +
      // failed jobs, classifies by error-classify.ts buckets, sorts by
      // count, surfaces top 5 with paste-ready retry hints.
      if (hasFlag(args, '--cluster-errors')) {
        try {
          const { clusterErrors } = await import('../core/minions/error-classify.ts');
          const errRows = await engine.executeRaw<{ id: number; last_error: string | null }>(
            `SELECT id, error_text AS last_error FROM minion_jobs
              WHERE status IN ('dead', 'failed')
                AND updated_at > now() - interval '24 hours'`,
          );
          if (errRows.length === 0) {
            console.log(`\n  Error clusters (24h): no dead/failed jobs`);
          } else {
            const clusters = clusterErrors(errRows);
            console.log(`\n  Error clusters (24h):`);
            for (const c of clusters.slice(0, 5)) {
              const sample = c.sample_ids.length > 0
                ? `  (e.g. \`gbrain jobs get ${c.sample_ids[0]}\`)` : '';
              console.log(`    ${String(c.count).padStart(4)} × ${c.cluster.padEnd(22)}${sample}`);
            }
            if (clusters.length > 5) {
              console.log(`    + ${clusters.length - 5} more cluster${clusters.length - 5 === 1 ? '' : 's'}`);
            }
          }
        } catch (e) {
          // error-classify import or SQL fail. Don't block stats output.
          if (process.env.GBRAIN_DEBUG === '1') {
            console.error(`[jobs stats] cluster-errors skipped: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      break;
    }

    case 'smoke': {
      const startTime = Date.now();
      try { await queue.ensureSchema(); }
      catch (e) {
        console.error(`SMOKE FAIL — schema init: ${e instanceof Error ? e.message : String(e)}`);
        process.exit(1);
      }

      const sigkillRescue = hasFlag(args, '--sigkill-rescue');
      const wedgeRescue = hasFlag(args, '--wedge-rescue');

      // Smoke harness is short-lived and has no listener — disable the health
      // timer so the no-listener fallback can't trip process.exit(1) mid-test.
      const worker = new MinionWorker(engine, {
        queue: 'smoke', pollInterval: 100, healthCheckInterval: 0,
      });
      worker.register('noop', async () => ({ ok: true, at: new Date().toISOString() }));

      const job = await queue.add('noop', {}, { queue: 'smoke', max_attempts: 1 });
      const workerPromise = worker.start();

      const timeoutMs = 15000;
      let final: MinionJob | null = null;
      for (let elapsed = 0; elapsed < timeoutMs; elapsed += 100) {
        await new Promise(r => setTimeout(r, 100));
        final = await queue.getJob(job.id);
        if (final && ['completed', 'failed', 'dead', 'cancelled'].includes(final.status)) break;
      }
      worker.stop();
      await workerPromise;

      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);
      if (final?.status !== 'completed') {
        console.error(`SMOKE FAIL — job #${job.id} status: ${final?.status ?? 'timeout'} (${elapsedSec}s elapsed)`);
        if (final?.error_text) console.error(`  Error: ${final.error_text}`);
        process.exit(1);
      }

      // --sigkill-rescue: regression case for #219. Simulates a SIGKILL
      // mid-flight by directly manipulating lock_until via handleStalled.
      // Verifies that with the v0.13.1 schema default (max_stalled=5), a
      // stalled job is REQUEUED rather than dead-lettered on first stall.
      // Full subprocess-level SIGKILL lives in test/e2e/minions.test.ts.
      if (sigkillRescue) {
        const rescueJob = await queue.add('noop', {}, { queue: 'smoke' });

        // Transition to active with a past lock_until, mimicking a worker
        // that claimed and then got SIGKILL'd mid-run.
        await engine.executeRaw(
          `UPDATE minion_jobs
              SET status='active',
                  lock_token='smoke-sigkill-rescue',
                  lock_until=now() - interval '1 minute',
                  started_at=now() - interval '2 minute',
                  attempts_started = attempts_started + 1
            WHERE id=$1`,
          [rescueJob.id]
        );

        const result = await queue.handleStalled();
        const afterStall = await queue.getJob(rescueJob.id);

        if (afterStall?.status === 'dead') {
          console.error(
            `SMOKE FAIL (--sigkill-rescue) — job #${rescueJob.id} was dead-lettered on first stall. ` +
            `This is the #219 regression: schema default max_stalled should rescue, not dead-letter. ` +
            `handleStalled: ${JSON.stringify(result)}`
          );
          process.exit(1);
        }
        if (afterStall?.status !== 'waiting') {
          console.error(
            `SMOKE FAIL (--sigkill-rescue) — unexpected status after stall: ${afterStall?.status}. ` +
            `Expected 'waiting' (rescued). handleStalled: ${JSON.stringify(result)}`
          );
          process.exit(1);
        }
        try { await queue.removeJob(rescueJob.id); } catch { /* non-fatal cleanup */ }
      }

      // --wedge-rescue: regression case for the v0.19.1 production incident.
      // In prod, a wedged worker held a row lock via a pending txn. The
      // lock-renewal UPDATE blocked, lock_until fell below now(), handleStalled
      // saw the candidate but FOR UPDATE SKIP LOCKED skipped (row lock held),
      // handleTimeouts was disqualified (lock_until > now() fails).
      // Only handleWallClockTimeouts' no-constraint sweep evicted.
      //
      // The smoke is single-connection, so we can't simulate a row lock held
      // by another txn. Instead we forge the state where BOTH handleStalled
      // and handleTimeouts are disqualified so only wall-clock fires:
      //   - lock_until far in the future → handleStalled skips (not a stall)
      //   - timeout_at = NULL → handleTimeouts skips (needs NOT NULL)
      //   - started_at 10s ago with timeout_ms=1000 → wall-clock matches
      //     (2 × timeout_ms = 2000ms threshold exceeded)
      if (wedgeRescue) {
        const wedgedJob = await queue.add('noop', {}, {
          queue: 'smoke',
          timeout_ms: 1000,
        });
        await engine.executeRaw(
          `UPDATE minion_jobs
              SET status='active',
                  lock_token='smoke-wedge-rescue',
                  lock_until=now() + interval '30 seconds',
                  started_at=now() - interval '10 seconds',
                  timeout_at=NULL,
                  attempts_started = attempts_started + 1
            WHERE id=$1`,
          [wedgedJob.id]
        );

        const stallResult = await queue.handleStalled();
        const stalledStatus = await queue.getJob(wedgedJob.id);
        const timeoutResult = await queue.handleTimeouts();
        const timedStatus = await queue.getJob(wedgedJob.id);
        const wallResult = await queue.handleWallClockTimeouts(30000);
        const finalStatus = await queue.getJob(wedgedJob.id);

        if (finalStatus?.status !== 'dead') {
          console.error(
            `SMOKE FAIL (--wedge-rescue) — wall-clock sweep did not evict job #${wedgedJob.id}. ` +
            `Status: ${finalStatus?.status}. ` +
            `handleStalled: requeued=${stallResult.requeued.length} dead=${stallResult.dead.length}, after: ${stalledStatus?.status}; ` +
            `handleTimeouts: ${timeoutResult.length}, after: ${timedStatus?.status}; ` +
            `handleWallClockTimeouts: ${wallResult.length}, final: ${finalStatus?.status}.`
          );
          process.exit(1);
        }
        if (finalStatus.error_text !== 'wall-clock timeout exceeded') {
          console.error(
            `SMOKE FAIL (--wedge-rescue) — dead, but error_text='${finalStatus.error_text}' ` +
            `(expected 'wall-clock timeout exceeded').`
          );
          process.exit(1);
        }
        try { await queue.removeJob(wedgedJob.id); } catch { /* non-fatal cleanup */ }
      }

      const cfg = (await import('../core/config.ts')).loadConfig();
      const engineLabel = cfg?.engine ?? 'unknown';
      const tags: string[] = [];
      if (sigkillRescue) tags.push('SIGKILL rescue');
      if (wedgeRescue) tags.push('wedge rescue');
      const tag = tags.length > 0 ? ` + ${tags.join(' + ')}` : '';
      console.log(`SMOKE PASS — Minions healthy${tag} in ${elapsedSec}s (engine: ${engineLabel})`);
      if (engineLabel === 'pglite') {
        console.log('Note: the `gbrain jobs work` daemon requires Postgres. PGLite');
        console.log('supports inline execution only (`submit --follow`).');
      }
      try { await queue.removeJob(job.id); } catch { /* non-fatal cleanup */ }
      process.exit(0);
    }

    case 'work': {
      // Check if PGLite
      const config = (await import('../core/config.ts')).loadConfig();
      if (config?.engine === 'pglite') {
        console.error('Error: Worker daemon requires Postgres. PGLite uses an exclusive file lock that blocks other processes.');
        console.error('Use --follow for inline execution: gbrain jobs submit <name> --follow');
        process.exit(1);
      }

      const queueName = parseFlag(args, '--queue') ?? 'default';
      const concurrency = resolveWorkerConcurrency(args);
      // --max-rss: explicit value wins (including 0 to disable the watchdog).
      // Absent → cgroup-aware auto-size (issue #1678): the flat 2048MB default
      // killed legit embed work (~10GB) on every cycle and produced a silent
      // ~400×/24h respawn loop. See src/core/minions/rss-default.ts.
      const maxRssExplicit = parseMaxRssFlag(args);
      const { resolveDefaultMaxRssMb, describeDefaultMaxRss } =
        await import('../core/minions/rss-default.ts');
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

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const worker = new MinionWorker(engine, {
        queue: queueName, concurrency, maxRssMb, healthCheckInterval,
      });
      await registerBuiltinHandlers(worker, engine);

      // Subscribe to self-health failures emitted by the worker. Library code
      // (worker.ts) never calls process.exit directly so it stays embeddable;
      // this CLI layer is the right place to terminate the process and let
      // the external PM (systemd, Docker, cron watchdog) restart cleanly.
      worker.on('unhealthy', (info) => {
        if (info.reason === 'db_dead') {
          console.error(
            `[health] FATAL: DB unreachable after ${info.consecutiveFailures} probes (${info.message}). ` +
            `Exiting for process-manager restart.`,
          );
        } else {
          console.error(
            `[health] FATAL: Worker stalled — ${info.waitingCount} waiting job(s) for ` +
            `registered handlers, ${info.idleMinutes}m idle. Exiting for process-manager restart.`,
          );
        }
        process.exit(1);
      });

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
      console.log(`Minion worker started (queue: ${queueName}, concurrency: ${concurrency}${watchdogNote}${healthNote}${niceNote})`);
      console.log(`Registered handlers: ${worker.registeredNames.join(', ')}`);

      // Register in the live worker registry (issue #1815) so jobs stats / doctor
      // can report this worker's effective niceness. Cleanup runs on BOTH the
      // finally below AND process.on('exit') — the unhealthy handler's
      // process.exit(1) bypasses the awaited finally (Codex #10).
      const { registerWorker } = await import('../core/minions/worker-registry.ts');
      const unregisterWorker = registerWorker({
        pid: process.pid,
        queue: queueName,
        nice_requested: niceVal ?? null,
        nice_effective: niceResult ? niceResult.effective : null,
        started_at: Date.now(),
      });
      process.on('exit', () => unregisterWorker());

      try {
        await worker.start();
      } finally {
        unregisterWorker();
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
      break;
    }

    case 'supervisor': {
      // Dispatcher for supervisor subcommands:
      //   gbrain jobs supervisor                    → foreground start (back-compat)
      //   gbrain jobs supervisor start [--detach]   → foreground or detached start
      //   gbrain jobs supervisor status             → JSON liveness + queue stats
      //   gbrain jobs supervisor stop               → SIGTERM + drain wait
      const { MinionSupervisor, DEFAULT_PID_FILE } = await import('../core/minions/supervisor.ts');
      const { writeSupervisorEvent } = await import('../core/minions/handlers/supervisor-audit.ts');

      const supCmd = args[1];
      const isStatusCmd = supCmd === 'status';
      const isStopCmd = supCmd === 'stop';
      const isStartCmd = supCmd === 'start' || supCmd === undefined || supCmd === '--detach' ||
                          (typeof supCmd === 'string' && supCmd.startsWith('--'));
      const jsonMode = hasFlag(args, '--json');
      const pidFile = parseFlag(args, '--pid-file') ?? DEFAULT_PID_FILE;

      // ----- status subcommand -----
      if (isStatusCmd) {
        const { readSupervisorEvents, summarizeCrashes } = await import('../core/minions/handlers/supervisor-audit.ts');
        const { readSupervisorPid } = await import('../core/minions/supervisor-pid.ts');
        const { readWorkers } = await import('../core/minions/worker-registry.ts');

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
        if (!pidfileRunning) {
          try {
            const { inspectLock, isLockHolderLive } = await import('../core/db-lock.ts');
            const { supervisorLockId, SUPERVISOR_LOCK_TTL_MIN } = await import('../core/minions/supervisor.ts');
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

        const status = {
          running,
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

      // ----- stop subcommand -----
      if (isStopCmd) {
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

      // ----- start subcommand (default) -----
      if (!isStartCmd) {
        console.error(`Unknown supervisor subcommand: ${supCmd}. Expected: start, status, stop.`);
        process.exit(1);
      }

      const config = (await import('../core/config.ts')).loadConfig();
      if (config?.engine === 'pglite') {
        console.error('Error: Supervisor requires Postgres. PGLite uses an exclusive file lock that blocks other processes.');
        process.exit(1);
      }

      const { resolveGbrainCliPath } = await import('./autopilot.ts');

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
                             !!process.env.GBRAIN_ALLOW_SHELL_JOBS;
      const detach = hasFlag(args, '--detach');
      // Supervisor's --max-rss: explicit wins; absent → cgroup-aware auto-size
      // (issue #1678). The supervisor is the main production path, so the
      // watchdog is on by default — but at a realistic, RAM-relative cap
      // instead of the old flat 2048MB footgun.
      const { resolveDefaultMaxRssMb: resolveSupMaxRss } =
        await import('../core/minions/rss-default.ts');
      const maxRssMb = parseMaxRssFlag(args) ?? resolveSupMaxRss();

      // --nice N (issue #1815): validated here (fail-fast on bad input even for
      // --detach), but APPLIED only in the foreground-start path below — applying
      // before the --detach branch would renice the throwaway parent that forks
      // and exits, not the long-lived re-exec'd child (Codex #1).
      const supNice = parseNiceFlag(args);

      const cliPath = parseFlag(args, '--cli-path') ?? resolveGbrainCliPath();

      // --detach: fork a background supervisor, print PID payload, exit 0.
      // Implementation: re-exec the same CLI as a detached child without --detach,
      // inheriting stderr (so JSONL events still flow to the parent's tail-f
      // if they wanted to follow logs) but detaching stdin/stdout.
      if (detach) {
        const { spawn } = await import('child_process');
        const childArgs = process.argv.slice(2).filter(a => a !== '--detach');
        const child = spawn(process.execPath, [process.argv[1], ...childArgs], {
          detached: true,
          stdio: ['ignore', 'ignore', 'inherit'],
          env: process.env,
        });
        child.unref();
        const payload = {
          event: 'started',
          supervisor_pid: child.pid,
          pid_file: pidFile,
          detached: true,
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
        cliPath,
        allowShellJobs,
        json: jsonMode,
        maxRssMb,
        ...(supNice !== undefined ? { nice_requested: supNice } : {}),
        ...(supNiceResult?.effective != null ? { nice_effective: supNiceResult.effective } : {}),
        ...(supNiceResult?.error ? { nice_error: supNiceResult.error } : {}),
        onEvent: (emission) => writeSupervisorEvent(emission, supervisorPid),
      });

      await supervisor.start();
      break;
    }

    case 'watch': {
      // v0.41 D2 — live dashboard; v0.42.11.0 (#1784) decoupled output from TTY.
      // Flags: --json (FORMAT, human default), --follow (LOOP, default=isTTY so
      // non-TTY one-shots), --refresh-ms=N. Non-TTY no-flag → one human snapshot.
      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
      const { runWatch } = await import('./jobs-watch.ts');
      const refreshArg = args.find(a => a.startsWith('--refresh-ms='));
      const refreshMs = refreshArg ? parseInt(refreshArg.split('=')[1] ?? '1000', 10) : 1000;
      const json = hasFlag(args, '--json');
      const follow = hasFlag(args, '--follow') ? true : undefined; // undefined → default to isTTY
      await runWatch(engine, { refreshMs, json, follow });
      break;
    }

    default:
      console.error(`Unknown subcommand: ${sub}. Run 'gbrain jobs --help' for usage.`);
      process.exit(1);
  }
}

/**
 * Register built-in job handlers.
 *
 * Handlers call library-level Core functions (runSyncCore via performSync,
 * runExtractCore, runEmbedCore, runBacklinksCore) directly — NOT the CLI
 * wrappers. CLI wrappers call process.exit(1) on validation errors; if a
 * worker claimed a badly-formed job and ran one, the WORKER PROCESS would
 * die and every in-flight job would go stalled. Library Cores throw
 * instead, so one bad job fails one job — not the worker.
 *
 * Per the v0.11.1 plan (Codex architecture #5 — tension 3).
 */
export async function registerBuiltinHandlers(
  worker: MinionWorker,
  engine: BrainEngine,
  opts?: { quiet?: boolean },
): Promise<void> {
  // `quiet` suppresses the informational startup stderr lines. The supervisor
  // (issue #1801) runs this against a throwaway worker purely to read
  // `registeredNames` for wedge name-scoping — it must not spam the operator's
  // terminal with "shell handler registered…" lines. The real `jobs work` path
  // omits opts and prints as before.
  const quiet = opts?.quiet === true;
  worker.register('sync', async (job) => {
    const { performSync } = await import('./sync.ts');
    const repoPath = typeof job.data.repoPath === 'string' ? job.data.repoPath : undefined;
    const noPull = !!job.data.noPull;
    // noEmbed defaults to true (embed is a separate job — submit `embed --stale`
    // after sync, OR run via the autopilot cycle which has its own embed phase).
    // Caller can opt in by passing { noEmbed: false } in job params.
    const noEmbed = job.data.noEmbed !== false;
    // v0.22.13 (PR #490 CODEX-1): resolve sourceId from job param OR by looking
    // up the sources row for repoPath. Mirrors cycle.ts:480 — without this, a
    // multi-source brain reads the global config.sync.last_commit anchor
    // instead of sources.last_commit, which on a regularly-GC'd repo can drop
    // out of git history and trigger 30-min full reimports every cycle.
    let sourceId: string | undefined =
      typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    if (!sourceId && repoPath) {
      try {
        const rows = await engine.executeRaw<{ id: string }>(
          `SELECT id FROM sources WHERE local_path = $1 LIMIT 1`,
          [repoPath],
        );
        sourceId = rows[0]?.id;
      } catch {
        // sources table may not exist on very old brains — fall through to
        // global config.sync.* anchor in performSync.
      }
    }
    // v0.22.13 (PR #490 CODEX-4): route concurrency through the shared
    // autoConcurrency helper instead of hardcoded 4. PGLite engines stay
    // serial (forced 1); explicit job param wins; auto path defaults are
    // applied inside performSync against the resolved file count.
    const concurrencyOverride = typeof job.data.concurrency === 'number'
      ? job.data.concurrency
      : undefined;
    // v0.36+ codex #5 fix: standalone `sync` handler now passes
    // noExtract:true so doctor's remediation plan [sync, extract] doesn't
    // double-extract (performSync inline-extract + standalone extract job).
    // Pre-fix, runPhaseSync in cycle.ts passed noExtract:true but the
    // standalone handler dropped it. Callers that want inline extract can
    // pass { noExtract: false } in job params explicitly.
    const noExtract = job.data.noExtract !== false;
    let result;
    try {
      result = await performSync(engine, {
        repoPath, sourceId, noPull, noEmbed, noExtract,
        concurrency: concurrencyOverride,
      });
    } catch (err) {
      // v0.42.x (#1794, Part B): single-flight backpressure. A concurrent
      // sync (manual run, sibling autopilot tick) holds the per-source lock.
      // SKIP cleanly — mark the job done, NOT failed — so the holder finishes
      // without this tick polluting the failed-jobs count + supervisor crash
      // metrics. The next scheduled tick resumes against the (by then
      // advanced) anchor.
      const { SyncLockBusyError } = await import('./sync.ts');
      if (err instanceof SyncLockBusyError) {
        console.error(
          `[sync] skipped: sync already in progress for ${sourceId ?? 'default'} ` +
          `(lock ${err.lockKey} held).`,
        );
        return { skipped: true, reason: 'sync_in_progress', source_id: sourceId ?? 'default' };
      }
      throw err;
    }

    // v0.40 D22: auto_embed_backfill defaults TRUE when sourceId is set AND
    // the feature flag is enabled. Submits a child embed-backfill job
    // (fire-and-forget — D15.1) so stale chunks get embedded async without
    // the sync handler waiting on the embed pipeline.
    const autoEmbed = job.data.auto_embed_backfill !== false;
    let embedJobId: number | null = null;
    let embedSkipReason: string | null = null;
    if (autoEmbed && sourceId && result.status !== 'up_to_date' && result.status !== 'dry_run') {
      try {
        const { isFederatedV2Enabled } = await import('../core/feature-flags.ts');
        if (await isFederatedV2Enabled(engine)) {
          const { submitEmbedBackfill } = await import('../core/embed-backfill-submit.ts');
          const submission = await submitEmbedBackfill(engine, sourceId, {
            reason: typeof job.data.embed_reason === 'string'
              ? (job.data.embed_reason as string)
              : 'sync_handler',
          });
          if (submission.status === 'submitted') {
            embedJobId = submission.jobId ?? null;
          } else {
            embedSkipReason = submission.status;
          }
        } else {
          embedSkipReason = 'feature_flag_disabled';
        }
      } catch (err) {
        // Embed-backfill submission failure must NOT fail the sync job.
        embedSkipReason = `submit_error:${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (!sourceId) {
      embedSkipReason = 'no_source_id';
    } else if (!autoEmbed) {
      embedSkipReason = 'auto_embed_disabled';
    }

    return { ...result, embed_job_id: embedJobId, embed_skip_reason: embedSkipReason };
  });

  worker.register('embed', async (job) => {
    const { runEmbedCore } = await import('./embed.ts');
    // Primary Minion progress channel is job.updateProgress (DB-backed,
    // readable via `gbrain jobs get <id>`). Stderr from the worker daemon
    // only emits coarse job-start / job-done lines; per-page detail lives
    // in the DB. Per Codex review #20.
    await runEmbedCore(engine, {
      slug: typeof job.data.slug === 'string' ? job.data.slug : undefined,
      slugs: Array.isArray(job.data.slugs) ? (job.data.slugs as string[]) : undefined,
      all: !!job.data.all,
      stale: job.data.all ? false : (job.data.stale !== false),
      sourceId: typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined,
      // CX1+CX5: pace overrides ride in the job payload as explicit overrides
      // only; runEmbedCore re-resolves env > config > bundle at execution so
      // GBRAIN_PACE_* still wins during an incident.
      ...(job.data.pace && typeof job.data.pace === 'object'
        ? {
            pace: job.data.pace as { perCallMode?: string; perCall?: PaceKeyOverrides },
            // Serialized from the queued payload → config tier so GBRAIN_PACE_*
            // on the worker still wins at execution (Codex P2 escape hatch).
            paceFromBackground: true,
          }
        : {}),
      onProgress: (done, total, embedded) => {
        // Fire-and-forget: progress updates are best-effort and must not
        // block the worker loop.
        job.updateProgress({ done, total, embedded, phase: 'embed.pages' }).catch(() => {});
      },
    });
    return { embedded: true };
  });

  worker.register('lint', async (job) => {
    const { runLintCore } = await import('./lint.ts');
    const target = typeof job.data.dir === 'string' ? job.data.dir : '.';
    // issue #1678: reuse the worker's live engine for lint's content-sanity
    // DB lift so it doesn't create + disconnect a competing engine.
    const result = await runLintCore({ target, fix: !!job.data.fix, dryRun: !!job.data.dryRun, engine });
    return result;
  });

  // v0.41.11.0 — extract-conversation-facts. NOT in PROTECTED_JOB_NAMES
  // because per-call cost is bounded by `data.max_cost_usd` (default
  // DEFAULT_MAX_COST_USD = $5) and the handler re-creates the
  // BudgetTracker inside its own process. BudgetExhausted is caught at
  // the core level and returned as `result.budget_exhausted: true` (NOT
  // a job failure) so the user can resume with a higher cap.
  worker.register('extract-conversation-facts', async (job) => {
    const { runExtractConversationFactsCore } = await import('./extract-conversation-facts.ts');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    if (!sourceId) {
      // Multi-source iteration not supported in the Minion-handler path;
      // the CLI wrapper does multi-source loops. A background submission
      // SHOULD pin to one source per call (job_id is per-call).
      throw new Error('extract-conversation-facts Minion job requires data.sourceId');
    }
    const types = Array.isArray(job.data.types)
      ? (job.data.types as string[]).filter((t) =>
          ['conversation', 'meeting', 'slack', 'email'].includes(t),
        )
      : undefined;
    const result = await runExtractConversationFactsCore(engine, {
      sourceId,
      types: types as ('conversation' | 'meeting' | 'slack' | 'email')[] | undefined,
      slug: typeof job.data.slug === 'string' ? job.data.slug : undefined,
      dryRun: !!job.data.dryRun,
      limit: typeof job.data.limit === 'number' ? job.data.limit : undefined,
      sinceIso: typeof job.data.sinceIso === 'string' ? job.data.sinceIso : undefined,
      force: !!job.data.force,
      sleepMs: typeof job.data.sleepMs === 'number' ? job.data.sleepMs : undefined,
      segmentLimit: typeof job.data.segmentLimit === 'number' ? job.data.segmentLimit : undefined,
      maxCostUsd: typeof job.data.maxCostUsd === 'number' ? job.data.maxCostUsd : undefined,
      overrideDisabled: !!job.data.overrideDisabled,
      // v0.41.15.0 (D9): round-trip --workers via job.data.workers so
      // `gbrain extract-conversation-facts --background --workers 20`
      // works end-to-end.
      workers: typeof job.data.workers === 'number' ? job.data.workers : undefined,
    });
    return result;
  });

  // v0.42.x (#2390) — Life Chronicle event extraction. NOT protected (bounded
  // LLM spend per page; no shell). Enqueued by the put_page chronicle backstop
  // and by `gbrain chronicle backfill`. Idempotent (content-addressed event
  // slugs + projection upsert), so a retry re-runs to the same state.
  worker.register('chronicle_extract', async (job) => {
    const slug = typeof job.data.slug === 'string' ? job.data.slug : undefined;
    if (!slug) throw new Error('chronicle_extract job requires data.slug');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    const { runChronicleExtract } = await import('../core/chronicle/extract-events.ts');
    const { chronicleTz } = await import('../core/chronicle/config.ts');
    const tz = await chronicleTz(engine);
    return await runChronicleExtract(engine, {
      slug,
      sourceId,
      tz,
      signal: (job as { signal?: AbortSignal }).signal,
    });
  });

  // v0.41.39 (#1700) — enrich. NOT in PROTECTED_JOB_NAMES: per-call cost is
  // bounded by data.maxCostUsd (default DEFAULT_MAX_COST_USD) and the handler
  // re-creates the BudgetTracker in its own process. BudgetExhausted is caught
  // at the core level and returned as result.budget_exhausted (NOT a failure).
  // Strict per-source: the CLI fans out one job per source when --source is
  // omitted, so a job ALWAYS carries data.sourceId.
  worker.register('enrich', async (job) => {
    const { runEnrichCore } = await import('./enrich.ts');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    if (!sourceId) {
      throw new Error('enrich Minion job requires data.sourceId (CLI fans out one job per source)');
    }
    const types = Array.isArray(job.data.types)
      ? (job.data.types as string[])
      : undefined;
    const order = typeof job.data.order === 'string' ? job.data.order : undefined;
    const result = await runEnrichCore(engine, {
      sourceId,
      types: types as import('../core/types.ts').PageType[] | undefined,
      order: order as ('inbound-links' | 'salience' | 'updated') | undefined,
      limit: typeof job.data.limit === 'number' ? job.data.limit : undefined,
      workers: typeof job.data.workers === 'number' ? job.data.workers : undefined,
      model: typeof job.data.model === 'string' ? job.data.model : undefined,
      maxCostUsd: typeof job.data.maxCostUsd === 'number' ? job.data.maxCostUsd : undefined,
      minContextChars: typeof job.data.minContextChars === 'number' ? job.data.minContextChars : undefined,
      thinThreshold: typeof job.data.thinThreshold === 'number' ? job.data.thinThreshold : undefined,
      reenrichAfterMs: typeof job.data.reenrichAfterMs === 'number' ? job.data.reenrichAfterMs : undefined,
      dryRun: !!job.data.dryRun,
      force: !!job.data.force,
    });
    return result;
  });

  // v0.40.3.0 T8b: RemediationStep consumer handlers. Thin wrappers
  // around already-shipping CLI commands so doctor --remediate can
  // submit them as Minion jobs. NOT in PROTECTED_JOB_NAMES (no shell
  // exec, no cost spike, MCP-safe).
  worker.register('lint-fix', async (job) => {
    const { runLintCore } = await import('./lint.ts');
    const target = typeof job.data.dir === 'string' ? job.data.dir : '.';
    // issue #1678: reuse the worker's live engine (see 'lint' handler).
    return await runLintCore({ target, fix: true, dryRun: false, engine });
  });

  worker.register('integrity-auto', async () => {
    const { runIntegrity } = await import('./integrity.ts');
    await runIntegrity(['auto']);
    return { ok: true };
  });

  worker.register('sync-retry-failed', async () => {
    const { runSync } = await import('./sync.ts');
    await runSync(engine, ['--retry-failed']);
    return { ok: true };
  });

  worker.register('import', async (job) => {
    // import.ts Core extraction deferred to v0.12.0 (import has parallel
    // workers + checkpointing). Keep the CLI wrapper call but note the
    // worker-kill risk is bounded: import's only process.exit fires on
    // a missing dir arg, which this handler always passes.
    const { runImport } = await import('./import.ts');
    const importArgs: string[] = [];
    if (job.data.dir) importArgs.push(String(job.data.dir));
    if (job.data.noEmbed) importArgs.push('--no-embed');
    await runImport(engine, importArgs);
    return { imported: true };
  });

  worker.register('extract', async (job) => {
    const { runExtractCore } = await import('./extract.ts');
    const mode = (typeof job.data.mode === 'string' && ['links', 'timeline', 'all'].includes(job.data.mode))
      ? (job.data.mode as 'links' | 'timeline' | 'all')
      : 'all';
    const dir = typeof job.data.dir === 'string'
      ? job.data.dir
      : (await engine.getConfig('sync.repo_path')) ?? '.';
    return await runExtractCore(engine, { mode, dir, dryRun: !!job.data.dryRun });
  });

  worker.register('backlinks', async (job) => {
    const { runBacklinksCore } = await import('./backlinks.ts');
    const action: 'check' | 'fix' = job.data.action === 'check' ? 'check' : 'fix';
    const dir = typeof job.data.dir === 'string'
      ? job.data.dir
      : (await engine.getConfig('sync.repo_path')) ?? '.';
    return await runBacklinksCore({ action, dir, dryRun: !!job.data.dryRun });
  });

  // Autopilot-cycle handler: delegates to runCycle. Shares the exact same
  // phase set and ordering as `gbrain dream` and autopilot's inline path —
  // one source of truth for what the brain does overnight.
  //
  // Yields the event loop between phases so the worker's lock-renewal
  // timer (src/core/minions/worker.ts) can fire. Without this the v0.14
  // stall-death regression returns: long CPU-bound phases starve the
  // renewal callback and the stalled-sweeper kills the job.
  //
  // Phase failures surface as report.status='partial' (via runCycle's
  // v0.40.3.0: per-page contextual retrieval re-embed handler. PROTECTED
  // name (src/core/minions/protected-names.ts) — MCP/OAuth callers can't
  // submit; only trusted local callers (config.ts mode-switch hook,
  // reindex sweep, doctor --remediate). Composes the global Haiku rate-
  // leaser per D26 P0-3 + delegates to contextual-retrieval-service.ts
  // for the two-phase build.
  {
    const { makeContextualReindexHandler } = await import(
      '../core/minions/handlers/contextual-reindex-per-chunk.ts'
    );
    worker.register('contextual_reindex_per_chunk', makeContextualReindexHandler({ engine }));
  }

  // derivation); the handler returns { partial, status, report } so
  // `gbrain jobs get <id>` shows the full structured report. Does NOT
  // throw on partial: a flaky phase must not block every future cycle.
  worker.register('autopilot-cycle', async (job) => {
    const { runCycle } = await import('../core/cycle.ts');
    // v0.41.30 (T2): fall back to null (NOT cwd '.') when no repo is configured.
    // The queued cycle is the same primitive `gbrain dream` uses; a checkout-less
    // postgres brain should skip filesystem phases (no_brain_dir) and run the
    // DB-only phases (resolve_symbol_edges, embed, ...) — not silently lint/sync
    // against whatever directory the worker happens to be running in.
    const repoPath: string | null = typeof job.data.repoPath === 'string'
      ? job.data.repoPath
      : (await engine.getConfig('sync.repo_path')) ?? null;

    // v0.38 (codex r1 P1-2 + P1-5): per-source dispatch threading.
    //   - source_id: when set, runCycle uses the per-source lock ID and
    //     writes last_full_cycle_at on success. Validated at handler entry
    //     so queue replays with malformed source_id dead-letter instead of
    //     reaching cycle code.
    //   - pull: when set, overrides the legacy hardcoded `true` so
    //     per-source dispatch can disable pull for local-only sources.
    //     Missing/undefined keeps the legacy `true` for back-compat.
    //   - Archive recheck: if source_id is set but the source was
    //     archived between fan-out and worker claim, skip cleanly.
    const rawSourceId = job.data.source_id;
    let sourceId: string | undefined;
    // issue #2227/#2194 (TODOS:634, codex #8): a per-source cycle must run its
    // FILESYSTEM phases (sync/lint/extract) against the SOURCE's own checkout,
    // not the global brain's. Pre-fix it inherited `repoPath` (the default
    // checkout) while writing DB freshness for `source_id` — mixed scope that
    // made cooldown/freshness attribute to the wrong source. We resolve the
    // source's `local_path` here and use it as the cycle's brainDir below.
    let sourceLocalPath: string | null = null;
    if (rawSourceId !== undefined && rawSourceId !== null) {
      if (typeof rawSourceId !== 'string') {
        throw new Error(`autopilot-cycle: invalid source_id (not a string): ${JSON.stringify(rawSourceId)}`);
      }
      const { isValidSourceId } = await import('../core/source-id.ts');
      if (!isValidSourceId(rawSourceId)) {
        // Dead-letter early — malformed source_id from queue replay shouldn't
        // reach cycle code. TS narrowing via isValidSourceId boolean shape
        // (assertValidSourceId would require static-import per TS2775).
        throw new Error(`autopilot-cycle: invalid source_id (regex): ${JSON.stringify(rawSourceId)}`);
      }
      // Archive recheck (codex r1 P1-5): cheap pre-cycle lookup. Returns
      // immediately if source is gone or archived; runCycle never even
      // acquires a lock. Also fetches local_path so FS phases bind to the
      // source's own checkout (the #2227/#2194 mixed-scope fix).
      const rows = await engine.executeRaw<{ archived: boolean | null; local_path: string | null }>(
        `SELECT archived, local_path FROM sources WHERE id = $1`,
        [rawSourceId],
      );
      if (rows.length === 0) {
        return {
          partial: false,
          status: 'skipped',
          report: { reason: 'source_not_found', source_id: rawSourceId },
        };
      }
      if (rows[0].archived === true) {
        return {
          partial: false,
          status: 'skipped',
          report: { reason: 'source_archived', source_id: rawSourceId },
        };
      }
      sourceId = rawSourceId;
      sourceLocalPath = typeof rows[0].local_path === 'string' && rows[0].local_path.length > 0
        ? rows[0].local_path
        : null;
    }

    // Effective checkout for FS phases. For a per-source cycle, bind to the
    // SOURCE's local_path (or null → skip FS phases for a pure-DB source);
    // NEVER fall through to the global repoPath, which would run sync/lint
    // against the wrong tree. Legacy (no source_id) keeps the global repoPath.
    const effectiveBrainDir: string | null = sourceId ? sourceLocalPath : repoPath;

    // Allow callers to select phases via job data (e.g. skip embed for
    // fast cycles). Validates against ALL_PHASES to prevent injection.
    const { ALL_PHASES } = await import('../core/cycle.ts');
    const validPhases = new Set(ALL_PHASES);
    const requestedPhases = Array.isArray(job.data.phases)
      ? (job.data.phases as string[]).filter(p => validPhases.has(p as any))
      : undefined;

    // Pull default: legacy `true` for back-compat; explicit boolean wins.
    const pull = typeof job.data.pull === 'boolean' ? job.data.pull : true;

    // #2194 fix #2 / codex #5 (D4): claim-time cooldown guard. A job already
    // queued or retrying (max_attempts:2) can reach the worker after the
    // dispatch gate decided to back this source off. Skip it here as a NO-OP
    // (status 'skipped', NOT a failure — a failure would re-arm the cooldown).
    if (sourceId) {
      const { isSourceInCooldown } = await import('./autopilot-fanout.ts');
      if (await isSourceInCooldown(engine, sourceId)) {
        return {
          partial: false,
          status: 'skipped',
          report: { reason: 'source_in_cooldown', source_id: sourceId },
        };
      }
    }

    const report = await runCycle(engine, {
      brainDir: effectiveBrainDir,
      pull,
      signal: job.signal, // propagate abort so cycle bails on timeout/cancel
      ...(sourceId ? { sourceId } : {}),
      ...(requestedPhases && requestedPhases.length > 0 ? { phases: requestedPhases as any } : {}),
      yieldBetweenPhases: async () => {
        // Yield to the event loop so worker lock-renewal can fire.
        await new Promise<void>(r => setImmediate(r));
      },
    });

    return {
      partial: report.status === 'partial' || report.status === 'failed',
      status: report.status,
      report,
    };
  });

  // #2194 fix #3 / #2227 bug #3 — brain-wide maintenance. Runs the `global`
  // cycle phases (embed, orphans, purge, resolve_symbol_edges, grade_takes,
  // calibration_profile, synthesize_concepts, skillopt) ONCE per window instead
  // of N times concurrently across per-source cycles (the 4→10GB RSS blowout).
  // No source_id → uses the legacy global cycle lock; stamps autopilot.last_global_at
  // on success so the dispatch gate backs off.
  worker.register('autopilot-global-maintenance', async (job) => {
    const { runCycle, GLOBAL_PHASES, LAST_GLOBAL_AT_KEY, ALL_PHASES } = await import('../core/cycle.ts');
    const repoPath: string | null = typeof job.data.repoPath === 'string'
      ? job.data.repoPath
      : (await engine.getConfig('sync.repo_path')) ?? null;

    const validPhases = new Set(ALL_PHASES);
    const requested = Array.isArray(job.data.phases)
      ? (job.data.phases as string[]).filter((p) => validPhases.has(p as never))
      : GLOBAL_PHASES;
    const phases = (requested.length > 0 ? requested : GLOBAL_PHASES) as typeof GLOBAL_PHASES;

    const report = await runCycle(engine, {
      brainDir: repoPath,
      pull: false, // brain-wide DB/maintenance work never git-pulls
      signal: job.signal,
      phases,
      yieldBetweenPhases: async () => { await new Promise<void>((r) => setImmediate(r)); },
    });

    // Stamp last_global_at only on a non-failed run so a failed pass stays stale
    // and re-dispatches next tick (self-healing retry).
    if (report.status === 'ok' || report.status === 'clean' || report.status === 'partial') {
      try {
        await engine.setConfig(LAST_GLOBAL_AT_KEY, new Date().toISOString());
      } catch (e) {
        console.warn(`[autopilot-global-maintenance] failed to stamp last_global_at: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return {
      partial: report.status === 'partial' || report.status === 'failed',
      status: report.status,
      report,
    };
  });

  // Shell handler is always registered. Runtime env guard lives inside the
  // handler so claimed jobs emit a clear rejection log on workers missing
  // GBRAIN_ALLOW_SHELL_JOBS=1.
  {
    const { shellHandler } = await import('../core/minions/handlers/shell.ts');
    worker.register('shell', shellHandler);
    if (!quiet) {
      if (process.env.GBRAIN_ALLOW_SHELL_JOBS === '1') {
        process.stderr.write('[minion worker] shell handler enabled (GBRAIN_ALLOW_SHELL_JOBS=1)\n');
      } else {
        process.stderr.write('[minion worker] shell handler registered in guarded mode (set GBRAIN_ALLOW_SHELL_JOBS=1 to execute shell jobs)\n');
      }
    }
  }

  // v0.15 subagent handlers: always-on. Unlike shell (which needs an env
  // flag because of RCE surface), subagent only calls the Anthropic API
  // with the operator's own ANTHROPIC_API_KEY — no key, the SDK call
  // fails immediately. Who-can-submit is already gated by
  // PROTECTED_JOB_NAMES + TrustedSubmitOpts (MCP can't submit subagent
  // jobs; only the CLI path with allowProtectedSubmit can). No separate
  // cost-ceremony env flag needed.
  const { makeSubagentHandler } = await import('../core/minions/handlers/subagent.ts');
  const { subagentAggregatorHandler } = await import('../core/minions/handlers/subagent-aggregator.ts');
  worker.register('subagent', makeSubagentHandler({ engine }));
  worker.register('subagent_aggregator', subagentAggregatorHandler);
  process.stderr.write('[minion worker] subagent handlers enabled\n');

  // ============================================================
  // v0.38 ingestion substrate — ingest_capture handler. Receives
  // IngestionEvent payloads from the daemon's dispatcher (file-watcher,
  // inbox-folder, cron-scheduler sources) and from serve --http's
  // POST /ingest route (webhook source). Routes through importFromContent
  // to land as a brain page under inbox/YYYY-MM-DD-<hash6> (or the
  // caller-provided slug).
  // ============================================================
  const { makeIngestCaptureHandler } = await import('../core/minions/handlers/ingest-capture.ts');
  worker.register('ingest_capture', makeIngestCaptureHandler(engine));

  // ============================================================
  // v0.36+ brain-health-100 wave: 11 new handlers for autonomous
  // remediation via `gbrain doctor --remediate` and autopilot.
  //
  // PROTECTED via PROTECTED_JOB_NAMES (D11): synthesize, patterns,
  // consolidate — they internally submit `subagent` jobs with
  // allowProtectedSubmit=true, so they CAN spend Anthropic credits.
  // Open handlers (DB writes only): reindex, repair-jsonb, orphans,
  // integrity, purge, extract_facts, resolve_symbol_edges,
  // recompute_emotional_weight.
  // ============================================================

  worker.register('reindex', async (job) => {
    const { runReindex } = await import('./reindex.ts');
    const args: string[] = ['--markdown'];
    if (typeof job.data.limit === 'number') args.push('--limit', String(job.data.limit));
    if (job.data.dryRun) args.push('--dry-run');
    if (job.data.noEmbed) args.push('--no-embed');
    if (typeof job.data.repoPath === 'string') args.push('--repo', job.data.repoPath);
    const result = await runReindex(engine, args);
    return { ...result, ran: 'reindex' };
  });

  worker.register('repair-jsonb', async (job) => {
    const { repairJsonb } = await import('./repair-jsonb.ts');
    const dryRun = !!job.data.dryRun;
    const result = await repairJsonb({ dryRun });
    return result;
  });

  worker.register('orphans', async (_job) => {
    const result = await engine.findOrphanPages();
    return { count: result.length, orphans: result };
  });

  worker.register('integrity', async (job) => {
    const { runIntegrity } = await import('./integrity.ts');
    const args: string[] = [];
    args.push(job.data.mode === 'auto' ? 'auto' : 'check');
    if (typeof job.data.confidence === 'number') args.push('--confidence', String(job.data.confidence));
    if (job.data.dryRun) args.push('--dry-run');
    await runIntegrity(args);
    return { ran: 'integrity', mode: args[0] };
  });

  worker.register('purge', async (job) => {
    const scope = (typeof job.data.scope === 'string' && ['pages', 'sources', 'all'].includes(job.data.scope))
      ? (job.data.scope as 'pages' | 'sources' | 'all')
      : 'all';
    const olderThanHours = typeof job.data.olderThanHours === 'number' ? job.data.olderThanHours : 72;
    const dryRun = !!job.data.dryRun;
    let pagesPurged = 0;
    let sourcesPurged: string[] = [];
    if (scope === 'pages' || scope === 'all') {
      const result = await engine.purgeDeletedPages(olderThanHours);
      pagesPurged = result.count;
    }
    if (scope === 'sources' || scope === 'all') {
      const { purgeExpiredSources } = await import('../core/destructive-guard.ts');
      sourcesPurged = await purgeExpiredSources(engine);
    }
    // GC stale op_checkpoints rows (folded scope item +C from review).
    const { purgeStaleCheckpoints } = await import('../core/op-checkpoint.ts');
    const checkpointsPurged = await purgeStaleCheckpoints(engine, 7);
    return { pagesPurged, sourcesPurged, checkpointsPurged, dryRun };
  });

  // Phase-wrapper handlers — each delegates to runCycle({ phases: [name] }).
  // Cycle owns the lock + abort signal + progress reporter per D10.
  // Smaller diff than full standalone phase extraction; cycle.ts remains
  // the single source of truth for phase semantics.
  const makePhaseHandler = (phase: string) => async (job: any) => {
    const { runCycle } = await import('../core/cycle.ts');
    // v0.41.38 (codex P2 review): fall back to null (NOT cwd '.') when no repo
    // is configured, matching the autopilot-cycle handler + `gbrain dream`. On a
    // checkout-less postgres brain a filesystem phase (synthesize/patterns/...)
    // skips with reason 'no_brain_dir' instead of running against the worker cwd;
    // DB-only phases (resolve_symbol_edges/embed/...) ignore brainDir either way.
    const repoPath: string | null = typeof job.data.repoPath === 'string'
      ? job.data.repoPath
      : ((await engine.getConfig('sync.repo_path')) ?? null);
    const report = await runCycle(engine, {
      brainDir: repoPath,
      phases: [phase as any],
      signal: job.signal,
    });
    return { phase, status: report.status, report };
  };

  // PROTECTED — internally spawn subagent children
  worker.register('synthesize', makePhaseHandler('synthesize'));
  worker.register('patterns', makePhaseHandler('patterns'));
  worker.register('consolidate', makePhaseHandler('consolidate'));

  // Open — DB writes only, no LLM spend
  worker.register('extract_facts', makePhaseHandler('extract_facts'));
  worker.register('resolve_symbol_edges', makePhaseHandler('resolve_symbol_edges'));
  worker.register('recompute_emotional_weight', makePhaseHandler('recompute_emotional_weight'));

  // v0.42.x (#1685 GAP D) — PROTECTED bounded extract_atoms backlog drain.
  // Thin wrapper over the shared helper (DECISION 5A) so the CLI `--drain`
  // path, this handler, and autopilot's auto-drain can't diverge on lock id /
  // window / defer behavior. On LockUnavailableError (the routine cycle holds
  // the per-source lock) the job completes `{ deferred: true }` and retries
  // next tick instead of failing — cooperative interleave (CODEX accepted).
  worker.register('extract-atoms-drain', async (job) => {
    const { runExtractAtomsDrainForSource } = await import('../core/cycle/extract-atoms-drain.ts');
    const { LockUnavailableError } = await import('../core/db-lock.ts');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    const windowSeconds =
      typeof job.data.window === 'number' && job.data.window > 0 ? job.data.window : 120;
    const repoPath =
      typeof job.data.repoPath === 'string'
        ? job.data.repoPath
        : ((await engine.getConfig('sync.repo_path')) ?? undefined);
    try {
      return await runExtractAtomsDrainForSource(engine, {
        sourceId,
        windowSeconds,
        brainDir: repoPath,
      });
    } catch (e) {
      if (e instanceof LockUnavailableError) {
        return { phase: 'extract_atoms', status: 'skipped', deferred: true, reason: 'cycle_already_running' };
      }
      throw e;
    }
  });

  // v0.40 Federated Sync v2 — embed-backfill: per-source decoupled embed.
  // Cost-bounded via D6 ($10/job BudgetTracker) + D19 (source-level cooldown
  // + 24h rolling cap, gated at submit time). NOT in PROTECTED_JOB_NAMES —
  // embedding-only spend, no API-by-the-minute risk like subagent.
  worker.register('embed-backfill', async (job) => {
    const { makeEmbedBackfillHandler } = await import('../core/minions/handlers/embed-backfill.ts');
    return await makeEmbedBackfillHandler(engine)(job);
  });

  // v0.41.18.0 (A10, T7): extract-ner handler for the gbrain onboard
  // remediation pipeline. Wraps extractNerLinks; emits typed_ner kind
  // alongside the by-mention 'plain' kind. NOT in PROTECTED_JOB_NAMES
  // (regex-only, no LLM spend).
  worker.register('extract-ner', async (job) => {
    const { extractNerLinks } = await import('../core/extract-ner.ts');
    const data = (job.data ?? {}) as { sourceId?: string };
    return await extractNerLinks(engine, {
      sourceIdFilter: data.sourceId,
    });
  });

  // v0.41.18.0 (A12, T9): extract-takes-from-pages handler. PROTECTED
  // (LLM-bearing). Two-gate consent enforced at the handler boundary:
  // refuses to run unless takes.bootstrap_enabled config is true, even
  // when allowProtectedSubmit was set at queue.add time.
  worker.register('extract-takes-from-pages', async (job) => {
    const { extractTakesFromPages } = await import('../core/extract-takes-from-pages.ts');
    const data = (job.data ?? {}) as { sourceId?: string; maxPages?: number };
    const bootstrapCfg = await engine.getConfig('takes.bootstrap_enabled');
    const bootstrapEnabled = bootstrapCfg === 'true' || bootstrapCfg === '1';
    return await extractTakesFromPages(engine, {
      bootstrapEnabled,
      sourceIdFilter: data.sourceId,
      maxPages: data.maxPages,
    });
  });

  // v0.41.18.0 (A11, T8): extract-timeline-from-meetings handler. Wraps
  // extractTimelineFromMeetings. NOT in PROTECTED_JOB_NAMES (pure SQL + string
  // scan, no LLM spend).
  worker.register('extract-timeline-from-meetings', async (job) => {
    const { extractTimelineFromMeetings } = await import('../core/extract-timeline-from-meetings.ts');
    const data = (job.data ?? {}) as { sourceId?: string };
    return await extractTimelineFromMeetings(engine, {
      sourceIdFilter: data.sourceId,
    });
  });

  // v0.41.18.0 (A13): embed-catch-up handler for the gbrain onboard
  // remediation pipeline. Wraps runEmbedCore with stale + catchUp + the
  // priority/batchSize the recommendation supplies. NOT in
  // PROTECTED_JOB_NAMES (embedding spend only).
  worker.register('embed-catch-up', async (job) => {
    const { runEmbedCore } = await import('./embed.ts');
    const data = (job.data ?? {}) as {
      sourceId?: string;
      batchSize?: number;
      priority?: 'recent';
    };
    return await runEmbedCore(engine, {
      stale: true,
      catchUp: true,
      batchSize: data.batchSize,
      priority: data.priority,
      sourceId: data.sourceId,
    });
  });

  // v0.42 type-unification (T10): unify-types PROTECTED handler. Pack-upgrade
  // migration that retypes 25K+ pages, creates alias rows, converts edge-
  // shaped pages to link rows, AND flips the active pack at end of run.
  // manual_only via src/core/onboard/render.ts:MANUAL_ONLY_PROTECTED_JOBS.
  // Operator path: `gbrain jobs submit unify-types --allow-protected --params
  // '{"target_pack":"gbrain-base-v2"}'`.
  worker.register('unify-types', async (job) => {
    const { runUnifyTypes } = await import('../core/schema-pack/unify-types-handler.ts');
    const data = (job.data ?? {}) as {
      target_pack?: string;
      apply?: boolean;
      sourceId?: string;
    };
    if (!data.target_pack) {
      throw new Error(`unify-types: missing required 'target_pack' parameter`);
    }
    const ctx = {
      engine,
      cfg: null,
      remote: false,
    } as unknown as import('../core/operations.ts').OperationContext;
    return await runUnifyTypes(ctx, {
      target_pack: data.target_pack,
      apply: data.apply ?? true,
      sourceId: data.sourceId,
      onProgress: (msg: string) => {
        job.updateProgress({ phase: 'unify-types', message: msg }).catch(() => {});
        process.stderr.write(msg + '\n');
      },
    });
  });

  // v0.42.0.0 SkillOpt Minion handler — for --background CLI invocations.
  // PROTECTED by name so MCP submission rejects (only trusted CLI can
  // submit). Threaded SkillOptOpts JSON in job.data.
  worker.register('skillopt', async (job) => {
    const { runSkillOpt } = await import('../core/skillopt/orchestrator.ts');
    const data = (job.data ?? {}) as Record<string, unknown>;
    const skillsDir = String(data.skills_dir ?? '');
    const skillName = String(data.skill_name ?? '');
    const benchmarkPath = String(data.benchmark_path ?? '');
    if (!skillsDir || !skillName || !benchmarkPath) {
      throw new Error(`skillopt handler: missing required job.data fields (skills_dir, skill_name, benchmark_path)`);
    }
    const result = await runSkillOpt({
      engine,
      skillName,
      skillsDir,
      benchmarkPath,
      epochs: Number(data.epochs ?? 4),
      batchSize: Number(data.batch_size ?? 8),
      lr: Number(data.lr ?? 4),
      lrSchedule: (data.lr_schedule as 'cosine' | 'linear' | 'constant') ?? 'cosine',
      split: (data.split as [number, number, number]) ?? [4, 1, 5],
      optimizerModel: String(data.optimizer_model ?? 'anthropic:claude-opus-4-7'),
      targetModel: String(data.target_model ?? 'anthropic:claude-sonnet-4-6'),
      judgeModel: String(data.judge_model ?? 'anthropic:claude-sonnet-4-6'),
      mode: (data.mode as 'patch' | 'rewrite') ?? 'patch',
      dryRun: Boolean(data.dry_run),
      noMutate: Boolean(data.no_mutate),
      allowMutateBundled: Boolean(data.allow_mutate_bundled),
      bootstrapReviewed: Boolean(data.bootstrap_reviewed),
      ...(data.held_out_path ? { heldOutPath: String(data.held_out_path) } : {}),
      json: true,
      maxCostUsd: Number(data.max_cost_usd ?? 5.0),
      maxRuntimeMin: Number(data.max_runtime_min ?? 30),
      force: Boolean(data.force),
    });
    return {
      outcome: result.outcome,
      receipt: result.receipt,
      mutated_skill_file: result.mutatedSkillFile,
      proposed_path: result.proposedPath,
    };
  });

  process.stderr.write('[minion worker] brain-health-100 handlers registered (12 ops, 4 protected) + embed-backfill (v0.40) + embed-catch-up (v0.42) + unify-types (v0.42) + skillopt (v0.42.0.0, protected)\n');

  // Plugin discovery — one line per discovered plugin (mirrors the
  // openclaw-seam startup line convention from v0.11+). Loaded
  // unconditionally; empty GBRAIN_PLUGIN_PATH is a no-op.
  try {
    const { loadPluginsFromEnv } = await import('../core/minions/plugin-loader.ts');
    const { BRAIN_TOOL_ALLOWLIST } = await import('../core/minions/tools/brain-allowlist.ts');
    const validNames = new Set<string>();
    for (const n of BRAIN_TOOL_ALLOWLIST) validNames.add(`brain_${n}`);
    const loaded = loadPluginsFromEnv({ validAgentToolNames: validNames });
    for (const w of loaded.warnings) process.stderr.write(w + '\n');
    for (const p of loaded.plugins) {
      process.stderr.write(
        `[plugin-loader] loaded '${p.manifest.name}' v${p.manifest.version} (${p.subagents.length} subagents)\n`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`[plugin-loader] discovery failed: ${msg}\n`);
  }
}
