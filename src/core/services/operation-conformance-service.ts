import { createHash } from 'crypto';
import { operationToMcpTool } from '../../mcp/tool-schema.ts';
import type { CliCommandCatalog, CliCommandExposureMode } from '../../cli.ts';
import {
  getOperationCapabilityRequirements,
  type Operation,
  type ParamDef,
} from '../operations.ts';
import type { RetrievalQualityGateReport } from '../evaluation/retrieval-quality-gate.ts';

export const OPERATION_GOLDEN_MANIFEST_SCHEMA_VERSION = 1;

export type CliExposureMode =
  | 'cli_shared'
  | 'cli_direct_engine'
  | 'cli_direct_no_engine'
  | 'cli_only'
  | 'mcp'
  | 'not_cli';

export type OperationGoldenManifest = {
  schema_version: typeof OPERATION_GOLDEN_MANIFEST_SCHEMA_VERSION;
  generated_from: 'live_operation_registry';
  summary: {
    operation_count: number;
    mcp_operation_count: number;
    cli_shared_count: number;
    cli_direct_count: number;
    cli_only_count: number;
    not_cli_count: number;
    mutating_count: number;
    read_only_count: number;
  };
  cli_commands: OperationManifestCliCommand[];
  operations: OperationGoldenManifestEntry[];
};

export type OperationManifestCliCommand = {
  command: string;
  mode: CliCommandExposureMode;
  operation_name?: string;
  operation_spec_name?: string;
  reason?: string;
};

export type OperationGoldenManifestEntry = {
  name: string;
  description: string;
  discovery?: {
    compact_description: boolean;
    description?: string;
  };
  mutating: boolean;
  capability_required: string[];
  capability_visibility: {
    requirements: string[];
  };
  params: Record<string, NormalizedParamDef>;
  cli_exposure: {
    mode: CliExposureMode;
    command?: string;
    reason?: string;
  };
  mcp: {
    read_only: boolean;
    destructive: boolean;
    open_world: boolean;
    required_params: string[];
  };
  compact_schema_hash: string;
  full_schema_hash: string;
  memory_verb_families: string[];
  mutation_aliases: string[];
};

export type NormalizedParamDef = {
  type: string[];
  required: boolean;
  nullable: boolean;
  description?: string;
  compact_description?: boolean;
  capability_required?: string;
  default?: unknown;
  enum?: string[];
  enum_error_hint?: string;
  compact_enum?: boolean;
  items?: NormalizedParamDef;
};

export const MEMORY_VERB_MATRIX = {
  discover_search: ['search', 'query', 'retrieve_context', 'plan_retrieval_request', 'select_retrieval_route'],
  read_evidence: ['read_context', 'get_page', 'list_pages', 'get_memory_candidate_entry', 'list_memory_candidate_entries', 'read_candidate_context'],
  plan_activate: ['classify_memory_scenario', 'select_activation_policy', 'plan_scenario_memory_request', 'plan_agent_session_activation', 'preview_agent_session_memory'],
  route_writeback: ['route_memory_writeback'],
  canonical_page_write: ['put_page'],
  canonical_non_page_personal_store: ['upsert_profile_memory_entry', 'record_personal_episode'],
  candidate_lifecycle: [
    'create_memory_candidate_entry',
    'advance_memory_candidate_status',
    'verify_memory_candidate_entry',
    'reject_memory_candidate_entry',
    'preflight_promote_memory_candidate',
    'promote_memory_candidate_entry',
    'supersede_memory_candidate_entry',
    'resolve_memory_candidate_contradiction',
  ],
  patch_governed_mutation: ['create_memory_patch_candidate', 'review_memory_patch_candidate', 'dry_run_memory_mutation', 'apply_memory_patch_candidate'],
  profile_episode: ['write_profile_memory_entry', 'upsert_profile_memory_entry', 'delete_profile_memory_entry', 'record_personal_episode', 'write_personal_episode_entry', 'delete_personal_episode_entry'],
  realm_session_ledger: ['upsert_memory_realm', 'create_memory_session', 'attach_memory_realm_to_session', 'close_memory_session', 'list_memory_mutation_events', 'record_memory_mutation_event'],
  redaction_forget: ['create_memory_redaction_plan', 'approve_memory_redaction_plan', 'reject_memory_redaction_plan', 'apply_memory_redaction_plan'],
  maintenance_health: ['run_dream_cycle_maintenance', 'get_memory_operations_health', 'rerun_memory_job'],
} as const satisfies Record<string, readonly string[]>;

