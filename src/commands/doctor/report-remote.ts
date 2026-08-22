/**
 * doctorReportRemote — verbatim peel from src/commands/doctor.ts
 * (containment sprint). The remote/thin-client doctor check registry; its
 * sole external consumer is the run_doctor op, which dynamic-imports it via
 * the doctor.ts re-export.
 *
 * NOTE: '../doctor.ts' imports this module (the re-export seam), so the
 * import below is circular. This is safe: every binding pulled from
 * doctor.ts is a hoisted function declaration referenced only at call time
 * inside doctorReportRemote, never during module evaluation.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { LATEST_VERSION } from '../../core/migrate.ts';
import { loadConfig } from '../../core/config.ts';
import { loadCompletedMigrations } from '../../core/preferences.ts';
import { compareVersions } from '../migrations/index.ts';
import { resolveHoursEnv } from '../../core/env-number.ts';
import {
  type Check,
  type DoctorReport,
  computeDoctorReport,
  checkPgliteScratchProbe,
  computeQueueHealthCheck,
  computeWedgedQueueCheck,
  computeOrphanedPrivateQueueCheck,
  computeAutopilotFanoutConcurrencyCheck,
  checkSubagentHealth,
  checkBatchRetryHealth,
  checkEmbeddingEnvOverride,
  checkEmbeddingMigrationState,
  checkSubagentCapability,
  checkVolunteerChannels,
  checkSyncFreshness,
  checkSyncConsolidation,
  checkPoolBudget,
  checkLinksExtractionLag,
  checkChatFallbackChainInert,
  checkSearchMode,
  checkEvalDrift,
  checkRerankerHealth,
  checkGraphSignalsCoverage,
  checkBrainstormHealth,
  checkAbandonedThreads,
  checkCalibrationFreshness,
  checkGradeConfidenceDrift,
  checkVoiceGateHealth,
  checkContextualRetrievalCoverage,
  checkHiddenBySearchPolicy,
  checkLinkResolutionOpportunity,
  checkFederationHealth,
  checkSelfUpgradeHealth,
} from '../doctor.ts';
import {
  checkSchemaPackActive,
  checkSchemaPackConsistency,
  checkSchemaPackSourceDrift,
} from './schema-pack-checks.ts';

// Same alias the local doctor keeps for its own freshness checks; the alias
// is a private one-liner in doctor.ts's check-fn library, so this module
// carries its own copy rather than widening that surface.
const _resolveSyncFreshnessHours = resolveHoursEnv;

export async function doctorReportRemote(
  engine: BrainEngine,
  opts: { sourceIds?: string[] } = {},
): Promise<DoctorReport> {
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
    // #2674: on PGLite, a dead connection is exactly the ambiguous case the
    // scratch probe exists for — pay its cold start only on this failure path.
    // Unlike buildChecks (where the connect error was swallowed upstream), the
    // real error IS in hand here: classify it, and only let the probe assert
    // store damage on a damage-class verdict (wasm-abort/corrupt) — a lock or
    // config refusal classifies 'unknown' and gets the hedged message.
    if (engine.kind === 'pglite') {
      let realStorePath: string | undefined;
      try { realStorePath = loadConfig()?.database_path; } catch { /* no config */ }
      let storeDamageEvidence = false;
      try {
        const { classifyPgliteInitError, stringifyPgliteInitError } = await import('../../core/pglite-engine.ts');
        const verdict = classifyPgliteInitError(stringifyPgliteInitError(e));
        storeDamageEvidence = verdict === 'wasm-abort' || verdict === 'corrupt';
      } catch { /* classifier unavailable — stay hedged (fail-closed) */ }
      checks.push(await checkPgliteScratchProbe({ realInitFailed: true, storeDamageEvidence, realStorePath }));
    }
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

  // 2b. #2038: idx_timeline_dedup shape. A renumbered-during-merge migration
  // (v102) can be recorded-as-applied without its DDL running, leaving the
  // 3-column index in place — every timeline write then fails the 4-column
  // ON CONFLICT. The version counter can't see this, so check the index SHAPE.
  try {
    const { checkTimelineDedupIndex } = await import('../../core/timeline-dedup-repair.ts');
    const idx = await checkTimelineDedupIndex(engine);
    if (!idx.tablePresent || !idx.needsRepair) {
      checks.push({
        name: 'timeline_dedup_index',
        status: 'ok',
        // #3737: canonical shape keys md5(summary) so long summaries can't
        // overflow the btree row cap.
        message: idx.tablePresent ? 'idx_timeline_dedup has the md5-keyed 4-column shape' : 'no timeline_entries table yet',
      });
    } else {
      checks.push({
        name: 'timeline_dedup_index',
        status: 'fail',
        message:
          `idx_timeline_dedup is ${idx.indexPresent ? `(${idx.columns.join(', ')})` : 'absent'}, ` +
          `expected (page_id, date, md5(summary), source) — timeline writes are failing (#2038/#3737). ` +
          `Run \`gbrain apply-migrations --force-schema\` to heal it.`,
      });
    }
  } catch {
    checks.push({ name: 'timeline_dedup_index', status: 'warn', message: 'Could not check idx_timeline_dedup shape' });
  }

  // 2c. #550: pages(source_id, slug) upsert arbiter — same drift class as 2b.
  // When the arbiter is missing, EVERY putPage fails with "no unique or
  // exclusion constraint" and the version counter can't see it.
  {
    const { pagesUpsertArbiterCheck } = await import('./checks/core-health.ts');
    checks.push(await pagesUpsertArbiterCheck(engine));
  }

  // v0.42.x — Life Chronicle (#2390): orphaned event projections. Reads already
  // hide projections whose event page is soft-deleted (read-time correctness);
  // this always-run probe surfaces the cleanup backlog. Keyed off the real
  // schema (event_page_id), NOT a migration verify-hook, per
  // migration-verify-hook-never-runs-on-stamped-brains.
  try {
    const orphans = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM timeline_entries te
       JOIN pages ep ON ep.id = te.event_page_id
       WHERE te.event_page_id IS NOT NULL AND ep.deleted_at IS NOT NULL`,
    );
    const n = Number(orphans[0]?.n ?? 0);
    checks.push(
      n === 0
        ? { name: 'chronicle_projection_health', status: 'ok', message: 'No orphaned event projections' }
        : {
            name: 'chronicle_projection_health',
            status: 'warn',
            message:
              `${n} timeline projection(s) point to soft-deleted event pages ` +
              '(hidden at read time; clean up with `gbrain integrity auto`).',
          },
    );
  } catch {
    checks.push({ name: 'chronicle_projection_health', status: 'ok', message: 'no event projections yet' });
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

  // 4. Sync failures (file-plane ledger; see src/core/sync-failure-ledger.ts).
  // issue #1939: read via the shared loader + severity decision so this remote
  // surface agrees with the local buildChecks emitter by construction. Stays
  // subprocess-free (file read + Date.parse only, no git), preserving the remote
  // trust boundary. Escalates to FAIL when a stuck bookmark has blocked past the
  // sync-freshness fail cadence or unresolved count is large.
  try {
    const { loadSyncFailures, decideSyncFailureSeverity } = await import('../../core/sync.ts');
    const entries = loadSyncFailures();
    const failHours = _resolveSyncFreshnessHours('GBRAIN_SYNC_FRESHNESS_FAIL_HOURS', 72);
    const sev = decideSyncFailureSeverity({ entries, nowMs: Date.now(), failHours });
    const msg =
      sev.unresolved === 0
        ? 'No unresolved sync failures'
        : `${sev.unresolved} unresolved sync failure(s)` +
          (sev.auto_skipped > 0 ? ` (${sev.auto_skipped} auto-skipped — pages NOT indexed)` : '') +
          ` — run \`gbrain sync --skip-failed\` on the host to acknowledge`;
    checks.push({ name: 'sync_failures', status: sev.status, message: msg });
  } catch {
    checks.push({ name: 'sync_failures', status: 'ok', message: 'No failures recorded' });
  }

  // 4b. Multi-source drift (v0.31.8 — D8 + D14). Same shape as the local
  // doctor's check at the same name. Runs server-side; the result is
  // returned to the thin-client over MCP.
  try {
    const { findMisroutedPages } = await import('../../core/multi-source-drift.ts');
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
  checks.push(await computeQueueHealthCheck(engine));

  // issue #1801 — wedged_queue (cross-surface parity with buildChecks).
  checks.push(await computeWedgedQueueCheck(engine));
  checks.push(await computeOrphanedPrivateQueueCheck(engine));

  // #2194 fix #5 — warn when autopilot fan-out exceeds worker concurrency.
  checks.push(await computeAutopilotFanoutConcurrencyCheck(engine));

  // v0.41 Bug 2 / Eng D8 — subagent_health surfaces rate-lease pressure to the operator.
  checks.push(await checkSubagentHealth(engine));

  // v0.41.18.0 — batch_retry_health (cross-surface parity with buildChecks).
  // Surfaces Supavisor circuit-breaker incidents over MCP so remote operators
  // see the same signal local doctor surfaces.
  checks.push(await checkBatchRetryHealth(engine));

  // v0.41.2.1 — embedding_env_override (cross-surface parity with
  // buildChecks). Surfaces when GBRAIN_EMBEDDING_* env vars disagree
  // with DB config; closes the silent-override class that caused the
  // 716K-chunk damage incident from PR #1421's description.
  checks.push(await checkEmbeddingEnvOverride(engine));

  // Surface the migration state marker (previously write-only): a live
  // marker = mid-migration brain, with the exact resume + status commands.
  checks.push(await checkEmbeddingMigrationState(engine));

  // v0.31.12 subagent runtime enforcement (Layer 3 of 3 — Codex F13).
  // The subagent loop requires native tool-calling. If models.subagent,
  // models.tier.subagent, or models.default resolves to a limited provider, warn here
  // so the user sees it at the next `gbrain doctor` run instead of at the
  // next subagent job submission. (Layers 1+2 also enforce — this is the
  // surfacing layer.)
  checks.push(await checkSubagentCapability(engine));

  // Harness hook adapters — per-channel push-context visibility (sibling of
  // the engine-free retrieval_reflex_health heartbeat check). Source-scoped
  // for remote callers (cross-model P1): a source-bound token must not see
  // other sources' activity counts/timestamps.
  checks.push(await checkVolunteerChannels(engine, { sourceIds: opts.sourceIds }));

  // 6. Sync freshness check
  checks.push(await checkSyncFreshness(engine));

  // v0.41.19.0 (Issue 5): sync --all consolidation nudge for multi-source brains.
  checks.push(await checkSyncConsolidation(engine));

  // v0.42.x (#1794, 4A): pool-budget nudge when GBRAIN_MAX_CONNECTIONS is set.
  checks.push(await checkPoolBudget(engine));

  // v0.42.7 (#1696): link-extraction lag. Strictly SQL (single indexed COUNT),
  // safe on the thin-client/remote path — remote operators on checkout-less
  // Postgres brains are exactly who can't otherwise see the extraction backlog.
  // Brain-wide here (remote --source scoping is a separate TODO, like orphan_ratio).
  checks.push(await checkLinksExtractionLag(engine));

  // v0.39 T7 + T9 — schema-pack health checks (3 checks per v0.38 plan):
  //   schema_pack_active        — active pack resolves cleanly
  //   schema_pack_consistency   — % of pages typed against active pack
  //   schema_pack_source_drift  — per-source pack divergence
  checks.push(await checkSchemaPackActive(engine));
  checks.push(await checkSchemaPackConsistency(engine));
  checks.push(await checkSchemaPackSourceDrift(engine));

  // 7. v0.32.3 search-lite mode + per-key drift surface.
  const inertFallbackChain = await checkChatFallbackChainInert(engine);
  if (inertFallbackChain) checks.push(inertFallbackChain);
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

  // issue #1777 — hidden_by_search_policy: chunked pages withheld from default
  // search by the hard-exclude prefix policy. Pure SQL COUNT, safe on the
  // remote/thin-client path.
  checks.push(await checkHiddenBySearchPolicy(engine));

  // 11a. issue #972 link_resolution_opportunity — same check the local
  // doctor runs at the equivalent slot in buildChecks. Mirrored for
  // thin-client parity so `gbrain remote doctor` sees the same hint.
  checks.push(await checkLinkResolutionOpportunity(engine));

  // 12. v0.40.5.0 Federated Sync v2 (T12) — federation_health:
  //   - Per-source lag, embed coverage, failed-job rate.
  //   - Single-source brain short-circuits to ok.
  //   - Three-state: ok / warn / fail.
  checks.push(await checkFederationHealth(engine));

  // 13. v0.42 self_upgrade_health: mode, whether behind, recent failures.
  // File-plane only (no engine) — works on thin clients too.
  checks.push(checkSelfUpgradeHealth());

  return computeDoctorReport(checks);
}
