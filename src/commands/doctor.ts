import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict, writeJsonDocument } from '../core/cli-force-exit.ts';
import { getIdleBlockers } from '../core/migrate.ts';
import { parseFlags as parseSkillsDirFlags, resolveSkillsDir } from './check-resolvable.ts';
import { createProgress } from '../core/progress.ts';
import { categorizeCheck, type CheckCategory } from '../core/doctor-categories.ts';
import { rankIssues, type RankedIssue } from '../core/doctor-cause-rank.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import type { DbUrlSource } from '../core/config.ts';
import { resolveEnvNumber, resolveHoursEnv } from '../core/env-number.ts';
export { checkPostgresCancellationDriver } from './doctor/checks/postgres-cancellation.ts';
export { checkProjectionReadiness } from './doctor/checks/projection-readiness.ts';
// Peeled doctor modules (containment sprint): each is a verbatim move out of
// this file. doctor.ts re-exports every moved public symbol under its
// original name so existing importers (tests, scripts/live-brain-first-check.ts,
// the run_doctor op's dynamic import of doctorReportRemote) keep working
// unchanged.
import { multiSourceDriftAdvice, multiSourceDriftGitRootSkipNote } from './doctor/schema-pack-checks.ts';
import { bootstrapDoctorChecks } from './doctor/bootstrap-checks.ts';
export { buildMemorableRelayCheck } from './doctor/checks/integrations-memorable.ts';
export { buildHomeDirInWorktreeCheck, isValidGitMarker } from './doctor/checks/home-worktree.ts';
export { buildMemoryWritebackCheck } from './doctor/checks/memory-writeback.ts';
import {
  skillConformanceCheck,
  skillsManifestIntegrityCheck,
  skillCurrencyCheck,
  skillPreconditionsCheck,
  skillBrainFirstCheck,
} from './doctor/skill-checks.ts';
export {
  multiSourceDriftAdvice,
  multiSourceDriftGitRootSkipNote,
  bootstrapDoctorChecks,
  skillConformanceCheck,
  skillsManifestIntegrityCheck,
  skillCurrencyCheck,
  skillPreconditionsCheck,
  skillBrainFirstCheck,
};
export { doctorReportRemote } from './doctor/report-remote.ts';

