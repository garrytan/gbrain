import type { Operation } from '../core/operations.ts';

export type ToolTier = 'core' | 'extended' | 'admin';

/**
 * The ~daily-driver tools a normal agent reaches for. Always visible on every surface.
 */
export const CORE_TOOLS = new Set<string>([
  'retrieve_context',
  'read_context',
  'search',
  'query',
  'get_page',
  'put_page',
  'remember',
  'get_skillpack',
  'sync_brain',
  'route_memory_writeback',
  'get_timeline',
  'add_timeline_entry',
  'add_link',
  'list_pages',
  'get_stats',
  'get_health',
  'tool_search',
]);

const ADMIN_TOOL_NAMES = new Set<string>([
  'admin_put_page',
  'apply_memory_patch_candidate',
  'apply_memory_redaction_plan',
  'approve_canonical_target_proposal',
  'approve_memory_redaction_plan',
  'attach_memory_realm_to_session',
  'audit_brain_loop',
  'build_session_grant_policy_input',
  'capture_agent_session_memory',
  'close_memory_session',
  'complete_canonical_handoff',
  'complete_canonical_target_proposal_binding',
  'create_canonical_target_proposal',
  'create_memory_patch_candidate',
  'create_memory_redaction_plan',
  'create_memory_session',
  'dry_run_memory_mutation',
  'evaluate_raw_access',
  'evaluate_session_source_grant',
  'evaluate_session_write_grant',
  'get_lifecycle_forgetting_report',
  'get_memory_operations_health',
  'get_memory_realm',
  'get_memory_redaction_plan',
  'get_memory_session',
  'get_source',
  'get_raw_data',
  'ingest_connector_item',
  'list_canonical_handoff_entries',
  'list_canonical_target_proposals',
  'list_memory_mutation_events',
  'list_memory_realms',
  'list_memory_redaction_plans',
  'list_memory_session_attachments',
  'list_memory_sessions',
  'list_source_items',
  'list_sources',
  'pause_source_processing',
  'plan_lifecycle_purge',
  'plan_agent_session_activation',
  'purge_lifecycle_memory',
  'preview_agent_session_memory',
  'preview_raw_canonical_document',
  'preview_raw_ingest',
  'preview_source_registration',
  'put_raw_data',
  'record_canonical_handoff',
  'record_connector_failure',
  'record_connector_item_deletion',
  'record_connector_sync_success',
  'record_memory_mutation_event',
  'register_connector_source',
  'register_source',
  'reject_canonical_target_proposal',
  'reject_memory_redaction_plan',
  'request_raw_source_chunks',
  'rerun_memory_job',
  'resolve_source_policy',
  'restore_lifecycle_memory',
  'review_lifecycle_purge_plan',
  'review_memory_patch_candidate',
  'run_dream_cycle_maintenance',
  'revoke_source_consent',
  'upsert_memory_realm',
]);

/**
 * Control-plane / governance / source-registry / maintenance families. These are hidden from
 * the default stdio catalog (they bury the daily-driver tools and are higher-risk to call
 * freely) and are blocked by named MCP dispatch unless their tier is explicitly enabled.
 * Add new admin tools here or set operation.tier = 'admin'; do not rely on name fragments.
 */
export function effectiveToolTier(op: Operation): ToolTier {
  if (op.tier) return op.tier;
  if (CORE_TOOLS.has(op.name)) return 'core';
  if (ADMIN_TOOL_NAMES.has(op.name)) return 'admin';
  return 'extended';
}

const ALL_TIERS: ReadonlySet<ToolTier> = new Set<ToolTier>(['core', 'extended', 'admin']);
const DEFAULT_TIERS: ReadonlySet<ToolTier> = new Set<ToolTier>(['core', 'extended']);

/**
 * Resolve the allowed tier set from a MBRAIN_MCP_TOOL_TIER-style selection.
 * - undefined / 'core+extended' (default): core + extended (admin hidden)
 * - 'all': everything
 * - 'core': core only
 * Any comma/plus-separated list of tiers is also honored (e.g. 'core,admin').
 */
export function resolveAllowedTiers(selection?: string | null): ReadonlySet<ToolTier> {
  if (!selection) return DEFAULT_TIERS;
  const normalized = selection.trim().toLowerCase();
  if (normalized === 'all') return ALL_TIERS;
  if (normalized === '' || normalized === 'default' || normalized === 'core+extended') return DEFAULT_TIERS;
  const tiers = normalized
    .split(/[+,\s]+/)
    .filter((token): token is ToolTier => token === 'core' || token === 'extended' || token === 'admin');
  return tiers.length > 0 ? new Set(tiers) : DEFAULT_TIERS;
}

export function isToolVisibleAtTier(op: Operation, allowed: ReadonlySet<ToolTier>): boolean {
  return allowed.has(effectiveToolTier(op));
}
