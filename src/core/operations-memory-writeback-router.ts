import { randomUUID } from 'crypto';
import type { Operation } from './operations.ts';
import {
  MEMORY_WRITEBACK_EVIDENCE_KINDS,
  routeMemoryWriteback,
} from './services/memory-writeback-router-service.ts';
import { createMemoryCandidateEntryWithStatusEvent } from './services/memory-inbox-service.ts';
import { reviewDuplicateMemory } from './services/duplicate-memory-review-service.ts';
import type {
  MemoryCandidateSensitivity,
  MemoryCandidateTargetObjectType,
  MemoryCandidateType,
  MemoryScenarioSourceKind,
  RouteMemoryWritebackInput,
} from './types.ts';

type OperationErrorCtor = new (
  code: any,
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

const MEMORY_SCENARIO_SOURCE_KIND_VALUES = [
  'chat',
  'code_event',
  'import',
  'meeting',
  'cron',
  'manual',
  'session_end',
  'trace_review',
] as const satisfies readonly MemoryScenarioSourceKind[];

const MEMORY_CANDIDATE_TYPE_VALUES = [
  'fact',
  'relationship',
  'note_update',
  'procedure',
  'profile_update',
  'open_question',
  'rationale',
] as const satisfies readonly MemoryCandidateType[];

const MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES = [
  'curated_note',
  'procedure',
  'profile_memory',
  'personal_episode',
  'other',
] as const satisfies readonly MemoryCandidateTargetObjectType[];

const MEMORY_CANDIDATE_SENSITIVITY_VALUES = [
  'public',
  'work',
  'personal',
  'secret',
  'unknown',
] as const satisfies readonly MemoryCandidateSensitivity[];

function invalidParams(
  deps: { OperationError: OperationErrorCtor },
  message: string,
): Error {
  return new deps.OperationError('invalid_params', message);
}

function requireString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string {
  if (typeof value !== 'string') {
    throw invalidParams(deps, `${field} must be a string`);
  }
  return value;
}

function optionalString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') {
    throw invalidParams(deps, `${field} must be a string`);
  }
  return value;
}

function optionalStringArray(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === 'string')) {
      throw invalidParams(deps, `${field} must be an array of strings`);
    }
    return value;
  }
  if (typeof value !== 'string') {
    throw invalidParams(deps, `${field} must be an array of strings`);
  }

  const trimmed = value.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw invalidParams(deps, `${field} must be valid JSON when passed as an array string`);
    }
    if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === 'string')) {
      throw invalidParams(deps, `${field} must be an array of strings`);
    }
    return parsed;
  }

  return trimmed
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function optionalNumber(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidParams(deps, `${field} must be a finite number`);
  }
  return value;
}

function optionalBoolean(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') {
    throw invalidParams(deps, `${field} must be a boolean`);
  }
  return value;
}

