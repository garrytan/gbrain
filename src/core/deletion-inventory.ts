/**
 * The deletion-target inventory (#5575 CEO-22, ENG-12): one registry that
 * classifies every table holding text, JSON, bytes, lexemes or vectors, so a
 * purge receipt can say exactly what it swept, what it hid, what it probed and
 * reported, and what is out of its reach. `test/deletion-inventory.test.ts`
 * fails when a migration adds a text-bearing column this registry does not
 * list, so a new store is classified before it ships.
 *
 * Classes:
 * - `swept`: purge removes or redacts matching content (`adapter` names how).
 * - `retained_inactive`: rows purge hides and marks `needs_rederive`.
 * - `out_of_scope` with a reason:
 *   - `probed_reported`: may carry memory text purge does not rewrite; the
 *     verification probes `probe` columns and lists matches as residuals;
 *   - `text_free_ledger`: tombstones and edges (hashes and ids only);
 *   - `secret_material`: credential hashes and grants;
 *   - `no_memory_text`: identifiers, hashes, enums, operational metadata.
 *
 * "Verified" in a receipt applies only to the swept scope. Purge removes
 * content from live stores; it never claims physical erasure.
 */

export type InventoryClass = 'swept' | 'retained_inactive' | 'out_of_scope';
export type OutOfScopeReason = 'probed_reported' | 'text_free_ledger' | 'secret_material' | 'no_memory_text';
export interface InventoryEntry {
  table: string;
  class: InventoryClass;
  /** The swept adapter, or the out-of-scope reason. */
  reason: string;
  /** Every text-bearing column (text, varchar, json/jsonb, bytea, arrays, tsvector, vector) at registration. */
  columns: readonly string[];
  /** For `probed_reported`: the columns the verification probes for the claim. */
  probe?: readonly string[];
}

