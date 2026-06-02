/**
 * Doctor check categorization — single source of truth.
 *
 * Every `Check.name` produced by `src/commands/doctor.ts` is assigned to
 * exactly one of four categories:
 *
 *   - brain : data-integrity signals (embedding coverage, page health, sync
 *             freshness, facts/takes/calibration data quality, contradictions,
 *             content-sanity audit findings). The "is my brain's data healthy?"
 *             question lives here.
 *   - skill : RESOLVER.md / skill conformance / routing-eval / filing-audit /
 *             whoknows expert routing. The "is my agent's skill dispatcher
 *             configured?" question.
 *   - ops   : infrastructure liveness — DB connection, pgvector, RLS,
 *             supervisor, queue depth, OAuth confidential clients, autopilot
 *             lock scope, reranker/provider reachability. The "is the
 *             machinery actually running?" question.
 *   - meta  : schema version, migrations, upgrade trail, eval capture, slug
 *             fallback audit, schema-pack drift. The "is gbrain itself
 *             coherent?" question.
 *
 * Why this matters: the doctor's legacy `health_score` ( 100 − 20×fails −
 * 5×warns ) weights every check equally. A skill routing miss costs the same
 * as a corrupt embedding column. With categorization, the doctor surfaces a
 * brain_checks_score and category_scores so operators see signal-to-noise on
 * the question they're actually asking.
 *
 * Naming discipline: this module owns the *category penalty* score
 * (`brain_checks_score`), which is ORTHOGONAL to `BrainHealth.brain_score`
 * (the weighted 35/25/15/15/10 composite surfaced by the `brain_score`
 * doctor check). The two answer different questions:
 *
 *   - brain_score        : "how healthy is the brain's data composition?"
 *   - brain_checks_score : "how many brain-category doctor checks failed?"
 *
 * The doctor renders both side by side.
 *
 * Drift contract: every check name that ships in doctor.ts MUST appear in
 * exactly one set below. The drift-guard test in
 * `test/doctor-categories.test.ts` enforces this by reading doctor.ts source
 * via a tagged-string scan and asserting set membership exactly.
 *
 * If you add a new doctor check, you MUST add its name to the appropriate
 * set here. The categorize step in `src/commands/doctor.ts` falls through
 * to 'meta' for any unknown name AND emits a once-per-process stderr warn
 * so a missing addition surfaces in dev runs even before the test catches
 * it in CI.
 */

export type CheckCategory = 'brain' | 'skill' | 'ops' | 'meta';

/**
 * Data-integrity signals. Everything that asks "is the brain's actual data
 * healthy and complete?"
 */
export const BRAIN_CHECK_NAMES: ReadonlySet<string> = new Set([
  'abandoned_threads',
  'brain_score',
  'calibration_freshness',
  'child_table_orphans',
  'content_sanity_audit_recent',
  'contextual_retrieval_coverage',
  'contradictions',
  'conversation_facts_backlog',
  'conversation_format_coverage',
  'conversation_parser_probe_health',
  'cross_modal_modality_backfill',
  'cycle_freshness',
  'effective_date_health',
  'embedding_column_registry',
  'embedding_env_override',
  'embedding_provider',
  'embedding_width_consistency',
  'embeddings',
  'eval_drift',
  'extract_atoms_backlog',
  'extract_health',
  'facts_embedding_width_consistency',
  'facts_extraction_health',
  'facts_health',
  'frontmatter_integrity',
  'grade_confidence_drift',
  'graph_coverage',
  'graph_signals_coverage',
  'image_assets',
  'integrity',
  'jsonb_integrity',
  'markdown_body_completeness',
  'nightly_quality_probe_health',
  'ocr_health',
  'orphan_ratio',
  'oversized_pages',
  'salience_health',
  'scraper_junk_pages',
  'source_routing_health',
  'stub_guard_24h',
  'sync_failures',
  'sync_freshness',
  'takes_weight_grid',
  'unified_multimodal_coverage',
  'voice_gate_health',
]);

/**
 * Skill dispatcher signals. RESOLVER.md reachability, skill frontmatter
 * conformance, brain-first compliance, expert-routing, filing audit.
 *
 * Deliberately small: only checks that scan the host's `skills/` tree or
 * skill-routing fixtures. Brain-data quality checks (even ones with a
 * skill-flavored name) live under 'brain'.
 */
export const SKILL_CHECK_NAMES: ReadonlySet<string> = new Set([
  'resolver_health',
  'skill_brain_first',
  'skill_conformance',
  'whoknows_health',
]);

/**
 * Infrastructure liveness signals. DB, workers, OAuth, RLS, locks, providers.
 */
export const OPS_CHECK_NAMES: ReadonlySet<string> = new Set([
  'alternative_providers',
  'autopilot_lock_scope',
  'batch_retry_health',
  'brainstorm_health',
  'connection',
  'federation_health',
  'home_dir_in_worktree',
  'index_audit',
  'oauth_confidential_client_health',
  'orphan_clones',
  'pgbouncer_prepare',
  'pgvector',
  'progressive_batch_audit_health',
  'queue_health',
  'reranker_health',
  'rls',
  'rls_event_trigger',
  'search_mode',
  'stale_locks',
  'subagent_capability',
  'subagent_health',
  'supervisor',
  'sync_consolidation',
  'ze_embedding_health',
]);

/**
 * gbrain-itself coherence signals. Schema migrations, version drift, audit
 * housekeeping. Default category for unknown names (with stderr warn).
 */
export const META_CHECK_NAMES: ReadonlySet<string> = new Set([
  'cycle_phase_scope',
  'eval_capture',
  'minions_migration',
  'multi_source_drift',
  'schema_pack_active',
  'schema_pack_consistency',
  'schema_pack_source_drift',
  'schema_version',
  'slug_fallback_audit',
  'upgrade_errors',
]);

/**
 * Stderr warn-once gate for unknown check names. Exported as a test seam so
 * the categorizer test can re-trigger warns.
 */
const _warnedUnknown = new Set<string>();
export function _resetUnknownCheckWarningsForTest(): void {
  _warnedUnknown.clear();
}

/**
 * Map a check name to its category. Unknown names fall through to 'meta'
 * with a once-per-process stderr warning — the test in
 * `test/doctor-categories.test.ts` is the structural guard, and the warn is
 * the runtime backstop so contributors notice in dev before CI fails.
 */
export function categorizeCheck(name: string): CheckCategory {
  if (BRAIN_CHECK_NAMES.has(name)) return 'brain';
  if (SKILL_CHECK_NAMES.has(name)) return 'skill';
  if (OPS_CHECK_NAMES.has(name)) return 'ops';
  if (META_CHECK_NAMES.has(name)) return 'meta';
  if (!_warnedUnknown.has(name)) {
    _warnedUnknown.add(name);
    process.stderr.write(
      `[doctor-categories] unknown check name '${name}' — defaulting to 'meta'. Add it to src/core/doctor-categories.ts.\n`,
    );
  }
  return 'meta';
}

/**
 * Skill-category check group. Used by buildChecks's scope-branch gates to
 * SKIP the (expensive, filesystem-walking) skill check group when the caller
 * asked for scope=brain. This is the load-bearing escape hatch that makes
 * `gbrain doctor --scope=brain` sub-second on a brain with thousands of
 * skills (per D9 in the plan).
 *
 * Use this set as the source of truth for "do these checks belong to the
 * skill group that the scope-branch gate skips?" — keeping the gate
 * categorization and the per-check categorization aligned.
 */
export const SKILL_CHECK_GROUP_NAMES: ReadonlySet<string> = SKILL_CHECK_NAMES;
