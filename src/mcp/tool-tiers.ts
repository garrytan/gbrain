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
  'get_skillpack',
  'sync_brain',
  'route_memory_writeback',
  'get_timeline',
  'add_timeline_entry',
  'add_link',
  'list_pages',
  'get_stats',
  'tool_search',
]);

const ADMIN_TOOL_NAMES = new Set<string>([
  'capture_agent_session_memory',
  'evaluate_raw_access',
  'get_source',
  'ingest_connector_item',
  'list_source_items',
  'list_sources',
  'pause_source_processing',
  'plan_agent_session_activation',
  'preview_agent_session_memory',
  'preview_raw_canonical_document',
  'preview_raw_ingest',
  'preview_source_registration',
  'record_connector_failure',
  'record_connector_item_deletion',
  'record_connector_sync_success',
  'register_connector_source',
  'register_source',
  'request_raw_source_chunks',
  'resolve_source_policy',
  'revoke_source_consent',
]);

/**
 * Control-plane / governance / source-registry / maintenance families. These are hidden from
 * the default stdio catalog (they bury the daily-driver tools and are higher-risk to call
 * freely) and are blocked by named MCP dispatch unless their tier is explicitly enabled. Matched
 * by substring so the classification stays robust as ops are added.
 */
const ADMIN_NAME_FRAGMENTS = [
  'redaction',
  'memory_realm',
  'memory_session',
  'memory_mutation',
  'mutation_event',
  'patch_candidate',
  'lifecycle',
  'canonical_handoff',
  'canonical_target_proposal',
  'raw_data',
  'raw_access',
  'raw_source',
  'source_grant',
  'write_grant',
  'grant_policy',
  'connector',
  'dream_cycle',
  'rerun_memory_job',
  'memory_operations_health',
  'audit_brain_loop',
  'physical_delete',
  'pause_source_processing',
  'revoke_source_consent',
  'resolve_source_policy',
];

function isAdminToolName(name: string): boolean {
  return ADMIN_NAME_FRAGMENTS.some(fragment => name.includes(fragment));
}

/**
 * Effective tier for an operation. An explicit `tier` on the operation always wins; otherwise
 * the core set and the admin classifier decide, defaulting to 'extended'.
 */
export function effectiveToolTier(op: Operation): ToolTier {
  if (op.tier) return op.tier;
  if (CORE_TOOLS.has(op.name)) return 'core';
  if (ADMIN_TOOL_NAMES.has(op.name)) return 'admin';
  if (isAdminToolName(op.name)) return 'admin';
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
