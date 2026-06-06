import type { Operation } from './operations.ts';
import {
  createAssertionPipelineService,
  type SourceChunkExtractionInput,
} from './services/assertion-pipeline-service.ts';
import type { ExtractedClaimInput } from './assertions/assertion-types.ts';
import { listRetrievableAssertionsForEngine } from './assertions/assertion-retrieval-store.ts';
import {
  explainAssertionForEngine,
  explainProjectionForEngine,
} from './assertions/assertion-lineage-store.ts';
import {
  buildSessionGrantPolicyInput,
  evaluateSessionSourceGrant,
  evaluateSessionWriteGrant,
} from './assertions/session-grants.ts';

type OperationErrorCtor = new (
  code: 'invalid_params',
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

export function createAssertionOperations(
  deps: { OperationError: OperationErrorCtor },
): Operation[] {
  const preview_assertion_claim_extraction: Operation = {
    name: 'preview_assertion_claim_extraction',
    description: 'Preview Phase 03 extraction from one source chunk into extracted claims.',
    params: {
      source_id: { type: 'string', required: true, description: 'Source id.' },
      source_item_id: { type: 'string', required: true, description: 'Source item id.' },
      source_chunk_id: { type: 'string', required: true, description: 'Source chunk id.' },
      chunk_text: { type: 'string', required: true, description: 'Source chunk text.' },
      extractor_kind: { type: 'string', required: true, description: 'Extractor kind.' },
      extractor_version: { type: 'string', required: true, description: 'Extractor version.' },
      runner_job_id: { type: 'string', nullable: true, description: 'Optional runner job id.' },
      session_id: { type: 'string', nullable: true, description: 'Optional originating session id.' },
      task_event_id: { type: 'string', nullable: true, description: 'Optional originating task event id.' },
      prompt_injection_flag: { type: 'boolean', description: 'Whether the chunk was prompt-injection flagged.' },
      secret_flag: { type: 'boolean', description: 'Whether the chunk carried a secret flag.' },
      extracted_claims: { type: 'array', required: true, items: { type: 'object' }, description: 'Structured extracted claim payloads to normalize.' },
      now: { type: 'string', description: 'Optional ISO timestamp for deterministic preview.' },
    },
    handler: async (_ctx, p) => {
      const claims = arrayParam(deps, 'extracted_claims', p.extracted_claims) as ExtractedClaimInput[];
      const service = createAssertionPipelineService({
        now: () => optionalString(deps, 'now', p.now) ?? new Date().toISOString(),
        extractor: async () => claims,
      });
      return service.extractClaimsFromSourceChunk(sourceChunkExtractionInput(deps, p));
    },
    cliHints: { name: 'assertion-claim-extract-preview' },
  };

  const preview_assertion_resolution: Operation = {
    name: 'preview_assertion_resolution',
    description: 'Preview resolving one extracted claim into assertion/evidence records.',
    params: {
      claim: { type: 'object', required: true, description: 'Extracted claim input.' },
      now: { type: 'string', description: 'Optional ISO timestamp for deterministic preview.' },
    },
    handler: async (_ctx, p) => {
      const claim = objectParam(deps, 'claim', p.claim) as unknown as ExtractedClaimInput;
      const service = createAssertionPipelineService({
        now: () => optionalString(deps, 'now', p.now) ?? new Date().toISOString(),
        extractor: async () => [],
      });
      const created = await service.createExtractedClaim(claim);
      return service.resolveExtractedClaim(created.id);
    },
    cliHints: { name: 'assertion-resolve-preview' },
  };

  const evaluate_session_source_grant: Operation = {
    name: 'evaluate_session_source_grant',
    description: 'Evaluate a Phase 03 session_source_grant against a raw source access request.',
    params: {
      grant: { type: 'object', required: true, description: 'Session source grant.' },
      request: { type: 'object', required: true, description: 'Requested raw source access.' },
    },
    handler: async (_ctx, p) => evaluateSessionSourceGrant(
      objectParam(deps, 'grant', p.grant) as any,
      objectParam(deps, 'request', p.request) as any,
    ),
    cliHints: { name: 'session-source-grant-evaluate' },
  };

  const evaluate_session_write_grant: Operation = {
    name: 'evaluate_session_write_grant',
    description: 'Evaluate a Phase 03 session_write_grant against a write policy request.',
    params: {
      grant: { type: 'object', required: true, description: 'Session write grant.' },
      request: { type: 'object', required: true, description: 'Requested write policy outcome.' },
    },
    handler: async (_ctx, p) => evaluateSessionWriteGrant(
      objectParam(deps, 'grant', p.grant) as any,
      objectParam(deps, 'request', p.request) as any,
    ),
    cliHints: { name: 'session-write-grant-evaluate' },
  };

  const build_session_grant_policy_input: Operation = {
    name: 'build_session_grant_policy_input',
    description: 'Build policy input from a Phase 03 session_grant record.',
    params: {
      grant: { type: 'object', required: true, description: 'Session grant.' },
      requested_at: { type: 'string', description: 'Optional ISO timestamp for active/expired evaluation.' },
    },
    handler: async (_ctx, p) => buildSessionGrantPolicyInput(
      objectParam(deps, 'grant', p.grant) as any,
      new Date(optionalString(deps, 'requested_at', p.requested_at) ?? new Date().toISOString()),
    ),
    cliHints: { name: 'session-grant-policy-input' },
  };

  const list_retrievable_assertions: Operation = {
    name: 'list_retrievable_assertions',
    description: 'List lifecycle-aware assertion retrieval plans: active answer-grounding, stale verify-first, audit-only history.',
    params: {
      target_slug: { type: 'string', description: 'Optional target slug filter.' },
      mode: { type: 'string', description: 'Retrieval mode: default or audit.' },
      scope_id: { type: 'string', description: 'Assertion retrieval scope id. Defaults to workspace:default.' },
      include_candidates: { type: 'boolean', description: 'Include candidate assertions as verify-first plans.' },
      include_rejected: { type: 'boolean', description: 'Include rejected assertions as audit-only plans.' },
      limit: { type: 'number', description: 'Maximum retrieval plans to return.' },
    },
    handler: async (ctx, p) => listRetrievableAssertionsForEngine(ctx.engine, {
      target_slug: optionalString(deps, 'target_slug', p.target_slug),
      mode: optionalAssertionRetrievalMode(deps, p.mode),
      scope_id: optionalString(deps, 'scope_id', p.scope_id) ?? 'workspace:default',
      include_candidates: optionalBoolean(deps, 'include_candidates', p.include_candidates),
      include_rejected: optionalBoolean(deps, 'include_rejected', p.include_rejected),
      limit: optionalNumber(deps, 'limit', p.limit),
    }),
    cliHints: { name: 'assertion-retrieval' },
  };

  const explain_assertion: Operation = {
    name: 'explain_assertion',
    description: 'Explain Phase 12 assertion audit lineage from source chunks to claims, evidence, canonical writes, and projections.',
    params: {
      assertion_id: { type: 'string', description: 'Assertion id to explain.' },
      target_slug: { type: 'string', description: 'Target slug whose assertions should be explained when assertion_id is omitted.' },
      scope_id: { type: 'string', description: 'Assertion lineage scope id. Defaults to workspace:default.' },
      include_raw: { type: 'boolean', description: 'Include raw chunk text only for non-secret, non-injection source chunks.' },
      limit: { type: 'number', description: 'Maximum assertions to explain when using target_slug.' },
    },
    handler: async (ctx, p) => {
      const assertion_id = optionalString(deps, 'assertion_id', p.assertion_id);
      const target_slug = optionalString(deps, 'target_slug', p.target_slug);
      if (!assertion_id && !target_slug) {
        throw new deps.OperationError('invalid_params', 'assertion_id or target_slug is required');
      }
      return explainAssertionForEngine(ctx.engine, {
        assertion_id,
        target_slug,
        scope_id: optionalString(deps, 'scope_id', p.scope_id) ?? 'workspace:default',
        include_raw: optionalBoolean(deps, 'include_raw', p.include_raw),
        limit: optionalNumber(deps, 'limit', p.limit),
      });
    },
    cliHints: { name: 'assertion-explain' },
  };

  const explain_projection: Operation = {
    name: 'explain_projection',
    description: 'Explain Phase 12 projection audit lineage from projection target back to assertions, claims, and source chunks.',
    params: {
      projection_target_id: { type: 'string', description: 'Canonical projection target id to explain.' },
      target_type: { type: 'string', description: 'Projection target_type when projection_target_id is omitted.' },
      target_id: { type: 'string', description: 'Projection target_id when projection_target_id is omitted.' },
      include_raw: { type: 'boolean', description: 'Include raw chunk text only for non-secret, non-injection source chunks.' },
      limit: { type: 'number', description: 'Maximum projections to explain when using target_type/target_id.' },
    },
    handler: async (ctx, p) => {
      const projection_target_id = optionalString(deps, 'projection_target_id', p.projection_target_id);
      const target_type = optionalString(deps, 'target_type', p.target_type);
      const target_id = optionalString(deps, 'target_id', p.target_id);
      if (!projection_target_id && (!target_type || !target_id)) {
        throw new deps.OperationError('invalid_params', 'projection_target_id or target_type plus target_id is required');
      }
      return explainProjectionForEngine(ctx.engine, {
        projection_target_id,
        target_type,
        target_id,
        include_raw: optionalBoolean(deps, 'include_raw', p.include_raw),
        limit: optionalNumber(deps, 'limit', p.limit),
      });
    },
    cliHints: { name: 'projection-explain' },
  };

  return [
    preview_assertion_claim_extraction,
    preview_assertion_resolution,
    evaluate_session_source_grant,
    evaluate_session_write_grant,
    build_session_grant_policy_input,
    list_retrievable_assertions,
    explain_assertion,
    explain_projection,
  ];
}

function sourceChunkExtractionInput(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
): SourceChunkExtractionInput {
  return {
    source_id: stringParam(deps, 'source_id', p.source_id),
    source_item_id: stringParam(deps, 'source_item_id', p.source_item_id),
    source_chunk_id: stringParam(deps, 'source_chunk_id', p.source_chunk_id),
    chunk_text: stringParam(deps, 'chunk_text', p.chunk_text),
    extractor_kind: stringParam(deps, 'extractor_kind', p.extractor_kind),
    extractor_version: stringParam(deps, 'extractor_version', p.extractor_version),
    runner_job_id: optionalNullableString(deps, 'runner_job_id', p.runner_job_id),
    session_id: optionalNullableString(deps, 'session_id', p.session_id),
    task_event_id: optionalNullableString(deps, 'task_event_id', p.task_event_id),
    prompt_injection_flag: optionalBoolean(deps, 'prompt_injection_flag', p.prompt_injection_flag),
    secret_flag: optionalBoolean(deps, 'secret_flag', p.secret_flag),
  };
}

function stringParam(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new deps.OperationError('invalid_params', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | undefined {
  if (value == null) return undefined;
  return stringParam(deps, field, value);
}

function optionalNullableString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | null | undefined {
  if (value === null) return null;
  return optionalString(deps, field, value);
}

function optionalBoolean(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') {
    throw new deps.OperationError('invalid_params', `${field} must be a boolean`);
  }
  return value;
}

function optionalNumber(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new deps.OperationError('invalid_params', `${field} must be a finite number`);
  }
  if (value < 0) {
    throw new deps.OperationError('invalid_params', `${field} must be greater than or equal to 0`);
  }
  return Math.floor(value);
}

function optionalAssertionRetrievalMode(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): 'default' | 'audit' | undefined {
  if (value == null) return undefined;
  const mode = stringParam(deps, 'mode', value);
  if (mode !== 'default' && mode !== 'audit') {
    throw new deps.OperationError('invalid_params', 'mode must be default or audit');
  }
  return mode;
}

function objectParam(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new deps.OperationError('invalid_params', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayParam(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new deps.OperationError('invalid_params', `${field} must be an array`);
  }
  return value;
}