export const MEMORY_AUTHORITY_GATES = {
  put_page: {
    authority_gate: 'direct_page_write_with_source_attribution_and_expected_hash',
    source_param: 'source_refs',
    snapshot_param: 'expected_content_hash',
    ledger_operation: 'put_page',
  },
  route_memory_writeback: {
    authority_gate: 'router_decision_before_agent_mediated_page_writeback',
    source_param: 'source_refs',
    snapshot_param: 'target_snapshot_hash',
    ledger_operation: null,
  },
  write_profile_memory_entry: {
    authority_gate: 'personal_profile_write_with_source_ref_and_lookup_preflight',
    source_param: 'source_ref',
    snapshot_param: null,
    ledger_operation: 'write_profile_memory_entry',
  },
  upsert_profile_memory_entry: {
    authority_gate: 'direct_personal_profile_store_with_source_ref',
    source_param: 'source_ref',
    snapshot_param: null,
    ledger_operation: 'upsert_profile_memory_entry',
  },
  write_personal_episode_entry: {
    authority_gate: 'personal_episode_write_with_source_ref_and_lookup_preflight',
    source_param: 'source_ref',
    snapshot_param: null,
    ledger_operation: 'write_personal_episode_entry',
  },
  record_personal_episode: {
    authority_gate: 'direct_personal_episode_store_with_source_ref',
    source_param: 'source_ref',
    snapshot_param: null,
    ledger_operation: 'record_personal_episode',
  },
  dry_run_memory_mutation: {
    authority_gate: 'control_plane_dry_run_before_apply',
    source_param: 'source_refs',
    snapshot_param: 'expected_target_snapshot_hash',
    ledger_operation: 'dry_run_memory_mutation',
  },
  apply_memory_patch_candidate: {
    authority_gate: 'reviewed_patch_candidate_apply',
    source_param: 'source_refs',
    snapshot_param: null,
    ledger_operation: 'apply_memory_patch_candidate',
  },
} as const satisfies Record<string, {
  authority_gate: string;
  source_param: string | null;
  snapshot_param: string | null;
  ledger_operation: string | null;
}>;

export const REQUIRED_MUTATION_ALIASES = {
  create_memory_redaction_plan: ['create_redaction_plan'],
  approve_memory_redaction_plan: [],
  reject_memory_redaction_plan: [],
  apply_memory_redaction_plan: ['execute_redaction_plan'],
} as const satisfies Record<string, readonly string[]>;

export type RetrievalQualityScorecardInput = {
  status: 'pass' | 'fail' | 'skip';
  thresholds: {
    top1_match_rate: number;
    recall_at_10: number;
  };
  metrics: {
    top1_match_rate: number;
    recall_at_10: number;
  };
  failures: string[];
};

export type ConformanceScorecard = {
  schema_version: 1;
  status: 'pass' | 'fail';
  hard_failures: string[];
  dimensions: Array<{
    id:
      | 'operation_catalog_integrity'
      | 'mcp_cli_compatibility'
      | 'capability_filtering'
      | 'retrieval_quality'
      | 'memory_authority'
      | 'writeback_governance'
      | 'mutation_control_plane'
      | 'replay_evaluation';
    numerator: number;
    denominator: number;
    status: 'pass' | 'fail' | 'skip';
    notes: string[];
  }>;
};

