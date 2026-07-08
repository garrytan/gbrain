// Retrieval-lane enum constants and parameter parsers shared by the
// operations-retrieval.ts module.
import { OperationError } from './operation-params.ts';
import type { ParamDef } from './operation-params.ts';
import { parseEnumParam, parseNonNegativeIntegerParam } from './operations-shared.ts';
import { parseCodeClaimVerificationEntry } from './services/code-claim-verification-service.ts';
import { CORPUS_LANE_ARTIFACT_KINDS } from './services/corpus-lane-service.ts';
import type {
  CodeClaim,
  CorpusLaneMetadata,
  MemoryActivationArtifact,
  MemoryArtifactKind,
  MemoryCandidateStatus,
  MemoryCandidateTargetObjectType,
  MemoryScenario,
  MemoryScenarioKnownSubject,
  MemoryScenarioKnownSubjectKind,
  MemoryScenarioSourceKind,
  PersonalEpisodeSourceKind,
  ProfileMemoryType,
  ReadContextProbeContext,
  RetrievalRouteIntent,
  RetrievalSelector,
  RetrievalSelectorKind,
  RetrieveContextGraphFrontierOptions,
  ScopeGatePolicy,
} from './types.ts';

export const RETRIEVAL_ROUTE_INTENTS = [
  'task_resume',
  'broad_synthesis',
  'precision_lookup',
  'mixed_scope_bridge',
  'personal_profile_lookup',
  'personal_episode_lookup',
] as const satisfies readonly RetrievalRouteIntent[];

export const PROFILE_MEMORY_TYPES = [
  'preference',
  'routine',
  'personal_project',
  'stable_fact',
  'relationship_boundary',
  'other',
] as const satisfies readonly ProfileMemoryType[];

export const PERSONAL_EPISODE_SOURCE_KINDS = ['chat', 'note', 'import', 'meeting', 'reminder', 'other'] as const satisfies readonly PersonalEpisodeSourceKind[];

export const PERSONAL_ROUTE_KINDS = ['profile', 'episode'] as const;

export const SCOPE_GATE_POLICIES = ['allow', 'defer', 'deny'] as const satisfies readonly ScopeGatePolicy[];

export const MEMORY_SCENARIOS = [
  'coding_continuation',
  'project_qa',
  'knowledge_qa',
  'auto_accumulation',
  'personal_recall',
  'mixed',
] as const satisfies readonly MemoryScenario[];

export const MEMORY_SCENARIO_SOURCE_KINDS = [
  'chat',
  'code_event',
  'import',
  'meeting',
  'cron',
  'manual',
  'session_end',
  'trace_review',
] as const satisfies readonly MemoryScenarioSourceKind[];

export const MEMORY_SCENARIO_KNOWN_SUBJECT_KINDS = [
  'project',
  'system',
  'concept',
  'person',
  'company',
  'source',
  'file',
  'symbol',
  'task',
  'profile',
  'personal_episode',
] as const satisfies readonly MemoryScenarioKnownSubjectKind[];

export const RETRIEVAL_SELECTOR_KINDS = [
  'page',
  'compiled_truth',
  'frontmatter',
  'section',
  'line_span',
  'timeline_entry',
  'timeline_range',
  'source_ref',
  'task_working_set',
  'task_attempt',
  'task_decision',
  'profile_memory',
  'personal_episode',
] as const satisfies readonly RetrievalSelectorKind[];

export const CONTEXT_READ_MODES = ['explicit', 'auto'] as const;

export const CONTEXT_TIMELINE_MODES = ['auto', 'include', 'exclude'] as const;

export const INCLUDE_TIMELINE_ENUM_ERROR_HINT = 'include_timeline controls returned timeline text; use exclude when timeline text should be omitted.';

export function includeTimelineParam(): ParamDef {
  return {
    type: 'string',
    description: 'Timeline inclusion mode: auto, include, or exclude. Use exclude to omit timeline text.',
    compactDescription: true,
    enum: [...CONTEXT_TIMELINE_MODES],
    enumErrorHint: INCLUDE_TIMELINE_ENUM_ERROR_HINT,
  };
}

