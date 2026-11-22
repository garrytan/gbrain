// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/commands/doctor/checks/queue-jobs.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

// verbatim src/commands/doctor/checks/queue-jobs.ts:784-817
export async function computeAutopilotFanoutConcurrencyCheck(engine: BrainEngine): Promise<Check> {
  if (engine.kind !== 'postgres') {
    return { name: 'autopilot_fanout_concurrency', status: 'ok', message: 'PGLite — single-writer, fan-out is 1' };
  }
  try {
    const { resolveFanoutMax, readSupervisorConcurrency } = await import('../../autopilot-fanout.ts');
    const concurrency = await readSupervisorConcurrency('default');
    if (concurrency === null) {
      return { name: 'autopilot_fanout_concurrency', status: 'ok', message: 'No supervisor observed — skipping fan-out/concurrency check' };
    }
    const fanoutMax = await resolveFanoutMax(engine);
    const effectiveSlots = Math.max(1, concurrency - 1);
    if (fanoutMax > effectiveSlots) {
      return {
        name: 'autopilot_fanout_concurrency',
        status: 'warn',
        message:
          `autopilot fan-out (${fanoutMax}/tick) exceeds worker concurrency (${concurrency}). ` +
          `Surplus cycles queue behind the worker and race the stalled-sweeper. ` +
          `Lower fan-out: \`gbrain config set autopilot.fanout_max_per_tick ${effectiveSlots}\`, ` +
          `or raise the supervisor's \`--concurrency\` to ${fanoutMax + 1}. ` +
          `(The clamp in autopilot does this automatically unless disabled.)`,
        details: { fanout_max: fanoutMax, concurrency, effective_slots: effectiveSlots },
      };
    }
    return {
      name: 'autopilot_fanout_concurrency',
      status: 'ok',
      message: `fan-out ${fanoutMax}/tick within worker concurrency ${concurrency}`,
    };
  } catch (e) {
    return { name: 'autopilot_fanout_concurrency', status: 'ok', message: `Skipped (${e instanceof Error ? e.message : String(e)})` };
  }
}