function requireEnumValue<T extends string>(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalidParams(deps, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function optionalEnumValue<T extends string>(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  if (value == null) return undefined;
  return requireEnumValue(deps, field, value, allowed);
}

function parseRouteMemoryWritebackInput(
  deps: { OperationError: OperationErrorCtor },
  params: Record<string, unknown>,
): RouteMemoryWritebackInput {
  return {
    content: requireString(deps, 'content', params.content),
    source_refs: optionalStringArray(deps, 'source_refs', params.source_refs),
    source_kind: optionalEnumValue(deps, 'source_kind', params.source_kind, MEMORY_SCENARIO_SOURCE_KIND_VALUES),
    evidence_kind: requireEnumValue(deps, 'evidence_kind', params.evidence_kind, MEMORY_WRITEBACK_EVIDENCE_KINDS),
    candidate_type: optionalEnumValue(deps, 'candidate_type', params.candidate_type, MEMORY_CANDIDATE_TYPE_VALUES),
    target_object_type: optionalEnumValue(
      deps,
      'target_object_type',
      params.target_object_type,
      MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES,
    ),
    target_object_id: optionalString(deps, 'target_object_id', params.target_object_id),
    scope_id: optionalString(deps, 'scope_id', params.scope_id),
    sensitivity: optionalEnumValue(deps, 'sensitivity', params.sensitivity, MEMORY_CANDIDATE_SENSITIVITY_VALUES),
    confidence_score: optionalNumber(deps, 'confidence_score', params.confidence_score),
    importance_score: optionalNumber(deps, 'importance_score', params.importance_score),
    recurrence_score: optionalNumber(deps, 'recurrence_score', params.recurrence_score),
    interaction_id: optionalString(deps, 'interaction_id', params.interaction_id),
    allow_canonical_write: optionalBoolean(deps, 'allow_canonical_write', params.allow_canonical_write),
    apply: optionalBoolean(deps, 'apply', params.apply),
  };
}

export function createMemoryWritebackRouterOperations(
  deps: { defaultScopeId: string; OperationError: OperationErrorCtor },
): Operation[] {
  const route_memory_writeback: Operation = {
    name: 'route_memory_writeback',
    description: 'Route a possible durable memory writeback to a reviewable candidate or deferred/no-write decision.',
    params: {
      content: { type: 'string', required: true, description: 'Claim, observation, or proposed memory content to route' },
      source_refs: { type: 'array', items: { type: 'string' }, description: 'Provenance references for the writeback signal' },
      source_kind: { type: 'string', description: 'Source kind for the writeback signal', enum: [...MEMORY_SCENARIO_SOURCE_KIND_VALUES] },
      evidence_kind: {
        type: 'string',
        required: true,
        description: 'Evidence quality and writeback safety category',
        enum: [...MEMORY_WRITEBACK_EVIDENCE_KINDS],
      },
      candidate_type: { type: 'string', description: 'Optional memory candidate type override', enum: [...MEMORY_CANDIDATE_TYPE_VALUES] },
      target_object_type: {
        type: 'string',
        description: 'Optional canonical target object type',
        enum: [...MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES],
      },
      target_object_id: { type: 'string', description: 'Optional canonical target object id' },
      scope_id: { type: 'string', description: `Memory candidate scope id (default: ${deps.defaultScopeId})` },
      sensitivity: { type: 'string', description: 'Optional sensitivity classification', enum: [...MEMORY_CANDIDATE_SENSITIVITY_VALUES] },
      confidence_score: { type: 'number', description: 'Optional confidence score from 0 to 1' },
      importance_score: { type: 'number', description: 'Optional importance score from 0 to 1' },
      recurrence_score: { type: 'number', description: 'Optional recurrence score from 0 to 1' },
      interaction_id: { type: 'string', description: 'Optional retrieval trace id for lifecycle event attribution' },
      allow_canonical_write: { type: 'boolean', description: 'Whether the router may return canonical write requirements' },
      apply: { type: 'boolean', description: 'Create the routed memory candidate when the route decision allows it' },
      dry_run: { type: 'boolean', description: 'Preview routing and candidate creation without mutating memory' },
    },
    mutating: true,
    handler: async (ctx, params) => {
      const input = parseRouteMemoryWritebackInput(deps, params);
      const routed = routeMemoryWriteback(input);

      if (ctx.dryRun) {
        return {
          ...routed,
          dry_run: true,
          applied: false,
        };
      }

      if (input.apply !== true || routed.decision !== 'create_candidate' || !routed.candidate_input) {
        return routed;
      }

      const candidateInput = {
        ...routed.candidate_input,
        id: routed.candidate_input.id ?? randomUUID(),
      };
      const duplicateReview = await reviewDuplicateMemory(ctx.engine, {
        scope_id: candidateInput.scope_id,
        subject_kind: 'memory_candidate',
        subject_id: candidateInput.id,
        content: candidateInput.proposed_content,
        source_refs: candidateInput.source_refs,
        candidate_type: candidateInput.candidate_type,
        target_object_type: candidateInput.target_object_type ?? undefined,
        target_object_id: candidateInput.target_object_id ?? undefined,
        include_pages: true,
        include_candidates: true,
        limit: 5,
      });
      const created = await createMemoryCandidateEntryWithStatusEvent(ctx.engine, candidateInput);

      return {
        ...routed,
        applied: true,
        candidate_input: candidateInput,
        created_candidate: created,
        duplicate_review: duplicateReview,
      };
    },
    cliHints: { name: 'route-memory-writeback' },
  };

  return [route_memory_writeback];
}
