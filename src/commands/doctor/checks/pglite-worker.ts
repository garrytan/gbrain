/**
 * PGLite / worker / pool check cluster — verbatim peel from src/commands/doctor.ts (containment
 * sprint). No behavior change; doctor.ts re-exports every exported symbol
 * under its original name (tests and external callers import them from
 * doctor.ts) and buildChecks / doctorReportRemote consume them.
 */
import * as db from '../../../core/db.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';

// ≥2 failed repair attempts inside 7 days = the corruption keeps regenerating.
const REPAIR_RECURRENCE_WINDOW_MS = 7 * 24 * 3600 * 1000;
const REPAIR_RECURRENCE_THRESHOLD = 2;

/**
 * WAL-repair wave (#223/#1670/#2575): when the DB failed to connect on a
 * PGLite brain, diagnose the data dir from the FILESYSTEM (the connect error
 * itself was swallowed by doctor's fs-only fallback — this check re-derives
 * the state from disk). Pure: interprets an `inspectPgliteDataDir` diagnosis
 * into a Check; exported so `test/doctor-pglite-datadir.test.ts` drives it
 * directly (same convention as computeWorkerOomLoopCheck). Returns a Check
 * always — the call site only runs it when connect already failed, so even a
 * healthy-looking dir warrants a pointer at the repair tooling.
 *
 * Recurrence escalation (eng-review 2A): repeated failed repair attempts on
 * record mean the corruption keeps regenerating (unclean-shutdown genesis) —
 * escalate to the engine-switch ladder instead of letting the brain silently
 * lose a WAL tail per cycle. Backup-dir inventory rides along (same
 * disk-visibility class as orphan_clones).
 */
export function computePgliteDataDirCheck(
  dataDir: string,
  diagnosis: import('../../../core/pglite-repair.ts').PgliteDirDiagnosis,
): Check {
  const backupNote = diagnosis.backupDirs.length > 0
    ? ` ${diagnosis.backupDirs.length} repair backup dir(s) on disk (newest: ${diagnosis.backupDirs[0]}) — delete old ones to reclaim space once the brain is healthy.`
    : '';
  // Count BOTH outcomes (adversarial review F12): a >1h-period crash loop where
  // each repair "succeeds" discards a WAL tail per cycle with zero FAILED
  // attempts on record — escalation must still fire.
  const recentAttempts = diagnosis.recentAttempts.filter(
    (a) => Date.now() - a.ts < REPAIR_RECURRENCE_WINDOW_MS,
  ).length;
  const recurrence = recentAttempts >= REPAIR_RECURRENCE_THRESHOLD
    ? ` Auto-repair has run ${recentAttempts}x this week — the corruption keeps regenerating (likely an unclean-shutdown loop). Consider switching engines (docs/ENGINES.md: \`gbrain init --supabase\` or native Postgres).`
    : '';

  switch (diagnosis.verdict) {
    case 'locked':
      return {
        name: 'pglite_data_dir',
        status: 'warn',
        message:
          `Could not connect, and the PGLite data-dir lock is held by live PID ${diagnosis.lockHolderPid} — ` +
          `another gbrain process (often \`gbrain serve\`) has the brain open. Stop it and re-run.${backupNote}`,
        remediation_status: 'human_only',
      };
    case 'missing':
      return {
        name: 'pglite_data_dir',
        status: 'warn',
        message: `No PGLite data dir at ${dataDir}. Run \`gbrain init --pglite\` to create one.`,
        remediation_status: 'human_only',
      };
    case 'unsupported-layout':
      return {
        name: 'pglite_data_dir',
        status: 'fail',
        message:
          `PGLite data dir at ${dataDir} is not repairable in place (${diagnosis.detail}). ` +
          `Rebuild from your brain repo: \`gbrain reinit-pglite\` (or back up ~/.gbrain, move the dir aside, ` +
          `\`gbrain init --pglite\`, re-add sources + sync + embed).${backupNote}${recurrence}`,
        remediation_status: 'human_only',
      };
    case 'wal-corruption-likely':
      return {
        name: 'pglite_data_dir',
        status: 'fail',
        message:
          `PGLite failed to open and the data dir shows unclean-shutdown state (${diagnosis.detail}). ` +
          `This is the torn-WAL class behind issue #223 — repairable in place, data preserved: ` +
          `\`gbrain pglite-repair --dry-run\` to diagnose, \`gbrain pglite-repair --yes\` to repair.${backupNote}${recurrence}`,
        remediation_status: 'human_only',
      };
    case 'looks-healthy':
    default:
      return {
        name: 'pglite_data_dir',
        status: 'fail',
        message:
          `PGLite failed to open but the data dir layout validates (${diagnosis.detail}). ` +
          `IF the connect error mentions \`Aborted()\` this is likely torn WAL state — ` +
          `\`gbrain pglite-repair --dry-run\` to diagnose, \`gbrain pglite-repair --yes\` to repair in place ` +
          `(repair discards the un-checkpointed WAL tail — don't run it for lock-contention or ` +
          `catalog-corruption errors; 58P01/pgvector load failures need \`gbrain reinit-pglite\` instead).${backupNote}${recurrence}`,
        remediation_status: 'human_only',
      };
  }
}

