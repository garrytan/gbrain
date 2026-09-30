/** `gbrain jobs stats` (dispatched by runJobs in src/commands/jobs.ts). */
import { hasFlag, parseFlag, type JobsCommandContext } from './shared.ts';
import { formatNice, getEffectiveNiceness } from '../../core/minions/niceness.ts';
import { deriveWedgeSignal } from '../../core/minions/queue.ts';

export async function runJobsStats({ args, engine, queue }: JobsCommandContext): Promise<void> {
  try { await queue.ensureSchema(); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

  const statsQueue = parseFlag(args, '--queue') ?? 'default';
  const stats = await queue.getStats({ queue: statsQueue });

  // Divergence detection: intake (created in window) vs USEFUL drain
  // (drained_completed — cancellations are outflow, not work; a naive
  // combined drain self-inflates while the TTL sweep shreds backlog).
  // Same env-threshold pattern as the wedge line below.
  const divergenceRatio = (() => {
    const raw = Number(process.env.GBRAIN_QUEUE_DIVERGENCE_RATIO ?? '');
    return Number.isFinite(raw) && raw > 0 ? raw : 2;
  })();
  const divergenceMinWaiting = (() => {
    const raw = parseInt(process.env.GBRAIN_QUEUE_DIVERGENCE_MIN_WAITING ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 50;
  })();
  const divergent = stats.by_type.filter(t =>
    t.waiting_now > divergenceMinWaiting &&
    t.total > divergenceRatio * Math.max(t.drained_completed, 1));

  // Waiting-TTL cancellations in the window (admission sweep visibility —
  // derived from the reason prefix cancelJobs writes; no extra storage).
  let ttlCancelled: Array<{ name: string; count: number }> = [];
  try {
    const { TTL_REASON_PREFIX } = await import('../../core/minions/admission.ts');
    const ttlRows = await engine.executeRaw<{ name: string; count: string }>(
      `SELECT name, count(*)::text AS count FROM minion_jobs
            WHERE status = 'cancelled' AND error_text LIKE $1
              AND finished_at > now() - interval '24 hours'
            GROUP BY name ORDER BY count(*) DESC`,
      [`${TTL_REASON_PREFIX}%`],
    );
    ttlCancelled = ttlRows.map(r => ({ name: r.name, count: parseInt(r.count, 10) }));
  } catch { /* best-effort */ }
  // Job names originate from the MCP-exposed submit surface — strip
  // control/ANSI bytes + cap before echoing into the terminal screams
  // (same hygiene as frontmatter-derived type names). Names embedded in
  // COPY-PASTEABLE command hints get the stricter safeConfigSegment gate:
  // display-sanitize keeps shell metacharacters.
  const { sanitizeTypeForDisplay: sanitizeName } = await import('../../core/schema-pack/type-usage.ts');
  const { safeConfigSegment } = await import('../../core/minions/admission.ts');

  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify({
      queue: statsQueue,
      ...stats,
      divergent: divergent.map(t => ({
        name: t.name,
        intake_24h: t.total,
        drained_completed_24h: t.drained_completed,
        waiting_now: t.waiting_now,
        oldest_waiting_minutes: t.oldest_waiting_minutes,
      })),
      ttl_cancelled_24h: ttlCancelled,
    }, null, 2));
    return;
  }

  console.log('Job Stats (last 24h):');
  if (stats.by_type.length > 0) {
    console.log(`  ${'Type'.padEnd(14)} ${'Total'.padEnd(7)} ${'Done'.padEnd(7)} ${'Failed'.padEnd(8)} ${'Dead'.padEnd(6)} ${'Drained'.padEnd(9)} ${'Waiting'.padEnd(9)} Avg Time`);
    for (const t of stats.by_type) {
      const avgTime = t.avg_duration_ms != null ? `${(t.avg_duration_ms / 1000).toFixed(1)}s` : '—';
      // Drained = terminal outflow in-window, completed-first with the
      // rest bracketed so TTL-cancel storms can't masquerade as work.
      const drained = `${t.drained_completed}${(t.drained_failed + t.drained_dead + t.drained_cancelled) > 0 ? `(+${t.drained_failed + t.drained_dead + t.drained_cancelled})` : ''}`;
      console.log(`  ${sanitizeName(t.name).padEnd(14)} ${String(t.total).padEnd(7)} ${String(t.completed).padEnd(7)} ${String(t.failed).padEnd(8)} ${String(t.dead).padEnd(6)} ${drained.padEnd(9)} ${String(t.waiting_now).padEnd(9)} ${avgTime}`);
    }
    console.log(`  (Drained = completed in-window, +N = failed/dead/cancelled outflow; Waiting = now, all queues)`);
  } else {
    console.log('  No jobs in the last 24 hours.');
  }
  console.log(`\n  Queue health: ${stats.queue_health.waiting} waiting, ${stats.queue_health.active} active, ${stats.queue_health.stalled} stalled`);

  // DIVERGENT-queue scream: intake structurally exceeds useful drain and a
  // real backlog is sitting there. This is the default-on protection layer
  // (quota ships config-only), so it must carry the opt-in hint.
  for (const t of divergent) {
    const perDay = t.drained_completed; // window is 24h
    const etaDays = perDay > 0 ? Math.round(t.waiting_now / perDay) : null;
    const eta = etaDays != null ? `~${etaDays}d backlog at current drain` : 'backlog never drains at current rate';
    const ttl = ttlCancelled.find(c => c.name === t.name);
    const ttlNote = ttl ? ` Waiting-TTL is cancelling ~${ttl.count}/day of it.` : '';
    console.log(
      `\n  ⚠  DIVERGENT QUEUE type '${sanitizeName(t.name)}': intake ${t.total}/24h vs ${t.drained_completed} completed/24h, ` +
      `${t.waiting_now} waiting (${eta}).${ttlNote}\n` +
      `     Reduce intake, raise drain, or cap admission:\n` +
      `       gbrain config set minions.quota_max_waiting.${safeConfigSegment(t.name) ?? '<job-name>'} <n>`,
    );
  }
  if (ttlCancelled.length > 0) {
    const parts = ttlCancelled.map(c => `${sanitizeName(c.name)}: ${c.count}`).join(', ');
    console.log(
      `\n  ⚠  Waiting-TTL cancelled ${ttlCancelled.reduce((a, c) => a + c.count, 0)} job(s) in the last 24h (${parts}).\n` +
      `     These waited past their TTL without ever being claimed. Tune:\n` +
      `       gbrain config set minions.ttl_waiting_hours.<name> <hours|0>`,
    );
  }

  // Scheduling priority (niceness, issue #1815). Best-effort: measures live
  // workers from the registry + the supervisor (if running) — silently skips
  // when nothing is reniced/running, so default stats output stays clean.
  try {
    const { readWorkers } = await import('../../core/minions/worker-registry.ts');
    const { readSupervisorPid } = await import('../../core/minions/supervisor-pid.ts');
    const { DEFAULT_PID_FILE } = await import('../../core/minions/supervisor.ts');
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
    // Shared derivation (queue.ts deriveWedgeSignal) so this line, the
    // doctor wedged_queue check, and the get_job_stats op agree (#1801).
    const { wedged, wedge_threshold_minutes: wedgeMins, private_queue } = deriveWedgeSignal(w);
    // Parent-owned dream-inline queue: no shared worker can EVER claim it,
    // so the supervisor-restart advice below would be a dead end (the
    // incident bug class). Gate the ABANDONED line on the SAME classifier
    // recovery uses — a healthy mid-drain queue (active_healthy 0 in a
    // claim gap) classifies live and must not scream.
    const privateVerdict = private_queue && w.active_healthy === 0 && w.waiting > 0
      ? await queue.classifyPrivateQueueForRecovery(w.queue)
      : null;
    if (privateVerdict === 'orphan' || privateVerdict === 'unowned') {
      const since = mins === null ? 'no completions on record' : `${mins}m since last completion`;
      console.log(
        `\n  ⚠  ABANDONED PRIVATE QUEUE '${w.queue}': ${w.waiting} waiting, 0 active (live-lock), ${since}.\n` +
        `     This dream-inline queue is parent-owned; restarting a worker cannot consume it.\n` +
        (privateVerdict === 'orphan'
          ? `     Auto-recovery cancels it at the next worker spawn or dream-cycle start.`
          : `     Legacy unowned queue: preview \`gbrain dream retriage --help\` before manual cancellation.`),
      );
    } else if (wedged) {
      const since = mins === null ? 'no completions on record' : `${mins}m since last completion`;
      console.log(
        `\n  ⚠  WEDGED QUEUE '${w.queue}': ${w.waiting} waiting, 0 active (live-lock), ${since}.\n` +
        `     A worker may be alive but stuck (dead DB pool / stuck handler). Fix:\n` +
        `       gbrain jobs supervisor stop && gbrain jobs supervisor start   # rebuild a fresh pool\n` +
        `       gbrain jobs retry <id>                                        # for dead-lettered jobs`,
      );
    }

    // Backpressure visibility: maxPending suppression keeps `waiting` at 0
    // while a job is in flight, which silences the waiting>0 wedge line
    // above — the exact operator-confusion cost of the duplicate-cycle
    // incident. Surface the last 24h of coalesce events (per name, this
    // queue) from the backpressure audit JSONL, plus a hint naming the
    // in-flight job when a name shows suppression with zero waiting rows
    // and a stale live-lock active. Best-effort: unreadable audit files
    // simply omit the line.
    try {
      const { readRecentCoalesceCounts } = await import('../../core/minions/backpressure-audit.ts');
      const coalesceCounts = readRecentCoalesceCounts({ queue: statsQueue, windowMs: 24 * 3600_000 });
      if (coalesceCounts.size > 0) {
        // Sort once, reuse for the summary AND the hint slice — slicing
        // insertion order would let low-volume early-in-file names crowd
        // out the highest-volume (most likely wedged) ones the summary
        // line just highlighted.
        const sortedCoalesces = [...coalesceCounts.entries()]
          .sort((a, b) => b[1].count - a[1].count);
        const parts = sortedCoalesces.map(([name, s]) => `${name}: ${s.count}`);
        console.log(`\n  Backpressure (24h): submissions coalesced onto in-flight jobs — ${parts.join(', ')}`);
        // Hint loop is bounded: names come from the 24h audit window
        // (normally a handful), capped defensively — this is an
        // operator-invoked diagnostic, not a hot path. Each hint is
        // driven by the LATEST coalesce target for the name (the audit's
        // returned_job_id), scoped to that job's source — a name-wide
        // aggregate would let source A's waiting row mask source B's
        // wedge, or name A's job for B's coalesce (multi-source brains).
        const hints = sortedCoalesces.slice(0, 10);
        for (const [name, summary] of hints) {
          if (summary.last_returned_job_id == null) continue;
          // The target CTE re-checks name+queue: the audit dir is shared
          // across brains in one GBRAIN_HOME, so an id from another
          // brain's audit trail must fail the match here rather than
          // name an unrelated job as the suppressor.
          const rows = await engine.executeRaw<{ waiting: string; live_id: string | null; age_min: string | null }>(
            `WITH target AS (
                   SELECT id, started_at, status, lock_until,
                          COALESCE(data->>'sourceId', data->>'source_id') AS scope
                     FROM minion_jobs WHERE id = $3 AND name = $1 AND queue = $2
                 )
                 SELECT (SELECT count(*)::text FROM minion_jobs m, target t
                          WHERE m.name = $1 AND m.queue = $2 AND m.status = 'waiting'
                            AND COALESCE(m.data->>'sourceId', m.data->>'source_id') IS NOT DISTINCT FROM t.scope) AS waiting,
                        (SELECT id::text FROM target WHERE status = 'active' AND lock_until > now()) AS live_id,
                        (SELECT floor(EXTRACT(EPOCH FROM (now() - started_at)) / 60)::text FROM target
                          WHERE status = 'active' AND lock_until > now()) AS age_min`,
            [name, statsQueue, summary.last_returned_job_id],
          );
          const r = rows[0];
          const ageMin = r?.age_min != null ? parseInt(r.age_min, 10) : null;
          if (r && parseInt(r.waiting ?? '0', 10) === 0 && r.live_id != null && ageMin != null && ageMin > wedgeMins) {
            console.log(
              `     ${name}: dispatch suppressed by in-flight job #${r.live_id} (age ${ageMin}m) — check \`gbrain jobs get ${r.live_id}\``,
            );
          }
        }
      }
    } catch {
      // Audit read is advisory; never break stats.
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
      const { clusterErrors } = await import('../../core/minions/error-classify.ts');
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
}
