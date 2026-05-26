import type { BrainEngine } from '../core/engine.ts';
import * as db from '../core/db.ts';
import { LATEST_VERSION, getIdleBlockers } from '../core/migrate.ts';
import { checkResolvable } from '../core/check-resolvable.ts';
import { autoFixDryViolations, type AutoFixReport, type FixOutcome } from '../core/dry-fix.ts';
import { autoDetectSkillsDirReadOnly } from '../core/repo-root.ts';
import { loadOrDeriveManifest } from '../core/skill-manifest.ts';
import { parseSkillFrontmatter } from '../core/skill-frontmatter.ts';
import {
  analyzeSkillBrainFirst,
  buildBrainFirstSummaryLine,
  type BrainFirstAnalysis,
} from '../core/skill-brain-first.ts';
import {
  loadSnapshot,
  writeSnapshotAtomically,
  diffAgainstSnapshot,
  appendAuditEventsForTransitions,
} from '../core/audit-skill-brain-first.ts';
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
  /**
   * v0.38: optional structured payload for checks that surface data
   * meant for programmatic consumption (e.g., cycle_phase_scope's
   * `phase_scope_map`). Mirrors `PhaseResult.details`. Most checks pack
   * everything into `message`; this is the escape hatch for ones that
   * shouldn't.
   */
  details?: Record<string, unknown>;
  issues?: Array<{ type: string; skill: string; action: string; fix?: any }>;
  /**
   * v0.36+ brain-health-100: structured remediation jobs per check.
   * Populated by the recommendation generator + (v0.40.3.0 T8b) individual
   * checks (lint, integrity, sync_failures). Consumed by
   * `gbrain doctor --remediation-plan` / `--remediate`. Optional and
   * additive — schema_version stays at 2 (D4).
   *
   * v0.40.3.0 (D6): typed to RemediationStep[] from the canonical
   * src/core/remediation-step.ts so check authors can use
   * `makeRemediationStep()` factory without hand-rolling the shape.
   */
  remediation?: import('../core/remediation-step.ts').RemediationStep[];
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

  // v0.41 Bug 2 / Eng D8 — subagent_health surfaces rate-lease pressure to the operator.
  checks.push(await checkSubagentHealth(engine));

  // v0.41.2.1 — embedding_env_override (cross-surface parity with
  // buildChecks). Surfaces when GBRAIN_EMBEDDING_* env vars disagree
  // with DB config; closes the silent-override class that caused the
  // 716K-chunk damage incident from PR #1421's description.
  checks.push(await checkEmbeddingEnvOverride(engine));

  // v0.31.12 subagent runtime enforcement (Layer 3 of 3 — Codex F13).
  // The subagent loop is Anthropic-only. If models.tier.subagent or
  // models.default is explicitly set to a non-Anthropic provider, warn here
  // so the user sees it at the next `gbrain doctor` run instead of at the
  // next subagent job submission. (Layers 1+2 also enforce — this is the
  // surfacing layer.)
  checks.push(await checkSubagentCapability(engine));

  // 6. Sync freshness check
  checks.push(await checkSyncFreshness(engine));

  // v0.39 T7 + T9 — schema-pack health checks (3 checks per v0.38 plan):
  //   schema_pack_active        — active pack resolves cleanly
  //   schema_pack_consistency   — % of pages typed against active pack
  //   schema_pack_source_drift  — per-source pack divergence
  checks.push(await checkSchemaPackActive(engine));
  checks.push(await checkSchemaPackConsistency(engine));
  checks.push(await checkSchemaPackSourceDrift(engine));

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

  // 9a. v0.40.4 graph_signals_coverage: when graph_signals is enabled
  // (via mode bundle default or explicit config override), surface
  // whether link density is high enough for the signal to fire
  // meaningfully. <10% inbound coverage warns; >=30% ok with metric.
  checks.push(await checkGraphSignalsCoverage(engine));

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

  // 11. v0.40.3.0 contextual_retrieval_coverage — surfaces pages with
  //   - chunker_version drift (pre-v40 pages not yet re-embedded)
  //   - contextual_retrieval_mode IS NULL (mode never evaluated)
  //   - synopsis-failures audit JSONL entries from the last 7 days
  checks.push(await checkContextualRetrievalCoverage(engine));

  // 12. v0.40.5.0 Federated Sync v2 (T12) — federation_health:
  //   - Per-source lag, embed coverage, failed-job rate.
  //   - Single-source brain short-circuits to ok.
  //   - Three-state: ok / warn / fail.
  checks.push(await checkFederationHealth(engine));

  return computeDoctorReport(checks);
}

// --- v0.36.1.0 calibration doctor checks (T12) ---

/**
 * abandoned_threads: surfaces active high-conviction takes (weight >= 0.7)
 * older than 12 months that have neither been superseded nor linked to a
 * follow-up page. These are commitments the user made and never revisited.
 * Status 'ok' with a count; never warns/fails (this is signal, not error).
 */
/**
 * v0.40.3.0 contextual_retrieval_coverage check.
 *
 * Surfaces drift between the active CR mode + the per-page
 * `contextual_retrieval_mode` column. Three signals:
 *
 *   1. Pages with chunker_version < current — pre-v40 pages that need
 *      to be re-embedded for the wrapper to apply. Paste-ready fix:
 *      `gbrain reindex --markdown`.
 *   2. Pages with contextual_retrieval_mode IS NULL — never evaluated
 *      against the CR ladder. Same fix as (1).
 *   3. Synopsis-failure events in the audit JSONL over the last 7 days
 *      — surfaces refusals + page-level fallbacks. >5% refusal rate
 *      warns; otherwise reported as informational.
 *
 * Reads `~/.gbrain/audit/synopsis-failures-YYYY-Www.jsonl` via
 * readRecentSynopsisFailures + summarizeSynopsisFailures from
 * `src/core/audit-synopsis.ts`. Failure-only audit means low write
 * volume on healthy brains.
 */