/**
 * issue #1685 (GAP A) — the single authoritative "worker is OOM-looping" signal.
 *
 * One `gbrain doctor` line replaces the hours of log archaeology the #1678
 * incident required: `cap=8192MB, N watchdog kills/24h → raise --max-rss`.
 *
 * UNIONS two sources so it's authoritative for BOTH worker modes (CODEX #5):
 *   - SUPERVISED workers: supervisor audit `worker_exited likely_cause=rss_watchdog`,
 *     read cross-week (CODEX #7) so a Mon read doesn't lose a Sun loop.
 *   - BARE `gbrain jobs work`: NO supervisor event is written; the only trace is
 *     `minion_jobs.error_text = 'aborted: watchdog'` (the same source queue_health
 *     subcheck 3 reads). Reading supervisor-only would miss bare workers entirely
 *     and the queue_health cross-reference would point at an unemitted check.
 *
 * Cap (CODEX #6): the breaker alert stamps `max_rss_mb`, but a fail from
 * oomKills>=5 spread over 24h may have no breaker event → no stamped cap. Fall
 * back to `resolveDefaultMaxRssMb()` so the message always renders a number.
 *
 * Returns null when the worker never OOM'd (don't warn installs that never hit
 * it). Pure-ish: filesystem audit read + one minion_jobs count; no process.exit.
 * Exported so `test/doctor-worker-oom-loop.test.ts` drives it directly.
 */
export async function computeWorkerOomLoopCheck(
  engine: BrainEngine | null,
): Promise<Check | null> {
  let supervisorKills = 0;
  let capFromBreaker: number | null = null;
  let breakerTripped = false;
  try {
    const { readRecentSupervisorEvents, summarizeCrashes } = await import(
      '../../../core/minions/handlers/supervisor-audit.ts'
    );
    const events = readRecentSupervisorEvents(24);
    supervisorKills = summarizeCrashes(events).by_cause.rss_watchdog;
    // Latest rss_watchdog_loop breaker alert carries the cap the supervisor
    // spawned with (supervisor.ts:521); its presence also means the breaker
    // tripped. Walk all events; last one wins for the cap.
    for (const e of events) {
      const row = e as Record<string, unknown>;
      if (e.event === 'health_warn' && row.reason === 'rss_watchdog_loop') {
        breakerTripped = true;
        const cap = Number(row.max_rss_mb);
        if (Number.isFinite(cap) && cap > 0) capFromBreaker = cap;
      }
    }
  } catch {
    // supervisor-audit read is best-effort; fall through to minion_jobs.
  }

  let bareWorkerKills = 0;
  if (engine && engine.kind !== 'pglite') {
    try {
      const sql = db.getConnection();
      const rows: Array<{ cnt: number }> = await sql`
        SELECT count(*)::int AS cnt
          FROM minion_jobs
         WHERE status IN ('dead', 'failed')
           AND finished_at > now() - interval '24 hours'
           AND error_text = 'aborted: watchdog'
      `;
      bareWorkerKills = rows[0]?.cnt ?? 0;
    } catch {
      // minion_jobs may not exist on a fresh brain; best-effort.
    }
  }

  // De-dup note (CODEX #5 accepted trade-off): a supervised watchdog kill aborts
  // in-flight jobs, so it can show in BOTH counts. We accept slight over-count
  // rather than miss bare workers — the signal is "is it OOM-looping," not an
  // exact tally. `details` keeps the two sources separate for honesty.
  const oomKills = supervisorKills + bareWorkerKills;
  if (oomKills < 1 && !breakerTripped) return null;

  let capMb: number;
  let capSource: 'breaker' | 'default';
  if (capFromBreaker !== null) {
    capMb = capFromBreaker;
    capSource = 'breaker';
  } else {
    let def = 16384;
    try {
      const { resolveDefaultMaxRssMb } = await import('../../../core/minions/rss-default.ts');
      def = resolveDefaultMaxRssMb();
    } catch {
      // keep the conservative ceiling fallback.
    }
    capMb = def;
    capSource = 'default';
  }

  const fixHint =
    'raise --max-rss (gbrain jobs work --max-rss <bigger>; auto-sizes to min(0.5×RAM,16GB))';
  const capLabel = capSource === 'breaker' ? `cap=${capMb}MB` : `cap≈${capMb}MB (auto-sized default)`;
  const status: Check['status'] = breakerTripped || oomKills >= 5 ? 'fail' : 'warn';
  return {
    name: 'worker_oom_loop',
    status,
    message:
      `Worker OOM-looping: ${capLabel}, ${oomKills} watchdog kill(s)/24h → ${fixHint}. ` +
      `Peak RSS: see worker stderr.`,
    details: {
      oom_kills: oomKills,
      supervisor_kills: supervisorKills,
      bare_worker_kills: bareWorkerKills,
      cap_mb: capMb,
      cap_source: capSource,
      breaker_tripped: breakerTripped,
      fix_hint: fixHint,
    },
  };
}