export function buildOperationGoldenManifest(input: {
  operations: Operation[];
  cliCatalog: CliCommandCatalog;
}): OperationGoldenManifest {
  const entries = [...input.operations]
    .sort((a, b) => compareAscii(a.name, b.name))
    .map(operation => buildOperationManifestEntry(operation, input.cliCatalog));
  const cliCommands = normalizeCliCommands(input.cliCatalog);
  const summary = {
    operation_count: entries.length,
    mcp_operation_count: entries.length,
    cli_shared_count: cliCommands.filter(entry => entry.mode === 'cli_shared').length,
    cli_direct_count: cliCommands.filter(entry => entry.mode === 'cli_direct_engine' || entry.mode === 'cli_direct_no_engine').length,
    cli_only_count: cliCommands.filter(entry => entry.mode === 'cli_only').length,
    not_cli_count: entries.filter(entry => entry.cli_exposure.mode === 'not_cli').length,
    mutating_count: entries.filter(entry => entry.mutating).length,
    read_only_count: entries.filter(entry => !entry.mutating).length,
  };

  return {
    schema_version: OPERATION_GOLDEN_MANIFEST_SCHEMA_VERSION,
    generated_from: 'live_operation_registry',
    summary,
    cli_commands: cliCommands,
    operations: entries,
  };
}

export function findOperationConformanceHardFailures(manifest: OperationGoldenManifest): string[] {
  return uniqueSorted([
    ...validateOperationCatalogIntegrity(manifest),
    ...validateMcpCliCompatibility(manifest),
    ...validateCapabilityFilteringDimension(manifest),
  ]);
}

function validateOperationCatalogIntegrity(manifest: OperationGoldenManifest): string[] {
  const failures: string[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.operations) {
    if (seen.has(entry.name)) failures.push(`duplicate_operation:${entry.name}`);
    seen.add(entry.name);
    if (!entry.full_schema_hash.match(/^[a-f0-9]{64}$/)) failures.push(`missing_full_schema_hash:${entry.name}`);
  }
  return failures.sort(compareAscii);
}

export function validateMcpRequiredParamParity(manifest: OperationGoldenManifest): string[] {
  const failures: string[] = [];
  for (const entry of manifest.operations) {
    const operationRequired = Object.entries(entry.params)
      .filter(([, param]) => param.required)
      .map(([name]) => name)
      .sort(compareAscii);
    const mcpRequired = [...entry.mcp.required_params].sort(compareAscii);
    if (stableStringify(operationRequired) !== stableStringify(mcpRequired)) {
      failures.push(`mcp_required_params_drift:${entry.name}`);
    }
  }
  return failures.sort(compareAscii);
}

function validateMcpCliCompatibility(manifest: OperationGoldenManifest): string[] {
  const failures: string[] = [];
  const commandNames = new Set<string>();
  for (const command of manifest.cli_commands) {
    if (commandNames.has(command.command)) failures.push(`duplicate_cli_command:${command.command}`);
    commandNames.add(command.command);
  }
  for (const entry of manifest.operations) {
    if (entry.cli_exposure.mode !== 'mcp' && entry.cli_exposure.mode !== 'not_cli' && !entry.cli_exposure.command) {
      failures.push(`cli_exposed_operation_without_command:${entry.name}`);
    }
    if (entry.cli_exposure.mode === 'mcp' && entry.cli_exposure.command) {
      failures.push(`mcp_only_operation_has_cli_command:${entry.name}`);
    }
    if (entry.cli_exposure.mode === 'not_cli' && entry.cli_exposure.reason !== 'cli hint is hidden') {
      failures.push(`unexpected_not_cli_operation:${entry.name}`);
    }
    if (entry.mcp.read_only === entry.mutating) {
      failures.push(`mcp_read_only_mutating_drift:${entry.name}`);
    }
  }
  return uniqueSorted([
    ...failures,
    ...validateMcpRequiredParamParity(manifest),
  ]);
}

function validateCapabilityFilteringDimension(manifest: OperationGoldenManifest): string[] {
  const failures: string[] = [];
  for (const entry of manifest.operations) {
    const declared = [...entry.capability_required].sort(compareAscii);
    const visible = [...entry.capability_visibility.requirements].sort(compareAscii);
    if (stableStringify(declared) !== stableStringify(visible)) {
      failures.push(`capability_visibility_drift:${entry.name}`);
    }
    const paramCapabilities = collectParamCapabilities(entry.params).sort(compareAscii);
    for (const capability of paramCapabilities) {
      if (!visible.includes(capability)) {
        failures.push(`param_capability_missing_from_visibility:${entry.name}:${capability}`);
      }
    }
  }
  return failures.sort(compareAscii);
}

