/**
 * Queue + jobs check cluster — verbatim peel from src/commands/doctor.ts (containment
 * sprint). No behavior change; doctor.ts re-exports every exported symbol
 * under its original name (tests and external callers import them from
 * doctor.ts) and buildChecks / doctorReportRemote consume them.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { resolveEnvNumber } from '../../../core/env-number.ts';
import type { Check } from '../../doctor.ts';

/** Local alias; the shared warn-once memo lives in core so it can't fork per module. */
const _resolveEnvNumber = resolveEnvNumber;

/**
 * v0.41.18.0 batch_retry_health doctor check (codex H-9 thresholds).
 *
 * Surfaces sustained Supavisor circuit-breaker incidents from the
 * engine-level batch retry wrap. Reads the last 24h of audit events from
 * `~/.gbrain/audit/batch-retry-YYYY-Www.jsonl`.
 *
 * Threshold ladder (codex H-9 — avoid permanent noise from one historical blip):
 *   ok    — zero exhausted events in 24h, OR <3 exhausted from a single site
 *   warn  — >=3 exhausted from same site in 24h, OR >=5 cross-site
 *   fail  — >=20 exhausted in 24h (sustained breaker; operator intervention)
 *
 * Also surfaces (codex H-9 corruption tolerance):
 *   - corrupted_lines count when audit JSONL has malformed rows
 *   - files_unreadable count for permission errors (NOT ENOENT which is normal)
 *
 * Also surfaces (codex M-10): runs resolveBulkRetryOpts(process.env) at
 * startup so bad GBRAIN_BULK_* config fails at doctor time, not first-retry.
 */
/**
 * queue_health: Postgres Minion queue diagnostics.
 *
 * Includes the original stalled/depth/memory/prompt checks plus the #2557
 * no-worker signal: old `embed-backfill` jobs waiting on a queue with no live
 * registered worker for that queue. That catches the default deployment shape
 * where `sync` enqueues deferred embedding work but the operator never started
 * `gbrain jobs work` or a supervisor.
 */
