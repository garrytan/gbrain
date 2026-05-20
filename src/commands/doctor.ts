import type { BrainEngine } from '../core/engine.ts';
import * as db from '../core/db.ts';
import { LATEST_VERSION, getIdleBlockers } from '../core/migrate.ts';
import { checkResolvable } from '../core/check-resolvable.ts';
import { autoFixDryViolations, type AutoFixReport, type FixOutcome } from '../core/dry-fix.ts';
import { autoDetectSkillsDirReadOnly } from '../core/repo-root.ts';
import { loadCompletedMigrations } from '../core/preferences.ts';
import { compareVersions } from './migrations/index.ts';
import { createProgress, startHeartbeat, type ProgressReporter } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import type { DbUrlSource } from '../core/config.ts';
import { gbrainPath } from '../core/config.ts';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  issues?: Array<{ type: string; skill: string; action: string; fix?: any }>;
  /**
   * v0.36+ brain-health-100: structured remediation jobs per check.
   * Populated by the recommendation generator; consumed by
   * `gbrain doctor --remediation-plan` / `--remediate`. Optional and
   * additive — schema_version stays at 2 (D4).
   */
  remediation?: Array<{
    id: string;
    job: string;
    params: Record<string, unknown>;
    idempotency_key: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    est_seconds: number;
    est_usd_cost?: number;
    depends_on?: string[];
    rationale: string;
    protected?: boolean;
  }>;
  /** Top-level triage state per D13. */
  remediation_status?: 'remediable' | 'human_only' | 'blocked';
}

/**
 * Structured doctor report. Stable shape consumed by:
 *   - gbrain doctor --json (CLI)
 *   - run_doctor MCP op (remote callers)
 *   - gbrain remote doctor (renders this from the MCP op response)
 *
 * schema_version=2 was set when --json output stabilized; bump only for
 * breaking field changes.
 */
export interface DoctorReport {
  schema_version: 2;
  status: 'healthy' | 'warnings' | 'unhealthy';
  health_score: number;
  checks: Check[];
}

/**
 * Compute the {status, health_score} headline from a list of checks.
 * Mirrors the calculation in outputResults() so remote callers and the
 * existing CLI front-end agree on what "healthy" means.
 */
export function computeDoctorReport(checks: Check[]): DoctorReport {
  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');
  let score = 100;
  for (const c of checks) {
    if (c.status === 'fail') score -= 20;
    else if (c.status === 'warn') score -= 5;
  }
  score = Math.max(0, score);
  const status: DoctorReport['status'] = hasFail ? 'unhealthy' : hasWarn ? 'warnings' : 'healthy';
  return { schema_version: 2, status, health_score: score, checks };
}

/**
 * Focused doctor for `run_doctor` MCP op + `gbrain remote doctor` CLI.
 *
 * Runs five checks scoped to "what does a remote operator need to know about
 * this brain right now?":
 *   - connection (engine reachable + page count)
 *   - schema_version (current vs latest)
 *   - brain_score (the 5-component health composite)
 *   - sync_failures (unacked parse failures)
 *   - queue_health (Postgres-only: stalled-forever active jobs)
 *
 * Deliberately a focused subset of the local doctor surface, NOT a full
 * mirror. Generalizing to lint/integrity/orphans is filed as follow-up work
 * pending demand. Local doctor is unchanged — operators on the host machine
 * still get the full check set.
 */
/**
 * Doctor check: takes.weight grid integrity (v0.32 — EXP-2).
 *
 * Pure helper — no `process.exit`, no side effects beyond the SQL probe.
 * `runDoctor` calls this and pushes the result onto its check list.
 * Tests can target this directly with a stubbed engine (codex review #7).
 *
 * Branches:
 *   - takes table doesn't exist (fresh brain pre-v37) → warn, "skipped"
 *   - 0 takes total → ok, "no takes yet" (avoids divide-by-zero)
 *   - off_grid / total > 10% → fail
 *   - off_grid / total > 1%  → warn
 *   - else → ok
 *
 * Tolerance matches migration v48: any value with abs(weight - on_grid) > 1e-3
 * is genuinely off-grid (the 0.05 grid is 5e-2; float32 noise is ~1e-7).
 */
const WHOKNOWS_FIXTURE_RELATIVE_PATH = 'test/fixtures/whoknows-eval.jsonl';

function isGbrainSourceRoot(dir: string): boolean {
  return (
    existsSync(join(dir, 'src', 'cli.ts')) &&
    existsSync(join(dir, 'skills', 'RESOLVER.md'))
  );
}

export function resolveWhoknowsFixturePath(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): string | null {
  if (env.GBRAIN_WHOKNOWS_FIXTURE_PATH) {
    return isAbsolute(env.GBRAIN_WHOKNOWS_FIXTURE_PATH)
      ? env.GBRAIN_WHOKNOWS_FIXTURE_PATH
      : resolvePath(process.cwd(), env.GBRAIN_WHOKNOWS_FIXTURE_PATH);
  }

  try {
    let dir = dirname(fileURLToPath(moduleUrl));
    for (let i = 0; i < 10; i++) {
      if (isGbrainSourceRoot(dir)) return join(dir, WHOKNOWS_FIXTURE_RELATIVE_PATH);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Some bundlers/runtimes may not expose a normal file: import URL.
    // Doctor should surface an override hint instead of fabricating a path.
  }

  return null;
}

/**
 * v0.33: whoknows_health — verify the eval fixture is present at the
 * documented path. Lightweight; just checks file existence and row count,
 * not the eval gate outcome (that runs via `gbrain eval whoknows`).
 *
 * Surface is intentionally narrow: a missing fixture means the eval
 * cannot run at all, which is the highest-leverage signal. Hit-rate
 * regression detection lives in `gbrain eval whoknows --json` and is
 * the job of the eval command, not the doctor sweep.
 */
export async function whoknowsHealthCheck(_engine: BrainEngine): Promise<Check> {
  try {
    const fixturePath = resolveWhoknowsFixturePath();
    if (!fixturePath) {
      return {
        name: 'whoknows_health',
        status: 'warn',
        message: 'whoknows eval fixture path could not be resolved. Set GBRAIN_WHOKNOWS_FIXTURE_PATH to the absolute path for test/fixtures/whoknows-eval.jsonl.',
      };
    }
    if (!existsSync(fixturePath)) {
      return {
        name: 'whoknows_health',
        status: 'warn',
        message: `whoknows eval fixture missing at ${fixturePath}. Fix: hand-label 10 queries you'd actually run, format {query, expected_top_3_slugs, notes}.`,
      };
    }
    const stat = statSync(fixturePath);
    if (stat.size === 0) {
      return {
        name: 'whoknows_health',
        status: 'warn',
        message: 'whoknows eval fixture exists but is empty. The eval cannot pass without queries.',
      };
    }
    const raw = readFileSync(fixturePath, 'utf-8');
    const rows = raw
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        return t && !t.startsWith('#') && !t.startsWith('//');
      });
    if (rows.length < 5) {
      return {
        name: 'whoknows_health',
        status: 'warn',
        message: `whoknows eval fixture has only ${rows.length} row(s); ENG-D2 recommends 10. Fix: add more hand-labeled queries.`,
      };
    }
    return {
      name: 'whoknows_health',
      status: 'ok',
      message: `whoknows eval fixture present (${rows.length} queries). Run \`gbrain eval whoknows test/fixtures/whoknows-eval.jsonl\` to grade.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'whoknows_health',
      status: 'warn',
      message: `Could not check whoknows fixture: ${msg}`,
    };
  }
}

export async function takesWeightGridCheck(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ off_grid: string | number; total: string | number }>(
      `SELECT
         count(*) FILTER (WHERE weight IS NOT NULL
                          AND abs(weight::numeric - ROUND(weight::numeric * 20) / 20) > 0.001)::int AS off_grid,
         count(*)::int AS total
       FROM takes`,
    );
    const total = Number(rows[0]?.total ?? 0);
    const offGrid = Number(rows[0]?.off_grid ?? 0);
    if (total === 0) {
      return { name: 'takes_weight_grid', status: 'ok', message: 'No takes yet' };
    }
    const ratio = offGrid / total;
    if (ratio > 0.10) {
      return {
        name: 'takes_weight_grid',
        status: 'fail',
        message: `${offGrid}/${total} takes off the 0.05 grid (${(ratio * 100).toFixed(1)}%). Fix: gbrain apply-migrations --yes`,
      };
    }
    if (ratio > 0.01) {
      return {
        name: 'takes_weight_grid',
        status: 'warn',
        message: `${offGrid}/${total} takes off the 0.05 grid (${(ratio * 100).toFixed(1)}%). Fix: gbrain apply-migrations --yes`,
      };
    }
    return {
      name: 'takes_weight_grid',
      status: 'ok',
      message: offGrid === 0
        ? `${total} take(s) on grid`
        : `${total} take(s) on grid (${offGrid} within tolerance)`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // takes table missing on a fresh pre-v37 brain — warn, don't fail.
    return {
      name: 'takes_weight_grid',
      status: 'warn',
      message: `Could not check takes weight grid: ${msg}`,
    };
  }
}

/**
 * Child-table orphan detection (closes #1063).
 *
 * The autopilot `orphans` phase (src/core/cycle.ts:runPhaseOrphans) detects
 * orphan PAGES (pages with no inbound links via the page-graph). It does NOT
 * scan FK-child tables for orphan rows. When a bulk page delete leaves
 * orphans in `content_chunks` / `page_versions` / `tags` / `takes` / etc.
 * — whether from pre-FK migrations, race conditions, or a code path that
 * bypassed cascade — they persist indefinitely until manual SQL cleanup.
 *
 * All ten FK-to-pages tables declare `ON DELETE CASCADE` in the live schema
 * (verified via `pg_constraint` snapshot in the issue body), so finding any
 * orphan row is by definition unexpected. The check ships paste-ready
 * cleanup SQL when orphans surface.
 *
 * Excluded: `files.page_id` and `links.origin_page_id` — both declared as
 * `ON DELETE SET NULL`, so a NULL value is a valid state (file/link survives
 * after page deletion); only NOT-NULL-but-page-missing is an orphan there.
 * The check encodes that distinction for the two SET NULL columns.
 *
 * Pure helper for parity with `takesWeightGridCheck` so tests can target it
 * directly without driving the full `runDoctor` pipeline.
 */
export async function childTableOrphansCheck(engine: BrainEngine): Promise<Check> {
  // (table, fk_column, allow_null). When allow_null=true, NULL is a valid
  // state (FK was declared ON DELETE SET NULL); the orphan predicate filters
  // out NULL values. When false, NULL is impossible by NOT NULL constraint;
  // any value not in pages.id is an orphan.
  const targets: Array<{ table: string; col: string; allowNull: boolean }> = [
    { table: 'content_chunks',   col: 'page_id',          allowNull: false },
    { table: 'page_versions',    col: 'page_id',          allowNull: false },
    { table: 'tags',             col: 'page_id',          allowNull: false },
    { table: 'takes',            col: 'page_id',          allowNull: false },
    { table: 'raw_data',         col: 'page_id',          allowNull: false },
    { table: 'timeline_entries', col: 'page_id',          allowNull: false },
    { table: 'links',            col: 'from_page_id',     allowNull: false },
    { table: 'links',            col: 'to_page_id',       allowNull: false },
    { table: 'links',            col: 'origin_page_id',   allowNull: true  },
    { table: 'files',            col: 'page_id',          allowNull: true  },
  ];
  let totalOrphans = 0;
  const breakdown: string[] = [];
  const cleanupSql: string[] = [];
  const errors: string[] = [];
  for (const { table, col, allowNull } of targets) {
    try {
      // NOT IN subquery is portable across postgres + PGLite. The `pages.id`
      // subquery covers every existing parent row.
      const nullFilter = allowNull ? `${col} IS NOT NULL AND ` : '';
      const rows = await engine.executeRaw<{ n: string | number }>(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE ${nullFilter}${col} NOT IN (SELECT id FROM pages)`,
      );
      const n = Number(rows[0]?.n ?? 0);
      if (n > 0) {
        totalOrphans += n;
        breakdown.push(`${table}.${col}=${n}`);
        cleanupSql.push(
          `DELETE FROM ${table} WHERE ${nullFilter}${col} NOT IN (SELECT id FROM pages);`,
        );
      }
    } catch (e) {
      // Table or column may not exist on older schemas — skip and continue.
      // Aggregate the errors so doctor surfaces "could not check N tables"
      // when a real failure shape appears (network, lock, syntax).
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${table}.${col}: ${msg.slice(0, 80)}`);
    }
  }
  if (totalOrphans === 0 && errors.length === 0) {
    return {
      name: 'child_table_orphans',
      status: 'ok',
      message: 'All FK-child tables clean (10 tables checked)',
    };
  }
  if (totalOrphans === 0 && errors.length > 0) {
    return {
      name: 'child_table_orphans',
      status: 'warn',
      message: `Could not check ${errors.length}/10 FK-child tables (older schema or transient error): ${errors.slice(0, 3).join('; ')}`,
    };
  }
  return {
    name: 'child_table_orphans',
    status: 'warn',
    message:
      `${totalOrphans} orphan row(s) in FK-child tables (${breakdown.join(', ')}). ` +
      `Cleanup: ${cleanupSql.join(' ')}`,
  };
}

export async function doctorReportRemote(engine: BrainEngine): Promise<DoctorReport> {
  const checks: Check[] = [];

  // 1. Connection
  let pageCount = 0;
  try {
    const stats = await engine.getStats();
    pageCount = stats.page_count ?? 0;
    checks.push({
      name: 'connection',
      status: 'ok',
      message: `Connected, ${pageCount} pages`,
    });
  } catch (e) {
    checks.push({
      name: 'connection',
      status: 'fail',
      message: e instanceof Error ? e.message : String(e),
    });
    // Without a connection, every other check is meaningless — short-circuit.
    return computeDoctorReport(checks);
  }

  // 2. Schema version. Uses engine.getConfig('version') — the same engine-
  // agnostic API the local doctor uses, works on both Postgres and PGLite.
  try {
    const versionStr = await engine.getConfig('version');
    const version = parseInt(versionStr || '0', 10);
    if (version >= LATEST_VERSION) {
      checks.push({ name: 'schema_version', status: 'ok', message: `Version ${version} (latest: ${LATEST_VERSION})` });
    } else if (version === 0) {
      checks.push({
        name: 'schema_version',
        status: 'fail',
        message: `No schema version recorded. Migrations never ran. Run \`gbrain apply-migrations --yes\` on the host.`,
      });
    } else {
      checks.push({
        name: 'schema_version',
        status: 'warn',
        message: `Version ${version}, latest is ${LATEST_VERSION}. Run \`gbrain apply-migrations --yes\` on the host.`,
      });
    }
  } catch {
    checks.push({ name: 'schema_version', status: 'warn', message: 'Could not check schema version' });
  }

  // 3. Brain score
  try {
    const health = await engine.getHealth();
    const score = health.brain_score ?? 0;
    checks.push({
      name: 'brain_score',
      status: score >= 70 ? 'ok' : score >= 50 ? 'warn' : 'fail',
      message: `Brain score ${score}/100`,
    });
  } catch (e) {
    checks.push({
      name: 'brain_score',
      status: 'warn',
      message: `Could not compute: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 3b. Migration wedge hint (v0.31.8 — D14 + D19). The brain server's
  // filesystem holds the migration ledger; the wedge condition (>=3 consecutive
  // partials with no later complete) needs the force-retry hint, not plain
  // --yes. Same shape as the local doctor at line ~336.
  try {
    const completed = loadCompletedMigrations();
    const byVersion = new Map<string, { complete: boolean; partial: boolean }>();
    for (const entry of completed) {
      const seen = byVersion.get(entry.version) ?? { complete: false, partial: false };
      if (entry.status === 'complete') seen.complete = true;
      if (entry.status === 'partial') seen.partial = true;
      byVersion.set(entry.version, seen);
    }
    const completedVersions = Array.from(byVersion.entries()).filter(([, s]) => s.complete).map(([v]) => v);
    const stuck = Array.from(byVersion.entries())
      .filter(([v, s]) => {
        if (!s.partial || s.complete) return false;
        const supersededBy = completedVersions.find(cv => compareVersions(cv, v) >= 0);
        return supersededBy === undefined;
      })
      .map(([v]) => v);
    const wedged: string[] = [];
    for (const v of stuck) {
      const partialCount = completed.filter(e => e.version === v && e.status === 'partial').length;
      if (partialCount >= 3) wedged.push(v);
    }
    if (wedged.length > 0) {
      const cmd = wedged.map(v => `gbrain apply-migrations --force-retry ${v}`).join(' && ');
      checks.push({
        name: 'minions_migration',
        status: 'fail',
        message: `WEDGED MIGRATION(s) on brain host: ${wedged.join(', ')}. Run on the host: ${cmd}`,
      });
    } else if (stuck.length > 0) {
      checks.push({
        name: 'minions_migration',
        status: 'fail',
        message: `MINIONS HALF-INSTALLED on brain host: ${stuck.join(', ')}. Run on the host: gbrain apply-migrations --yes`,
      });
    }
  } catch {
    // Best-effort. A broken JSONL on the brain server should not stop the
    // remote doctor.
  }

  // 4. Sync failures (file-plane state, not in-DB; see src/core/sync.ts).
  // Read the JSONL file directly at the canonical path; cheap and engine-agnostic.
  try {
    const { readFileSync, existsSync } = await import('fs');
    const { gbrainPath } = await import('../core/config.ts');
    const path = gbrainPath('sync-failures.jsonl');
    let unacked = 0;
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { acknowledged_at?: string | null };
          if (!entry.acknowledged_at) unacked++;
        } catch { /* skip malformed line */ }
      }
    }
    checks.push({
      name: 'sync_failures',
      status: unacked === 0 ? 'ok' : 'warn',
      message: unacked === 0
        ? 'No unacked failures'
        : `${unacked} unacked failure(s) — run \`gbrain sync --skip-failed\` on the host to acknowledge`,
    });
  } catch {
    checks.push({ name: 'sync_failures', status: 'ok', message: 'No failures recorded' });
  }

  // 4b. Multi-source drift (v0.31.8 — D8 + D14). Same shape as the local
  // doctor's check at the same name. Runs server-side; the result is
  // returned to the thin-client over MCP.
  try {
    const { findMisroutedPages } = await import('../core/multi-source-drift.ts');
    const sources = await engine.executeRaw<{ id: string; local_path: string | null }>(
      `SELECT id, local_path FROM sources`,
    );
    const nonDefaultWithPath = sources.filter(s => s.id !== 'default' && s.local_path);
    if (sources.length > 1 && nonDefaultWithPath.length > 0) {
      const result = await findMisroutedPages(
        engine,
        nonDefaultWithPath.map(s => ({ id: s.id, local_path: s.local_path as string })),
      );
      if (result.walk_truncated) {
        checks.push({
          name: 'multi_source_drift',
          status: 'warn',
          message: 'Multi-source drift check skipped — FS walk hit limit/timeout on the brain server.',
        });
      } else if (result.count > 0) {
        const sampleStr = result.sample.map(s => `${s.slug} (intended=${s.intended_source})`).join(', ');
        checks.push({
          name: 'multi_source_drift',
          status: 'warn',
          message:
            `${result.count} page slug(s) appear at 'default' but NOT at the intended source ` +
            `(e.g., ${sampleStr}). Likely pre-v0.30.3 misroutes OR an incomplete initial sync. ` +
            `Verify on the brain host: \`gbrain sources status\` then \`gbrain sync --source <id> --full\`.`,
        });
      } else {
        checks.push({
          name: 'multi_source_drift',
          status: 'ok',
          message: 'No cross-source slug drift detected.',
        });
      }
    }
  } catch {
    // Best-effort, like the rest of doctorReportRemote.
  }

  // 5. Queue health (Postgres-only). PGLite has no minion_jobs in the same
  // shape; skip the check there with an informational message.
  if (engine.kind === 'postgres') {
    try {
      const rows = await engine.executeRaw<{ stalled: string | number }>(
        `SELECT COUNT(*) AS stalled FROM minion_jobs
          WHERE state = 'active'
            AND started_at IS NOT NULL
            AND started_at < NOW() - INTERVAL '1 hour'`,
      );
      const stalled = Number(rows[0]?.stalled ?? 0);
      checks.push({
        name: 'queue_health',
        status: stalled === 0 ? 'ok' : 'warn',
        message: stalled === 0
          ? 'No stalled active jobs'
          : `${stalled} active job(s) stalled > 1h — \`gbrain jobs cancel <id>\` or \`gbrain jobs retry <id>\` on the host`,
      });
    } catch {
      checks.push({ name: 'queue_health', status: 'ok', message: 'No queue activity' });
    }
  } else {
    checks.push({ name: 'queue_health', status: 'ok', message: 'PGLite — no queue to check' });
  }

  // v0.31.12 subagent runtime enforcement (Layer 3 of 3 — Codex F13).
  // The subagent loop is Anthropic-only. If models.tier.subagent or
  // models.default is explicitly set to a non-Anthropic provider, warn here
  // so the user sees it at the next `gbrain doctor` run instead of at the
  // next subagent job submission. (Layers 1+2 also enforce — this is the
  // surfacing layer.)
  checks.push(await checkSubagentProvider(engine));

  // 6. Sync freshness check
  checks.push(await checkSyncFreshness(engine));

  // 7. v0.32.3 search-lite mode + per-key drift surface.
  checks.push(await checkSearchMode(engine));

  // 8. v0.32.3 eval_drift: retrieval-affecting files changed since last
  // eval run? Non-blocking — surfaces as ok + hint.
  checks.push(await checkEvalDrift(engine));

  // 9. v0.35.0.0+ reranker_health: surfaces rerank-audit failures from
  // ~/.gbrain/audit/rerank-failures-*.jsonl. Failure-only (no success
  // logging on the search hot path per CDX2-F22). Reads
  // search.reranker.enabled FIRST so absence-of-failures means different
  // things when reranker is on vs off.
  checks.push(await checkRerankerHealth(engine));

  // 9b. v0.37.0 brainstorm_health: surfaces three brainstorm/lsd readiness
  // signals: (a) migration v79 applied (last_retrieved_at column exists),
  // (b) calibration cold-start status (active_bias_tags empty), (c)
  // search.track_retrieval enabled/disabled. Each surfaces a paste-ready
  // fix hint.
  checks.push(await checkBrainstormHealth(engine));

  // 10. v0.36.1.0 Hindsight calibration wave (T12) — four new checks:
  //   - abandoned_threads: high-conviction takes never revisited
  //   - calibration_freshness: profile is older than 7 days
  //   - grade_confidence_drift: judge self-reported confidence vs actual accuracy (CDX-11 mitigation)
  //   - voice_gate_health: voice gate failure rate over the last 7 days
  checks.push(await checkAbandonedThreads(engine));
  checks.push(await checkCalibrationFreshness(engine));
  checks.push(await checkGradeConfidenceDrift(engine));
  checks.push(await checkVoiceGateHealth(engine));

  return computeDoctorReport(checks);
}

