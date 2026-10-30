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
 * 5×warns, over the checks that finished: #7276 ) weights every check equally. A skill routing miss costs the same
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
 * Drift contract: every check name that ships through doctor MUST appear in
 * exactly one set below. The drift-guard test in
 * `test/doctor-categories.test.ts` enforces this by reading doctor check
 * emitter sources via a tagged-string scan and asserting set membership
 * exactly.
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
  'atom_provenance_drift',
  // #7013: atoms an empty managed re-extraction retired that atoms-restore can bring back (doctor/checks/atom-retirements.ts).
  'atom_retirements_restorable',
  'captured_facts_active',
  // #7125: facts whose stored text holds a pre-fix sanitizer redaction marker (doctor/checks/facts-redaction-marker.ts).
  'facts_redaction_marker',
  // #7247: a calendar day holding a bulk-loaded share of a source's facts as their valid_from (doctor/checks/fact-bulk-dates.ts).
  'fact_bulk_dates',
  'conversation_label_facts',
  'conversation_outcomes_stale',
  'connector_checkpoints',
  'connector_held_items',
  'git_held_files',
  'fence_integrity',
  // GBRA-221: live fence rows on imported pages whose body is outside-authored text (doctor/checks/outside-content-fences.ts).
  'outside_content_fences',
  // GBRA-161: derived items live generations retired in the restore window, and results held instead of published (doctor/checks/generations.ts).
  'generation_held',
  'generation_pending',
  'generation_retirements',
  // #5575: stored trust tier counts, the legacy-row backfill, scan and source claims.
  'trust_tiers',
  'trust_scan',
  'trust_sources_unclaimed',
  // #7656: index-existing trust releases confirmed before their preview showed the fence row's fields (doctor/checks/trust-release-unpreviewed.ts).
  'trust_release_unpreviewed_fields',
  'credential_projection_pending',
  'derived_visibility',
  'extractor_facts_expired',
  'loop_facts_drift',
  'ontology_facts_fenced',
  'orphan_persistence_bindings',
  'foreign_ownership_marker',
  'coordination_lock_location',
  'safe_index_pending',
  'self_capture',
  'brain_score',
  // W1: belief ledger coverage intervals, drift, orphan lifetimes and unsafe restores.
  'belief_ledger_coverage',
  'calibration_freshness',
  'child_table_orphans',
  'chronicle_projection_health',
  'auto_chronicle',
  'auto_chronicle_default_on',
  'chronicle_config_invalid',
  'facts_drain',
  'fact_take_vectors',
  'code_chunk_metadata',
  'content_hash_duplicates',
  'content_sanity_audit_recent',
  'contextual_retrieval_coverage',
  'contradictions',
  'conversation_facts_backlog',
  'conversation_format_coverage',
  'conversation_parser_probe_health',
  'cross_modal_modality_backfill',
  'cycle_freshness',
  'dangling_aliases',
  'effective_date_health',
  // #4795 — reindex-search-vector marker still set: keyword index split
  // across two tokenizers until the resumed run finishes.
  'fts_reindex_incomplete',
  'embed_staleness',
  'embedding_column_registry',
  'embedding_env_override',
  // #6113: a bare legacy embedding_model DB row; the fix previews migrate embeddings.
  'embedding_identity_unqualified',
  // #5137: an env provider key shadowing a different config key.
  'embedding_key_source',
  'embedding_migration_state',
  'embedding_provider',
  // #5691: query-instruction advisory for instruction-style embedding models.
  'embedding_query_prefix',
  'embedding_state',
  'embedding_width_consistency',
  'embeddings',
  'entity_link_coverage',
  'eval_drift',
  'extract_atoms_backlog',
  // #6325: managed atom origins held after repeated extraction failures.
  'extract_atoms_held_failed',
  'extract_health',
  // Large pages A7: page extractions that read only part of their input.
  'extraction_input_truncated',
  // PR 4 (Wave B incremental derivation, transcripts): conversation pages held because no format is detected over them.
  'conversation_detection_ambiguous',
  // PR 4 (Wave B incremental derivation, transcripts): segmented derivations held back by a model without a price.
  'derivation_unpriced_model',
  'facts_embedding_width_consistency',
  'facts_extraction_health',
  'facts_health',
  'frontmatter_integrity',
  'frontmatter_repairable',
  'malformed_path_pages',
  'memory_writeback',
  'core_memory',
  'grade_confidence_drift',
  'graph_coverage',
  'graph_signals_coverage',
  // Which extraction prompts resolve relative dates (informational).
  'extraction_date_grounding',
  'hidden_by_search_policy',
  'image_assets',
  // #6529: image pages without an image vector, apart from text coverage (plus NULL source_path and held images).
  'image_embedding_coverage',
  'integrity',
  'jsonb_integrity',
  // #4222 — near-empty entity pages that accreted huge edge counts (junk
  // hubs polluting the graph): a data-quality signal, sibling of
  // scraper_junk_pages / graph_coverage.
  'junk_entity_hubs',
  'link_resolution_opportunity',
  'links_extraction_lag',
  'markdown_body_completeness',
  'nightly_quality_probe_health',
  'ocr_health',
  'orphan_ratio',
  'oversized_pages',
  'parked_effects',
  // #6741: managed purges parked after repeated failures (doctor/checks/purge-parks.ts).
  'purge_parked_pages',
  // Wave B PR 4: fact purge sweeps of stored derivation results still pending or stalled (doctor/checks/derivation-purge-sweeps.ts).
  'derivation_purge_sweeps',
  'partial_embedding',
  'pglite_scratch_probe',
  'quarantined_pages',
  'raw_provenance',
  'flagged_pages',
  'salience_health',
  'scraper_junk_pages',
  'slug_collisions',
  'source_config_shape',
  'source_routing_health',
  'stale_mentions',
  'stub_guard_24h',
  // Fact supersession threshold calibrated for the active embedding model (facts/supersession-threshold.ts).
  'supersession_calibration',
  // #6590: whether the embedding model has measured fact admission cosine floors (search/fact-relevance.ts).
  'fact_admission_floors',
  'sync_failures',
  // #5984: unfinished managed sync cursors, their remaining entries and indexing ETA.
  'managed_sync_backlog',
  'sync_freshness',
  // #6858 ask 6: p95 commit→searchable of managed sources over 24 h (doctor/checks/managed-sync-latency.ts).
  'managed_sync_latency',
  // GBRA-133 PR 2a: the resident that syncs each local source on commit, or none with the fix (doctor/checks/commit-notifier.ts).
  'commit_notifier',
  // #5063: source checkouts with commits not on their upstream or stale uncommitted changes.
  'git_convergence',
  // #5186: an ownership marker committed to a source checkout's Git index.
  'tracked_ownership_marker',
  // #7381: a source checkout behind its upstream, write-through files or staged files waiting for a commit, unpushed commits outside the source root (doctor/checks/git-writer.ts).
  'checkout_lagging',
  'dirty_age',
  'commits_outside_source_root',
  'quarantined_changes',
  'takes_count',
  'takes_weight_grid',
  // #5836: active facts with no entity (invisible to entity recall and the conflict sweep).
  'unlinked_facts',
  // #7160: title-prefixed person pages that likely duplicate an unprefixed page (preview only).
  'person_title_duplicates',
  // Git-canonical G1: the database compared with the commit at HEAD per source, informational (doctor/checks/db-ahead-of-git.ts).
  'db_ahead_of_git',
  // Git-canonical G3: how far each strict source's index trails HEAD (doctor/checks/git-index-lag.ts).
  'git_index_lag',
  'edge_validity',
  'text_projection_readiness',
  'timeline_coverage',
  'timeline_orphans',
  'timeline_history',
  // #6147: imported conversation pages that may still carry a typed credential (cached audit).
  'transcript_secret_exposure',
  // #5254 — pages written database-only to a source with no canonical owner.
  'unbound_source',
  'undeclared_db_only_pages',
  // #6696 B5: live pages whose canonical file is missing on the owner host (doctor/checks/ghost-pages.ts).
  'ghost_pages',
  // #6948: files recorded by several live pages (origin twins) and the pages_live_origin_key index (doctor/checks/origin-twins.ts).
  'origin_twins',
  // #7305: live pages whose slug their recorded file path does not derive, and whose file lacks the slug: stamp (doctor/checks/slug-path-mismatch.ts).
  'slug_path_mismatch',
  // #6729: inexact renames whose identity sync did not keep, until the pair gets a disposition (doctor/checks/rename-identity-downgrades.ts).
  'rename_identity_downgrades',
  // #6609: live pages of a classic checkout whose recorded file a full sync would not find (doctor/checks/missing-recorded-files.ts).
  'missing_recorded_files',
  // #7130: soft-deleted pages a managed sync removed although Git never held their file (doctor/checks/uncommitted-sync-deletions.ts).
  'uncommitted_sync_deletions',
  // #6865: committed files of a managed Git source with no page and no hold, from the stored detector result (doctor/checks/unindexed-files.ts).
  'unindexed_files',
  // GBRA-150: pages a managed sync committed past the freshness target that search cannot fully see (doctor/checks/landing-gaps.ts).
  'sync_landing_gaps',
  // #6712: live pages whose database-only edit an incremental sync overwrote without a hold (doctor/checks/overwritten-edits.ts).
  'sync_overwritten_db_edits',
  // #7891: provenance stamps and trust markers a write removed before #7892 (doctor/checks/provenance-stamp-drift.ts).
  'provenance_stamp_drift',
  'unified_multimodal_coverage',
  'unverified_extractions',
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
  'memory_verbs_usage',
  'resolver_health',
  'retrieval_reflex_health',
  // Harness hook adapters: per-channel push-context visibility (sibling of
  // retrieval_reflex_health — same "is my agent's context wiring live?" question).
  'volunteer_channels',
  'skill_brain_first',
  'skill_conformance',
  'skills_manifest_integrity',
  'skill_currency',
  'skill_preconditions',
  'whoknows_health',
]);

