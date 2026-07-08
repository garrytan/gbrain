import { type Operation, OperationError } from '../core/operations.ts';
import { effectiveToolTier, resolveAllowedTiers, type ToolTier } from './tool-tiers.ts';

export type McpSurfaceProfileName = 'stdio' | 'http_local' | 'review_local' | 'http_remote' | 'edge_remote';
export type McpSurfaceCapability = 'raw_source' | 'canonical_write';
export type McpSurfaceTimeoutClass = 'interactive' | 'http_request' | 'edge_request';
export type McpSurfaceCorsPolicy = 'none' | 'configured_origins' | 'edge_cors';
export type McpSurfaceBodySizePolicy = 'stdio_frame_budget' | 'http_1mb' | 'edge_platform';
export type McpSurfaceRequestLogPolicy = 'stderr' | 'mcp_request_log' | 'edge_request_log';

export type McpSurfaceProfileDefinition = {
  name: McpSurfaceProfileName;
  description: string;
  defaultTierSelection: string;
  allowedOperationNames?: readonly string[];
  forbiddenOperationNames: readonly string[];
  allowedCapabilities: readonly McpSurfaceCapability[];
  timeoutClass: McpSurfaceTimeoutClass;
  corsPolicy: McpSurfaceCorsPolicy;
  bodySizePolicy: McpSurfaceBodySizePolicy;
  requestLogPolicy: McpSurfaceRequestLogPolicy;
};

export type ResolvedMcpSurfaceProfile = McpSurfaceProfileDefinition & {
  visibleTiers: ReadonlySet<ToolTier>;
  callableTiers: ReadonlySet<ToolTier>;
};

export type McpSurfaceDecision = {
  profile: McpSurfaceProfileName;
  visible: boolean;
  callable: boolean;
  effective_tier: ToolTier;
  required_capabilities: McpSurfaceCapability[];
  denial_reasons: string[];
};

export type OperationSurfaceProfileExposure = {
  effective_tier: ToolTier;
  required_capabilities: McpSurfaceCapability[];
  capability_classification: 'explicit' | 'implicit_read_only' | 'unclassified_mutating';
  visible_profiles: McpSurfaceProfileName[];
  callable_profiles: McpSurfaceProfileName[];
  forbidden_profiles: McpSurfaceProfileName[];
  decisions: Record<McpSurfaceProfileName, Pick<McpSurfaceDecision, 'visible' | 'callable' | 'denial_reasons'>>;
};

export const MCP_SURFACE_PROFILE_NAMES = ['stdio', 'http_local', 'review_local', 'http_remote', 'edge_remote'] as const satisfies readonly McpSurfaceProfileName[];

const REMOTE_FORBIDDEN_OPERATION_NAMES = ['admin_put_page', 'file_upload', 'get_raw_data'] as const;

const EDGE_FORBIDDEN_OPERATION_NAMES = [...REMOTE_FORBIDDEN_OPERATION_NAMES, 'sync_brain', 'get_skillpack'] as const;

const REVIEW_LOCAL_OPERATION_NAMES = [
  'get_memory_candidate_entry',
  'list_memory_candidate_entries',
  'read_candidate_context',
  'reject_memory_candidate_entry',
  'verify_memory_candidate_entry',
] as const;

