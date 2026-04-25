/**
 * CLI handler for `gbrain jobs` subcommands.
 * Thin wrapper around MinionQueue and MinionWorker.
 */

import type { BrainEngine } from '../core/engine.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { MinionWorker } from '../core/minions/worker.ts';
import type { MinionJob, MinionJobStatus } from '../core/minions/types.ts';

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
    `  Attempts: ${job.attempts_made}/${job.max_attempts} (started: ${job.attempts_started})`,
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
  gbrain jobs list [--status S] [--queue Q] [--limit N]
  gbrain jobs get <id>
  gbrain jobs cancel <id>
  gbrain jobs retry <id>
  gbrain jobs prune [--older-than 30d]
  gbrain jobs delete <id>
  gbrain jobs stats
  gbrain jobs smoke
  gbrain jobs work [--queue Q] [--concurrency N]
  gbrain jobs supervisor [start] [--detach] [--json]
                         [--concurrency N] [--queue Q] [--pid-file PATH]
                         [--max-crashes N] [--health-interval N]
                         [--allow-shell-jobs] [--cli-path PATH]
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
          logShellSubmission({
            caller: 'cli',
            remote: false,
            job_id: job.id,
            cwd: typeof data.cwd === 'string' ? data.cwd : '',
            cmd_display: typeof data.cmd === 'string' ? data.cmd.slice(0, 80) : undefined,
            argv_display: Array.isArray(data.argv)
              ? (data.argv as unknown[]).filter((a): a is string => typeof a === 'string').map((a) => a.slice(0, 80))
              : undefined,
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
        // Inline execution: run the job in this process
        const worker = new MinionWorker(engine, { queue: queueName, pollInterval: 100 });

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

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const jobs = await queue.getJobs({ status, queue: queueName, limit });

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

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const job = await queue.getJob(id);
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

      const stats = await queue.getStats();

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

      const worker = new MinionWorker(engine, { queue: 'smoke', pollInterval: 100 });
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

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const worker = new MinionWorker(engine, { queue: queueName, concurrency });
      await registerBuiltinHandlers(worker, engine);

      console.log(`Minion worker started (queue: ${queueName}, concurrency: ${concurrency})`);
      console.log(`Registered handlers: ${worker.registeredNames.join(', ')}`);
      await worker.start();
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
        const { existsSync, readFileSync } = await import('fs');
        const { readSupervisorEvents } = await import('../core/minions/handlers/supervisor-audit.ts');

        let supervisorPid: number | null = null;
        let running = false;
        if (existsSync(pidFile)) {
          try {
            const line = readFileSync(pidFile, 'utf8').trim().split('\n')[0];
            const parsed = parseInt(line, 10);
            if (!isNaN(parsed) && parsed > 0) {
              supervisorPid = parsed;
              try { process.kill(parsed, 0); running = true; } catch { running = false; }
            }
          } catch { /* unreadable PID file */ }
        }

        const events = readSupervisorEvents({ sinceMs: 24 * 60 * 60 * 1000 });
        const lastStart = events.filter(e => e.event === 'started').pop()?.ts ?? null;
        const crashes24h = events.filter(e => e.event === 'worker_exited').length;
        const maxCrashesEvent = events.filter(e => e.event === 'max_crashes_exceeded').pop() ?? null;

        const status = {
          running,
          supervisor_pid: supervisorPid,
          pid_file: pidFile,
          last_start: lastStart,
          crashes_24h: crashes24h,
          max_crashes_exceeded: !!maxCrashesEvent,
        };

        if (jsonMode) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          console.log(`Supervisor: ${running ? 'running' : 'not running'}`);
          if (supervisorPid) console.log(`  PID:           ${supervisorPid}`);
          console.log(`  PID file:      ${pidFile}`);
          if (lastStart) console.log(`  Last start:    ${lastStart}`);
          console.log(`  Crashes (24h): ${crashes24h}`);
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
      const healthInterval = parseInt(parseFlag(args, '--health-interval') ?? '60000', 10);
      const allowShellJobs = hasFlag(args, '--allow-shell-jobs') ||
                             !!process.env.GBRAIN_ALLOW_SHELL_JOBS;
      const detach = hasFlag(args, '--detach');

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

      // Foreground start.
      const supervisorPid = process.pid;
      const supervisor = new MinionSupervisor(engine, {
        concurrency,
        queue: queueName,
        pidFile,
        maxCrashes,
        healthInterval,
        cliPath,
        allowShellJobs,
        json: jsonMode,
        onEvent: (emission) => writeSupervisorEvent(emission, supervisorPid),
      });

      await supervisor.start();
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
export async function registerBuiltinHandlers(worker: MinionWorker, engine: BrainEngine): Promise<void> {
  worker.register('sync', async (job) => {
    const { performSync } = await import('./sync.ts');
    const repoPath = typeof job.data.repoPath === 'string' ? job.data.repoPath : undefined;
    const noPull = !!job.data.noPull;
    const noEmbed = job.data.noEmbed !== false;
    const result = await performSync(engine, { repoPath, noPull, noEmbed });
    return result;
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
    const result = await runLintCore({ target, fix: !!job.data.fix, dryRun: !!job.data.dryRun });
    return result;
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
  // derivation); the handler returns { partial, status, report } so
  // `gbrain jobs get <id>` shows the full structured report. Does NOT
  // throw on partial: a flaky phase must not block every future cycle.
  worker.register('autopilot-cycle', async (job) => {
    const { runCycle } = await import('../core/cycle.ts');
    const repoPath = typeof job.data.repoPath === 'string'
      ? job.data.repoPath
      : (await engine.getConfig('sync.repo_path')) ?? '.';

    const report = await runCycle(engine, {
      brainDir: repoPath,
      pull: true, // autopilot daemon opts into git pull
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

  // Shell handler is always registered. Runtime env guard lives inside the
  // handler so claimed jobs emit a clear rejection log on workers missing
  // GBRAIN_ALLOW_SHELL_JOBS=1.
  {
    const { shellHandler } = await import('../core/minions/handlers/shell.ts');
    worker.register('shell', shellHandler);
    if (process.env.GBRAIN_ALLOW_SHELL_JOBS === '1') {
      process.stderr.write('[minion worker] shell handler enabled (GBRAIN_ALLOW_SHELL_JOBS=1)\n');
    } else {
      process.stderr.write('[minion worker] shell handler registered in guarded mode (set GBRAIN_ALLOW_SHELL_JOBS=1 to execute shell jobs)\n');
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
