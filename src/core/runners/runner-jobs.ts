import { createHash } from 'crypto';
import type { MaintenanceFailureClass } from '../maintenance/job-runtime.ts';
import type { RestrictedRunnerKind } from './runner-registry.ts';
import type { RunnerTaskType } from './runner-policy.ts';

export type RunnerJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'degraded' | 'cancelled';
export type RunnerMessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type RunnerToolCallStatus = 'allowed' | 'denied' | 'failed' | 'succeeded';

export interface RunnerSourceScope {
  source_id?: string;
  source_item_ids?: string[];
  chunk_ids?: string[];
}

export interface RunnerTokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface RunnerJobRecord {
  id: string;
  memory_job_id: string | null;
  runner_kind: RestrictedRunnerKind;
  runner_version: string | null;
  model: string | null;
  provider: string | null;
  task_type: RunnerTaskType;
  source_scope_json: RunnerSourceScope;
  prompt_hash: string;
  input_hash: string;
  output_hash: string | null;
  status: RunnerJobStatus;
  failure_class: MaintenanceFailureClass | null;
  token_usage_json: RunnerTokenUsage;
  cost_estimate_usd: number | null;
  can_execute_shell: false;
  can_access_connector_credentials: false;
  created_at: string;
  updated_at: string;
}

export interface BuildRunnerJobInput {
  memory_job_id?: string | null;
  runner_kind: RestrictedRunnerKind;
  runner_version?: string | null;
  model?: string | null;
  provider?: string | null;
  task_type: RunnerTaskType;
  source_scope_json?: RunnerSourceScope;
  prompt?: string;
  input?: string;
  output?: string | null;
  status?: RunnerJobStatus;
  failure_class?: MaintenanceFailureClass | null;
  token_usage_json?: Partial<RunnerTokenUsage>;
  cost_estimate_usd?: number | null;
  now?: string;
}

export interface RunnerToolCallRecord {
  id: string;
  runner_job_id: string;
  tool_name: string;
  status: RunnerToolCallStatus;
  policy_reason: string;
  request_hash: string;
  response_hash: string | null;
  token_usage_json: RunnerTokenUsage;
  cost_estimate_usd: number | null;
  created_at: string;
}

export interface RunnerMessageRecord {
  id: string;
  runner_job_id: string;
  role: RunnerMessageRole;
  content_hash: string;
  redacted_preview: string;
  token_count: number;
  created_at: string;
}

export interface RunnerArtifactRecord {
  id: string;
  runner_job_id: string;
  artifact_kind: string;
  artifact_ref: string;
  content_hash: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

const SAFE_ARTIFACT_REF_PATTERN = /^(?:artifact-ref|runner-artifact|memory-job-artifact|report-section|source-summary|sha256):[A-Za-z0-9._:-]{1,160}$/;
const SAFE_ARTIFACT_METADATA_KEYS = new Set([
  'source_id',
  'source_item_id',
  'chunk_id',
  'chunk_ids',
  'content_hash',
  'token_count',
  'line_count',
  'format',
  'schema_version',
  'created_by',
  'task_type',
  'policy_reason',
]);
const SAFE_METADATA_STRING_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const SECRETISH_IDENTIFIER_PATTERN = /(?:token|secret|password|bearer|sk-|xox|akia)/i;

export function buildRunnerJobRecord(input: BuildRunnerJobInput): RunnerJobRecord {
  const now = input.now ?? new Date().toISOString();
  const prompt = input.prompt ?? '';
  const runnerInput = input.input ?? '';
  const output = input.output ?? null;
  return {
    id: stableId('runner-job', input.task_type, input.runner_kind, JSON.stringify(sanitizeRunnerSourceScope(input.source_scope_json)), prompt, runnerInput, now),
    memory_job_id: input.memory_job_id ?? null,
    runner_kind: input.runner_kind,
    runner_version: input.runner_version ?? null,
    model: input.model ?? null,
    provider: input.provider ?? null,
    task_type: input.task_type,
    source_scope_json: sanitizeRunnerSourceScope(input.source_scope_json),
    prompt_hash: sha256(prompt),
    input_hash: sha256(runnerInput),
    output_hash: output === null ? null : sha256(output),
    status: input.status ?? 'queued',
    failure_class: input.failure_class ?? null,
    token_usage_json: normalizeUsage(input.token_usage_json),
    cost_estimate_usd: input.cost_estimate_usd ?? null,
    can_execute_shell: false,
    can_access_connector_credentials: false,
    created_at: now,
    updated_at: now,
  };
}

export function buildRunnerToolCallRecord(input: {
  runner_job_id: string;
  tool_name: string;
  status: RunnerToolCallStatus;
  policy_reason: string;
  request: unknown;
  response?: unknown;
  token_usage_json?: Partial<RunnerTokenUsage>;
  cost_estimate_usd?: number | null;
  now?: string;
}): RunnerToolCallRecord {
  const now = input.now ?? new Date().toISOString();
  return {
    id: stableId('runner-tool-call', input.runner_job_id, input.tool_name, JSON.stringify(input.request), now),
    runner_job_id: input.runner_job_id,
    tool_name: input.tool_name,
    status: input.status,
    policy_reason: input.policy_reason,
    request_hash: sha256(JSON.stringify(input.request)),
    response_hash: input.response === undefined ? null : sha256(JSON.stringify(input.response)),
    token_usage_json: normalizeUsage(input.token_usage_json),
    cost_estimate_usd: input.cost_estimate_usd ?? null,
    created_at: now,
  };
}

export function buildRunnerMessageRecord(input: {
  runner_job_id: string;
  role: RunnerMessageRole;
  content: string;
  token_count?: number;
  now?: string;
}): RunnerMessageRecord {
  const now = input.now ?? new Date().toISOString();
  const contentHash = sha256(input.content);
  return {
    id: stableId('runner-message', input.runner_job_id, input.role, input.content, now),
    runner_job_id: input.runner_job_id,
    role: input.role,
    content_hash: contentHash,
    redacted_preview: hashedPreview(contentHash),
    token_count: input.token_count ?? estimateTokens(input.content),
    created_at: now,
  };
}

export function buildRunnerArtifactRecord(input: {
  runner_job_id: string;
  artifact_kind: string;
  artifact_ref: string;
  content?: string | null;
  metadata_json?: Record<string, unknown>;
  now?: string;
}): RunnerArtifactRecord {
  const now = input.now ?? new Date().toISOString();
  const artifactKind = sanitizeRunnerArtifactKind(input.artifact_kind);
  const artifactRef = sanitizeRunnerArtifactRef(input.artifact_ref);
  return {
    id: stableId('runner-artifact', input.runner_job_id, artifactKind, artifactRef, now),
    runner_job_id: input.runner_job_id,
    artifact_kind: artifactKind,
    artifact_ref: artifactRef,
    content_hash: input.content == null ? null : sha256(input.content),
    metadata_json: sanitizeRunnerArtifactMetadata(input.metadata_json),
    created_at: now,
  };
}

function normalizeUsage(input: Partial<RunnerTokenUsage> | undefined): RunnerTokenUsage {
  const inputTokens = input?.input_tokens ?? 0;
  const outputTokens = input?.output_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: input?.total_tokens ?? inputTokens + outputTokens,
  };
}