const CANONICAL_WRITE_MUTATING_OPERATIONS = [
  'add_link',
  'add_tag',
  'add_timeline_entry',
  'admin_put_page',
  'advance_memory_candidate_status',
  'apply_memory_patch_candidate',
  'apply_memory_redaction_plan',
  'approve_canonical_target_proposal',
  'approve_memory_redaction_plan',
  'attach_memory_realm_to_session',
  'bind_memory_candidate_target',
  'build_context_atlas',
  'build_context_map',
  'capture_agent_session_memory',
  'capture_map_derived_candidates',
  'close_memory_session',
  'complete_canonical_handoff',
  'complete_canonical_target_proposal_binding',
  'create_canonical_target_proposal',
  'create_memory_candidate_entry',
  'create_memory_patch_candidate',
  'create_memory_redaction_plan',
  'create_memory_session',
  'delete_memory_candidate_entry',
  'delete_page',
  'delete_personal_episode_entry',
  'delete_profile_memory_entry',
  'dry_run_memory_mutation',
  'file_upload',
  'finalize_memory_candidate',
  'ingest_connector_item',
  'log_ingest',
  'pause_source_processing',
  'plan_lifecycle_purge',
  'promote_memory_candidate_entry',
  'propose_compile_debt_patches',
  'propose_procedural_candidates',
  'purge_lifecycle_memory',
  'put_page',
  'put_raw_data',
  'rebuild_note_manifest',
  'rebuild_note_sections',
  'record_attempt',
  'record_canonical_handoff',
  'record_connector_failure',
  'record_connector_item_deletion',
  'record_connector_sync_success',
  'record_decision',
  'record_memory_mutation_event',
  'record_personal_episode',
  'record_retrieval_trace',
  'remember',
  'refresh_task_working_set',
  'register_connector_source',
  'register_source',
  'reject_canonical_target_proposal',
  'reject_memory_candidate_entry',
  'reject_memory_redaction_plan',
  'remove_link',
  'remove_tag',
  'rerun_memory_job',
  'resolve_memory_candidate_contradiction',
  'restore_lifecycle_memory',
  'reverify_code_claims',
  'revert_version',
  'review_lifecycle_purge_plan',
  'review_memory_patch_candidate',
  'revoke_source_consent',
  'route_memory_writeback',
  'run_dream_cycle_maintenance',
  'run_watched_questions',
  'start_task',
  'supersede_memory_candidate_entry',
  'sync_brain',
  'update_task',
  'unwatch_question',
  'upsert_memory_realm',
  'upsert_profile_memory_entry',
  'verify_memory_candidate_entry',
  'watch_question',
  'write_personal_episode_entry',
  'write_profile_memory_entry',
] as const;

const RAW_SOURCE_OPERATION_NAMES = [
  'evaluate_raw_access',
  'evaluate_session_source_grant',
  'get_raw_data',
  'get_source',
  'list_source_items',
  'list_sources',
  'preview_raw_canonical_document',
  'preview_raw_ingest',
  'preview_source_registration',
  'request_raw_source_chunks',
  'resolve_source_policy',
] as const;

export const SURFACE_CAPABILITY_REQUIREMENTS_BY_OPERATION: Readonly<Record<string, readonly McpSurfaceCapability[]>> = Object.freeze({
  ...Object.fromEntries(CANONICAL_WRITE_MUTATING_OPERATIONS.map(name => [name, ['canonical_write'] as const])),
  ...Object.fromEntries(RAW_SOURCE_OPERATION_NAMES.map(name => [name, ['raw_source'] as const])),
});