// --- v0.36.1.0 calibration doctor checks (T12) ---

/**
 * abandoned_threads: surfaces active high-conviction takes (weight >= 0.7)
 * older than 12 months that have neither been superseded nor linked to a
 * follow-up page. These are commitments the user made and never revisited.
 * Status 'ok' with a count; never warns/fails (this is signal, not error).
 */
export async function checkAbandonedThreads(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM takes
         WHERE active = true
           AND resolved_at IS NULL
           AND superseded_by IS NULL
           AND weight >= 0.7
           AND since_date IS NOT NULL
           AND since_date::date < (now() - INTERVAL '12 months')`,
    );
    const count = rows[0]?.count ?? 0;
    if (count === 0) {
      return {
        name: 'abandoned_threads',
        status: 'ok',
        message: 'No abandoned high-conviction threads',
      };
    }
    return {
      name: 'abandoned_threads',
      status: 'ok',
      message: `${count} high-conviction take(s) older than 12 months and never revisited — see \`gbrain calibration\` for details`,
    };
  } catch (e) {
    return {
      name: 'abandoned_threads',
      status: 'warn',
      message: `Could not check abandoned threads: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * calibration_freshness: warns when the active calibration profile is
 * older than 7 days (configurable). Default holder 'garry'. Multi-source
 * brains see one row per source; this check uses the most recent across
 * all sources.
 */
export async function checkCalibrationFreshness(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ generated_at: Date | null }>(
      `SELECT MAX(generated_at) AS generated_at FROM calibration_profiles WHERE holder = 'garry'`,
    );
    const generated = rows[0]?.generated_at;
    if (!generated) {
      return {
        name: 'calibration_freshness',
        status: 'ok',
        message: 'No calibration profile yet (builds after 5+ resolved takes)',
      };
    }
    const ageMs = Date.now() - new Date(generated).getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
    const staleDays = 7;
    if (ageDays > staleDays) {
      return {
        name: 'calibration_freshness',
        status: 'warn',
        message: `Calibration profile is ${ageDays} days old (stale at >${staleDays}d). Run \`gbrain calibration --regenerate\``,
      };
    }
    return {
      name: 'calibration_freshness',
      status: 'ok',
      message: `Calibration profile generated ${ageDays}d ago`,
    };
  } catch (e) {
    return {
      name: 'calibration_freshness',
      status: 'warn',
      message: `Could not check calibration freshness: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * grade_confidence_drift (CDX-11 mitigation): compare the judge's
 * self-reported confidence on auto-applied verdicts against the eventual
 * accuracy on those same takes. When auto-resolutions diverge from
 * confidence prediction, the judge is mis-calibrated and the operator
 * should retune the prompt or revisit the threshold.
 *
 * v0.36.1.0 ship state: returns 'ok' with a counter — actual drift math
 * requires a measurement window we haven't accumulated yet. The check
 * exists so the surface is wired; the math arrives once we have N >= 30
 * auto-applied verdicts to compare.
 */
export async function checkGradeConfidenceDrift(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ applied_count: number }>(
      `SELECT COUNT(*)::int AS applied_count FROM take_grade_cache WHERE applied = true`,
    );
    const applied = rows[0]?.applied_count ?? 0;
    if (applied < 30) {
      return {
        name: 'grade_confidence_drift',
        status: 'ok',
        message: `Only ${applied} auto-applied verdicts — need 30+ for drift detection`,
      };
    }
    // v0.37+ TODO: compute confidence-vs-accuracy correlation; warn when
    // mean(applied verdicts' confidence) deviates from the actual accuracy
    // rate (cross-checked against later manual corrections via the
    // contradictions probe). For v0.36.1.0 the check surfaces only the
    // count and a "calibration math pending" status.
    return {
      name: 'grade_confidence_drift',
      status: 'ok',
      message: `${applied} auto-applied verdicts; drift math arrives in v0.37+`,
    };
  } catch (e) {
    return {
      name: 'grade_confidence_drift',
      status: 'warn',
      message: `Could not check grade confidence drift: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * voice_gate_health: warns when calibration_profiles rows show a high rate
 * of voice gate failures over the last 7 days. Failures aren't bad in
 * isolation (template fallback is fine), but a sustained high rate signals
 * the rubric needs tuning.
 */
export async function checkVoiceGateHealth(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ total: number; failures: number }>(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(CASE WHEN voice_gate_passed = false THEN 1 ELSE 0 END), 0)::int AS failures
         FROM calibration_profiles
         WHERE generated_at >= (now() - INTERVAL '7 days')`,
    );
    const total = rows[0]?.total ?? 0;
    const failures = rows[0]?.failures ?? 0;
    if (total === 0) {
      return {
        name: 'voice_gate_health',
        status: 'ok',
        message: 'No calibration profile generation in the last 7 days',
      };
    }
    const failRate = failures / total;
    if (failRate >= 0.3) {
      return {
        name: 'voice_gate_health',
        status: 'warn',
        message: `Voice gate failed ${failures}/${total} (${Math.round(failRate * 100)}%) in last 7 days. Review src/core/calibration/voice-gate.ts rubric.`,
      };
    }
    return {
      name: 'voice_gate_health',
      status: 'ok',
      message: `Voice gate ${failures}/${total} failed in last 7 days (${Math.round(failRate * 100)}%)`,
    };
  } catch (e) {
    return {
      name: 'voice_gate_health',
      status: 'warn',
      message: `Could not check voice gate health: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * v0.35.0.0+ reranker_health doctor check.
 *
 * Logic (post-CDX2 review):
 *   1) Read `search.reranker.enabled` first. When disabled and no
 *      failures in window → 'ok: reranker disabled'. Avoids interpreting
 *      "no events" as "broken" when reranker is simply not in use.
 *   2) Walk last 7 days of `~/.gbrain/audit/rerank-failures-*.jsonl`.
 *   3) Auth failures: ANY single one warns (config-time problem doctor's
 *      own probe should have caught — surface it).
 *   4) Transient (network/timeout/rate_limit): warn at >=5 in window.
 *      Below that they're noise; reranker fails open anyway.
 *   5) Payload-too-large failures: warn at >=1 (indicates a workload
 *      mismatch that the operator should know about).
 *
 * Engine-agnostic (file-based + one config-key read).
 */
export async function checkRerankerHealth(engine: BrainEngine): Promise<Check> {
  try {
    const { readRecentRerankFailures } = await import('../core/rerank-audit.ts');
    const cfg = await engine.getConfig('search.reranker.enabled');
    const rerankerEnabled = cfg === 'true' || cfg === '1';

    const failures = readRecentRerankFailures(7);
    if (failures.length === 0) {
      return {
        name: 'reranker_health',
        status: 'ok',
        message: rerankerEnabled
          ? 'No rerank failures in last 7 days'
          : 'Reranker disabled — no failures expected',
      };
    }

    const authFails = failures.filter((f) => f.reason === 'auth');
    if (authFails.length > 0) {
      return {
        name: 'reranker_health',
        status: 'warn',
        message: `${authFails.length} reranker auth failure(s) in last 7 days. Fix: verify ZEROENTROPY_API_KEY and run \`gbrain models doctor\`.`,
      };
    }

    const payloadFails = failures.filter((f) => f.reason === 'payload_too_large');
    if (payloadFails.length > 0) {
      return {
        name: 'reranker_health',
        status: 'warn',
        message: `${payloadFails.length} reranker payload-too-large failure(s) in last 7 days. Fix: lower \`search.reranker.top_n_in\` (default 30) or split very large documents.`,
      };
    }

    const transientFails = failures.filter(
      (f) => f.reason === 'network' || f.reason === 'timeout' || f.reason === 'rate_limit',
    );
    if (transientFails.length >= 5) {
      return {
        name: 'reranker_health',
        status: 'warn',
        message: `${transientFails.length} transient reranker failure(s) in last 7 days. Search fails open to RRF order; check ZE status if persistent.`,
      };
    }

    return {
      name: 'reranker_health',
      status: 'ok',
      message: `${failures.length} reranker failure(s) in last 7 days (below threshold)`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'reranker_health',
      status: 'warn',
      message: `Could not check reranker audit: ${msg}`,
    };
  }
}

/**
 * v0.37.0 brainstorm_health doctor check.
 *
 * Surfaces three readiness signals for `gbrain brainstorm` / `gbrain lsd`:
 *
 *   1. Migration v79 applied — the `pages.last_retrieved_at` column exists.
 *      If missing, LSD's stale-page signal degrades silently (corpus-sampling
 *      fallback only). Fix: `gbrain apply-migrations --yes`.
 *
 *   2. search.track_retrieval — when explicitly off, LSD never accumulates
 *      stale signal (every page stays at NULL last_retrieved_at). Default-on
 *      is fine; explicit-off is a warning so the user notices the setting.
 *      Fix: `gbrain config set search.track_retrieval true`.
 *
 *   3. Calibration cold-start — the latest calibration profile has empty
 *      `active_bias_tags`. brainstorm + LSD judge fall back to no-anti-bias
 *      mode with a stderr warning at run time; this surfaces it earlier.
 *      Fix: `gbrain calibration --regenerate` once enough takes are resolved.
 *
 * Returns the FIRST non-ok signal as the status — column-missing dominates,
 * then disabled-tracking, then cold-start. All three are non-blocking warnings;
 * brainstorm + LSD still work, just with degraded signal.
 */
export async function checkBrainstormHealth(engine: BrainEngine): Promise<Check> {
  // (1) Column probe — fast, single-query.
  try {
    const probeRows = await engine.executeRaw<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'pages' AND column_name = 'last_retrieved_at'
       ) AS exists`,
      []
    );
    const columnPresent = probeRows[0]?.exists === true;
    if (!columnPresent) {
      return {
        name: 'brainstorm_health',
        status: 'warn',
        message: `pages.last_retrieved_at column missing. LSD stale-bias degraded to corpus-sampling. Fix: \`gbrain apply-migrations --yes\``,
      };
    }
  } catch (e) {
    // Information schema may not be queryable on every engine variant.
    // Don't fail the doctor over this — degrade to skip.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'brainstorm_health',
      status: 'warn',
      message: `Could not probe pages.last_retrieved_at (${msg}); brainstorm/lsd may run with degraded signal.`,
    };
  }

  // (2) search.track_retrieval — explicit-off surfaces as a warning.
  try {
    const trackCfg = await engine.getConfig('search.track_retrieval');
    if (trackCfg === 'false' || trackCfg === '0' || trackCfg === 'off' || trackCfg === 'no') {
      return {
        name: 'brainstorm_health',
        status: 'warn',
        message: `search.track_retrieval is explicitly off — LSD's stale-page signal never accumulates. Fix: \`gbrain config set search.track_retrieval true\` (or accept and use brainstorm only).`,
      };
    }
  } catch {
    // Config read miss is benign; default-on applies.
  }

  // (3) Calibration cold-start — empty active_bias_tags.
  try {
    const calibRows = await engine.executeRaw<{ active_bias_tags: string[] | null }>(
      `SELECT active_bias_tags
         FROM calibration_profiles
         ORDER BY generated_at DESC
         LIMIT 1`,
      []
    );
    if (calibRows.length === 0) {
      return {
        name: 'brainstorm_health',
        status: 'ok',
        message: `Migration v79 applied; tracking enabled. Calibration profile not yet generated — brainstorm/lsd will run unbiased until enough takes are resolved.`,
      };
    }
    const tags = calibRows[0].active_bias_tags;
    if (!Array.isArray(tags) || tags.length === 0) {
      return {
        name: 'brainstorm_health',
        status: 'ok',
        message: `Migration v79 applied; tracking enabled. Calibration cold-start (no active_bias_tags) — judge runs unbiased. Fix when ready: \`gbrain calibration --regenerate\`.`,
      };
    }
    return {
      name: 'brainstorm_health',
      status: 'ok',
      message: `Migration v79 applied; tracking enabled; calibration profile with ${tags.length} bias tag(s) loaded.`,
    };
  } catch {
    // Pre-v0.36.1 brain (no calibration_profiles table). Brainstorm/lsd still
    // work without anti-bias context — orchestrator stderr-warns at run time.
    return {
      name: 'brainstorm_health',
      status: 'ok',
      message: `Migration v79 applied; tracking enabled. calibration_profiles table missing (pre-v0.36.1 brain) — judge runs unbiased.`,
    };
  }
}

/**
 * v0.36.0.0 (A5): ze_embedding_health doctor check.
 *
 * When the configured embedding_model starts with `zeroentropyai:`, verify
 * the API key is set. Doesn't make a network call by default — the existing
 * `gbrain models doctor` probe covers that, and we don't want every
 * `gbrain doctor` run to spend tokens. Surfaces a paste-ready fix when the
 * key is missing.
 */
export async function checkZeEmbeddingHealth(engine: BrainEngine): Promise<Check> {
  try {
    const model = await engine.getConfig('embedding_model') ?? '';
    if (!model.startsWith('zeroentropyai:')) {
      return {
        name: 'ze_embedding_health',
        status: 'ok',
        message: `Configured embedding model "${model || 'default'}" is not ZeroEntropy — skip.`,
      };
    }
    const envKey = process.env.ZEROENTROPY_API_KEY;
    const configKey = await engine.getConfig('zeroentropy_api_key');
    if (!envKey && !configKey) {
      return {
        name: 'ze_embedding_health',
        status: 'warn',
        message:
          `embedding_model="${model}" but ZEROENTROPY_API_KEY is not set. ` +
          `Fix: get a key at https://dashboard.zeroentropy.dev and run ` +
          `\`gbrain config set zeroentropy_api_key <YOUR_KEY>\` (or export ZEROENTROPY_API_KEY).`,
      };
    }
    return {
      name: 'ze_embedding_health',
      status: 'ok',
      message: `embedding_model="${model}" with key configured`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'ze_embedding_health',
      status: 'warn',
      message: `Could not check ZE embedding health: ${msg}`,
    };
  }
}

/**
 * v0.36.0.0 (A5): embedding_width_consistency doctor check.
 *
 * Cross-checks that `config.embedding_dimensions` matches the actual
 * `vector(N)` width on `content_chunks.embedding`. Drift here means the
 * ze-switch was interrupted mid-flight (schema changed but config write
 * crashed, or vice versa). Surfaces a paste-ready `gbrain ze-switch
 * --resume` hint.
 */
export async function checkEmbeddingWidthConsistency(engine: BrainEngine): Promise<Check> {
  try {
    const configDimStr = await engine.getConfig('embedding_dimensions');
    if (!configDimStr) {
      // Pre-v0.27 brain or never configured. Not our problem.
      return {
        name: 'embedding_width_consistency',
        status: 'ok',
        message: 'embedding_dimensions not configured — using defaults.',
      };
    }
    const configDim = parseInt(configDimStr, 10);
    if (!Number.isFinite(configDim) || configDim <= 0) {
      return {
        name: 'embedding_width_consistency',
        status: 'warn',
        message: `embedding_dimensions config value "${configDimStr}" is not a positive integer. Fix: \`gbrain config set embedding_dimensions <N>\`.`,
      };
    }

    // Read the actual column width from pg_attribute / information_schema.
    // Postgres + PGLite both expose vector typmod via atttypmod (vectors
    // store dim as typmod). atttypmod==-1 means no constraint; >=0 is the
    // dim+VARHDRSZ — we use format_type for portability.
    const rows = await engine.executeRaw<{ format_type: string }>(
      `SELECT format_type(atttypid, atttypmod) AS format_type
         FROM pg_attribute
        WHERE attrelid = 'content_chunks'::regclass
          AND attname = 'embedding'
          AND NOT attisdropped`,
    );
    if (rows.length === 0) {
      return {
        name: 'embedding_width_consistency',
        status: 'warn',
        message: 'content_chunks.embedding column not found. Fix: run `gbrain init --migrate-only` or check schema.',
      };
    }
    const formatType = rows[0].format_type;
    // Parse 'vector(N)' shape.
    const m = formatType.match(/vector\((\d+)\)/i);
    if (!m) {
      return {
        name: 'embedding_width_consistency',
        status: 'warn',
        message: `Unexpected column type for content_chunks.embedding: "${formatType}".`,
      };
    }
    const schemaDim = parseInt(m[1], 10);
    if (schemaDim !== configDim) {
      return {
        name: 'embedding_width_consistency',
        status: 'warn',
        message:
          `Schema width mismatch: content_chunks.embedding is vector(${schemaDim}) but ` +
          `embedding_dimensions config = ${configDim}. ` +
          `Fix: \`gbrain ze-switch --resume\` if you were mid-switch, or ` +
          `\`gbrain config set embedding_dimensions ${schemaDim}\` to match the schema.`,
      };
    }
    return {
      name: 'embedding_width_consistency',
      status: 'ok',
      message: `Schema width (${schemaDim}d) matches embedding_dimensions config`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'embedding_width_consistency',
      status: 'warn',
      message: `Could not check embedding width: ${msg}`,
    };
  }
}