// Peeled check bundles (containment sprint): verbatim moves of the standalone
// check-function library into src/commands/doctor/checks/*. Every exported
// symbol keeps its original name and import path via these re-exports
// (dozens of tests + scripts import checks directly from doctor.ts, and
// report-remote.ts consumes them through this façade).
export {
  resolveWhoknowsFixturePath,
  whoknowsHealthCheck,
  pgvectorCheck,
  pagesUpsertArbiterCheck,
  linkSourceCheckConstraintCheck,
  jsonbIntegrityCheck,
  checkVolunteerChannels,
  takesWeightGridCheck,
  childTableOrphansCheck,
  rawProvenanceCheck,
  checkSourceConfigShape,
  checkPgliteScratchProbe,
} from './doctor/checks/core-health.ts';
export {
  checkContextualRetrievalCoverage,
  checkHiddenBySearchPolicy,
  checkLinkResolutionOpportunity,
  checkAbandonedThreads,
  checkCalibrationFreshness,
  checkGradeConfidenceDrift,
  checkSubagentHealth,
  checkVoiceGateHealth,
  checkRerankerHealth,
} from './doctor/checks/calibration.ts';
export {
  computeQueueHealthCheck,
  computeWedgedQueueCheck,
  computeOrphanedPrivateQueueCheck,
  computeAutopilotFanoutConcurrencyCheck,
  checkBatchRetryHealth,
} from './doctor/checks/queue-jobs.ts';
export {
  checkGraphSignalsCoverage,
  checkBrainstormHealth,
  checkEmbeddingWidthConsistency,
  checkFactsEmbeddingWidthConsistency,
  checkJunkEntityHubs,
  JUNK_HUB_EDGE_THRESHOLD,
  JUNK_HUB_MAX_CHUNKS,
} from './doctor/checks/graph-embedding.ts';
export {
  checkSourceRoutingHealth,
  checkFederationHealth,
  checkOauthConfidentialHealth,
  checkOauthClientScopeHealth,
  checkAutopilotLockScope,
  checkStaleLocks,
  checkCyclePhaseScope,
} from './doctor/checks/routing-federation.ts';
export {
  checkChatFallbackChainInert,
  checkSearchMode,
  checkEvalDrift,
  checkEmbeddingEnvOverride,
  checkEmbeddingMigrationState,
  checkSubagentCapability,
  computeConversationParserProbeHealthCheck,
  computeNightlyQualityProbeHealthCheck,
  computeConversationFactsBacklogCheck,
} from './doctor/checks/search-eval.ts';
export {
  EXTRACTION_LAG_WARN_PCT_DEFAULT,
  EXTRACTION_LAG_MIN_PAGES,
  checkLinksExtractionLag,
  checkUnverifiedExtractions,
  checkContentHashDuplicates,
  checkCodeChunkMetadata,
  checkUndeclaredDbOnlyPages,
  checkDbOnlyCollectorCollision,
  computeExtractAtomsBacklogCheck,
  computeAtomProvenanceDriftCheck,
  computeExtractHealthCheck,
  checkSyncFreshness,
} from './doctor/checks/extraction-sync.ts';
export { computeConversationFormatCoverageCheck } from './doctor/checks/conversation-coverage.ts';
export {
  checkSyncConsolidation,
  computePoolBudgetCheck,
  checkPoolBudget,
  checkCycleFreshness,
} from './doctor/checks/consolidation-cycle.ts';
export { dbRepairRecurrenceCheck, pgliteScaleCheck } from './doctor/checks/engine-fit.ts';
export {
  computePgliteDataDirCheck,
  computeWorkerOomLoopCheck,
  computePoolReapHealthCheck,
} from './doctor/checks/pglite-worker.ts';
export {
  buildMemoryVerbsCheck,
  buildRetrievalReflexCheck,
} from './doctor/checks/verbs-reflex.ts';
import type { DoctorContext } from './doctor/context.ts';
import { runDoctorRegistry, parseOnlyChecks } from './doctor/registry.ts';
import { finalizeCheckFixes, fixLine, unknownScoreCategories, type CheckAgentFields } from './doctor/check-fix.ts';
import { throttleDoctorHeartbeat } from './doctor/heartbeat.ts';
import type { RenderContext } from '../core/agent-output.ts';
export interface Check extends CheckAgentFields {
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
  /**
   * v0.41.19.0 category tag — assigned by `categorizeCheck(name)` at report
   * compute time. Optional + additive so legacy consumers ignore it.
   * Source of truth: `src/core/doctor-categories.ts`.
   */
  category?: CheckCategory;
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
  /**
   * Legacy all-checks aggregate. `100 − 20×fails − 5×warns`, floor 0.
   *
   * Preserved verbatim from pre-v0.41.19.0 for back-compat with `gbrain
   * doctor --remediate`, `gbrain remote doctor`, the MCP `run_doctor` op,
   * and any external monitor / CI gate that reads this field. NO behavior
   * change: a fixed check set produces a byte-identical `health_score`
   * before and after the v0.41.19.0 wave.
   */
  health_score: number;
  /**
   * v0.41.19.0 — same penalty math (100 − 20×fails − 5×warns) restricted to
   * checks tagged `category: 'brain'` by `categorizeCheck()`. The "is my
   * brain's data healthy?" signal, decoupled from skill routing / ops /
   * meta. Orthogonal to `BrainHealth.brain_score` (the weighted
   * 35/25/15/15/10 composite surfaced by the `brain_score` doctor check) —
   * `brain_checks_score` counts brain-category check failures;
   * `brain_score` measures brain-data composition. Doctor renders both.
   */
  brain_checks_score: number;
  /**
   * v0.41.19.0 — per-category penalty scores. Same math as `health_score`,
   * restricted to each category in turn. An operator reading `score: 15`
   * driven by 504 RESOLVER.md warnings now sees `category_scores.brain:
   * ~100` and `category_scores.skill: 0` instead of one polluted number.
   */
  category_scores: {
    brain: number;
    skill: number;
    ops: number;
    meta: number;
  };
  checks: Check[];
  /**
   * v0.42.x (#1685 GAP C) — non-ok checks ranked by cause (root before symptom,
   * fail before warn). Lets an agent act on the root cause without re-deriving
   * the ranking. Additive + optional; schema_version stays at 2.
   */
  top_issues?: RankedIssue[];
  /**
   * db-availability loop — which engine this report was measured against and
   * where its URL came from. Additive + optional (schema_version stays 2);
   * absent on remote/report-only paths that don't know them.
   */
  engine?: 'postgres' | 'pglite';
  db_url_source?: DbUrlSource | null;
  /** E2: capabilities off by choice that bound what this brain can do (e.g. `embeddings_disabled`). Additive. */
  capped_by?: string[];
  /** E10: category scores that are not evidence because their checks did not run (e.g. `brain` when the DB was unreachable). */
  unknown_scores?: Array<'brain'>;
}