export function validateMemoryVerbMatrix(operationsByName: Record<string, Operation>): string[] {
  const failures: string[] = [];
  for (const [family, operationNames] of Object.entries(MEMORY_VERB_MATRIX)) {
    for (const operationName of operationNames) {
      if (!operationsByName[operationName]) {
        failures.push(`memory_verb_missing_operation:${family}:${operationName}`);
      }
    }
  }
  return failures.sort(compareAscii);
}

export function validateMemoryAuthorityGates(operationsByName: Record<string, Operation>): string[] {
  const failures: string[] = [];
  for (const [operationName, gate] of Object.entries(MEMORY_AUTHORITY_GATES)) {
    const operation = operationsByName[operationName];
    if (!operation) {
      failures.push(`authority_gate_missing_operation:${operationName}`);
      continue;
    }
    if (operation.mutating !== true) failures.push(`authority_gate_operation_not_mutating:${operationName}`);
    if (gate.source_param && !operation.params[gate.source_param]) {
      failures.push(`authority_gate_missing_source_param:${operationName}:${gate.source_param}`);
    }
    if (gate.snapshot_param && !operation.params[gate.snapshot_param]) {
      failures.push(`authority_gate_missing_snapshot_param:${operationName}:${gate.snapshot_param}`);
    }
  }
  return failures.sort(compareAscii);
}

export function validateMutationNameAlignment(operationsByName: Record<string, Operation>): string[] {
  const failures: string[] = [];
  const ledgerEnum = enumValues(operationsByName.record_memory_mutation_event?.params.operation);
  const listLedgerEnum = enumValues(operationsByName.list_memory_mutation_events?.params.operation);
  const dryRunEnum = enumValues(operationsByName.dry_run_memory_mutation?.params.operation);

  if (ledgerEnum.length === 0) failures.push('mutation_ledger_missing_operation_enum');
  if (stableStringify(ledgerEnum) !== stableStringify(listLedgerEnum)) {
    failures.push('mutation_ledger_list_record_enum_drift');
  }
  for (const operationName of dryRunEnum) {
    if (!ledgerEnum.includes(operationName)) {
      failures.push(`dry_run_operation_missing_from_ledger:${operationName}`);
    }
  }
  for (const gate of Object.values(MEMORY_AUTHORITY_GATES)) {
    if (gate.ledger_operation && !ledgerEnum.includes(gate.ledger_operation)) {
      failures.push(`authority_gate_ledger_operation_missing:${gate.ledger_operation}`);
    }
  }
  for (const [operationName, aliases] of Object.entries(REQUIRED_MUTATION_ALIASES)) {
    if (!operationsByName[operationName]) {
      failures.push(`required_mutation_alias_operation_missing:${operationName}`);
    }
    for (const alias of aliases) {
      if (!ledgerEnum.includes(alias)) {
        failures.push(`required_mutation_alias_missing_from_ledger:${operationName}:${alias}`);
      }
    }
  }
  return failures.sort(compareAscii);
}