type Row = [table: string, cls: InventoryClass, reason: string, columns: string, probe?: string];
const ROWS: readonly Row[] = [
  ['access_tokens', 'out_of_scope', 'secret_material', 'name token_hash scopes permissions source_grant source_id federated_read allowed_operations takes_holders min_trust'],
  ['budget_ledger', 'out_of_scope', 'no_memory_text', 'scope resolver_id'],
  ['budget_reservations', 'out_of_scope', 'no_memory_text', 'reservation_id scope resolver_id status'],
  ['calibration_profiles', 'out_of_scope', 'probed_reported', 'source_id holder wave_version domain_scorecards pattern_statements active_bias_tags model_id', 'pattern_statements domain_scorecards'],
  ['chat_usage_log', 'out_of_scope', 'no_memory_text', 'model provider phase'],
  ['chronicle_judge_reservations', 'out_of_scope', 'no_memory_text', 'source_id content_hash'],
  ['chronicle_page_state', 'out_of_scope', 'no_memory_text', 'source_id content_hash slug state reason trigger principal_kind principal_id event_slugs event_hashes campaign_id pricing_policy'],
  ['code_edges_chunk', 'out_of_scope', 'no_memory_text', 'from_symbol_qualified to_symbol_qualified edge_type edge_metadata source_id'],
  ['code_edges_symbol', 'out_of_scope', 'no_memory_text', 'from_symbol_qualified to_symbol_qualified edge_type edge_metadata source_id'],
  ['code_traversal_cache', 'out_of_scope', 'no_memory_text', 'symbol_qualified source_id response_json'],
  ['config', 'out_of_scope', 'no_memory_text', 'key value'],
  ['content_chunks', 'swept', 'chunks', 'chunk_text chunk_source embedding model embedded_text_hash embedding_input_hash language symbol_name symbol_type modality embedding_image embedding_multimodal parent_symbol_path doc_comment symbol_name_qualified search_vector'],
  ['context_volunteer_events', 'out_of_scope', 'probed_reported', 'source_id slug match_arm rationale channel session_id', 'rationale'],
  ['conversation_parser_llm_cache', 'out_of_scope', 'probed_reported', 'content_sha256 model_id call_shape value_json', 'value_json'],
  ['core_edit_notices', 'swept', 'core_notice_base', 'source_id slug revision base_revision base_text actor'],
  ['decide_calibrations', 'out_of_scope', 'no_memory_text', 'slot call_site provider model_resolved metric qualification policy_fingerprint dataset_hash split_hash calibrate_ids_hash pack_shape notes'],
  ['decide_proposals', 'swept', 'review_rows', 'source_id sweep_id direction model_resolved status before_state after_state'],
  ['decide_review_proposals', 'swept', 'review_rows', 'kind source_id sweep_id a_ref b_ref subject visibility model_resolved question_version status receipt'],
  ['decide_review_queue', 'swept', 'review_rows', 'kind source_id a_ref b_ref evidence reason'],
  ['decide_spend', 'out_of_scope', 'no_memory_text', 'request_id source_id slot provider model_resolved lane outcome'],
  ['decide_state', 'out_of_scope', 'no_memory_text', 'key value'],
  ['decide_sweep_deferred', 'out_of_scope', 'no_memory_text', 'source_id slot reason'],
  ['decision_receipts', 'out_of_scope', 'probed_reported', 'decision_id source_id slot mode provider model_alias model_resolved question_kind state_hash question_hash answer_choice outcome subject_ref call_site lane policy_fingerprint calibration_ref error_reason run_meta', 'run_meta'],
  ['derivation_inputs', 'out_of_scope', 'text_free_ledger', 'derived_table derived_id input_table input_id source_id'],
  ['dream_synthesis_completions', 'out_of_scope', 'no_memory_text', 'source_id idempotency_key'],
  ['dream_verdicts', 'out_of_scope', 'probed_reported', 'file_path content_hash reasons content_type segments entities model', 'segments entities reasons'],
  ['drift_decisions', 'out_of_scope', 'probed_reported', 'reasoning applied_by', 'reasoning'],
  ['entity_identities', 'out_of_scope', 'no_memory_text', 'entity_id source_id established_by'],
  ['eval_candidates', 'out_of_scope', 'probed_reported', 'tool_name query retrieved_slugs source_ids detail detail_resolved salience_param recency_param salience_resolved recency_resolved salience_source recency_source embedding_column schema_pack_per_source', 'query'],
  ['eval_capture_failures', 'out_of_scope', 'no_memory_text', 'reason'],
  ['eval_contradictions_cache', 'out_of_scope', 'probed_reported', 'chunk_a_hash chunk_b_hash model_id prompt_version truncation_policy verdict', 'verdict'],
  ['eval_contradictions_runs', 'out_of_scope', 'probed_reported', 'run_id judge_model prompt_version source_tier_breakdown report_json', 'report_json'],
  ['eval_takes_quality_runs', 'out_of_scope', 'probed_reported', 'receipt_sha8_corpus receipt_sha8_prompt receipt_sha8_models receipt_sha8_rubric rubric_version verdict dim_scores receipt_json receipt_disk_path', 'receipt_json'],
  ['extract_atoms_page_state', 'out_of_scope', 'no_memory_text', 'content_hash'],
  ['extract_atoms_transcript_state', 'out_of_scope', 'no_memory_text', 'source_id file_path content_hash'],
  ['extract_rollup_7d', 'out_of_scope', 'no_memory_text', 'kind source_id'],
  ['fact_purges', 'out_of_scope', 'text_free_ledger', 'source_id visibility subject fact_hash actor reason'],
  ['fact_relink_attempts', 'out_of_scope', 'probed_reported', 'source_id outcome reason tier model target_slug run_id', 'reason'],
  ['fact_withdrawals', 'out_of_scope', 'text_free_ledger', 'source_id visibility subject fact_hash'],
  ['facts', 'swept', 'fact', 'source_id entity_slug fact kind visibility notability context source source_session embedding source_markdown_slug claim_metric claim_unit claim_period event_type dimension value value_hash dim_status embedding_model embedded_text_hash write_principal_kind write_principal_id last_write_principal_kind last_write_principal_id attributed_to trust_tier write_origin'],
  ['files', 'swept', 'page_files', 'source_id page_slug filename storage_path mime_type content_hash metadata'],
  ['gbrain_cycle_locks', 'out_of_scope', 'no_memory_text', 'id holder_host'],
  ['ingest_log', 'out_of_scope', 'probed_reported', 'source_id source_type source_ref pages_updated summary', 'summary pages_updated'],
  ['link_edge_proposals', 'out_of_scope', 'probed_reported', 'source_id link_type evidence_hash status model generated_line detail', 'generated_line detail'],
  ['link_relationships', 'out_of_scope', 'no_memory_text', 'link_type scope source_id semantics status_now evidence_hash'],
  ['link_transitions', 'out_of_scope', 'no_memory_text', 'source_id link_type kind date_precision producer line_hash'],
  ['links', 'out_of_scope', 'probed_reported', 'link_type context link_source link_kind origin_field resolution_type assertion_tense', 'context'],
  ['loop_suppressions', 'out_of_scope', 'no_memory_text', 'source_id kind value'],
  ['mcp_request_log', 'out_of_scope', 'probed_reported', 'token_name agent_name operation status params error_message', 'params error_message'],
  ['mcp_spend_log', 'out_of_scope', 'no_memory_text', 'client_id token_name operation provider model budget_key'],
  ['mcp_spend_reservations', 'out_of_scope', 'no_memory_text', 'client_id model provider status usage_unknown_reason budget_key'],
  ['mention_gazetteer_entries', 'out_of_scope', 'no_memory_text', 'source_id name_norm target_slug'],
  ['mention_index_status', 'out_of_scope', 'no_memory_text', 'source_id state policy_fingerprint error'],
  ['migration_impact_log', 'out_of_scope', 'probed_reported', 'remediation_id metric_name source_id brain_id idempotency_key applied_by details', 'details'],
  ['minion_attachments', 'out_of_scope', 'probed_reported', 'filename content_type content storage_uri sha256', 'content'],
  ['minion_budget_log', 'out_of_scope', 'no_memory_text', 'event_type model'],
  ['minion_inbox', 'out_of_scope', 'probed_reported', 'sender payload', 'payload'],
  ['minion_jobs', 'out_of_scope', 'probed_reported', 'name queue status submission_authority data backoff_type lock_token on_child_fail idempotency_key private_queue_owner_token result progress error_text stacktrace quiet_hours stagger_key spend_authorization', 'data result error_text'],
  ['minion_lease_pressure_log', 'out_of_scope', 'no_memory_text', 'lease_key queue_name job_name model provider'],
  ['minion_self_fix_log', 'out_of_scope', 'no_memory_text', 'classifier_bucket policy_applied outcome'],
  ['needs_rederive', 'out_of_scope', 'text_free_ledger', 'derived_table derived_id source_id reason'],
  ['oauth_clients', 'out_of_scope', 'secret_material', 'client_id client_secret_hash client_name redirect_uris grant_types scope token_endpoint_auth_method source_id federated_read bound_tools bound_source_id bound_brain_id bound_slug_prefixes surface surface_set_by allowed_operations delegated_slug_prefixes delegated_namespace grant_profile grant_repair_reasons source_grant takes_holders min_trust'],
  ['oauth_codes', 'out_of_scope', 'secret_material', 'code_hash client_id scopes code_challenge code_challenge_method redirect_uri state resource'],
  ['oauth_grant_audit', 'out_of_scope', 'no_memory_text', 'client_id actor action before_grant after_grant'],
  ['oauth_tokens', 'out_of_scope', 'secret_material', 'token_hash token_type client_id scopes resource'],
  ['op_checkpoint_paths', 'out_of_scope', 'no_memory_text', 'op fingerprint path'],
  ['op_checkpoints', 'out_of_scope', 'no_memory_text', 'op fingerprint completed_keys'],
  ['open_loops', 'swept', 'open_loops', 'source_id dedup_key loop_type counterparty_slug counterparty_email summary evidence thread_id page_slug status detector closed_by'],
  ['page_aliases', 'out_of_scope', 'probed_reported', 'source_id alias_norm slug origin alias_text', 'alias_text'],
  ['page_facts_reconcile', 'out_of_scope', 'no_memory_text', 'outcome'],
  ['page_mention_state', 'out_of_scope', 'no_memory_text', 'source_id'],
  ['page_projection_jobs', 'out_of_scope', 'no_memory_text', 'slug reason'],
  ['page_purges', 'out_of_scope', 'text_free_ledger', 'source_id content_hash slug'],
  ['page_versions', 'swept', 'page_versions', 'compiled_truth frontmatter timeline title type tags source_path write_principal_kind write_principal_id archived_principal_kind archived_principal_id trust_tier write_origin'],
  ['page_write_guards', 'out_of_scope', 'no_memory_text', 'slug'],
  ['pages', 'swept', 'page_body', 'source_id slug type page_kind title compiled_truth timeline frontmatter content_hash effective_date_source import_filename database_only_reason contextual_retrieval_mode corpus_generation search_vector source_path ingested_via source_uri source_kind embedding_signature revision_principal_kind revision_principal_id trust_tier write_origin'],
  ['persistence_consumers', 'out_of_scope', 'no_memory_text', 'kind mode pool version nonce minted_under persistence_home host_json_path pid_ns'],
  ['persistence_counters', 'out_of_scope', 'no_memory_text', 'key'],
  ['persistence_effects', 'swept', 'effect_recovery', 'kind data state source_id error_code outcome recovery'],
  ['persistence_graduation', 'out_of_scope', 'probed_reported', 'role state source_data_dir trigger_bypass table_receipts replay_probe timings doctor rollback', 'table_receipts'],
  ['persistence_host_bindings', 'out_of_scope', 'no_memory_text', 'local_path coordination_path'],
  ['persistence_local_writers', 'out_of_scope', 'secret_material', 'lane credential_hash grant_ceiling'],
  ['persistence_requests', 'swept', 'request_intent', 'principal_kind principal_id operation source_id slug digest intent authority state recovery outcome error_code error_message blocked_reason target_kind admitter_version consumer_version error_detail claim_phase'],
  ['persistence_source_bindings', 'out_of_scope', 'no_memory_text', 'source_id relative_path'],
  ['persistence_topology_changes', 'out_of_scope', 'probed_reported', 'digest operation source_id state recovery outcome', 'recovery outcome'],
  ['persistence_worktree_refreshes', 'out_of_scope', 'probed_reported', 'source_ids state old_head target_head upstream_ref preserved_uncommitted outcome', 'outcome'],
  ['persistence_worktrees', 'out_of_scope', 'no_memory_text', 'state manifest'],
  ['planner_stats_deltas', 'out_of_scope', 'no_memory_text', 'table_name'],
  ['planner_stats_state', 'out_of_scope', 'no_memory_text', 'table_name'],
  ['query_cache', 'swept', 'query_cache', 'id query_text source_id embedding results meta knobs_hash page_generations'],
  ['raw_data', 'out_of_scope', 'probed_reported', 'source data', 'source data'],
  ['retrieval_event_links', 'out_of_scope', 'no_memory_text', 'event_id source_id edge_key to_slug'],
  ['retrieval_event_pages', 'out_of_scope', 'no_memory_text', 'event_id source_id slug content_hash'],
  ['retrieval_events', 'out_of_scope', 'no_memory_text', 'id client_id op'],
  ['retrieval_feedback', 'out_of_scope', 'no_memory_text', 'event_id signal element_kind source_id element_key client_id'],
  ['retrieval_weights', 'out_of_scope', 'no_memory_text', 'source_id element_kind element_key content_hash'],
  ['search_telemetry', 'out_of_scope', 'no_memory_text', 'date mode intent'],
  ['session_context_state', 'out_of_scope', 'probed_reported', 'source_id client_id session_id standing_entities surfaced_slugs checkpoint_manifest', 'checkpoint_manifest standing_entities'],
  ['shared_skill_delivery_batches', 'out_of_scope', 'no_memory_text', 'view_token authority_digest revisions evidence'],
  ['shared_skill_heads', 'out_of_scope', 'no_memory_text', 'source_id pack_id name metadata policy_epoch'],
  ['shared_skill_members', 'out_of_scope', 'no_memory_text', 'principal_kind principal_id adapter follow_policy desired_view acknowledged_view'],
  ['shared_skill_packs', 'out_of_scope', 'no_memory_text', 'source_id pack_id manifest manifest_hash'],
  ['shared_skill_policies', 'out_of_scope', 'no_memory_text', 'source_id policy'],
  ['shared_skill_policy_audit', 'out_of_scope', 'no_memory_text', 'source_id principal_kind principal_id previous_epoch policy'],
  ['shared_skill_revision_leases', 'out_of_scope', 'no_memory_text', 'lease_kind source_id pack_id name principal_kind principal_id'],
  ['shared_skill_revisions', 'out_of_scope', 'probed_reported', 'source_id pack_id name metadata files policy_epoch', 'files metadata'],
  ['shared_skill_state', 'out_of_scope', 'secret_material', 'token_secret'],
  ['slug_aliases', 'out_of_scope', 'no_memory_text', 'source_id alias_slug canonical_slug notes'],
  ['source_ingestion_receipts', 'out_of_scope', 'probed_reported', 'source_id approved_revision profile schema_fingerprint extractor_version phase outcome counts checkpoint_refs diagnostic policy_fingerprint', 'diagnostic'],
  ['sources', 'out_of_scope', 'no_memory_text', 'id name local_path last_commit config contextual_retrieval_mode chunker_version upstream_commit'],
  ['subagent_messages', 'out_of_scope', 'probed_reported', 'role content_blocks provider_id model', 'content_blocks'],
  ['subagent_rate_leases', 'out_of_scope', 'no_memory_text', 'key'],
  ['subagent_tool_executions', 'out_of_scope', 'probed_reported', 'tool_use_id tool_name input status output error provider_id', 'input output'],
  ['tags', 'out_of_scope', 'no_memory_text', 'tag tag_source'],
  ['take_domain_assignments', 'out_of_scope', 'no_memory_text', 'domain pack source'],
  ['take_grade_cache', 'out_of_scope', 'probed_reported', 'prompt_version judge_model_id evidence_signature wave_version verdict', 'verdict'],
  ['take_nudge_log', 'out_of_scope', 'no_memory_text', 'source_id nudge_pattern channel wave_version'],
  ['take_proposals', 'swept', 'take_proposals', 'source_id page_slug content_hash prompt_version wave_version proposal_run_id status claim_text kind holder domain dedup_against_fence_rows model_id acted_by'],
  ['take_purges', 'out_of_scope', 'text_free_ledger', 'source_id subject claim_hash'],
  ['takes', 'swept', 'take', 'claim kind holder since_date until_date source resolved_unit resolved_source resolved_by embedding resolved_quality embedding_model embedded_text_hash write_principal_kind write_principal_id last_write_principal_kind last_write_principal_id trust_tier write_origin'],
  ['think_ab_results', 'out_of_scope', 'probed_reported', 'source_id wave_version question baseline_answer with_calibration_answer preferred model_id notes', 'question baseline_answer with_calibration_answer'],
  ['timeline_entries', 'out_of_scope', 'probed_reported', 'source summary detail write_principal_kind write_principal_id last_write_principal_kind last_write_principal_id trust_tier write_origin', 'summary detail'],
  ['trust_allow_rules', 'out_of_scope', 'no_memory_text', 'source_id uri_prefix reason_family created_by removed_by reason'],
  ['trust_proposals', 'swept', 'review_rows', 'action source_id target_table related_table before_state after_state proposer proposer_principal_kind proposer_principal_id status decided_principal_kind decided_principal_id'],
  ['wanted_links', 'out_of_scope', 'probed_reported', 'source_id producer ref_kind target_source_id target_ref link_type context', 'context'],
  ['write_gate_holds', 'swept', 'review_rows', 'kind source_id slug fingerprint payload write_origin tier reason_families reasons request_id status decided_by'],
  ['write_gate_receipts', 'out_of_scope', 'text_free_ledger', 'target_table target_id source_id content_hash tier verdict reason_families reasons request_id'],
];