/**
 * Infrastructure liveness signals. DB, workers, OAuth, RLS, locks, providers.
 */
export const OPS_CHECK_NAMES: ReadonlySet<string> = new Set([
  // The effective chat_fallback_chain, its config plane, the providers it reaches and per-entry readiness.
  'chat_fallback_chain',
  // Agent operator wave: is an agent harness wired to this brain (registration read; --only adds the smoke test).
  'harness_wiring',
  // Cat 41: the provider-use decision gbrain setup recorded; declined = no provider request (discovery, probe).
  'provider_consent',
  'frontmatter_hook',
  // F4b: PGLite row-delta planner statistics / Postgres autovacuum ANALYZE lag on the hot tables.
  'planner_stats_stale',
  'alternative_providers',
  'autopilot_fanout_concurrency',
  'autopilot_lock_scope',
  'bootstrap_hook_schema_pairing',
  'bootstrap_harness_health',
  'bootstrap_hooks_heartbeat',
  'bootstrap_last_verify',
  'memorable_relay_health',
  'backup_coverage',
  'bootstrap_push_health',
  'bootstrap_durability_job',
  'bootstrap_runbook_skew',
  'bootstrap_serve_lock',
  'batch_retry_health',
  'canonical_content_writes',
  // Sources opted out of, or parked by, the shared-skills migration (checks/shared-skills.ts).
  'shared_skills_sources',
  'brainstorm_health',
  'connectors',
  'dream_paid_loop',
  'connection',
  'db_only_collector_collision',
  'federation_health',
  'google_file_modes',
  // #5012 item 9: a Google source's configured calendar was unreadable at its last sync (doctor/checks/google-calendar.ts).
  'google_calendar_readable',
  // #7073: a Google source's last sync could not reach a service (API disabled, scope not granted) (doctor/checks/google-api-access.ts).
  'google_api_access',
  'google_oauth',
  'home_dir_in_worktree',
  // GBRA-108: cron commands that run gbrain without GBRAIN_HOME (doctor/checks/cron-gbrain-home.ts).
  'cron_gbrain_home',
  'index_audit',
  'npm_squat',
  'oauth_client_scope_health',
  'oauth_confidential_client_health',
  'orphan_clones',
  'persistence_capacity',
  'persistence_compaction',
  // #6712 PR 2: the managed-sync soak counters (interventions, content decisions), informational.
  'sync_soak_counters',
  'persistence_counter_drift',
  'worktree_refresh_stuck',
  'managed_guard_schema_drift',
  'publication_refusals',
  'persistence_request_growth',
  'persistence_request_indexes',
  'persistence_write_stall',
  'lost_caller_writes',
  // #6650: terminal write receipts that block work or are a gbrain-defect class (doctor/checks/persistence-requests.ts).
  'persistence_terminal_failures',
  'stale_frontmatter_keys',
  'maintenance_write_drift',
  'managed_sync_not_moving',
  // #6858: a managed sync run stopped on a page that did not commit, failed past an hour (doctor/checks/managed-sync-blocked.ts).
  'managed_sync_blocked',
  // #6712 PR 4a: the read-only convergence shadow's counts (doctor/checks/managed-sync-convergence.ts).
  'managed_sync_convergence',
  // #6712 PR 4b: sync.admission is not normal, so managed sync admits less than it classifies (doctor/checks/sync-admission.ts).
  'sync_admission_restricted',
  'persistence_session_timeouts',
  // #6317: consumer heartbeat rows and host identity (doctor/checks/persistence-consumers.ts).
  'two_consumers_on_host',
  'consumers_without_heartbeat',
  'host_identity_mismatch',
  // #6696 C6: a live serve or worker on an older build than this checkout (doctor/checks/persistence-consumers.ts).
  'serve_build_drift',
  // #7245: serve, the jobs supervisor, worker parents and job children on different builds (doctor/checks/runtime-build-skew.ts).
  'runtime_build_skew',
  // GBRA-156: the warm CLI socket refused CLI calls by identity part in the last 24 h (doctor/checks/cli-socket-refusals.ts).
  'cli_socket_refusals',
  'stale_embedding_effects',
  'vector_plan',
  'keyword_plan',
  'writer_version',
  'segmented_storage',
  'pgbouncer_prepare',
  'pglite_data_dir',
  // #6573: a local IPC socket path over the platform's AF_UNIX budget (doctor/checks/local-ipc.ts).
  'ipc_socket_path',
  // db-availability loop: engine-fit + repair-recurrence signals.
  'pglite_scale',
  'db_repair_recurrence',
  'pglite_leftovers',
  // Engine graduation (PGLite -> Postgres) interrupted / split brain.
  'graduation_interrupted',
  'pgvector',
  'postgres_cancellation_driver',
  'plugin_lane_collision',
  'pool_budget',
  'progressive_batch_audit_health',
  'queue_health',
  // #4578: brain-wide maintenance jobs dying at their deadline.
  'global_maintenance_timeouts',
  // GBRA-130 C-6: no completed brain-wide pass while jobs fail or a phase keeps blocking it.
  'global_maintenance_stalled',
  'embed_backfill_stalled',
  // #7117: the content-drift sweep's latest batch failed.
  'content_drift_sweep',
  'connector_account_mismatch',
  // #5157: queued jobs from before the v0.50 authority cutover block every worker.
  'legacy_job_authority',
  // F3: legacy tokens on the JSONB-only grant shape (info) and grant drift (warn).
  'legacy_token_grant_shape',
  'legacy_token_grant_drift',
  // Lane E: tokens minted without scopes (grandfathered read+write+admin).
  'legacy_token_null_scope',
  // D4: grants whose operation snapshot or stored surface keeps operations their scopes allow out of reach.
  'grant_new_ops_available',
  'reranker_health',
  'rls',
  // #7632: every gbrain function that pins a search_path ends it with pg_temp.
  'function_search_path',
  'rls_event_trigger',
  'search_mode',
  'decide_health',
  'pool_reap_health',
  'self_upgrade_health',
  'bun_runtime',
  'stale_locks',
  'subagent_capability',
  'subagent_health',
  'supervisor',
  'supervisor_niceness',
  'supervisor_singleton',
  'sync_consolidation',
  'wedged_queue',
  'orphaned_private_queue',
  'worker_oom_loop',
]);