export function parseIncludeTimelineParam(value: unknown): (typeof CONTEXT_TIMELINE_MODES)[number] | undefined {
  return parseEnumParam(value, 'include_timeline', CONTEXT_TIMELINE_MODES, INCLUDE_TIMELINE_ENUM_ERROR_HINT);
}

export const MEMORY_ARTIFACT_KINDS = [
  'current_artifact',
  'compiled_truth',
  'timeline',
  'source_record',
  'context_map',
  'codemap_pointer',
  'task_attempt_failed',
  'task_decision',
  'memory_candidate',
  'profile_memory',
  'personal_episode',
] as const satisfies readonly MemoryArtifactKind[];

export const MEMORY_CANDIDATE_STATUS_VALUES = [
  'captured',
  'candidate',
  'staged_for_review',
  'rejected',
  'promoted',
  'superseded',
] as const satisfies readonly MemoryCandidateStatus[];

export const MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES = [
  'curated_note',
  'procedure',
  'profile_memory',
  'personal_episode',
  'other',
] as const satisfies readonly MemoryCandidateTargetObjectType[];

export function parseStringListParam(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value !== 'string') {
    throw new OperationError('invalid_params', `${key} must be an array or string list.`);
  }

  const trimmed = value.trim();
  if (trimmed === '') return [];

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new OperationError('invalid_params', `${key} must be valid JSON when passed as an array string.`);
    }
    if (!Array.isArray(parsed)) {
      throw new OperationError('invalid_params', `${key} JSON value must be an array.`);
    }
    return parsed.map((item) => String(item));
  }

  return trimmed
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseRetrieveContextGraphFrontierParam(value: unknown, key: string): RetrieveContextGraphFrontierOptions | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return { enabled: value };

  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (trimmed === 'true') return { enabled: true };
    if (trimmed === 'false') return { enabled: false };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new OperationError('invalid_params', `${key} must be valid JSON when passed as a string.`);
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OperationError('invalid_params', `${key} must be an object, boolean, or JSON object string.`);
  }

  const object = parsed as Record<string, unknown>;
  const allowedKeys = new Set(['enabled', 'max_depth', 'fanout_cap']);
  for (const optionKey of Object.keys(object)) {
    if (!allowedKeys.has(optionKey)) {
      throw new OperationError('invalid_params', `${key}.${optionKey} is not a supported option.`);
    }
  }
  if (typeof object.enabled !== 'boolean') {
    throw new OperationError('invalid_params', `${key}.enabled must be a boolean.`);
  }

  return {
    enabled: object.enabled,
    ...(object.max_depth !== undefined
      ? {
          max_depth: parseNonNegativeIntegerParam(object.max_depth, `${key}.max_depth`),
        }
      : {}),
    ...(object.fanout_cap !== undefined
      ? {
          fanout_cap: parseNonNegativeIntegerParam(object.fanout_cap, `${key}.fanout_cap`),
        }
      : {}),
  };
}

export function parseReadContextProbeContextParam(value: unknown, key: string): ReadContextProbeContext | undefined {
  if (value === undefined || value === null) return undefined;

  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return undefined;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new OperationError('invalid_params', `${key} must be valid JSON when passed as a string.`);
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OperationError('invalid_params', `${key} must be an object or JSON object string.`);
  }

  const object = parsed as Record<string, unknown>;
  const allowedKeys = new Set([
    'retrieve_trace_ids',
    'candidate_signal_count',
    'candidate_signal_ids',
    'search_chunk_count',
    'graph_frontier_considered',
    'context_map_consulted',
    'raw_source_consulted',
  ]);
  for (const optionKey of Object.keys(object)) {
    if (!allowedKeys.has(optionKey)) {
      throw new OperationError('invalid_params', `${key}.${optionKey} is not a supported option.`);
    }
  }

  return {
    retrieve_trace_ids: parseOptionalStringArray(object.retrieve_trace_ids, `${key}.retrieve_trace_ids`),
    candidate_signal_count: parseOptionalNonNegativeInteger(object.candidate_signal_count, `${key}.candidate_signal_count`),
    candidate_signal_ids: parseOptionalStringArray(object.candidate_signal_ids, `${key}.candidate_signal_ids`),
    search_chunk_count: parseOptionalNonNegativeInteger(object.search_chunk_count, `${key}.search_chunk_count`),
    graph_frontier_considered: parseOptionalBoolean(object.graph_frontier_considered, `${key}.graph_frontier_considered`),
    context_map_consulted: parseOptionalBoolean(object.context_map_consulted, `${key}.context_map_consulted`),
    raw_source_consulted: parseOptionalBoolean(object.raw_source_consulted, `${key}.raw_source_consulted`),
  };
}