export const DELETION_INVENTORY: readonly InventoryEntry[] = ROWS.map(([table, cls, reason, columns, probe]) => ({
  table, class: cls, reason, columns: columns.split(' '), ...(probe ? { probe: probe.split(' ') } : {}),
}));

export const DELETION_INVENTORY_BY_TABLE: ReadonlyMap<string, InventoryEntry> = new Map(DELETION_INVENTORY.map(e => [e.table, e]));

/** Rows reached through derivation_inputs are hidden in their own table and marked needs_rederive. */
export const DERIVED_ARTIFACTS_ENTRY: InventoryEntry = {
  table: 'derived_artifacts', class: 'retained_inactive', reason: 'needs_rederive', columns: [],
};

/** Stores outside the database. `swept` ones purge checks and cleans; `out_of_reach` ones it can only name. */
export interface OnDiskStore { store: string; status: 'swept' | 'out_of_reach'; detail: string }
export const ON_DISK_STORES: readonly OnDiskStore[] = [
  { store: 'canonical_markdown', status: 'swept', detail: 'The page file is rewritten without the row by the post-commit mirror effect (managed sources) and committed as "gbrain: purge fact <hash8>".' },
  { store: 'fence_tmp_evidence', status: 'swept', detail: 'A quarantined <page file>.tmp left by a failed fence write is deleted when it carries the claim.' },
  { store: 'facts_write_failures_log', status: 'out_of_reach', detail: '~/.gbrain/facts.write_failures.jsonl keeps fence-write warnings; purge reports whether it mentions the claim and never rewrites it.' },
  { store: 'exports', status: 'out_of_reach', detail: 'Markdown exports and compiled context files written before the purge keep their copy.' },
];

/** Residuals no purge can reach. Listed first in every receipt. */
export const OUT_OF_REACH_RESIDUALS: ReadonlyArray<{ store: string; detail: string }> = [
  { store: 'git_history', detail: 'Earlier commits in the brain repository (and every clone and remote) still contain the row; purge lists them and never rewrites history.' },
  { store: 'other_clones', detail: 'Other checkouts, pulled copies and pushed remotes of the brain repository are outside this host.' },
  { store: 'backups', detail: 'A backup taken before the purge restores the content and an older purge ledger.' },
  { store: 'provider_copies', detail: 'Embedding, decision and chat providers that received the text keep whatever their retention keeps.' },
  { store: 'database_physical', detail: 'Deleted rows stay in table pages, indexes and the write-ahead log until vacuum and WAL recycling; replicas and point-in-time recovery windows keep them longer.' },
];