export const MCP_SURFACE_PROFILES: Record<McpSurfaceProfileName, McpSurfaceProfileDefinition> = {
  stdio: {
    name: 'stdio',
    description: 'Local stdio MCP surface for the owner agent.',
    defaultTierSelection: 'default',
    forbiddenOperationNames: [],
    allowedCapabilities: ['canonical_write', 'raw_source'],
    timeoutClass: 'interactive',
    corsPolicy: 'none',
    bodySizePolicy: 'stdio_frame_budget',
    requestLogPolicy: 'stderr',
  },
  http_local: {
    name: 'http_local',
    description: 'Built-in HTTP MCP surface for local or explicitly trusted clients.',
    defaultTierSelection: 'default',
    forbiddenOperationNames: REMOTE_FORBIDDEN_OPERATION_NAMES,
    allowedCapabilities: ['canonical_write', 'raw_source'],
    timeoutClass: 'http_request',
    corsPolicy: 'configured_origins',
    bodySizePolicy: 'http_1mb',
    requestLogPolicy: 'mcp_request_log',
  },
  review_local: {
    name: 'review_local',
    description: 'Built-in local HTTP review surface for Memory Inbox triage.',
    defaultTierSelection: 'default',
    allowedOperationNames: REVIEW_LOCAL_OPERATION_NAMES,
    forbiddenOperationNames: REMOTE_FORBIDDEN_OPERATION_NAMES,
    allowedCapabilities: ['canonical_write', 'raw_source'],
    timeoutClass: 'http_request',
    corsPolicy: 'configured_origins',
    bodySizePolicy: 'http_1mb',
    requestLogPolicy: 'mcp_request_log',
  },
  http_remote: {
    name: 'http_remote',
    description: 'Built-in HTTP MCP surface when exposed to remote clients.',
    defaultTierSelection: 'default',
    forbiddenOperationNames: REMOTE_FORBIDDEN_OPERATION_NAMES,
    allowedCapabilities: ['canonical_write', 'raw_source'],
    timeoutClass: 'http_request',
    corsPolicy: 'configured_origins',
    bodySizePolicy: 'http_1mb',
    requestLogPolicy: 'mcp_request_log',
  },
  edge_remote: {
    name: 'edge_remote',
    description: 'Supabase Edge MCP surface for remote clients.',
    defaultTierSelection: 'default',
    forbiddenOperationNames: EDGE_FORBIDDEN_OPERATION_NAMES,
    allowedCapabilities: ['canonical_write', 'raw_source'],
    timeoutClass: 'edge_request',
    corsPolicy: 'edge_cors',
    bodySizePolicy: 'edge_platform',
    requestLogPolicy: 'edge_request_log',
  },
};

export function resolveMcpSurfaceProfile(name: McpSurfaceProfileName, options: { toolTierSelection?: string | null } = {}): ResolvedMcpSurfaceProfile {
  const profile = MCP_SURFACE_PROFILES[name];
  const tiers = resolveAllowedTiers(options.toolTierSelection ?? profile.defaultTierSelection);
  return {
    ...profile,
    visibleTiers: tiers,
    callableTiers: tiers,
  };
}

export function surfaceTokenCapabilitiesFromScopes(scopes: readonly string[] | undefined): ReadonlySet<McpSurfaceCapability> {
  const capabilities = new Set<McpSurfaceCapability>();
  for (const scope of scopes ?? []) {
    switch (scope.trim()) {
      case 'canonical_write':
      case 'mbrain:canonical_write':
        capabilities.add('canonical_write');
        break;
      case 'raw_source':
      case 'mbrain:raw_source':
        capabilities.add('raw_source');
        break;
    }
  }
  return capabilities;
}

export function surfaceCapabilityClassificationForOperation(operation: Pick<Operation, 'name' | 'mutating'>): {
  classification: OperationSurfaceProfileExposure['capability_classification'];
  requiredCapabilities: McpSurfaceCapability[];
} {
  const explicit = SURFACE_CAPABILITY_REQUIREMENTS_BY_OPERATION[operation.name];
  if (explicit) {
    return {
      classification: 'explicit',
      requiredCapabilities: [...explicit].sort(),
    };
  }
  return {
    classification: operation.mutating === true ? 'unclassified_mutating' : 'implicit_read_only',
    requiredCapabilities: [],
  };
}

export function requiredSurfaceCapabilitiesForOperation(operation: Pick<Operation, 'name' | 'mutating'>): McpSurfaceCapability[] {
  return surfaceCapabilityClassificationForOperation(operation).requiredCapabilities;
}

export function findMcpSurfaceProfileClassificationFailures(operations: readonly Operation[]): string[] {
  const failures: string[] = [];
  for (const operation of operations) {
    const classification = surfaceCapabilityClassificationForOperation(operation);
    if (classification.classification === 'unclassified_mutating') {
      failures.push(`surface_capability_unclassified_mutating:${operation.name}`);
    }
    const defaultRemoteProfiles = MCP_SURFACE_PROFILE_NAMES
      .map(name => resolveMcpSurfaceProfile(name))
      .filter(profile => profile.name === 'http_local' || profile.name === 'http_remote' || profile.name === 'edge_remote');
    const remoteCallable = defaultRemoteProfiles.some(profile => getMcpSurfaceDecision(operation, profile).callable);
    if (operation.mutating === true && remoteCallable && classification.requiredCapabilities.length === 0) {
      failures.push(`surface_capability_missing_remote_mutation:${operation.name}`);
    }
  }
  return [...new Set(failures)].sort();
}

