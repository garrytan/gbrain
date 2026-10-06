/**
 * Late signals: sync / backup / cycle freshness and the silent-failure batch, then search mode, queues, OAuth, graph signals, embedding width, routing, locks and the onboard checks.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import {
  checkHiddenBySearchPolicy,
  checkRerankerHealth,
  checkLinkResolutionOpportunity,
} from './calibration.ts';
import { checkSyncConsolidation, checkCycleFreshness } from './consolidation-cycle.ts';
import {
  checkSyncFreshness,
  checkLinksExtractionLag,
  checkContentHashDuplicates,
  checkCodeChunkMetadata,
  checkUndeclaredDbOnlyPages,
  checkDbOnlyCollectorCollision,
} from './extraction-sync.ts';
import {
  checkGraphSignalsCoverage,
  checkJunkEntityHubs,
  checkBrainstormHealth,
  checkEmbeddingWidthConsistency,
  checkFactsEmbeddingWidthConsistency,
} from './graph-embedding.ts';
import {
  checkBatchRetryHealth,
  computeWedgedQueueCheck,
  computeOrphanedPrivateQueueCheck,
  computeAutopilotFanoutConcurrencyCheck,
} from './queue-jobs.ts';
import {
  checkSourceRoutingHealth,
  checkOauthConfidentialHealth,
  checkOauthClientScopeHealth,
  checkAutopilotLockScope,
  checkStaleLocks,
  checkCyclePhaseScope,
} from './routing-federation.ts';
import { checkSearchMode, checkEvalDrift } from './search-eval.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

async function runSyncFreshness(ctx: DoctorContext): Promise<Check[]> {
  const { orphanRatioSourceId, progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

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
    const contentWrites = await (await import('./canonical-content.ts')).checkCanonicalContentWrites(engine);
    if (contentWrites) checks.push(contentWrites);
    const sharedSkills = await (await import('./shared-skills.ts')).checkSharedSkillsSources(engine);
    if (sharedSkills) checks.push(sharedSkills);
    // Monthly backup-coverage check (same D4 trust stance as sync_freshness:
    // localOnly:true probes git; the remote path stays a cache-only reader).
    progress.heartbeat('backup_coverage');
    {
      const { checkBackupCoverage } = await import('./backup-coverage.ts');
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
  return checks;
}

export const syncFreshnessEntry: DoctorEntry = {
  name: 'sync_freshness',
  emits: [
    'sync_freshness',
    'canonical_content_writes',
    'shared_skills_sources',
    'backup_coverage',
    'sync_consolidation',
    'links_extraction_lag',
    'cycle_freshness',
    'content_hash_duplicates',
    'code_chunk_metadata',
    'undeclared_db_only_pages',
    'db_only_collector_collision',
  ],
  run: runSyncFreshness,
};

async function runSearchMode(ctx: DoctorContext): Promise<Check[]> {
  const { doFix, dryRun, progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // v0.32.3 search-lite — mode + eval_drift surfaces. Status stays 'ok' per
  // [CDX-20]; hint lives in `message`.
  if (engine !== null) {
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
      const { computeGoogleOauthCheck } = await import('./google-oauth.ts');
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
    const { runAllOnboardChecks } = await import('../../../core/onboard/checks.ts');
    const onboardResults = await runAllOnboardChecks(engine);
    for (const r of onboardResults) checks.push(r.check);
  }
  return checks;
}

export const searchModeEntry: DoctorEntry = {
  name: 'search_mode',
  emits: [
    'search_mode',
    'hidden_by_search_policy',
    'eval_drift',
    'reranker_health',
    'batch_retry_health',
    'wedged_queue',
    'orphaned_private_queue',
    'autopilot_fanout_concurrency',
    'google_oauth',
    'graph_signals_coverage',
    'junk_entity_hubs',
    'brainstorm_health',
    'link_resolution_opportunity',
    'embedding_width_consistency',
    'facts_embedding_width_consistency',
    'source_routing_health',
    'oauth_confidential_client_health',
    'oauth_client_scope_health',
    'autopilot_lock_scope',
    'stale_locks',
    'cycle_phase_scope',
    'embed_staleness',
    'entity_link_coverage',
    'timeline_coverage',
    'takes_count',
    'pack_upgrade_available',
    'type_proliferation',
    'dangling_aliases',
  ],
  run: runSearchMode,
};