export function buildConformanceScorecard(input: {
  manifest: OperationGoldenManifest;
  operationsByName: Record<string, Operation>;
  retrievalQuality: RetrievalQualityScorecardInput;
}): ConformanceScorecard {
  const operationFailures = validateOperationCatalogIntegrity(input.manifest);
  const mcpCliFailures = validateMcpCliCompatibility(input.manifest);
  const capabilityFailures = validateCapabilityFilteringDimension(input.manifest);
  const memoryVerbFailures = validateMemoryVerbMatrix(input.operationsByName);
  const authorityFailures = validateMemoryAuthorityGates(input.operationsByName);
  const mutationFailures = validateMutationNameAlignment(input.operationsByName);
  const replayNotes = input.retrievalQuality.status === 'skip'
    ? ['source-aware retrieval qrels gate skipped']
    : ['source-aware retrieval qrels gate executed'];
  const retrievalFailures = input.retrievalQuality.status === 'fail'
    ? input.retrievalQuality.failures.map(failure => `retrieval_quality:${failure}`)
    : [];
  const hardFailures = uniqueSorted([
    ...operationFailures,
    ...mcpCliFailures,
    ...capabilityFailures,
    ...memoryVerbFailures,
    ...authorityFailures,
    ...mutationFailures,
    ...retrievalFailures,
  ]);

  const manifest = input.manifest;
  const dimensions: ConformanceScorecard['dimensions'] = [
    dimension('operation_catalog_integrity', manifest.operations.length - operationFailures.length, manifest.operations.length, operationFailures),
    dimension('mcp_cli_compatibility', manifest.operations.length - mcpCliFailures.length, manifest.operations.length, mcpCliFailures),
    dimension('capability_filtering', manifest.operations.length - capabilityFailures.length, manifest.operations.length, capabilityFailures),
    dimension(
      'retrieval_quality',
      input.retrievalQuality.status === 'pass' ? 2 : 0,
      2,
      input.retrievalQuality.status === 'pass'
        ? []
        : input.retrievalQuality.failures,
      input.retrievalQuality.status === 'skip' ? 'skip' : undefined,
    ),
    dimension('memory_authority', Object.keys(MEMORY_VERB_MATRIX).length - memoryVerbFailures.length, Object.keys(MEMORY_VERB_MATRIX).length, memoryVerbFailures),
    dimension('writeback_governance', Object.keys(MEMORY_AUTHORITY_GATES).length - authorityFailures.length, Object.keys(MEMORY_AUTHORITY_GATES).length, authorityFailures),
    dimension('mutation_control_plane', 3 - mutationFailures.length, 3, mutationFailures),
    dimension('replay_evaluation', input.retrievalQuality.status === 'skip' ? 0 : 1, 1, replayNotes, input.retrievalQuality.status === 'skip' ? 'skip' : 'pass'),
  ];

  return {
    schema_version: 1,
    status: hardFailures.length === 0 ? 'pass' : 'fail',
    hard_failures: hardFailures,
    dimensions,
  };
}

export function formatConformanceScorecardSummary(scorecard: ConformanceScorecard): string {
  const lines = [
    `MBrain conformance scorecard: ${scorecard.status}`,
    `hard_failures: ${scorecard.hard_failures.length === 0 ? 'none' : scorecard.hard_failures.length}`,
  ];
  for (const entry of scorecard.dimensions) {
    const notes = entry.notes.length > 0 ? ` (${entry.notes.join('; ')})` : '';
    lines.push(`${entry.id}: ${entry.status} ${entry.numerator}/${entry.denominator}${notes}`);
  }
  return `${lines.join('\n')}\n`;
}

export function retrievalQualityScorecardInputFromGateReport(
  report: RetrievalQualityGateReport,
): RetrievalQualityScorecardInput {
  return {
    status: report.status === 'passed' ? 'pass' : 'fail',
    thresholds: report.thresholds,
    metrics: {
      top1_match_rate: report.top1_match_rate,
      recall_at_10: report.recall_at_10,
    },
    failures: report.failures.map(failure => `${failure.id}:${failure.reason_codes.join('+')}`),
  };
}

function normalizeCliCommands(cliCatalog: CliCommandCatalog): OperationManifestCliCommand[] {
  return Object.values(cliCatalog.commands)
    .map(command => ({
      command: command.command,
      mode: command.mode,
      ...(command.operation_name ? { operation_name: command.operation_name } : {}),
      ...(command.operation_spec_name ? { operation_spec_name: command.operation_spec_name } : {}),
      ...(command.reason ? { reason: command.reason } : {}),
    }))
    .sort((a, b) => compareAscii(a.command, b.command));
}