export async function computeWedgedQueueCheck(engine: any) {
  // verbatim src/commands/doctor/checks/queue-jobs.ts:399-539
  try {
    const rows = await engine.executeRaw<{
      queue: string;
      active_healthy: string | number;
      waiting: string | number;
      mins_since_completion: string | number | null;
    }>(
      `SELECT queue,
         count(*) FILTER (WHERE status = 'active' AND lock_until > now()) AS active_healthy,
         count(*) FILTER (WHERE status = 'waiting') AS waiting,
         EXTRACT(EPOCH FROM (now() - max(updated_at) FILTER (WHERE status = 'completed'))) / 60
           AS mins_since_completion
       FROM minion_jobs
       WHERE queue NOT LIKE 'dream-inline-%'
       GROUP BY queue`,
    );
    const wedged: { queue: string; label: string }[] = [];
    for (const r of rows) {
      const activeHealthy = Number(r.active_healthy ?? 0);
      const waiting = Number(r.waiting ?? 0);
      const mins = r.mins_since_completion === null ? null : Number(r.mins_since_completion);
      // Conservative: only flag stale-after-progress (non-null mins past
      // threshold). The null-completions case is the supervisor's job.
      if (activeHealthy === 0 && waiting > 0 && mins !== null && mins > thresholdMin) {
        wedged.push({
          queue: r.queue,
          label: `'${r.queue}' (${waiting} waiting, 0 active, ${Math.round(mins)}m since last completion)`,
        });
      }
    }
    if (wedged.length === 0) {
      return { name: 'wedged_queue', status: 'ok', message: 'No wedged queues' };
    }
    // The verify-step doctor of an engine graduation runs on the fenced target before any worker may
    // start, so waiting jobs carried from the quiesced source cannot have progressed yet.
    if (process.env.GBRAIN_GRADUATION_RUN) {
      return { name: 'wedged_queue', status: 'warn', message: `Graduation exemption: ${wedged.map(w => w.label).join(', ')} carried from the quiesced source; workers start after cutover.`,
        details: { graduation_exempt: true, run_id: process.env.GBRAIN_GRADUATION_RUN, queues: wedged.map(w => w.queue) } };
    }
    // #7966: an autopilot pause stops every worker's claims, so the backlog is the hold, not a wedge: report it
    // without restart advice (a restart claims nothing while the marker stays).
    if (autopilotPaused()) {
      const operator = existsSync(autopilotOperatorPauseMarkerPath());
      return {
        name: 'wedged_queue',
        status: 'warn',
        message: `Held by ${operator ? 'the operator\'s autopilot pause' : 'the migration pause marker'} (${autopilotPauseReason()}): ${wedged.map(w => w.label).join('; ')}. ` +
          'Workers claim no jobs while it is present, so a restart does not help; ' +
          (operator ? '`gbrain autopilot resume` releases the hold.' : 'it clears when the migration that set it finishes.'),
        details: { wedged_queues: wedged.length, paused: operator ? 'operator' : 'cooperative', threshold_minutes: thresholdMin },
      };
    }
    // #3063: "worker alive but not claiming work" would be a false claim
    // for a queue no worker process was ever subscribed to. Split the
    // wedged set by whether a registered live worker actually exists for
    // that queue (getLiveWorkers() self-cleans dead entries), so the
    // advisory repair matches the real fault instead of misdirecting the
    // operator toward restarting a worker that was never there — a queue
    // with no worker needs `start`, not `stop && start`.
    let liveWorkers: Array<{ queue: string }> = [];
    let registryFailure: { errno: string; path: string | null } | null = null;
    const registry = await import('../../../core/minions/worker-registry.ts');
    try {
      liveWorkers = (opts.readWorkers ?? registry.readWorkers)();
    } catch (e) {
      // A registry read error must not turn this check green (the queue is
      // demonstrably wedged) — but it also must not fabricate a liveness
      // verdict either way. Fall through to the liveness-unknown wording.
      registryFailure = registry.workerRegistryReadFailure(e);
    }
    if (registryFailure) {
      return {
        name: 'wedged_queue',
        status: 'fail',
        message:
          `Wedged queue(s) — worker registry unreadable (${registryFailureLabel(registryFailure, opts.remote === true)}), worker liveness unknown: ` +
          `${wedged.map((w) => w.label).join('; ')}. ` +
          `If a worker is running for the queue, restart it: ` +
          '`gbrain jobs supervisor stop && gbrain jobs supervisor start [--queue <name>]`; ' +
          'if none is, start one: `gbrain jobs supervisor start --queue <name> --detach`.',
        details: {
          wedged_queues: wedged.length,
          ...registryFailureDetails(registryFailure, opts.remote === true),
          threshold_minutes: thresholdMin,
        },
      };
    }
    const liveQueues = new Set(liveWorkers.map((w) => w.queue));
    const stuck = wedged.filter((w) => liveQueues.has(w.queue));
    const noWorker = wedged.filter((w) => !liveQueues.has(w.queue));

    const messageParts: string[] = [];
    if (stuck.length > 0) {
      // Queue-aware restart hint (upstream v0.46.26.0): the bare stop/start
      // pair bounces the DEFAULT worker — for a non-default wedged queue
      // that advice restarts the wrong process. Name the queue in the
      // start command. Queue names are producer-controlled and this hint
      // gets copy-pasted (by operators AND remediation agents), so
      // embedded quotes are escaped for the shell.
      const shellQuote = (q: string) => `'${q.replace(/'/g, String.raw`'\''`)}'`;
      const stuckQueueNames = stuck.map((w) => w.queue);
      const nonDefault = stuckQueueNames.filter((q) => q !== 'default');
      const hints: string[] = [];
      if (nonDefault.length < stuckQueueNames.length || nonDefault.length === 0) {
        hints.push('`gbrain jobs supervisor stop && gbrain jobs supervisor start`');
      }
      for (const q of nonDefault) {
        hints.push(`\`gbrain jobs supervisor stop && gbrain jobs supervisor start --queue ${shellQuote(q)}\``);
      }
      messageParts.push(
        `Wedged queue(s) — worker alive but not claiming work: ${stuck.map((w) => w.label).join('; ')}. ` +
          `Restart the worker so it rebuilds a fresh DB pool: ${hints.join(', ')}, ` +
          `then \`gbrain jobs retry <id>\` on any dead-lettered jobs.`,
      );
    }
    if (noWorker.length > 0) {
      messageParts.push(
        `No worker subscribed to queue(s): ${noWorker.map((w) => w.label).join('; ')}. ` +
          `Start one: \`gbrain jobs supervisor start --queue <name> --detach\` ` +
          `or \`gbrain jobs work --queue <name>\`.`,
      );
    }
    return {
      name: 'wedged_queue',
      status: 'fail',
      message: messageParts.join(' '),
      details: {
        wedged_queues: wedged.length,
        stuck_worker_queues: stuck.length,
        no_worker_queues: noWorker.length,
        threshold_minutes: thresholdMin,
      },
    };
  } catch (e) {
    // Pre-migration brains / transient errors: advisory check stays ok.
    return {
      name: 'wedged_queue',
      status: 'ok',
      message: `Skipped (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}
