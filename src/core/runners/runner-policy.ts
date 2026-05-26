import type { MaintenanceFailureClass } from '../maintenance/job-runtime.ts';
import {
  buildRawAccessLedgerEntry,
  type RawAccessLedgerEntry,
  type RawAccessPolicy,
} from '../source-registry/raw-access-ledger.ts';
import { evaluateRawAccessRequest } from '../source-registry/raw-access-ledger.ts';
import {
  buildRunnerChunkPayload,
  type RunnerChunkPayload,
  type SourceChunkRecord,
} from '../source-registry/raw-ingest.ts';
import type { RestrictedRunnerKind } from './runner-registry.ts';

export const RUNNER_TASK_TYPES = [
  'assertion_extraction',
  'consolidation_review',
  'contradiction_review',
  'forgetting_review',
  'source_summary',
  'daily_report',
] as const;

export type RunnerTaskType = typeof RUNNER_TASK_TYPES[number];

export const ALLOWED_RUNNER_TOOLS = [
  'read_scoped_source_excerpt',
  'read_assertion_context',
  'create_extracted_claim',
  'propose_assertion_update',
  'propose_supersession',
  'propose_conflict_resolution',
  'propose_expire_archive',
  'draft_source_summary',
  'draft_report_section',
] as const;

export type AllowedRunnerToolName = typeof ALLOWED_RUNNER_TOOLS[number];

export const DENIED_RUNNER_TOOLS = [
  'shell_execute',
  'put_page',
  'file_write',
  'connector_credentials',
  'raw_source_dump',
  'policy_override',
  'direct_purge',
  'canonical_mutation',
] as const;

export type DeniedRunnerToolName = typeof DENIED_RUNNER_TOOLS[number];
export type RunnerToolName = AllowedRunnerToolName | DeniedRunnerToolName | (string & {});
export type RunnerToolDecisionStatus = 'allowed' | 'denied' | 'degraded';

export interface RunnerBudget {
  max_tool_calls?: number;
  used_tool_calls?: number;
  max_input_tokens?: number;
  used_input_tokens?: number;
}

export interface RunnerToolCallPolicyInput {
  task_type: RunnerTaskType | (string & {});
  tool_name: RunnerToolName;
  budget?: RunnerBudget;
}

export interface RunnerToolPolicyDecision {
  status: RunnerToolDecisionStatus;
  failure_class: MaintenanceFailureClass | null;
  reason: string;
  allowed_tools: AllowedRunnerToolName[];
  proposal_only: boolean;
  canonical_mutation_allowed: false;
  connector_credentials_available: false;
}

export interface RunnerRawAccessInput {
  task_type: RunnerTaskType | (string & {});
  runner_kind: RestrictedRunnerKind;
  runner_id: string;
  job_id?: string | null;
  source_id: string;
  source_policy: RawAccessPolicy;
  chunks: readonly SourceChunkRecord[];
  prompt?: string;
  input?: string;
  requested_at?: string;
  budget?: RunnerBudget;
}

export interface RunnerRawAccessResult {
  status: RunnerToolDecisionStatus;
  failure_class: MaintenanceFailureClass | null;
  reason: string;
  payloads: RunnerChunkPayload[];
  ledger_entries: RawAccessLedgerEntry[];
}

const TASK_TOOL_ALLOWLIST: Record<RunnerTaskType, AllowedRunnerToolName[]> = {
  assertion_extraction: [
    'read_scoped_source_excerpt',
    'read_assertion_context',
    'create_extracted_claim',
  ],
  consolidation_review: [
    'read_assertion_context',
    'propose_assertion_update',
    'propose_supersession',
    'propose_conflict_resolution',
  ],
  contradiction_review: [
    'read_assertion_context',
    'propose_conflict_resolution',
    'propose_supersession',
  ],
  forgetting_review: [
    'read_assertion_context',
    'propose_expire_archive',
    'draft_report_section',
  ],
  source_summary: [
    'read_scoped_source_excerpt',
    'draft_source_summary',
  ],
  daily_report: [
    'read_assertion_context',
    'draft_source_summary',
    'draft_report_section',
  ],
};