function _penaltyScore(checks: Check[]): number {
  let score = 100;
  for (const c of checks) {
    if (c.status === 'fail') score -= 20;
    else if (c.status === 'warn') score -= 5;
  }
  return Math.max(0, score);
}

/**
 * Compute the {status, health_score, brain_checks_score, category_scores}
 * headline from a list of checks. Mirrors the calculation in outputResults()
 * so remote callers and the existing CLI front-end agree on what "healthy"
 * means.
 *
 * **Back-compat invariant:** `health_score` math is byte-identical to
 * pre-v0.41.19.0 for any fixed `checks` array. The new fields are additive.
 *
 * **Categorization:** each check is tagged via `categorizeCheck(name)` at
 * report-build time if it doesn't already carry a `category` field. The
 * categorizer is the single source of truth in
 * `src/core/doctor-categories.ts`.
 */
export function computeDoctorReport(
  checks: Check[],
  extras?: { engine?: 'postgres' | 'pglite'; db_url_source?: DbUrlSource | null; render?: RenderContext },
): DoctorReport {
  const tagged = finalizeCheckFixes(checks, extras?.render).map((c) =>
    c.category ? c : { ...c, category: categorizeCheck(c.name) },
  );
  const capped_by = tagged.some((c) => c.name === 'embeddings' && c.readiness_state === 'disabled_by_choice') ? ['embeddings_disabled'] : [];

  const hasFail = tagged.some((c) => c.status === 'fail');
  const hasWarn = tagged.some((c) => c.status === 'warn');

  const health_score = _penaltyScore(tagged);
  const brain = tagged.filter((c) => c.category === 'brain');
  const skill = tagged.filter((c) => c.category === 'skill');
  const ops = tagged.filter((c) => c.category === 'ops');
  const meta = tagged.filter((c) => c.category === 'meta');

  const status: DoctorReport['status'] = hasFail ? 'unhealthy' : hasWarn ? 'warnings' : 'healthy';
  return {
    schema_version: 2,
    status,
    health_score,
    brain_checks_score: _penaltyScore(brain),
    category_scores: {
      brain: _penaltyScore(brain),
      skill: _penaltyScore(skill),
      ops: _penaltyScore(ops),
      meta: _penaltyScore(meta),
    },
    checks: tagged,
    top_issues: rankIssues(tagged),
    ...(extras?.engine ? { engine: extras.engine } : {}),
    ...(extras?.db_url_source !== undefined ? { db_url_source: extras.db_url_source } : {}),
    ...(capped_by.length ? { capped_by } : {}),
    ...(unknownScoreCategories(tagged).length ? { unknown_scores: unknownScoreCategories(tagged) } : {}),
  };
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

export { upgradeErrorResolved, checkSelfUpgradeHealth, checkUpgradeErrors } from './doctor/checks/upgrade-health.ts';

/**
 * Re-exported from `src/core/env-number.ts`, which now owns the implementation
 * AND the warn-once memo. `source-health.ts` needs the hours resolver for the
 * staleness ceiling, and doctor already imports from source-health — so the
 * helper had to move to core or the import graph would cycle.
 *
 * The `_resolveEnvNumber` name is kept because `sync.ts:5730` dynamically
 * imports it from this module.
 */
export { resolveEnvNumber as _resolveEnvNumber };

/** Local aliases; the shared memo lives in core so it can't fork per module. */
const _resolveEnvNumber = resolveEnvNumber;
const _resolveSyncFreshnessHours = resolveHoursEnv;



/**
 * Build the full check list for `gbrain doctor` against an engine + arg vector.
 * Filesystem-first, DB-second: filesystem checks (resolver, conformance) run
 * without an engine; DB checks run only if one is provided.
 *
 * `dbSource` is passed only from the `--fast` and DB-unavailable paths in
 * cli.ts so we can emit a precise "why no DB check" message. When null, the
 * user has no DB configured anywhere; otherwise the caller chose --fast or
 * we failed to connect despite a configured URL.
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
 * Refactor wave 1 (W4 doctor): the checks themselves are the ordered
 * entries of `DOCTOR_CHECK_REGISTRY` (src/commands/doctor/registry.ts, one
 * `{ name, emits, run }` per topic block under src/commands/doctor/checks/).
 * buildChecks parses the flags into a `DoctorContext` and runs the registry;
 * the two early exits are registry entries returning `STOP_DOCTOR`.
 *
 * Side effects retained inside the entries (kept for "no behavior change"):
 *   - `printAutoFixReport` on `--fix` non-JSON path
 *   - `progress` reporter writes to stderr (heartbeats per check)
 *   - `engine.executeRaw` / handler-leaf calls (the actual probe work)
 */
export async function buildChecks(
  engine: BrainEngine | null,
  args: string[],
  dbSource?: DbUrlSource,
  // db-availability loop (2c-bis): the connect error captured by the CLI's
  // dead-DB fallback. Lets the null-engine path synthesize a CLASSIFIED
  // `connection` check — without it, a total outage produced NO connection
  // entry at all, which is exactly the field smoke-test branches on.
  connectError?: unknown,
): Promise<Check[]> {
  const jsonOutput = args.includes('--json');
  const fastMode = args.includes('--fast');
  const doFix = args.includes('--fix');
  const dryRun = args.includes('--dry-run');
  // v0.41.19.0 — `--scope=brain` SKIPS the SKILL check group (which walks the
  // filesystem `skills/` tree, the dominant non-DB cost). Defaults to `all`.
  // `runResolverChecks`-equivalent invocations are gated below; the same gate
  // covers `whoknows_health` (the one DB-dependent skill check) where it's
  // invoked later in the function.
  const scope: 'all' | 'brain' = args.includes('--scope=brain') ? 'brain' : 'all';

  // v0.41.29.0: explicit `--source <id>` scopes the `orphan_ratio` check to one
  // source. EXPLICIT-ONLY by design — a raw flag parse, NOT resolveSourceWithTier.
  // The tier resolver would pick a default source when `--source` is absent and
  // silently scope a bare `gbrain doctor` to one source; we want bare doctor to
  // stay brain-wide. Only `orphan_ratio` consumes this for now (other checks
  // staying brain-wide is a separate, larger change — see TODOS.md).
  let orphanRatioSourceId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && i + 1 < args.length) {
      orphanRatioSourceId = args[++i] || undefined;
    }
  }

  // Progress reporter. `--json` is doctor's machine-readable output, so plain
  // progress must not leak to stderr unless the caller explicitly asks for
  // structured progress with --progress-json.
  const progress = throttleDoctorHeartbeat(createProgress(doctorProgressOptions(jsonOutput)));

  // --- Filesystem checks (always run, no DB needed) ---

  // 1. Resolver health + 2. Skill conformance + 2b. Skill brain-first.
  //
  // SKILL check group (gated behind --scope=all).
  //
  // The resolver walk reads every SKILL.md under the configured skills dir
  // (`skills/RESOLVER.md` or workspace-root `AGENTS.md`). On large OpenClaw
  // deployments with 200+ skills this is the dominant non-DB cost. The
  // v0.41.19.0 `--scope=brain` flag skips this whole block per D9 in the plan.
  //
  // We also skip `--fix` execution under scope=brain because --fix
  // exclusively targets DRY violations inside SKILL.md files. Use the same
  // resolution as `check-resolvable` (#4673: flag-first — doctor accepted
  // `--skills-dir` and silently ignored it, so every skill check graded the
  // auto-detected workspace and `--fix` could write SKILL.md edits into a
  // workspace the operator explicitly steered away from). Sharing
  // check-resolvable's exported resolveSkillsDir keeps the three skills-dir
  // commands (doctor, check-resolvable, routing-eval) on one precedence:
  // --skills-dir → $GBRAIN_SKILLS_DIR / $OPENCLAW_WORKSPACE / walk-up →
  // install-path read-only fallback. `source: 'explicit'` correctly bypasses
  // the install_path --fix refusal below — an explicit flag is exactly the
  // operator signal that gate wants.
  const detected = scope === 'all' ? resolveSkillsDir(parseSkillsDirFlags(args)) : { dir: null, source: 'none' as const };
  const skillsDir = detected.dir;

  const ctx: DoctorContext = {
    engine,
    args,
    dbSource,
    connectError,
    jsonOutput,
    fastMode,
    doFix,
    dryRun,
    scope,
    orphanRatioSourceId,
    progress,
    skillsDirResolution: detected,
    skillsDir,
    autoFixReport: null,
    schemaVersion: 0,
    connectionFailed: false,
    only: parseOnlyChecks(args),
  };

  return runDoctorRegistry(ctx);
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
  // db-availability loop: the connect error from the CLI's dead-DB fallback,
  // threaded to buildChecks for the synthesized `connection` check (2c-bis).
  connectError?: unknown,
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

  if (args.includes('--probe') && !(await (await import('./doctor/probe-consent.ts')).authorizeProviderProbe(engine, args, jsonOutput))) return;
  const checks = await buildChecks(engine, args, dbSource, connectError);
  const hasFail = outputResults(checks, jsonOutput, { engine: engine?.kind, db_url_source: dbSource ?? null });

  // Features teaser (non-JSON, non-failing only)
  if (!jsonOutput && !hasFail && engine) {
    try {
      const { featuresTeaserForDoctor } = await import('./features.ts');
      const teaser = await featuresTeaserForDoctor(engine);
      if (teaser) console.log(`\n${teaser}`);
    } catch { /* best-effort */ }
  }

  // Use process.exitCode instead of process.exit() so cleanup handlers
  // (e.g. Bun unload events, open database connections) still run before
  // the process terminates. process.exit() is a hard kill that bypasses them.
  setCliExitVerdict(hasFail ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function doctorProgressOptions(jsonOutput: boolean) {
  const cliOpts = getCliOptions();
  if (jsonOutput && !cliOpts.quiet && !cliOpts.progressJson) {
    return { mode: 'quiet' as const };
  }
  return cliOptsToProgressOptions(cliOpts);
}

function outputResults(
  checks: Check[],
  json: boolean,
  extras?: { engine?: 'postgres' | 'pglite'; db_url_source?: DbUrlSource | null },
): boolean {
  // v0.41.19.0 — render goes through computeDoctorReport so the human
  // output, JSON output, and remote MCP envelope all share one shape.
  const report = computeDoctorReport(checks, extras);
  const hasFail = report.status === 'unhealthy';
  const hasWarn = report.status === 'warnings';
  const score = report.health_score;

  if (json) {
    void writeJsonDocument(JSON.stringify(report)); // D2: the one --json document
    return hasFail;
  }

  console.log('\nGBrain Health Check');
  console.log('===================');

  // #1685 GAP C — cause-ranked summary so the operator reads the root cause
  // first instead of scrolling the full list. Caps at 5; clean brains skip it.
  const topIssues = report.top_issues ?? [];
  if (topIssues.length > 0) {
    console.log('');
    console.log('Top issues (ranked by cause):');
    const shown = topIssues.slice(0, 5);
    for (const issue of shown) {
      const icon = issue.status === 'fail' ? 'FAIL' : 'WARN';
      const dn = issue.downstream_of ? ` (likely downstream of ${issue.downstream_of})` : '';
      console.log(`  [${icon}] ${issue.name}${dn} → ${fixLine(issue.action) ?? issue.fix}`);
    }
    if (topIssues.length > shown.length) {
      console.log(`  +${topIssues.length - shown.length} more — see full list below`);
    }
    console.log('');
  }

  for (const c of report.checks) {
    const icon = c.status === 'ok' ? (c.severity === 'info' ? 'INFO' : 'OK') : c.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  [${icon}] ${c.name}: ${c.message}`);
    const fix = c.status === 'ok' ? null : fixLine(c.fix);
    if (fix) console.log(`    Fix: ${fix}`);
    if (c.issues) {
      for (const issue of c.issues) {
        console.log(`    → ${issue.type.toUpperCase()}: ${issue.skill}`);
        console.log(`      ACTION: ${issue.action}`);
      }
    }
  }

  // v0.41.19.0 — brain-first headline. The user asked "is my brain ok?".
  // Lead with the brain-category score; show the legacy aggregate
  // alongside as context. The weighted BrainHealth.brain_score (data
  // composition) is surfaced separately by the `brain_score` check above —
  // it's read out of the check list so we don't duplicate the query.
  const brainScoreCheck = report.checks.find((c) => c.name === 'brain_score');
  const brainScoreLine = brainScoreCheck
    ? `Weighted brain score: ${brainScoreCheck.status === 'ok' ? '' : `[${brainScoreCheck.status.toUpperCase()}] `}${brainScoreCheck.message}`
    : null;

  console.log('');
  console.log(`Brain checks:  ${report.unknown_scores?.includes('brain') ? 'unknown (database checks did not run)' : `${report.brain_checks_score}/100  (category penalty)`}`);
  console.log(`Skill checks:  ${report.category_scores.skill}/100`);
  console.log(`Ops checks:    ${report.category_scores.ops}/100`);
  console.log(`Meta checks:   ${report.category_scores.meta}/100`);
  if (brainScoreLine) console.log(brainScoreLine);
  console.log('');

  if (hasFail) {
    console.log(`Overall health score: ${score}/100. Failed checks found.`);
  } else if (hasWarn) {
    console.log(`Overall health score: ${score}/100. All checks OK (some warnings).`);
  } else {
    console.log(`Overall health score: ${score}/100. All checks passed.`);
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
      void writeJsonDocument(JSON.stringify({ status: 'unavailable', reason: 'no_engine' }));
    } else {
      console.log('gbrain doctor --locks requires a database connection. Configure a URL and retry.');
    }
    process.exit(1);
  }

  if (engine.kind !== 'postgres') {
    if (jsonOutput) {
      void writeJsonDocument(JSON.stringify({ status: 'not_applicable', engine: engine.kind }));
    } else {
      console.log(`gbrain doctor --locks is Postgres-only. Current engine: ${engine.kind}. No blockers possible (no connection pool).`);
    }
    return;
  }

  const blockers = await getIdleBlockers(engine);

  if (jsonOutput) {
    void writeJsonDocument(JSON.stringify({ status: blockers.length === 0 ? 'ok' : 'blockers_found', blockers }, null, 2));
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

// --remediation-plan + --remediate live in doctor/remediate.ts (re-exported for import-site stability).
export { runRemediationPlan, renderRemediationPlanLines, runRemediate } from './doctor/remediate.ts';