function buildOperationManifestEntry(operation: Operation, cliCatalog: CliCommandCatalog): OperationGoldenManifestEntry {
  const fullTool = operationToMcpTool(operation, { compact: false });
  const compactTool = operationToMcpTool(operation, { compact: true });
  const capabilityRequirements = getOperationCapabilityRequirements(operation).sort(compareAscii);
  const command = operation.cliHints?.name;
  const commandEntry = command ? cliCatalog.commands[command] : undefined;
  const cliExposure = operation.cliHints?.hidden
    ? { mode: 'not_cli' as const, reason: 'cli hint is hidden' }
    : commandEntry
      ? { mode: commandEntry.mode, command, reason: commandEntry.reason }
      : command
        ? { mode: 'cli_shared' as const, command }
        : { mode: 'mcp' as const, reason: 'mcp operation without CLI command' };

  return {
    name: operation.name,
    description: operation.description,
    ...(operation.discovery
      ? {
        discovery: {
          compact_description: operation.discovery.compactDescription === true,
          ...(operation.discovery.description ? { description: operation.discovery.description } : {}),
        },
      }
      : {}),
    mutating: operation.mutating === true,
    capability_required: capabilityRequirements,
    capability_visibility: {
      requirements: capabilityRequirements,
    },
    params: Object.fromEntries(
      Object.entries(operation.params)
        .sort(([a], [b]) => compareAscii(a, b))
        .map(([name, param]) => [name, normalizeParamDef(param)]),
    ),
    cli_exposure: cliExposure,
    mcp: {
      read_only: fullTool.annotations?.readOnlyHint === true,
      destructive: fullTool.annotations?.destructiveHint === true,
      open_world: fullTool.annotations?.openWorldHint === true,
      required_params: [...(fullTool.inputSchema.required ?? [])].sort(compareAscii),
    },
    compact_schema_hash: hashStable(compactTool.inputSchema),
    full_schema_hash: hashStable(fullTool.inputSchema),
    memory_verb_families: memoryVerbFamiliesForOperation(operation.name),
    mutation_aliases: mutationAliasesForOperation(operation.name),
  };
}

function normalizeParamDef(param: ParamDef): NormalizedParamDef {
  return {
    type: normalizeParamTypes(param.type),
    required: param.required === true,
    nullable: param.nullable === true,
    ...(param.description ? { description: param.description } : {}),
    ...(param.compactDescription !== undefined ? { compact_description: param.compactDescription } : {}),
    ...(param.capabilityRequired ? { capability_required: param.capabilityRequired } : {}),
    ...(param.default !== undefined ? { default: normalizeJsonValue(param.default) } : {}),
    ...(param.enum ? { enum: [...param.enum] } : {}),
    ...(param.enumErrorHint ? { enum_error_hint: param.enumErrorHint } : {}),
    ...(param.compactEnum !== undefined ? { compact_enum: param.compactEnum } : {}),
    ...(param.items ? { items: normalizeParamDef(param.items) } : {}),
  };
}

function normalizeParamTypes(type: ParamDef['type']): string[] {
  return (Array.isArray(type) ? [...type] : [type]).sort(compareAscii);
}

function memoryVerbFamiliesForOperation(operationName: string): string[] {
  return Object.entries(MEMORY_VERB_MATRIX)
    .filter(([, operationNames]) => (operationNames as readonly string[]).includes(operationName))
    .map(([family]) => family)
    .sort(compareAscii);
}

function mutationAliasesForOperation(operationName: string): string[] {
  return [...(REQUIRED_MUTATION_ALIASES[operationName as keyof typeof REQUIRED_MUTATION_ALIASES] ?? [])];
}

function enumValues(param: ParamDef | undefined): string[] {
  return [...(param?.enum ?? [])].sort(compareAscii);
}

function dimension(
  id: ConformanceScorecard['dimensions'][number]['id'],
  numerator: number,
  denominator: number,
  notes: string[],
  forcedStatus?: 'pass' | 'skip',
): ConformanceScorecard['dimensions'][number] {
  const normalizedDenominator = Math.max(1, denominator);
  const normalizedNumerator = Math.max(0, Math.min(numerator, normalizedDenominator));
  return {
    id,
    numerator: normalizedNumerator,
    denominator: normalizedDenominator,
    status: forcedStatus ?? (notes.length === 0 && normalizedNumerator === normalizedDenominator ? 'pass' : 'fail'),
    notes: [...notes].sort(compareAscii),
  };
}

function collectParamCapabilities(params: Record<string, NormalizedParamDef>): string[] {
  const capabilities: string[] = [];
  for (const param of Object.values(params)) {
    collectParamCapabilitiesFromParam(param, capabilities);
  }
  return uniqueSorted(capabilities);
}

function collectParamCapabilitiesFromParam(param: NormalizedParamDef, capabilities: string[]): void {
  if (param.capability_required) capabilities.push(param.capability_required);
  if (param.items) collectParamCapabilitiesFromParam(param.items, capabilities);
}

function hashStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(compareAscii);
}

function normalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => compareAscii(a, b))
        .map(([key, item]) => [key, normalizeJsonValue(item)]),
    );
  }
  return value;
}

function compareAscii(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