const REMOTE_RAW_ACCESS_ALLOWED_POLICIES = new Set([
  'remote_redacted_policy_gated',
]);

export function getRunnerToolAllowlist(taskType: RunnerTaskType | (string & {})): AllowedRunnerToolName[] {
  return isRunnerTaskType(taskType) ? [...TASK_TOOL_ALLOWLIST[taskType]] : [];
}

export function evaluateRunnerToolCall(input: RunnerToolCallPolicyInput): RunnerToolPolicyDecision {
  const allowedTools = getRunnerToolAllowlist(input.task_type);
  if (!isRunnerTaskType(input.task_type)) {
    return {
      status: 'denied',
      failure_class: 'policy_denied',
      reason: `runner_task_denied:${input.task_type}`,
      allowed_tools: [],
      proposal_only: false,
      canonical_mutation_allowed: false,
      connector_credentials_available: false,
    };
  }
  if (DENIED_RUNNER_TOOLS.includes(input.tool_name as DeniedRunnerToolName) || !allowedTools.includes(input.tool_name as AllowedRunnerToolName)) {
    return denyTool(input.tool_name, allowedTools);
  }

  if (budgetExhausted(input.budget)) {
    return {
      status: 'degraded',
      failure_class: 'policy_denied',
      reason: 'runner_budget_exhausted',
      allowed_tools: allowedTools,
      proposal_only: false,
      canonical_mutation_allowed: false,
      connector_credentials_available: false,
    };
  }

  return {
    status: 'allowed',
    failure_class: null,
    reason: 'runner_tool_allowed',
    allowed_tools: allowedTools,
    proposal_only: isProposalTool(input.tool_name),
    canonical_mutation_allowed: false,
    connector_credentials_available: false,
  };
}

export function evaluateRunnerRawAccess(input: RunnerRawAccessInput): RunnerRawAccessResult {
  const toolDecision = evaluateRunnerToolCall({
    task_type: input.task_type,
    tool_name: 'read_scoped_source_excerpt',
    budget: input.budget,
  });
  if (toolDecision.status !== 'allowed') {
    return {
      status: toolDecision.status,
      failure_class: toolDecision.failure_class,
      reason: toolDecision.reason,
      payloads: [],
      ledger_entries: input.chunks.length === 0 ? [] : buildLedgerEntries(input, 'deny', toolDecision.reason),
    };
  }

  if (input.chunks.length === 0) {
    return deniedRawAccess(input, 'source_unavailable', 'chunk_scope_required', []);
  }

  if (!runnerLocalityAllowsRawAccess(input.runner_kind, input.source_policy.runner_access)) {
    return deniedRawAccess(input, 'policy_denied', 'remote_runner_access_denied', input.chunks);
  }

  const projectedTokens = (input.budget?.used_input_tokens ?? 0)
    + input.chunks.reduce((sum, chunk) => sum + chunk.token_count, 0);
  if (input.budget?.max_input_tokens !== undefined && projectedTokens > input.budget.max_input_tokens) {
    return {
      status: 'degraded',
      failure_class: 'policy_denied',
      reason: 'runner_budget_exhausted',
      payloads: [],
      ledger_entries: buildLedgerEntries(input, 'deny', 'runner_budget_exhausted'),
    };
  }

  if (input.chunks.some((chunk) => chunk.prompt_injection_risk !== 'none')) {
    return deniedRawAccess(input, 'prompt_injection_quarantine', 'prompt_injection_quarantine', input.chunks);
  }

  if (input.chunks.some((chunk) => chunk.secret_risk !== 'none' && chunk.redacted_text === chunk.chunk_text)) {
    return deniedRawAccess(input, 'secret_redaction_required', 'secret_redaction_required', input.chunks);
  }

  const ledgerEntries = buildLedgerEntries(input, 'allow', 'scoped_access_allowed');
  if (ledgerEntries.some((entry) => entry.policy_decision === 'deny')) {
    return {
      status: 'denied',
      failure_class: 'policy_denied',
      reason: ledgerEntries.find((entry) => entry.policy_decision === 'deny')?.policy_reason ?? 'raw_access_denied',
      payloads: [],
      ledger_entries: ledgerEntries,
    };
  }

  return {
    status: 'allowed',
    failure_class: null,
    reason: 'scoped_access_allowed',
    payloads: input.chunks.map((chunk) => buildRunnerChunkPayload(chunk)),
    ledger_entries: ledgerEntries,
  };
}