/**
 * gbrain-itself coherence signals. Schema migrations, version drift, audit
 * housekeeping. Default category for unknown names (with stderr warn).
 */
export const META_CHECK_NAMES: ReadonlySet<string> = new Set([
  // The one-time behavior-change disclosure, readable again here (read-only).
  'behavior_changes',
  // #7142: checks with no result from the last 24 h on a quick-tier or capped run (doctor/last-known.ts).
  'doctor_last_known',
  // Agent operator wave E11: recent agent dead ends from the agent-contract event log.
  'agent_contract',
  'cycle_phase_scope',
  'default_source_local_path',
  'eval_capture',
  'retrieval_feedback_health',
  // #4613 — links_link_source_check CHECK shape: schema coherence healed by
  // `gbrain apply-migrations` (sibling of pages_upsert_arbiter).
  'links_link_source_check',
  'minions_migration',
  'multi_source_drift',
  'pack_upgrade_available',
  // #550 — pages UNIQUE(source_id, slug) upsert arbiter presence: schema
  // coherence healed by `gbrain apply-migrations` (sibling of
  // timeline_dedup_index / schema_version).
  'pages_upsert_arbiter',
  // #5216: the resumable pages.knowledge_revision backfill (resumed by apply-migrations --force-schema).
  'revision_backfill',
  'schema_columns',
  // #6911: tables the applied migrations created that are missing (repair missing-tables recreates rebuildable caches).
  'schema_missing_tables',
  'schema_pack_active',
  'schema_pack_consistency',
  'schema_pack_source_drift',
  'schema_version',
  'slug_fallback_audit',
  // #6712 PR 2: retired sync.* keys stored on the brain and no longer applied.
  'sync_config_keys',
  'timeline_dedup_index',
  'type_proliferation',
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
