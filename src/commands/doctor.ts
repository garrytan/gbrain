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
import { join } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  issues?: Array<{ type: string; skill: string; action: string; fix?: any }>;
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

  return computeDoctorReport(checks);
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
export async function checkSyncFreshness(engine: BrainEngine): Promise<Check> {
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

    const now = Date.now();
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
    const { readSupervisorEvents } = await import('../core/minions/handlers/supervisor-audit.ts');

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
    const crashes24h = events.filter(e => e.event === 'worker_exited').length;
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
      } else if (crashes24h > 3) {
        checks.push({
          name: 'supervisor',
          status: 'warn',
          message: `Supervisor running but worker crashed ${crashes24h}x in last 24h. Check ~/.gbrain/audit/supervisor-*.jsonl for causes.`,
        });
      } else {
        checks.push({
          name: 'supervisor',
          status: 'ok',
          message: `running=true pid=${supervisorPid} last_start=${lastStart ?? 'unknown'} crashes_24h=${crashes24h}`,
        });
      }
    }
  } catch {
    // Audit read / import failure is best-effort; skip silently.
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