export async function computeQueueHealthCheck(
  engine: BrainEngine,
  opts: {
    waitingDepthThreshold?: number;
    oldWaitingHours?: number;
    readWorkers?: () => Array<{ queue: string }>;
  } = {},
): Promise<Check> {
  if (engine.kind === 'pglite') {
    return {
      name: 'queue_health',
      status: 'ok',
      message: 'Skipped (PGLite — no multi-process worker surface)',
    };
  }

  try {
    // issue #1801: column is `status`, not `state` (schema.sql:780).
    const stalledRows: Array<{ id: number; name: string; started_at: string }> =
      await engine.executeRaw(
        `SELECT id, name, started_at::text AS started_at
           FROM minion_jobs
          WHERE status = 'active'
            AND started_at IS NOT NULL
            AND started_at < now() - interval '1 hour'
          ORDER BY started_at ASC
          LIMIT 5`,
      );

    const threshold = opts.waitingDepthThreshold
      ?? _resolveEnvNumber('GBRAIN_QUEUE_WAITING_THRESHOLD', 10);
    const depthRows: Array<{ name: string; queue: string; depth: number }> =
      await engine.executeRaw(
        `SELECT name, queue, count(*)::int AS depth
           FROM minion_jobs
          WHERE status = 'waiting'
          GROUP BY name, queue
         HAVING count(*) > $1
          ORDER BY depth DESC
          LIMIT 5`,
        [threshold],
      );

    const rssKillRows: Array<{ cnt: number }> = await engine.executeRaw(
      `SELECT count(*)::int AS cnt
         FROM minion_jobs
        WHERE status IN ('dead', 'failed')
          AND finished_at > now() - interval '24 hours'
          AND error_text = 'aborted: watchdog'`,
    );
    const rssKillCount = Number(rssKillRows[0]?.cnt ?? 0);

    const promptTooLongRows: Array<{ cnt: number }> = await engine.executeRaw(
      `SELECT count(*)::int AS cnt
         FROM minion_jobs
        WHERE name = 'subagent'
          AND status = 'dead'
          AND finished_at > now() - interval '24 hours'
          AND error_text LIKE 'prompt_too_long:%'`,
    );
    const promptTooLongCount = Number(promptTooLongRows[0]?.cnt ?? 0);

    const oldWaitingHours = opts.oldWaitingHours
      ?? _resolveEnvNumber('GBRAIN_QUEUE_NO_WORKER_WARN_HOURS', 1);
    const oldWaitingRows: Array<{
      name: string;
      queue: string;
      depth: number;
      oldest_age_seconds: number;
    }> = await engine.executeRaw(
      `SELECT name,
              queue,
              count(*)::int AS depth,
              EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest_age_seconds
         FROM minion_jobs
        WHERE status = 'waiting'
          AND name = 'embed-backfill'
        GROUP BY name, queue
       HAVING min(created_at) < now() - ($1::text::interval)
        ORDER BY oldest_age_seconds DESC
        LIMIT 5`,
      [`${oldWaitingHours} hours`],
    );

    // Read the live-worker registry unconditionally (was: only when old
    // embed-backfill rows existed) — the structured `details.worker_alive`
    // below needs it on every run. Cheap: one directory enumeration.
    const workers = opts.readWorkers
      ? opts.readWorkers()
      : (await import('../../../core/minions/worker-registry.ts')).readWorkers();
    const liveWorkerQueues = new Set(workers.map((w) => w.queue));

    // Minions-visibility wave: structured details so machine callers stop
    // parsing prose. depth = total waiting jobs; oldest_age_seconds = age of
    // the oldest waiting job (null when the queue is empty); worker_alive =
    // every queue holding waiting work has a live registered worker
    // (vacuously true with zero waiting jobs). Messages stay unchanged.
    // Perf note (twin of buildQueueDepths in status.ts): WHERE constrains
    // only `status` — the second column of the (queue, status, updated_at)
    // wedge index — so this GROUP BY full-scans minion_jobs today. Acceptable
    // at doctor frequency over pruned waiting sets; a partial
    // (queue, created_at) WHERE status='waiting' index is the fix if hot.
    const waitingByQueue: Array<{
      queue: string;
      depth: number | string;
      oldest_age_seconds: number | string | null;
    }> = await engine.executeRaw(
      `SELECT queue,
              count(*)::int AS depth,
              EXTRACT(EPOCH FROM (now() - min(created_at)))::int AS oldest_age_seconds
         FROM minion_jobs
        WHERE status = 'waiting'
        GROUP BY queue`,
    );
    const details: Record<string, unknown> = {
      depth: waitingByQueue.reduce((n, r) => n + Number(r.depth), 0),
      oldest_age_seconds: waitingByQueue.reduce<number | null>(
        (max, r) => {
          const age = r.oldest_age_seconds === null ? null : Number(r.oldest_age_seconds);
          if (age === null) return max;
          return max === null ? age : Math.max(max, age);
        },
        null,
      ),
      worker_alive: waitingByQueue.every((r) => liveWorkerQueues.has(r.queue)),
    };

    const problems: string[] = [];
    if (stalledRows.length > 0) {
      const sample = stalledRows
        .map(r => `#${r.id}(${r.name})`)
        .join(', ');
      problems.push(
        `${stalledRows.length} stalled-forever job(s): ${sample}. ` +
        `Fix: gbrain jobs get <id> to inspect; gbrain jobs cancel <id> to force-kill.`
      );
    }
    if (depthRows.length > 0) {
      const sample = depthRows
        .map(r => `${r.name}@${r.queue}=${r.depth}`)
        .join(', ');
      problems.push(
        `waiting-queue depth exceeds ${threshold} for: ${sample}. ` +
        `Fix: set maxWaiting on the submitter (or raise GBRAIN_QUEUE_WAITING_THRESHOLD).`
      );
    }
    for (const row of oldWaitingRows) {
      if (liveWorkerQueues.has(row.queue)) continue;
      const hours = Math.max(1, Math.round(Number(row.oldest_age_seconds ?? 0) / 3600));
      problems.push(
        `${row.depth} ${row.name} job(s) have waited on queue '${row.queue}' for up to ${hours}h ` +
        `and no live worker is registered for that queue. ` +
        `Start one with \`gbrain jobs work --queue ${row.queue}\` or ` +
        `\`gbrain jobs supervisor start --queue ${row.queue}\`.`
      );
    }
    if (rssKillCount > 0) {
      problems.push(
        `${rssKillCount} job(s) dead-lettered for RSS-watchdog memory-limit kills in last 24h. ` +
        `Fix: raise the limit (e.g. \`gbrain jobs work --max-rss 4096\`) or opt out (\`--max-rss 0\`). ` +
        `→ see worker_oom_loop for the cap + fix (the authoritative OOM-loop signal).`
      );
    }
    // Queue divergence: per-type intake structurally exceeds useful drain
    // (completions keyed on finished_at) while a real backlog waits. Same
    // env thresholds as the `jobs stats` DIVERGENT scream so the two
    // advisory surfaces agree. Cancellations (incl. the waiting-TTL sweep)
    // are deliberately NOT counted as drain — outflow is not work.
    try {
      const { TTL_REASON_PREFIX, safeConfigSegment } = await import('../../../core/minions/admission.ts');
      const { sanitizeTypeForDisplay } = await import('../../../core/schema-pack/type-usage.ts');
      const divergenceRatio = resolveEnvNumber('GBRAIN_QUEUE_DIVERGENCE_RATIO', 2);
      const divergenceMinWaiting = resolveEnvNumber('GBRAIN_QUEUE_DIVERGENCE_MIN_WAITING', 50);
      const divRows = await engine.executeRaw<{ name: string; intake: string; completed: string; waiting: string }>(
        `SELECT w.name,
                COALESCE(i.intake, '0') AS intake,
                COALESCE(c.completed, '0') AS completed,
                w.waiting
           FROM (SELECT name, count(*)::text AS waiting FROM minion_jobs
                  WHERE status = 'waiting' GROUP BY name) w
           LEFT JOIN (SELECT name, count(*)::text AS intake FROM minion_jobs
                  WHERE created_at > now() - interval '24 hours' GROUP BY name) i ON i.name = w.name
           LEFT JOIN (SELECT name, count(*)::text AS completed FROM minion_jobs
                  WHERE finished_at > now() - interval '24 hours' AND status = 'completed'
                  GROUP BY name) c ON c.name = w.name`,
      );
      for (const r of divRows) {
        const waiting = parseInt(r.waiting, 10);
        const intake = parseInt(r.intake, 10);
        const completed = parseInt(r.completed, 10);
        if (waiting > divergenceMinWaiting && intake > divergenceRatio * Math.max(completed, 1)) {
          // Job names originate from the MCP-exposed submit surface —
          // sanitize for display; strict-gate names embedded in the
          // copy-pasteable config hint.
          problems.push(
            `DIVERGENT queue type '${sanitizeTypeForDisplay(r.name)}': intake ${intake}/24h vs ${completed} completed/24h, ` +
            `${waiting} waiting — the backlog grows structurally. Reduce intake, raise drain, or cap ` +
            `admission: \`gbrain config set minions.quota_max_waiting.${safeConfigSegment(r.name) ?? '<job-name>'} <n>\`. See \`gbrain jobs stats\`.`
          );
        }
      }
      // Waiting-TTL cancellations mean the divergence is being SHREDDED, not
      // worked — that's operating as designed but the operator must know.
      const ttlRows = await engine.executeRaw<{ name: string; count: string }>(
        `SELECT name, count(*)::text AS count FROM minion_jobs
          WHERE status = 'cancelled' AND error_text LIKE $1
            AND finished_at > now() - interval '24 hours'
          GROUP BY name`,
        [`${TTL_REASON_PREFIX}%`],
      );
      for (const r of ttlRows) {
        problems.push(
          `waiting-TTL cancelled ${r.count} '${sanitizeTypeForDisplay(r.name)}' job(s) in the last 24h (queued work expired ` +
          `unclaimed — intake still exceeds drain). Tune: \`gbrain config set ` +
          `minions.ttl_waiting_hours.${safeConfigSegment(r.name) ?? '<job-name>'} <hours|0>\`.`
        );
      }
    } catch { /* best-effort — divergence probes never break doctor */ }
    if (promptTooLongCount > 0) {
      problems.push(
        `${promptTooLongCount} subagent job(s) dead-lettered with prompt_too_long in last 24h. ` +
        `Dream/synthesize transcripts exceeded the model's input context. ` +
        `Fix: \`gbrain dream --phase synthesize --dry-run --json\` to identify fat transcripts; ` +
        `set \`dream.synthesize.max_prompt_tokens\` to bound the per-chunk budget, or use a ` +
        `larger-context model (Opus 4.7 = 1M tokens vs Sonnet 4.6 = 200K).`
      );
    }

    if (problems.length === 0) {
      return {
        name: 'queue_health',
        status: 'ok',
        message: `No stalled-forever jobs; no queue over depth ${threshold}; no old embed-backfill jobs without a worker.`,
        details,
      };
    }
    return {
      name: 'queue_health',
      status: 'warn',
      message: problems.join(' '),
      details,
    };
  } catch (e) {
    return {
      name: 'queue_health',
      status: 'warn',
      message: `queue_health scan skipped: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * issue #1801 — `wedged_queue` check. Surfaces the alive-but-wedged-worker
 * signature (a queue with claimable work waiting, zero live-lock active jobs,
 * and stale completions) as a health ERROR, so an operator / the daily doctor
 * catches a silent processing halt in minutes, not 15 hours.
 *
 * Postgres-only (PGLite has no multi-process worker surface). Grouped BY queue
 * (Codex #15) so a healthy worker on one queue can't mask a wedged one.
 * `active_healthy` counts only live-lock active rows, so an expired-lock active
 * row (a worker that died mid-job) does NOT mask the wedge (Codex #6). The
 * check is conservative for the advisory surface: it fails only on stale-after-
 * progress (mins_since_completion > threshold, non-null); a queue that never
 * completed anything is left to the supervisor's startup-grace-aware watchdog
 * to avoid crying wolf on a freshly-submitted queue with no worker yet.
 *
 * Exported so `test/doctor.test.ts` drives it directly. Reads
 * GBRAIN_WEDGED_QUEUE_WARN_MINUTES (default 15).
 */
export async function computeWedgedQueueCheck(
  engine: BrainEngine,
  opts: { readWorkers?: () => Array<{ queue: string }> } = {},
): Promise<Check> {
  if (engine.kind !== 'postgres') {
    return { name: 'wedged_queue', status: 'ok', message: 'PGLite — no queue to check' };
  }
  const thresholdMin = _resolveEnvNumber('GBRAIN_WEDGED_QUEUE_WARN_MINUTES', 15);
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
    // #3063: "worker alive but not claiming work" would be a false claim
    // for a queue no worker process was ever subscribed to. Split the
    // wedged set by whether a registered live worker actually exists for
    // that queue (getLiveWorkers() self-cleans dead entries), so the
    // advisory repair matches the real fault instead of misdirecting the
    // operator toward restarting a worker that was never there — a queue
    // with no worker needs `start`, not `stop && start`.
    let liveWorkers: Array<{ queue: string }> = [];
    let registryReadable = true;
    try {
      // Lazy import mirrors computeQueueHealthCheck's own registry access
      // above — the registry module stays off this file's eager import
      // graph and only loads once a wedge actually needs the signal.
      const getLiveWorkers = opts.readWorkers
        ?? (await import('../../../core/minions/worker-registry.ts')).readWorkers;
      liveWorkers = getLiveWorkers();
    } catch {
      // A registry read error must not turn this check green (the queue is
      // demonstrably wedged) — but it also must not fabricate a liveness
      // verdict either way. Fall through to the liveness-unknown wording.
      registryReadable = false;
    }
    if (!registryReadable) {
      return {
        name: 'wedged_queue',
        status: 'fail',
        message:
          `Wedged queue(s) — worker registry unreadable, worker liveness unknown: ` +
          `${wedged.map((w) => w.label).join('; ')}. ` +
          `If a worker is running for the queue, restart it: ` +
          '`gbrain jobs supervisor stop && gbrain jobs supervisor start [--queue <name>]`; ' +
          'if none is, start one: `gbrain jobs supervisor start --queue <name> --detach`.',
        details: {
          wedged_queues: wedged.length,
          worker_registry_unreadable: true,
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

/**
 * Private dream queues are owned by one parent cycle and are intentionally not
 * consumed by the default worker. If that parent disappears, restarting the
 * supervisor cannot help; the queue needs reconciliation instead. Keep this
 * diagnosis separate from wedged_queue so Doctor gives the right repair.
 *
 * Liveness model (#4250, mirrors dream-retriage's CX1 rules so the check and
 * its advertised repair agree):
 *   - Live cycle locks are the REAL running-cycle signal (queue age alone
 *     false-positives on a live parent between child claims). Bare
 *     `gbrain-cycle` is the legacy global lock; `gbrain-cycle:<source>` is
 *     per-source.
 *   - Lock existence is NOT queue ownership: a queue whose birth (the
 *     `dream-inline-<ms>-<uuid8>` name timestamp, else min(created_at) as a
 *     conservative fallback) predates the live lock's acquired_at cannot
 *     belong to that holder — an older crashed cycle's orphan stays visible
 *     even while a new cycle runs.
 *   - Waiting-class = waiting|delayed — exactly the statuses retriage's
 *     conversion path repairs. `paused` rows are surfaced in details only
 *     (flagging them would fail doctor with no advertised fix).
 */
export async function computeOrphanedPrivateQueueCheck(engine: BrainEngine): Promise<Check> {
  // Runs on BOTH engines: PGLite mints the same dream-inline-* queues (every
  // child is inlined precisely because no separate worker can run), and the
  // grouped SQL below is plain Postgres that PGLite executes unchanged. The
  // old PGLite short-circuit hid exactly the brains with the fewest recovery
  // lanes.
  const thresholdMin = _resolveEnvNumber('GBRAIN_ORPHANED_PRIVATE_QUEUE_MINUTES', 60);
  try {
    const { dreamInlineQueueAgeMs } = await import('../../../core/cycle/synthesize.ts');
    const { resolveStealGraceSeconds } = await import('../../../core/db-lock.ts');
    const { LOCK_TTL_MINUTES } = await import('../../../core/cycle.ts');
    const rows = await engine.executeRaw<{
      queue: string;
      source_id: string | null;
      active_healthy: string | number;
      waiting: string | number;
      paused: string | number;
      oldest_waiting_minutes: string | number | null;
      birth_epoch_ms: string | number | null;
    }>(
      `SELECT queue,
         min(data->>'source_id') AS source_id,
         count(*) FILTER (WHERE status = 'active' AND lock_until > now()) AS active_healthy,
         count(*) FILTER (WHERE status IN ('waiting','delayed')) AS waiting,
         count(*) FILTER (WHERE status = 'paused') AS paused,
         EXTRACT(EPOCH FROM (now() - min(created_at) FILTER (WHERE status IN ('waiting','delayed')))) / 60
           AS oldest_waiting_minutes,
         EXTRACT(EPOCH FROM min(created_at)) * 1000 AS birth_epoch_ms
       FROM minion_jobs
       WHERE queue LIKE 'dream-inline-%'
       GROUP BY queue`,
    );
    // Live cycle locks with their acquisition time, for ownership correlation.
    // Liveness matches db-lock's own model: an unexpired TTL, OR a lapsed TTL
    // whose holder refreshed within the steal grace (starved-but-alive —
    // exactly the holder the steal path refuses to kill; treating it as dead
    // here would point operators at cancelling a still-draining cycle's queue).
    const stealGraceSecs = resolveStealGraceSeconds(LOCK_TTL_MINUTES);
    const locks = await engine.executeRaw<{ id: string; acquired_epoch_ms: string | number }>(
      `SELECT id, EXTRACT(EPOCH FROM acquired_at) * 1000 AS acquired_epoch_ms
         FROM gbrain_cycle_locks
        WHERE (ttl_expires_at > NOW()
               OR last_refreshed_at > NOW() - make_interval(secs => ${Number(stealGraceSecs)}))
          AND id LIKE 'gbrain-cycle%'`,
    );
    const globalLockAcquiredMs = locks
      .filter(l => l.id === 'gbrain-cycle')
      .map(l => Number(l.acquired_epoch_ms))[0];
    const sourceLockAcquiredMs = new Map<string, number>(
      locks
        .filter(l => l.id.startsWith('gbrain-cycle:'))
        .map(l => [l.id.slice('gbrain-cycle:'.length), Number(l.acquired_epoch_ms)]),
    );
    const nowMs = Date.now();
    const orphaned: string[] = [];
    const candidateQueues: string[] = [];
    // Per-candidate waiting counts, index-aligned with candidateQueues:
    // waiting_jobs must count FLAGGED queues only — summing during the scan
    // would include live-lease-suppressed and cap-truncated queues that
    // orphaned_private_queues excludes.
    const candidateWaiting: number[] = [];
    let pausedTotal = 0;
    let suppressedByLiveLock = 0;
    for (const r of rows) {
      pausedTotal += Number(r.paused ?? 0);
      const activeHealthy = Number(r.active_healthy ?? 0);
      const waiting = Number(r.waiting ?? 0);
      const age = r.oldest_waiting_minutes === null ? null : Number(r.oldest_waiting_minutes);
      if (activeHealthy !== 0 || waiting === 0 || age === null || age <= thresholdMin) continue;
      // Queue birth: prefer the name-embedded timestamp; fall back to the
      // oldest job row. The fallback can only OVERSTATE birth (rows are
      // created at/after queue creation), which biases toward suppression —
      // the fail-safe direction.
      const nameAgeMs = dreamInlineQueueAgeMs(r.queue, nowMs);
      const birthMs = nameAgeMs !== null
        ? nowMs - nameAgeMs
        : (r.birth_epoch_ms === null ? null : Number(r.birth_epoch_ms));
      // A live lock suppresses the queue only if it could OWN it: the queue
      // was born at/after the lock was acquired. SKEW_TOLERANCE_MS absorbs
      // host-clock (queue-name Date.now) vs DB-clock (acquired_at NOW())
      // drift — the maintenance lane mints its queue seconds after lock
      // acquisition, so seconds of skew must not flip a live cycle's own
      // queue into "born before the lock". Unknown birth = possibly owned
      // (fail-safe suppress).
      const SKEW_TOLERANCE_MS = 60_000;
      const candidateLockAcquisitions = [
        ...(globalLockAcquiredMs !== undefined ? [globalLockAcquiredMs] : []),
        ...(r.source_id !== null && sourceLockAcquiredMs.has(r.source_id)
          ? [sourceLockAcquiredMs.get(r.source_id)!]
          : []),
      ];
      const possiblyOwnedByLiveCycle = candidateLockAcquisitions.some(
        acquiredMs => birthMs === null || !Number.isFinite(acquiredMs) || birthMs >= acquiredMs - SKEW_TOLERANCE_MS,
      );
      if (possiblyOwnedByLiveCycle) {
        suppressedByLiveLock++;
        continue;
      }
      orphaned.push(`'${r.queue}' (${waiting} waiting, oldest ${Math.round(age)}m)`);
      candidateQueues.push(r.queue);
      candidateWaiting.push(waiting);
    }
    // Bucket the survivors through the SAME classifier recovery uses, so the
    // advertised remediation and recovery's actual behavior cannot drift:
    //   live      → owner lease/lock still healthy — suppress (not an orphan);
    //   orphan    → metadata-backed: auto-recovery cancels it at the next
    //               worker spawn or cycle start;
    //   unowned   → legacy pre-metadata rows: retriage preview is the tool;
    //   not_orphan→ owner job non-terminal — inspect the owner, don't cancel.
    const { MinionQueue } = await import('../../../core/minions/queue.ts');
    const classifierQueue = new MinionQueue(engine);
    let suppressedByLiveLease = 0;
    const recoverable: string[] = [];
    const legacyUnowned: string[] = [];
    const ownerPending: string[] = [];
    // One classify query per candidate — cap the loop so a pathological brain
    // (hundreds of stale queues) can't turn an advisory doctor check into a
    // hang; the count line below reports the truncation honestly.
    const CLASSIFY_CAP = 100;
    const truncatedCandidates = Math.max(0, candidateQueues.length - CLASSIFY_CAP);
    candidateQueues.length = Math.min(candidateQueues.length, CLASSIFY_CAP);
    let flaggedWaiting = 0;
    for (let i = 0; i < candidateQueues.length; i++) {
      const verdict = await classifierQueue.classifyPrivateQueueForRecovery(candidateQueues[i]);
      if (verdict === 'live') { suppressedByLiveLease++; continue; }
      if (verdict === 'orphan') recoverable.push(orphaned[i]);
      else if (verdict === 'unowned') legacyUnowned.push(orphaned[i]);
      else ownerPending.push(orphaned[i]);
      flaggedWaiting += candidateWaiting[i];
    }
    const flagged = recoverable.length + legacyUnowned.length + ownerPending.length;
    if (flagged === 0) {
      const suppressed = suppressedByLiveLock + suppressedByLiveLease;
      return {
        name: 'orphaned_private_queue',
        status: 'ok',
        // Truncation must stay visible on the ok path too: 100 live + 50
        // never-classified candidates is NOT a clean bill of health.
        message: suppressed > 0 || truncatedCandidates > 0
          ? `No provably-orphaned private queues (${suppressed} possibly owned by a live cycle` +
            (truncatedCandidates > 0 ? `, ${truncatedCandidates} unclassified — re-run doctor to page through them` : '') + `)`
          : 'No orphaned private queues',
        ...(pausedTotal > 0 || suppressed > 0 || truncatedCandidates > 0
          ? { details: {
              paused_jobs: pausedTotal,
              suppressed_by_live_lock: suppressedByLiveLock,
              suppressed_by_live_lease: suppressedByLiveLease,
              ...(truncatedCandidates > 0 ? { unclassified_candidates: truncatedCandidates } : {}),
            } }
          : {}),
      };
    }
    const remediation: string[] = [];
    if (recoverable.length > 0) {
      remediation.push(
        `Auto-recovery cancels the metadata-backed queue(s) at the next worker spawn or dream-cycle start` +
        (engine.kind === 'postgres'
          ? ` (trigger now: \`gbrain jobs supervisor start\`)`
          : ` (trigger now: \`gbrain dream\`)`) + `.`,
      );
    }
    if (legacyUnowned.length > 0) {
      remediation.push(
        `Legacy unowned queue(s) need manual retriage: preview with \`gbrain dream retriage --help\` ` +
        `and apply cancellation only after reviewing that dry run.`,
      );
    }
    if (ownerPending.length > 0) {
      remediation.push(
        `Owner-pending queue(s) have a NON-terminal owner job — inspect it with \`gbrain jobs get <owner id>\` before cancelling anything.`,
      );
    }
    return {
      name: 'orphaned_private_queue',
      status: 'fail',
      message:
        `Orphaned private dream queue(s): ${[...recoverable, ...legacyUnowned, ...ownerPending].join('; ')}. ` +
        `A supervisor restart cannot consume these parent-owned queues. ${remediation.join(' ')}`,
      details: {
        orphaned_private_queues: flagged,
        recoverable_queues: recoverable.length,
        legacy_unowned_queues: legacyUnowned.length,
        owner_pending_queues: ownerPending.length,
        waiting_jobs: flaggedWaiting,
        paused_jobs: pausedTotal,
        suppressed_by_live_lock: suppressedByLiveLock,
        suppressed_by_live_lease: suppressedByLiveLease,
        threshold_minutes: thresholdMin,
        ...(truncatedCandidates > 0 ? { unclassified_candidates: truncatedCandidates } : {}),
      },
    };
  } catch (e) {
    // Warn, never ok: a permanently-broken check must not read as
    // permanently healthy (the fail-open would hide every future orphan).
    return {
      name: 'orphaned_private_queue',
      status: 'warn',
      message: `Check could not run (${e instanceof Error ? e.message : String(e)}) — orphan detection is NOT covered this run`,
    };
  }
}