/**
 * issue #1685 (GAP B) — DB pool reap health (Postgres-only).
 *
 * Answers the #1685 line "DB pool reaped N times/hr AND not auto-recovering"
 * that no existing signal expresses. Reads the pool-recovery audit
 * (`reconnect()` emits reap_detected / reconnect_succeeded / reconnect_failed):
 *   - fail: reaps>0 AND reconnect failures>0 → the pool is being reaped and
 *           rebuilds are throwing (genuinely not recovering).
 *   - warn: reaps>=10/hr, all recovered → pooler thrash (self-heal works but the
 *           cap is likely too low / concurrency too high).
 *   - else: null (quiet — a few reaps that all recovered is normal).
 *
 * Returns null on PGLite / no engine / audit-read failure. Exported so
 * `test/doctor-pool-reap-health.test.ts` drives it directly.
 */
export async function computePoolReapHealthCheck(
  engine: BrainEngine | null,
): Promise<Check | null> {
  if (!engine || engine.kind === 'pglite') return null;
  let r: { reaps: number; recoveries: number; failures: number };
  try {
    const { readRecentPoolRecoveries } = await import('../../../core/audit/pool-recovery-audit.ts');
    r = readRecentPoolRecoveries(1);
  } catch {
    return null;
  }

  // CODEX (impl review #3): the audit counts independent event kinds — it does
  // NOT correlate a reconnect_failed to a preceding reap. So `reaps>0 AND
  // failures>0` would falsely report "not auto-recovering" when a recovered reap
  // and an unrelated reconnect failure merely co-occur in the same hour. Fail on
  // the reconnect FAILURES themselves (reconnect throwing is the real, actionable
  // problem regardless of reaps); report reaps as context, not as a causal claim.
  if (r.failures > 0) {
    const fix = 'check DB reachability / credentials (reconnect is throwing)';
    return {
      name: 'pool_reap_health',
      status: 'fail',
      message:
        `DB reconnect FAILED ${r.failures}× in last hour (${r.reaps} pooler reap(s) detected) ` +
        `— reconnect is throwing; ${fix}.`,
      details: { reaps: r.reaps, recoveries: r.recoveries, failures: r.failures, fix_hint: fix },
    };
  }
  if (r.reaps >= 10) {
    const fix = 'raise --max-rss or reduce worker concurrency (pooler thrash)';
    return {
      name: 'pool_reap_health',
      status: 'warn',
      message:
        `DB pool reaped ${r.reaps}× in last hour (self-heal recovered each) ` +
        `— ${fix}.`,
      details: { reaps: r.reaps, recoveries: r.recoveries, failures: r.failures, fix_hint: fix },
    };
  }
  return null;
}