export function parseOptionalStringArray(value: unknown, key: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new OperationError('invalid_params', `${key} must be an array of strings.`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new OperationError('invalid_params', `${key}[${index}] must be a string.`);
    }
    return item;
  });
}

export function parseOptionalNonNegativeInteger(value: unknown, key: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new OperationError('invalid_params', `${key} must be a non-negative integer.`);
  }
  return value;
}

export function parseOptionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new OperationError('invalid_params', `${key} must be a boolean.`);
  }
  return value;
}

export function parseKnownSubjectsParam(value: unknown, key: string): Array<string | MemoryScenarioKnownSubject> | undefined {
  if (value === undefined || value === null) return undefined;

  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return [];
    if (trimmed.startsWith('[')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new OperationError('invalid_params', `${key} must be valid JSON when passed as an array string.`);
      }
    } else {
      parsed = trimmed
        .split(/\r?\n|,/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new OperationError('invalid_params', `${key} must be an array.`);
  }

  return parsed.map((item, index) => {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') {
      throw new OperationError('invalid_params', `${key}[${index}] must be a string or object.`);
    }

    const subject = item as Record<string, unknown>;
    if (typeof subject.ref !== 'string' || subject.ref.length === 0) {
      throw new OperationError('invalid_params', `${key}[${index}].ref must be a non-empty string.`);
    }

    const knownSubject: MemoryScenarioKnownSubject = { ref: subject.ref };
    if (subject.kind !== undefined) {
      if (subject.kind === null) {
        throw new OperationError('invalid_params', `${key}[${index}].kind must be one of: ${MEMORY_SCENARIO_KNOWN_SUBJECT_KINDS.join(', ')}.`);
      }
      const kind = parseEnumParam(subject.kind, `${key}[${index}].kind`, MEMORY_SCENARIO_KNOWN_SUBJECT_KINDS);
      if (kind) knownSubject.kind = kind;
    }
    return knownSubject;
  });
}

export function parseRetrievalSelectors(value: unknown, key: string): RetrievalSelector[] | undefined {
  if (value === undefined || value === null) return undefined;

  let parsed: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new OperationError('invalid_params', `${key} must be valid JSON when passed as a string.`);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new OperationError('invalid_params', `${key} must be an array of selector objects.`);
  }

  return parsed.map((item, index) => {
    if (typeof item === 'string') return parseRetrievalSelectorId(item, `${key}[${index}]`);
    return parseRetrievalSelectorObject(item, `${key}[${index}]`);
  });
}