export function isToolVisibleInSurfaceProfile(operation: Operation, profile: ResolvedMcpSurfaceProfile): boolean {
  return isOperationAllowedByProfile(operation, profile)
    && !profile.forbiddenOperationNames.includes(operation.name)
    && profile.visibleTiers.has(effectiveToolTier(operation));
}

export function getMcpSurfaceDecision(operation: Operation, profile: ResolvedMcpSurfaceProfile, options: { tokenCapabilities?: ReadonlySet<McpSurfaceCapability> } = {}): McpSurfaceDecision {
  const effective_tier = effectiveToolTier(operation);
  const required_capabilities = requiredSurfaceCapabilitiesForOperation(operation);
  const denial_reasons: string[] = [];

  if (!isOperationAllowedByProfile(operation, profile)) {
    denial_reasons.push('surface_operation_not_allowed');
  }
  if (profile.forbiddenOperationNames.includes(operation.name)) {
    denial_reasons.push('forbidden_operation');
  }
  if (!profile.callableTiers.has(effective_tier)) {
    denial_reasons.push('tier_not_callable');
  }

  const allowedCapabilities = new Set(profile.allowedCapabilities);
  const tokenCapabilities = options.tokenCapabilities;
  for (const capability of required_capabilities) {
    if (!allowedCapabilities.has(capability)) {
      denial_reasons.push(`surface_disallows_${capability}`);
      continue;
    }
    if (tokenCapabilities && !tokenCapabilities.has(capability)) {
      denial_reasons.push(`token_missing_${capability}`);
    }
  }

  return {
    profile: profile.name,
    visible: isToolVisibleInSurfaceProfile(operation, profile),
    callable: denial_reasons.length === 0,
    effective_tier,
    required_capabilities,
    denial_reasons: denial_reasons.sort(),
  };
}

function isOperationAllowedByProfile(operation: Operation, profile: ResolvedMcpSurfaceProfile): boolean {
  return profile.allowedOperationNames === undefined || profile.allowedOperationNames.includes(operation.name);
}

export function assertToolCallableInSurfaceProfile(operation: Operation, profile: ResolvedMcpSurfaceProfile, options: { tokenCapabilities?: ReadonlySet<McpSurfaceCapability> } = {}): void {
  const decision = getMcpSurfaceDecision(operation, profile, options);
  if (decision.callable) return;
  throw new OperationError('permission_denied', `Tool ${operation.name} is not callable on MCP surface ${profile.name}: ${decision.denial_reasons.join(', ')}`, 'Use a surface profile and token scopes that explicitly allow this operation, or use the local CLI repair path when appropriate.');
}

export function buildOperationSurfaceProfileExposure(operation: Operation): OperationSurfaceProfileExposure {
  const profiles = MCP_SURFACE_PROFILE_NAMES.map((name) => resolveMcpSurfaceProfile(name));
  const decisions = profiles.map((profile) => getMcpSurfaceDecision(operation, profile));
  const classification = surfaceCapabilityClassificationForOperation(operation);
  return {
    effective_tier: effectiveToolTier(operation),
    required_capabilities: classification.requiredCapabilities,
    capability_classification: classification.classification,
    visible_profiles: decisions.filter((decision) => decision.visible).map((decision) => decision.profile),
    callable_profiles: decisions.filter((decision) => decision.callable).map((decision) => decision.profile),
    forbidden_profiles: decisions.filter((decision) => decision.denial_reasons.includes('forbidden_operation')).map((decision) => decision.profile),
    decisions: Object.fromEntries(
      decisions.map((decision) => [
        decision.profile,
        {
          visible: decision.visible,
          callable: decision.callable,
          denial_reasons: decision.denial_reasons,
        },
      ]),
    ) as OperationSurfaceProfileExposure['decisions'],
  };
}