function denyTool(toolName: RunnerToolName, allowedTools: AllowedRunnerToolName[]): RunnerToolPolicyDecision {
  return {
    status: 'denied',
    failure_class: 'policy_denied',
    reason: `runner_tool_denied:${toolName}`,
    allowed_tools: allowedTools,
    proposal_only: false,
    canonical_mutation_allowed: false,
    connector_credentials_available: false,
  };
}

function deniedRawAccess(
  input: RunnerRawAccessInput,
  failureClass: MaintenanceFailureClass,
  reason: string,
  chunks: readonly SourceChunkRecord[],
): RunnerRawAccessResult {
  return {
    status: 'denied',
    failure_class: failureClass,
    reason,
    payloads: [],
    ledger_entries: chunks.length === 0 ? [] : buildLedgerEntries(input, 'deny', reason),
  };
}

function buildLedgerEntries(
  input: RunnerRawAccessInput,
  forcedDecision: 'allow' | 'deny',
  forcedReason: string,
): RawAccessLedgerEntry[] {
  const bySourceItem = new Map<string, SourceChunkRecord[]>();
  for (const chunk of input.chunks) {
    const existing = bySourceItem.get(chunk.source_item_id) ?? [];
    existing.push(chunk);
    bySourceItem.set(chunk.source_item_id, existing);
  }

  return [...bySourceItem.entries()].map(([sourceItemId, chunks]) => {
    const request = {
      actor_type: 'runner',
      actor_id: input.runner_id,
      job_id: input.job_id ?? null,
      source_id: input.source_id,
      source_item_id: sourceItemId,
      chunk_ids: chunks.map((chunk) => chunk.id),
      reason: input.task_type,
      prompt: input.prompt,
      input: input.input,
      requested_at: input.requested_at,
    };
    const sourceDecision = evaluateRawAccessRequest(request, input.source_policy);
    const decision = forcedDecision === 'deny'
      ? { policy_decision: 'deny' as const, reason: forcedReason, redaction_required: true }
      : sourceDecision;
    return buildRawAccessLedgerEntry(request, decision);
  });
}

function budgetExhausted(budget: RunnerBudget | undefined): boolean {
  if (!budget) return false;
  if (budget.max_tool_calls !== undefined && (budget.used_tool_calls ?? 0) >= budget.max_tool_calls) {
    return true;
  }
  if (budget.max_input_tokens !== undefined && (budget.used_input_tokens ?? 0) >= budget.max_input_tokens) {
    return true;
  }
  return false;
}

function runnerLocalityAllowsRawAccess(
  runnerKind: RestrictedRunnerKind,
  runnerAccess: RawAccessPolicy['runner_access'],
): boolean {
  if (runnerKind !== 'remote_model') return true;
  const normalized = normalizeRunnerAccess(runnerAccess);
  return REMOTE_RAW_ACCESS_ALLOWED_POLICIES.has(normalized);
}

function normalizeRunnerAccess(runnerAccess: RawAccessPolicy['runner_access']): string {
  return (runnerAccess ?? '').toLowerCase().replace(/[-\s]+/g, '_');
}

function isProposalTool(toolName: RunnerToolName): boolean {
  return toolName.startsWith('propose_');
}

function isRunnerTaskType(value: string): value is RunnerTaskType {
  return RUNNER_TASK_TYPES.includes(value as RunnerTaskType);
}