export async function checkContextualRetrievalCoverage(engine: BrainEngine): Promise<Check> {
  try {
    const { MARKDOWN_CHUNKER_VERSION } = await import('../core/chunkers/recursive.ts');
    const rows = await engine.executeRaw<{ chunker_drift: number; mode_null: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE chunker_version < $1)::int AS chunker_drift,
         COUNT(*) FILTER (WHERE contextual_retrieval_mode IS NULL)::int AS mode_null
       FROM pages
       WHERE page_kind = 'markdown'
         AND deleted_at IS NULL`,
      [MARKDOWN_CHUNKER_VERSION],
    );
    const chunkerDrift = rows[0]?.chunker_drift ?? 0;
    const modeNull = rows[0]?.mode_null ?? 0;

    // Synopsis-failures audit summary (best-effort; missing audit file = 0).
    let failureSummaryLine = '';
    try {
      const audit = await import('../core/audit-synopsis.ts');
      const events = audit.readRecentSynopsisFailures(7);
      const summary = audit.summarizeSynopsisFailures(events);
      if (summary && summary.total > 0) {
        const rate = (summary.page_level_fallback_rate * 100).toFixed(1);
        failureSummaryLine =
          ` ${summary.total} synopsis failure(s) in last 7d ` +
          `(${summary.page_level_fallback_count} triggered page-level fall-back, ${rate}%).`;
      }
    } catch {
      // Audit module unavailable — skip the summary line.
    }

    if (chunkerDrift === 0 && modeNull === 0 && failureSummaryLine === '') {
      return {
        name: 'contextual_retrieval_coverage',
        status: 'ok',
        message: 'All markdown pages aligned to current chunker + CR mode.',
      };
    }

    const parts: string[] = [];
    if (chunkerDrift > 0) {
      parts.push(`${chunkerDrift} page(s) at older chunker_version`);
    }
    if (modeNull > 0) {
      parts.push(`${modeNull} page(s) never evaluated against CR ladder`);
    }
    const fixHint =
      chunkerDrift > 0 || modeNull > 0
        ? ` Run \`gbrain reindex --markdown\` to align.`
        : '';
    return {
      name: 'contextual_retrieval_coverage',
      status: chunkerDrift > 0 || modeNull > 0 ? 'warn' : 'ok',
      message: `${parts.join('; ')}.${fixHint}${failureSummaryLine}`,
    };
  } catch (e) {
    return {
      name: 'contextual_retrieval_coverage',
      status: 'warn',
      message: `Could not check contextual retrieval coverage: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

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
/**
 * v0.41 Bug 2 / Eng D8 — surfaces rate-lease pressure from
 * `minion_lease_pressure_log` (populated by the worker's lease-full bypass
 * path). The operator's primary forensic signal for "is the lease cap too
 * tight" — without this check, the v0.41 bypass would be invisible (no
 * dead-letter, but also no operator awareness).
 *
 * Thresholds (windowed at 24h):
 *   0 bounces                                            → ok ("no pressure")
 *   1-99 bounces                                         → ok ("transient")
 *   100+ bounces + subagent jobs completed in same window → ok ("healthy backpressure")
 *   100+ bounces + ZERO completed subagent jobs           → warn (paste-ready cap-raise hint)
 *   1000+ bounces                                        → fail ("blocking real work")
 *
 * Works on both Postgres + PGLite (migration v94 creates the table on both).
 * Pre-v93 brains (no table) silently skip with an OK message.
 */
export async function checkSubagentHealth(engine: BrainEngine): Promise<Check> {
  try {
    const bounceRows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_lease_pressure_log
        WHERE bounced_at > now() - interval '24 hours'`,
    );
    const bounces = parseInt(bounceRows[0]?.count ?? '0', 10);
    if (bounces === 0) {
      return {
        name: 'subagent_health',
        status: 'ok',
        message: 'No rate-lease pressure in last 24h',
      };
    }
    if (bounces >= 1000) {
      return {
        name: 'subagent_health',
        status: 'fail',
        message: `${bounces} lease-pressure bounces in last 24h — this is blocking real work. Raise the cap: \`export GBRAIN_ANTHROPIC_MAX_INFLIGHT=64\` (or \`unlimited\` for Azure / Bedrock / self-hosted upstreams with no provider-side rate limit). After raising, restart \`gbrain jobs work\`.`,
      };
    }
    // 1-999 bounces: cross-check forward progress.
    const completedRows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs
        WHERE finished_at > now() - interval '24 hours'
          AND status = 'completed'
          AND name = 'subagent'`,
    ).catch(() => [{ count: '0' }]);
    const completed = parseInt(completedRows[0]?.count ?? '0', 10);
    if (bounces >= 100 && completed === 0) {
      return {
        name: 'subagent_health',
        status: 'warn',
        message: `${bounces} lease-pressure bounces in last 24h with no completed subagent jobs — cap is too tight. Raise via \`export GBRAIN_ANTHROPIC_MAX_INFLIGHT=64\` (or \`unlimited\` for upstreams with no provider-side cap).`,
      };
    }
    return {
      name: 'subagent_health',
      status: 'ok',
      message: `Lease pressure: ${bounces} bounces in last 24h, ${completed} subagent jobs completed — backpressure is binding but throughput is healthy`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env.GBRAIN_DEBUG === '1') {
      process.stderr.write(`[doctor] subagent_health skipped: ${msg}\n`);
    }
    return {
      name: 'subagent_health',
      status: 'ok',
      message: 'Skipped (minion_lease_pressure_log unavailable — pre-v0.41 brain)',
    };
  }
}

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
 * v0.40.4 graph_signals_coverage doctor check.
 *
 * Surfaces whether the brain's link density is high enough for the
 * v0.40.4 graph-signals stage to meaningfully fire. Logic:
 *
 *   1. Resolve the active graph_signals setting (config override OR
 *      mode-bundle default). When OFF → silent ok (no metric noise on
 *      installs that don't use the feature).
 *
 *   2. When ON, compute the global density: % of pages with >=1
 *      inbound link. This is a STRUCTURAL lower bound — top-K
 *      subgraphs need at least some edges to fire any signal.
 *      Codex outside-voice #14 noted this is an imperfect proxy
 *      (T-todo-5 will replace it with actual fire-rate measurement
 *      from search-stats after 30 days of data).
 *
 *   3. >=30% → ok with the percentage.
 *      <10%  → warn (mismatch: signal enabled but link graph is too
 *              sparse to fire often; fix: `gbrain extract all` to
 *              populate the link graph from frontmatter + markdown).
 *      10-29% → ok with note (signal will fire occasionally).
 *
 * Errors during the SQL count → warn with the underlying message.
 * Best-effort: this check never breaks doctor.
 */
export async function checkGraphSignalsCoverage(engine: BrainEngine): Promise<Check> {
  try {
    // Resolve the active graph_signals setting. Read the config key
    // explicitly; when unset, fall through to the mode bundle default.
    const cfgVal = await engine.getConfig('search.graph_signals');
    let enabled: boolean;
    if (cfgVal !== null && cfgVal !== undefined) {
      // v0.40.4 codex F1 — case-insensitive + trim, parity with
      // loadOverridesFromConfig in src/core/search/mode.ts. Without
      // this, `gbrain config set search.graph_signals TRUE` enables
      // the feature in production but doctor reports "disabled".
      const v = cfgVal.trim().toLowerCase();
      enabled = v === 'true' || v === '1';
    } else {
      // Mode bundle default. Read search.mode (case-insensitive + trim
      // parity with isSearchMode + DEFAULT_SEARCH_MODE fallback).
      const modeRaw = await engine.getConfig('search.mode');
      const modeVal = typeof modeRaw === 'string' ? modeRaw.trim().toLowerCase() : '';
      const mode = modeVal === 'conservative' || modeVal === 'tokenmax' ? modeVal : 'balanced';
      // Hardcoded knowledge of the mode bundle defaults — keeps the
      // doctor check from pulling in the full search/mode.ts surface.
      enabled = mode !== 'conservative';
    }

    if (!enabled) {
      return {
        name: 'graph_signals_coverage',
        status: 'ok',
        message: 'graph_signals disabled — coverage not checked',
      };
    }

    // Compute global inbound-link density. Counts DISTINCT pages with
    // at least one inbound edge / total pages.
    const totalRows = await engine.executeRaw(`SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL`);
    const totalPages = Number((totalRows as any)[0]?.n ?? 0);

    if (totalPages === 0) {
      return {
        name: 'graph_signals_coverage',
        status: 'ok',
        message: 'Empty brain — no pages to compute coverage against',
      };
    }

    const linkedRows = await engine.executeRaw(
      `SELECT COUNT(DISTINCT l.to_page_id)::int AS n
       FROM links l
       JOIN pages p ON p.id = l.to_page_id
       WHERE p.deleted_at IS NULL`
    );
    const linkedPages = Number((linkedRows as any)[0]?.n ?? 0);
    const pct = (linkedPages / totalPages) * 100;
    const pctStr = pct.toFixed(1);

    if (pct < 10) {
      return {
        name: 'graph_signals_coverage',
        status: 'warn',
        message: `graph_signals enabled but only ${pctStr}% of pages have inbound links (<10%). Signal will rarely fire. Fix: \`gbrain extract all\` to populate the link graph from frontmatter + markdown.`,
      };
    }

    return {
      name: 'graph_signals_coverage',
      status: 'ok',
      message: pct >= 30
        ? `${pctStr}% of pages have inbound links (>=30% — graph signals fire on most queries)`
        : `${pctStr}% of pages have inbound links (10-29% — graph signals fire occasionally)`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      name: 'graph_signals_coverage',
      status: 'warn',
      message: `Could not check graph_signals_coverage: ${msg}`,
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
    // v0.37 fix wave (Lane E.3 + CDX2-10): read from gateway, not DB.
    // The file plane is canonical post-v0.37; the DB config table is
    // schema-applied metadata. Reading DB here would skip the warning
    // when the user has a fresh install with no DB config row yet.
    const { getEmbeddingModel } = await import('../core/ai/gateway.ts');
    const { loadConfigFileOnly } = await import('../core/config.ts');
    let model = '';
    try { model = getEmbeddingModel(); } catch { /* gateway unconfigured */ }
    if (!model.startsWith('zeroentropyai:')) {
      return {
        name: 'ze_embedding_health',
        status: 'ok',
        message: `Configured embedding model "${model || 'default'}" is not ZeroEntropy — skip.`,
      };
    }
    const envKey = process.env.ZEROENTROPY_API_KEY;
    // File plane: zeroentropy_api_key on GBrainConfig (added by C.3).
    const fileKey = loadConfigFileOnly()?.zeroentropy_api_key;
    if (!envKey && !fileKey) {
      return {
        name: 'ze_embedding_health',
        status: 'warn',
        message:
          `embedding_model="${model}" but ZEROENTROPY_API_KEY is not set. ` +
          `Fix: get a key at https://dashboard.zeroentropy.dev and either ` +
          `\`export ZEROENTROPY_API_KEY=...\` or edit ~/.gbrain/config.json ` +
          `to add "zeroentropy_api_key": "...". (gbrain config set writes the DB plane, which the embed pipeline ignores.)`,
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
    // v0.37 fix wave (Lane E.1 + CDX-8): read from gateway, not DB. The
    // file plane is canonical post-v0.37; the DB config table is
    // schema-applied metadata. Reading DB here silently skipped the
    // check on fresh installs whose DB config row hadn't been written
    // yet.
    const { getEmbeddingDimensions, getEmbeddingModel } = await import('../core/ai/gateway.ts');
    let configDim: number;
    let resolvedModel: string;
    try {
      configDim = getEmbeddingDimensions();
      resolvedModel = getEmbeddingModel();
    } catch {
      return {
        name: 'embedding_width_consistency',
        status: 'ok',
        message: 'gateway not configured — skipping width check.',
      };
    }
    if (!Number.isFinite(configDim) || configDim <= 0) {
      return {
        name: 'embedding_width_consistency',
        status: 'warn',
        message: `gateway returned non-positive embedding dimension "${configDim}".`,
      };
    }

    // Read the actual column width via the existing helper (shared with
    // init.ts and embed.ts dim-mismatch pre-flight). One source of truth.
    const { readContentChunksEmbeddingDim, embeddingMismatchMessage } = await import('../core/embedding-dim-check.ts');
    const existing = await readContentChunksEmbeddingDim(engine);
    if (!existing.exists) {
      return {
        name: 'embedding_width_consistency',
        status: 'warn',
        message: 'content_chunks.embedding column not found. Fix: run `gbrain init --migrate-only` or check schema.',
      };
    }
    if (existing.dims === null) {
      return {
        name: 'embedding_width_consistency',
        status: 'warn',
        message: 'content_chunks.embedding is not a vector type. Schema may be corrupt.',
      };
    }
    if (existing.dims !== configDim) {
      // E.2: use the engine-kind-branched recipe instead of pointing at
      // the no-op `gbrain config set` path. The recipe is paste-ready
      // for the brain's actual engine.
      const databasePath = (engine as { _savedConfig?: { database_path?: string } })._savedConfig?.database_path;
      const recipe = embeddingMismatchMessage({
        currentDims: existing.dims,
        requestedDims: configDim,
        requestedModel: resolvedModel,
        source: 'doctor',
        engineKind: engine.kind,
        databasePath,
      });
      return {
        name: 'embedding_width_consistency',
        status: 'warn',
        message:
          `Schema width mismatch: content_chunks.embedding is vector(${existing.dims}) but ` +
          `gateway resolved embedding_dimensions = ${configDim}.\n\n${recipe}`,
      };
    }
    return {
      name: 'embedding_width_consistency',
      status: 'ok',
      message: `Schema width (${existing.dims}d) matches gateway embedding_dimensions`,
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

/**
 * v0.37.7.0 — Tier 5K source_routing_health (D5 lock: 200-page total cap).
 *
 * On a multi-source brain, sample up to 200 recent pages across all
 * non-default sources (per-source cap = min(50, ceil(200/N))). Warn
 * when:
 *  - A non-default source has zero pages (silent-collapse-to-default
 *    fingerprint from #1167 + #1222).
 *  - The brain repo has a `.gitignore` file but
 *    `sync.respect_gitignore` is unset/false (info-line nudge for
 *    Tier 4I's opt-in flag).
 *
 * Cost-bounded: total cap of 200 means a 20-source CEO brain pays
 * 20*10 = 200 selects rather than 20*50 = 1000.
 */
export async function checkSourceRoutingHealth(engine: BrainEngine): Promise<Check> {
  try {
    const sources = await engine.executeRaw<{ id: string }>(
      `SELECT id FROM sources WHERE id <> 'default'`,
    );
    if (sources.length === 0) {
      return { name: 'source_routing_health', status: 'ok', message: 'Single-source brain (no federation to check)' };
    }
    const perSourceCap = Math.min(50, Math.ceil(200 / Math.max(1, sources.length)));
    const emptySources: string[] = [];
    for (const s of sources) {
      const rows = await engine.executeRaw<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM pages WHERE source_id = $1 LIMIT $2`,
        [s.id, perSourceCap],
      );
      if (Number(rows[0]?.n ?? 0) === 0) {
        emptySources.push(s.id);
      }
    }
    if (emptySources.length > 0) {
      return {
        name: 'source_routing_health',
        status: 'warn',
        message:
          `${emptySources.length} non-default source(s) have zero pages: ${emptySources.join(', ')}. ` +
          `If you've recently run \`gbrain import --source-id <id>\` against these, the writes may have ` +
          `silently fallen to the default source pre-v0.37.7.0. Re-run with --source-id; verify via ` +
          `\`gbrain sources current --json\`.`,
      };
    }
    return {
      name: 'source_routing_health',
      status: 'ok',
      message: `Multi-source brain (${sources.length} non-default source(s)); all populated`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'source_routing_health', status: 'warn', message: `Check failed: ${msg}` };
  }
}

/**
 * v0.40 Federated Sync v2 (T12) — federation_health.
 *
 * Per-source dashboard surface for the autopilot/operator.
 * Three-state per-source (then aggregated to single Check):
 *
 *   ok    — all federated sources synced within 1h AND embed coverage >=95%
 *           (or chunks <100), AND failed_jobs_24h < 3
 *   warn  — any source has lag > 1h + federated, OR coverage < 95% with
 *           chunks > 100, OR failed_jobs_24h >= 3
 *   fail  — any source has lag > 24h, OR coverage < 50% with chunks > 1000
 *
 * Single-source brain short-circuits to ok (no federation to check).
 * Each warning carries a paste-ready remediation hint.
 */
export async function checkFederationHealth(engine: BrainEngine): Promise<Check> {
  try {
    const { loadAllSources } = await import('../core/sources-load.ts');
    const { computeAllSourceMetrics } = await import('../core/source-health.ts');
    const sources = await loadAllSources(engine, { includeArchived: false });
    if (sources.length <= 1) {
      return {
        name: 'federation_health',
        status: 'ok',
        message: 'Single-source brain (no federation to check)',
      };
    }
    const metrics = await computeAllSourceMetrics(engine, sources);

    const warns: string[] = [];
    const fails: string[] = [];
    for (const m of metrics) {
      // Fail thresholds first (most severe)
      if (m.lag_seconds !== null && m.lag_seconds > 24 * 3600) {
        fails.push(`${m.source_id}: stale ${Math.floor(m.lag_seconds / 3600)}h — run \`gbrain sync trigger --source ${m.source_id}\``);
        continue;
      }
      if (m.embed_coverage_pct < 50 && m.total_chunks > 1000) {
        fails.push(`${m.source_id}: ${m.embed_coverage_pct.toFixed(1)}% embed coverage (${m.total_chunks.toLocaleString()} chunks) — run \`gbrain jobs submit embed-backfill --params '{"sourceId":"${m.source_id}"}'\``);
        continue;
      }
      // Warns
      if (m.federated && m.lag_seconds !== null && m.lag_seconds > 3600) {
        warns.push(`${m.source_id}: federated source ${Math.floor(m.lag_seconds / 3600)}h+ stale — run \`gbrain sync trigger --source ${m.source_id}\``);
      }
      if (m.embed_coverage_pct < 95 && m.total_chunks > 100) {
        warns.push(`${m.source_id}: ${m.embed_coverage_pct.toFixed(1)}% embed coverage — run \`gbrain jobs submit embed-backfill --params '{"sourceId":"${m.source_id}"}'\``);
      }
      if (m.failed_jobs_24h >= 3) {
        warns.push(`${m.source_id}: ${m.failed_jobs_24h} failures in 24h — check \`gbrain jobs list --status failed\``);
      }
    }

    if (fails.length > 0) {
      return {
        name: 'federation_health',
        status: 'fail',
        message: `${fails.length} federation failure(s):\n  ${fails.join('\n  ')}`,
      };
    }
    if (warns.length > 0) {
      return {
        name: 'federation_health',
        status: 'warn',
        message: `${warns.length} federation warning(s):\n  ${warns.join('\n  ')}`,
      };
    }
    return {
      name: 'federation_health',
      status: 'ok',
      message: `${metrics.length} source(s) healthy (parallel sync, async embed)`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'federation_health', status: 'warn', message: `Check failed: ${msg}` };
  }
}

/**
 * v0.37.7.0 — Tier 5L oauth_confidential_client_health.
 *
 * Confidential OAuth clients (token_endpoint_auth_method != 'none')
 * MUST have a non-NULL client_secret_hash. v0.34.1.0's #909 fix
 * intentionally NULLs the column for public PKCE clients; if any
 * row claims confidential auth but has NULL hash, that's the
 * regression fingerprint from #1166.
 */
export async function checkOauthConfidentialHealth(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ client_id: string; method: string | null; hash: string | null }>(
      `SELECT client_id,
              token_endpoint_auth_method AS method,
              client_secret_hash AS hash
         FROM oauth_clients`,
    );
    if (rows.length === 0) {
      return { name: 'oauth_confidential_client_health', status: 'ok', message: 'No OAuth clients registered' };
    }
    const broken = rows.filter(r => {
      const isPublic = r.method === 'none';
      return !isPublic && (r.hash == null || r.hash === '');
    });
    if (broken.length > 0) {
      return {
        name: 'oauth_confidential_client_health',
        status: 'fail',
        message:
          `${broken.length} confidential OAuth client(s) have NULL/empty secret hash: ${broken.map(b => b.client_id).slice(0, 5).join(', ')}` +
          (broken.length > 5 ? ` (+${broken.length - 5} more)` : '') +
          `. Fix: \`gbrain auth revoke-client <id> && gbrain auth register-client …\` for each, OR \`gbrain upgrade\` if pre-v0.37.7.0.`,
      };
    }
    return {
      name: 'oauth_confidential_client_health',
      status: 'ok',
      message: `${rows.length} OAuth client(s) registered; all auth shapes consistent`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Pre-OAuth schema (oauth_clients table missing) → ok.
    if (msg.toLowerCase().includes('relation') && msg.toLowerCase().includes('does not exist')) {
      return { name: 'oauth_confidential_client_health', status: 'ok', message: 'OAuth not configured (skipping)' };
    }
    return { name: 'oauth_confidential_client_health', status: 'warn', message: `Check failed: ${msg}` };
  }
}

/**
 * v0.37.7.0 — Tier 5M autopilot_lock_scope (PID-safe hint per codex CF11).
 *
 * Detects stale autopilot lockfiles. When `GBRAIN_HOME` is set, the
 * canonical lock path lives under `gbrainPath('autopilot.lock')`.
 * If a hardcoded `~/.gbrain/autopilot.lock` ALSO exists outside the
 * current `GBRAIN_HOME`, that's a pre-v0.37.7.0 leftover or a
 * different brain's lock. Hint includes PID + a `ps -p` check so
 * the user verifies before deleting.
 */
export function checkAutopilotLockScope(): Check {
  try {
    const canonical = gbrainPath('autopilot.lock');
    const home = process.env.HOME || '';
    const legacy = home ? `${home}/.gbrain/autopilot.lock` : '';
    // Same path → nothing to surface.
    if (canonical === legacy || !legacy || !existsSync(legacy)) {
      return { name: 'autopilot_lock_scope', status: 'ok', message: `Lock path: ${canonical}` };
    }
    // legacy lock exists outside GBRAIN_HOME. Read its PID for a safe hint.
    let owningPid: string = 'unknown';
    try {
      const raw = readFileSync(legacy, 'utf8').trim();
      if (/^\d+$/.test(raw)) owningPid = raw;
    } catch { /* unreadable → leave 'unknown' */ }
    return {
      name: 'autopilot_lock_scope',
      status: 'warn',
      message:
        `Stale lockfile outside GBRAIN_HOME: ${legacy} (owning PID: ${owningPid}). ` +
        `Verify with \`ps -p ${owningPid}\` — if the process is dead, \`rm ${legacy}\`. ` +
        `If alive, identify it (\`ps -fp ${owningPid}\`) and stop before deleting.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'autopilot_lock_scope', status: 'warn', message: `Check failed: ${msg}` };
  }
}

/**
 * v0.41.6.0 D3 — stale_locks doctor check.
 *
 * Surfaces every row in `gbrain_cycle_locks` whose `ttl_expires_at < NOW()`.
 * The TTL is the canonical staleness signal already trusted by
 * tryAcquireDbLock's UPDATE-on-conflict SQL — when TTL is in the past,
 * the next acquire attempt will sweep the row anyway. Doctor's job is to
 * warn the user proactively so the next sync doesn't get a surprise
 * "Another sync is in progress" with no fix hint.
 *
 * Paste-ready hint per stale lock: names the source-id from the
 * `gbrain-sync:<source>` lock-key shape so users can copy-paste the
 * exact recovery command.
 *
 * Out of scope (filed as v0.41+ follow-up TODO): detection of
 * "wedged but TTL-refreshing" locks where a refresh thread is alive
 * but the main work is blocked. Requires explicit heartbeat probe;
 * speculation until production data shows the case.
 */
export async function checkStaleLocks(engine: BrainEngine): Promise<Check> {
  try {
    const { listStaleLocks } = await import('../core/db-lock.ts');
    const stale = await listStaleLocks(engine);
    if (stale.length === 0) {
      return { name: 'stale_locks', status: 'ok', message: 'No stale locks (no rows with ttl_expires_at < NOW())' };
    }
    const lines = stale.slice(0, 10).map(s => {
      const ageH = Math.floor(s.age_ms / 3600_000);
      const source = s.id.startsWith('gbrain-sync:') ? s.id.slice('gbrain-sync:'.length) : null;
      const breakHint = source ? `gbrain sync --break-lock --source ${source}` : `gbrain sync --break-lock`;
      return `  ${s.id} (pid ${s.holder_pid} on ${s.holder_host}, age ${ageH}h) → ${breakHint}`;
    });
    const tail = stale.length > 10 ? `  ... and ${stale.length - 10} more.` : null;
    return {
      name: 'stale_locks',
      status: 'warn',
      message: [
        `${stale.length} stale lock(s) detected (ttl_expires_at < NOW()):`,
        ...lines,
        tail,
      ].filter(Boolean).join('\n'),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Pre-v0.30 brains may not have the gbrain_cycle_locks table yet.
    if (/relation .* does not exist|no such table/i.test(msg)) {
      return { name: 'stale_locks', status: 'ok', message: 'gbrain_cycle_locks table not yet provisioned (skipping)' };
    }
    return { name: 'stale_locks', status: 'warn', message: `Check failed: ${msg}` };
  }
}

/**
 * v0.38 — cycle_phase_scope check (informational).
 *
 * Renders the static `PHASE_SCOPE` taxonomy from `src/core/cycle.ts` so
 * operators (and future automation) can see at a glance which phases
 * are safe to parallelize per source vs which serialize brain-wide.
 *
 * Always returns 'ok' — this is documentation, not enforcement. The
 * runtime-enforcement TODO is deferred per plan.
 */
export function checkCyclePhaseScope(): Check {
  try {
    // Lazy require to avoid pulling cycle.ts into doctor's import graph
    // for non-cycle-related doctor runs. Same pattern as the existing
    // dynamic imports elsewhere in this file.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { ALL_PHASES, PHASE_SCOPE } = require('../core/cycle.ts') as {
      ALL_PHASES: ReadonlyArray<string>;
      PHASE_SCOPE: Record<string, 'source' | 'global' | 'mixed'>;
    };
    const counts: Record<'source' | 'global' | 'mixed', number> = { source: 0, global: 0, mixed: 0 };
    const breakdown: Record<string, string[]> = { source: [], global: [], mixed: [] };
    for (const phase of ALL_PHASES) {
      const scope = PHASE_SCOPE[phase];
      if (scope) {
        counts[scope]++;
        breakdown[scope].push(phase);
      }
    }
    return {
      name: 'cycle_phase_scope',
      status: 'ok',
      message:
        `Phase taxonomy: ${counts.source} source-scoped, ${counts.global} brain-global, ` +
        `${counts.mixed} mixed. Source-safe: [${breakdown.source.join(', ')}]. ` +
        `Brain-global: [${breakdown.global.join(', ')}]. Mixed: [${breakdown.mixed.join(', ')}].`,
      details: {
        phase_scope_map: PHASE_SCOPE,
        counts,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name: 'cycle_phase_scope', status: 'warn', message: `Check failed: ${msg}` };
  }
}

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

/**
 * v0.41.2.1 — embedding_env_override (D9 #9). Defense-in-depth for the
 * ze-switch env-override class (the 716K-chunk damage incident from
 * PR #1421's description).
 *
 * GBRAIN_EMBEDDING_MODEL / GBRAIN_EMBEDDING_DIMENSIONS win over DB+file
 * config in loadConfig(). When env disagrees with DB, the gateway embeds
 * with the env-selected model — even after ze-switch wrote a different
 * value to DB. This check surfaces that disagreement on every hourly
 * doctor run so users can spot the drift before the embed sweep corrupts
 * vectors at the wrong width.
 *
 * Uses Check.details (NOT Check.issues, which has a different schema)
 * so the structured `mismatches[]` payload is consumable by monitoring
 * pipelines without ad-hoc type widening.
 *
 * Cross-surface parity: wired into BOTH buildChecks() and
 * doctorReportRemote() — operators running thin-client doctor against
 * a remote brain see the server's env, which is the env that matters
 * for the embed pipeline running there.
 */
async function checkEmbeddingEnvOverride(engine: BrainEngine): Promise<Check> {
  const envModel = process.env.GBRAIN_EMBEDDING_MODEL?.trim();
  const envDim = process.env.GBRAIN_EMBEDDING_DIMENSIONS?.trim();
  if (!envModel && !envDim) {
    return {
      name: 'embedding_env_override',
      status: 'ok',
      message: 'no embedding env overrides set',
    };
  }
  let dbModel: string | null = null;
  let dbDim: string | null = null;
  try {
    dbModel = await engine.getConfig('embedding_model');
    dbDim = await engine.getConfig('embedding_dimensions');
  } catch (err) {
    return {
      name: 'embedding_env_override',
      status: 'warn',
      message: `couldn't read DB config to compare env: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const mismatches: Array<{ key: string; env: string; db: string }> = [];
  if (envModel && dbModel && envModel !== dbModel) {
    mismatches.push({ key: 'GBRAIN_EMBEDDING_MODEL', env: envModel, db: dbModel });
  }
  if (envDim && dbDim && envDim !== dbDim) {
    mismatches.push({ key: 'GBRAIN_EMBEDDING_DIMENSIONS', env: envDim, db: dbDim });
  }
  if (mismatches.length === 0) {
    return {
      name: 'embedding_env_override',
      status: 'ok',
      message: 'env vars agree with DB config',
    };
  }
  return {
    name: 'embedding_env_override',
    status: 'warn',
    message:
      `${mismatches.length} embedding env var(s) disagree with DB config (env wins at runtime). ` +
      `Fix: \`unset ${mismatches.map((m) => m.key).join(' ')}\` in your shell profile / .env, ` +
      `or update DB config to match.`,
    details: { mismatches },
  };
}

async function checkSubagentCapability(engine: BrainEngine): Promise<Check> {
  try {
    const { classifyCapabilities } = await import('../core/ai/capabilities.ts');
    const tierSubagent = await engine.getConfig('models.tier.subagent');
    const modelsDefault = await engine.getConfig('models.default');

    // Helper: explain a verdict in user-facing terms.
    const explain = (resolved: string, source: string): Check | null => {
      const verdict = classifyCapabilities(resolved);
      if (verdict === 'unusable:no_tools') {
        return {
          name: 'subagent_capability',
          status: 'warn',
          message:
            `${source} is "${resolved}" but that provider/model lacks native tool calling. ` +
            `The subagent loop cannot run on this model — runtime will fall back to claude-sonnet-4-6. ` +
            `Fix: \`gbrain config set ${source} <provider>:<model-with-tools>\` (e.g. anthropic:claude-sonnet-4-6 or openai:gpt-5.2).`,
        };
      }
      if (verdict === 'unknown') {
        return {
          name: 'subagent_capability',
          status: 'warn',
          message:
            `${source} is "${resolved}" which references an unknown provider. ` +
            `Use a recipe-declared provider. ` +
            `Fix: \`gbrain config set ${source} anthropic:claude-sonnet-4-6\` or pick another known provider.`,
        };
      }
      if (verdict === 'degraded:no_caching') {
        return {
          name: 'subagent_capability',
          status: 'warn',
          message:
            `${source} is "${resolved}" — provider does not support prompt caching. ` +
            `The subagent loop runs hot (cost scales linearly with conversation length). ` +
            `For lower cost on long loops, use an Anthropic model: ` +
            `\`gbrain config set models.tier.subagent anthropic:claude-sonnet-4-6\`.`,
        };
      }
      return null;
    };

    if (tierSubagent) {
      const issue = explain(tierSubagent, 'models.tier.subagent');
      if (issue) return issue;
    } else if (modelsDefault) {
      const issue = explain(modelsDefault, 'models.default');
      if (issue) return issue;
    }
    // v0.37 (T10 / D7) + v0.38 (D7 capability rename): warn when the configured
    // chat_model is non-Anthropic AND ANTHROPIC_API_KEY isn't set. With
    // agent.use_gateway_loop=false (the v0.38 default), subagent jobs still
    // require Anthropic at runtime; without the key, gbrain dream / gbrain
    // agent run / gbrain autopilot will all fail at job submission. Catches
    // the post-init drift case the init-time caveat would have shown if init
    // had been re-run.
    try {
      const { loadConfig } = await import('../core/config.ts');
      const cfg = loadConfig();
      const chatModel = cfg?.chat_model;
      const { isAnthropicProvider } = await import('../core/model-config.ts');
      if (chatModel && !isAnthropicProvider(chatModel) && !process.env.ANTHROPIC_API_KEY) {
        return {
          name: 'subagent_capability',
          status: 'warn',
          message:
            `chat_model is "${chatModel}" (non-Anthropic) and ANTHROPIC_API_KEY is not set. ` +
            `Subagent features (gbrain dream, gbrain agent run, gbrain autopilot) will fail at job submission ` +
            `unless agent.use_gateway_loop=true. Chat alone (gbrain think) still works. ` +
            `Either set ANTHROPIC_API_KEY or enable: \`gbrain config set agent.use_gateway_loop true\`.`,
        };
      }
    } catch { /* loadConfig may throw; fall through */ }

    return {
      name: 'subagent_capability',
      status: 'ok',
      message: tierSubagent
        ? `Subagent tier resolves to "${tierSubagent}" with full tool-loop capability`
        : `Subagent tier resolves to default (claude-sonnet-4-6) — full tool-loop capability`,
    };
  } catch (e) {
    return {
      name: 'subagent_capability',
      status: 'warn',
      message: `Could not check subagent capability: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// v0.38 — `checkSubagentProvider` was renamed to `checkSubagentCapability` (D7).
// Back-compat alias preserved for any external doctor extensions importing it.
const checkSubagentProvider = checkSubagentCapability;
void checkSubagentProvider;

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
/**
 * v0.40.1.0 Track D / T7 — pure function form of the nightly_quality_probe_health
 * check. Extracted from the inline runDoctor block so tests can drive every
 * branch (disabled / enabled-no-events / enabled-all-pass / enabled-with-failures)
 * without spinning up the audit JSONL or a real config file.
 */
export function computeNightlyQualityProbeHealthCheck(
  probeEnabled: boolean,
  events: ReadonlyArray<{ outcome: string; ts: string; detail?: string }>,
): Check {
  const name = 'nightly_quality_probe_health';
  if (!probeEnabled && events.length === 0) {
    // Quiet skip — surface enable hint only when explicitly asked to.
    return {
      name,
      status: 'ok',
      message: `disabled (opt-in). Enable with: gbrain config set autopilot.nightly_quality_probe.enabled true`,
    };
  }
  if (events.length === 0) {
    return {
      name,
      status: 'ok',
      message: `enabled but no probe events in the last 7 days (next run by autopilot).`,
    };
  }
  // v0.40.1.0 Track D (codex CDX-5): any non-PASS outcome is bad signal.
  // Previously only fail / error / budget_exceeded triggered warn —
  // no_embedding_key / rate_limited / inconclusive were silently reported
  // as PASS, hiding real misconfigurations.
  const bad = events.filter(e => e.outcome !== 'pass');
  const latest = events[events.length - 1]!;
  if (bad.length > 0) {
    const counts =
      `pass=${events.filter(e => e.outcome === 'pass').length} ` +
      `fail=${events.filter(e => e.outcome === 'fail').length} ` +
      `error=${events.filter(e => e.outcome === 'error').length} ` +
      `inconclusive=${events.filter(e => e.outcome === 'inconclusive').length} ` +
      `budget=${events.filter(e => e.outcome === 'budget_exceeded').length} ` +
      `no_embed_key=${events.filter(e => e.outcome === 'no_embedding_key').length} ` +
      `rate_limited=${events.filter(e => e.outcome === 'rate_limited').length}`;
    return {
      name,
      status: 'warn',
      message: `${bad.length} non-PASS run${bad.length === 1 ? '' : 's'} in last 7d (${counts}). Latest: ${latest.outcome} at ${latest.ts}${latest.detail ? ` (${latest.detail})` : ''}.`,
    };
  }
  return {
    name,
    status: 'ok',
    message: `${events.length} PASS run${events.length === 1 ? '' : 's'} in last 7d. Latest: ${latest.ts}.`,
  };
}

/**
 * v0.41.11.0 — conversation_facts_backlog doctor check.
 *
 * 3-state status:
 *   - SKIPPED when cycle.conversation_facts_backfill.enabled=false
 *     (with paste-ready enable hint). No backlog enumeration; cheap probe.
 *     This is the Eng-v2 C9 "don't degrade health for opt-out users" gate.
 *   - OK when enabled=true AND backlog==0 OR no eligible pages exist.
 *   - WARN when enabled=true AND backlog>10.
 *
 * Backlog query uses the page-level TERMINAL audit row check (Eng-v2
 * C7), source-scoped via explicit predicate (Eng-v2 C2). Partial-
 * extraction pages stay in backlog because the terminal row isn't
 * written until ALL segments complete.
 *
 * Known approximation (documented in the details field): "complete"
 * means "terminal row exists" which means "all segments completed in
 * a prior run." A page with the terminal row from one run + new
 * messages since shows OK until the next run picks up new messages
 * and writes a fresh terminal row. The backlog is therefore an UPPER
 * BOUND on "pages with NO extraction at all", not "pages whose facts
 * are current."
 */
export async function computeConversationFactsBacklogCheck(
  engine: BrainEngine,
): Promise<Check> {
  const name = 'conversation_facts_backlog';
  try {
    // Read the same config the cycle phase reads (Eng-v2 A2 single SoT).
    const enabledRaw = await engine.getConfig(
      'cycle.conversation_facts_backfill.enabled',
    );
    const enabled = enabledRaw != null &&
      !['false', '0', 'no', 'off', ''].includes(enabledRaw.trim().toLowerCase());

    if (!enabled) {
      return {
        name,
        status: 'ok',
        message:
          'disabled (opt-in). Enable with: gbrain config set cycle.conversation_facts_backfill.enabled true',
      };
    }

    // Resolve types from same key as cycle phase + CLI default.
    const typesRaw = await engine.getConfig(
      'cycle.conversation_facts_backfill.types',
    );
    let types = ['conversation', 'meeting', 'slack', 'email'];
    if (typesRaw) {
      try {
        const parsed = JSON.parse(typesRaw);
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter(
            (t): t is string => typeof t === 'string',
          );
          if (filtered.length > 0) types = filtered;
        }
      } catch {
        // fall through to default
      }
    }

    // Source-scoped NOT EXISTS (Eng-v2 C2 + C7):
    //   - facts.source matches TERMINAL audit source
    //   - source_session matches terminal:<slug>
    //   - source_id matches page's source_id (cross-source safety)
    const rows = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM pages p
       WHERE p.type = ANY($1::text[])
         AND p.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM facts f
           WHERE f.source = 'cli:extract-conversation-facts:terminal'
             AND f.source_session = 'cli:extract-conversation-facts:terminal:' || p.slug
             AND f.source_id = p.source_id
         )`,
      [types],
    );

    const backlog = Number(rows[0]?.count ?? 0);

    if (backlog === 0) {
      return {
        name,
        status: 'ok',
        message: 'all eligible pages have extraction terminal audit rows',
        details: {
          backlog,
          types,
          known_approximation:
            'backlog counts pages with NO extraction terminal row; pages with new messages since prior extraction may show OK until next run',
        },
      };
    }

    if (backlog > 10) {
      const fixHint =
        'gbrain extract-conversation-facts --background --max-cost-usd 5';
      return {
        name,
        status: 'warn',
        message: `${backlog} eligible pages without extraction. Fix: ${fixHint}`,
        details: {
          backlog,
          types,
          fix_hint: fixHint,
          known_approximation:
            'backlog counts pages with NO extraction terminal row; pages with new messages since prior extraction may show OK until next run',
        },
      };
    }

    return {
      name,
      status: 'ok',
      message: `${backlog} eligible page(s) below warn threshold (>10)`,
      details: { backlog, types },
    };
  } catch (err) {
    return {
      name,
      status: 'warn',
      message: `backlog query failed: ${(err as Error).message}`,
    };
  }
}

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
        issues.push(`Source ${display} has never completed a full cycle`);
        hasFailures = true;
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
        message: `${issues.join('; ')}.`,
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
/**
 * Build the full check list for `gbrain doctor` against an engine + arg vector.
 *
 * The check-building seam: takes the same args as `runDoctor` minus the
 * --locks shortcut (locks-mode is a focused diagnostic the CLI wrapper
 * handles separately). Returns a `Check[]` array; the caller renders it
 * via `outputResults` and decides exit code. Early-exit cases (no engine,
 * connection failure) return a partial check array without calling
 * `process.exit` directly — the caller still renders + exits.
 *
 * v0.39 narrow-seam extract (audit-driven). The 10 `process.exit` sites
 * in this file all live in CLI wrappers (`runDoctor`, `runLocksCheck`,
 * the remediation subcommands). Behavioral tests drive `buildChecks`
 * directly via PGLite; the wrapper-level subprocess smoke in
 * `test/doctor-cli-smoke.test.ts` covers the render + exit paths that
 * a unit test can't reach in-process.
 *
 * Side effects retained inside buildChecks (kept for "no behavior change"):
 *   - `printAutoFixReport` on `--fix` non-JSON path
 *   - `progress` reporter writes to stderr (heartbeats per check)
 *   - `engine.executeRaw` / handler-leaf calls (the actual probe work)
 */
export async function buildChecks(
  engine: BrainEngine | null,
  args: string[],
  dbSource?: DbUrlSource,
): Promise<Check[]> {
  const jsonOutput = args.includes('--json');
  const fastMode = args.includes('--fast');
  const doFix = args.includes('--fix');
  const dryRun = args.includes('--dry-run');

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

  // 2b. Skill brain-first compliance (v0.36.x, supersedes PR #1206).
  // Scans every SKILL.md for external-lookup tools (web_search, exa,
  // perplexity, etc.) and warns when the skill doesn't declare
  // `brain_first: exempt` AND doesn't carry a canonical Convention
  // callout / Phase 1 brain heading / position-relative brain-first
  // reference. Motivated by the 2026-05-19 tweet-shield incident.
  //
  // Audit trail: snapshot+diff at ~/.gbrain/audit/skill-brain-first-
  // snapshot.json. Writes one detected/resolved JSONL line per state
  // transition + one fixed line per applied --fix. Stable brain → zero
  // audit writes per doctor run.
  if (skillsDir) {
    checks.push(skillBrainFirstCheck(skillsDir));
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
      // v0.40.3.0 T8b (D8 + D12 Bug 3): emit a single sync-retry-failed
      // step. sync-skip-failed is DELIBERATELY NOT emitted as a remediation
      // — auto-skipping failed syncs hides data loss. Operators can still
      // run `gbrain sync --skip-failed` manually.
      const { makeRemediationStep } = await import('../core/remediation-step.ts');
      const oldestTs = unacked.reduce(
        (acc, f) => (acc === '' || f.ts < acc ? f.ts : acc),
        '',
      );
      const retryStep = makeRemediationStep({
        id: 'sync-retry-failed',
        job: 'sync-retry-failed',
        // Content-stable per codex D12 Bug 2: count + oldest_ts captures
        // the relevant state without using a real timestamp.
        params: { failure_count: unacked.length, oldest_failure: oldestTs },
        severity: unacked.length >= 10 ? 'high' : 'medium',
        est_seconds: 30,
        est_usd_cost: 0,
        rationale: `Retry ${unacked.length} unacked sync failure(s) (codes: ${codeBreakdown})`,
      });
      checks.push({
        name: 'sync_failures',
        status: 'warn',
        message:
          `${unacked.length} unacknowledged sync failure(s) [${codeBreakdown}]. ${preview}` +
          `${unacked.length > 3 ? `, and ${unacked.length - 3} more` : ''}. ` +
          `Fix the file(s) and re-run 'gbrain sync', or use 'gbrain sync --skip-failed' to acknowledge.`,
        remediation: [retryStep],
        remediation_status: 'remediable',
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

  // 3d.1 Nightly quality probe (v0.40.1.0 Track D / T7). Reads the last
  // 7 days of quality-probe-YYYY-Www.jsonl audit events. SKIPPED with
  // paste-ready enable hint when the feature is opt-in disabled (default).
  // WARN on any FAIL / ERROR / BUDGET_EXCEEDED row in the window; OK when
  // all rows are PASS. The probe itself is wired into autopilot, NOT into
  // doctor — doctor just surfaces what the probe wrote.
  try {
    const { readRecentQualityProbeEvents } = await import('../core/audit-quality-probe.ts');
    const { loadConfig } = await import('../core/config.ts');
    let probeEnabled = false;
    try {
      const cfg = loadConfig();
      probeEnabled = Boolean((cfg as any)?.autopilot?.nightly_quality_probe?.enabled);
    } catch { /* config unavailable → treat as disabled */ }
    const events = readRecentQualityProbeEvents(7);
    const check = computeNightlyQualityProbeHealthCheck(probeEnabled, events);
    checks.push(check);
  } catch {
    // Best-effort; audit-log read failure shouldn't stop doctor.
  }

  // 3d.2 v0.41.11.0 — conversation_facts_backlog. 3-state status:
  // SKIPPED-with-enable-hint when the cycle phase is disabled (opt-out
  // users don't get noise debt); OK at backlog=0; WARN at backlog>10
  // with a paste-ready fix command. Emits a Remediation when WARN.
  if (engine) {
    try {
      const check = await computeConversationFactsBacklogCheck(engine);
      // Wire a remediation step on WARN so `gbrain doctor --remediate`
      // picks it up. The CLI command honors --max-cost-usd; the
      // remediation step caps at $5 default (matches doctor's max_usd
      // default for the remediate flow).
      if (check.status === 'warn') {
        try {
          const { makeRemediationStep } = await import('../core/remediation-step.ts');
          const remediation = makeRemediationStep({
            id: 'conversation_facts_backfill',
            job: 'extract-conversation-facts',
            params: { sourceId: 'default', maxCostUsd: 5 },
            severity: 'medium',
            est_seconds: 600,
            est_usd_cost: 5,
            rationale:
              'Backfill facts for conversation/meeting/slack/email pages so chunker-loses-anchor recall misses get a topical-header-rich facts row to bind to.',
          });
          check.remediation = [remediation];
          check.remediation_status = 'remediable';
        } catch {
          // remediation factory unavailable → check still surfaces backlog
        }
      }
      checks.push(check);
    } catch {
      // Best-effort; backlog query failure shouldn't stop doctor.
    }
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
    // Early return: caller renders the partial check list + decides exit code.
    // Pre-v0.39 this site called outputResults + process.exit directly; the
    // narrow-seam extract moved both to the runDoctor CLI wrapper.
    return checks;
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
    // Early return: caller renders the partial check list + decides exit code.
    // Pre-v0.39 this site called outputResults + process.exit directly; the
    // narrow-seam extract moved both to the runDoctor CLI wrapper.
    return checks;
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

    // v0.37 (T9, codex #7 nuance): catch the v0.36 silent-default case where
    // config has no embedding_model but the schema column exists at a dim
    // that doesn't match the gateway's resolved default. Empty-brain vs
    // non-empty-brain branching determines the repair hint:
    //   - empty brain (no embedded chunks) → `gbrain init --force --embedding-model …`
    //   - non-empty brain → `gbrain retrieval-upgrade --to … --reindex`
    // The bug-reporter's `rm -rf ~/.gbrain` recovery is never the right answer.
    let surfacedUnconfiguredDrift = false;
    try {
      const { loadConfig } = await import('../core/config.ts');
      const cfg = loadConfig();
      const fileEmbeddingSet = !!cfg?.embedding_model;
      const deferredSetup = cfg?.embedding_disabled === true;
      if (!fileEmbeddingSet && !deferredSetup) {
        // Read column dim + chunk count
        const { readContentChunksEmbeddingDim } = await import('../core/embedding-dim-check.ts');
        const colDim = await readContentChunksEmbeddingDim(engine);
        if (colDim.exists && colDim.dims !== null && colDim.dims !== configuredDims) {
          // Determine if the brain has any content — drift is only a real
          // user-facing problem once the user has imported anything. A
          // pristine brain (0 total chunks) is still in fresh-install state;
          // first import will hit the loud preflight before any column
          // write, so doctor doesn't need to pre-warn.
          let totalChunks = 0;
          let embeddedCount = 0;
          try {
            const rows = await engine.executeRaw<{ total: number | string; embedded: number | string }>(
              `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded FROM content_chunks`,
            );
            totalChunks = Number(rows?.[0]?.total ?? 0);
            embeddedCount = Number(rows?.[0]?.embedded ?? 0);
          } catch { /* table may be missing or fresh; treat as empty */ }

          if (totalChunks > 0) {
            const fix = embeddedCount === 0
              ? `No embeddings yet — drop the empty schema and re-init at the right dim:\n        gbrain init --force --pglite --embedding-model ${configuredModel} --embedding-dimensions ${configuredDims}`
              : `Non-empty brain (${embeddedCount} embedded chunks). Migrate cleanly:\n        gbrain retrieval-upgrade --to ${configuredModel} --reindex`;

            checks.push({
              name: 'embedding_provider',
              status: 'warn',
              message:
                `Schema column is vector(${colDim.dims}) but gateway default resolves to ${configuredModel} (${configuredDims}d). ` +
                `Persist your provider choice with \`gbrain config set embedding_model ${configuredModel}\` AND fix the schema:\n      ${fix}`,
            });
            surfacedUnconfiguredDrift = true;
          }
        }
      }
    } catch {
      // loadConfig may throw on a malformed config; let the existing
      // available/probe branch surface the issue.
    }

    if (surfacedUnconfiguredDrift) {
      // Bail out — the warn above is more actionable than the live probe.
    } else if (!available) {
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

  // 8b. v0.41.2.1 embedding_env_override (D9 #9 — uses Check.details, NOT
  //     Check.issues). Defense in depth for users who bypass ze-switch
  //     entirely; surfaces on every hourly doctor run when env disagrees
  //     with DB config. Mirrored in doctorReportRemote() via the shared
  //     checkEmbeddingEnvOverride() helper.
  progress.heartbeat('embedding_env_override');
  checks.push(await checkEmbeddingEnvOverride(engine));

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

  // 9b. v0.42.0.0 — orphan_ratio check (migration #1 of #1409).
  //
  // Surfaces the fraction of linkable pages with no inbound links.
  // Consumes the same canonical getOrphansData() pure fn as
  // `gbrain orphans --count` (D1), so the two surfaces cannot disagree.
  //
  // Skip when entity count < 100 (vacuous — small brains naturally
  // show high orphan ratio; not actionable signal).
  // Warn at >0.5; fail at >0.8. Both states recommend
  // `gbrain extract links --by-mention` as the fix.
  progress.heartbeat('orphan_ratio');
  try {
    const { getOrphansData } = await import('./orphans.ts');
    const entityCount = (await engine.executeRaw<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM pages WHERE type IN ('entity', 'person', 'company', 'organization') AND deleted_at IS NULL",
    ))[0]?.count ?? 0;
    if (entityCount < 100) {
      checks.push({
        name: 'orphan_ratio',
        status: 'ok',
        message: `Vacuous: ${entityCount} entity pages (<100). Orphan ratio not meaningful at this scale.`,
      });
    } else {
      const data = await getOrphansData(engine, { includePseudo: false });
      const ratio = data.total_linkable > 0 ? data.total_orphans / data.total_linkable : 0;
      const pct = (ratio * 100).toFixed(0);
      const hint =
        'Run: gbrain extract links --by-mention   (auto-links entity mentions in body text). ' +
        'Run gbrain orphans for the list.';
      if (ratio > 0.8) {
        checks.push({
          name: 'orphan_ratio',
          status: 'fail',
          message: `Orphan ratio ${pct}% (${data.total_orphans}/${data.total_linkable} linkable pages have no inbound links). ${hint}`,
        });
      } else if (ratio > 0.5) {
        checks.push({
          name: 'orphan_ratio',
          status: 'warn',
          message: `Orphan ratio ${pct}% (${data.total_orphans}/${data.total_linkable} linkable pages have no inbound links). ${hint}`,
        });
      } else {
        checks.push({
          name: 'orphan_ratio',
          status: 'ok',
          message: `Orphan ratio ${pct}% (${data.total_orphans}/${data.total_linkable} linkable pages)`,
        });
      }
    }
  } catch {
    checks.push({ name: 'orphan_ratio', status: 'warn', message: 'Could not check orphan ratio' });
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
      // v0.40.3.0 T8b (D8): emit integrity-auto RemediationStep.
      // Three-bucket repair handled by `gbrain integrity auto` (the
      // existing CLI). Deterministic — no LLM cost.
      const { makeRemediationStep } = await import('../core/remediation-step.ts');
      const integrityStep = makeRemediationStep({
        id: 'integrity-auto',
        job: 'integrity-auto',
        params: {
          bare_count: res.bareHits.length,
          external_count: res.externalHits.length,
          pages_scanned: res.pagesScanned,
        },
        severity: res.bareHits.length > 50 ? 'high' : 'medium',
        est_seconds: 60,
        est_usd_cost: 0,
        rationale: `Auto-repair ${res.bareHits.length} bare-tweet phrase(s)`,
      });
      checks.push({
        name: 'integrity',
        status: 'warn',
        message: `Sampled ${res.pagesScanned} pages; ${res.bareHits.length} bare-tweet phrase(s), ${res.externalHits.length} external link(s). Run: gbrain integrity check (or integrity auto to repair).`,
        remediation: [integrityStep],
        remediation_status: 'remediable',
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

  // 11b. Content sanity checks (v0.41).
  //
  // Three sibling checks all backed by the shared assessor in
  // src/core/content-sanity.ts so the surface stays aligned with the
  // ingest gate at importFromContent and the lint rules at lintContent.
  //
  // - oversized_pages: indexed-free table scan (~100ms on 100K-page brains)
  //   counting pages whose body (compiled_truth + timeline, UTF-8 bytes
  //   via octet_length per Codex r2 #13) exceeds the block threshold.
  //   Status warn when 1+ rows; never fail (oversize is now a soft state).
  // - scraper_junk_pages: capped 1000-most-recent default + --content-audit
  //   opt-in for full scan (D10 mirrors --index-audit precedent). Applies
  //   the assessor per-page on title + 2KB head-slice + frontmatter.
  // - content_sanity_audit_recent: reads ~/.gbrain/audit/content-sanity-*.jsonl
  //   over the last 7 days, aggregates by event type + source. Caveat
  //   (Codex r1 #14): JSONL is local-only — multi-host operators should
  //   share GBRAIN_AUDIT_DIR. Message names this so the limitation is
  //   visible at the doctor surface.
  const fullContentAudit = args.includes('--content-audit');
  progress.heartbeat('oversized_pages');
  try {
    const sql = db.getConnection();
    // Read effective bytes_block from the cached effectiveCfg loaded
    // earlier in this doctor run if available; otherwise default.
    // (We re-read here per-check to avoid threading config through
    // every check — bytes_block is read once per doctor run via
    // loadConfig which caches in module-level config layer.)
    const { loadConfig: _loadCfg } = await import('../core/config.ts');
    const _cfg = _loadCfg();
    const bytesBlock = _cfg?.content_sanity?.bytes_block ?? 500_000;
    const rows = await sql`
      SELECT p.slug, p.source_id,
             octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) AS bytes
      FROM pages p
      WHERE p.deleted_at IS NULL
        AND (octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, ''))) > ${bytesBlock}
      ORDER BY bytes DESC
      LIMIT 100
    `;
    if (rows.length === 0) {
      checks.push({
        name: 'oversized_pages',
        status: 'ok',
        message: `No pages exceed ${bytesBlock} bytes`,
      });
    } else {
      const oversizeRows = rows as unknown as Array<{ slug: string; source_id: string; bytes: number }>;
      const top = oversizeRows.slice(0, 3)
        .map(r => `${r.slug} (${r.bytes}b, src=${r.source_id})`)
        .join('; ');
      checks.push({
        name: 'oversized_pages',
        status: 'warn',
        message: `${rows.length} page(s) exceed ${bytesBlock}-byte block threshold. Top: ${top}. New ingests with the same shape get frontmatter.embed_skip set automatically; existing oversized pages can be split or accepted as non-embeddable.`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: 'oversized_pages',
      status: 'ok',
      message: `Skipped (${msg})`,
    });
  }

  progress.heartbeat('scraper_junk_pages');
  try {
    const sql = db.getConnection();
    const { assessContentSanity } = await import('../core/content-sanity.ts');
    const { loadOperatorLiterals } = await import('../core/content-sanity-literals.ts');
    const literals = loadOperatorLiterals();
    const scanLimit = fullContentAudit ? null : 1000;
    const rows = scanLimit
      ? await sql`
          SELECT p.slug, p.source_id, p.title,
                 LEFT(p.compiled_truth, 2048) AS body_head,
                 LEFT(COALESCE(p.timeline, ''), 1024) AS tl_head,
                 p.frontmatter
            FROM pages p
           WHERE p.deleted_at IS NULL
           ORDER BY p.updated_at DESC
           LIMIT ${scanLimit}
        `
      : await sql`
          SELECT p.slug, p.source_id, p.title,
                 LEFT(p.compiled_truth, 2048) AS body_head,
                 LEFT(COALESCE(p.timeline, ''), 1024) AS tl_head,
                 p.frontmatter
            FROM pages p
           WHERE p.deleted_at IS NULL
        `;
    const hits: Array<{ slug: string; matched: string[] }> = [];
    const scanRows = rows as unknown as Array<{ slug: string; source_id: string; title: string; body_head: string; tl_head: string; frontmatter: Record<string, unknown> | null }>;
    for (const r of scanRows) {
      const sanity = assessContentSanity({
        compiled_truth: r.body_head ?? '',
        timeline: r.tl_head ?? '',
        title: r.title ?? '',
        bytes_warn: Number.MAX_SAFE_INTEGER, // we ONLY care about junk-pattern hits here
        bytes_block: Number.MAX_SAFE_INTEGER,
        extra_literals: literals,
      });
      if (sanity.shouldHardBlock) {
        hits.push({
          slug: r.slug,
          matched: [...sanity.junk_pattern_matches, ...sanity.literal_substring_matches],
        });
      }
    }
    if (hits.length === 0) {
      checks.push({
        name: 'scraper_junk_pages',
        status: 'ok',
        message: scanLimit
          ? `No junk-pattern hits in ${rows.length} recent page(s) (use --content-audit for full scan)`
          : `No junk-pattern hits in ${rows.length} page(s) (full audit)`,
      });
    } else {
      const top = hits.slice(0, 3).map(h => `${h.slug} [${h.matched.join(',')}]`).join('; ');
      checks.push({
        name: 'scraper_junk_pages',
        status: 'warn',
        message: `${hits.length} page(s) match junk patterns. Top: ${top}. ${scanLimit ? '(scanned 1000 most-recent; rerun with --content-audit for full scan)' : '(full audit)'} New ingests with these shapes are now hard-blocked; existing inventory should be cleaned at source.`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: 'scraper_junk_pages',
      status: 'ok',
      message: `Skipped (${msg})`,
    });
  }

  progress.heartbeat('content_sanity_audit_recent');
  try {
    const { readRecentContentSanityEvents, summarizeContentSanityEvents } =
      await import('../core/audit/content-sanity-audit.ts');
    const events = readRecentContentSanityEvents(7);
    if (events.length === 0) {
      checks.push({
        name: 'content_sanity_audit_recent',
        status: 'ok',
        message: 'No content-sanity events in last 7 days (audit JSONL is local to this host; share GBRAIN_AUDIT_DIR for multi-host visibility)',
      });
    } else {
      const summary = summarizeContentSanityEvents(events);
      const topPatterns = summary.top_patterns.slice(0, 3).map(p => `${p.name}=${p.count}`).join(', ');
      const topSources = Object.entries(summary.by_source)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([s, n]) => `${s}=${n}`)
        .join(', ');
      const status: 'ok' | 'warn' | 'fail' =
        events.length >= 100 ? 'fail' : events.length >= 10 ? 'warn' : 'ok';
      checks.push({
        name: 'content_sanity_audit_recent',
        status,
        message: `${events.length} events (hard=${summary.by_type.hard_block} soft=${summary.by_type.soft_block} warn=${summary.by_type.warn})${topPatterns ? ', patterns: ' + topPatterns : ''}${topSources ? ', sources: ' + topSources : ''}. (Local audit only — multi-host operators set GBRAIN_AUDIT_DIR.)`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: 'content_sanity_audit_recent',
      status: 'ok',
      message: `Skipped (${msg})`,
    });
  }

  // 11a. Frontmatter integrity (v0.22.4, hardened in v0.38.2.0).
  // scanBrainSources walks every registered source's local_path on disk
  // (not from the DB), invoking parseMarkdown(..., {validate:true}) per
  // file. Reports per-source counts grouped by error code. The fix path is
  // `gbrain frontmatter validate <source-path> --fix`, which writes .bak
  // backups so it works for both git and non-git brain repos.
  //
  // v0.38.2.0 wave (this PR supersedes PR #1287):
  //  - `pruneDir` now applies at descent inside brain-writer.ts:walkDir so
  //    the scan no longer recurses into node_modules / .git / .obsidian /
  //    *.raw / ops. That alone takes the 216K-page user from "hangs
  //    forever" to "completes in seconds" on the typical brain.
  //  - `deadline` (per-file Date.now() check inside the sync loop) is the
  //    load-bearing wall-clock bound. AbortSignal.timeout (kept for
  //    between-source aborts) cannot interrupt sync readdirSync /
  //    readFileSync — codex outside-voice C1 caught the original plan's
  //    assumption that it could.
  //  - Partial-result surfacing: per-source status ('scanned' | 'partial' |
  //    'skipped'), files_scanned numerator, and an honest "scanned ~N files
  //    (source has ~M pages in DB)" message when the deadline fires. The
  //    `partial` and `aborted_at_source` fields on AuditReport feed the
  //    JSON consumer.
  //  - Configurable via GBRAIN_DOCTOR_FM_TIMEOUT_MS (default 30000ms).
  progress.heartbeat('frontmatter_integrity');
  const fmHb = startHeartbeat(progress, 'scanning frontmatter…');
  const fmTimeoutMs = (() => {
    const raw = process.env.GBRAIN_DOCTOR_FM_TIMEOUT_MS;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 30000;
  })();
  try {
    const { scanBrainSources } = await import('../core/brain-writer.ts');
    const fmDeadline = Date.now() + fmTimeoutMs;
    const fmAbort = AbortSignal.timeout(fmTimeoutMs);
    // Per-source DB denominator. Coarse — DB pages and on-disk syncable
    // files are overlapping but not identical (unsynced disk files,
    // soft-deleted DB rows, auto-generated pages). Wording in the partial
    // message makes the mismatch honest. Failure of the COUNT degrades to
    // null and the message falls back to bare numerator.
    const dbPageCountForSource = async (sourceId: string): Promise<number | null> => {
      try {
        const rows = await engine.executeRaw<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL`,
          [sourceId],
        );
        if (rows.length === 0) return null;
        const parsed = parseInt(rows[0].n, 10);
        return Number.isFinite(parsed) ? parsed : null;
      } catch {
        return null;
      }
    };
    const report = await scanBrainSources(engine, {
      signal: fmAbort,
      deadline: fmDeadline,
      dbPageCountForSource,
    });

    if (report.total === 0 && !report.partial) {
      const sources = report.per_source.length;
      checks.push({
        name: 'frontmatter_integrity',
        status: 'ok',
        message: sources === 0
          ? 'No registered sources to scan'
          : `${sources} source(s) clean — no frontmatter issues`,
      });
    } else {
      // Build per-source breakdown that distinguishes scanned / partial /
      // skipped so the user can tell which sources weren't checked.
      const sourceMessages: string[] = [];
      for (const src of report.per_source) {
        if (src.status === 'skipped') {
          // Codex adversarial #1: `gbrain frontmatter validate` takes a
          // filesystem PATH, not a source id. Pre-fix the hint pointed users
          // at a command that would fail with "no such directory" — breaking
          // the very remediation path this PR ships to give them.
          sourceMessages.push(
            `${src.source_id}: NOT SCANNED (timeout — run \`gbrain frontmatter validate ${src.source_path}\`)`,
          );
          continue;
        }
        if (src.status === 'partial') {
          const denom = src.db_page_count != null ? ` (source has ~${src.db_page_count} pages in DB)` : '';
          const codes = src.total > 0
            ? `, ${Object.entries(src.errors_by_code).map(([k, v]) => `${k}=${v}`).join(', ')}`
            : '';
          sourceMessages.push(
            `${src.source_id}: PARTIAL — scanned ~${src.files_scanned} files${denom}, ${src.total} issue(s) so far${codes}`,
          );
          continue;
        }
        // status === 'scanned'
        if (src.total === 0) continue; // clean source — don't clutter the message
        const codes = Object.entries(src.errors_by_code)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        sourceMessages.push(`${src.source_id}: ${src.total} (${codes})`);
      }
      const fixHint = report.partial
        ? `Raise GBRAIN_DOCTOR_FM_TIMEOUT_MS or run \`gbrain frontmatter validate <source>\` directly. Fix issues: \`gbrain frontmatter validate <source> --fix\``
        : `Fix: gbrain frontmatter validate <source-path> --fix`;
      checks.push({
        name: 'frontmatter_integrity',
        status: 'warn',
        message:
          `${report.total} frontmatter issue(s)` +
          (report.partial ? ` (PARTIAL SCAN — timeout after ${fmTimeoutMs / 1000}s)` : '') +
          `. ${sourceMessages.join('; ')}. ${fixHint}`,
      });
    }
  } catch (e) {
    // Codex outside-voice D4: the abort path returns cleanly via partial
    // state — this catch is purely for unexpected errors (FS permission,
    // OOM, disk full, etc.). Pre-v0.38.2.0 (PR #1287) had an unreachable
    // abort-classifier branch here; removed because timer-based aborts
    // in a sync walker can't surface as a thrown error anyway.
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

  // 11.4 subagent_capability (v0.38 — D7; was subagent_provider in v0.31.12). Surfaces a
  // warn when models.tier.subagent or models.default points at a non-Anthropic
  // provider. Layers 1 (queue.ts submit-time) and 2 (handler runtime) also
  // enforce; this is the surfacing layer so users see the config drift before
  // a job is submitted.
  progress.heartbeat('subagent_capability');
  checks.push(await checkSubagentCapability(engine));

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
    // v0.38 — full-cycle freshness, sibling to sync_freshness. Reads
    // last_full_cycle_at from sources.config; mirrors what autopilot's
    // per-source dispatch gate sees.
    progress.heartbeat('cycle_freshness');
    checks.push(await checkCycleFreshness(engine));
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
    // v0.40.4 graph_signals_coverage — global inbound-link density when
    // graph_signals is enabled in the active mode bundle.
    progress.heartbeat('graph_signals_coverage');
    checks.push(await checkGraphSignalsCoverage(engine));
    // v0.37.0 brainstorm_health — migration v79, track_retrieval, calibration cold-start.
    progress.heartbeat('brainstorm_health');
    checks.push(await checkBrainstormHealth(engine));
    // v0.36.0.0 (A5): ZE embedding key health + schema/config width consistency.
    progress.heartbeat('ze_embedding_health');
    checks.push(await checkZeEmbeddingHealth(engine));
    progress.heartbeat('embedding_width_consistency');
    checks.push(await checkEmbeddingWidthConsistency(engine));

    // v0.37.7.0 doctor checks (#1167, #1166, #1226) — fast-mode skipped
    // since these touch DB queries with cost on large brains.
    // 5K — source_routing_health (D5 lock: 200-page total cap)
    progress.heartbeat('source_routing_health');
    checks.push(await checkSourceRoutingHealth(engine));
    // 5L — oauth_confidential_client_health (success-path probe per codex CF8)
    progress.heartbeat('oauth_confidential_client_health');
    checks.push(await checkOauthConfidentialHealth(engine));
    // 5M — autopilot_lock_scope (PID-safe hint per codex CF11)
    progress.heartbeat('autopilot_lock_scope');
    checks.push(checkAutopilotLockScope());
    // v0.41.6.0 D3 — stale_locks (gbrain_cycle_locks rows with ttl_expires_at < NOW())
    progress.heartbeat('stale_locks');
    checks.push(await checkStaleLocks(engine));
    // v0.38 — cycle_phase_scope (informational; no DB cost)
    progress.heartbeat('cycle_phase_scope');
    checks.push(checkCyclePhaseScope());
  }

  progress.finish();

  return checks;
}

/**
 * CLI entry point for `gbrain doctor`. Thin wrapper around buildChecks +
 * computeDoctorReport + render + process.exit.
 *
 * Concerns kept here (not pushed into buildChecks):
 *   - --locks shortcut (focused diagnostic; calls runLocksCheck + returns)
 *   - outputResults render (stdout)
 *   - features teaser (non-JSON, non-failing only)
 *   - process.exit (10 sites total across runDoctor + runLocksCheck +
 *     runRemediationPlan + runRemediate)
 *
 * v0.39 narrow-seam extract — buildChecks is the unit-testable seam, this
 * wrapper is the wallclock + exit-code concerned function. See
 * test/doctor-behavioral.test.ts for the in-process seam coverage and
 * test/doctor-cli-smoke.test.ts for the subprocess wrapper coverage.
 */
export async function runDoctor(
  engine: BrainEngine | null,
  args: string[],
  dbSource?: DbUrlSource,
) {
  const jsonOutput = args.includes('--json');
  const locksMode = args.includes('--locks');

  // --locks is a focused diagnostic: it runs the same pg_stat_activity
  // query that `runMigrations` pre-flight uses, prints any idle-in-tx
  // backends, and exits. Referenced from migrate.ts's 57014 diagnostic.
  if (locksMode) {
    await runLocksCheck(engine, jsonOutput);
    return;
  }

  const checks = await buildChecks(engine, args, dbSource);
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

/**
 * v0.36.x skill_brain_first doctor check (supersedes PR #1206).
 *
 * Walks the skills manifest, runs the pure `analyzeSkillBrainFirst()`
 * helper on each, surfaces violators with structured issues[]. Snapshot-
 * diff against the previous run drives audit JSONL writes (transition-
 * only) — stable brains produce zero audit churn per doctor invocation.
 *
 * Exit shape:
 *   - 0 violators → status: 'ok', message: '<n> skills compliant or exempt'
 *   - any violator → status: 'warn', message + per-skill summary lines +
 *     formerly-EXEMPT_SKILLS hint when applicable (CMT1 replaces the
 *     dropped upgrade migration with a guided opt-in)
 *
 * Test seam: pure function, no `process.exit`. Direct call from tests
 * with a synthetic skills dir under tempdir.
 */
export function skillBrainFirstCheck(skillsDir: string): Check {
  let manifest: ReturnType<typeof loadOrDeriveManifest>;
  try {
    manifest = loadOrDeriveManifest(skillsDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: 'skill_brain_first',
      status: 'warn',
      message: `Could not load skills manifest from ${skillsDir} (${msg})`,
    };
  }
  if (manifest.skills.length === 0) {
    return {
      name: 'skill_brain_first',
      status: 'ok',
      message: 'No skills found — skill_brain_first not applicable',
    };
  }

  const violators: BrainFirstAnalysis[] = [];
  const typoSkills: BrainFirstAnalysis[] = [];

  for (const entry of manifest.skills) {
    const skillPath = join(skillsDir, entry.path);
    if (!existsSync(skillPath)) continue; // resolver_health already reports
    let content: string;
    try {
      content = readFileSync(skillPath, 'utf-8');
    } catch {
      continue; // best-effort; permissions etc.
    }
    const fm = parseSkillFrontmatter(content);
    const result = analyzeSkillBrainFirst(content, entry.name, fm);
    if (result.typo_hint) typoSkills.push(result);
    if (result.status === 'warn') violators.push(result);
  }

  // --- Snapshot + diff audit (A2 contract) ---------------------------------
  // Best-effort: snapshot/audit failures don't poison the check result.
  const violatorSlugs = new Set(violators.map(v => v.skill));
  const patternsBySlug = new Map<string, string[]>();
  for (const v of violators) {
    patternsBySlug.set(v.skill, v.external_patterns_matched);
  }
  let priorSnapshotPresent = true;
  try {
    const snapshot = loadSnapshot();
    priorSnapshotPresent = snapshot.present;
    const diff = diffAgainstSnapshot(violatorSlugs, snapshot.violators);
    const doctorRunId = `${process.pid}-${Date.now()}`;
    if (snapshot.present) {
      // Steady-state path: write events only for transitions.
      appendAuditEventsForTransitions(diff, patternsBySlug, doctorRunId);
    } else {
      // First run / corrupt snapshot: bootstrap by writing one
      // `detected` line per current violator. This is the only path
      // that writes more than `diff.added.length` lines in a single
      // doctor invocation.
      const bootstrapDiff = { added: Array.from(violatorSlugs).sort(), removed: [], unchanged: [] };
      appendAuditEventsForTransitions(bootstrapDiff, patternsBySlug, doctorRunId);
    }
    writeSnapshotAtomically(violatorSlugs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] skill_brain_first audit step failed (${msg}); check continues\n`);
  }

  // --- Build the check result ---------------------------------------------
  if (violators.length === 0) {
    const typoNote = typoSkills.length > 0
      ? ` (note: ${typoSkills.length} skill(s) have brain_first typo hints: ${typoSkills.map(t => t.skill).join(', ')})`
      : '';
    return {
      name: 'skill_brain_first',
      status: 'ok',
      message: `${manifest.skills.length} skill(s) compliant or exempt${typoNote}`,
    };
  }

  // Sort for deterministic message + issues order.
  violators.sort((a, b) => a.skill.localeCompare(b.skill));

  const formerlyExempt = violators.filter(v => v.formerly_hardcoded_exempt);
  const summary: string[] = [];
  summary.push(
    `${violators.length} skill(s) do external lookups without a brain-first compliance signal. ` +
    `Fix via 'gbrain doctor --fix' (adds canonical Convention callout) ` +
    `or set 'brain_first: exempt' in skill frontmatter for genuine infra skills.`,
  );
  if (formerlyExempt.length > 0) {
    summary.push(
      `Of these, ${formerlyExempt.length} were hardcoded-exempt in PR #1206 (${formerlyExempt.map(v => v.skill).slice(0, 6).join(', ')}${formerlyExempt.length > 6 ? ', ...' : ''}). ` +
      `These need explicit opt-out now: run 'gbrain doctor --fix' to add the canonical callout, ` +
      `or add 'brain_first: exempt' to frontmatter for skills that genuinely shouldn't consult the brain.`,
    );
  }
  if (typoSkills.length > 0) {
    summary.push(
      `${typoSkills.length} skill(s) have brain_first typo hints: ` +
      typoSkills.slice(0, 6).map(t => `${t.skill} — ${t.typo_hint}`).join('; ') +
      (typoSkills.length > 6 ? '; ...' : ''),
    );
  }

  return {
    name: 'skill_brain_first',
    status: 'warn',
    message: summary.join(' '),
    issues: violators.map(v => ({
      type: 'skill_missing_brain_first',
      skill: v.skill,
      action: v.formerly_hardcoded_exempt
        ? `Add canonical Convention callout OR set 'brain_first: exempt' (was hardcoded-exempt in PR #1206)`
        : `Add canonical Convention callout OR set 'brain_first: exempt'`,
      fix: {
        kind: 'add-convention-callout',
        external_patterns: v.external_patterns_matched,
        typo_hint: v.typo_hint,
        formerly_hardcoded_exempt: v.formerly_hardcoded_exempt,
        summary_line: buildBrainFirstSummaryLine(v),
      },
    })),
  };
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
  // A4 amended: --max-cost is an alias for --max-usd. Both spellings are
  // documented as the cron-safety guard. Either threads through to the
  // pre-flight estimate refusal AND, via withBudgetTracker, the mid-run
  // BudgetExhausted hard-throw.
  const maxUsd = parseFloatFlag(args, '--max-usd') ?? parseFloatFlag(args, '--max-cost');
  const dryRun = args.includes('--dry-run');
  const skipConfirm = args.includes('--yes');
  const jsonOutput = args.includes('--json');
  // A4 amended: --resume <plan_hash?> loads the checkpoint for the active
  // (engine,target) and continues from the next step. With no value, the
  // most recent checkpoint for the active engine is loaded.
  const resumeFlagIdx = args.indexOf('--resume');
  const resumeMode = resumeFlagIdx !== -1;
  const resumeArg = resumeMode ? args[resumeFlagIdx + 1] : undefined;
  const resumePlanHash = resumeArg && !resumeArg.startsWith('--') ? resumeArg : undefined;

  const { computeRecommendations, classifyChecks, maxReachableScore } =
    await import('../core/brain-score-recommendations.ts');
  const {
    BudgetTracker,
    BudgetExhausted,
  } = await import('../core/budget/budget-tracker.ts');
  const { withBudgetTracker } = await import('../core/ai/gateway.ts');
  const {
    computePlanHash,
    saveRemediationCheckpoint,
    loadRemediationCheckpoint,
    listRemediationCheckpoints,
    clearRemediationCheckpoint,
  } = await import('../core/remediation-checkpoint.ts');

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

  // A4 amended: compute plan_hash off the active recommendation ids so the
  // checkpoint binds to THIS plan. Resume only fires for matching plans.
  const planHash = computePlanHash(recs.map((r) => r.id));
  let completedFromCheckpoint = new Set<string>();
  if (resumeMode) {
    const requested = resumePlanHash;
    let cp = requested ? loadRemediationCheckpoint(requested) : null;
    if (!cp && !requested) {
      // No explicit hash: try newest checkpoint that matches the active plan.
      const recent = listRemediationCheckpoints();
      for (const e of recent) {
        const candidate = loadRemediationCheckpoint(e.plan_hash);
        if (candidate && candidate.plan_hash === planHash) {
          cp = candidate;
          break;
        }
      }
    }
    if (!cp) {
      console.error(
        `[remediate --resume] no matching checkpoint found ` +
          `(plan_hash=${planHash}${requested ? `; requested=${requested}` : ''}). ` +
          `Run without --resume to start fresh.`,
      );
      process.exit(2);
    }
    if (cp.plan_hash !== planHash) {
      console.error(
        `[remediate --resume] checkpoint plan_hash=${cp.plan_hash} does not match active plan_hash=${planHash}. ` +
          `The plan has changed (brain state moved). Run without --resume to start fresh.`,
      );
      process.exit(2);
    }
    completedFromCheckpoint = new Set(cp.completed.map((c) => c.id));
    console.error(
      `[remediate --resume] resuming plan_hash=${planHash}: ${completedFromCheckpoint.size} step(s) completed, ` +
        `${recs.length - completedFromCheckpoint.size} remaining.`,
    );
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

  // A4 amended: install a BudgetTracker scope around the plan-step loop so
  // any gateway.chat / embed / rerank inside a Minion handler (synthesize,
  // patterns, consolidate) auto-enforces the cap. On BudgetExhausted, the
  // onExhausted callback persists the checkpoint BEFORE the throw propagates;
  // the catch surfaces the actionable --resume hint.
  const remediateTracker = new BudgetTracker({
    label: 'doctor.remediate',
    maxCostUsd: maxUsd ?? undefined,
  });

  let exhaustionSnapshot: { spent: number; cap: number; reason: string; model_id?: string } | undefined;
  remediateTracker.onExhausted(() => {
    // BudgetTracker fires this synchronously from inside reserve()/record()
    // before the throw bubbles. Persist whatever has been done so far.
    const cp = {
      schema_version: 1 as const,
      plan_hash: planHash,
      doctor_run_id: doctorRunId,
      target_score: targetScore,
      started_at: new Date().toISOString(),
      completed: submitted
        .filter((s) => s.status === 'completed')
        .map((s) => ({ id: s.id, job: '', status: s.status, job_id: s.job_id ?? null })),
      aborted_at: new Date().toISOString(),
      abort_reason: 'budget_exhausted' as const,
      budget_snapshot: exhaustionSnapshot,
    };
    saveRemediationCheckpoint(cp);
  });

  const runLoop = async (): Promise<void> => {
    let stepCount = 0;
    while (recs.length > 0 && stepCount < maxJobs) {
      const step = recs[0];
      if (!step) break;
      stepCount++;

      // Resume: skip steps that the checkpoint already marked completed.
      if (completedFromCheckpoint.has(step.id)) {
        submitted.push({ step: stepCount, id: step.id, job_id: null, status: 'completed' });
        recs.shift();
        continue;
      }

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
        if (e instanceof BudgetExhausted) {
          exhaustionSnapshot = {
            spent: e.spent,
            cap: e.cap,
            reason: e.reason,
            model_id: e.modelId,
          };
          throw e;
        }
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
  };

  let budgetExhaustedAt: InstanceType<typeof BudgetExhausted> | null = null;
  try {
    await withBudgetTracker(remediateTracker, runLoop);
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      budgetExhaustedAt = err;
      console.error(
        `\n[remediate] BudgetExhausted (${err.reason}): spent $${err.spent.toFixed(4)} > cap $${err.cap.toFixed(2)}.\n` +
          `Checkpoint saved. Resume with:\n` +
          `  gbrain doctor --remediate --resume ${planHash}\n`,
      );
    } else {
      throw err;
    }
  }

  // Clear checkpoint on a clean run (no budget abort). Failed steps in the
  // submitted set don't disqualify the cleanup — they re-surface on the
  // next plan with bumped suffixes.
  if (!budgetExhaustedAt) {
    clearRemediationCheckpoint(planHash);
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
  if (budgetExhaustedAt || anyFailed) process.exit(1);
}

/**
 * Build RecommendationContext from engine + config.
 * Pure read; no side effects.
 */
async function loadRecommendationContext(engine: BrainEngine) {
  // v0.37 fix wave (Lane E.4 + CDX2-11): read schema-sizing fields from
  // gateway, not DB. The DB plane is schema-applied metadata; the file
  // plane is the gateway runtime source. Pre-fix this context produced
  // stale recommendations on fresh installs whose DB rows hadn't been
  // populated.
  //
  // Also extended the API-key check to recognize the ZE key alongside
  // OpenAI (was OpenAI-only). After Lane C.3, zeroentropy_api_key lives
  // in GBrainConfig + propagates to the gateway env dict.
  const repoPath = await engine.getConfig('sync.repo_path');
  let embeddingModel: string | undefined;
  let embeddingDimensions: number | undefined;
  try {
    const gw = await import('../core/ai/gateway.ts');
    embeddingModel = gw.getEmbeddingModel();
    embeddingDimensions = gw.getEmbeddingDimensions();
  } catch {
    // Gateway unconfigured — fall back to DB plane as a best-effort hint
    // (preserves doctor running before any engine.connect()).
    const dbModel = await engine.getConfig('embedding_model');
    const dbDims = await engine.getConfig('embedding_dimensions');
    embeddingModel = dbModel ?? undefined;
    embeddingDimensions = dbDims ? Number(dbDims) : undefined;
  }
  // v0.40.x: recipe-aware provider check, shared with autopilot.ts via
  // embeddingProviderConfigured(). Local providers (ollama, llama-server —
  // empty auth_env.required) need no hosted key; hosted providers check
  // their OWN required key (so a Voyage brain is judged by VOYAGE_API_KEY,
  // not by whether an OpenAI/ZE key happens to exist — the pre-fix wart).
  // fileCfg loads synchronously, so the resolveKey closure is sync.
  const { loadConfigFileOnly } = await import('../core/config.ts');
  const fileCfg = loadConfigFileOnly();
  const { embeddingProviderConfigured, HOSTED_EMBED_KEY_CONFIG } = await import(
    '../core/brain-score-recommendations.ts'
  );
  const embeddingConfigured = embeddingProviderConfigured(embeddingModel, (envVar) => {
    const cfgField = HOSTED_EMBED_KEY_CONFIG[envVar];
    const fromCfg = cfgField ? (fileCfg as Record<string, unknown> | null)?.[cfgField] : undefined;
    return !!(process.env[envVar] || fromCfg);
  });
  return {
    repoPath: repoPath ?? undefined,
    embeddingModel,
    embeddingDimensions,
    embeddingProviderConfigured: embeddingConfigured,
    hasChatApiKey: !!(process.env.ANTHROPIC_API_KEY || fileCfg?.anthropic_api_key),
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

// =================================================================
// v0.39 T7 + T9 — schema-pack doctor checks
// =================================================================
// Three checks per v0.38 CEO plan that never shipped at v0.38 time:
//   schema_pack_active       — does the active pack resolve cleanly?
//   schema_pack_consistency  — what % of pages match the active pack?
//   schema_pack_source_drift — do per-source packs disagree?
// All three are warn-only; never fail-block.

async function checkSchemaPackActive(engine: BrainEngine): Promise<Check> {
  try {
    const { loadActivePack } = await import('../core/schema-pack/load-active.ts');
    const { loadConfig } = await import('../core/config.ts');
    const pack = await loadActivePack({ cfg: loadConfig(), remote: false });
    return {
      name: 'schema_pack_active',
      status: 'ok',
      message: `Active pack: ${pack.manifest.name} v${pack.manifest.version} (${pack.manifest.page_types.length} types, ${pack.manifest.link_types?.length ?? 0} link verbs)`,
    };
  } catch (e) {
    return {
      name: 'schema_pack_active',
      status: 'warn',
      message: `Active pack failed to resolve: ${(e as Error).message}. Run \`gbrain schema active\` to debug.`,
    };
  }
}

async function checkSchemaPackConsistency(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await engine.executeRaw<{ src: string; total: string | number; untyped: string | number }>(
      `SELECT
         source_id AS src,
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE type IS NULL OR type = '')::text AS untyped
       FROM pages
       WHERE deleted_at IS NULL
       GROUP BY source_id
       ORDER BY source_id`,
    );
    if (rows.length === 0) {
      return { name: 'schema_pack_consistency', status: 'ok', message: 'No pages in any source — schema consistency N/A.' };
    }
    let worstPct = 0;
    let worstSrc = '';
    let worstUntyped = 0;
    let worstTotal = 0;
    for (const r of rows) {
      const total = Number(r.total);
      const untyped = Number(r.untyped);
      if (total === 0) continue;
      const pct = untyped / total;
      if (pct > worstPct) {
        worstPct = pct;
        worstSrc = r.src;
        worstUntyped = untyped;
        worstTotal = total;
      }
    }
    if (worstPct === 0) {
      return { name: 'schema_pack_consistency', status: 'ok', message: 'All pages match the active schema pack across every source.' };
    }
    const pctStr = (worstPct * 100).toFixed(1);
    if (worstPct >= 0.1) {
      return {
        name: 'schema_pack_consistency',
        status: 'warn',
        message: `Source \`${worstSrc}\`: ${worstUntyped} of ${worstTotal} pages (${pctStr}%) have no type matching the active pack. Run \`gbrain schema detect --source ${worstSrc}\` to propose a pack matching your content shape.`,
      };
    }
    return {
      name: 'schema_pack_consistency',
      status: 'ok',
      message: `${pctStr}% untyped at worst (source \`${worstSrc}\`) — under the 10% warn threshold.`,
    };
  } catch (e) {
    return {
      name: 'schema_pack_consistency',
      status: 'ok',
      message: `Skipped: ${(e as Error).message}`,
    };
  }
}

async function checkSchemaPackSourceDrift(engine: BrainEngine): Promise<Check> {
  try {
    // Compare per-source schema_pack overrides (tier 3 DB config) to detect
    // multi-source brains where different sources point at conflicting packs.
    const rows = await engine.executeRaw<{ key: string; value: string }>(
      `SELECT key, value FROM config WHERE key LIKE 'schema_pack.source.%'`,
    );
    if (rows.length === 0) {
      return { name: 'schema_pack_source_drift', status: 'ok', message: 'No per-source pack overrides — drift N/A.' };
    }
    const distinctPacks = new Set(rows.map((r) => r.value).filter(Boolean));
    if (distinctPacks.size <= 1) {
      return { name: 'schema_pack_source_drift', status: 'ok', message: `${rows.length} per-source overrides; all point at the same pack.` };
    }
    return {
      name: 'schema_pack_source_drift',
      status: 'warn',
      message: `Per-source pack divergence detected: ${distinctPacks.size} distinct packs across ${rows.length} sources. Run \`gbrain sources list\` then \`gbrain schema active --source <id>\` per source to audit.`,
    };
  } catch (e) {
    return {
      name: 'schema_pack_source_drift',
      status: 'ok',
      message: `Skipped: ${(e as Error).message}`,
    };
  }
}