function parseRetrievalSelectorId(value: string, key: string): RetrievalSelector {
  const selectorId = value.trim();
  if (selectorId.length === 0) {
    throw new OperationError('invalid_params', `${key} must be a non-empty selector id.`);
  }

  const { base, char_start, char_end } = parseSelectorIdCharRange(selectorId, key);
  const [kindValue, scopeNamespace, scopeName, ...targetParts] = base.split(':');
  const kind = parseEnumParam(kindValue, `${key}.kind`, RETRIEVAL_SELECTOR_KINDS);
  if (!kind) {
    throw new OperationError('invalid_params', `${key}.kind must be one of: ${RETRIEVAL_SELECTOR_KINDS.join(', ')}.`);
  }
  if (!scopeNamespace || !scopeName) {
    throw new OperationError('invalid_params', `${key} must include selector scope.`);
  }

  const scope_id = `${scopeNamespace}:${scopeName}`;
  const target = targetParts.join(':');
  if (!target) {
    throw new OperationError('invalid_params', `${key} must include selector target.`);
  }

  const selector: RetrievalSelector = {
    selector_id: selectorId,
    kind,
    scope_id,
    ...(char_start !== undefined ? { char_start } : {}),
    ...(char_end !== undefined ? { char_end } : {}),
  };

  switch (kind) {
    case 'page':
    case 'compiled_truth':
    case 'frontmatter':
    case 'timeline_range':
      selector.slug = target;
      break;
    case 'section':
      selector.section_id = target;
      break;
    case 'line_span': {
      const lineStart = Number(targetParts.at(-2));
      const lineEnd = Number(targetParts.at(-1));
      const slug = targetParts.slice(0, -2).join(':');
      if (!slug || !Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) {
        throw new OperationError('invalid_params', `${key} line_span selector id must include slug, line_start, and line_end.`);
      }
      selector.slug = slug;
      selector.line_start = lineStart;
      selector.line_end = lineEnd;
      break;
    }
    case 'source_ref': {
      const targetSuffixIndex = target.indexOf('@target:');
      if (targetSuffixIndex >= 0) {
        selector.source_ref = target.slice(0, targetSuffixIndex);
        const targetHint = target.slice(targetSuffixIndex + '@target:'.length);
        if (targetHint.includes('#')) {
          selector.path = targetHint;
        } else {
          selector.slug = targetHint;
        }
      } else {
        selector.source_ref = target;
      }
      break;
    }
    case 'timeline_entry':
    case 'task_working_set':
    case 'task_attempt':
    case 'task_decision':
    case 'profile_memory':
    case 'personal_episode':
      selector.object_id = target;
      break;
  }

  return selector;
}

function parseSelectorIdCharRange(selectorId: string, key: string): { base: string; char_start?: number; char_end?: number } {
  const charsIndex = selectorId.lastIndexOf('@chars:');
  if (charsIndex < 0) return { base: selectorId };

  const base = selectorId.slice(0, charsIndex);
  const [startRaw, endRaw = ''] = selectorId.slice(charsIndex + '@chars:'.length).split(':');
  const charStart = Number(startRaw);
  const charEnd = endRaw.length > 0 ? Number(endRaw) : undefined;
  if (!Number.isInteger(charStart) || charStart < 0) {
    throw new OperationError('invalid_params', `${key} char_start must be a nonnegative integer.`);
  }
  if (charEnd !== undefined && (!Number.isInteger(charEnd) || charEnd < 0)) {
    throw new OperationError('invalid_params', `${key} char_end must be a nonnegative integer.`);
  }
  return {
    base,
    char_start: charStart,
    ...(charEnd !== undefined ? { char_end: charEnd } : {}),
  };
}

function parseRetrievalSelectorObject(value: unknown, key: string): RetrievalSelector {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('invalid_params', `${key} must be an object.`);
  }

  const selector = { ...(value as Record<string, unknown>) };
  const kind = parseEnumParam(selector.kind, `${key}.kind`, RETRIEVAL_SELECTOR_KINDS);
  if (!kind) {
    throw new OperationError('invalid_params', `${key}.kind must be one of: ${RETRIEVAL_SELECTOR_KINDS.join(', ')}.`);
  }
  selector.kind = kind;

  for (const field of ['selector_id', 'scope_id', 'slug', 'path', 'section_id', 'source_ref', 'object_id', 'content_hash', 'freshness']) {
    if (selector[field] !== undefined && typeof selector[field] !== 'string') {
      throw new OperationError('invalid_params', `${key}.${field} must be a string.`);
    }
  }

  for (const field of ['line_start', 'line_end', 'char_start', 'char_end']) {
    if (selector[field] !== undefined && typeof selector[field] !== 'number') {
      throw new OperationError('invalid_params', `${key}.${field} must be a number.`);
    }
  }

  if (selector.source_refs !== undefined) {
    if (!Array.isArray(selector.source_refs) || !selector.source_refs.every((item) => typeof item === 'string')) {
      throw new OperationError('invalid_params', `${key}.source_refs must be an array of strings.`);
    }
  }
  if (selector.corpus_lane !== undefined) {
    selector.corpus_lane = parseCorpusLaneMetadata(selector.corpus_lane, `${key}.corpus_lane`);
  }

  return selector as unknown as RetrievalSelector;
}

