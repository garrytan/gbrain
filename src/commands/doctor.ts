import type { BrainEngine } from '../core/engine.ts';
import { EMBED_SKIP_FILTER_FRAGMENT } from '../core/embed-skip.ts';
import { quarantineFilterFragment } from '../core/quarantine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import * as db from '../core/db.ts';
import { LATEST_VERSION, getIdleBlockers } from '../core/migrate.ts';
import { checkResolvable } from '../core/check-resolvable.ts';
import { autoFixDryViolations, type AutoFixReport } from '../core/dry-fix.ts';
import { parseFlags as parseSkillsDirFlags, resolveSkillsDir } from './check-resolvable.ts';
import { loadCompletedMigrations } from '../core/preferences.ts';
import { compareVersions } from './migrations/index.ts';
import { createProgress, startHeartbeat } from '../core/progress.ts';
import { categorizeCheck, type CheckCategory } from '../core/doctor-categories.ts';
import { rankIssues, type RankedIssue } from '../core/doctor-cause-rank.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';
import type { DbUrlSource } from '../core/config.ts';
import { gbrainPath, loadConfig } from '../core/config.ts';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { resolveEnvNumber, resolveHoursEnv } from '../core/env-number.ts';
import { computeEffectiveDate } from '../core/effective-date.ts';
import { parseFrontmatter } from '../core/backfill-effective-date.ts';
import { hnswIndexExpected, hnswMaxDimsForType } from '../core/vector-index.ts';
import { VERSION as GBRAIN_BINARY_VERSION } from '../version.ts';
import { schemaVersionHealth } from '../core/schema-version-health.ts';
import { zeroTotalContradictionsCheck } from '../core/eval-contradictions/run-health.ts';
// Peeled doctor modules (containment sprint): each is a verbatim move out of
// this file. doctor.ts re-exports every moved public symbol under its
// original name so existing importers (tests, scripts/live-brain-first-check.ts,
// the run_doctor op's dynamic import of doctorReportRemote) keep working
// unchanged.
import { multiSourceDriftAdvice, multiSourceDriftGitRootSkipNote } from './doctor/schema-pack-checks.ts';
import { bootstrapDoctorChecks } from './doctor/bootstrap-checks.ts';
import { buildMemorableRelayCheck } from './doctor/checks/integrations-memorable.ts';
export { buildMemorableRelayCheck } from './doctor/checks/integrations-memorable.ts';
import { buildHomeDirInWorktreeCheck } from './doctor/checks/home-worktree.ts';
export { buildHomeDirInWorktreeCheck, isValidGitMarker } from './doctor/checks/home-worktree.ts';
import { buildMemoryWritebackCheck } from './doctor/checks/memory-writeback.ts';
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
  checkZeEmbeddingHealth,
  checkProviderSunset,
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
import { dbRepairRecurrenceCheck, pgliteScaleCheck } from './doctor/checks/engine-fit.ts';
import { classifyPgAccessError } from '../core/pg-access-classify.ts';
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
// Import-back seam: buildChecks/runDoctor below call these moved checks.
// (`export ... from` above creates no local binding, so the plain imports
// here are required and non-conflicting.)
import {
  whoknowsHealthCheck,
  pgvectorCheck,
  pagesUpsertArbiterCheck,
  jsonbIntegrityCheck,
  checkVolunteerChannels,
  takesWeightGridCheck,
  childTableOrphansCheck,
  rawProvenanceCheck,
  checkSourceConfigShape,
  checkPgliteScratchProbe,
} from './doctor/checks/core-health.ts';
import {
  checkHiddenBySearchPolicy,
  checkLinkResolutionOpportunity,
  checkRerankerHealth,
} from './doctor/checks/calibration.ts';
import {
  computeQueueHealthCheck,
  computeWedgedQueueCheck,
  computeOrphanedPrivateQueueCheck,
  computeAutopilotFanoutConcurrencyCheck,
  checkBatchRetryHealth,
} from './doctor/checks/queue-jobs.ts';
import {
  checkGraphSignalsCoverage,
  checkBrainstormHealth,
  checkZeEmbeddingHealth,
  checkProviderSunset,
  checkEmbeddingWidthConsistency,
  checkFactsEmbeddingWidthConsistency,
  checkJunkEntityHubs,
} from './doctor/checks/graph-embedding.ts';
import {
  checkSourceRoutingHealth,
  checkOauthConfidentialHealth,
  checkOauthClientScopeHealth,
  checkAutopilotLockScope,
  checkStaleLocks,
  checkCyclePhaseScope,
} from './doctor/checks/routing-federation.ts';
import {
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
import {
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
import { computeConversationFormatCoverageCheck } from './doctor/checks/conversation-coverage.ts';
import {
  checkSyncConsolidation,
  checkCycleFreshness,
} from './doctor/checks/consolidation-cycle.ts';
import {
  computePgliteDataDirCheck,
  computeWorkerOomLoopCheck,
  computePoolReapHealthCheck,
} from './doctor/checks/pglite-worker.ts';
import {
  buildMemoryVerbsCheck,
  buildRetrievalReflexCheck,
} from './doctor/checks/verbs-reflex.ts';
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
  extras?: { engine?: 'postgres' | 'pglite'; db_url_source?: DbUrlSource | null },
): DoctorReport {
  const tagged = checks.map((c) =>
    c.category ? c : { ...c, category: categorizeCheck(c.name) },
  );

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

/**
 * #4517: is the latest upgrade-errors.jsonl record superseded? True when the
 * running binary version is at/past the version the failed upgrade was moving
 * to AND the schema ledger is current (no pending migrations) — i.e. a later
 * (or retried) upgrade demonstrably finished the job. Pure + exported for
 * tests. Compares ALL dot-segments (the canonical `compareVersions` stops at
 * 3, which would treat 0.31.4.1 == 0.31.4.0); a malformed version fails
 * closed (keeps warning).
 */
export function upgradeErrorResolved(
  failedToVersion: string,
  binaryVersion: string,
  schemaCurrent: boolean,
): boolean {
  if (!schemaCurrent) return false;
  if (typeof failedToVersion !== 'string' || typeof binaryVersion !== 'string') return false;
  const a = binaryVersion.replace(/^v/, '').split('.');
  const b = failedToVersion.replace(/^v/, '').split('.');
  if (a.length === 0 || b.length === 0) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const da = parseInt(a[i] ?? '0', 10);
    const db = parseInt(b[i] ?? '0', 10);
    if (!Number.isFinite(da) || !Number.isFinite(db) || Number.isNaN(da) || Number.isNaN(db)) return false;
    if (da > db) return true;
    if (da < db) return false;
  }
  return true; // equal → the failed target version is now running
}

/**
 * v0.42 self_upgrade_health. Surfaces the self-upgrade mode, whether an update
 * is pending (from the cache), and any recent failed auto-upgrade attempts.
 * File-plane only (no DB) so it runs on thin clients. Three-state: warn on
 * recent failures, otherwise ok.
 */
export function checkSelfUpgradeHealth(): Check {
  try {
    const { loadConfig } = require('../core/config.ts');
    const {
      resolveSelfUpgradeMode,
      pendingUpgradeVersion,
    } = require('../core/self-upgrade.ts');
    const { readRecentSelfUpgrades } = require('../core/audit/self-upgrade-audit.ts');

    const cfg = loadConfig();
    const mode = resolveSelfUpgradeMode(cfg);
    if (mode === 'off') {
      return {
        name: 'self_upgrade_health',
        status: 'ok',
        message: 'Self-upgrade disabled (mode=off). Enable: gbrain config set self_upgrade.mode notify',
      };
    }

    const parts: string[] = [`mode=${mode}`];
    // Shared stale/foreign-cache guard: only report an upgrade strictly newer
    // than the RUNNING binary (pendingUpgradeVersion owns the rule).
    const pendingLatest = pendingUpgradeVersion(GBRAIN_BINARY_VERSION, Date.now());
    if (pendingLatest) {
      parts.push(`update available: ${GBRAIN_BINARY_VERSION} -> ${pendingLatest} (run: gbrain self-upgrade)`);
    }
    const failedVersions: string[] = cfg?.self_upgrade?.failed_versions ?? [];
    if (failedVersions.length > 0) {
      parts.push(`skipping known-bad: ${failedVersions.join(', ')}`);
    }

    const recent = readRecentSelfUpgrades(7) as Array<{ outcome?: string; error?: string; latest?: string | null }>;
    const failures = recent.filter((e) => e.outcome === 'failed');
    if (failures.length > 0) {
      const last = failures[failures.length - 1];
      return {
        name: 'self_upgrade_health',
        status: 'warn',
        message:
          `${failures.length} self-upgrade failure(s) in 7d (${parts.join('; ')}). ` +
          `Last: ${last.latest ?? '?'}${last.error ? ` — ${last.error}` : ''}. ` +
          `Check ~/.gbrain/upgrade-errors.jsonl; apply manually with gbrain self-upgrade.`,
      };
    }

    return { name: 'self_upgrade_health', status: 'ok', message: parts.join('; ') };
  } catch (e) {
    return {
      name: 'self_upgrade_health',
      status: 'ok',
      message: `Self-upgrade status unavailable (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

/**
 * Upgrade-error trail (v0.13+). `gbrain upgrade` silently swallows
 * best-effort failures in `gbrain post-upgrade`; the failure record is
 * appended to `~/.gbrain/upgrade-errors.jsonl` so we can surface it here
 * with a paste-ready recovery hint. Without this, users end up with
 * half-upgraded brains and no signal.
 *
 * #4517: a failure record on its own doesn't mean the brain is STILL
 * broken — the recovery hint (e.g. `apply-migrations --yes`) may have
 * already fixed it. Suppression requires BOTH proofs: the installed
 * binary's own version is at/past the record's `to_version` (the failed
 * upgrade demonstrably completed filesystem-side) AND the schema ledger is
 * current (`config.version >= LATEST_VERSION` — the DB half of the upgrade
 * also finished). A binary alone can lie: `self-upgrade` swaps the binary
 * before `post-upgrade` runs migrations, which is exactly the failure this
 * trail records. When the schema can't be verified (no engine, unreadable
 * version), the warn stays — fail-closed. A superseded record downgrades to
 * an explicit status:'ok' line (rather than silence) so the operator sees
 * the past failure was resolved, not swallowed.
 * `upgradeErrorResolved` above is the pure decision fn.
 */
export async function checkUpgradeErrors(
  engine: Pick<BrainEngine, 'getConfig'> | null,
): Promise<Check | null> {
  try {
    const errPath = gbrainPath('upgrade-errors.jsonl');
    if (!existsSync(errPath)) return null;
    const lines = readFileSync(errPath, 'utf-8').split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;
    const latest = JSON.parse(lines[lines.length - 1]) as {
      ts: string; phase: string; from_version: string; to_version: string; hint: string;
    };
    const date = latest.ts.slice(0, 10);
    let schemaCurrent = false;
    if (engine) {
      try {
        const v = parseInt((await engine.getConfig('version')) || '0', 10);
        schemaCurrent = v >= LATEST_VERSION;
      } catch { /* unverifiable → keep warning */ }
    }
    if (upgradeErrorResolved(latest.to_version, GBRAIN_BINARY_VERSION, schemaCurrent)) {
      return {
        name: 'upgrade_errors',
        status: 'ok',
        message: `Past post-upgrade failure on ${date} (${latest.from_version} → ${latest.to_version}) superseded: binary now ${GBRAIN_BINARY_VERSION}, schema current.`,
      };
    }
    return {
      name: 'upgrade_errors',
      status: 'warn',
      message: `Post-upgrade failure on ${date} (${latest.from_version} → ${latest.to_version}, phase: ${latest.phase}). Recovery: ${latest.hint}`,
    };
  } catch {
    // Read/parse failure is itself best-effort; skip silently.
    return null;
  }
}

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
 * PgBouncer / prepared-statement compatibility. URL-only inspection — no DB
 * round-trip — extracted so it runs BOTH before the connection check and in
 * the dead-DB filesystem lane (a URL problem is diagnosable with the DB down).
 */
async function pgbouncerPrepareCheck(): Promise<Check | null> {
  try {
    const { resolvePrepare } = await import('../core/db.ts');
    const config = loadConfig();
    const url = config?.database_url || '';
    if (!url) return null;
    const prepare = resolvePrepare(url);
    if (prepare === false) {
      return { name: 'pgbouncer_prepare', status: 'ok', message: 'Prepared statements disabled (PgBouncer-safe)' };
    }
    try {
      const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
      if (parsed.port === '6543') {
        return {
          name: 'pgbouncer_prepare',
          status: 'warn',
          message:
            'Port 6543 (PgBouncer transaction mode) detected but prepared statements are enabled. ' +
            'This causes "prepared statement does not exist" errors under concurrent load. ' +
            'Fix: unset GBRAIN_PREPARE (or set =false), or add ?prepare=false to the connection URL.',
        };
      }
    } catch {
      // URL parse failure — skip, nothing actionable
    }
    return null;
  } catch {
    return null; // best-effort; never fail doctor on this check
  }
}

/**
 * db-availability loop (2c/2c-bis): the ONE classified-connection-fail shape,
 * shared by the live connection check and the dead-DB synthesized entry.
 * `connection` is in ROOT_CAUSE_CHECKS, so top_issues[0].fix carries the
 * classified remediation instead of a raw pg error. Deliberately NOT
 * makeRemediationStep: that lane feeds `--remediate`, whose Minion jobs need
 * the very DB that's down (db-repair is the engine-free applier here).
 */
function classifiedConnectionCheck(e: unknown): Check {
  const d = classifyPgAccessError(e, { url: loadConfig()?.database_url ?? null });
  return {
    name: 'connection',
    status: 'fail',
    message: d.message,
    details: { reason: d.reason, transient: d.transient, fix_hint: `${d.remediation} Run: gbrain db-repair` },
  };
}

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
 * Side effects retained inside buildChecks (kept for "no behavior change"):
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

  const checks: Check[] = [];
  let autoFixReport: AutoFixReport | null = null;

  // Progress reporter. `--json` is doctor's machine-readable output, so plain
  // progress must not leak to stderr unless the caller explicitly asks for
  // structured progress with --progress-json.
  const progress = createProgress(doctorProgressOptions(jsonOutput));

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
  if (scope === 'all' && skillsDir) {

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
  } else if (scope === 'all') {
    checks.push({ name: 'resolver_health', status: 'warn', message: 'Could not find skills directory' });
  }

  // 1b. Retrieval Reflex health (#1981, SKILL group — gated). Truthful runtime
  // status: the deterministic pointer layer is on by default; the heartbeat file
  // (written by the context engine when it actually injects) is the authority for
  // "is it firing". The doctor cannot see the OpenClaw host capability directly,
  // so it never claims "enabled via host"; it reports observed activity instead.
  if (scope === 'all') {
    checks.push(buildRetrievalReflexCheck(skillsDir));
  }

  // 1b-2. Per-channel push-context visibility (the hook lane's feedback
  // loop). Engine-aware sibling of the reflex heartbeat check above — the
  // LOCAL `gbrain doctor` is the primary operator surface for this, so it
  // runs here as well as on the remote report path. Skipped in fs-only mode.
  if (scope === 'all' && engine && !fastMode) {
    checks.push(await checkVolunteerChannels(engine));
  }

  // 1c. MEMORY_VERBS v1 usage sidecar health (Cathedral 1, E4). Read-only,
  // fail-open: reports whether the local JSONL sidecar is present + parseable
  // and when a verb last fired. Local file only — never uploaded.
  if (scope === 'all') {
    checks.push(await buildMemoryVerbsCheck());
  }

  // 2. Skill conformance (SKILL group — gated)
  if (scope === 'all' && skillsDir) {
    const conformanceResult = skillConformanceCheck(skillsDir);
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
  //
  // SKILL group — gated.
  if (scope === 'all' && skillsDir) {
    checks.push(skillBrainFirstCheck(skillsDir));
  }

  // 2c. Skills manifest integrity (#159): tamper-evidence, not signatures.
  // Compares the skills tree against its committed skills.lock.json and
  // WARNS on drift — never fails, never blocks. No manifest (e.g. a user
  // workspace skills dir, or a compiled binary far from the repo) → ok/skip.
  // SKILL group — gated.
  if (scope === 'all' && skillsDir) {
    checks.push(skillsManifestIntegrityCheck(skillsDir));
  }

  // 2c-bis. Skill currency (new built-in skills available downstream) +
  // live precondition verification for installed skills that declare
  // `requires:`. Currency is filesystem-only; preconditions need the engine
  // and skip cleanly without one.
  if (scope === 'all' && skillsDir) {
    checks.push(skillCurrencyCheck(skillsDir));
    checks.push(await skillPreconditionsCheck(skillsDir, engine));
  }

  // 2d. Agent-bootstrap health (plan B2/B4/ENG-4). Filesystem-first; the
  // one engine-dependent pairing check degrades gracefully when engine is
  // null. Emits NOTHING on machines with no bootstrap state, so ordinary
  // brains keep a clean doctor.
  checks.push(...(await bootstrapDoctorChecks(engine)));

  // 2e. Memorable relay health — engine-free, file-plane only, so it runs
  // unconditionally (survives --fast and every --scope). Gate off = one quiet
  // ok row; the states it exists to catch are enabled-without-disclosure and
  // enabled-but-never-actually-relaying.
  checks.push(await buildMemorableRelayCheck());

  // 2e-bis. Ambient-writeback health (WP6): resolved mode/TTL/visibility +
  // brain audience, installed instruction blocks (receipt vs live probe vs
  // drift), validity-lapsed count, and the 7d local counters. Off = one
  // quiet ok row (opt-in convention).
  progress.heartbeat('memory_writeback');
  checks.push(await buildMemoryWritebackCheck(engine));

  // 2f. Chat-connector health (D3.2): re-auth-needed / stalled-sync / drift.
  // Credential-gated + auto_sync-gated — emits a plain "ok" (no nag) on brains
  // with no connectors or a manual-only user.
  if (engine) {
    try {
      const { connectorsHealthCheck } = await import('./doctor/checks/connectors.ts');
      checks.push(await connectorsHealthCheck(engine));
    } catch {
      // best-effort; a connectors check failure must never break doctor
    }
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

  // 3b. Upgrade-error trail (v0.13+). See checkUpgradeErrors for the #4517
  // staleness re-verification semantics (binary version + schema ledger).
  const upgradeErrorsCheck = await checkUpgradeErrors(engine);
  if (upgradeErrorsCheck) checks.push(upgradeErrorsCheck);

  // 3b-ter. Self-upgrade health (#3747). Pure local-file check (config +
  // upgrade cache + audit trail; no DB) that was only ever pushed by the
  // REMOTE report (doctor/report-remote.ts) — the local `gbrain doctor`,
  // the surface an operator actually runs on the host, never emitted it,
  // so a wedged auto-upgrade loop was invisible exactly where it would be
  // diagnosed. Sits beside the upgrade_errors trail it complements.
  checks.push(checkSelfUpgradeHealth());

  // 3b-bis. Supervisor health (filesystem-only: PID liveness + audit log).
  // Reads the default PID file (`~/.gbrain/supervisor.pid` unless the user
  // overrode with GBRAIN_SUPERVISOR_PID_FILE) and the latest audit file
  // written by src/core/minions/handlers/supervisor-audit.ts. Surfaces
  // supervisor_running / last_start / crashes_24h / max_crashes_exceeded.
  // Does NOT run the supervisor itself — this is a read-only health check.
  try {
    const { DEFAULT_PID_FILE } = await import('../core/minions/supervisor.ts');
    const { readSupervisorEvents, summarizeCrashes } = await import('../core/minions/handlers/supervisor-audit.ts');
    const { readSupervisorPid } = await import('../core/minions/supervisor-pid.ts');

    const pidStatus = readSupervisorPid(DEFAULT_PID_FILE);
    const supervisorPid = pidStatus.pid;
    const pidfileRunning = pidStatus.running;

    // issue #2227 fix #1/#3: DEFAULT_PID_FILE is HOME-derived, so a supervisor
    // started under a different $HOME reads as "not running" even when healthy.
    // Consult the queue-scoped DB singleton lock (#1849, HOME-independent) before
    // warning. PID-reuse-safe (isLockHolderLive keys on lock freshness).
    let detectedViaDbLock = false;
    if (!pidfileRunning && engine) {
      try {
        const { inspectLock, isLockHolderLive } = await import('../core/db-lock.ts');
        const { supervisorLockId, SUPERVISOR_LOCK_TTL_MIN } = await import('../core/minions/supervisor.ts');
        const snap = await inspectLock(engine, supervisorLockId('default'));
        if (snap && isLockHolderLive(snap, SUPERVISOR_LOCK_TTL_MIN)) detectedViaDbLock = true;
      } catch { /* pre-migration / transient: pidfile-only */ }
    }
    const running = pidfileRunning || detectedViaDbLock;
    // #4518: under --fast, `engine` is null (the CLI dispatcher never
    // connects — see cli.ts's `if (args.includes('--fast'))` branch), so the
    // #1849 DB-lock fallback above is structurally unreachable. A supervisor
    // running the documented multi-queue pattern (distinct --pid-file per
    // named queue, e.g. `supervisor-cron.pid` + `supervisor-default.pid`)
    // never writes DEFAULT_PID_FILE either, so `running` is always false for
    // that install shape under --fast — not because it's actually down, but
    // because the ONE check that could prove otherwise was never attempted.
    // Don't assert "not running" on a check we know is inconclusive here.
    const dbLockCheckSkippedUnderFast = fastMode && !pidfileRunning && !engine;

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
    const causeStr = `runtime=${summary.by_cause.runtime_error} oom=${summary.by_cause.oom_or_external_kill} rss=${summary.by_cause.rss_watchdog} unknown=${summary.by_cause.unknown} legacy=${summary.by_cause.legacy}${summary.by_cause.rss_watchdog > 0 ? ' (see worker_oom_loop)' : ''}`;
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
      } else if (!running && dbLockCheckSkippedUnderFast && events.length > 0) {
        // #4518: pidfile check found nothing at the HOME-derived default
        // path, but under --fast we never got to try the #1849 DB-lock
        // fallback that would prove a per-queue --pid-file supervisor is
        // actually alive. Say so instead of asserting a liveness verdict
        // this run structurally couldn't determine.
        checks.push({
          name: 'supervisor',
          status: 'ok',
          message: `Not found at the default pidfile path (last_start=${lastStart ?? 'unknown'}) — inconclusive under --fast (DB-lock fallback needs a connection). Run \`gbrain doctor\` without --fast to verify a per-queue --pid-file supervisor.`,
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
          message: `running=true${detectedViaDbLock ? ' (detected via DB lock; pidfile not at the HOME-derived path)' : ` pid=${supervisorPid}`} last_start=${lastStart ?? 'unknown'} crashes_24h=${crashes24h} clean_exits_24h=${summary.clean_exits}`,
        });
      }
    }
  } catch {
    // Audit read / import failure is best-effort; skip silently.
  }

  // 3b-bis-2. Supervisor SINGLETON + effective max-rss (#1849). Separate check
  // from `supervisor` above (same Codex #11 precedent as the niceness split) so
  // a singleton-divergence warn can't clobber the crash/liveness precedence.
  //
  // The #1849 fix makes a queue-scoped DB lock the real singleton authority. A
  // second supervisor on the same (db, queue) now fails fast at start — but if
  // a rogue one slipped in BEFORE upgrade (or someone ran one with an explicit
  // --pid-file on a pre-fix binary), the lock holder's (host, pid) won't match
  // the local pidfile. Surface that mismatch + the effective --max-rss (the cap
  // a rogue supervisor would have fought over). Bare pid is meaningless across
  // hosts/containers, so we compare host+pid (Codex #25).
  try {
    const { DEFAULT_PID_FILE, supervisorLockId, classifySupervisorSingleton } = await import('../core/minions/supervisor.ts');
    const { readSupervisorEvents } = await import('../core/minions/handlers/supervisor-audit.ts');
    const { readSupervisorPid } = await import('../core/minions/supervisor-pid.ts');
    const { hostname } = await import('os');

    const events = readSupervisorEvents({ sinceMs: 24 * 60 * 60 * 1000 });
    const lastStarted = events.filter(e => e.event === 'started').pop() as
      | (Record<string, unknown> & { ts?: string })
      | undefined;

    // Only run when a supervisor was actually observed (no noise on installs
    // that never used it) and we have a live engine to read the lock row.
    if (lastStarted && engine) {
      const queue = typeof lastStarted.queue === 'string' ? lastStarted.queue : 'default';
      const effectiveMaxRss = typeof lastStarted.max_rss_mb === 'number' ? lastStarted.max_rss_mb : null;
      // The 'started' event already records the pid-file path actually in use
      // (this.opts.pidFile, which reflects a custom --pid-file). Prefer that
      // over re-deriving DEFAULT_PID_FILE locally so a custom --pid-file
      // deployment doesn't false-positive a singleton mismatch against itself.
      // Falls back to DEFAULT_PID_FILE when the event carries no usable value.
      const pidFilePath = typeof lastStarted.pid_file === 'string' && lastStarted.pid_file.length > 0
        ? lastStarted.pid_file
        : DEFAULT_PID_FILE;
      const localPid = readSupervisorPid(pidFilePath).pid;
      const localHost = hostname();

      // Read the DB singleton lock holder for this queue.
      const lockRows = await engine.executeRaw<{ holder_pid: number; holder_host: string; live: boolean }>(
        `SELECT holder_pid, holder_host, ttl_expires_at > now() AS live
           FROM gbrain_cycle_locks WHERE id = $1`,
        [supervisorLockId(queue)],
      );
      const lock = lockRows[0] ?? null;
      const rssStr = effectiveMaxRss !== null ? `${effectiveMaxRss}MB` : 'unknown';

      const verdict = classifySupervisorSingleton({
        lockLive: !!lock?.live,
        lockHolderHost: lock?.holder_host ?? null,
        lockHolderPid: lock?.holder_pid ?? null,
        localHost,
        localPid,
      });
      if (verdict === 'mismatch') {
        checks.push({
          name: 'supervisor_singleton',
          status: 'warn',
          message:
            `Queue '${queue}' singleton lock is held by ${lock!.holder_host}:${lock!.holder_pid}, ` +
            `but the local pidfile points to ${localHost}:${localPid ?? 'none'}. A second supervisor may be ` +
            `running with a different --max-rss (effective cap here: ${rssStr}). Stop the extra one ` +
            `and keep a single supervisor per queue: gbrain jobs supervisor stop.`,
          details: { queue, lock_holder: `${lock!.holder_host}:${lock!.holder_pid}`, local: `${localHost}:${localPid ?? 'none'}`, effective_max_rss_mb: effectiveMaxRss },
        });
      } else if (verdict === 'single') {
        checks.push({
          name: 'supervisor_singleton',
          status: 'ok',
          message: `Single supervisor on queue '${queue}' (holder=${lock!.holder_host}:${lock!.holder_pid}, max_rss=${rssStr}).`,
          details: { queue, effective_max_rss_mb: effectiveMaxRss },
        });
      }
    }
  } catch {
    // Best-effort (lock table may not exist on a very old brain); skip silently.
  }

  // 3b-sexies. Supervisor/worker scheduling priority (niceness, issue #1815).
  // SEPARATE check from `supervisor` above so a niceness divergence warn can
  // never clobber the supervisor check's max_crashes_exceeded fail/warn
  // precedence (Codex #11). Only surfaces when --nice was actually used (a live
  // worker exists or the supervisor recorded a niceness), so installs that never
  // touched --nice get no noise.
  try {
    const { DEFAULT_PID_FILE } = await import('../core/minions/supervisor.ts');
    const { readSupervisorPid } = await import('../core/minions/supervisor-pid.ts');
    const { readWorkers } = await import('../core/minions/worker-registry.ts');
    const { getEffectiveNiceness, formatNice } = await import('../core/minions/niceness.ts');

    const sup = readSupervisorPid(DEFAULT_PID_FILE);
    const supervisorNice = sup.running && sup.pid !== null ? getEffectiveNiceness(sup.pid) : null;
    const workers = readWorkers().map(w => ({
      pid: w.pid,
      queue: w.queue,
      brain_id: w.brain_id,
      nice_requested: w.nice_requested,
      nice_effective: w.nice_now,
    }));

    if (workers.length > 0 || supervisorNice !== null) {
      // Divergence: a worker (or the supervisor) asked for a niceness it didn't
      // get — usually negative nice without privilege, or an RLIMIT_NICE clamp.
      const diverged = workers.filter(
        w => w.nice_requested !== null && w.nice_effective !== null && w.nice_requested !== w.nice_effective,
      );

      const workerSummary = workers
        .map(w => `pid ${w.pid}=${w.nice_effective !== null ? formatNice(w.nice_effective) : '?'}`)
        .join(', ');
      const supPart = supervisorNice !== null ? `supervisor=${formatNice(supervisorNice)}` : '';
      const okMsg = [supPart, workerSummary && `workers: ${workerSummary}`].filter(Boolean).join('; ');

      if (diverged.length > 0) {
        const detail = diverged
          .map(w => `pid ${w.pid} requested ${formatNice(w.nice_requested!)} but running at ${formatNice(w.nice_effective!)}`)
          .join('; ');
        checks.push({
          name: 'supervisor_niceness',
          status: 'warn',
          message: `Niceness not applied as requested (${detail}). Negative nice needs privilege; the OS may also clamp to RLIMIT_NICE. Workers run at their inherited priority.`,
          details: { supervisor_nice: supervisorNice, workers },
        });
      } else {
        checks.push({
          name: 'supervisor_niceness',
          status: 'ok',
          message: okMsg || 'No niceness override active',
          details: { supervisor_nice: supervisorNice, workers },
        });
      }
    }
  } catch {
    // Registry / import failure is best-effort; skip silently.
  }

  // 3b-quater. Worker OOM-loop (issue #1685 GAP A) — the single authoritative
  // "is the worker OOM-looping" line, unioning supervised (supervisor audit)
  // and bare-worker (minion_jobs watchdog-abort) kills. Returns null when the
  // worker never OOM'd, so clean installs see nothing.
  try {
    const oomCheck = await computeWorkerOomLoopCheck(engine);
    if (oomCheck) checks.push(oomCheck);
  } catch {
    // best-effort.
  }

  // 3b-quinquies. DB pool reap health (issue #1685 GAP B) — Postgres pooler
  // reap frequency + recovered-vs-stuck split. Quiet unless reaps thrash or
  // reconnect is failing.
  try {
    const reapCheck = await computePoolReapHealthCheck(engine);
    if (reapCheck) checks.push(reapCheck);
  } catch {
    // best-effort.
  }

  // 3b-tris. Stub-guard fire count (last 24h). The v0.34.5 stub guard in
  // fence-write.ts refuses to spawn unprefixed entity pages (bare `alice.md`
  // at brain root); the #4108 arm refuses pages for fallback-resolved slugs
  // no live page backs. Fires append per-arm `reason` lines to
  // ~/.gbrain/audit/stub-guard-YYYY-Www.jsonl (pre-#4108 lines lack one and
  // count as unprefixed). The v0.36 sunset criterion covers 'unprefixed'
  // ONLY; the fallback_resolution arm never sunsets.
  //
  // WARN at >10 fires/24h — at that rate the resolver is probably missing
  // a case (typo prefix, alias, non-Latin script). Operators should grep
  // the audit log for the slugs that hit it and either add the missing
  // resolver branch or document them as legitimate bare-slug ingestion.
  try {
    const { readRecentStubGuardEvents } = await import('../core/facts/stub-guard-audit.ts');
    const events = readRecentStubGuardEvents({ sinceMs: 24 * 60 * 60 * 1000 });
    const fallbackCount = events.filter((e) => e.reason === 'fallback_resolution').length;
    const reasonSplit = `unprefixed=${events.length - fallbackCount}, fallback_resolution=${fallbackCount}`;
    if (events.length > 10) {
      // Surface the top 3 slugs that hit it so operators have somewhere to start.
      const slugCounts = new Map<string, number>();
      for (const e of events) slugCounts.set(e.slug, (slugCounts.get(e.slug) ?? 0) + 1);
      const topSlugs = [...slugCounts.entries()]
        .sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([slug, n]) => `${slug}(${n})`).join(', ');
      checks.push({
        name: 'stub_guard_24h',
        status: 'warn',
        message:
          `Stub guard fired ${events.length}x in last 24h (${reasonSplit}; top: ${topSlugs}). ` +
          `If this stays elevated, the prefix-expansion in resolveEntitySlug is ` +
          `missing a case. Check ~/.gbrain/audit/stub-guard-*.jsonl for the slugs ` +
          `that hit it.`,
      });
    } else if (events.length > 0) {
      checks.push({
        name: 'stub_guard_24h',
        status: 'ok',
        message: `Stub guard fired ${events.length}x in last 24h (${reasonSplit}; below WARN threshold of 10).`,
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
    const { unacknowledgedSyncFailures, loadSyncFailures, summarizeFailuresByCode, decideSyncFailureSeverity } = await import('../core/sync.ts');
    const all = loadSyncFailures();
    // issue #1939: "unresolved" = open + auto_skipped. Severity (ok/warn/fail)
    // comes from the SAME shared decision the remote surface uses, so a stuck
    // bookmark blocked past the fail cadence (or a large unresolved count)
    // escalates to FAIL instead of staying a quiet WARN forever.
    const unresolved = unacknowledgedSyncFailures();
    if (unresolved.length > 0) {
      const failHours = _resolveSyncFreshnessHours('GBRAIN_SYNC_FRESHNESS_FAIL_HOURS', 72);
      const sev = decideSyncFailureSeverity({ entries: all, nowMs: Date.now(), failHours });
      const codeSummary = summarizeFailuresByCode(unresolved);
      const codeBreakdown = codeSummary.map(s => `${s.code}=${s.count}`).join(', ');
      const preview = unresolved.slice(0, 3).map(f => `${f.path} (${f.error.slice(0, 60)})`).join('; ');
      // v0.40.3.0 T8b (D8 + D12 Bug 3): emit a single sync-retry-failed
      // step. sync-skip-failed is DELIBERATELY NOT emitted as a remediation
      // — auto-skipping failed syncs hides data loss. Operators can still
      // run `gbrain sync --skip-failed` manually.
      const { makeRemediationStep } = await import('../core/remediation-step.ts');
      const oldestTs = unresolved.reduce(
        (acc, f) => (acc === '' || f.ts < acc ? f.ts : acc),
        '',
      );
      const retryStep = makeRemediationStep({
        id: 'sync-retry-failed',
        job: 'sync-retry-failed',
        // Content-stable per codex D12 Bug 2: count + oldest_ts captures
        // the relevant state without using a real timestamp.
        params: { failure_count: unresolved.length, oldest_failure: oldestTs },
        severity: sev.status === 'fail' ? 'high' : 'medium',
        est_seconds: 30,
        est_usd_cost: 0,
        rationale: `Retry ${unresolved.length} unresolved sync failure(s) (codes: ${codeBreakdown})`,
      });
      checks.push({
        name: 'sync_failures',
        status: sev.status,
        message:
          `${unresolved.length} unresolved sync failure(s) [${codeBreakdown}]` +
          (sev.auto_skipped > 0 ? ` — ${sev.auto_skipped} auto-skipped (pages NOT indexed)` : '') +
          `. ${preview}` +
          `${unresolved.length > 3 ? `, and ${unresolved.length - 3} more` : ''}. ` +
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

  // 3d.05 Malformed-path pages. DB pages whose backing FILENAME contains
  // bracket/control characters (markdown-link syntax as a literal filename).
  // Sync refuses to import such markdown paths; this check is the discovery
  // surface for rows ingested before that gate. Two-tier remediation matches
  // core/sync.ts: POISONED rows (`](`/control chars) reconcile away on a full
  // sync; bare-bracket rows are kept (deleting them while their file exists
  // would be data loss) and need a rename + re-sync.
  if (engine) {
    try {
      const { hasMalformedPathSegment, isPoisonedPath } = await import('../core/sync.ts');
      const candidates = await engine.executeRaw<{ slug: string; source_id: string; source_path: string }>(
        `SELECT slug, source_id, source_path FROM pages
          WHERE source_path IS NOT NULL AND deleted_at IS NULL
            AND (source_path LIKE '%[%' OR source_path LIKE '%]%'
                 OR source_path ~ '[[:cntrl:]]')`,
        [],
      );
      const malformed = candidates.filter(r => hasMalformedPathSegment(r.source_path));
      if (malformed.length > 0) {
        const poisoned = malformed.filter(r => isPoisonedPath(r.source_path)).length;
        const bare = malformed.length - poisoned;
        const preview = malformed.slice(0, 3).map(r => r.slug).join(', ');
        checks.push({
          name: 'malformed_path_pages',
          status: 'warn',
          message:
            `${malformed.length} page(s) backed by malformed filenames (bracket/control ` +
            `characters) pollute search: ${preview}` +
            `${malformed.length > 3 ? `, and ${malformed.length - 3} more` : ''}. ` +
            (poisoned > 0 ? `${poisoned} junk row(s): run a full 'gbrain sync' to reconcile them away. ` : '') +
            (bare > 0 ? `${bare} bare-bracket row(s) are kept — rename the backing file(s) and re-sync.` : ''),
        });
      }
    } catch {
      // Best-effort; a schema without source_path shouldn't stop doctor.
    }
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
    const { resolveProbeEnabled } = await import('../core/cycle/nightly-quality-probe.ts');
    let probeEnabled = false;
    try {
      // Dual-plane read, matching the autopilot gate: the DB row (what the
      // enable hint's `gbrain config set` writes) wins; file plane fallback.
      let dbVal: string | null = null;
      try {
        dbVal = engine ? await engine.getConfig('autopilot.nightly_quality_probe.enabled') : null;
      } catch { /* DB unavailable → file plane only */ }
      const cfg = loadConfig();
      probeEnabled = resolveProbeEnabled(dbVal, (cfg as any)?.autopilot?.nightly_quality_probe?.enabled);
    } catch { /* config unavailable → treat as disabled */ }
    const events = readRecentQualityProbeEvents(7);
    const check = computeNightlyQualityProbeHealthCheck(probeEnabled, events);
    checks.push(check);
  } catch {
    // Best-effort; audit-log read failure shouldn't stop doctor.
  }

  // 3d.3 v0.42 — extract_health. Reads extract_rollup_7d (migration v106)
  // for per-kind aggregates. Empty rollup → OK. High halt rate per kind
  // → WARN. Rollup write failures → WARN (audit JSONL is the SoT, but
  // operator should know the DB cache is degraded). See plan A5 + D-EXTRACT-32.
  if (engine) {
    try {
      const check = await computeExtractHealthCheck(engine);
      checks.push(check);
    } catch {
      // Best-effort; rollup-table missing on pre-v106 brains is normal
      // and is already handled inside computeExtractHealthCheck.
    }
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

  // 3d.2b issue #1678 — extract_atoms_backlog. Surfaces the silent
  // pack-gated-phase backlog: when the active pack doesn't run extract_atoms
  // but eligible pages pile up, WARN with the `--drain` command. OK when the
  // pack runs the phase (routine cycle drains it) or there's no backlog.
  if (engine) {
    try {
      checks.push(await computeExtractAtomsBacklogCheck(engine));
    } catch {
      // Best-effort; backlog query failure shouldn't stop doctor.
    }
    // The mirror of the backlog check: atoms whose source_hash no longer
    // resolves to any live page (#4566). Same best-effort posture.
    try {
      checks.push(await computeAtomProvenanceDriftCheck(engine));
    } catch {
      // Best-effort; provenance query failure shouldn't stop doctor.
    }
  }

  // 3d.3 v0.41.13.0 — conversation_format_coverage. Peeled to
  // doctor/checks/conversation-coverage.ts (#4193) so it is unit-testable;
  // summary-only conversation pages report separately instead of counting
  // as parser misses. Error handling lives inside the compute function.
  if (engine) {
    checks.push(await computeConversationFormatCoverageCheck(engine));
  }

  // 3d.4 v0.41.13.0 — progressive_batch_audit_health. Reads last 7
  // days of `~/.gbrain/audit/progressive-batch-YYYY-Www.jsonl` and
  // surfaces operations that aborted with `abort_*` verdicts so
  // operators see what went wrong without grep'ing the JSONL by hand.
  try {
    const { readRecentProgressiveBatchEvents } = await import(
      '../core/progressive-batch/audit.ts'
    );
    const events = readRecentProgressiveBatchEvents(7);
    const aborts = events.filter((e) => e.verdict !== 'proceed');
    if (aborts.length === 0) {
      checks.push({
        name: 'progressive_batch_audit_health',
        status: 'ok',
        message:
          events.length === 0
            ? 'No progressive-batch operations in the last 7 days'
            : `${events.length} progressive-batch events; 0 aborts`,
      });
    } else {
      const reasonsCounted: Record<string, number> = {};
      for (const e of aborts) {
        const key = e.abort_reason ?? e.verdict;
        reasonsCounted[key] = (reasonsCounted[key] ?? 0) + 1;
      }
      const breakdown = Object.entries(reasonsCounted)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      checks.push({
        name: 'progressive_batch_audit_health',
        status: 'warn',
        message:
          `${aborts.length}/${events.length} progressive-batch events aborted in last 7d. ` +
          `Breakdown: ${breakdown}. ` +
          `Inspect: cat ~/.gbrain/audit/progressive-batch-*.jsonl | jq 'select(.verdict != "proceed")'`,
      });
    }
  } catch (err) {
    checks.push({
      name: 'progressive_batch_audit_health',
      status: 'ok',
      message: `Skipped (audit file unreachable): ${(err as Error)?.message ?? String(err)}`,
    });
  }

  // 3d.5 v0.41.13.0 — conversation_parser_probe_health. Mode-gated
  // per D10: ON when search.mode=tokenmax, opt-in for other modes.
  // Surfaces the last 7 days of nightly-probe audit events; warn on any
  // non-pass outcome (fail / budget_exceeded / adversarial_false_positive).
  // (Until the autopilot wire-up this was a hardcoded "Skipped" stub.)
  try {
    const { readRecentParserProbeEvents } = await import('../core/audit-parser-probe.ts');
    let parserProbeEnabled = false;
    try {
      let dbVal: string | null = null;
      let dbMode: string | null = null;
      try {
        dbVal = engine ? await engine.getConfig('autopilot.conversation_parser_probe.enabled') : null;
        dbMode = engine ? await engine.getConfig('search.mode') : null;
      } catch { /* DB unavailable → file plane only */ }
      const { loadConfig } = await import('../core/config.ts');
      const fileVal = (loadConfig() as any)?.autopilot?.conversation_parser_probe?.enabled;
      const flagOn = dbVal != null ? dbVal === 'true' : fileVal === true;
      parserProbeEnabled = flagOn || dbMode === 'tokenmax';
    } catch { /* config unavailable → treat as disabled */ }
    const parserEvents = readRecentParserProbeEvents(7);
    checks.push(computeConversationParserProbeHealthCheck(parserProbeEnabled, parserEvents));
  } catch {
    // Best-effort; audit-log read failure shouldn't stop doctor.
  }

  // 3e. home_dir_in_worktree (v0.35.8.0; peeled to doctor/checks/home-worktree.ts).
  // Walks up from `gbrainPath()` toward $HOME looking for a VALIDATED `.git`
  // marker (#4683: an empty/invalid `.git` git itself rejects no longer warns).
  // Honors GBRAIN_HOME via gbrainPath().
  try {
    checks.push(buildHomeDirInWorktreeCheck(
      gbrainPath(),
      process.env.HOME || '',
      Boolean(process.env.GBRAIN_HOME),
    ));
  } catch {
    // Best-effort filesystem-hygiene check; never block doctor.
  }

  // 3f. npm_squat (#505). The npm registry name `gbrain` belongs to an
  // unrelated third-party package — this project is NOT distributed on npm.
  // A reflexive `npm i -g gbrain` / `bun add -g gbrain` installs something
  // unrelated that can shadow the real binary on PATH. Classify every
  // `gbrain` that `which -a` finds (pure helpers in
  // src/core/npm-squat-check.ts) and warn when an unrelated install wins on
  // PATH or the entry is broken. Skips silently when gbrain isn't on PATH
  // at all (e.g. running via `bun src/cli.ts`).
  try {
    const { execSync } = await import('node:child_process');
    let candidates: string[] = [];
    try {
      candidates = execSync('which -a gbrain', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      // `which` exits non-zero when gbrain isn't on PATH (or is missing
      // entirely on this platform) — nothing to check.
    }
    const { assessGbrainBinaries } = await import('../core/npm-squat-check.ts');
    const assessment = assessGbrainBinaries(candidates);
    if (assessment.status !== 'skip') {
      checks.push({
        name: 'npm_squat',
        status: assessment.status,
        message: assessment.message,
      });
    }
  } catch {
    // Best-effort environment check; never block doctor.
  }

  // 3g. pglite_leftovers (#3856). A pglite -> postgres migration leaves the
  // old engine store (`brain.pglite/`) under the gbrain home forever — dead
  // weight roughly the size of the live DB that nothing surfaces, silently
  // riding along in any backup that archives the home dir. Assessment is a
  // pure helper (src/core/pglite-leftovers-check.ts); it warns ONLY for a
  // durable postgres engine, and skips while `migrate-manifest.json` exists
  // (an in-flight/interrupted migration can make `brain.pglite` the LIVE
  // target while the durable engine still reads postgres — #3194) and for
  // everything else (fail open).
  // The engine is read from config.json DIRECTLY, not loadConfig(): a
  // transient DATABASE_URL (#427) can make a live PGLite brain resolve as
  // postgres for one process, and deletion advice must never rest on an
  // env override (Codex review P1).
  // Warn-only by design: WHEN the abandoned store is safe to drop is a
  // policy question (#3856), so the remediation is a verified manual delete
  // — no CLI command is named that does not exist (#3697).
  try {
    const { readFileSync } = await import('node:fs');
    const durableEngine = (
      JSON.parse(readFileSync(join(gbrainPath(), 'config.json'), 'utf8')) as { engine?: unknown }
    ).engine;
    const { assessPgliteLeftovers } = await import('../core/pglite-leftovers-check.ts');
    const leftovers = assessPgliteLeftovers(
      typeof durableEngine === 'string' ? durableEngine : undefined,
      gbrainPath(),
    );
    if (leftovers.status !== 'skip') {
      checks.push({
        name: 'pglite_leftovers',
        status: leftovers.status,
        message: leftovers.message,
      });
    }
  } catch {
    // Best-effort filesystem-hygiene check; never block doctor (a missing/
    // unparseable config.json lands here and skips, same fail-open posture).
  }

  // 3a-bis. default_source_local_path (#4739, narrowed). A null
  // default.local_path is the DESIGNED fallback topology (pages nest under
  // sync.repo_path), so this only warns when that fallback demonstrably
  // fails: file-backed default pages with no resolvable root, or a
  // sync.repo_path the #2018 leak guard silently skips. Logic lives in
  // doctor/checks/default-source-path.ts (module-dir rule).
  if (engine !== null) try {
    const { defaultSourceLocalPathCheck } = await import('./doctor/checks/default-source-path.ts');
    const dspCheck = await defaultSourceLocalPathCheck(engine!);
    if (dspCheck) checks.push(dspCheck);
  } catch {
    // Best-effort. A broken sources table should not stop doctor.
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
        const skipNote = result.git_root_skipped.length > 0
          ? multiSourceDriftGitRootSkipNote(result.git_root_skipped)
          : '';
        checks.push({
          name: 'multi_source_drift',
          status: 'warn',
          message: multiSourceDriftAdvice(result.count, sampleStr) + skipNote,
        });
      } else {
        // #4712: if EVERY candidate source was skipped as git-root-pinned,
        // no walk actually ran — 'ok' would misreport "verified clean" when
        // nothing was checked at all. 'warn' only in that all-skipped case;
        // a partial skip alongside real, clean coverage stays 'ok'.
        const allSkipped =
          result.git_root_skipped.length > 0 &&
          result.git_root_skipped.length >= nonDefaultWithPath.length;
        checks.push({
          name: 'multi_source_drift',
          status: allSkipped ? 'warn' : 'ok',
          message: allSkipped
            ? `Multi-source drift check performed no verification` +
              multiSourceDriftGitRootSkipNote(result.git_root_skipped)
            : result.git_root_skipped.length > 0
              ? `No cross-source slug drift detected among checked sources.` +
                multiSourceDriftGitRootSkipNote(result.git_root_skipped)
              : 'No cross-source slug drift detected.',
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

  // 3d. PGLite data-dir diagnosis (WAL-repair wave) + scratch-store probe
  // (#2674). The data-dir check re-derives the failure state from DISK (the
  // connect error was swallowed by the fs-only fallback); the probe adds the
  // RUNTIME dimension (a throwaway store that opens fine proves the WASM
  // runtime is healthy). Both only fire when the connect already FAILED on a
  // PGLite brain (engine === null, not --fast — under --fast connect wasn't
  // attempted, so "engine === null" proves nothing there).
  //
  // Probe cost gate (a PGLite cold start is 5–20s): auto-runs ONLY when init
  // failed AND the disk diagnosis didn't already fully explain it — a live
  // lock or a missing dir needs no runtime probe (and 'locked' was exactly
  // the reviewed false-positive: blaming the store while `gbrain serve` held
  // it). Explicit --probe-pglite always runs it. A routine healthy
  // `gbrain doctor` never pays it.
  {
    const probeRequested = args.includes('--probe-pglite');
    let cfgForProbe: ReturnType<typeof loadConfig> = null;
    try { cfgForProbe = loadConfig(); } catch { /* no config — nothing to diagnose */ }
    const pgliteInitFailed = !engine && !fastMode && cfgForProbe?.engine === 'pglite';

    let dirVerdict: import('../core/pglite-repair.ts').PgliteDirDiagnosis['verdict'] | undefined;
    if (pgliteInitFailed) {
      try {
        const { inspectPgliteDataDir } = await import('../core/pglite-repair.ts');
        const { resolve } = await import('node:path');
        // Absolutize: a RELATIVE database_path would make the sidecar/backup
        // lookups resolve against doctor's cwd instead of the engine's.
        const pgliteDataDir = resolve(cfgForProbe!.database_path || gbrainPath('brain.pglite'));
        const diagnosis = inspectPgliteDataDir(pgliteDataDir);
        dirVerdict = diagnosis.verdict;
        checks.push(computePgliteDataDirCheck(pgliteDataDir, diagnosis));
      } catch {
        // Best-effort: an unreadable config or fs failure must not stop doctor.
      }
    }

    const dirExplainsFailure = dirVerdict === 'locked' || dirVerdict === 'missing';
    if (probeRequested || (pgliteInitFailed && !dirExplainsFailure)) {
      progress.start('doctor.pglite_probe');
      const stopHb = startHeartbeat(progress, 'pglite scratch-store probe (cold start, can take 5–20s)…');
      try {
        checks.push(
          await checkPgliteScratchProbe({
            // A lock/missing dir explains the failure without the store being
            // damaged — an explicit --probe-pglite there still reports on the
            // runtime, but must not treat the store as the convicted party.
            realInitFailed: pgliteInitFailed && !dirExplainsFailure,
            storeDamageEvidence:
              dirVerdict === 'wal-corruption-likely' || dirVerdict === 'unsupported-layout',
            realStorePath: cfgForProbe?.database_path,
          }),
        );
      } finally {
        stopHb();
        progress.finish();
      }
    }
  }

  // --- DB checks (skip if --fast or no engine) ---

  if (fastMode || !engine) {
    if (!engine) {
      // Pick the precise message. When dbSource is provided, we know
      // whether a URL exists (env or config-file) — the caller simply
      // skipped the connection. When null, there really is no config
      // anywhere.
      if (!fastMode && dbSource && connectError !== undefined) {
        // 2c-bis: a REAL connect failure — synthesize the classified check so
        // `checks[name=="connection"]` exists in every failure shape.
        checks.push(classifiedConnectionCheck(connectError));
      } else {
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
      // URL-only + engine-free checks still run on a dead DB — that is the
      // point of them.
      const pgbouncer = await pgbouncerPrepareCheck();
      if (pgbouncer) checks.push(pgbouncer);
      const recurrence = dbRepairRecurrenceCheck();
      if (recurrence) checks.push(recurrence);
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

  // 3a. PgBouncer / prepared-statement compatibility — HOISTED above the
  // connection check because it is URL-only (no round-trip) and must still
  // run when the connection below fails.
  progress.heartbeat('pgbouncer_prepare');
  {
    const pgbouncer = await pgbouncerPrepareCheck();
    if (pgbouncer) checks.push(pgbouncer);
  }

  // 3b. db-repair recurrence — engine-free receipts read; runs regardless of
  // connection state (repeat repairs are most interesting when the DB is sick).
  {
    const recurrence = dbRepairRecurrenceCheck();
    if (recurrence) checks.push(recurrence);
  }

  // 3. Connection
  progress.heartbeat('connection');
  try {
    const stats = await engine.getStats();
    checks.push({ name: 'connection', status: 'ok', message: `Connected, ${stats.page_count} pages` });
  } catch (e: unknown) {
    // db-availability loop (2c): classified + redacted, with the fix hint.
    checks.push(classifiedConnectionCheck(e));
    progress.finish();
    // Early return: caller renders the partial check list + decides exit code.
    // Pre-v0.39 this site called outputResults + process.exit directly; the
    // narrow-seam extract moved both to the runDoctor CLI wrapper.
    return checks;
  }

  // 4. pgvector extension
  progress.heartbeat('pgvector');
  checks.push(await pgvectorCheck(engine));

  // 4a-bis. #550: pages(source_id, slug) upsert arbiter — when missing, every
  // page write fails brain-wide and the version counter can't see the drift.
  progress.heartbeat('pages_upsert_arbiter');
  checks.push(await pagesUpsertArbiterCheck(engine));

  // 4b. pglite_scale — engine-fit signal: makes the init-time 1000-file
  // Supabase suggestion re-evaluable for the life of the brain.
  progress.heartbeat('pglite_scale');
  {
    const scale = await pgliteScaleCheck(engine);
    if (scale) checks.push(scale);
  }
  // (pgbouncer_prepare moved ABOVE the connection check — URL-only, must
  // survive a dead DB.)

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
    checks.push({ name: 'schema_version', ...schemaVersionHealth(schemaVersion, LATEST_VERSION) });

    // 6b. Schema columns — gbrain#4421/#4425. The ledger counter alone can
    // lie: a PgBouncer transaction-mode pooler can swallow an ALTER TABLE
    // while the migration runner still advances config.version, leaving the
    // ledger "current" over a physically narrower table. The read-only column
    // diff below does the same live-column check `gbrain init --migrate-only`
    // already self-heals with — but a plain diagnostic run never issues DDL.
    if (schemaVersion > LATEST_VERSION) {
      // Forward skew (schemaVersionHealth warns AHEAD above): an ahead DB is
      // a superset of this client's expected columns — the diff below would
      // only mislead. "Upgrade this client" is the real fix; skip the diff.
    } else if (schemaVersion >= LATEST_VERSION) {
      // Ledger-current branch. Dynamic import is deliberate: the positional
      // source guard in test/doctor-schema-column-diff.test.ts pins that the
      // diff consult lives INSIDE this branch (a behind DB is EXPECTED to
      // miss columns from unapplied migrations — schema_version's own warn
      // covers that already, so the diff would only mislead there too).
      progress.heartbeat('schema_columns');
      try {
        const { detectMissingColumns } = await import('../core/schema-verify.ts');
        const detected = await detectMissingColumns(engine);
        if (detected.missing.length === 0) {
          checks.push({ name: 'schema_columns', status: 'ok', message: `${detected.checked} column(s) verified against live schema` });
        } else {
          const cols = detected.missing.map(m => `${m.table}.${m.column}`).join(', ');
          checks.push({
            name: 'schema_columns',
            status: 'warn',
            message:
              `${detected.missing.length} column(s) missing despite schema_version reporting up to date: ${cols}. ` +
              `The migration ledger advanced past a swallowed ALTER TABLE (PgBouncer transaction-mode is the ` +
              `usual cause). Fix: gbrain init --migrate-only (runs the schema self-heal); if it persists, ` +
              `connect directly to Postgres (not the pooler) first.`,
          });
        }
      } catch {
        checks.push({ name: 'schema_columns', status: 'warn', message: 'Could not verify live schema columns' });
      }
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
            'Fix: recreate it with the SQL in docs/guides/rls-and-you.md ("What if the trigger gets dropped?").',
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
    // Coverage + missing now share one source (the stored vector over
    // eligible chunks), so the two numbers can no longer contradict each
    // other. When the READ path rides a custom active column, say so — this
    // check reports the default write-side column; the active-column truth
    // lives in embedding_column_registry.
    let carveOut = '';
    try {
      const activeCol = await engine.getConfig('search_embedding_column');
      if (activeCol && activeCol !== 'embedding') {
        carveOut = ` (read path uses '${activeCol}'; see embedding_column_registry)`;
      }
    } catch {
      // Config read is best-effort; the coverage numbers stand alone.
    }
    if (health.embed_coverage >= 0.9) {
      checks.push({ name: 'embeddings', status: 'ok', message: `${pct}% coverage, ${health.missing_embeddings} missing${carveOut}` });
    } else if (health.embed_coverage > 0) {
      checks.push({ name: 'embeddings', status: 'warn', message: `${pct}% coverage, ${health.missing_embeddings} missing. Run: gbrain embed --stale${carveOut}` });
    } else {
      checks.push({ name: 'embeddings', status: 'warn', message: `No embeddings yet. Run: gbrain embed --stale${carveOut}` });
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
    //   - non-empty brain → `gbrain migrate embeddings --to … --dim …` (#3390)
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
              : `Non-empty brain (${embeddedCount} embedded chunks). Migrate cleanly:\n        gbrain migrate embeddings --to ${configuredModel} --dim ${configuredDims}`;

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
      // Doctor is itself the provider-health circuit breaker. A permanent
      // billing/auth failure must be sampled once, not multiplied by the AI
      // SDK's default retries (which can add ~90s to every health check).
      const vec = await embedOne('gbrain doctor embedding smoke test', { maxRetries: 0 });
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
          if (!hnswIndexExpected(entry.type, entry.dimensions)) {
            okColumns.push(
              `${colName} (exact scan: ${entry.type}(${entry.dimensions}) exceeds HNSW cap ${hnswMaxDimsForType(entry.type)})`,
            );
            continue;
          }
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
          // NOTE: there is NO per-column embed flag (write-side custom-column
          // support is a filed follow-up) — the old hint prescribed one.
          coverageWarn =
            `Active column '${activeCol}' is ${pct.toFixed(1)}% populated. ` +
            `Search quality silently degraded on un-embedded chunks. ` +
            `Fix: gbrain config set search_embedding_column embedding (read the default column), ` +
            `then gbrain embed --stale; per-column write-side backfill is a filed follow-up (TODOS.md)`;
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

  // Surface the migration state marker (previously write-only): a live
  // marker = mid-migration brain, with the exact resume + status commands.
  checks.push(await checkEmbeddingMigrationState(engine));

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
      // deleted_at IS NULL: a brain whose only entity pages are soft-deleted has
      // zero LIVE entities, and must take the short-circuit below rather than
      // warn about coverage on pages the rest of the system treats as gone.
      // buildGazetteer (src/core/by-mention.ts) already filters this way, so
      // without it the two disagree about whether entity pages exist at all.
      // #4280: quarantined shells are excluded too — parity with onboard's
      // VISIBLE_ENTITY_PREDICATE, which never counted them.
      `SELECT COUNT(*)::int AS count FROM pages WHERE deleted_at IS NULL AND type IN ('entity', 'person', 'company', 'organization') AND ${quarantineFilterFragment('pages')}`,
    ))[0]?.count ?? 0;

    // Compute coverage against eligible entities only — exclude test fixtures
    // (`tools/gbrain/test/*`) and template stubs (`templates/new-person`) so
    // that brains seeded only with code sources don't get spurious warnings
    // about missing link/timeline coverage on pages that are test fixtures, not
    // real knowledge entities.
    // #4191: an entity counts as CONNECTED with an inbound OR outbound link.
    // Counting outbound only (from_page_id) contradicted onboard's
    // entity_link_coverage (inbound EXISTS, target 70%): a brain of
    // inbound-only entities (meetings link TO people) read ok there and
    // warn here. Same in/out predicate + 70% target both places now.
    const eligibleStats = (await engine.executeRaw<{ entities: number; connected: number; timeline: number }>(
      `WITH eligible AS (
        SELECT id FROM pages
        WHERE deleted_at IS NULL
          AND type IN ('entity','person','company','organization')
          AND ${quarantineFilterFragment('pages')}
          AND slug NOT LIKE 'tools/gbrain/test/%'
          AND slug <> 'templates/new-person'
      )
      SELECT
        (SELECT count(*)::int FROM eligible) AS entities,
        (SELECT count(*)::int FROM eligible e
           WHERE EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = e.id)
              OR EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = e.id)) AS connected,
        (SELECT count(DISTINCT page_id)::int FROM timeline_entries WHERE page_id IN (SELECT id FROM eligible)) AS timeline`,
    ))[0] ?? { entities: entityCount, connected: 0, timeline: 0 };

    const eligibleEntityCount = Number(eligibleStats.entities ?? entityCount);
    const linkCoverage = eligibleEntityCount > 0 ? Number(eligibleStats.connected ?? 0) / eligibleEntityCount : 0;
    const timelineCoverage = eligibleEntityCount > 0 ? Number(eligibleStats.timeline ?? 0) / eligibleEntityCount : 0;
    const linkPct = (linkCoverage * 100).toFixed(0);
    const timelinePct = (timelineCoverage * 100).toFixed(0);
    if (entityCount === 0) {
      // Markdown-only / journal / wiki brain — no entity pages to compute
      // coverage against. Coverage formula is structurally inapplicable.
      checks.push({
        name: 'graph_coverage',
        status: 'ok',
        message: 'No entity pages — graph_coverage not applicable (markdown-only brain)',
      });
    } else if (eligibleEntityCount === 0) {
      checks.push({
        name: 'graph_coverage',
        status: 'ok',
        message: `Only code/test fixture entity pages found (${entityCount}); graph_coverage not applicable`,
      });
    } else if (linkCoverage >= 0.7 && timelineCoverage >= 0.5) {
      checks.push({ name: 'graph_coverage', status: 'ok', message: `Entity connected coverage (in/out) ${linkPct}%, entity timeline coverage ${timelinePct}%` });
    } else {
      checks.push({
        name: 'graph_coverage',
        status: 'warn',
        message: `Entity connected coverage (in/out) ${linkPct}% (target 70%), entity timeline coverage ${timelinePct}% (${eligibleEntityCount} entity pages). Run: gbrain extract all`,
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
        `timeline density (all pages) ${health.timeline_coverage_score}/15`,
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

  // 9b. v0.41.18.0 — orphan_ratio check (migration #1 of #1409).
  //
  // Surfaces the fraction of linkable pages with no inbound links.
  // Consumes the same canonical getOrphansData() pure fn as
  // `gbrain orphans --count` (D1), so the two surfaces cannot disagree.
  //
  // Skip when entity count < 100 (vacuous — small brains naturally
  // show high orphan ratio; not actionable signal).
  // Warn at >0.5; fail at >0.8. Both states recommend
  // `gbrain extract links --by-mention` as the fix.
  // v0.41.29.0: explicit `--source <id>` scopes this check to one source
  // (orphanRatioSourceId, parsed at the top of buildChecks). The entity-count
  // gate + getOrphansData both scope to it; messages name the source. Bare
  // doctor (no --source) stays brain-wide.
  progress.heartbeat('orphan_ratio');
  try {
    const { getOrphansData } = await import('./orphans.ts');
    const srcId = orphanRatioSourceId;
    const inSource = srcId ? ` in source '${srcId}'` : '';
    const entityCount = (await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type IN ('entity', 'person', 'company', 'organization') AND deleted_at IS NULL${srcId ? ' AND source_id = $1' : ''}`,
      srcId ? [srcId] : [],
    ))[0]?.count ?? 0;
    // Brain-wide (no --source): <100 entities is vacuous — small brains
    // naturally show a high orphan ratio; not actionable signal. Skip.
    if (entityCount < 100 && !srcId) {
      checks.push({
        name: 'orphan_ratio',
        status: 'ok',
        message: `Vacuous: ${entityCount} entity pages (<100). Orphan ratio not meaningful at this scale.`,
      });
    } else {
      // F7 (Codex): under EXPLICIT --source, an operator deliberately asked
      // about one source — answer it even below 100 entities, with a
      // low-scale caveat, instead of swallowing a real per-source failure
      // (e.g. 80 fully-orphaned entity pages) behind a vacuous "ok".
      const data = await getOrphansData(engine, { includePseudo: false, sourceId: srcId });
      const ratio = data.total_linkable > 0 ? data.total_orphans / data.total_linkable : 0;
      const pct = (ratio * 100).toFixed(0);
      const caveat =
        entityCount < 100
          ? ` — low scale (${entityCount} entity pages <100), interpret with caution`
          : '';
      const hint =
        'Run: gbrain extract links --by-mention   (auto-links entity mentions in body text). ' +
        'Run gbrain orphans for the list.';
      if (ratio > 0.8) {
        checks.push({
          name: 'orphan_ratio',
          status: 'fail',
          message: `Orphan ratio ${pct}%${inSource} (${data.total_orphans}/${data.total_linkable} linkable pages have no inbound links)${caveat}. ${hint}`,
        });
      } else if (ratio > 0.5) {
        checks.push({
          name: 'orphan_ratio',
          status: 'warn',
          message: `Orphan ratio ${pct}%${inSource} (${data.total_orphans}/${data.total_linkable} linkable pages have no inbound links)${caveat}. ${hint}`,
        });
      } else {
        checks.push({
          name: 'orphan_ratio',
          status: 'ok',
          message: `Orphan ratio ${pct}%${inSource} (${data.total_orphans}/${data.total_linkable} linkable pages)${caveat}`,
        });
      }
    }
  } catch {
    checks.push({ name: 'orphan_ratio', status: 'warn', message: 'Could not check orphan ratio' });
  }

  // 9c. stale_mentions (#3674, lands PR #3711) — read-only drift surface for
  // by-mention links the current gazetteer no longer produces. Logic lives in
  // doctor/checks/stale-mentions.ts (module-dir rule); it never throws.
  progress.heartbeat('stale_mentions');
  const staleMentionsHb = startHeartbeat(progress, 're-deriving by-mention links…');
  try {
    const { staleMentionsCheck } = await import('./doctor/checks/stale-mentions.ts');
    checks.push(await staleMentionsCheck(engine));
  } finally {
    staleMentionsHb();
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
  checks.push(await jsonbIntegrityCheck(engine, progress));

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

  // 10d. Raw-source persistence guarantee (#1978, warn-only v1).
  // Every synthesized/derived page must carry a raw trace or an explicit
  // exemption. Warn-only in v1 — surfaces violations, blocks nothing.
  progress.heartbeat('raw_provenance');
  checks.push(await rawProvenanceCheck(engine));

  // #2829: detect sources whose jsonb `config` was re-wrapped into a string
  // scalar (grows a layer per read→write cycle). Non-object configs break
  // federation + ACL reads; surface them with the repair path.
  progress.heartbeat('source_config_shape');
  checks.push(await checkSourceConfigShape(engine));

  // v0.33: whoknows_health — fixture presence + row count. The eval
  // gate itself runs via `gbrain eval whoknows`; this check is the
  // "did you do the assignment?" signal.
  // SKILL group — gated behind --scope=all (v0.41.19.0).
  if (scope === 'all') {
    progress.heartbeat('whoknows_health');
    checks.push(await whoknowsHealthCheck(engine));
  }

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
    // #1871: engine.executeRaw (NOT db.getConnection() — that's the postgres
    // singleton, dead on the default PGLite engine; this check silently
    // reported "Skipped" on every PGLite brain).
    const rows = await engine.executeRaw<{ slug: string; body_len: number; raw_len: number }>(
      `SELECT p.slug,
              length(p.compiled_truth) AS body_len,
              length(rd.data ->> 'content') AS raw_len
       FROM pages p
       JOIN raw_data rd ON rd.page_id = p.id
       WHERE rd.data ? 'content'
         AND length(rd.data ->> 'content') > 1000
         AND length(p.compiled_truth) < length(rd.data ->> 'content') * 0.3
         AND (rd.data ->> 'content') ~ '(^|\n)##+ '
       LIMIT 100`,
    );
    if (rows.length === 0) {
      checks.push({ name: 'markdown_body_completeness', status: 'ok', message: 'No truncated bodies detected' });
    } else {
      const sample = rows.slice(0, 3).map((r) => r.slug).join(', ');
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
  //   Excludes frontmatter.embed_skip pages via the canonical
  //   EMBED_SKIP_FILTER_FRAGMENT (src/core/embed-skip.ts) — key existence,
  //   not a boolean value comparison, matching every other embed-skip
  //   consumer in the codebase. The warn message itself says "existing
  //   oversized pages can be ... accepted as non-embeddable" (i.e.
  //   embed_skip set), so a page that already took that accepted
  //   remediation must not still count against this check — otherwise the
  //   warning can never clear for a page an operator already resolved the
  //   documented way (found via dogfooding: a page with embed_skip set
  //   kept re-appearing in this check's output every run).
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
    // Read effective bytes_block from the cached effectiveCfg loaded
    // earlier in this doctor run if available; otherwise default.
    // (We re-read here per-check to avoid threading config through
    // every check — bytes_block is read once per doctor run via
    // loadConfig which caches in module-level config layer.)
    const { loadConfig: _loadCfg } = await import('../core/config.ts');
    const _cfg = _loadCfg();
    const bytesBlock = _cfg?.content_sanity?.bytes_block ?? 500_000;
    // #1871: engine.executeRaw, not the dead-on-PGLite postgres singleton.
    const rows = await engine.executeRaw<{ slug: string; source_id: string; bytes: number }>(
      `SELECT p.slug, p.source_id,
              octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) AS bytes
       FROM pages p
       WHERE p.deleted_at IS NULL
         AND ${EMBED_SKIP_FILTER_FRAGMENT}
         AND (octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, ''))) > $1
       ORDER BY bytes DESC
       LIMIT 100`,
      [bytesBlock],
    );
    if (rows.length === 0) {
      checks.push({
        name: 'oversized_pages',
        status: 'ok',
        message: `No pages exceed ${bytesBlock} bytes (excluding embed_skip pages, which already took the accepted non-embeddable remediation)`,
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
    const { assessContentSanity } = await import('../core/content-sanity.ts');
    const { loadOperatorLiterals } = await import('../core/content-sanity-literals.ts');
    const literals = loadOperatorLiterals();
    const scanLimit = fullContentAudit ? null : 1000;
    // #1871: engine.executeRaw, not the dead-on-PGLite postgres singleton.
    const rows = scanLimit
      ? await engine.executeRaw(
          `SELECT p.slug, p.source_id, p.title,
                  LEFT(p.compiled_truth, 2048) AS body_head,
                  LEFT(COALESCE(p.timeline, ''), 1024) AS tl_head,
                  p.frontmatter
             FROM pages p
            WHERE p.deleted_at IS NULL
            ORDER BY p.updated_at DESC
            LIMIT $1`,
          [scanLimit],
        )
      : await engine.executeRaw(
          `SELECT p.slug, p.source_id, p.title,
                  LEFT(p.compiled_truth, 2048) AS body_head,
                  LEFT(COALESCE(p.timeline, ''), 1024) AS tl_head,
                  p.frontmatter
             FROM pages p
            WHERE p.deleted_at IS NULL`,
        );
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
      // Audit events are evidence, not automatically breakage. A large code
      // source can legitimately emit many WARN events (oversize/markup-heavy)
      // while remaining searchable and intentionally flagged. Fail on hard
      // dispositions (content actually blocked or hidden); warn on soft
      // dispositions or volume. This keeps doctor from treating expected
      // code-corpus telemetry as an unhealthy brain.
      //
      // v0.42 renamed the hard path: a rejected page emits `reject` and a
      // quarantined (hidden) junk page emits `quarantine`; `hard_block` is now
      // only the pre-v0.42 legacy alias. Counting `hard_block` alone let fresh
      // junk-ingest evidence (`reject`/`quarantine`) clear as `ok` whenever
      // fewer than 10 events landed. `flag` is a warn disposition (still
      // searchable, agent warned on retrieval), so it joins `soft_block`.
      const hardBlocked =
        summary.by_type.hard_block + summary.by_type.reject + summary.by_type.quarantine;
      const softBlocked = summary.by_type.soft_block + summary.by_type.flag;
      const status: 'ok' | 'warn' | 'fail' =
        hardBlocked > 0 ? 'fail' :
          (softBlocked > 0 || events.length >= 10) ? 'warn' : 'ok';
      checks.push({
        name: 'content_sanity_audit_recent',
        status,
        message: `${events.length} events (hard=${hardBlocked} [hard_block=${summary.by_type.hard_block} reject=${summary.by_type.reject} quarantine=${summary.by_type.quarantine}] soft=${softBlocked} [soft_block=${summary.by_type.soft_block} flag=${summary.by_type.flag}] warn=${summary.by_type.warn})${topPatterns ? ', patterns: ' + topPatterns : ''}${topSources ? ', sources: ' + topSources : ''}. (Local audit only — multi-host operators set GBRAIN_AUDIT_DIR.)`,
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

  // v0.42 (#1699) content-quality gate: quarantined (hidden junk) +
  // flagged (warned, still searchable) page counts. Both are simple
  // JSONB key-existence scans (cheap; the marked subset stays small).
  progress.heartbeat('quarantined_pages');
  try {
    // engine.executeRaw (NOT db.getConnection() — that's the postgres singleton,
    // dead on the default PGLite engine). The JSONB `?` existence operator is
    // literal SQL through executeRaw on both engines.
    const rows = await engine.executeRaw<{ n: string | number }>(
      `SELECT COUNT(*)::int AS n FROM pages p WHERE p.deleted_at IS NULL AND p.frontmatter ? 'quarantine'`,
    );
    const n = Number(rows[0]?.n ?? 0);
    checks.push({
      name: 'quarantined_pages',
      status: n > 0 ? 'warn' : 'ok',
      message: n > 0
        ? `${n} page(s) quarantined as junk (hidden from search). Review with 'gbrain quarantine list'; clear a false positive with 'gbrain quarantine clear <slug>'.`
        : 'No quarantined pages',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: 'quarantined_pages', status: 'ok', message: `Skipped (${msg})` });
  }

  progress.heartbeat('flagged_pages');
  try {
    const rows = await engine.executeRaw<{ n: string | number }>(
      `SELECT COUNT(*)::int AS n FROM pages p WHERE p.deleted_at IS NULL AND p.frontmatter ? 'content_flag'`,
    );
    const n = Number(rows[0]?.n ?? 0);
    // Flagged pages are "examine me", not "broken" — warn so they're visible
    // but the message is non-alarming.
    checks.push({
      name: 'flagged_pages',
      status: n > 0 ? 'warn' : 'ok',
      message: n > 0
        ? `${n} page(s) flagged (markup-heavy or oversize) — still searchable, agent warned on retrieval. Review with 'gbrain quarantine list --include-flagged'.`
        : 'No flagged pages',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: 'flagged_pages', status: 'ok', message: `Skipped (${msg})` });
  }

  // issue #160: extraction quarantine lane review nudge.
  progress.heartbeat('unverified_extractions');
  checks.push(await checkUnverifiedExtractions(engine, { sourceId: orphanRatioSourceId }));

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
        // #3889: warn (not ok) when the latest run judged zero pairs but
        // errored — "0 contradictions" from an all-error run is a lie.
        checks.push({ name: 'contradictions', ...zeroTotalContradictionsCheck(latest) });
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
      // Zero failure rows is only "healthy" when extraction is actually
      // configured. Keyless installs deliberately write NO absorb rows (the
      // calm expected state) — reporting "ok: no failures" there would read
      // as extraction-healthy while extraction never runs. Doctor HOLDS the
      // engine, so probe the ACTUAL resolved extraction model (sees DB-plane
      // facts.extraction_model / models.* overrides the engine-blind
      // detectCapabilities() cannot) — the same gate the runtime uses.
      const { getFactsExtractionModel } = await import('../core/facts/extract.ts');
      const { isAvailable } = await import('../core/ai/gateway.ts');
      const extractionAvailable = isAvailable('chat', await getFactsExtractionModel(engine));
      if (!extractionAvailable) {
        // Keyless vs keyed-but-misrouted split (same classification the
        // backstop uses): a quiet keyed brain whose pinned extraction model
        // lost its key must NOT read as calm "(keyless)" — that masks a
        // fixable misconfiguration.
        const { KEYLESS_EXTRACTION_GUIDANCE, classifyUnavailable } = await import('../core/facts/backstop.ts');
        const { getFactsExtractionModel } = await import('../core/facts/extract.ts');
        const unavailableModel = await getFactsExtractionModel(engine);
        if ((await classifyUnavailable(unavailableModel)) === 'keyed') {
          checks.push({
            name: 'facts_extraction_health',
            status: 'warn',
            message:
              `Automatic fact extraction is misconfigured: resolved model ${unavailableModel} has no usable ` +
              `provider key. Fix: set the provider's API key, or \`gbrain config set facts.extraction_model <provider:model>\`.`,
          });
        } else {
          checks.push({
            name: 'facts_extraction_health',
            status: 'ok',
            message: `Automatic fact extraction not configured (keyless) — ${KEYLESS_EXTRACTION_GUIDANCE}`,
          });
        }
      } else {
        checks.push({
          name: 'facts_extraction_health',
          status: 'ok',
          message: 'No facts:absorb failures in the last 24h.',
        });
      }
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
  // date and pre-1990 scans cheap. The "fell back despite parseable date"
  // arm can't be a pure SQL COUNT(*) — JSONB `?` only proves a key exists,
  // not that its value parses — so it fetches the candidate rows and
  // re-runs computeEffectiveDate() in JS (same function `gbrain
  // reindex-frontmatter` uses) to confirm a real date was missed.
  progress.heartbeat('effective_date_health');
  try {
    const result = await engine.executeRaw<{ kind: string; count: string }>(
      `WITH sample AS (
         SELECT effective_date
           FROM pages
          ORDER BY id DESC
          LIMIT 1000
       )
       SELECT 'future_dated' AS kind, COUNT(*)::text AS count FROM sample
        WHERE effective_date IS NOT NULL AND effective_date > NOW() + INTERVAL '1 year'
       UNION ALL
       SELECT 'pre_1990', COUNT(*)::text FROM sample
        WHERE effective_date IS NOT NULL AND effective_date < TIMESTAMPTZ '1990-01-01'`,
    );
    const counts = new Map(result.map(r => [r.kind, Number(r.count)]));
    const future = counts.get('future_dated') ?? 0;
    const pre1990 = counts.get('pre_1990') ?? 0;

    // `frontmatter ? 'date'` (JSONB key-existence) only proves the key is
    // present — an empty string, null, or unparseable value still passes
    // it, so a naive COUNT(*) on that predicate over-reports "fell back
    // despite a parseable date". Fetch the candidate rows instead and run
    // them through the SAME parse/range rules `gbrain reindex-frontmatter`
    // uses (computeEffectiveDate) to confirm the frontmatter value itself
    // is parseable. This is a ONE-DIRECTIONAL guarantee, not equivalence:
    // every row counted here is a row reindex-frontmatter's dry run would
    // also flag, but reindex-frontmatter's dry run additionally flags rows
    // this arm intentionally excludes (filename-derived dates only, no
    // parseable frontmatter — that's a different message). Two queries
    // against the "last 1000 pages" window means this and the counts above
    // can drift by a row or two under concurrent writes — acceptable for a
    // sampled health check that already says "sample of last 1000 pages"
    // in its message.
    const candidates = await engine.executeRaw<{
      slug: string;
      frontmatter: unknown;
      created_at: string;
      updated_at: string;
    }>(
      `WITH sample AS (
         SELECT slug, frontmatter, effective_date_source, created_at, updated_at
           FROM pages
          ORDER BY id DESC
          LIMIT 1000
       )
       SELECT slug, frontmatter, created_at, updated_at
         FROM sample
        WHERE effective_date_source = 'fallback'
          AND (frontmatter ? 'event_date' OR frontmatter ? 'date' OR frontmatter ? 'published')`,
    );
    let fallbackWithFm = 0;
    for (const row of candidates) {
      // filename: null — this arm asks "does the frontmatter ALONE have a
      // parseable date", independent of whichever source wins the full
      // precedence chain. Passing the row's real filename would let a
      // daily/meetings-prefixed slug's filename-first precedence (see
      // effective-date.ts) resolve to source='filename' whenever the slug
      // also carries a YYYY-MM-DD prefix — silently hiding a genuinely
      // parseable frontmatter date (Codex review: reproduced with
      // `daily/2024-03-15-standup` + `{ date: '2024-04-01' }`, which
      // reindex-frontmatter WOULD still act on). filename=null makes
      // computeEffectiveDate fall straight through to the frontmatter
      // fields regardless of slug prefix.
      const recomputed = computeEffectiveDate({
        slug: row.slug,
        frontmatter: parseFrontmatter(row.frontmatter),
        filename: null,
        updatedAt: new Date(row.updated_at),
        createdAt: new Date(row.created_at),
      });
      if (recomputed.source === 'event_date' || recomputed.source === 'date' || recomputed.source === 'published') {
        fallbackWithFm++;
      }
    }

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

  progress.heartbeat('queue_health');
  const queueHealthHb = startHeartbeat(progress, 'scanning queue health…');
  try {
    checks.push(await computeQueueHealthCheck(engine));
  } finally {
    queueHealthHb();
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
      const rows = await engine.executeRaw<{ storage_path: string; source_local_path: string | null }>(
        `SELECT f.storage_path, s.local_path AS source_local_path FROM files f LEFT JOIN sources s ON s.id = COALESCE(f.source_id, 'default') WHERE f.mime_type LIKE 'image/%' LIMIT 1000`
      );
      let vanished = 0;
      let foreign = 0;
      const vanishedPaths: string[] = [];
      const fs = await import('node:fs');
      const { resolveImageAssetPath } = await import('./doctor-asset-paths.ts');
      // storage_path is repo-relative for sync-ingested assets. Prefer the
      // owning source's root; sync.repo_path is only a legacy fallback.
      const repoRoot = (await engine.getConfig('sync.repo_path')) ?? process.cwd();
      for (const r of rows) {
        // #1835: Windows drive paths (D:/…) translate to the WSL automount
        // (/mnt/d/…) under WSL, and are SKIPPED (not "missing") on hosts
        // where they cannot exist (macOS / plain Linux) — never joined onto
        // repoRoot, which produced a false "restore from git" WARN.
        const resolved = resolveImageAssetPath(r.storage_path, r.source_local_path, repoRoot);
        if (resolved.abs === null) {
          foreign++;
          continue;
        }
        try {
          fs.statSync(resolved.abs);
        } catch {
          vanished++;
          if (vanishedPaths.length < 5) vanishedPaths.push(r.storage_path);
        }
      }
      const checked = rows.length - foreign;
      const foreignNote = foreign > 0
        ? ` (${foreign} Windows-drive path(s) skipped — not resolvable on this platform)`
        : '';
      if (rows.length === 0) {
        checks.push({ name: 'image_assets', status: 'ok', message: 'No image assets indexed yet' });
      } else if (vanished === 0) {
        checks.push({ name: 'image_assets', status: 'ok', message: `${checked} image(s) all present on disk${foreignNote}` });
      } else {
        checks.push({
          name: 'image_assets',
          status: 'warn',
          message: `${vanished} of ${checked} image(s) missing from disk (e.g. ${vanishedPaths.join(', ')})${foreignNote}. ` +
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
      // #3973: images skipped by the per-run OCR budget cap (maybeOcr).
      const skippedBudget = parseInt((await engine.getConfig('ocr_skipped_budget')) ?? '0', 10);
      if (attempted === 0 && skippedBudget === 0) {
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
      } else if (skippedBudget > 0) {
        checks.push({
          name: 'ocr_health',
          status: 'warn',
          message: `OCR budget cap skipped ${skippedBudget} image(s) (${succeeded}/${attempted} attempted calls succeeded). ` +
                   `Fix: raise embedding_image_ocr_max_images / embedding_image_ocr_max_usd and re-import, or ignore if the cap is intentional.`,
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
    // v0.41.27.0 D4: local CLI path is trusted to walk DB-supplied
    // local_path values via subprocess (we own the brain repo). Pass
    // localOnly:true so the git short-circuit fires. The HTTP MCP path
    // at doctorReportRemote (around line 662) deliberately keeps the
    // default (false) — that's the trust-boundary preservation Codex
    // P0-1 flagged.
    checks.push(await checkSyncFreshness(engine, { localOnly: true }));
    // Monthly backup-coverage check (same D4 trust stance as sync_freshness:
    // localOnly:true probes git; the remote path stays a cache-only reader).
    progress.heartbeat('backup_coverage');
    {
      const { checkBackupCoverage } = await import('./doctor/checks/backup-coverage.ts');
      checks.push(await checkBackupCoverage(engine, { localOnly: true }));
    }
    // v0.41.19.0 (Issue 5): sync --all consolidation nudge.
    progress.heartbeat('sync_consolidation');
    checks.push(await checkSyncConsolidation(engine));
    // v0.42.7 (#1696): link-extraction lag. --source scopes it (explicit-only
    // parse, like orphan_ratio); bare doctor stays brain-wide. Fix: extract --stale.
    progress.heartbeat('links_extraction_lag');
    checks.push(await checkLinksExtractionLag(engine, { sourceId: orphanRatioSourceId }));
    // v0.38 — full-cycle freshness, sibling to sync_freshness. Reads
    // last_full_cycle_at from sources.config; mirrors what autopilot's
    // per-source dispatch gate sees.
    progress.heartbeat('cycle_freshness');
    checks.push(await checkCycleFreshness(engine));
    // Silent-failure batch (#2250 / #2784 / #2788): wrong-root import
    // duplicates, undeclared DB-only pages, collector-output-in-db_only.
    progress.heartbeat('content_hash_duplicates');
    checks.push(await checkContentHashDuplicates(engine));
    // #3970: code-page chunks missing symbol metadata (unhealable without
    // reindex-code --force — the content_hash short-circuit skips them).
    progress.heartbeat('code_chunk_metadata');
    checks.push(await checkCodeChunkMetadata(engine));
    progress.heartbeat('undeclared_db_only_pages');
    checks.push(await checkUndeclaredDbOnlyPages(engine));
    progress.heartbeat('db_only_collector_collision');
    checks.push(await checkDbOnlyCollectorCollision(engine));
  }

  // v0.32.3 search-lite — mode + eval_drift surfaces. Status stays 'ok' per
  // [CDX-20]; hint lives in `message`.
  if (engine !== null) {
    progress.heartbeat('chat_fallback_chain_inert');
    const inertFallbackChain = await checkChatFallbackChainInert(engine);
    if (inertFallbackChain) checks.push(inertFallbackChain);
    progress.heartbeat('search_mode');
    checks.push(await checkSearchMode(engine));
    // issue #1777 — hidden_by_search_policy: chunked pages withheld from default
    // search by the hard-exclude prefix policy (audit the surviving excludes).
    progress.heartbeat('hidden_by_search_policy');
    checks.push(await checkHiddenBySearchPolicy(engine));
    progress.heartbeat('eval_drift');
    checks.push(await checkEvalDrift(engine));
    // v0.35.0.0+ reranker_health — read JSONL audit; warn on auth or volume.
    progress.heartbeat('reranker_health');
    checks.push(await checkRerankerHealth(engine));
    // v0.41.18.0 batch_retry_health — Supavisor circuit-breaker incident
    // surfacing via the batch-retry audit JSONL. Codex H-9 thresholds.
    progress.heartbeat('batch_retry_health');
    checks.push(await checkBatchRetryHealth(engine));
    // issue #1801 wedged_queue — alive-but-wedged worker (claimable work
    // waiting, zero live-lock active, stale completions) as a health error.
    progress.heartbeat('wedged_queue');
    checks.push(await computeWedgedQueueCheck(engine));
    progress.heartbeat('orphaned_private_queue');
    checks.push(await computeOrphanedPrivateQueueCheck(engine));
    // #2194 fix #5 — autopilot fan-out vs worker concurrency mismatch.
    progress.heartbeat('autopilot_fanout_concurrency');
    checks.push(await computeAutopilotFanoutConcurrencyCheck(engine));
    // v0.47 google connector: credential-vault health incl. the day-6
    // Testing-mode expiry warning (zero-network; live probes live in
    // `gbrain google status`).
    progress.heartbeat('google_oauth');
    {
      const { computeGoogleOauthCheck } = await import('./doctor/checks/google-oauth.ts');
      checks.push(await computeGoogleOauthCheck());
    }
    // v0.40.4 graph_signals_coverage — global inbound-link density when
    // graph_signals is enabled in the active mode bundle.
    progress.heartbeat('graph_signals_coverage');
    checks.push(await checkGraphSignalsCoverage(engine));
    // #4222 junk_entity_hubs — near-empty entity pages that accreted huge
    // edge counts (generic-token names like "Will"). Warn + list only.
    progress.heartbeat('junk_entity_hubs');
    checks.push(await checkJunkEntityHubs(engine));
    // v0.37.0 brainstorm_health — migration v79, track_retrieval, calibration cold-start.
    progress.heartbeat('brainstorm_health');
    checks.push(await checkBrainstormHealth(engine));
    // issue #972 link_resolution_opportunity — full scan: count bare wikilinks
    // that would resolve under global_basename mode. Surfaces a paste-ready
    // enable hint when ≥5 hits AND ≥20% of bare wikilinks would resolve.
    // Skipped silently when the flag is already enabled. Bounded by a 60s
    // budget so a huge brain never wedges doctor on this check.
    progress.heartbeat('link_resolution_opportunity');
    checks.push(await checkLinkResolutionOpportunity(engine, progress));
    // v0.36.0.0 (A5): ZE embedding key health + schema/config width consistency.
    progress.heartbeat('ze_embedding_health');
    checks.push(await checkZeEmbeddingHealth(engine));
    // provider_sunset — brain pinned to a provider with an announced
    // hosted-API shutdown; paste-ready migration hint with the actual
    // column width. Warn before the date, fail after.
    progress.heartbeat('provider_sunset');
    checks.push(await checkProviderSunset(engine));
    progress.heartbeat('embedding_width_consistency');
    checks.push(await checkEmbeddingWidthConsistency(engine));
    // v0.41.15.0 (T6, codex #19/#20) — facts.embedding column drift
    // parity check. Same drift class as content_chunks, separate column.
    progress.heartbeat('facts_embedding_width_consistency');
    checks.push(await checkFactsEmbeddingWidthConsistency(engine));

    // v0.37.7.0 doctor checks (#1167, #1166, #1226) — fast-mode skipped
    // since these touch DB queries with cost on large brains.
    // 5K — source_routing_health (D5 lock: 200-page total cap)
    progress.heartbeat('source_routing_health');
    checks.push(await checkSourceRoutingHealth(engine));
    // 5L — oauth_confidential_client_health (success-path probe per codex CF8)
    progress.heartbeat('oauth_confidential_client_health');
    checks.push(await checkOauthConfidentialHealth(engine));
    // oauth_client_scope_health — dangling federated grants + orphaned empty workspace sources
    progress.heartbeat('oauth_client_scope_health');
    checks.push(await checkOauthClientScopeHealth(engine));
    // 5M — autopilot_lock_scope (PID-safe hint per codex CF11)
    progress.heartbeat('autopilot_lock_scope');
    checks.push(checkAutopilotLockScope());
    // v0.41.6.0 D3 — stale_locks (gbrain_cycle_locks rows with ttl_expires_at < NOW())
    progress.heartbeat('stale_locks');
    checks.push(await checkStaleLocks(engine, { fix: doFix, dryRun }));
    // v0.38 — cycle_phase_scope (informational; no DB cost)
    progress.heartbeat('cycle_phase_scope');
    checks.push(checkCyclePhaseScope());

    // v0.41.18.0 (A16, T4): 4 onboard checks — each emits a Check + its
    // own RemediationStep[] aggregated by onboard's plan path. The
    // checks themselves are cheap counts (backed by content_chunks_stale_idx
    // for embed_staleness, TABLESAMPLE on PG >50K for the coverage pair).
    progress.heartbeat('onboard_checks');
    const { runAllOnboardChecks } = await import('../core/onboard/checks.ts');
    const onboardResults = await runAllOnboardChecks(engine);
    for (const r of onboardResults) checks.push(r.check);
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
    console.log(JSON.stringify(report));
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
      console.log(`  [${icon}] ${issue.name}${dn} → ${issue.fix}`);
    }
    if (topIssues.length > shown.length) {
      console.log(`  +${topIssues.length - shown.length} more — see full list below`);
    }
    console.log('');
  }

  for (const c of report.checks) {
    const icon = c.status === 'ok' ? 'OK' : c.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(`  [${icon}] ${c.name}: ${c.message}`);
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
  console.log(`Brain checks:  ${report.brain_checks_score}/100  (category penalty)`);
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
 * CLI wrapper around computeRemediationPlan (src/core/remediation/plan.ts).
 *
 * v0.41.18.0 (A1, codex finding #2): library extracted so onboard +
 * MCP run_onboard can compose against a stable shape. This wrapper
 * stays as the CLI surface only — argv parsing + human render. JSON
 * mode emits the library's stable envelope verbatim.
 *
 * Read-only — never enqueues, never mutates.
 */
export async function runRemediationPlan(
  engine: BrainEngine,
  args: string[],
): Promise<void> {
  const { computeRemediationPlan } = await import('../core/remediation/index.ts');

  const targetScore = parseIntFlag(args, '--target-score') ?? 90;
  const jsonOutput = args.includes('--json');

  const plan = await computeRemediationPlan(engine, { targetScore });

  if (jsonOutput) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  for (const line of renderRemediationPlanLines(plan, targetScore)) {
    console.log(line);
  }
}

/**
 * Human-render the remediation plan into a sequence of console lines.
 * Exported for unit-test access — `runRemediationPlan` consumes it
 * verbatim and only adds the JSON-mode short-circuit.
 *
 * Gating the "at target" line on `brain_score_current >= targetScore`
 * is load-bearing: when the plan is empty AND the target is unreachable,
 * the prior shape printed both "Target unreachable: …" and "Brain is at
 * target" back-to-back, which contradicted itself and hid the real next
 * step (manual prereq config to lift `max_reachable_score`).
 */
export function renderRemediationPlanLines(
  plan: RemediationPlanShape,
  targetScore: number,
): string[] {
  const lines: string[] = [];
  lines.push(`Brain score: ${plan.brain_score_current}/100 → target ${targetScore}`);
  if (plan.target_unreachable) {
    lines.push(`Target unreachable: max with autonomous remediation is ${plan.max_reachable_score}/100.`);
  }
  if (plan.plan.length === 0) {
    if (plan.brain_score_current >= targetScore) {
      lines.push('No remediations needed. Brain is at target.');
    }
    // When brain_score < targetScore and plan is empty, the unreachable
    // line (if applicable) is the user-facing explanation; the blocked-
    // checks block below surfaces the manual gap. Don't follow with a
    // misleading "at target" claim.
  } else {
    lines.push(`Plan: ${plan.plan.length} step(s), est ${plan.est_total_seconds}s, est $${plan.est_total_usd_cost.toFixed(2)}`);
    for (const step of plan.plan) {
      const protectedMark = step.protected ? ' [PROTECTED]' : '';
      const costMark = step.est_usd_cost ? ` ($${step.est_usd_cost.toFixed(2)})` : '';
      lines.push(`  ${step.step}. [${step.severity}] ${step.job}${protectedMark} — ${step.rationale}${costMark}`);
    }
  }
  if (plan.blocked.length > 0) {
    lines.push(`\nBlocked checks (prereq missing):`);
    for (const b of plan.blocked) {
      lines.push(`  - ${b.check}: ${b.reason}`);
    }
  }
  return lines;
}

interface RemediationPlanShape {
  brain_score_current: number;
  target_unreachable: boolean;
  max_reachable_score: number;
  plan: Array<{
    step: number;
    severity: string;
    job: string;
    protected?: boolean;
    est_usd_cost?: number;
    rationale: string;
  }>;
  est_total_seconds: number;
  est_total_usd_cost: number;
  blocked: Array<{ check: string; reason: string }>;
}

/**
 * CLI wrapper around runRemediation (src/core/remediation/run.ts).
 *
 * v0.41.18.0 (A1, codex finding #2): orchestrator extracted into the
 * remediation library. This wrapper stays as the CLI surface only —
 * argv parsing + interactive TTY confirmation + human/JSON render via
 * RemediationHooks.
 *
 * Default behavior: submit-and-wait per step. --dry-run skips submission.
 * --max-usd N refuses if est_total_usd_cost > N. --max-jobs N caps the
 * inner loop. --resume [plan_hash] loads checkpoint and continues.
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
  const maxUsdRaw = parseFloatFlag(args, '--max-usd') ?? parseFloatFlag(args, '--max-cost');
  const maxUsd = maxUsdRaw === null ? undefined : maxUsdRaw;
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

  const { runRemediation, computeRemediationPlan } =
    await import('../core/remediation/index.ts');

  // TTY confirmation gate (stays in CLI; library doesn't render).
  // Compute the plan once for the confirmation prompt, then hand off
  // to the library for the actual run. The library re-computes its
  // own plan internally — we accept the second computation cost for
  // a cleaner CLI/library separation.
  if (!skipConfirm && !dryRun && process.stdout.isTTY && !resumeMode) {
    const plan = await computeRemediationPlan(engine, { targetScore });
    if (plan.target_unreachable) {
      console.error(
        `[remediate] target ${targetScore} unreachable; max autonomous = ${plan.max_reachable_score}/100. ` +
        `Configure missing prereqs (see --remediation-plan blocked output) or lower --target-score.`,
      );
      process.exit(2);
    }
    if (plan.plan.length === 0) {
      console.log(`Brain at score ${plan.brain_score_current}/100, target ${targetScore}. Nothing to do.`);
      return;
    }
    if (maxUsd !== undefined && plan.est_total_usd_cost > maxUsd) {
      console.error(
        `[remediate] est cost $${plan.est_total_usd_cost.toFixed(2)} exceeds --max-usd $${maxUsd.toFixed(2)}. Aborting.`,
      );
      process.exit(2);
    }
    console.log(`About to submit ${plan.plan.length} job(s), est ${plan.est_total_seconds}s, est $${plan.est_total_usd_cost.toFixed(2)}`);
    console.log('Pass --yes to proceed (cron-friendly).');
    process.exit(1);
  }

  if (engine.kind === 'pglite') {
    console.error('[remediate] PGLite engine: running inline (no durable queue).');
  }

  const result = await runRemediation(
    engine,
    {
      targetScore,
      maxJobs,
      maxUsd,
      dryRun,
      resume: resumeMode,
      resumePlanHash,
    },
    {
      onTargetUnreachable: (target, ceiling) => {
        console.error(
          `[remediate] target ${target} unreachable; max autonomous = ${ceiling}/100. ` +
          `Configure missing prereqs (see --remediation-plan blocked output) or lower --target-score.`,
        );
      },
      onNothingToDo: (score, target) => {
        console.log(`Brain at score ${score}/100, target ${target}. Nothing to do.`);
      },
      onBudgetRefused: (estCost, cap) => {
        console.error(
          `[remediate] est cost $${estCost.toFixed(2)} exceeds --max-usd $${cap.toFixed(2)}. Aborting.`,
        );
      },
      onResumeMissed: (planHash, requested) => {
        console.error(
          `[remediate --resume] no matching checkpoint found ` +
          `(plan_hash=${planHash}${requested ? `; requested=${requested}` : ''}). ` +
          `Run without --resume to start fresh.`,
        );
      },
      onResumeLoaded: (planHash, completed, remaining) => {
        console.error(
          `[remediate --resume] resuming plan_hash=${planHash}: ${completed} step(s) completed, ${remaining} remaining.`,
        );
      },
      onBudgetExhausted: (planHash, snapshot) => {
        console.error(
          `\n[remediate] BudgetExhausted (${snapshot.reason}): spent $${snapshot.spent.toFixed(4)} > cap $${snapshot.cap.toFixed(2)}.\n` +
          `Checkpoint saved. Resume with:\n` +
          `  gbrain doctor --remediate --resume ${planHash}\n`,
        );
      },
    },
  );

  // CLI surfaces — target unreachable / resume missed already emitted via hooks.
  // Library returns synthetic result with target_unreachable populated; exit 2.
  if (result.target_unreachable) process.exit(2);

  if (dryRun && result.submitted.length > 0) {
    console.log(`[remediate --dry-run] Would submit ${result.submitted.length} jobs:`);
    for (const s of result.submitted) console.log(`  - ${s.id}`);
    return;
  }

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.submitted.length > 0) {
    console.log(`\nBrain score: ${result.brain_score_initial} → ${result.brain_score_final} (target ${targetScore})`);
    // #3626: split the count honestly — a step that deduped onto an in-flight
    // job did not submit new work; a rotated re-run did.
    const coalesced = result.submitted.filter((s) => s.coalesced).length;
    const rotated = result.submitted.filter((s) => s.deduped_job_id !== undefined).length;
    const notes = [
      ...(rotated > 0 ? [`${rotated} re-ran under a rotated key (prior terminal row held it)`] : []),
      ...(coalesced > 0 ? [`${coalesced} coalesced onto in-flight job(s)`] : []),
    ];
    console.log(
      `Submitted: ${result.submitted.length - coalesced} job(s)${notes.length > 0 ? ` (${notes.join('; ')})` : ''}, ${result.aborted_count} aborted/failed`,
    );
  }

  const anyFailed = result.submitted.some(
    (s) => s.status !== 'completed' && s.status !== 'submitted' && s.status !== 'dry_run',
  );
  if (result.budget_exhausted || anyFailed) process.exit(1);
}

// v0.41.18.0 (A1, codex finding #2): loadRecommendationContext moved to
// src/core/remediation/context.ts so onboard + MCP run_onboard compose
// the same context. The CLI surfaces (runRemediationPlan / runRemediate
// above) now call computeRemediationPlan + runRemediation from the
// library, which builds the context internally.

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
