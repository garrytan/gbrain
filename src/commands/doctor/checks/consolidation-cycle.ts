/**
 * Consolidation / budget / cycle check cluster — verbatim peel from src/commands/doctor.ts (containment
 * sprint). No behavior change; doctor.ts re-exports every exported symbol
 * under its original name (tests and external callers import them from
 * doctor.ts) and buildChecks / doctorReportRemote consume them.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { resolveHoursEnv } from '../../../core/env-number.ts';
import type { Check } from '../../doctor.ts';

/** Local alias; the shared warn-once memo lives in core so it can't fork per module. */
const _resolveSyncFreshnessHours = resolveHoursEnv;


/**
 * v0.41.19.0 (Issue 5 of ops-fix-wave) — surface `sync --all --parallel`
 * to operators with multi-source brains.
 *
 * Background: `gbrain sync --all --parallel N --workers N --skip-failed`
 * has existed since v0.40.3.0 but most operators still maintain separate
 * per-source cron entries with manual deconfliction. One `--all` line
 * replaces N per-source lines AND auto-picks-up future sources without
 * a crontab edit.
 *
 * Surgical scope: we can't reach into the user's crontab (host-specific,
 * portability risk). What we CAN do is surface the paste-ready command
 * inside `gbrain doctor` so the operator sees it whenever they run a
 * health check on a multi-source brain.
 *
 * Posture: never failure-state. Always `ok` with the paste-ready cmd
 * embedded in the message (matches how sync_freshness embeds fix hints).
 * Single-source brains get `ok` with a "not applicable" message.
 * SQL error → `warn` (own try/catch, not relying on the outer doctor
 * dispatcher — codex flagged this).
 */
