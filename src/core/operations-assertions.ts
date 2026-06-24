import type { Operation } from './operations.ts';
import { listRetrievableAssertionsForEngine } from './assertions/assertion-retrieval-store.ts';
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

  return [
    evaluate_session_source_grant,
    evaluate_session_write_grant,
    build_session_grant_policy_input,
    list_retrievable_assertions,
  ];
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