/**
 * #2194 fix #5: warn when autopilot's per-tick fan-out exceeds the worker's
 * effective concurrency. Fanning out more cycles than there are worker slots
 * guarantees waiters that race the stalled-sweeper — a silent misconfig today.
 * Advisory (started-event concurrency is fine here; the behavior-changing clamp
 * in resolveEffectiveFanoutMax is the one that gates on liveness). Surfaces only
 * when a supervisor has actually started (no noise on never-supervised brains).
 */
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

export async function checkBatchRetryHealth(_engine: BrainEngine): Promise<Check> {
  try {
    // Codex M-10: surface bad env config at doctor time.
    try {
      const { resolveBulkRetryOpts } = await import('../../../core/retry.ts');
      resolveBulkRetryOpts();
    } catch (e) {
      return {
        name: 'batch_retry_health',
        status: 'warn',
        message: `GBRAIN_BULK_* env override invalid: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const { readRecentBatchRetryEvents } = await import('../../../core/audit/batch-retry-audit.ts');
    const result = readRecentBatchRetryEvents(24);

    // Surface corruption / permission errors at warn so operators investigate.
    if (result.files_unreadable > 0) {
      return {
        name: 'batch_retry_health',
        status: 'warn',
        message: `${result.files_unreadable} audit file(s) unreadable (permission / IO). Fix: check ~/.gbrain/audit/ (or $GBRAIN_AUDIT_DIR if set).`,
      };
    }

    const exhausted = result.events.filter((e) => e.outcome === 'exhausted');
    const successful = result.events.filter((e) => e.outcome === 'success');

    // v0.41.25.0 (#1570) — read the db-disconnect audit so the existing
    // batch_retry_health check surfaces ALL connection-incident signal in
    // one place (per codex finding 11: extend, don't add a new check).
    // Disconnect events are informational — every CLI command legitimately
    // disconnects at end-of-life. The value is the most_recent_caller
    // frame: when the v0.41.25 retry reconnect callback fires, the
    // operator runs `gbrain doctor` and the stack trace tells them which
    // code path triggered the mid-process disconnect. v0.41.26 fixes
    // that specific ownership boundary.
    let disconnectNote = '';
    try {
      const { readRecentDbDisconnects } = await import('../../../core/audit/db-disconnect-audit.ts');
      const dc = readRecentDbDisconnects(24);
      if (dc.count > 0) {
        // First-line of stack trace is the caller of logDbDisconnect; show
        // it so the operator sees something compact in human output.
        const firstFrame = (dc.most_recent_caller ?? '').split('\n')[0]?.trim() ?? '';
        const frameSlug = firstFrame.length > 0 ? ` (most recent caller: ${firstFrame.slice(0, 200)})` : '';
        disconnectNote = ` Disconnect-call audit: ${dc.count} call(s) in 24h${frameSlug}.`;
      }
    } catch { /* audit module unavailable; older brain, fine */ }

    if (exhausted.length === 0) {
      const note = result.corrupted_lines > 0
        ? ` (note: ${result.corrupted_lines} corrupt JSONL line(s) skipped)`
        : '';
      const recoveredNote = successful.length > 0
        ? ` ${successful.length} transient retry(s) succeeded.`
        : '';
      return {
        name: 'batch_retry_health',
        status: 'ok',
        message: `No exhausted batch retries in last 24h.${recoveredNote}${note}${disconnectNote}`,
      };
    }

    // Group exhausted events by site for per-site threshold detection.
    const bySite = new Map<string, number>();
    for (const e of exhausted) bySite.set(e.site, (bySite.get(e.site) ?? 0) + 1);
    const worstSite = [...bySite.entries()].sort((a, b) => b[1] - a[1])[0];

    // codex H-9 fail threshold: >=20 in 24h = sustained breaker.
    if (exhausted.length >= 20) {
      return {
        name: 'batch_retry_health',
        status: 'fail',
        message: `${exhausted.length} exhausted batch retries in last 24h (worst: ${worstSite[0]} = ${worstSite[1]}). Sustained circuit-breaker incident. Fix: check pooler status; consider raising GBRAIN_BULK_MAX_RETRIES or moving to direct-connection.${disconnectNote}`,
      };
    }

    // warn thresholds: >=3 same-site OR >=5 cross-site.
    if (worstSite[1] >= 3 || exhausted.length >= 5) {
      return {
        name: 'batch_retry_health',
        status: 'warn',
        message: `${exhausted.length} exhausted batch retries in last 24h (worst: ${worstSite[0]} = ${worstSite[1]}). Tune via GBRAIN_BULK_MAX_RETRIES / GBRAIN_BULK_RETRY_MAX_MS.${disconnectNote}`,
      };
    }

    // Single-incident noise tolerance.
    return {
      name: 'batch_retry_health',
      status: 'ok',
      message: `${exhausted.length} exhausted batch retry(s) in last 24h (below per-site threshold of 3)${disconnectNote}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'batch_retry_health',
      status: 'warn',
      message: `Could not check batch_retry audit: ${msg}`,
    };
  }
}
