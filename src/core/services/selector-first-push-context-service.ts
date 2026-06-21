import type {
  RetrievalSelector,
  RetrieveContextAnswerability,
  SelectorFirstPushContextEnvelope,
  SelectorFirstPushContextSelectorSnapshot,
  ScopeGateDecisionResult,
} from '../types.ts';
import { normalizeRetrievalSelector, retrievalSelectorId } from './retrieval-selector-service.ts';

const SCHEMA_VERSION = 1;
const ENVELOPE_KIND = 'selector_first_push_context';
const REQUIRED_NEXT_TOOL = 'read_context';

export interface BuildSelectorFirstPushContextEnvelopeInput {
  request_id: string;
  trace_ids?: string[];
  selectors: RetrievalSelector[];
  scope_gate?: ScopeGateDecisionResult;
  answerability: RetrieveContextAnswerability;
  source_ref_count?: number;
  confidence?: number;
  now?: string;
  ttl_ms?: number;
}

export interface ValidateSelectorFirstPushContextEnvelopeInput {
  now?: string;
}

export interface SelectorFirstPushContextValidationResult {
  accepted: boolean;
  reason_codes: string[];
  read_context_required: boolean;
  selector_ids: string[];
}

export function buildSelectorFirstPushContextEnvelope(
  input: BuildSelectorFirstPushContextEnvelopeInput,
): SelectorFirstPushContextEnvelope {
  const now = input.now ?? new Date().toISOString();
  const ttlMs = input.ttl_ms ?? 60_000;
  const selectorSnapshots = input.selectors.map((selector) =>
    sanitizeSelectorSnapshot(normalizeRetrievalSelector(selector))
  );
  const reasonCodes = input.answerability.reason_codes ?? [];

  return {
    schema_version: SCHEMA_VERSION,
    envelope_kind: ENVELOPE_KIND,
    request_id: input.request_id,
    created_at: now,
    expires_at: new Date(Date.parse(now) + ttlMs).toISOString(),
    ttl_ms: ttlMs,
    trace_ids: [...(input.trace_ids ?? [])],
    selector_ids: selectorSnapshots.map((selector) => selector.selector_id),
    selector_snapshots: selectorSnapshots,
    content_hashes: selectorSnapshots
      .map((selector) => selector.content_hash)
      .filter((hash): hash is string => typeof hash === 'string' && hash.length > 0),
    source_ref_count: input.source_ref_count ?? 0,
    confidence: input.confidence ?? 0,
    not_answer_ground_until_read_context: true,
    required_next_tool: REQUIRED_NEXT_TOOL,
    answer_readiness: {
      ready: false,
      must_read_context: true,
      reason_codes: [...reasonCodes],
    },
    read_context_arguments: {
      selectors: selectorSnapshots,
    },
    ...(input.scope_gate ? { scope_gate: input.scope_gate } : {}),
  };
}

