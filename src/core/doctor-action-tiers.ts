import type { CheckCategory } from './doctor-categories.ts';

export type DoctorActionTier = 'red' | 'yellow' | 'blue' | 'gray';

export interface TierableCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  category?: CheckCategory;
  action_tier?: DoctorActionTier;
}

const RED_RUNTIME_CHECKS = new Set([
  'alternative_providers',
  'autopilot_lock_scope',
  'batch_retry_health',
  'connection',
  'embedding_column_registry',
  'embedding_env_override',
  'embedding_provider',
  'embedding_width_consistency',
  'embeddings',
  'facts_embedding_width_consistency',
  'jsonb_integrity',
  'markdown_body_completeness',
  'minions_migration',
  'oauth_confidential_client_health',
  'pgbouncer_prepare',
  'pgvector',
  'queue_health',
  'rls',
  'rls_event_trigger',
  'schema_version',
  'stale_locks',
  'subagent_capability',
  'supervisor',
  'supervisor_singleton',
  'sync_failures',
  'takes_weight_grid',
  'wedged_queue',
  'worker_oom_loop',
]);

const YELLOW_BACKLOG_CHECKS = new Set([
  'abandoned_threads',
  'autopilot_fanout_concurrency',
  'content_sanity_audit_recent',
  'conversation_facts_backlog',
  'cross_modal_modality_backfill',
  'cycle_freshness',
  'dangling_aliases',
  'embed_staleness',
  'eval_drift',
  'extract_atoms_backlog',
  'extract_health',
  'flagged_pages',
  'frontmatter_integrity',
  'image_assets',
  'integrity',
  'links_extraction_lag',
  'multi_source_drift',
  'ocr_health',
  'orphan_ratio',
  'orphan_clones',
  'oversized_pages',
  'pool_budget',
  'pool_reap_health',
  'progressive_batch_audit_health',
  'quarantined_pages',
  'scraper_junk_pages',
  'sync_consolidation',
  'sync_freshness',
]);

const BLUE_QUALITY_CHECKS = new Set([
  'brain_score',
  'brainstorm_health',
  'calibration_freshness',
  'contextual_retrieval_coverage',
  'conversation_format_coverage',
  'conversation_parser_probe_health',
  'contradictions',
  'effective_date_health',
  'entity_link_coverage',
  'facts_extraction_health',
  'facts_health',
  'grade_confidence_drift',
  'graph_coverage',
  'graph_signals_coverage',
  'hidden_by_search_policy',
  'link_resolution_opportunity',
  'nightly_quality_probe_health',
  'pack_upgrade_available',
  'reranker_health',
  'resolver_health',
  'retrieval_reflex_health',
  'salience_health',
  'schema_pack_active',
  'schema_pack_consistency',
  'schema_pack_source_drift',
  'search_mode',
  'skill_brain_first',
  'skill_conformance',
  'source_routing_health',
  'takes_count',
  'timeline_coverage',
  'type_proliferation',
  'unified_multimodal_coverage',
  'voice_gate_health',
  'whoknows_health',
  'ze_embedding_health',
]);

export function actionTierForCheck(check: TierableCheck): DoctorActionTier {
  if (check.status === 'ok') return 'gray';
  if (RED_RUNTIME_CHECKS.has(check.name)) return 'red';
  if (YELLOW_BACKLOG_CHECKS.has(check.name)) return 'yellow';
  if (BLUE_QUALITY_CHECKS.has(check.name)) return 'blue';
  if (check.status === 'fail') return 'red';
  if (check.category === 'ops') return 'yellow';
  if (check.category === 'skill') return 'blue';
  if (check.category === 'meta') return 'yellow';
  return 'yellow';
}

export interface DoctorActionTierSummary {
  red: number;
  yellow: number;
  blue: number;
  gray: number;
}

export function summarizeActionTiers(checks: TierableCheck[]): DoctorActionTierSummary {
  const summary: DoctorActionTierSummary = { red: 0, yellow: 0, blue: 0, gray: 0 };
  for (const check of checks) summary[check.action_tier ?? actionTierForCheck(check)]++;
  return summary;
}