export function parseCorpusLaneMetadata(value: unknown, key: string): CorpusLaneMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('invalid_params', `${key} must be an object.`);
  }
  const lane = value as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const field of ['lane_id', 'source_record', 'import_origin', 'artifact_kind']) {
    if (lane[field] === undefined) continue;
    if (typeof lane[field] !== 'string') {
      throw new OperationError('invalid_params', `${key}.${field} must be a string.`);
    }
    const trimmed = lane[field].trim();
    if (trimmed.length === 0) {
      throw new OperationError('invalid_params', `${key}.${field} must be a non-empty string.`);
    }
    if (field === 'artifact_kind' && !(CORPUS_LANE_ARTIFACT_KINDS as readonly string[]).includes(trimmed)) {
      throw new OperationError('invalid_params', `${key}.artifact_kind must be one of: ${CORPUS_LANE_ARTIFACT_KINDS.join(', ')}.`);
    }
    output[field] = trimmed;
  }
  if (!output.lane_id) {
    throw new OperationError('invalid_params', `${key}.lane_id must be a string.`);
  }
  return output as unknown as CorpusLaneMetadata;
}

export function parseActivationArtifacts(value: unknown, key: string): MemoryActivationArtifact[] {
  if (value === undefined || value === null) return [];

  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new OperationError('invalid_params', `${key} must be valid JSON when passed as a string.`);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new OperationError('invalid_params', `${key} must be an array.`);
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new OperationError('invalid_params', `${key}[${index}] must be an object.`);
    }

    const artifact = item as Record<string, unknown>;
    if (typeof artifact.id !== 'string' || artifact.id.length === 0) {
      throw new OperationError('invalid_params', `${key}[${index}].id must be a non-empty string.`);
    }

    const artifactKind = parseEnumParam(artifact.artifact_kind, `${key}[${index}].artifact_kind`, MEMORY_ARTIFACT_KINDS);
    if (!artifactKind) {
      throw new OperationError('invalid_params', `${key}[${index}].artifact_kind must be one of: ${MEMORY_ARTIFACT_KINDS.join(', ')}.`);
    }

    if (artifact.source_ref !== undefined && typeof artifact.source_ref !== 'string') {
      throw new OperationError('invalid_params', `${key}[${index}].source_ref must be a string.`);
    }
    if (artifact.stale !== undefined && typeof artifact.stale !== 'boolean') {
      throw new OperationError('invalid_params', `${key}[${index}].stale must be a boolean.`);
    }
    if (artifact.anchors_valid !== undefined && typeof artifact.anchors_valid !== 'boolean') {
      throw new OperationError('invalid_params', `${key}[${index}].anchors_valid must be a boolean.`);
    }

    if (artifact.candidate_status === null) {
      throw new OperationError('invalid_params', `${key}[${index}].candidate_status must be one of: ${MEMORY_CANDIDATE_STATUS_VALUES.join(', ')}.`);
    }
    if (artifact.target_object_type === null) {
      throw new OperationError(
        'invalid_params',
        `${key}[${index}].target_object_type must be one of: ${MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES.join(', ')}.`,
      );
    }
    if (artifact.source_refs_count === null) {
      throw new OperationError('invalid_params', `${key}[${index}].source_refs_count must be a non-negative integer`);
    }

    const candidateStatus = parseEnumParam(artifact.candidate_status, `${key}[${index}].candidate_status`, MEMORY_CANDIDATE_STATUS_VALUES);
    const targetObjectType = parseEnumParam(artifact.target_object_type, `${key}[${index}].target_object_type`, MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES);
    const sourceRefsCount = parseNonNegativeIntegerParam(artifact.source_refs_count, `${key}[${index}].source_refs_count`);

    let scopePolicy: ScopeGatePolicy | undefined;
    if (artifact.scope_policy !== undefined) {
      if (artifact.scope_policy === null) {
        throw new OperationError('invalid_params', `${key}[${index}].scope_policy must be one of: ${SCOPE_GATE_POLICIES.join(', ')}.`);
      }
      scopePolicy = parseEnumParam(artifact.scope_policy, `${key}[${index}].scope_policy`, SCOPE_GATE_POLICIES);
    }

    return {
      id: artifact.id,
      artifact_kind: artifactKind,
      source_ref: artifact.source_ref,
      stale: artifact.stale,
      anchors_valid: artifact.anchors_valid,
      scope_policy: scopePolicy,
      candidate_status: candidateStatus,
      target_object_type: targetObjectType,
      source_refs_count: sourceRefsCount,
    };
  });
}