export function validateSelectorFirstPushContextEnvelope(
  input: unknown,
  options: ValidateSelectorFirstPushContextEnvelopeInput = {},
): SelectorFirstPushContextValidationResult {
  const reasonCodes: string[] = [];
  const envelope = isRecord(input) ? input : null;
  if (!envelope) {
    return {
      accepted: false,
      reason_codes: ['envelope_not_object'],
      read_context_required: false,
      selector_ids: [],
    };
  }

  if (envelope.schema_version !== SCHEMA_VERSION) reasonCodes.push('schema_version_invalid');
  if (envelope.envelope_kind !== ENVELOPE_KIND) reasonCodes.push('envelope_kind_invalid');
  if (hasUnknownKeys(envelope, TOP_LEVEL_FIELDS)) reasonCodes.push('unknown_field');

  const selectorIds = stringArray(envelope.selector_ids);
  if (!selectorIds || selectorIds.length === 0) reasonCodes.push('selector_ids_invalid');
  const traceIds = stringArray(envelope.trace_ids);
  const contentHashes = stringArray(envelope.content_hashes);
  const topLevelFieldsHaveValidShape =
    typeof envelope.request_id === 'string'
    && envelope.request_id.length > 0
    && typeof envelope.created_at === 'string'
    && Number.isFinite(Date.parse(envelope.created_at))
    && isPositiveInteger(envelope.ttl_ms)
    && traceIds !== null
    && contentHashes !== null
    && isNonnegativeInteger(envelope.source_ref_count)
    && isConfidence(envelope.confidence);
  const answerReadiness = isRecord(envelope.answer_readiness) ? envelope.answer_readiness : null;
  const answerReadinessFieldsHaveValidShape =
    answerReadiness !== null
    && !hasUnknownKeys(answerReadiness, ANSWER_READINESS_FIELDS)
    && stringArray(answerReadiness.reason_codes) !== null;

  const readContextRequired = envelope.not_answer_ground_until_read_context === true
    && envelope.required_next_tool === REQUIRED_NEXT_TOOL
    && answerReadinessFieldsHaveValidShape
    && answerReadiness?.ready === false
    && answerReadiness.must_read_context === true;
  if (!readContextRequired) reasonCodes.push('read_context_not_required');
  if (!topLevelFieldsHaveValidShape || !answerReadinessFieldsHaveValidShape) {
    reasonCodes.push('field_shape_invalid');
  }

  const expiresAt = typeof envelope.expires_at === 'string' ? Date.parse(envelope.expires_at) : NaN;
  const now = Date.parse(options.now ?? new Date().toISOString());
  if (!Number.isFinite(expiresAt)) {
    reasonCodes.push('expires_at_invalid');
  } else if (Number.isFinite(now) && expiresAt <= now) {
    reasonCodes.push('expired');
  }

  if (hasRawAnswerField(envelope)) reasonCodes.push('raw_text_field_present');
  if (hasCandidateAnswerField(envelope)) reasonCodes.push('candidate_pointer_present');
  const selectorSnapshots = selectorSnapshotArray(envelope.selector_snapshots);
  const readContextArguments = isRecord(envelope.read_context_arguments)
    ? envelope.read_context_arguments
    : null;
  const argumentSelectors = readContextArguments
    ? selectorSnapshotArray(readContextArguments.selectors)
    : null;
  if (
    !readContextArguments
    || hasUnknownKeys(readContextArguments, READ_CONTEXT_ARGUMENT_FIELDS)
  ) {
    reasonCodes.push('read_context_arguments_invalid');
  }
  if (envelope.scope_gate !== undefined && (
    !isRecord(envelope.scope_gate)
    || hasUnknownKeys(envelope.scope_gate, SCOPE_GATE_FIELDS)
    || !scopeGateShapeIsValid(envelope.scope_gate)
  )) {
    reasonCodes.push('scope_gate_invalid');
  }
  if (!selectorSnapshots || selectorSnapshots.length === 0) {
    reasonCodes.push('selector_snapshots_invalid');
  }
  if (selectorSnapshotArrayHasInvalidShape(envelope.selector_snapshots)) {
    reasonCodes.push('selector_snapshot_invalid');
  }
  if (!argumentSelectors || argumentSelectors.length === 0) {
    reasonCodes.push('read_context_arguments_invalid');
  } else if (selectorSnapshotArrayHasInvalidShape(readContextArguments?.selectors)) {
    reasonCodes.push('read_context_arguments_invalid');
  }
  if (selectorSnapshots && hasUnsanitizedSelectorSnapshot(selectorSnapshots)) {
    reasonCodes.push('selector_snapshot_not_sanitized');
  }
  if (argumentSelectors && hasUnsanitizedSelectorSnapshot(argumentSelectors)) {
    reasonCodes.push('read_context_arguments_invalid');
  }
  if (
    selectorIds
    && selectorSnapshots
    && argumentSelectors
    && (
      !sameStringList(selectorIds, selectorSnapshots.map((selector) => selector.selector_id))
      || !sameStringList(selectorIds, argumentSelectors.map((selector) => selector.selector_id))
    )
  ) {
    reasonCodes.push('selector_ids_mismatch');
  }

  return {
    accepted: reasonCodes.length === 0,
    reason_codes: unique(reasonCodes),
    read_context_required: readContextRequired,
    selector_ids: selectorIds ?? [],
  };
}

function sanitizeSelectorSnapshot(selector: RetrievalSelector): SelectorFirstPushContextSelectorSnapshot {
  return pruneUndefined({
    selector_id: retrievalSelectorId(selector),
    kind: selector.kind,
    scope_id: selector.scope_id,
    slug: selector.slug,
    path: selector.path,
    section_id: selector.section_id,
    source_ref: selector.source_ref,
    line_start: selector.line_start,
    line_end: selector.line_end,
    char_start: selector.char_start,
    char_end: selector.char_end,
    object_id: selector.object_id,
    content_hash: selector.content_hash,
    freshness: selector.freshness,
  });
}

function selectorSnapshotArray(value: unknown): SelectorFirstPushContextSelectorSnapshot[] | null {
  if (!Array.isArray(value)) return null;
  const snapshots: SelectorFirstPushContextSelectorSnapshot[] = [];
  for (const selector of value) {
    if (!isRecord(selector)) return null;
    if (typeof selector.selector_id !== 'string' || selector.selector_id.length === 0) return null;
    if (typeof selector.kind !== 'string' || selector.kind.length === 0) return null;
    if (!selectorFieldShapesAreValid(selector)) return null;
    try {
      normalizeRetrievalSelector(selector as unknown as RetrievalSelector);
    } catch {
      return null;
    }
    snapshots.push(selector as unknown as SelectorFirstPushContextSelectorSnapshot);
  }
  return snapshots;
}