/**
 * v0.32.3 [CDX-20]: surface mode + per-key override drift.
 *
 * Status stays `ok` (never warns; never docks health score). If
 * search.mode is unset → suggest picking one. If overrides contradict
 * the mode (e.g. mode=conservative but cache.enabled=false), say so in
 * the message and paste a `gbrain search modes --reset` fix command.
 */
export async function checkSearchMode(engine: BrainEngine): Promise<Check> {
  try {
    const mode = await engine.getConfig('search.mode');
    const overrides = await engine.listConfigKeys('search.');
    // Exclude search.mode itself + the upgrade-notice state key from the
    // override roster — they aren't knobs.
    const overrideKeys = overrides.filter(k => k !== 'search.mode' && k !== 'search.mode_upgrade_notice_shown');

    if (!mode) {
      return {
        name: 'search_mode',
        status: 'ok',
        message: 'search.mode is unset (using balanced fallback). Run `gbrain search modes` to see what is running and pick a mode explicitly.',
      };
    }

    if (overrideKeys.length === 0) {
      return {
        name: 'search_mode',
        status: 'ok',
        message: `Mode: ${mode} (no per-key overrides — mode bundle is canonical).`,
      };
    }

    return {
      name: 'search_mode',
      status: 'ok',
      message: `Mode: ${mode} with ${overrideKeys.length} per-key override(s) (${overrideKeys.join(', ')}). To consolidate to the pure mode bundle: gbrain search modes --reset`,
    };
  } catch (e) {
    return {
      name: 'search_mode',
      status: 'ok',
      message: `Could not read search mode config (${(e as Error).message ?? 'unknown'}).`,
    };
  }
}

/**
 * v0.32.3 [CDX-6]: surface when retrieval-affecting files have changed
 * since the most recent published eval. Curated watch-list in
 * src/core/eval/drift-watch.ts; additions to that list require a
 * CHANGELOG line.
 *
 * Status stays `ok` — operator-facing reminder, not a hard gate.
 */
export async function checkEvalDrift(engine: BrainEngine): Promise<Check> {
  try {
    const { watchedFilesDrifted } = await import('../core/eval/drift-watch.ts');
    // Working tree vs HEAD (uncommitted retrieval changes). The fuller
    // version (vs the commit of the last published eval) is wired when
    // eval_results lands; today we just probe for uncommitted retrieval
    // changes so the operator sees them before re-running evals.
    const repoRoot = process.cwd();
    const drifted = watchedFilesDrifted(repoRoot);
    if (drifted.length === 0) {
      return {
        name: 'eval_drift',
        status: 'ok',
        message: 'No retrieval-affecting files changed in working tree.',
      };
    }
    const summary = drifted.slice(0, 3).join(', ') + (drifted.length > 3 ? ', …' : '');
    return {
      name: 'eval_drift',
      status: 'ok',
      message: `${drifted.length} retrieval-affecting file(s) changed since HEAD: ${summary}. Re-run \`gbrain eval run-all\` after committing these changes.`,
    };
  } catch (e) {
    return {
      name: 'eval_drift',
      status: 'ok',
      message: `Could not probe retrieval drift (${(e as Error).message ?? 'unknown'}).`,
    };
  }
}

/**
 * v0.31.12 — surface a warn when models.tier.subagent or models.default
 * resolves to a non-Anthropic provider. The subagent loop in
 * src/core/minions/handlers/subagent.ts uses Anthropic Messages API with
 * prompt caching on system + tools; non-Anthropic providers would break
 * the loop at runtime. This check makes the configuration drift visible
 * before a job is submitted.
 */