export async function checkSyncConsolidation(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources
        WHERE archived IS NOT TRUE
          AND local_path IS NOT NULL`,
    );
    const sourceCount = rows.length;
    if (sourceCount < 2) {
      return {
        name: 'sync_consolidation',
        status: 'ok',
        message: 'Single-source brain — sync --all consolidation not applicable.',
      };
    }
    return {
      name: 'sync_consolidation',
      status: 'ok',
      message:
        `${sourceCount} active sources detected. Recommended cron: ` +
        '`gbrain sync --all --parallel 4 --workers 4 --skip-failed`. ' +
        'If your crontab has separate per-source entries, replace them with one --all line — ' +
        'future sources auto-pick-up without a crontab edit.',
    };
  } catch (err) {
    return {
      name: 'sync_consolidation',
      status: 'warn',
      message: `Could not check sync consolidation: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * v0.42.x (#1794, 4A) — pure pool-budget check. When `GBRAIN_MAX_CONNECTIONS`
 * is set (the operator opted into the single-source connection clamp), verify
 * the parent pool leaves room for at least one parallel worker. If even the
 * parent pool alone is at/over the budget, sync clamps to serial AND every
 * other gbrain process competes for the same cap — the operator should lower
 * `GBRAIN_POOL_SIZE`. Pure so it's unit-testable without env/engine.
 */
export function computePoolBudgetCheck(
  maxConnections: number | undefined,
  parentPool: number,
  perWorkerPool: number,
): Check {
  if (maxConnections === undefined) {
    return {
      name: 'pool_budget',
      status: 'ok',
      message: 'GBRAIN_MAX_CONNECTIONS not set — connection budget clamp disabled (default behavior).',
    };
  }
  if (parentPool + perWorkerPool > maxConnections) {
    return {
      name: 'pool_budget',
      status: 'warn',
      message:
        `GBRAIN_MAX_CONNECTIONS=${maxConnections} leaves no room for a parallel sync worker ` +
        `(parent pool ${parentPool} + ${perWorkerPool} per-worker > ${maxConnections}). ` +
        `Sync will run serial. If you hit EMAXCONNSESSION, lower the parent pool: ` +
        '`gbrain config` / set GBRAIN_POOL_SIZE=2 (recommended for low-cap poolers like Supabase Supavisor).',
    };
  }
  const maxWorkers = Math.floor((maxConnections - parentPool) / perWorkerPool);
  return {
    name: 'pool_budget',
    status: 'ok',
    message:
      `GBRAIN_MAX_CONNECTIONS=${maxConnections}: room for up to ${maxWorkers} parallel sync ` +
      `worker(s) (parent pool ${parentPool} + ${perWorkerPool} per-worker).`,
  };
}

/** Thin env/engine wrapper over `computePoolBudgetCheck`. */
export async function checkPoolBudget(_engine: BrainEngine): Promise<Check> {
  try {
    const { resolveMaxConnections } = await import('../../../core/sync-concurrency.ts');
    const { resolvePoolSize } = await import('../../../core/db.ts');
    const maxConnections = resolveMaxConnections();
    const parentPool = resolvePoolSize();
    const perWorkerPool = Math.min(2, resolvePoolSize(2));
    return computePoolBudgetCheck(maxConnections, parentPool, perWorkerPool);
  } catch (err) {
    return {
      name: 'pool_budget',
      status: 'ok',
      message: `Skipped (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

/**
 * v0.38 — per-source `last_full_cycle_at` freshness check.
 *
 * Sibling to `sync_freshness`. Where sync_freshness reads `last_sync_at`
 * (one phase of the cycle), this check reads `sources.config->>'last_full_cycle_at'`
 * which is the canonical "this whole cycle completed" timestamp written
 * by runCycle's exit hook. Autopilot's per-source fan-out gate (the
 * v0.38 fan-out wave) reads the same field — so this check surfaces
 * exactly what autopilot sees when deciding to skip a source.
 *
 * Default thresholds: warn at 6h, fail at 24h. Tighter than sync_freshness
 * because full-cycle staleness compounds (sync stale → extract stale →
 * embed stale → search stale). Env overrides:
 *   - GBRAIN_CYCLE_FRESHNESS_WARN_HOURS (default 6)
 *   - GBRAIN_CYCLE_FRESHNESS_FAIL_HOURS (default 24)
 */
export async function checkCycleFreshness(
  engine: BrainEngine,
  opts?: { nowMs?: number },
): Promise<Check> {
  try {
    const sources = await engine.listAllSources({ localPathOnly: true });
    if (sources.length === 0) {
      return {
        name: 'cycle_freshness',
        status: 'ok',
        message: 'No federated sources to cycle',
      };
    }

    const warnHours = _resolveSyncFreshnessHours('GBRAIN_CYCLE_FRESHNESS_WARN_HOURS', 6);
    const failHours = _resolveSyncFreshnessHours('GBRAIN_CYCLE_FRESHNESS_FAIL_HOURS', 24);
    const warnMs = warnHours * 60 * 60 * 1000;
    const failMs = failHours * 60 * 60 * 1000;
    const now = opts?.nowMs ?? Date.now();

    const issues: string[] = [];
    let hasWarnings = false;
    let hasFailures = false;

    for (const source of sources) {
      const display = source.name && source.name !== source.id
        ? `'${source.id}' (${source.name})`
        : `'${source.id}'`;
      const raw = source.config?.last_full_cycle_at;
      if (typeof raw !== 'string') {
        // #2540: WARN, not FAIL. This check iterates EVERY local_path source,
        // so on a multi-source install where only some vaults are cycled
        // (e.g. one nightly `gbrain dream --dir <vault>`), a never-cycled
        // sibling source turned doctor permanently red — which erodes the
        // check's signal until real staleness hides inside the noise (the
        // reporter's install masked genuinely stale sources for weeks this
        // way). "Never cycled" also fires on a source added minutes ago.
        // A source that HAS cycled and then went stale still escalates
        // through the warn/fail age thresholds below — that is the
        // regression signal this check exists for.
        issues.push(`Source ${display} has never completed a full cycle`);
        hasWarnings = true;
        continue;
      }
      const last = new Date(raw).getTime();
      if (!Number.isFinite(last)) {
        issues.push(`Source ${display} has unparseable last_full_cycle_at: ${raw}`);
        hasWarnings = true;
        continue;
      }
      const ageMs = now - last;
      if (ageMs < 0) {
        issues.push(`Source ${display} has future last_full_cycle_at — clock skew`);
        hasWarnings = true;
        continue;
      }
      const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
      if (ageMs > failMs) {
        issues.push(`Source ${display} last cycled ${ageHours}h ago`);
        hasFailures = true;
      } else if (ageMs > warnMs) {
        issues.push(`Source ${display} last cycled ${ageHours}h ago`);
        hasWarnings = true;
      }
    }

    if (hasFailures) {
      return {
        name: 'cycle_freshness',
        status: 'fail',
        message: `${issues.join('; ')}. Run \`gbrain dream --source <id>\` for each stale source, or start \`gbrain autopilot\`.`,
      };
    }
    if (hasWarnings) {
      return {
        name: 'cycle_freshness',
        status: 'warn',
        message: `${issues.join('; ')}. Run \`gbrain dream --source <id>\` to cycle a source, or start \`gbrain autopilot\`.`,
      };
    }
    return {
      name: 'cycle_freshness',
      status: 'ok',
      message: `All ${sources.length} federated source(s) cycled recently`,
    };
  } catch (e) {
    return {
      name: 'cycle_freshness',
      status: 'warn',
      message: `Could not check cycle freshness: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