function hasUnsanitizedSelectorSnapshot(value: SelectorFirstPushContextSelectorSnapshot[]): boolean {
  return value.some((selector) => hasUnknownKeys(selector as unknown as Record<string, unknown>, SELECTOR_SNAPSHOT_FIELDS));
}

function selectorSnapshotArrayHasInvalidShape(value: unknown): boolean {
  return Array.isArray(value) && selectorSnapshotArray(value) === null;
}

function selectorFieldShapesAreValid(selector: Record<string, unknown>): boolean {
  if (hasUnknownKeys(selector, SELECTOR_SNAPSHOT_FIELDS)) return false;

  for (const field of STRING_SELECTOR_SNAPSHOT_FIELDS) {
    const value = selector[field];
    if (value !== undefined && typeof value !== 'string') return false;
  }
  for (const field of INTEGER_SELECTOR_SNAPSHOT_FIELDS) {
    const value = selector[field];
    if (value !== undefined && !isNonnegativeInteger(value)) return false;
  }
  const freshness = selector.freshness;
  if (
    freshness !== undefined
    && freshness !== 'current'
    && freshness !== 'stale'
    && freshness !== 'unknown'
  ) {
    return false;
  }

  return true;
}

function scopeGateShapeIsValid(scopeGate: Record<string, unknown>): boolean {
  return isScopeGatePolicy(scopeGate.policy)
    && isScopeGateScope(scopeGate.resolved_scope)
    && typeof scopeGate.decision_reason === 'string'
    && stringArray(scopeGate.summary_lines) !== null;
}

function isScopeGatePolicy(value: unknown): boolean {
  return value === 'allow' || value === 'defer' || value === 'deny';
}

function isScopeGateScope(value: unknown): boolean {
  return value === 'work' || value === 'personal' || value === 'mixed' || value === 'unknown';
}

function hasRawAnswerField(value: unknown): boolean {
  return hasKeyMatching(value, (key) =>
    key === 'text'
    || key === 'raw_text'
    || key === 'raw_content'
    || key === 'raw_answer'
    || key === 'answer_text'
    || key === 'page_text'
    || key === 'compiled_truth'
    || key === 'timeline'
    || key === 'chunk_text'
    || key === 'proposed_content'
    || key === 'personal_memory_text'
    || key === 'source_excerpt'
    || key === 'evidence_text'
    || key === 'answer_ground'
  );
}

function hasCandidateAnswerField(value: unknown): boolean {
  return hasKeyMatching(value, (key) =>
    key === 'candidate_ids'
    || key === 'candidate_id'
    || key === 'candidate_content'
    || key === 'candidate_answer'
    || key === 'candidate_summary'
  );
}

function hasKeyMatching(value: unknown, matches: (key: string) => boolean): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasKeyMatching(item, matches));

  for (const [key, nested] of Object.entries(value)) {
    if (matches(key)) return true;
    if (hasKeyMatching(nested, matches)) return true;
  }
  return false;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((entry) => typeof entry === 'string')) return null;
  return [...value];
}

function isPositiveInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isNonnegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isConfidence(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pruneUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function sameStringList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => right[index] === value);
}

function hasUnknownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

const TOP_LEVEL_FIELDS = new Set([
  'schema_version',
  'envelope_kind',
  'request_id',
  'created_at',
  'expires_at',
  'ttl_ms',
  'trace_ids',
  'selector_ids',
  'selector_snapshots',
  'content_hashes',
  'source_ref_count',
  'confidence',
  'not_answer_ground_until_read_context',
  'required_next_tool',
  'answer_readiness',
  'read_context_arguments',
  'scope_gate',
]);

const ANSWER_READINESS_FIELDS = new Set([
  'ready',
  'must_read_context',
  'reason_codes',
]);

const READ_CONTEXT_ARGUMENT_FIELDS = new Set([
  'selectors',
]);

const SCOPE_GATE_FIELDS = new Set([
  'policy',
  'resolved_scope',
  'decision_reason',
  'summary_lines',
]);

const SELECTOR_SNAPSHOT_FIELDS = new Set([
  'selector_id',
  'kind',
  'scope_id',
  'slug',
  'path',
  'section_id',
  'source_ref',
  'line_start',
  'line_end',
  'char_start',
  'char_end',
  'object_id',
  'content_hash',
  'freshness',
]);

const STRING_SELECTOR_SNAPSHOT_FIELDS = [
  'selector_id',
  'kind',
  'scope_id',
  'slug',
  'path',
  'section_id',
  'source_ref',
  'object_id',
  'content_hash',
] as const;

const INTEGER_SELECTOR_SNAPSHOT_FIELDS = [
  'line_start',
  'line_end',
  'char_start',
  'char_end',
] as const;
