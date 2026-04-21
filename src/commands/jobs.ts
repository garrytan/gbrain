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
                            [--delay Nms] [--timeout-ms Nms] [--max-attempts N]
                            [--queue Q] [--dry-run]
  gbrain jobs list [--status S] [--queue Q] [--limit N]
  gbrain jobs get <id>
  gbrain jobs cancel <id>
  gbrain jobs retry <id>
  gbrain jobs prune [--older-than 30d]
  gbrain jobs delete <id>
  gbrain jobs stats
  gbrain jobs smoke
  gbrain jobs work [--queue Q] [--concurrency N]

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
      const queueName = parseFlag(args, '--queue') ?? 'default';
      const timeoutMsRaw = parseFlag(args, '--timeout-ms');
      const timeoutMs = timeoutMsRaw !== undefined ? parseInt(timeoutMsRaw, 10) : undefined;
      if (timeoutMsRaw !== undefined && (isNaN(timeoutMs!) || timeoutMs! <= 0)) {
        console.error('Error: --timeout-ms must be a positive integer (milliseconds)');
        process.exit(1);
      }
      const dryRun = hasFlag(args, '--dry-run');
      const follow = hasFlag(args, '--follow');

      if (dryRun) {
        console.log(`[DRY RUN] Would submit job:`);
        console.log(`  Name: ${name}`);
        console.log(`  Queue: ${queueName}`);
        console.log(`  Priority: ${priority}`);
        console.log(`  Max attempts: ${maxAttempts}`);
        if (delay > 0) console.log(`  Delay: ${delay}ms`);
        if (timeoutMs) console.log(`  Timeout: ${timeoutMs}ms`);
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
        queue: queueName,
        timeout_ms: timeoutMs,
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
      if (final?.status === 'completed') {
        const cfg = (await import('../core/config.ts')).loadConfig();
        const engineLabel = cfg?.engine ?? 'unknown';
        console.log(`SMOKE PASS — Minions healthy in ${elapsedSec}s (engine: ${engineLabel})`);
        if (engineLabel === 'pglite') {
          console.log('Note: the `gbrain jobs work` daemon requires Postgres. PGLite');
          console.log('supports inline execution only (`submit --follow`).');
        }
        try { await queue.removeJob(job.id); } catch { /* non-fatal cleanup */ }
        process.exit(0);
      } else {
        console.error(`SMOKE FAIL — job #${job.id} status: ${final?.status ?? 'timeout'} (${elapsedSec}s elapsed)`);
        if (final?.error_text) console.error(`  Error: ${final.error_text}`);
        process.exit(1);
      }
      break;
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
      const concurrency = parseInt(parseFlag(args, '--concurrency') ?? '1', 10);

      try { await queue.ensureSchema(); }
      catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

      const worker = new MinionWorker(engine, { queue: queueName, concurrency });
      await registerBuiltinHandlers(worker, engine);

      console.log(`Minion worker started (queue: ${queueName}, concurrency: ${concurrency})`);
      console.log(`Registered handlers: ${worker.registeredNames.join(', ')}`);
      await worker.start();
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
    await runEmbedCore(engine, {
      slug: typeof job.data.slug === 'string' ? job.data.slug : undefined,
      slugs: Array.isArray(job.data.slugs) ? (job.data.slugs as string[]) : undefined,
      all: !!job.data.all,
      stale: job.data.all ? false : (job.data.stale !== false),
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

  // The killer handler. Autopilot submits ONE `autopilot-cycle` per cycle
  // (idempotency_key on cycle slot) instead of a 4-job parent-child DAG,
  // because Minions' parent/child is NOT a depends_on primitive (Codex
  // H3/H4). Each step is wrapped in its own try/catch; the handler returns
  // `{ partial: true, failed_steps: [...] }` when any step fails. It does
  // NOT throw on partial failure — that would cause the Minion to retry,
  // and an intermittent extract bug would block every future cycle.
  worker.register('autopilot-cycle', async (job) => {
    const { performSync } = await import('./sync.ts');
    const { runExtractCore } = await import('./extract.ts');
    const { runEmbedCore } = await import('./embed.ts');
    const { runBacklinksCore } = await import('./backlinks.ts');

    const repoPath = typeof job.data.repoPath === 'string'
      ? job.data.repoPath
      : (await engine.getConfig('sync.repo_path')) ?? '.';

    const steps: Record<string, unknown> = {};
    const failed: string[] = [];

    // Bug 8 — Between phases, yield to the event loop. The worker's lock
    // renewal runs on a timer (src/core/minions/worker.ts); without a
    // periodic yield, long CPU-bound phases starve the renewal callback
    // and the job gets killed by the stalled-sweeper. A single
    // `await new Promise(r => setImmediate(r))` gives the timer a chance
    // to fire. The per-phase body is async+await already, so each phase
    // internally yields on its own I/O boundaries — this is a belt for
    // the gap between phases.
    //
    // Follow-up (deferred to v0.15): thread ctx.signal / ctx.shutdownSignal
    // through each core fn so mid-phase cancellation works on huge brains.
    const yieldToLoop = () => new Promise<void>(r => setImmediate(r));

    try { steps.sync = await performSync(engine, { repoPath, noEmbed: true }); }
    catch (e) { steps.sync = { error: e instanceof Error ? e.message : String(e) }; failed.push('sync'); }
    await yieldToLoop();

    try { steps.extract = await runExtractCore(engine, { mode: 'all', dir: repoPath }); }
    catch (e) { steps.extract = { error: e instanceof Error ? e.message : String(e) }; failed.push('extract'); }
    await yieldToLoop();

    try { await runEmbedCore(engine, { stale: true }); steps.embed = { embedded: true }; }
    catch (e) { steps.embed = { error: e instanceof Error ? e.message : String(e) }; failed.push('embed'); }
    await yieldToLoop();

    try { steps.backlinks = await runBacklinksCore({ action: 'fix', dir: repoPath }); }
    catch (e) { steps.backlinks = { error: e instanceof Error ? e.message : String(e) }; failed.push('backlinks'); }

    if (failed.length > 0) {
      return { partial: true, failed_steps: failed, steps };
    }
    return { partial: false, steps };
  });

  // Shell handler: registered ONLY when GBRAIN_ALLOW_SHELL_JOBS=1 is set on the
  // worker process. Default-closed; opt-in per-host. Without the flag, shell
  // jobs submitted via CLI insert rows but no worker claims them (they sit in
  // 'waiting' — the CLI prints a starvation warning for that case).
  if (process.env.GBRAIN_ALLOW_SHELL_JOBS === '1') {
    const { shellHandler } = await import('../core/minions/handlers/shell.ts');
    worker.register('shell', shellHandler);
    process.stderr.write('[minion worker] shell handler enabled (GBRAIN_ALLOW_SHELL_JOBS=1)\n');
  } else {
    process.stderr.write('[minion worker] shell handler disabled (set GBRAIN_ALLOW_SHELL_JOBS=1 to enable)\n');
  }
}