export async function withSelectorParamErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof OperationError) throw error;
    if (error instanceof Error && error.message.toLowerCase().includes('selector')) {
      throw new OperationError('invalid_params', error.message);
    }
    throw error;
  }
}

export function parseCodeClaimsParam(value: unknown, key: string): CodeClaim[] | undefined {
  if (value === undefined || value === null) return undefined;

  let rawClaims: unknown = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return [];
    if (trimmed.startsWith('[')) {
      try {
        rawClaims = JSON.parse(trimmed);
      } catch {
        throw new OperationError('invalid_params', `${key} must be valid JSON when passed as an array string.`);
      }
    } else {
      rawClaims = parseStringListParam(value, key)?.map((entry) => (entry.startsWith('code_claim:') ? entry : `code_claim:${entry}`));
    }
  }

  if (!Array.isArray(rawClaims)) {
    throw new OperationError('invalid_params', `${key} must be an array of code claim objects or code_claim entries.`);
  }

  return rawClaims.map((claim, index) => parseCodeClaimParamItem(claim, `${key}[${index}]`));
}

function parseCodeClaimParamItem(value: unknown, key: string): CodeClaim {
  if (typeof value === 'string') {
    const parsed = parseCodeClaimVerificationEntry(value.startsWith('code_claim:') ? value : `code_claim:${value}`);
    if (!parsed) {
      throw new OperationError('invalid_params', `${key} must be a valid code_claim entry.`);
    }
    return parsed;
  }

  if (!value || typeof value !== 'object') {
    throw new OperationError('invalid_params', `${key} must be a code claim object.`);
  }
  const claim = value as Record<string, unknown>;
  const hasPath = typeof claim.path === 'string' && claim.path.trim().length > 0;
  const hasSymbol = typeof claim.symbol === 'string' && claim.symbol.length > 0;
  if (!hasPath && !hasSymbol) {
    throw new OperationError('invalid_params', `${key} must include a non-empty path or symbol.`);
  }

  return {
    ...(hasPath ? { path: String(claim.path) } : {}),
    ...(hasSymbol ? { symbol: String(claim.symbol) } : {}),
    ...(typeof claim.branch_name === 'string' && claim.branch_name.length > 0 ? { branch_name: claim.branch_name } : {}),
    ...(typeof claim.source_trace_id === 'string' && claim.source_trace_id.length > 0 ? { source_trace_id: claim.source_trace_id } : {}),
    ...(typeof claim.expected_content_hash === 'string' && claim.expected_content_hash.trim().length > 0
      ? { expected_content_hash: claim.expected_content_hash }
      : {}),
    ...(typeof claim.verification_hint === 'string' && claim.verification_hint.trim().length > 0 ? { verification_hint: claim.verification_hint } : {}),
    ...(typeof claim.verification_mode === 'string' && claim.verification_mode.trim().length > 0 ? { verification_mode: claim.verification_mode } : {}),
    ...(typeof claim.source_ref === 'string' && claim.source_ref.trim().length > 0 ? { source_ref: claim.source_ref } : {}),
    ...(typeof claim.symbol_id === 'string' && claim.symbol_id.trim().length > 0 ? { symbol_id: claim.symbol_id } : {}),
  };
}