export function sanitizeRunnerSourceScope(scope: RunnerSourceScope | undefined): RunnerSourceScope {
  if (!scope) return {};
  const sourceId = typeof scope.source_id === 'string'
    && isSafePersistedIdentifier(scope.source_id)
    ? scope.source_id
    : undefined;
  return {
    ...(sourceId ? { source_id: sourceId } : {}),
    ...stringArrayField('source_item_ids', scope.source_item_ids),
    ...stringArrayField('chunk_ids', scope.chunk_ids),
  };
}

function stringArrayField<K extends 'source_item_ids' | 'chunk_ids'>(
  key: K,
  value: unknown,
): Pick<RunnerSourceScope, K> | Record<string, never> {
  if (!Array.isArray(value)) return {};
  const strings = value.filter((entry): entry is string => (
    typeof entry === 'string' && isSafePersistedIdentifier(entry)
  ));
  return strings.length === 0 ? {} : { [key]: strings } as Pick<RunnerSourceScope, K>;
}

function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return Math.max(1, Math.ceil(words.length * 1.3));
}

function hashedPreview(contentHash: string): string {
  return `sha256:${contentHash.slice(0, 16)}`;
}

export function sanitizeRunnerArtifactRef(artifactRef: string): string {
  if (SAFE_ARTIFACT_REF_PATTERN.test(artifactRef) && !isSecretishIdentifier(artifactRef)) return artifactRef;
  return `artifact-ref:${sha256(artifactRef).slice(0, 24)}`;
}

export function sanitizeRunnerArtifactKind(artifactKind: string): string {
  if (isSafePersistedIdentifier(artifactKind)) return artifactKind;
  return `artifact-kind:${sha256(artifactKind).slice(0, 24)}`;
}

export function sanitizeRunnerArtifactMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!SAFE_ARTIFACT_METADATA_KEYS.has(key)) continue;
    const cleanValue = sanitizeRunnerArtifactMetadataValue(value);
    if (cleanValue !== undefined) {
      sanitized[key] = cleanValue;
    }
  }
  return sanitized;
}

function sanitizeRunnerArtifactMetadataValue(
  value: unknown,
): string | number | boolean | null | string[] | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return isSafeMetadataString(value) ? value : undefined;
  if (Array.isArray(value)) {
    const safeStrings = value
      .filter((entry): entry is string => typeof entry === 'string' && isSafeMetadataString(entry))
      .slice(0, 50);
    return safeStrings.length > 0 ? safeStrings : undefined;
  }
  return undefined;
}

function isSafeMetadataString(value: string): boolean {
  return isSafePersistedIdentifier(value);
}

function isSafePersistedIdentifier(value: string): boolean {
  return SAFE_METADATA_STRING_PATTERN.test(value) && !isSecretishIdentifier(value);
}

function isSecretishIdentifier(value: string): boolean {
  return SECRETISH_IDENTIFIER_PATTERN.test(value);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${sha256(parts.join('\0')).slice(0, 24)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