async function checkSubagentProvider(engine: BrainEngine): Promise<Check> {
  try {
    const { isAnthropicProvider } = await import('../core/model-config.ts');
    const tierSubagent = await engine.getConfig('models.tier.subagent');
    const modelsDefault = await engine.getConfig('models.default');

    // Tier-explicit override loses fail-loud since the user clearly meant it.
    if (tierSubagent && !isAnthropicProvider(tierSubagent)) {
      return {
        name: 'subagent_provider',
        status: 'warn',
        message:
          `models.tier.subagent is "${tierSubagent}" but the subagent loop is Anthropic-only. ` +
          `Runtime will fall back to claude-sonnet-4-6. Fix: ` +
          `\`gbrain config set models.tier.subagent anthropic:claude-sonnet-4-6\`.`,
      };
    }
    // models.default sneaking subagent into a non-Anthropic provider.
    if (!tierSubagent && modelsDefault && !isAnthropicProvider(modelsDefault)) {
      return {
        name: 'subagent_provider',
        status: 'warn',
        message:
          `models.default is "${modelsDefault}" which would route subagent jobs to a non-Anthropic provider. ` +
          `Runtime falls back to claude-sonnet-4-6 for subagent only. ` +
          `Fix: \`gbrain config set models.tier.subagent anthropic:claude-sonnet-4-6\` to lock it in.`,
      };
    }
    return { name: 'subagent_provider', status: 'ok', message: 'Subagent tier resolves to Anthropic' };
  } catch (e) {
    return {
      name: 'subagent_provider',
      status: 'warn',
      message: `Could not check subagent provider: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// Module-scoped flag so the NaN-fallback warning fires once per process.
let _syncFreshnessEnvWarned = false;

function _resolveSyncFreshnessHours(varName: string, fallback: number): number {
  const raw = process.env[varName];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    if (!_syncFreshnessEnvWarned) {
      _syncFreshnessEnvWarned = true;
      console.warn(
        `[gbrain doctor] Ignoring invalid ${varName}=${raw}; using default ${fallback}h.`,
      );
    }
    return fallback;
  }
  return n;
}

/**
 * Sync freshness check (v0.32.4) — verify that sources with local_path have
 * been synced recently. Detects the silent failure mode where `gbrain sync`
 * stopped running and brain search now misses recent pages.
 *
 * Pure staleness check. Reads `sources.last_sync_at` only — no filesystem
 * access. Filesystem-vs-DB drift detection is intentionally out of scope:
 *   - doctorReportRemote runs in the HTTP MCP server (src/commands/serve-http.ts);
 *     walking arbitrary DB-supplied paths from a remote-callable endpoint
 *     crosses a trust boundary (OAuth write scope could mutate local_path).
 *   - Drift detection belongs in `multi_source_drift` which already has
 *     GBRAIN_DRIFT_LIMIT + GBRAIN_DRIFT_TIMEOUT_MS guards.
 *
 * Thresholds (env-overridable, default = 24h warn / 72h fail):
 *   - GBRAIN_SYNC_FRESHNESS_WARN_HOURS
 *   - GBRAIN_SYNC_FRESHNESS_FAIL_HOURS
 * Invalid values (NaN, ≤0) fall back to defaults with a once-per-process warn.
 *
 * Edge cases handled:
 *   - last_sync_at IS NULL → fail "never synced"
 *   - last_sync_at > now() (clock skew / corrupted timestamp) → warn
 *   - mixed sources → highest-severity drives the overall status
 *   - executeRaw throws → outer-catch warn so doctor keeps running
 *
 * Failure messages embed `source.id` so the fix command
 * `gbrain sync --source <id>` matches what the user copy-pastes.
 */
export async function checkSyncFreshness(
  engine: BrainEngine,
  opts?: { nowMs?: number },
): Promise<Check> {
  try {
    const sources = await engine.executeRaw<{
      id: string;
      name: string;
      local_path: string | null;
      last_sync_at: Date | null;
    }>(
      `SELECT id, name, local_path, last_sync_at FROM sources WHERE local_path IS NOT NULL`,
    );

    if (sources.length === 0) {
      return {
        name: 'sync_freshness',
        status: 'ok',
        message: 'No federated sources to sync',
      };
    }

    const warnHours = _resolveSyncFreshnessHours('GBRAIN_SYNC_FRESHNESS_WARN_HOURS', 24);
    const failHours = _resolveSyncFreshnessHours('GBRAIN_SYNC_FRESHNESS_FAIL_HOURS', 72);
    const warnMs = warnHours * 60 * 60 * 1000;
    const failMs = failHours * 60 * 60 * 1000;

    // `opts.nowMs` is a test-only injection seam for the boundary tests.
    // Without it, the two `Date.now()` calls (one in the test's `agoMs`
    // helper, one here) drift apart by microseconds-to-milliseconds, which
    // pushes "exactly 72h ago" above the strict `>` threshold and flips the
    // status from warn to fail (CI-flaky, see PR #1138 ship). Production
    // callers omit `nowMs` and get live wall-clock semantics.
    const now = opts?.nowMs ?? Date.now();
    const issues: string[] = [];
    let hasWarnings = false;
    let hasFailures = false;

    for (const source of sources) {
      // Embed source.id in user-visible messages so `gbrain sync --source <id>`
      // matches what the user copy-pastes. Show display name in parens when set.
      const display = source.name && source.name !== source.id
        ? `'${source.id}' (${source.name})`
        : `'${source.id}'`;

      if (!source.last_sync_at) {
        issues.push(`Source ${display} has never been synced`);
        hasFailures = true;
        continue;
      }

      const lastSync = new Date(source.last_sync_at).getTime();
      const ageMs = now - lastSync;

      if (ageMs < 0) {
        issues.push(
          `Source ${display} has future last_sync_at — clock skew or corrupted timestamp`,
        );
        hasWarnings = true;
        continue;
      }

      const ageHours = Math.floor(ageMs / (1000 * 60 * 60));
      const ageDays = Math.floor(ageHours / 24);

      if (ageMs > failMs) {
        issues.push(`Source ${display} last synced ${ageDays}d ago — brain search is stale!`);
        hasFailures = true;
      } else if (ageMs > warnMs) {
        issues.push(`Source ${display} last synced ${ageHours}h ago`);
        hasWarnings = true;
      }
    }

    if (hasFailures) {
      return {
        name: 'sync_freshness',
        status: 'fail',
        message: `${issues.join('; ')}. Run \`gbrain sync --source <id>\` for each stale source`,
      };
    }
    if (hasWarnings) {
      return {
        name: 'sync_freshness',
        status: 'warn',
        message: `${issues.join('; ')}. Run \`gbrain sync --source <id>\` to refresh`,
      };
    }
    return {
      name: 'sync_freshness',
      status: 'ok',
      message: `All ${sources.length} federated source(s) synced recently`,
    };
  } catch (e) {
    return {
      name: 'sync_freshness',
      status: 'warn',
      message: `Could not check sync freshness: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Run doctor with filesystem-first, DB-second architecture.
 * Filesystem checks (resolver, conformance) run without engine.
 * DB checks run only if engine is provided.
 *
 * `dbSource` is passed only from the `--fast` and DB-unavailable paths in
 * cli.ts so we can emit a precise "why no DB check" message. When null, the
 * user has no DB configured anywhere; otherwise the caller chose --fast or
 * we failed to connect despite a configured URL.
 */
export async function runDoctor(engine: BrainEngine | null, args: string[], dbSource?: DbUrlSource) {
  const jsonOutput = args.includes('--json');
  const fastMode = args.includes('--fast');
  const doFix = args.includes('--fix');
  const dryRun = args.includes('--dry-run');
  const locksMode = args.includes('--locks');

  // --locks is a focused diagnostic: it runs the same pg_stat_activity
  // query that `runMigrations` pre-flight uses, prints any idle-in-tx
  // backends, and exits. Used by a user (or the migrate.ts error 57014
  // message) who just hit a statement_timeout and needs to find the
  // blocker. Referenced from migrate.ts's 57014 diagnostic — that
  // message promised this flag exists.
  if (locksMode) {
    await runLocksCheck(engine, jsonOutput);
    return;
  }

  const checks: Check[] = [];
  let autoFixReport: AutoFixReport | null = null;

  // Progress reporter. `--json` is doctor's own JSON output (list of checks);
  // progress events stay on stderr regardless, gated by the global --quiet /
  // --progress-json flags. On a 52K-page brain the DB checks can take minutes,
  // and without a heartbeat agents can't tell doctor from a hang.
  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));

  // --- Filesystem checks (always run, no DB needed) ---

  // 1. Resolver health
  // Use the same auto-detect as `check-resolvable` so doctor sees a
  // workspace/skills dir reachable via $OPENCLAW_WORKSPACE or
  // ~/.openclaw/workspace, not just a `skills/` walked up from cwd.
  // Read-only variant adds the install-path fallback so a hosted-CLI install
  // run from `~` (e.g., `bun install -g github:garrytan/gbrain && cd ~ &&
  // gbrain doctor`) can still find the bundled skills/ dir without warning.
  const detected = autoDetectSkillsDirReadOnly();
  const skillsDir = detected.dir;
  if (skillsDir) {

    // --fix: run auto-repair BEFORE checkResolvable so the post-fix scan
    // reflects the new state. Auto-fix only targets DRY violations today;
    // other resolver issues are left to human repair.
    //
    // SAFETY GATE (v0.31.7 follow-up to D5): refuse --fix when the skills
    // dir came from the install-path fallback. autoFixDryViolations writes
    // to SKILL.md files; a user running `cd ~ && gbrain doctor --fix`
    // without an explicit signal would have install_path resolve to the
    // bundled gbrain repo and silently rewrite the install-tree skills.
    // Codex caught this leak in the v0.31.7 ship review (D6 lock).
    if (doFix) {
      if (detected.source === 'install_path') {
        process.stderr.write(
          'gbrain doctor --fix refused: skills dir resolved via install-path fallback (read-only).\n' +
          'The --fix flag writes to SKILL.md files; running it against the bundled install\n' +
          'tree would silently mutate gbrain itself. Set $GBRAIN_SKILLS_DIR, $OPENCLAW_WORKSPACE,\n' +
          'or pass --skills-dir <path> to point at the workspace you actually want to fix.\n',
        );
      } else {
        autoFixReport = autoFixDryViolations(skillsDir, { dryRun });
        printAutoFixReport(autoFixReport, dryRun, jsonOutput);
      }
    }

    const report = checkResolvable(skillsDir);
    if (report.errors.length === 0 && report.warnings.length === 0) {
      checks.push({
        name: 'resolver_health',
        status: 'ok',
        message: `${report.summary.total_skills} skills, all reachable`,
      });
    } else {
      const status = report.errors.length > 0 ? 'fail' as const : 'warn' as const;
      const total = report.errors.length + report.warnings.length;
      const check: Check = {
        name: 'resolver_health',
        status,
        message: `${total} issue(s): ${report.errors.length} error(s), ${report.warnings.length} warning(s)`,
        issues: [...report.errors, ...report.warnings].map(i => ({
          type: i.type,
          skill: i.skill,
          action: i.action,
          fix: i.fix,
        })),
      };
      checks.push(check);
    }
  } else {
    checks.push({ name: 'resolver_health', status: 'warn', message: 'Could not find skills directory' });
  }

  // 2. Skill conformance
  if (skillsDir) {
    const conformanceResult = checkSkillConformance(skillsDir);
    checks.push(conformanceResult);
  }

  // 3. Half-migrated Minions detection (filesystem-only).
  // If completed.jsonl has any status:"partial" entry with no later
  // status:"complete" for the same version, the install is mid-migration.
  // Typical cause: v0.11.0 stopgap wrote a partial record but nobody ran
  // `gbrain apply-migrations --yes` afterward. This check fires on every
  // `gbrain doctor` invocation so your OpenClaw's health skill catches it.
  //
  // Forward-progress override: a partial entry for vX.Y.Z is treated as
  // stale (not stuck) if there is a `complete` entry for any vA.B.C >= vX.Y.Z
  // anywhere in the file. The reasoning: if a newer migration successfully
  // landed, the install moved past the older partial — the old record is
  // historical noise from a stopgap that never finished cleanly, but the
  // schema clearly advanced. Without this, every install that went through
  // a v0.11.0 stopgap and then upgraded carries the "MINIONS HALF-INSTALLED"
  // flag forever, even on installs that have been at v0.22+ for months.
  try {
    const completed = loadCompletedMigrations();
    const byVersion = new Map<string, { complete: boolean; partial: boolean }>();
    for (const entry of completed) {
      const seen = byVersion.get(entry.version) ?? { complete: false, partial: false };
      if (entry.status === 'complete') seen.complete = true;
      if (entry.status === 'partial') seen.partial = true;
      byVersion.set(entry.version, seen);
    }
    const completedVersions = Array.from(byVersion.entries())
      .filter(([, s]) => s.complete)
      .map(([v]) => v);
    const stuck = Array.from(byVersion.entries())
      .filter(([v, s]) => {
        if (!s.partial || s.complete) return false;
        // Forward-progress override: if any version >= v has completed, the
        // partial is stale. compareVersions returns 1 when first arg is newer.
        const supersededBy = completedVersions.find(cv => compareVersions(cv, v) >= 0);
        return supersededBy === undefined;
      })
      .map(([v]) => v);

    // v0.31.8 (D19): detect 3-consecutive-partials shape (the apply-migrations
    // wedge condition). The `stuck` filter above already excludes
    // forward-progress-superseded versions, so we only count actual unresolved
    // partials per version. A version with >=3 trailing partials needs
    // `gbrain apply-migrations --force-retry <v>` once before plain --yes
    // will succeed (the 3-consecutive-partials guard in apply-migrations.ts
    // is still active). Without this hint, operators wedged on v0.29.1 (and
    // any future migration that hits the same guard) get "run --yes" advice
    // that won't unstick them.
    const wedged: string[] = [];
    for (const v of stuck) {
      const partialCount = completed.filter(
        e => e.version === v && e.status === 'partial',
      ).length;
      if (partialCount >= 3) wedged.push(v);
    }

    if (wedged.length > 0) {
      // The wedged set is a STRICT subset of the stuck set, so a wedged
      // version is also stuck. Surface the force-retry hint instead of the
      // generic --yes hint; chained with `&&` when multiple versions are
      // wedged so the operator can copy-paste a single line.
      const cmd = wedged.map(v => `gbrain apply-migrations --force-retry ${v}`).join(' && ');
      checks.push({
        name: 'minions_migration',
        status: 'fail',
        message: `WEDGED MIGRATION(s): ${wedged.join(', ')} (>=3 consecutive partials). Run: ${cmd}`,
      });
    } else if (stuck.length > 0) {
      checks.push({
        name: 'minions_migration',
        status: 'fail',
        message: `MINIONS HALF-INSTALLED (partial migration: ${stuck.join(', ')}). Run: gbrain apply-migrations --yes`,
      });
    }
    // Note: the "no preferences.json but schema is v7+" case is detected
    // in the DB section below (needs schema version).
  } catch (e) {
    // completed.jsonl read/parse failure is non-fatal — probably a fresh
    // install with no record yet. Don't warn here; the DB check below
    // handles the "schema v7+ but no prefs" case.
  }

  // 3b. Upgrade-error trail (v0.13+). `gbrain upgrade` silently swallows
  // best-effort failures in `gbrain post-upgrade`; the failure record is
  // appended to ~/.gbrain/upgrade-errors.jsonl so we can surface it here
  // with a paste-ready recovery hint. Without this, users end up with
  // half-upgraded brains and no signal.
  try {
    const home = process.env.HOME || '';
    const errPath = join(home, '.gbrain', 'upgrade-errors.jsonl');
    if (existsSync(errPath)) {
      const lines = readFileSync(errPath, 'utf-8').split('\n').filter(l => l.trim());
      if (lines.length > 0) {
        const latest = JSON.parse(lines[lines.length - 1]) as {
          ts: string; phase: string; from_version: string; to_version: string; hint: string;
        };
        const date = latest.ts.slice(0, 10);
        checks.push({
          name: 'upgrade_errors',
          status: 'warn',
          message: `Post-upgrade failure on ${date} (${latest.from_version} → ${latest.to_version}, phase: ${latest.phase}). Recovery: ${latest.hint}`,
        });
      }
    }
  } catch {
    // Read/parse failure is itself best-effort; skip silently.
  }

  // 3b-bis. Supervisor health (filesystem-only: PID liveness + audit log).
  // Reads the default PID file (`~/.gbrain/supervisor.pid` unless the user
  // overrode with GBRAIN_SUPERVISOR_PID_FILE) and the latest audit file
  // written by src/core/minions/handlers/supervisor-audit.ts. Surfaces
  // supervisor_running / last_start / crashes_24h / max_crashes_exceeded.
  // Does NOT run the supervisor itself — this is a read-only health check.
  try {
    const { DEFAULT_PID_FILE } = await import('../core/minions/supervisor.ts');
    const { readSupervisorEvents, summarizeCrashes } = await import('../core/minions/handlers/supervisor-audit.ts');

    let supervisorPid: number | null = null;
    let running = false;
    if (existsSync(DEFAULT_PID_FILE)) {
      try {
        const line = readFileSync(DEFAULT_PID_FILE, 'utf8').trim().split('\n')[0];
        const parsed = parseInt(line, 10);
        if (!isNaN(parsed) && parsed > 0) {
          supervisorPid = parsed;
          try { process.kill(parsed, 0); running = true; } catch { running = false; }
        }
      } catch { /* unreadable */ }
    }

    const events = readSupervisorEvents({ sinceMs: 24 * 60 * 60 * 1000 });
    const lastStart = events.filter(e => e.event === 'started').pop()?.ts ?? null;
    // Shared classifier — same code path runs in `gbrain jobs supervisor
    // status` (src/commands/jobs.ts). Counts only events whose `likely_cause`
    // is NOT in the clean denylist (clean_exit, graceful_shutdown). Pre-v0.34
    // entries lacking `likely_cause` fall back to `code !== 0`. Supersedes
    // v0.35.4.0's binary `classifyWorkerExit({code})` on this surface: the
    // `likely_cause` read correctly classifies SIGTERM (code=null,
    // likely_cause='graceful_shutdown') as clean, and produces per-cause
    // buckets so operators triage memory pressure (oom) vs code bugs
    // (runtime) without grep'ing JSONL. `classifyWorkerExit` is still
    // used by the supervisor's internal restart policy where the binary
    // shape is the right contract.
    const summary = summarizeCrashes(events);
    const crashes24h = summary.total;
    const causeStr = `runtime=${summary.by_cause.runtime_error} oom=${summary.by_cause.oom_or_external_kill} unknown=${summary.by_cause.unknown} legacy=${summary.by_cause.legacy}`;
    const maxCrashesEvent = events.filter(e => e.event === 'max_crashes_exceeded').pop() ?? null;

    // Only surface a Check if the supervisor was ever observed (stops the
    // "never used the supervisor" install from getting a warn about it).
    if (supervisorPid !== null || events.length > 0) {
      if (maxCrashesEvent) {
        checks.push({
          name: 'supervisor',
          status: 'fail',
          message: `Supervisor gave up at ${maxCrashesEvent.ts} (max_crashes_exceeded). Restart with: gbrain jobs supervisor start --detach`,
        });
      } else if (!running && events.length > 0) {
        checks.push({
          name: 'supervisor',
          status: 'warn',
          message: `Supervisor not running (last_start=${lastStart ?? 'unknown'}). Restart with: gbrain jobs supervisor start --detach`,
        });
      } else if (crashes24h >= 1) {
        // Threshold dropped from `>3` (pre-fix, inflated by clean exits being
        // miscounted) to `>=1` (any real crash is signal). Per-cause breakdown
        // gives operators triage context without grep'ing the JSONL.
        checks.push({
          name: 'supervisor',
          status: 'warn',
          message: `Worker crashed ${crashes24h}x in last 24h (${causeStr}). Check ~/.gbrain/audit/supervisor-*.jsonl for context.`,
        });
      } else {
        checks.push({
          name: 'supervisor',
          status: 'ok',
          message: `running=true pid=${supervisorPid} last_start=${lastStart ?? 'unknown'} crashes_24h=${crashes24h} clean_exits_24h=${summary.clean_exits}`,
        });
      }
    }
  } catch {
    // Audit read / import failure is best-effort; skip silently.
  }

  // 3b-tris. Stub-guard fire count (last 24h). The v0.34.5 stub guard in
  // fence-write.ts refuses to spawn unprefixed entity pages (e.g. bare
  // `alice.md` at brain root). Each fire is appended to
  // ~/.gbrain/audit/stub-guard-YYYY-Www.jsonl. This check is the operator
  // visibility surface for the guard's v0.36 sunset criterion: when the
  // 24h count is consistently low, the prefix-expansion in
  // resolveEntitySlug is doing its job and the guard can be removed.
  //
  // WARN at >10 fires/24h — at that rate the resolver is probably missing
  // a case (typo prefix, alias, non-Latin script). Operators should grep
  // the audit log for the slugs that hit it and either add the missing
  // resolver branch or document them as legitimate bare-slug ingestion.
  try {
    const { readRecentStubGuardEvents } = await import('../core/facts/stub-guard-audit.ts');
    const events = readRecentStubGuardEvents({ sinceMs: 24 * 60 * 60 * 1000 });
    if (events.length > 10) {
      // Surface the top 3 slugs that hit it so operators have somewhere to start.
      const slugCounts = new Map<string, number>();
      for (const e of events) slugCounts.set(e.slug, (slugCounts.get(e.slug) ?? 0) + 1);
      const topSlugs = [...slugCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([slug, n]) => `${slug}(${n})`)
        .join(', ');
      checks.push({
        name: 'stub_guard_24h',
        status: 'warn',
        message:
          `Stub guard fired ${events.length}x in last 24h (top: ${topSlugs}). ` +
          `If this stays elevated, the prefix-expansion in resolveEntitySlug is ` +
          `missing a case. Check ~/.gbrain/audit/stub-guard-*.jsonl for the slugs ` +
          `that hit it.`,
      });
    } else if (events.length > 0) {
      checks.push({
        name: 'stub_guard_24h',
        status: 'ok',
        message: `Stub guard fired ${events.length}x in last 24h (below WARN threshold of 10).`,
      });
    }
    // Zero hits is the goal — emit no check at all so the doctor output stays clean.
  } catch {
    // Audit read failure is best-effort; skip silently.
  }

  // 3c. Sync failure trail (Bug 9). sync.ts gates the `sync.last_commit`
  // bookmark when per-file parse errors happen, and appends each failure
  // to ~/.gbrain/sync-failures.jsonl with the commit hash + exact error.
  // Without this doctor check, users see "sync blocked" and have no
  // surface showing which files to fix.
  try {
    const { unacknowledgedSyncFailures, loadSyncFailures, summarizeFailuresByCode } = await import('../core/sync.ts');
    const unacked = unacknowledgedSyncFailures();
    const all = loadSyncFailures();
    if (unacked.length > 0) {
      const codeSummary = summarizeFailuresByCode(unacked);
      const codeBreakdown = codeSummary.map(s => `${s.code}=${s.count}`).join(', ');
      const preview = unacked.slice(0, 3).map(f => `${f.path} (${f.error.slice(0, 60)})`).join('; ');
      checks.push({
        name: 'sync_failures',
        status: 'warn',
        message:
          `${unacked.length} unacknowledged sync failure(s) [${codeBreakdown}]. ${preview}` +
          `${unacked.length > 3 ? `, and ${unacked.length - 3} more` : ''}. ` +
          `Fix the file(s) and re-run 'gbrain sync', or use 'gbrain sync --skip-failed' to acknowledge.`,
      });
    } else if (all.length > 0) {
      // Acknowledged-only: show code breakdown for visibility.
      const ackedSummary = summarizeFailuresByCode(all);
      const ackedBreakdown = ackedSummary.map(s => `${s.code}=${s.count}`).join(', ');
      checks.push({
        name: 'sync_failures',
        status: 'ok',
        message: `${all.length} historical sync failure(s), all acknowledged [${ackedBreakdown}].`,
      });
    }
  } catch {
    // Best-effort. A broken JSONL should not stop doctor.
  }

  // 3d. Slug-fallback audit (v0.32.7 CJK wave, codex C7). Informational
  // count of pages where importFromFile fell back to a frontmatter slug
  // because the path slugified empty (emoji / Thai / Arabic / exotic-script
  // filenames). NOT routed through sync-failures.jsonl — that surface
  // gates bookmark advancement, info rows don't fit there.
  try {
    const { readRecentSlugFallbacks } = await import('../core/audit-slug-fallback.ts');
    const fallbacks = readRecentSlugFallbacks(7);
    if (fallbacks.length > 0) {
      checks.push({
        name: 'slug_fallback_audit',
        status: 'ok',
        message: `info: ${fallbacks.length} slug fallback${fallbacks.length === 1 ? '' : 's'} in the last 7 days (SLUG_FALLBACK_FRONTMATTER).`,
      });
    }
  } catch {
    // Best-effort; audit-log read failure shouldn't stop doctor.
  }

  // 3e. home_dir_in_worktree (v0.35.8.0). Walks up from `gbrainPath()`
  // looking for a `.git` directory OR file. If found, warns: `~/.gbrain/`
  // lives inside a git worktree, so an accidental `git add` from the
  // worktree root could stage the brain. Pairs with the retroactive
  // `~/.gbrain/.gitignore` (single-line `*`) laid down by saveConfig +
  // post-upgrade. Honest scope: the .gitignore covers casual `git add`
  // but NOT already-tracked files, screenshots, backups, or `git add -f`.
  //
  // Walk termination: stops at $HOME (don't keep walking into / on a user
  // who set GBRAIN_HOME=/tmp/something). Handles `.git` as both a directory
  // (main repo) and a file (linked worktree pointing at parent's worktrees/).
  // Honors GBRAIN_HOME via gbrainPath().
  try {
    const gbrainHome = gbrainPath();
    const home = process.env.HOME || '';
    let worktreeRoot: string | null = null;
    if (gbrainHome && home && gbrainHome.startsWith(home + '/')) {
      // Walk up from gbrainHome's parent toward $HOME, stopping at $HOME.
      // We don't check gbrainHome itself: a `.git` directly inside ~/.gbrain
      // isn't a containing-worktree, it would be a brain repo cloned there.
      let cur = dirname(gbrainHome);
      while (cur && cur.length >= home.length) {
        const gitPath = join(cur, '.git');
        try {
          const st = statSync(gitPath);
          // Either a directory (main repo) or a file (linked worktree pointer).
          if (st.isDirectory() || st.isFile()) {
            worktreeRoot = cur;
            break;
          }
        } catch {
          // No .git at this level; continue.
        }
        if (cur === home) break;
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
    }
    if (worktreeRoot) {
      const homeEnvHint = process.env.GBRAIN_HOME
        ? `# Or move \`~/.gbrain\` outside the worktree by setting GBRAIN_HOME elsewhere.`
        : `# Fix: \`export GBRAIN_HOME=/some/path/outside/the/worktree\` (gbrain appends \`.gbrain\`).`;
      checks.push({
        name: 'home_dir_in_worktree',
        status: 'warn',
        message:
          `~/.gbrain lives inside git worktree at ${worktreeRoot}. ` +
          `Config + brain DB could be committed by accident. ` +
          `A retroactive ~/.gbrain/.gitignore blocks casual \`git add\`, but does NOT cover ` +
          `already-tracked files, screenshots, backups, or \`git add -f\`. ${homeEnvHint}`,
      });
    } else {
      checks.push({
        name: 'home_dir_in_worktree',
        status: 'ok',
        message: 'gbrain home is outside any enclosing git worktree.',
      });
    }
  } catch {
    // Best-effort filesystem-hygiene check; never block doctor.
  }

  // 3b-multi-source. Multi-source drift (v0.31.8 — D8 + D17 + OV12 + OV13).
  // Pre-v0.30.3 putPage misrouted multi-source writes to (default, slug).
  // For each non-default source with local_path set, walk the FS and surface
  // slugs that exist at default but NOT at the intended source. Only runs
  // on multi-source brains (sources count > 1). Single-source brains skip.
  // Engine is nullable in runDoctor (--fast / DB-down skip the DB phase);
  // bail silently here when engine is null since the check needs DB access.
  if (engine !== null) try {
    const { findMisroutedPages } = await import('../core/multi-source-drift.ts');
    const sources = await engine!.executeRaw<{ id: string; local_path: string | null }>(
      `SELECT id, local_path FROM sources`,
    );
    const nonDefaultWithPath = sources.filter(s => s.id !== 'default' && s.local_path);
    if (sources.length > 1 && nonDefaultWithPath.length > 0) {
      const result = await findMisroutedPages(
        engine!,
        nonDefaultWithPath.map(s => ({ id: s.id, local_path: s.local_path as string })),
      );
      if (result.walk_truncated) {
        checks.push({
          name: 'multi_source_drift',
          status: 'warn',
          message:
            `Multi-source drift check skipped — FS walk hit limit/timeout. ` +
            `Re-run on a quieter brain or shorter walk via GBRAIN_DRIFT_LIMIT/GBRAIN_DRIFT_TIMEOUT_MS.`,
        });
      } else if (result.count > 0) {
        const sampleStr = result.sample.map(s => `${s.slug} (intended=${s.intended_source})`).join(', ');
        checks.push({
          name: 'multi_source_drift',
          status: 'warn',
          message:
            `${result.count} page slug(s) appear at 'default' but NOT at the intended source ` +
            `(e.g., ${sampleStr}). Two possible causes: (1) pre-v0.30.3 putPage misroutes; ` +
            `(2) source X never completed initial sync and the default page is unrelated. ` +
            `Verify with 'gbrain sources status', then either re-sync with ` +
            `'gbrain sync --source <id> --full' or 'gbrain delete <slug>' if the default-source ` +
            `row is the misroute. (A 'gbrain sources rehome' cleanup command is tracked for v0.32.0.)`,
        });
      } else {
        checks.push({
          name: 'multi_source_drift',
          status: 'ok',
          message: 'No cross-source slug drift detected.',
        });
      }
    }
  } catch {
    // Best-effort. A broken sources table or unreadable local_path should
    // not stop doctor. The walk itself catches per-directory errors; this
    // outer try covers the executeRaw path.
  }

  // 3c. Orphan clone temp dirs (v0.28 P1). `gbrain sources add --url` clones
  // into $GBRAIN_HOME/clones/.tmp/<id>-<rand>/ and renames atomically; if the
  // process is SIGKILL'd between clone-finish and rename, the temp dir
  // orphans. Surface entries older than 24h so operators notice before the
  // disk fills. The autopilot purge phase nukes these on its cadence; this
  // check just makes the state visible.
  try {
    const fs = await import('fs');
    const cfg = await import('../core/config.ts');
    const tmpRoot = cfg.gbrainPath('clones', '.tmp');
    if (fs.existsSync(tmpRoot)) {
      const STALE_MS = 24 * 3600 * 1000;
      const now = Date.now();
      const stale: { name: string; ageHours: number }[] = [];
      for (const ent of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
        const full = join(tmpRoot, ent.name);
        try {
          const st = fs.lstatSync(full);
          const age = now - st.mtimeMs;
          if (age > STALE_MS) {
            stale.push({ name: ent.name, ageHours: Math.floor(age / 3600_000) });
          }
        } catch {
          /* skip unreadable */
        }
      }
      if (stale.length === 0) {
        checks.push({
          name: 'orphan_clones',
          status: 'ok',
          message: `No stale clone temp dirs in ${tmpRoot}.`,
        });
      } else {
        checks.push({
          name: 'orphan_clones',
          status: 'warn',
          message:
            `${stale.length} stale clone temp dir(s) in ${tmpRoot}: ` +
            stale.map(s => `${s.name} (${s.ageHours}h)`).join(', ') +
            `. Run \`gbrain sources purge-orphan-clones\` or wait for the autopilot purge phase.`,
        });
      }
    }
  } catch {
    // Filesystem read failure is non-fatal.
  }

  // --- DB checks (skip if --fast or no engine) ---

  if (fastMode || !engine) {
    if (!engine) {
      // Pick the precise message. When dbSource is provided, we know
      // whether a URL exists (env or config-file) — the caller simply
      // skipped the connection. When null, there really is no config
      // anywhere.
      let msg: string;
      if (fastMode && dbSource) {
        msg = `Skipping DB checks (--fast mode, URL present from ${dbSource})`;
      } else if (!fastMode && dbSource) {
        msg = `Could not connect to configured DB (URL from ${dbSource}); filesystem checks only`;
      } else {
        msg = 'No database configured (filesystem checks only). Set GBRAIN_DATABASE_URL or run `gbrain init`.';
      }
      checks.push({ name: 'connection', status: 'warn', message: msg });
    }
    const earlyFail1 = outputResults(checks, jsonOutput);
    process.exit(earlyFail1 ? 1 : 0);
    return;
  }

  // DB checks phase — start a single reporter phase so agents see which
  // check is running (several take seconds on 50K-page brains; without a
  // heartbeat the binary looks hung when stdout is piped).
  progress.start('doctor.db_checks');

  // 3. Connection
  progress.heartbeat('connection');
  try {
    const stats = await engine.getStats();
    checks.push({ name: 'connection', status: 'ok', message: `Connected, ${stats.page_count} pages` });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ name: 'connection', status: 'fail', message: msg });
    progress.finish();
    const earlyFail2 = outputResults(checks, jsonOutput);
    process.exit(earlyFail2 ? 1 : 0);
    return;
  }

  // 4. pgvector extension
  progress.heartbeat('pgvector');
  try {
    const sql = db.getConnection();
    const ext = await sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    if (ext.length > 0) {
      checks.push({ name: 'pgvector', status: 'ok', message: 'Extension installed' });
    } else {
      checks.push({ name: 'pgvector', status: 'fail', message: 'Extension not found. Run: CREATE EXTENSION vector;' });
    }
  } catch {
    checks.push({ name: 'pgvector', status: 'warn', message: 'Could not check pgvector extension' });
  }

  // 4b. PgBouncer / prepared-statement compatibility.
  // URL-only inspection — no DB roundtrip — so this is cheap and works
  // regardless of whether the caller is the module singleton or a
  // worker-instance engine.
  progress.heartbeat('pgbouncer_prepare');
  try {
    const { resolvePrepare } = await import('../core/db.ts');
    const { loadConfig } = await import('../core/config.ts');
    const config = loadConfig();
    const url = config?.database_url || '';
    const prepare = resolvePrepare(url);
    if (prepare === false) {
      checks.push({
        name: 'pgbouncer_prepare',
        status: 'ok',
        message: 'Prepared statements disabled (PgBouncer-safe)',
      });
    } else {
      try {
        const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
        if (parsed.port === '6543') {
          checks.push({
            name: 'pgbouncer_prepare',
            status: 'warn',
            message:
              'Port 6543 (PgBouncer transaction mode) detected but prepared statements are enabled. ' +
              'This causes "prepared statement does not exist" errors under concurrent load. ' +
              'Fix: unset GBRAIN_PREPARE (or set =false), or add ?prepare=false to the connection URL.',
          });
        }
      } catch {
        // URL parse failure — skip, nothing actionable
      }
    }
  } catch {
    // best-effort; never fail doctor on this check
  }

  // 5. RLS — check ALL public tables, not just gbrain's own.
  // Any table without RLS in the public schema is a security risk:
  // Supabase exposes the public schema via PostgREST, so tables without
  // RLS are readable/writable by anyone with the anon key.
  //
  // Escape hatch ("write it in blood"): if a user or plugin deliberately
  // wants a public-schema table readable by the anon key (analytics,
  // materialized views the anon key needs), they can exempt it with a
  // Postgres COMMENT whose value starts with:
  //
  //     GBRAIN:RLS_EXEMPT reason=<non-empty reason>
  //
  // The comment lives in pg_description, survives pg_dump, is visible in
  // schema diffs, and requires raw SQL in psql to set — there is no
  // `gbrain rls-exempt add` CLI on purpose. Doctor re-enumerates the
  // exemption list on every successful run so exempt tables never go
  // invisible. See docs/guides/rls-and-you.md.
  progress.heartbeat('rls');
  if (engine.kind === 'pglite') {
    // PGLite is embedded and single-user — no PostgREST exposure,
    // RLS is not a meaningful security boundary here.
    checks.push({
      name: 'rls',
      status: 'ok',
      message: 'Skipped (PGLite — no PostgREST exposure, RLS not applicable)',
    });
  } else {
    try {
      const sql = db.getConnection();
      // Left-join pg_description so we get the (optional) COMMENT ON TABLE
      // value alongside rowsecurity in a single round-trip. Filter to
      // base tables in the public schema.
      const tables = await sql`
        SELECT
          t.tablename,
          t.rowsecurity,
          COALESCE(
            obj_description(format('public.%I', t.tablename)::regclass, 'pg_class'),
            ''
          ) AS comment
        FROM pg_tables t
        WHERE t.schemaname = 'public'
      `;
      const EXEMPT_RE = /^GBRAIN:RLS_EXEMPT\s+reason=\S.{3,}/;
      const exempt: string[] = [];
      const gaps: string[] = [];
      for (const t of tables as Array<any>) {
        if (t.rowsecurity) continue;
        if (EXEMPT_RE.test(t.comment || '')) {
          exempt.push(t.tablename);
        } else {
          gaps.push(t.tablename);
        }
      }
      if (gaps.length === 0) {
        const suffix = exempt.length > 0
          ? ` (${exempt.length} explicitly exempt: ${exempt.join(', ')})`
          : '';
        checks.push({
          name: 'rls',
          status: 'ok',
          message: `RLS enabled on ${tables.length - exempt.length}/${tables.length} public tables${suffix}`,
        });
      } else {
        const names = gaps.join(', ');
        // Double-escape " inside identifiers so a pathological table name
        // like `weird"table` renders as `"weird""table"` in the remediation
        // SQL (matches how Postgres parses quoted identifiers). Doubling
        // any existing " is the minimum needed to keep the output valid
        // copy-paste SQL. Extremely rare in practice but cheap to get right.
        const fixes = gaps
          .map(n => `ALTER TABLE "public"."${n.replace(/"/g, '""')}" ENABLE ROW LEVEL SECURITY;`)
          .join(' ');
        const exemptInfo = exempt.length > 0
          ? ` (${exempt.length} other table(s) explicitly exempt.)`
          : '';
        checks.push({
          name: 'rls',
          status: 'fail',
          message:
            `${gaps.length} table(s) WITHOUT Row Level Security: ${names}.${exemptInfo} ` +
            `Fix: ${fixes} ` +
            `If a table should stay readable by the anon key on purpose, see docs/guides/rls-and-you.md for the GBRAIN:RLS_EXEMPT comment escape hatch.`,
        });
      }
    } catch {
      checks.push({ name: 'rls', status: 'warn', message: 'Could not check RLS status' });
    }
  }

  // 6. Schema version — also surfaces the #218 "postinstall silently failed"
  // state: if schema_version is 0/missing but the DB connected, migrations
  // never ran. That's the same class as a half-migrated install, just from a
  // different root cause (Bun blocked our top-level postinstall on global
  // install). Message is actionable either way.
  progress.heartbeat('schema_version');
  let schemaVersion = 0;
  try {
    const version = await engine.getConfig('version');
    schemaVersion = parseInt(version || '0', 10);
    if (schemaVersion >= LATEST_VERSION) {
      checks.push({ name: 'schema_version', status: 'ok', message: `Version ${schemaVersion} (latest: ${LATEST_VERSION})` });
    } else if (schemaVersion === 0) {
      checks.push({
        name: 'schema_version',
        status: 'fail',
        message: `No schema version recorded. Migrations never ran. Fix: gbrain apply-migrations --yes. ` +
                 `If you installed via 'bun install -g github:...', see https://github.com/garrytan/gbrain/issues/218.`,
      });
    } else {
      checks.push({
        name: 'schema_version',
        status: 'warn',
        message: `Version ${schemaVersion}, latest is ${LATEST_VERSION}. Fix: gbrain apply-migrations --yes`,
      });
    }
  } catch {
    checks.push({ name: 'schema_version', status: 'warn', message: 'Could not check schema version' });
  }

  // Note: we intentionally DO NOT fail on "schema v7+ but no preferences.json".
  // That's a valid fresh-install state after `gbrain init` — the migration
  // orchestrator writes preferences, but `init` alone doesn't run it. The
  // partial-completed.jsonl check in the filesystem section (step 3) is
  // the canonical half-migration signal and fires when the stopgap ran
  // but `apply-migrations` didn't follow up.

  // 7. RLS event trigger (post-install drift detector for v35 auto-RLS).
  // Catches the case where an operator manually drops the trigger to debug
  // something and forgets to recreate it. Does NOT catch install-time silent
  // failure — runMigrations rethrows on SQL failure and only bumps
  // config.version after success, so a failed v35 install means version
  // stays at 34 and check #6 (schema_version) fires loudly.
  //
  // Healthy evtenabled values: 'O' (origin) and 'A' (always). 'R' is
  // replica-only and would NOT fire in normal origin sessions; 'D' is
  // disabled. Both of those are warn states.
  progress.heartbeat('rls_event_trigger');
  if (engine.kind === 'pglite') {
    checks.push({
      name: 'rls_event_trigger',
      status: 'ok',
      message: 'Skipped (PGLite — no event trigger support)',
    });
  } else {
    try {
      const sql = db.getConnection();
      const rows = await sql`
        SELECT evtname, evtenabled FROM pg_event_trigger
        WHERE evtname = 'auto_rls_on_create_table'
      `;
      if (rows.length === 0) {
        checks.push({
          name: 'rls_event_trigger',
          status: 'warn',
          message:
            'Auto-RLS event trigger missing. New tables created outside gbrain may not get RLS. ' +
            'Fix: gbrain apply-migrations --force-retry 35',
        });
      } else if (rows[0].evtenabled !== 'O' && rows[0].evtenabled !== 'A') {
        checks.push({
          name: 'rls_event_trigger',
          status: 'warn',
          message:
            `Auto-RLS event trigger present but evtenabled=${rows[0].evtenabled} ` +
            `(not origin/always). Trigger will not fire in normal sessions. ` +
            `Fix: ALTER EVENT TRIGGER auto_rls_on_create_table ENABLE;`,
        });
      } else {
        checks.push({
          name: 'rls_event_trigger',
          status: 'ok',
          message: 'Auto-RLS event trigger installed',
        });
      }
    } catch {
      checks.push({
        name: 'rls_event_trigger',
        status: 'warn',
        message: 'Could not check RLS event trigger',
      });
    }
  }

  // 8. Embedding health
  progress.heartbeat('embeddings');
  try {
    const health = await engine.getHealth();
    const pct = (health.embed_coverage * 100).toFixed(0);
    if (health.embed_coverage >= 0.9) {
      checks.push({ name: 'embeddings', status: 'ok', message: `${pct}% coverage, ${health.missing_embeddings} missing` });
    } else if (health.embed_coverage > 0) {
      checks.push({ name: 'embeddings', status: 'warn', message: `${pct}% coverage, ${health.missing_embeddings} missing. Run: gbrain embed --stale` });
    } else {
      checks.push({ name: 'embeddings', status: 'warn', message: 'No embeddings yet. Run: gbrain embed --stale' });
    }
  } catch {
    checks.push({ name: 'embeddings', status: 'warn', message: 'Could not check embedding health' });
  }

  // 8b. Embedding provider eval — live smoke test of the configured provider.
  //     Verifies: correct model, API key works, dimensions match config, DB column matches.
  progress.heartbeat('embedding_provider');
  try {
    const {
      getEmbeddingModel,
      getEmbeddingDimensions,
      embedOne,
      isAvailable,
    } = await import('../core/ai/gateway.ts');

    const configuredModel = getEmbeddingModel();
    const configuredDims = getEmbeddingDimensions();
    const available = isAvailable('embedding');

    if (!available) {
      // Per v0.28.5 plan P1: silently skipped when no API key is configured.
      // Doctor must stay green on CI / local-only / offline environments where
      // a full provider probe isn't possible. The skipped status is still
      // visible in --json output so operators can see it ran.
      checks.push({
        name: 'embedding_provider',
        status: 'ok',
        message: `Skipped (no provider credentials). Model: ${configuredModel}.`,
      });
    } else {
      // Live embed test
      const start = Date.now();
      const vec = await embedOne('gbrain doctor embedding smoke test');
      const ms = Date.now() - start;
      const actualDims = vec.length;

      const issues: string[] = [];

      // Check dimensions match config
      if (actualDims !== configuredDims) {
        issues.push(`Dimension mismatch: provider returned ${actualDims} but config expects ${configuredDims}`);
      }

      // Check DB column dimensions match (engine-portable; works on both
      // Postgres and PGLite via the shared dim-check helper added in v0.28.5).
      try {
        const { readContentChunksEmbeddingDim } = await import('../core/embedding-dim-check.ts');
        const colDim = await readContentChunksEmbeddingDim(engine);
        if (colDim.exists && colDim.dims !== null && colDim.dims !== actualDims) {
          issues.push(`DB dimension mismatch: column is vector(${colDim.dims}) but provider returns ${actualDims}-dim. See docs/embedding-migrations.md for the manual ALTER recipe.`);
        }
      } catch { /* column or table missing — fresh brain, fine */ }

      if (issues.length > 0) {
        checks.push({
          name: 'embedding_provider',
          status: 'warn',
          message: `${configuredModel} responds (${ms}ms, ${actualDims} dims) but: ${issues.join('; ')}`,
        });
      } else {
        checks.push({
          name: 'embedding_provider',
          status: 'ok',
          message: `${configuredModel} ✓ ${ms}ms, ${actualDims} dims, DB aligned`,
        });
      }
    }
  } catch (e: any) {
    // Per v0.28.5 plan P1: non-fatal on network failure. The probe surfaces
    // the issue but doesn't fail doctor — common cases (rate limit, transient
    // 5xx, DNS blip, expired key) shouldn't take down a CI run.
    checks.push({
      name: 'embedding_provider',
      status: 'warn',
      message: `Embedding provider probe failed: ${e.message?.slice(0, 200) ?? e}`,
    });
  }

  // 8c. Alternative provider advisory (v0.32 D11=C / Codex finding #2 wire-through).
  // Walks listRecipes() and surfaces any recipe whose required env vars are ALL
  // set in the process env but is not the currently configured provider. Helps
  // users discover that, e.g., OPENAI_API_KEY=x DASHSCOPE_API_KEY=y means they
  // have a Chinese-region alternative ready to go without setup.
  progress.heartbeat('alternative_providers');
  try {
    const { listRecipes } = await import('../core/ai/recipes/index.ts');
    const { getEmbeddingModel } = await import('../core/ai/gateway.ts');
    const configuredId = (getEmbeddingModel() || '').split(':')[0];
    const alternatives: string[] = [];
    for (const r of listRecipes()) {
      if (r.id === configuredId) continue;
      const required = r.auth_env?.required ?? [];
      // Skip recipes with no required env (they're "always available" — not a
      // useful signal) and recipes that require env we don't have.
      if (required.length === 0) continue;
      const allPresent = required.every(k => !!process.env[k]);
      if (!allPresent) continue;
      // Skip recipes without an embedding touchpoint (chat-only — not an
      // embedding alternative).
      if (!r.touchpoints.embedding) continue;
      alternatives.push(r.id);
    }
    if (alternatives.length > 0) {
      checks.push({
        name: 'alternative_providers',
        status: 'ok',
        message: `Detected ${alternatives.length} alternative embedding provider${alternatives.length > 1 ? 's' : ''} ready to use: ${alternatives.join(', ')}. Run \`gbrain providers list\` to switch.`,
      });
    }
  } catch { /* listRecipes / gateway not available — silent */ }

  // 8c. Embedding column registry (v0.36 — D5 + D13 + D14).
  //     Validates every column in the merged registry against the real DB
  //     shape: (a) column exists, (b) declared type+dims match actual
  //     format_type(atttypid, atttypmod), (c) HNSW index present on
  //     Postgres, (d) the ACTIVE default column has >= 90% coverage.
  //
  //     Batch probes (D5) so the registry can grow without N+1 round-trips:
  //     one format_type query, one pg_indexes query, one coverage-per-active
  //     column query.
  progress.heartbeat('embedding_column_registry');
  try {
    const { getEmbeddingColumnRegistry, resolveEmbeddingColumn, quoteIdentifier } =
      await import('../core/search/embedding-column.ts');
    const { loadConfig: _loadConfig } = await import('../core/config.ts');
    const fileCfg = _loadConfig();
    const mergedCfg = fileCfg ? await (await import('../core/config.ts')).loadConfigWithEngine(engine, fileCfg).catch(() => fileCfg) : null;
    if (!mergedCfg) {
      checks.push({
        name: 'embedding_column_registry',
        status: 'ok',
        message: 'No brain config loaded — skipped',
      });
    } else {
      const registry = getEmbeddingColumnRegistry(mergedCfg);
      const declaredColumns = Object.keys(registry);
      const activeCol = resolveEmbeddingColumn(undefined, mergedCfg).name;

      // D13 — batch format_type probe via pg_attribute. udt_name only
      // returns 'vector' vs 'halfvec'; format_type(atttypid, atttypmod)
      // returns 'vector(1024)' / 'halfvec(2560)' so dim drift surfaces.
      const formatRows = await engine.executeRaw<{ attname: string; formatted: string }>(
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS formatted
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = 'content_chunks'
            AND a.attname = ANY($1::text[])
            AND NOT a.attisdropped`,
        [declaredColumns],
      );
      const actualByName = new Map<string, string>();
      for (const r of formatRows) actualByName.set(r.attname, r.formatted);

      // D5 — batch index probe (Postgres only; PGLite indexing is implicit
      // and the partial-index pattern doesn't surface in pg_indexes the
      // same way). Reports informational, not blocking — search still
      // works without an HNSW index, just slow.
      const haveIndex = new Map<string, boolean>();
      if (engine.kind === 'postgres') {
        const indexRows = await engine.executeRaw<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes
            WHERE tablename = 'content_chunks'
              AND schemaname = 'public'`,
        );
        for (const col of declaredColumns) {
          const found = indexRows.some(r => /USING\s+hnsw/i.test(r.indexdef) && r.indexdef.includes(`(${col} `));
          haveIndex.set(col, found);
        }
      }

      // Per-column health rollup.
      const issues: string[] = [];
      const okColumns: string[] = [];
      for (const colName of declaredColumns) {
        const entry = registry[colName];
        const actual = actualByName.get(colName);
        if (!actual) {
          issues.push(`${colName}: declared but column does NOT exist in content_chunks`);
          continue;
        }
        // Expected format: `vector(N)` or `halfvec(N)`.
        const m = actual.match(/^(vector|halfvec)\((\d+)\)/i);
        const actualType = m ? m[1].toLowerCase() : actual;
        const actualDims = m ? parseInt(m[2], 10) : null;
        if (actualType !== entry.type) {
          issues.push(
            `${colName}: declared type=${entry.type} but actual is ${actual}. ` +
              `Fix: gbrain config set embedding_columns '<JSON>' OR ` +
              `ALTER TABLE content_chunks ALTER COLUMN ${colName} TYPE ${entry.type}(${entry.dimensions});`,
          );
          continue;
        }
        if (actualDims !== null && actualDims !== entry.dimensions) {
          issues.push(
            `${colName}: declared dims=${entry.dimensions} but actual is ${actual}. ` +
              `Fix one side: update config OR ` +
              `ALTER TABLE content_chunks ALTER COLUMN ${colName} TYPE ${entry.type}(${entry.dimensions});`,
          );
          continue;
        }
        if (engine.kind === 'postgres' && haveIndex.get(colName) === false) {
          issues.push(
            `${colName}: no HNSW index. Search works but uses sequential scan. ` +
              `Fix: CREATE INDEX IF NOT EXISTS idx_chunks_${colName} ON content_chunks USING hnsw (${quoteIdentifier(colName)} ${entry.type}_cosine_ops);`,
          );
          continue;
        }
        okColumns.push(colName);
      }

      // D14 — coverage gate on the ACTIVE default column. Catches the
      // "user switched to a 5%-populated column" silent-degradation case.
      let coverageWarn: string | null = null;
      if (activeCol && actualByName.has(activeCol)) {
        // Codex /ship #5: pull `total` alongside `pct` so a fresh brain
        // (0 chunks → NULLIF makes pct NULL → coalesces to 0) doesn't
        // false-warn "Active column 'embedding' is 0.0% populated".
        const covRows = await engine.executeRaw<{ pct: number; total: number }>(
          `SELECT (
             COUNT(*) FILTER (WHERE ${quoteIdentifier(activeCol)} IS NOT NULL)::float
             / NULLIF(COUNT(*), 0) * 100
           )::float AS pct,
           COUNT(*)::int AS total
           FROM content_chunks`,
        );
        const pct = covRows[0]?.pct ?? 0;
        const total = covRows[0]?.total ?? 0;
        // Only warn when there's a real coverage gap. Empty brain (0 chunks)
        // is a normal state for new installs — skip the gate entirely.
        if (total > 0 && pct < 90) {
          coverageWarn =
            `Active column '${activeCol}' is ${pct.toFixed(1)}% populated. ` +
            `Search quality silently degraded on un-embedded chunks. ` +
            `Fix: gbrain embed --column ${activeCol} --stale (write-side support v2) ` +
            `OR gbrain config set search_embedding_column embedding`;
        }
      }

      if (issues.length === 0 && !coverageWarn) {
        const indexNote = engine.kind === 'postgres' ? ' (all indexed)' : '';
        checks.push({
          name: 'embedding_column_registry',
          status: 'ok',
          message: `Registry healthy: ${okColumns.length} columns (${okColumns.join(', ')})${indexNote}; active='${activeCol}'`,
        });
      } else {
        const allMessages = [
          ...issues,
          ...(coverageWarn ? [coverageWarn] : []),
        ];
        checks.push({
          name: 'embedding_column_registry',
          status: 'warn',
          message: allMessages.join(' | '),
        });
      }
    }
  } catch (err) {
    // Pre-config brains, registry-validation throws, etc. Surfaces the
    // error message but doesn't fail the doctor run.
    checks.push({
      name: 'embedding_column_registry',
      status: 'warn',
      message: `Could not check embedding column registry: ${(err as Error).message}`,
    });
  }

  // 9. Graph health (link + timeline coverage on entity pages).
  // dead_links removed in v0.10.1: ON DELETE CASCADE on link FKs makes it always 0.
  //
  // Skip when the brain has 0 entity pages (markdown-only wikis, journals,
  // notes brains). The coverage formula divides by entity-page count, so it's
  // structurally undefined when no entities exist — emitting WARN under that
  // condition is a false positive. Closes #530.
  progress.heartbeat('graph_coverage');
  try {
    const health = await engine.getHealth();
    const entityCount = (await engine.executeRaw<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM pages WHERE type IN ('entity', 'person', 'company', 'organization')",
    ))[0]?.count ?? 0;

    const linkPct = ((health.link_coverage ?? 0) * 100).toFixed(0);
    const timelinePct = ((health.timeline_coverage ?? 0) * 100).toFixed(0);
    if (entityCount === 0) {
      // Markdown-only / journal / wiki brain — no entity pages to compute
      // coverage against. Coverage formula is structurally inapplicable.
      checks.push({
        name: 'graph_coverage',
        status: 'ok',
        message: 'No entity pages — graph_coverage not applicable (markdown-only brain)',
      });
    } else if ((health.link_coverage ?? 0) >= 0.5 && (health.timeline_coverage ?? 0) >= 0.5) {
      checks.push({ name: 'graph_coverage', status: 'ok', message: `Entity link coverage ${linkPct}%, timeline ${timelinePct}%` });
    } else {
      checks.push({
        name: 'graph_coverage',
        status: 'warn',
        message: `Entity link coverage ${linkPct}%, timeline ${timelinePct}% (${entityCount} entity pages). Run: gbrain extract all`,
      });
    }

    // Bug 11 — brain_score breakdown. When the total is < 100, show which
    // components contributed the deficit so users know what to fix.
    // Uses distinct *_score field names (not overloading link_coverage /
    // timeline_coverage, which are entity-scoped).
    if (health.brain_score < 100) {
      const parts = [
        `embed ${health.embed_coverage_score}/35`,
        `links ${health.link_density_score}/25`,
        `timeline ${health.timeline_coverage_score}/15`,
        `orphans ${health.no_orphans_score}/15`,
        `dead-links ${health.no_dead_links_score}/10`,
      ];
      checks.push({
        name: 'brain_score',
        status: health.brain_score >= 70 ? 'ok' : 'warn',
        message: `Brain score ${health.brain_score}/100 (${parts.join(', ')})`,
      });
    } else {
      checks.push({ name: 'brain_score', status: 'ok', message: `Brain score 100/100` });
    }
  } catch {
    checks.push({ name: 'graph_coverage', status: 'warn', message: 'Could not check graph coverage' });
  }

  // 10. Integrity sample scan (v0.13 knowledge runtime).
  // Read-only — no network, no writes, no resolver calls. Samples the first
  // 500 pages by slug order and surfaces bare-tweet + dead-link counts as a
  // warning. Full-brain scan: `gbrain integrity check`.
  progress.heartbeat('integrity_sample');
  const integrityHb = startHeartbeat(progress, 'scanning 500-page integrity sample…');
  try {
    const { scanIntegrity } = await import('./integrity.ts');
    const res = await scanIntegrity(engine, { limit: 500 });
    const total = res.bareHits.length + res.externalHits.length;
    if (total === 0) {
      checks.push({
        name: 'integrity',
        status: 'ok',
        message: `Sampled ${res.pagesScanned} pages; no bare-tweet phrases or external links.`,
      });
    } else if (res.bareHits.length > 0) {
      checks.push({
        name: 'integrity',
        status: 'warn',
        message: `Sampled ${res.pagesScanned} pages; ${res.bareHits.length} bare-tweet phrase(s), ${res.externalHits.length} external link(s). Run: gbrain integrity check (or integrity auto to repair).`,
      });
    } else {
      checks.push({
        name: 'integrity',
        status: 'ok',
        message: `Sampled ${res.pagesScanned} pages; ${res.externalHits.length} external link(s) (no bare tweets).`,
      });
    }
  } catch (e) {
    checks.push({ name: 'integrity', status: 'warn', message: `integrity scan skipped: ${e instanceof Error ? e.message : String(e)}` });
  } finally {
    integrityHb();
  }

  // 10. JSONB integrity (v0.12.3 reliability wave).
  // v0.12.0's JSON.stringify()::jsonb pattern stored JSONB string literals
  // instead of objects on real Postgres. PGLite masked this; Supabase did not.
  // Scan 5 known write sites for rows whose top-level jsonb_typeof is
  // 'string'. `page_versions.frontmatter` added in v0.15.2 so doctor's
  // surface matches `repair-jsonb` (the previous 4-target scan missed a
  // repair target, per #254/Codex review).
  progress.heartbeat('jsonb_integrity');
  try {
    const sql = db.getConnection();
    const targets: Array<{ table: string; col: string; expected: 'object' | 'array' }> = [
      { table: 'pages',         col: 'frontmatter',    expected: 'object' },
      { table: 'raw_data',      col: 'data',           expected: 'object' },
      { table: 'ingest_log',    col: 'pages_updated',  expected: 'array'  },
      { table: 'files',         col: 'metadata',       expected: 'object' },
      { table: 'page_versions', col: 'frontmatter',    expected: 'object' },
    ];
    let totalBad = 0;
    const breakdown: string[] = [];
    for (const { table, col } of targets) {
      progress.heartbeat(`jsonb_integrity.${table}.${col}`);
      const rows = await sql.unsafe(
        `SELECT count(*)::int AS n FROM ${table} WHERE jsonb_typeof(${col}) = 'string'`,
      );
      const n = Number((rows as any)[0]?.n ?? 0);
      if (n > 0) { totalBad += n; breakdown.push(`${table}.${col}=${n}`); }
    }
    if (totalBad === 0) {
      checks.push({ name: 'jsonb_integrity', status: 'ok', message: 'All JSONB columns store objects/arrays' });
    } else {
      checks.push({
        name: 'jsonb_integrity',
        status: 'warn',
        message: `${totalBad} row(s) double-encoded (${breakdown.join(', ')}). Fix: gbrain repair-jsonb`,
      });
    }
  } catch {
    checks.push({ name: 'jsonb_integrity', status: 'warn', message: 'Could not check JSONB integrity' });
  }

  // 10b. Takes weight grid integrity (v0.32 — EXP-2).
  //
  // Cross-modal eval over 100K production takes flagged 0.74, 0.82-style
  // weights as false precision. v0.31's engine layer rounds to 0.05 on
  // insert (PR #795); v0.32's migration v48 backfills pre-existing data.
  // This check is the post-backfill drift detector — if a downstream
  // extraction agent or hand-edit re-introduces off-grid values, we want
  // the warning to surface before it pollutes scorecard / calibration math.
  //
  // Pure helper so the test surface targets `takesWeightGridCheck(engine)`
  // directly rather than the full `runDoctor` pipeline (codex review #7).
  progress.heartbeat('takes_weight_grid');
  checks.push(await takesWeightGridCheck(engine));

  // 10c. Child-table orphan detection (closes #1063).
  // The autopilot `orphans` phase scans for orphan pages (no inbound links)
  // but does NOT detect orphan rows in FK-child tables. After a bulk page
  // delete, child rows can persist if cascade didn't fire (pre-FK rows,
  // race during bulk cascade, code path that bypassed cascade). This
  // surfaces them with paste-ready cleanup SQL.
  progress.heartbeat('child_table_orphans');
  checks.push(await childTableOrphansCheck(engine));

  // v0.33: whoknows_health — fixture presence + row count. The eval
  // gate itself runs via `gbrain eval whoknows`; this check is the
  // "did you do the assignment?" signal.
  progress.heartbeat('whoknows_health');
  checks.push(await whoknowsHealthCheck(engine));

  // v0.36 cross-modal wave: modality column cleanup.
  //
  // Historical brains that imported image assets before v0.27.1's
  // `modality='image'` default-set may have image chunks where
  // embedding_image is populated but modality wasn't tagged. The cross-modal
  // search routing in v0.36 depends on `modality` for keyword filtering;
  // surface the gap so operators can run `gbrain backfill modality`.
  progress.heartbeat('cross_modal_modality_backfill');
  try {
    const mismatchRows = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*)::text AS count FROM content_chunks
       WHERE embedding_image IS NOT NULL
         AND chunk_source = 'image_asset'
         AND (modality IS NULL OR modality != 'image')`,
    );
    const mismatch = parseInt(String(mismatchRows[0]?.count ?? '0'), 10);
    if (mismatch === 0) {
      checks.push({
        name: 'cross_modal_modality_backfill',
        status: 'ok',
        message: 'All image-asset chunks have modality=image',
      });
    } else {
      checks.push({
        name: 'cross_modal_modality_backfill',
        status: 'warn',
        message:
          `${mismatch} image-asset chunk(s) have embedding_image populated but modality != 'image'. ` +
          `Fix: \`gbrain backfill modality\``,
      });
    }
  } catch {
    // Engine probably doesn't have the modality column (pre-v0.27.1 brain) —
    // skip silently. Auto-migration will land it on next upgrade.
    checks.push({
      name: 'cross_modal_modality_backfill',
      status: 'ok',
      message: 'modality column not present (pre-v0.27.1 brain); skipped',
    });
  }

  // v0.36 Phase 3 — unified_multimodal coverage (D21 source-aware).
  //
  // Only meaningful when search.unified_multimodal is on. Reports the
  // percentage of content_chunks with embedding_multimodal populated.
  // Source-aware: a global 95% can hide 0% coverage for a specific source.
  progress.heartbeat('unified_multimodal_coverage');
  try {
    const unifiedFlag = await engine.getConfig('search.unified_multimodal').catch(() => null);
    const unifiedOnlyFlag = await engine.getConfig('search.unified_multimodal_only').catch(() => null);
    const unifiedOn = unifiedFlag === 'true' || unifiedFlag === '1';
    const unifiedOnlyOn = unifiedOnlyFlag === 'true' || unifiedOnlyFlag === '1';

    if (!unifiedOn) {
      checks.push({
        name: 'unified_multimodal_coverage',
        status: 'ok',
        message: 'search.unified_multimodal is off; coverage check N/A',
      });
    } else {
      // D21 source-aware: report per-source coverage so multi-source brains
      // can't hide 0% on one source behind a high global average.
      const rows = await engine.executeRaw<{ source_id: string | null; total: string; covered: string }>(
        `SELECT
           COALESCE(p.source_id, 'default') AS source_id,
           COUNT(*)::text AS total,
           SUM(CASE WHEN cc.embedding_multimodal IS NOT NULL THEN 1 ELSE 0 END)::text AS covered
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         GROUP BY p.source_id`,
      );
      const perSource = rows.map(r => ({
        source: r.source_id || 'default',
        total: parseInt(String(r.total), 10),
        covered: parseInt(String(r.covered), 10),
      }));
      const lowestCoverage = perSource.reduce(
        (acc, r) => Math.min(acc, r.total > 0 ? r.covered / r.total : 1),
        1,
      );
      const summary = perSource.map(r => {
        const pct = r.total > 0 ? Math.round((r.covered / r.total) * 100) : 0;
        return `${r.source}:${pct}%`;
      }).join(', ');

      if (unifiedOnlyOn && lowestCoverage < 0.99) {
        checks.push({
          name: 'unified_multimodal_coverage',
          status: 'fail',
          message:
            `unified_multimodal_only is ON but lowest source coverage is ${(lowestCoverage * 100).toFixed(1)}% (${summary}). ` +
            `Run \`gbrain reindex --multimodal\` to bring coverage to 99%+ or disable strict mode.`,
        });
      } else if (lowestCoverage < 0.95) {
        checks.push({
          name: 'unified_multimodal_coverage',
          status: 'warn',
          message:
            `unified_multimodal is on but lowest source coverage is ${(lowestCoverage * 100).toFixed(1)}% (${summary}). ` +
            `Run \`gbrain reindex --multimodal\` to fill the gap.`,
        });
      } else {
        checks.push({
          name: 'unified_multimodal_coverage',
          status: 'ok',
          message: `unified_multimodal coverage: ${summary}`,
        });
      }
    }
  } catch {
    // Column probably not present (pre-v0.36 brain pre-migration); skip silently.
    checks.push({
      name: 'unified_multimodal_coverage',
      status: 'ok',
      message: 'embedding_multimodal column not present yet; skipped',
    });
  }

  // 11. Markdown body completeness (v0.12.3 reliability wave).
  // v0.12.0's splitBody ate everything after the first `---` horizontal rule,
  // truncating wiki-style pages. Heuristic: pages whose body is <30% of the
  // raw source content length when raw has multiple H2/H3 boundaries.
  //
  // No total on this check: the regex scan over rd.data -> 'content' is a
  // sequential scan that LIMIT 100 bounds only the output, not the scan
  // work. We heartbeat every second so agents see life, no fake totals.
  progress.heartbeat('markdown_body_completeness');
  const mbcHb = startHeartbeat(progress, 'scanning pages for truncation…');
  try {
    const sql = db.getConnection();
    const rows = await sql`
      SELECT p.slug,
             length(p.compiled_truth) AS body_len,
             length(rd.data ->> 'content') AS raw_len
      FROM pages p
      JOIN raw_data rd ON rd.page_id = p.id
      WHERE rd.data ? 'content'
        AND length(rd.data ->> 'content') > 1000
        AND length(p.compiled_truth) < length(rd.data ->> 'content') * 0.3
        AND (rd.data ->> 'content') ~ '(^|\n)##+ '
      LIMIT 100
    `;
    if (rows.length === 0) {
      checks.push({ name: 'markdown_body_completeness', status: 'ok', message: 'No truncated bodies detected' });
    } else {
      const sample = rows.slice(0, 3).map((r: any) => r.slug).join(', ');
      checks.push({
        name: 'markdown_body_completeness',
        status: 'warn',
        message: `${rows.length} page(s) appear truncated (sample: ${sample}). Re-import with: gbrain sync --force`,
      });
    }
  } catch {
    // pages_raw.raw_data may not exist on older schemas; best-effort.
    checks.push({ name: 'markdown_body_completeness', status: 'ok', message: 'Skipped (raw_data unavailable)' });
  } finally {
    mbcHb();
  }

  // 11a. Frontmatter integrity (v0.22.4).
  // scanBrainSources walks every registered source's local_path on disk
  // (not from the DB), invoking parseMarkdown(..., {validate:true}) per
  // file. Reports per-source counts grouped by error code. The fix path is
  // `gbrain frontmatter validate <source-path> --fix`, which writes .bak
  // backups so it works for both git and non-git brain repos.
  progress.heartbeat('frontmatter_integrity');
  const fmHb = startHeartbeat(progress, 'scanning frontmatter…');
  try {
    const { scanBrainSources } = await import('../core/brain-writer.ts');
    const report = await scanBrainSources(engine);
    if (report.total === 0) {
      const sources = report.per_source.length;
      checks.push({
        name: 'frontmatter_integrity',
        status: 'ok',
        message: sources === 0
          ? 'No registered sources to scan'
          : `${sources} source(s) clean — no frontmatter issues`,
      });
    } else {
      const sourceMessages: string[] = [];
      for (const src of report.per_source) {
        if (src.total === 0) continue;
        const codes = Object.entries(src.errors_by_code)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        sourceMessages.push(`${src.source_id}: ${src.total} (${codes})`);
      }
      checks.push({
        name: 'frontmatter_integrity',
        status: 'warn',
        message:
          `${report.total} frontmatter issue(s) across ${sourceMessages.length} source(s). ` +
          `${sourceMessages.join('; ')}. Fix: gbrain frontmatter validate <source-path> --fix`,
      });
    }
  } catch (e) {
    checks.push({
      name: 'frontmatter_integrity',
      status: 'warn',
      message: `Could not scan frontmatter: ${e instanceof Error ? e.message : String(e)}`,
    });
  } finally {
    fmHb();
  }

  // 11a-bis. Eval-capture health (v0.25.0). Capture is a fire-and-forget
  // side-effect that logs failures to a persistent table so this check
  // can see drops cross-process (the MCP server captures; `gbrain doctor`
  // runs in a separate process). Counts failures in the last 24h and
  // warns when non-zero. Pre-v31 brains: the table doesn't exist yet;
  // swallow the error and report skipped.
  progress.heartbeat('eval_capture');
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const failures = await engine.listEvalCaptureFailures({ since });
    if (failures.length === 0) {
      checks.push({ name: 'eval_capture', status: 'ok', message: 'No capture failures in the last 24h' });
    } else {
      const byReason = new Map<string, number>();
      for (const f of failures) {
        byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1);
      }
      const breakdown = [...byReason.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${n} ${r}`)
        .join(', ');
      checks.push({
        name: 'eval_capture',
        status: 'warn',
        message: `${failures.length} capture failure(s) in the last 24h (${breakdown}). ` +
          `If you care about replay fidelity, investigate. If not, set eval.capture: false ` +
          `in ~/.gbrain/config.json to silence.`,
      });
    }
  } catch (err) {
    // Distinguish "table doesn't exist yet" (pre-v31, ok skip) from real
    // problems like RLS denying SELECT — the latter masks the very condition
    // this check is supposed to surface (capture INSERTs almost certainly
    // also fail).
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') {
      checks.push({ name: 'eval_capture', status: 'ok', message: 'Skipped (eval_capture_failures table unavailable — apply migrations or upgrade)' });
    } else if (code === '42501') {
      checks.push({
        name: 'eval_capture',
        status: 'warn',
        message: 'RLS denies SELECT on eval_capture_failures. Capture INSERTs are almost certainly failing too. Run as a role with BYPASSRLS or grant SELECT on this table.',
      });
    } else {
      checks.push({
        name: 'eval_capture',
        status: 'warn',
        message: `Could not read eval_capture_failures: ${(err as Error)?.message ?? String(err)}`,
      });
    }
  }

  // 11a-bis-3. contradictions probe summary (v0.32.6 — M1).
  //
  // Reads the most recent eval_contradictions_runs row and surfaces:
  //   - headline count + severity breakdown
  //   - paste-ready resolution commands per HIGH-severity finding
  //   - Wilson CI band so the user knows whether the headline is trustworthy
  // Skipped (status: 'ok') when the table is empty — the probe simply hasn't
  // run yet, which is normal on a fresh install.
  progress.heartbeat('contradictions');
  try {
    const recent = await engine.loadContradictionsTrend(7);
    if (recent.length === 0) {
      checks.push({
        name: 'contradictions',
        status: 'ok',
        message: 'No probe runs in the last 7 days. Run `gbrain eval suspected-contradictions --query "..." --top-k 5` to populate.',
      });
    } else {
      const latest = recent[0];
      const report = latest.report_json as Record<string, unknown> | null;
      const perQuery = (report?.per_query as Array<{
        contradictions: Array<{
          severity: 'low' | 'medium' | 'high';
          axis: string;
          a: { slug: string };
          b: { slug: string };
          resolution_command: string;
        }>;
      }> | undefined) ?? [];
      let high = 0, medium = 0, low = 0;
      const highFindings: Array<{ a: string; b: string; axis: string; cmd: string }> = [];
      for (const q of perQuery) {
        for (const c of q.contradictions) {
          if (c.severity === 'high') {
            high++;
            highFindings.push({ a: c.a.slug, b: c.b.slug, axis: c.axis, cmd: c.resolution_command });
          } else if (c.severity === 'medium') medium++;
          else low++;
        }
      }
      const total = high + medium + low;
      if (total === 0) {
        checks.push({
          name: 'contradictions',
          status: 'ok',
          message: `Latest probe run (${latest.ran_at.slice(0, 10)}) found no suspected contradictions across ${latest.queries_evaluated} queries.`,
        });
      } else {
        const ciLow = (latest.wilson_ci_lower * 100).toFixed(0);
        const ciHigh = (latest.wilson_ci_upper * 100).toFixed(0);
        const lines = [
          `${total} suspected contradictions (high=${high} medium=${medium} low=${low}) detected by latest probe — Wilson CI 95%: ${ciLow}-${ciHigh}%.`,
        ];
        for (const f of highFindings.slice(0, 3)) {
          lines.push(`  HIGH: ${f.a} vs ${f.b}${f.axis ? ' — ' + f.axis : ''}`);
          lines.push(`    → ${f.cmd}`);
        }
        if (highFindings.length > 3) {
          lines.push(`  …and ${highFindings.length - 3} more — see \`gbrain eval suspected-contradictions review\``);
        }
        checks.push({
          name: 'contradictions',
          status: high > 0 ? 'warn' : 'ok',
          message: lines.join('\n  '),
        });
      }
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') {
      checks.push({ name: 'contradictions', status: 'ok', message: 'Skipped (eval_contradictions_runs table unavailable — apply migrations to enable)' });
    } else {
      checks.push({
        name: 'contradictions',
        status: 'warn',
        message: `Could not read contradictions trend: ${(err as Error)?.message ?? String(err)}`,
      });
    }
  }

  // 11a-bis-2. facts_extraction_health (v0.31.2 — codex P1 #3).
  //
  // Mirrors the eval_capture check shape but reads facts:absorb rows
  // (written by writeFactsAbsorbLog from src/core/facts/absorb-log.ts).
  // Iterates over EVERY source so multi-source brains see per-source
  // failure rates instead of only 'default'. Threshold configurable via
  // `facts.absorb_warn_threshold` (default 10 over the last 24h, per
  // source, per reason). When the threshold is exceeded for any
  // (source, reason) pair, status flips to warn and the message names
  // the breakdown.
  progress.heartbeat('facts_extraction_health');
  try {
    const thresholdRaw = await engine.getConfig('facts.absorb_warn_threshold');
    const parsed = parseInt(thresholdRaw ?? '', 10);
    const threshold = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;

    // Single SQL grouping by (source_id, reason) over the last 24h. The
    // composite index v50 added (idx_ingest_log_source_type_created on
    // source_id, source_type, created_at DESC) covers this query's
    // filter + sort path.
    const rows = await engine.executeRaw<{
      source_id: string;
      reason: string;
      n: string | number;
    }>(
      `SELECT
         source_id,
         split_part(summary, ':', 1) AS reason,
         COUNT(*)::text AS n
       FROM ingest_log
       WHERE source_type = 'facts:absorb'
         AND created_at >= now() - INTERVAL '24 hours'
       GROUP BY source_id, split_part(summary, ':', 1)
       ORDER BY source_id, COUNT(*) DESC`,
    );

    if (rows.length === 0) {
      checks.push({
        name: 'facts_extraction_health',
        status: 'ok',
        message: 'No facts:absorb failures in the last 24h.',
      });
    } else {
      // Group per source so the breakdown is operator-friendly.
      const bySource = new Map<string, Array<{ reason: string; n: number }>>();
      let anyOverThreshold = false;
      for (const r of rows) {
        const n = typeof r.n === 'number' ? r.n : parseInt(r.n, 10);
        if (!Number.isFinite(n)) continue;
        if (n >= threshold) anyOverThreshold = true;
        if (!bySource.has(r.source_id)) bySource.set(r.source_id, []);
        bySource.get(r.source_id)!.push({ reason: r.reason, n });
      }
      const summary = [...bySource.entries()]
        .map(([sid, reasons]) =>
          `${sid}: ${reasons.map(x => `${x.n} ${x.reason}`).join(', ')}`,
        )
        .join(' | ');
      checks.push({
        name: 'facts_extraction_health',
        status: anyOverThreshold ? 'warn' : 'ok',
        message: anyOverThreshold
          ? `Facts:absorb failures over the threshold (${threshold}) in the last 24h: ${summary}. ` +
            `Run \`gbrain recall --since 24h --json\` to inspect what landed; ` +
            `tune the gate via \`gbrain config set facts.absorb_warn_threshold N\`.`
          : `Facts:absorb activity in last 24h (under threshold ${threshold}): ${summary}.`,
      });
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01' || code === '42703') {
      // ingest_log missing entirely (extreme legacy) or source_id column
      // missing (pre-v50 brain that hasn't run apply-migrations yet).
      checks.push({
        name: 'facts_extraction_health',
        status: 'ok',
        message: 'Skipped (ingest_log.source_id unavailable — run `gbrain apply-migrations --yes`).',
      });
    } else if (code === '42501') {
      checks.push({
        name: 'facts_extraction_health',
        status: 'warn',
        message: 'RLS denies SELECT on ingest_log. The check can\'t see facts:absorb rows. Run as a BYPASSRLS role or grant SELECT on this table.',
      });
    } else {
      checks.push({
        name: 'facts_extraction_health',
        status: 'warn',
        message: `Could not read ingest_log for facts:absorb: ${(err as Error)?.message ?? String(err)}`,
      });
    }
  }

  // 11a-2. effective_date_health (v0.29.1).
  //
  // Detects pages where computeEffectiveDate fell back to updated_at even
  // though parseable frontmatter dates are present (codex pass-1 #5
  // resolution: the sentinel column lets us catch "wrong but populated"
  // rows that look healthy at first glance).
  //
  // Sample 1000 random rows by default to keep the check fast on 200K-page
  // brains. The expression index pages_coalesce_date_idx makes the future-
  // date and pre-1990 scans cheap; the parseable-fm-date scan reads
  // frontmatter JSONB and is the slow path.
  progress.heartbeat('effective_date_health');
  try {
    const result = await engine.executeRaw<{ kind: string; count: string }>(
      `WITH sample AS (
         SELECT slug, frontmatter, effective_date, effective_date_source
           FROM pages
          ORDER BY id DESC
          LIMIT 1000
       )
       SELECT 'fallback_with_fm_date' AS kind, COUNT(*)::text AS count
         FROM sample
        WHERE effective_date_source = 'fallback'
          AND (frontmatter ? 'event_date' OR frontmatter ? 'date' OR frontmatter ? 'published')
       UNION ALL
       SELECT 'future_dated', COUNT(*)::text FROM sample
        WHERE effective_date IS NOT NULL AND effective_date > NOW() + INTERVAL '1 year'
       UNION ALL
       SELECT 'pre_1990', COUNT(*)::text FROM sample
        WHERE effective_date IS NOT NULL AND effective_date < TIMESTAMPTZ '1990-01-01'`,
    );
    const counts = new Map(result.map(r => [r.kind, Number(r.count)]));
    const fallbackWithFm = counts.get('fallback_with_fm_date') ?? 0;
    const future = counts.get('future_dated') ?? 0;
    const pre1990 = counts.get('pre_1990') ?? 0;
    if (fallbackWithFm > 0 || future > 0 || pre1990 > 0) {
      const parts: string[] = [];
      if (fallbackWithFm > 0) parts.push(`${fallbackWithFm} fell back to updated_at despite parseable frontmatter date`);
      if (future > 0) parts.push(`${future} dated > NOW() + 1y`);
      if (pre1990 > 0) parts.push(`${pre1990} pre-1990`);
      checks.push({
        name: 'effective_date_health',
        status: 'warn',
        message: `${parts.join('; ')} (sample of last 1000 pages). Run \`gbrain reindex-frontmatter\` to recompute.`,
      });
    } else {
      checks.push({
        name: 'effective_date_health',
        status: 'ok',
        message: 'Sample of last 1000 pages clean (no fallback-with-parseable-fm-date, no future-dated, no pre-1990)',
      });
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42703') {
      // column doesn't exist — pre-v0.29.1 brain
      checks.push({ name: 'effective_date_health', status: 'ok', message: 'Skipped (effective_date column unavailable — run gbrain apply-migrations)' });
    } else {
      checks.push({ name: 'effective_date_health', status: 'warn', message: `Could not read pages: ${(err as Error)?.message ?? String(err)}` });
    }
  }

  // 11a-3. salience_health (v0.29.1).
  //
  // Detects pages with active takes (so emotional_weight should be > 0)
  // whose recompute_emotional_weight phase hasn't yet run, plus the
  // brain-average emotional_weight as an informational signal.
  progress.heartbeat('salience_health');
  try {
    const result = await engine.executeRaw<{ kind: string; n: string }>(
      `SELECT 'zero_weight_with_takes' AS kind, COUNT(DISTINCT p.id)::text AS n
         FROM pages p
         JOIN takes t ON t.page_id = p.id AND t.active = TRUE
        WHERE COALESCE(p.emotional_weight, 0) = 0
       UNION ALL
       SELECT 'nonzero_weight', COUNT(*)::text FROM pages WHERE COALESCE(emotional_weight, 0) > 0`,
    );
    const counts = new Map(result.map(r => [r.kind, Number(r.n)]));
    const zeroWithTakes = counts.get('zero_weight_with_takes') ?? 0;
    const nonzero = counts.get('nonzero_weight') ?? 0;
    if (zeroWithTakes > 0) {
      checks.push({
        name: 'salience_health',
        status: 'warn',
        message: `${zeroWithTakes} pages with active takes have emotional_weight=0. Run \`gbrain dream --phase recompute_emotional_weight\` to populate. Brain has ${nonzero} pages with non-zero emotional_weight.`,
      });
    } else if (nonzero === 0) {
      checks.push({
        name: 'salience_health',
        status: 'ok',
        message: 'Skipped (no pages have emotional_weight > 0; either fresh install or recompute hasn\'t run yet)',
      });
    } else {
      checks.push({
        name: 'salience_health',
        status: 'ok',
        message: `${nonzero} pages have non-zero emotional_weight; no take/weight mismatches detected`,
      });
    }
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42703' || code === '42P01') {
      checks.push({ name: 'salience_health', status: 'ok', message: 'Skipped (emotional_weight or takes table unavailable — pre-v0.29 brain)' });
    } else {
      checks.push({ name: 'salience_health', status: 'warn', message: `Could not read pages: ${(err as Error)?.message ?? String(err)}` });
    }
  }

  // 11b. Queue health (v0.19.1 queue-resilience wave).
  // Postgres-only because PGLite has no multi-process worker surface. Two
  // subchecks, both cheap (single SELECT each, status-index-covered):
  //
  //   1. stalled-forever: any active job whose started_at is > 1h old. The
  //      incident that motivated this release ran 90+ min before surfacing.
  //      Surface the ID so the operator can `gbrain jobs get <id>` to inspect
  //      or `gbrain jobs cancel <id>` to force-kill.
  //
  //   2. backpressure-missed: per-name waiting depth exceeds the threshold
  //      (default 10, override via GBRAIN_QUEUE_WAITING_THRESHOLD env). Signal
  //      that a submitter probably needs maxWaiting set. Bounded by per-name
  //      aggregation so a single name's pile shows up clearly instead of
  //      getting lost in the total.
  //
  // Not included in v0.19.1 (tracked as B7 follow-up): worker-heartbeat
  // staleness. It needs a minion_workers table; the lock_until-on-active-jobs
  // proxy can't distinguish "no worker" from "worker idle," and a check that
  // cries wolf erodes trust in every other doctor check.
  progress.heartbeat('queue_health');
  if (engine.kind === 'pglite') {
    checks.push({
      name: 'queue_health',
      status: 'ok',
      message: 'Skipped (PGLite — no multi-process worker surface)',
    });
  } else {
    const queueHealthHb = startHeartbeat(progress, 'scanning queue health…');
    try {
      const sql = db.getConnection();
      // Subcheck 1: stalled-forever active jobs (>1h wall-clock).
      const stalledRows: Array<{ id: number; name: string; started_at: string }> = await sql`
        SELECT id, name, started_at::text AS started_at
          FROM minion_jobs
         WHERE status = 'active'
           AND started_at IS NOT NULL
           AND started_at < now() - interval '1 hour'
         ORDER BY started_at ASC
         LIMIT 5
      `;
      // Subcheck 2: per-name waiting depth exceeds threshold.
      const rawThreshold = process.env.GBRAIN_QUEUE_WAITING_THRESHOLD;
      const parsedThreshold = rawThreshold ? parseInt(rawThreshold, 10) : 10;
      const threshold = Number.isFinite(parsedThreshold) && parsedThreshold >= 1
        ? parsedThreshold
        : 10;
      const depthRows: Array<{ name: string; queue: string; depth: number }> = await sql`
        SELECT name, queue, count(*)::int AS depth
          FROM minion_jobs
         WHERE status = 'waiting'
         GROUP BY name, queue
        HAVING count(*) > ${threshold}
         ORDER BY depth DESC
         LIMIT 5
      `;
      // Subcheck 3 (v0.22.14): RSS-watchdog kills in the last 24h. Bare workers
      // newly default to --max-rss 2048 (was 0); operators who run large embed
      // or import jobs may see kills that didn't happen pre-v0.22.14. We surface
      // a hint when this signature appears so the upgrade path is obvious.
      // Signature: when the watchdog trips, gracefulShutdown('watchdog') aborts
      // in-flight jobs with `new Error('watchdog')`. The worker's failJob path
      // (worker.ts:660-664) writes `error_text = 'aborted: watchdog'` for any
      // job in-flight at the moment of the kill.
      //
      // We deliberately DO NOT do a loose `ILIKE '%watchdog%'`:
      //   1. Parent jobs that inherit `on_child_fail='fail_parent'` get
      //      `"child job N failed: aborted: watchdog"` — counting that
      //      double-counts (child + parent) for one watchdog event.
      //   2. Any user error_text containing the word "watchdog" matches.
      // Match the exact prefix `'aborted: watchdog'` to scope this purely to
      // the worker's own kill signature.
      const rssKillRows: Array<{ cnt: number }> = await sql`
        SELECT count(*)::int AS cnt
          FROM minion_jobs
         WHERE status IN ('dead', 'failed')
           AND finished_at > now() - interval '24 hours'
           AND error_text = 'aborted: watchdog'
      `;
      const rssKillCount = rssKillRows[0]?.cnt ?? 0;

      // Subcheck 4 (v0.30.2): prompt_too_long terminal failures on subagent
      // jobs in the last 24h. The dream/synthesize phase classifies Anthropic
      // 400 "prompt is too long" responses as UnrecoverableError so they
      // dead-letter on first attempt instead of clogging the queue with
      // max_stalled retries. Surface count + fix hint when present.
      const promptTooLongRows: Array<{ cnt: number }> = await sql`
        SELECT count(*)::int AS cnt
          FROM minion_jobs
         WHERE name = 'subagent'
           AND status = 'dead'
           AND finished_at > now() - interval '24 hours'
           AND error_text LIKE 'prompt_too_long:%'
      `;
      const promptTooLongCount = promptTooLongRows[0]?.cnt ?? 0;

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
      if (rssKillCount > 0) {
        problems.push(
          `${rssKillCount} job(s) dead-lettered for RSS-watchdog memory-limit kills in last 24h. ` +
          `v0.22.14 changed the bare-worker --max-rss default from 0 (off) to 2048 MB. ` +
          `Fix: raise the limit (e.g. \`gbrain jobs work --max-rss 4096\`) or opt out (\`--max-rss 0\`). ` +
          `See skills/migrations/v0.22.14.md.`
        );
      }
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
        checks.push({
          name: 'queue_health',
          status: 'ok',
          message: `No stalled-forever jobs; no queue over depth ${threshold}.`,
        });
      } else {
        checks.push({
          name: 'queue_health',
          status: 'warn',
          message: problems.join(' '),
        });
      }
    } catch (e) {
      checks.push({
        name: 'queue_health',
        status: 'warn',
        message: `queue_health scan skipped: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      queueHealthHb();
    }
  }

  // 11.4 subagent_provider (v0.31.12 — Codex F13 layer 3 of 3). Surfaces a
  // warn when models.tier.subagent or models.default points at a non-Anthropic
  // provider. Layers 1 (queue.ts submit-time) and 2 (handler runtime) also
  // enforce; this is the surfacing layer so users see the config drift before
  // a job is submitted.
  progress.heartbeat('subagent_provider');
  checks.push(await checkSubagentProvider(engine));

  // 11.5 facts_health (v0.31 hot memory). Surfaces per-source counters so
  // operators can see the extraction pipeline's pulse without raw SQL.
  // Lightweight: one COUNT-with-filters query + a top-5 aggregate. Only
  // runs when the facts table exists (post-v40 brains); pre-v40 the
  // probe is a no-op.
  progress.heartbeat('facts_health');
  try {
    const factsExists = await engine.executeRaw<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'facts') AS exists`,
    );
    if (factsExists[0]?.exists) {
      const health = await engine.getFactsHealth('default');
      const status: 'ok' | 'warn' = health.total_active >= 0 ? 'ok' : 'warn';
      const top = health.top_entities
        .slice(0, 3)
        .map(t => `${t.entity_slug}:${t.count}`)
        .join(', ') || '—';
      checks.push({
        name: 'facts_health',
        status,
        message:
          `facts_health(default): ${health.total_active} active, ` +
          `${health.total_today} today, ${health.total_week} this week, ` +
          `${health.total_consolidated} consolidated, ` +
          `top entities ${top}`,
      });
    } else {
      checks.push({
        name: 'facts_health',
        status: 'ok',
        message: 'facts table not present (pre-v0.31 brain or migration pending)',
      });
    }
  } catch (e) {
    checks.push({
      name: 'facts_health',
      status: 'warn',
      message: `facts_health probe failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // 12. Index audit (opt-in via --index-audit). v0.13.1 follow-up to #170.
  // Reports indexes with zero recorded scans on Postgres. Informational only;
  // we DO NOT auto-drop. On #170's brain, idx_pages_frontmatter and
  // idx_pages_trgm showed 0 scans — the suggestion there is "consider
  // investigating on YOUR brain," not "drop these globally." Zero scans on a
  // fresh install is also normal (nothing has queried yet); the real signal
  // is zero scans on a long-running active brain.
  if (args.includes('--index-audit')) {
    progress.heartbeat('index_audit');
    if (engine.kind === 'pglite') {
      checks.push({
        name: 'index_audit',
        status: 'ok',
        message: 'Skipped (PGLite — pg_stat_user_indexes is a Postgres extension)',
      });
    } else {
      try {
        const sql = db.getConnection();
        const rows = await sql`
          SELECT schemaname, relname AS table, indexrelname AS index,
                 idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
            FROM pg_stat_user_indexes
           WHERE schemaname = 'public'
             AND idx_scan = 0
           ORDER BY pg_relation_size(indexrelid) DESC
           LIMIT 20
        `;
        if (rows.length === 0) {
          checks.push({ name: 'index_audit', status: 'ok', message: 'All public indexes have recorded scans' });
        } else {
          const list = rows.map((r: any) => `${r.index}(${r.size})`).join(', ');
          checks.push({
            name: 'index_audit',
            status: 'warn',
            message: `${rows.length} zero-scan index(es): ${list}. ` +
                     `Consider investigating whether they're used on YOUR workload (fresh brains naturally show zero scans until queries accumulate). ` +
                     `Do not drop without confirming.`,
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        checks.push({ name: 'index_audit', status: 'warn', message: `Index audit failed: ${msg}` });
      }
    }
  }

  // v0.27.1: image_assets — vanished images (files row exists but file
  // missing on disk). Cherry-4b. Engine-agnostic; uses listFilesForPage's
  // sibling SQL via raw query for cross-engine compatibility.
  if (engine) {
    progress.heartbeat('image_assets');
    try {
      const rows = await engine.executeRaw<{ storage_path: string }>(
        `SELECT storage_path FROM files WHERE mime_type LIKE 'image/%' LIMIT 1000`
      );
      let vanished = 0;
      const vanishedPaths: string[] = [];
      const fs = await import('node:fs');
      for (const r of rows) {
        try {
          fs.statSync(r.storage_path);
        } catch {
          vanished++;
          if (vanishedPaths.length < 5) vanishedPaths.push(r.storage_path);
        }
      }
      if (rows.length === 0) {
        checks.push({ name: 'image_assets', status: 'ok', message: 'No image assets indexed yet' });
      } else if (vanished === 0) {
        checks.push({ name: 'image_assets', status: 'ok', message: `${rows.length} image(s) all present on disk` });
      } else {
        checks.push({
          name: 'image_assets',
          status: 'warn',
          message: `${vanished} of ${rows.length} image(s) missing from disk (e.g. ${vanishedPaths.join(', ')}). ` +
                   `Fix: restore from git, or \`gbrain sync --skip-failed\` to acknowledge.`,
        });
      }
    } catch {
      // Pre-v36 brains may not have the files table on PGLite — quiet skip.
    }

    // v0.27.1 Eng-1B: ocr_health — counters incremented by importImageFile.
    // Warns when OCR is opted-in (attempted > 0) but never succeeds.
    progress.heartbeat('ocr_health');
    try {
      const attempted = parseInt((await engine.getConfig('ocr_attempted')) ?? '0', 10);
      const succeeded = parseInt((await engine.getConfig('ocr_succeeded')) ?? '0', 10);
      const failedNoKey = parseInt((await engine.getConfig('ocr_failed_no_key')) ?? '0', 10);
      const failedOther = parseInt((await engine.getConfig('ocr_failed_other')) ?? '0', 10);
      if (attempted === 0) {
        checks.push({ name: 'ocr_health', status: 'ok', message: 'OCR not in use (or no images ingested with OCR opt-in)' });
      } else if (succeeded === 0 && (failedNoKey > 0 || failedOther > 0)) {
        const reasons: string[] = [];
        if (failedNoKey > 0) reasons.push(`${failedNoKey} no-key`);
        if (failedOther > 0) reasons.push(`${failedOther} other`);
        checks.push({
          name: 'ocr_health',
          status: 'warn',
          message: `OCR is opted-in but no calls succeeded (${attempted} attempted, ${reasons.join(', ')}). ` +
                   `Fix: verify OPENAI_API_KEY is set, or set embedding_image_ocr=false to disable.`,
        });
      } else {
        checks.push({
          name: 'ocr_health',
          status: 'ok',
          message: `OCR healthy (${succeeded}/${attempted} succeeded; ${failedNoKey} no-key, ${failedOther} other failures)`,
        });
      }
    } catch { /* config table missing on a very old brain — skip */ }
  }

  // Sync freshness check (v0.32 — Check that sources are synced recently)
  if (engine !== null) {
    progress.heartbeat('sync_freshness');
    checks.push(await checkSyncFreshness(engine));
  }

  // v0.32.3 search-lite — mode + eval_drift surfaces. Status stays 'ok' per
  // [CDX-20]; hint lives in `message`.
  if (engine !== null) {
    progress.heartbeat('search_mode');
    checks.push(await checkSearchMode(engine));
    progress.heartbeat('eval_drift');
    checks.push(await checkEvalDrift(engine));
    // v0.35.0.0+ reranker_health — read JSONL audit; warn on auth or volume.
    progress.heartbeat('reranker_health');
    checks.push(await checkRerankerHealth(engine));
    // v0.37.0 brainstorm_health — migration v79, track_retrieval, calibration cold-start.
    progress.heartbeat('brainstorm_health');
    checks.push(await checkBrainstormHealth(engine));
    // v0.36.0.0 (A5): ZE embedding key health + schema/config width consistency.
    progress.heartbeat('ze_embedding_health');
    checks.push(await checkZeEmbeddingHealth(engine));
    progress.heartbeat('embedding_width_consistency');
    checks.push(await checkEmbeddingWidthConsistency(engine));
  }

  progress.finish();

  const hasFail = outputResults(checks, jsonOutput);

  // Features teaser (non-JSON, non-failing only)
  if (!jsonOutput && !hasFail && engine) {
    try {
      const { featuresTeaserForDoctor } = await import('./features.ts');
      const teaser = await featuresTeaserForDoctor(engine);
      if (teaser) console.log(`\n${teaser}`);
    } catch { /* best-effort */ }
  }

  process.exit(hasFail ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Print the auto-fix report in human-readable form. JSON output goes through
 *  outputResults alongside the check list; this is the pretty-print path. */
function printAutoFixReport(report: AutoFixReport, dryRun: boolean, jsonOutput: boolean): void {
  if (jsonOutput) return; // JSON consumers read autoFixReport via the check issues / caller
  const verb = dryRun ? 'PROPOSED' : 'APPLIED';
  for (const outcome of report.fixed) {
    console.log(`[${verb}] ${outcome.skillPath} (${outcome.patternLabel})`);
    if (outcome.before) {
      console.log('--- before');
      console.log(outcome.before);
      console.log('--- after');
      console.log(outcome.after ?? '');
      console.log('');
    }
  }
  const n = report.fixed.length;
  const s = report.skipped.length;
  if (n === 0 && s === 0) {
    console.log('Doctor --fix: no DRY violations to repair.');
    return;
  }
  const label = dryRun ? 'fixes proposed' : 'fixes applied';
  console.log(`${n} ${label}${s > 0 ? `, ${s} skipped:` : '.'}`);
  for (const sk of report.skipped) {
    const hint = sk.reason === 'working_tree_dirty' ? ' (run `git stash` first)' : '';
    console.log(`  - ${sk.skillPath}: ${sk.reason}${hint}`);
  }
  if (dryRun && n > 0) console.log('\nRun without --dry-run to apply.');
}


/** Quick skill conformance check — frontmatter + required sections */
function checkSkillConformance(skillsDir: string): Check {
  const manifestPath = join(skillsDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    return { name: 'skill_conformance', status: 'warn', message: 'manifest.json not found' };
  }

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const skills = manifest.skills || [];
    let passing = 0;
    const failing: string[] = [];

    for (const skill of skills) {
      const skillPath = join(skillsDir, skill.path);
      if (!existsSync(skillPath)) {
        failing.push(`${skill.name}: file missing`);
        continue;
      }
      const content = readFileSync(skillPath, 'utf-8');
      // Check frontmatter exists
      if (!content.startsWith('---')) {
        failing.push(`${skill.name}: no frontmatter`);
        continue;
      }
      passing++;
    }

    if (failing.length === 0) {
      return { name: 'skill_conformance', status: 'ok', message: `${passing}/${skills.length} skills pass` };
    }
    return {
      name: 'skill_conformance',
      status: 'warn',
      message: `${passing}/${skills.length} pass. Failing: ${failing.join(', ')}`,
    };
  } catch {
    return { name: 'skill_conformance', status: 'warn', message: 'Could not parse manifest.json' };
  }
}

function outputResults(checks: Check[], json: boolean): boolean {
  const hasFail = checks.some(c => c.status === 'fail');
  const hasWarn = checks.some(c => c.status === 'warn');

  // Compute composite health score (0-100)
  let score = 100;
  for (const c of checks) {
    if (c.status === 'fail') score -= 20;
    else if (c.status === 'warn') score -= 5;
  }
  score = Math.max(0, score);

  if (json) {
    const status = hasFail ? 'unhealthy' : hasWarn ? 'warnings' : 'healthy';
    console.log(JSON.stringify({ schema_version: 2, status, health_score: score, checks }));
    return hasFail;
  }

  console.log('\nGBrain Health Check');
  console.log('===================');
  for (const c of checks) {
    const icon = c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  [${icon}] ${c.name}: ${c.message}`);
    if (c.issues) {
      for (const issue of c.issues) {
        console.log(`    → ${issue.type.toUpperCase()}: ${issue.skill}`);
        console.log(`      ACTION: ${issue.action}`);
      }
    }
  }

  if (hasFail) {
    console.log(`\nHealth score: ${score}/100. Failed checks found.`);
  } else if (hasWarn) {
    console.log(`\nHealth score: ${score}/100. All checks OK (some warnings).`);
  } else {
    console.log(`\nHealth score: ${score}/100. All checks passed.`);
  }
  return hasFail;
}

/**
 * `gbrain doctor --locks` — list idle-in-transaction backends older
 * than 5 minutes that could block DDL. Exits 0 on clean, 1 on blockers.
 *
 * Agents hitting a statement_timeout (SQLSTATE 57014) during migration
 * need a one-command path to find and kill the blocker. migrate.ts's
 * 57014 diagnostic references this flag by name; keep the two in sync.
 *
 * Postgres-only. PGLite has no pool, no idle-in-tx concept, so the
 * check prints a one-liner and exits 0.
 */
async function runLocksCheck(engine: BrainEngine | null, jsonOutput: boolean): Promise<void> {
  if (!engine) {
    if (jsonOutput) {
      console.log(JSON.stringify({ status: 'unavailable', reason: 'no_engine' }));
    } else {
      console.log('gbrain doctor --locks requires a database connection. Configure a URL and retry.');
    }
    process.exit(1);
  }

  if (engine.kind !== 'postgres') {
    if (jsonOutput) {
      console.log(JSON.stringify({ status: 'not_applicable', engine: engine.kind }));
    } else {
      console.log(`gbrain doctor --locks is Postgres-only. Current engine: ${engine.kind}. No blockers possible (no connection pool).`);
    }
    return;
  }

  const blockers = await getIdleBlockers(engine);

  if (jsonOutput) {
    console.log(JSON.stringify({ status: blockers.length === 0 ? 'ok' : 'blockers_found', blockers }, null, 2));
    if (blockers.length > 0) process.exit(1);
    return;
  }

  if (blockers.length === 0) {
    console.log('✓ No idle-in-transaction backends older than 5 minutes.');
    return;
  }

  console.log(`Found ${blockers.length} idle-in-transaction backend(s) older than 5 minutes:\n`);
  for (const b of blockers) {
    console.log(`  PID ${b.pid}  (idle since ${b.query_start})`);
    console.log(`    Query: ${b.query}`);
    console.log(`    Kill:  SELECT pg_terminate_backend(${b.pid});`);
    console.log('');
  }
  console.log('These connections may block ALTER TABLE DDL during migration.');
  console.log('After terminating, retry: gbrain apply-migrations --yes');
  process.exit(1);
}

// ============================================================
// v0.36+ brain-health-100 wave: --remediation-plan + --remediate
//
// Plan: ~/.claude/plans/system-instruction-you-are-working-fluttering-ocean.md
// Decisions: D1 (per-job re-eval), D3 (sequential submit),
// D5 (depends_on cascade on failure), D7 (scoped recheck),
// D9 (content-hash idempotency), D13 (three-state classification),
// D14 (stable remediation_id), +A (cost-budget gate).
// ============================================================

/**
 * Emit ordered Remediation list to drive brain to --target-score.
 *
 * Read-only — never enqueues, never mutates. The agent contract:
 * inspect the plan with --remediation-plan --json before committing
 * to --remediate. The JSON shape is stable; consumers that parse it
 * can rely on it across releases.
 */
export async function runRemediationPlan(
  engine: BrainEngine,
  args: string[],
): Promise<void> {
  const { computeRecommendations, classifyChecks, maxReachableScore } =
    await import('../core/brain-score-recommendations.ts');

  const targetScore = parseIntFlag(args, '--target-score') ?? 90;
  const jsonOutput = args.includes('--json');

  // Cheap path (D7) — don't run slow doctor checks for the plan surface.
  // The recommendation generator works from BrainHealth + context alone.
  const health = await engine.getHealth();
  const ctx = await loadRecommendationContext(engine);
  const recs = computeRecommendations(health, ctx);
  // Synthetic check list for classification — we don't need full doctor
  // output, just the check names the recommendations care about.
  const syntheticChecks = [
    { name: 'brain_score', status: 'ok' as const },
    { name: 'sync_freshness', status: 'ok' as const },
    { name: 'missing_embeddings', status: 'ok' as const },
    { name: 'dead_links', status: 'ok' as const },
    { name: 'orphan_pages', status: 'ok' as const },
  ];
  const classifications = classifyChecks(syntheticChecks, ctx);
  const ceiling = maxReachableScore(health, classifications);

  const filteredRecs = recs.filter((r) => r.status === 'remediable');
  const estTotalSeconds = filteredRecs.reduce((sum, r) => sum + r.est_seconds, 0);
  const estTotalUsd = filteredRecs.reduce((sum, r) => sum + (r.est_usd_cost ?? 0), 0);

  const blocked = classifications
    .filter((c) => c.status === 'blocked')
    .map((c) => ({ check: c.check, reason: c.reason ?? 'prerequisite missing' }));

  const plan = {
    schema_version: 2,
    brain_score_current: health.brain_score,
    brain_score_target: targetScore,
    max_reachable_score: ceiling,
    target_unreachable: targetScore > ceiling,
    plan: filteredRecs.map((r, i) => ({ step: i + 1, ...r })),
    est_total_seconds: estTotalSeconds,
    est_total_usd_cost: Number(estTotalUsd.toFixed(2)),
    blocked,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  // Human output
  console.log(`Brain score: ${health.brain_score}/100 → target ${targetScore}`);
  if (plan.target_unreachable) {
    console.log(`Target unreachable: max with autonomous remediation is ${ceiling}/100.`);
  }
  if (plan.plan.length === 0) {
    console.log('No remediations needed. Brain is at target.');
  } else {
    console.log(`Plan: ${plan.plan.length} step(s), est ${plan.est_total_seconds}s, est $${plan.est_total_usd_cost.toFixed(2)}`);
    for (const step of plan.plan) {
      const protectedMark = step.protected ? ' [PROTECTED]' : '';
      const costMark = step.est_usd_cost ? ` ($${step.est_usd_cost.toFixed(2)})` : '';
      console.log(`  ${step.step}. [${step.severity}] ${step.job}${protectedMark} — ${step.rationale}${costMark}`);
    }
  }
  if (blocked.length > 0) {
    console.log(`\nBlocked checks (prereq missing):`);
    for (const b of blocked) {
      console.log(`  - ${b.check}: ${b.reason}`);
    }
  }
}

/**
 * Submit ordered Remediation jobs sequentially per D3, with D5 cascade
 * on failure and D7 scoped recheck between steps.
 *
 * Default behavior: submit-and-wait per step. --dry-run skips submission.
 * --max-usd N refuses if est_total_usd_cost > N. --max-jobs N caps the
 * inner loop.
 *
 * PGLite path: synchronous in-process execution (no durable queue).
 */
export async function runRemediate(
  engine: BrainEngine,
  args: string[],
): Promise<void> {
  const targetScore = parseIntFlag(args, '--target-score') ?? 90;
  const maxJobs = parseIntFlag(args, '--max-jobs') ?? Infinity;
  const maxUsd = parseFloatFlag(args, '--max-usd');
  const dryRun = args.includes('--dry-run');
  const skipConfirm = args.includes('--yes');
  const jsonOutput = args.includes('--json');

  const { computeRecommendations, classifyChecks, maxReachableScore } =
    await import('../core/brain-score-recommendations.ts');

  const ctx = await loadRecommendationContext(engine);

  // Pre-flight ceiling check (D13)
  const initialHealth = await engine.getHealth();
  const syntheticChecks = [
    { name: 'brain_score', status: 'ok' as const },
    { name: 'sync_freshness', status: 'ok' as const },
    { name: 'missing_embeddings', status: 'ok' as const },
    { name: 'dead_links', status: 'ok' as const },
    { name: 'orphan_pages', status: 'ok' as const },
  ];
  const classifications = classifyChecks(syntheticChecks, ctx);
  const ceiling = maxReachableScore(initialHealth, classifications);
  if (targetScore > ceiling) {
    console.error(
      `[remediate] target ${targetScore} unreachable; max autonomous = ${ceiling}/100. ` +
      `Configure missing prereqs (see --remediation-plan blocked output) or lower --target-score.`,
    );
    process.exit(2);
  }

  // Initial plan
  let recs = computeRecommendations(initialHealth, ctx).filter((r) => r.status === 'remediable');
  if (recs.length === 0) {
    console.log(`Brain at score ${initialHealth.brain_score}/100, target ${targetScore}. Nothing to do.`);
    return;
  }

  const estTotalUsd = recs.reduce((sum, r) => sum + (r.est_usd_cost ?? 0), 0);
  if (maxUsd !== null && estTotalUsd > maxUsd) {
    console.error(
      `[remediate] est cost $${estTotalUsd.toFixed(2)} exceeds --max-usd $${maxUsd.toFixed(2)}. Aborting.`,
    );
    process.exit(2);
  }

  if (!skipConfirm && process.stdout.isTTY) {
    console.log(`About to submit ${recs.length} job(s), est ${Math.round(recs.reduce((s, r) => s + r.est_seconds, 0))}s, est $${estTotalUsd.toFixed(2)}`);
    console.log('Pass --yes to proceed (cron-friendly).');
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[remediate --dry-run] Would submit ${recs.length} jobs:`);
    for (const r of recs) console.log(`  - ${r.id} (${r.job})`);
    return;
  }

  // Sequential submit per D3, with D5 cascade on failure and D7
  // scoped recheck between steps.
  const submitted: Array<{ step: number; id: string; job_id: number | null; status: string }> = [];
  const abortedIds = new Set<string>();
  const doctorRunId = crypto.randomUUID();

  const isPGLite = engine.kind === 'pglite';
  if (isPGLite) {
    console.error('[remediate] PGLite engine: running inline (no durable queue).');
  }

  const { MinionQueue } = await import('../core/minions/queue.ts');
  const { waitForCompletion } = await import('../core/minions/wait-for-completion.ts');
  const queue = new MinionQueue(engine);

  let stepCount = 0;
  while (recs.length > 0 && stepCount < maxJobs) {
    const step = recs[0];
    if (!step) break;
    stepCount++;

    // D5: if depends_on intersects aborted, skip + cascade
    if (step.depends_on && step.depends_on.some((d) => abortedIds.has(d))) {
      submitted.push({ step: stepCount, id: step.id, job_id: null, status: 'skipped_dep_aborted' });
      abortedIds.add(step.id);
      recs.shift();
      continue;
    }

    try {
      const isProtected = !!step.protected;
      const job = await queue.add(
        step.job,
        { ...step.params, doctor_run_id: doctorRunId },
        {
          queue: 'default',
          idempotency_key: step.idempotency_key,
          max_attempts: 2,
          maxWaiting: 1,
        },
        isProtected ? { allowProtectedSubmit: true } : undefined,
      );
      submitted.push({ step: stepCount, id: step.id, job_id: job.id, status: 'submitted' });

      // Wait for terminal state. PGLite is in-process — short poll.
      const terminal = await waitForCompletion(queue, job.id, {
        pollMs: isPGLite ? 250 : 1000,
        timeoutMs: (step.est_seconds + 60) * 1000,
      });
      const lastSub = submitted[submitted.length - 1];
      if (lastSub) lastSub.status = terminal.status;

      if (terminal.status !== 'completed') {
        abortedIds.add(step.id);
      }
    } catch (e) {
      submitted.push({
        step: stepCount, id: step.id, job_id: null,
        status: `error: ${(e as Error).message.slice(0, 100)}`,
      });
      abortedIds.add(step.id);
    }

    recs.shift();
    // D7: scoped recheck — re-compute plan from fresh health snapshot.
    // The next plan may drop completed steps and re-introduce failed
    // steps with bumped retry suffix (D1).
    if (recs.length === 0 || stepCount >= maxJobs) break;
    const freshHealth = await engine.getHealth();
    recs = computeRecommendations(freshHealth, ctx).filter((r) => r.status === 'remediable');
  }

  const finalHealth = await engine.getHealth();
  const result = {
    doctor_run_id: doctorRunId,
    brain_score_initial: initialHealth.brain_score,
    brain_score_final: finalHealth.brain_score,
    brain_score_target: targetScore,
    target_reached: finalHealth.brain_score >= targetScore,
    submitted,
    aborted_count: abortedIds.size,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nBrain score: ${initialHealth.brain_score} → ${finalHealth.brain_score} (target ${targetScore})`);
    console.log(`Submitted: ${submitted.length} job(s), ${abortedIds.size} aborted/failed`);
  }

  const anyFailed = submitted.some((s) => s.status !== 'completed' && s.status !== 'submitted');
  if (anyFailed) process.exit(1);
}

/**
 * Build RecommendationContext from engine + config.
 * Pure read; no side effects.
 */
async function loadRecommendationContext(engine: BrainEngine) {
  const repoPath = await engine.getConfig('sync.repo_path');
  const embeddingModel = await engine.getConfig('embedding_model');
  const embeddingDimensions = await engine.getConfig('embedding_dimensions');
  return {
    repoPath: repoPath ?? undefined,
    embeddingModel: embeddingModel ?? undefined,
    embeddingDimensions: embeddingDimensions ? Number(embeddingDimensions) : undefined,
    hasEmbeddingApiKey: !!(process.env.OPENAI_API_KEY || await engine.getConfig('openai_api_key')),
    hasChatApiKey: !!(process.env.ANTHROPIC_API_KEY || await engine.getConfig('anthropic_api_key')),
  };
}

function parseIntFlag(args: string[], flag: string): number | null {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return null;
  const v = parseInt(args[i + 1] ?? '', 10);
  return isNaN(v) ? null : v;
}

function parseFloatFlag(args: string[], flag: string): number | null {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return null;
  const v = parseFloat(args[i + 1] ?? '');
  return isNaN(v) ? null : v;
}
