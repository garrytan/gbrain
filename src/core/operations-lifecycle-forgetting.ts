import type { Operation } from './operations.ts';
import { createLifecycleForgettingServiceForEngine } from './services/lifecycle-forgetting-engine-service.ts';

type OperationErrorCtor = new (
  code: 'invalid_params',
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

export function createLifecycleForgettingOperations(
  deps: { OperationError: OperationErrorCtor },
): Operation[] {
  const get_lifecycle_forgetting_report: Operation = {
    name: 'get_lifecycle_forgetting_report',
    description: 'Return the Phase 08 lifecycle forgetting audit report for one scope.',
    params: {
      scope_id: { type: 'string', description: 'Lifecycle scope id; defaults to workspace:default.' },
      now: { type: 'string', description: 'Optional ISO timestamp for deterministic reports.' },
      limit: { type: 'number', description: 'Maximum lifecycle rows to inspect.' },
    },
    handler: async (ctx, p) => {
      const now = optionalString(deps, 'now', p.now) ?? new Date().toISOString();
      return createLifecycleForgettingServiceForEngine(ctx.engine, () => now).buildDailyReport({
        scope_id: optionalString(deps, 'scope_id', p.scope_id) ?? 'workspace:default',
        now,
        limit: optionalNumber(deps, 'limit', p.limit),
      });
    },
    mutating: false,
    cliHints: { name: 'lifecycle-report' },
  };

  const plan_lifecycle_purge: Operation = {
    name: 'plan_lifecycle_purge',
    description: 'Create a reviewed purge plan for due expired or archived lifecycle rows.',
    params: {
      scope_id: { type: 'string', description: 'Lifecycle scope id; defaults to workspace:default.' },
      reason: { type: 'string', description: 'Reason for the purge plan.' },
      requested_by: { type: 'string', description: 'Actor requesting the plan.' },
      now: { type: 'string', description: 'Optional ISO timestamp for deterministic planning.' },
      limit: { type: 'number', description: 'Maximum lifecycle rows to inspect.' },
    },
    handler: async (ctx, p) => {
      const now = optionalString(deps, 'now', p.now) ?? new Date().toISOString();
      return createLifecycleForgettingServiceForEngine(ctx.engine, () => now).planPurgeCandidates({
        scope_id: optionalString(deps, 'scope_id', p.scope_id) ?? 'workspace:default',
        reason: optionalString(deps, 'reason', p.reason) ?? 'manual lifecycle purge review',
        requested_by: optionalString(deps, 'requested_by', p.requested_by) ?? 'mbrain:cli',
        now,
        limit: optionalNumber(deps, 'limit', p.limit),
      });
    },
    mutating: true,
    cliHints: { name: 'lifecycle-plan-purge' },
  };

  const restore_lifecycle_memory: Operation = {
    name: 'restore_lifecycle_memory',
    description: 'Restore a stale, expired, or archived lifecycle row where policy allows.',
    params: {
      entity_type: { type: 'string', required: true, description: 'Lifecycle entity type.' },
      entity_id: { type: 'string', required: true, description: 'Lifecycle entity id.' },
      scope_id: { type: 'string', description: 'Lifecycle scope id; defaults to workspace:default.' },
      to_lifecycle_state: { type: 'string', description: 'Restore target state: active or stale.' },
      reason: { type: 'string', description: 'Reason for restore.' },
      now: { type: 'string', description: 'Optional ISO timestamp for deterministic restore.' },
    },
    handler: async (ctx, p) => {
      const now = optionalString(deps, 'now', p.now) ?? new Date().toISOString();
      return createLifecycleForgettingServiceForEngine(ctx.engine, () => now).restoreEntity({
        entity_type: stringParam(deps, 'entity_type', p.entity_type),
        entity_id: stringParam(deps, 'entity_id', p.entity_id),
        scope_id: optionalString(deps, 'scope_id', p.scope_id) ?? 'workspace:default',
        to_lifecycle_state: optionalRestoreState(deps, p.to_lifecycle_state),
        reason: optionalString(deps, 'reason', p.reason) ?? 'manual lifecycle restore',
        now,
      });
    },
    mutating: true,
    cliHints: { name: 'lifecycle-restore' },
  };

  const review_lifecycle_purge_plan: Operation = {
    name: 'review_lifecycle_purge_plan',
    description: 'Approve, reject, or cancel a reviewed lifecycle purge plan before destructive purge.',
    params: {
      purge_plan_id: { type: 'string', required: true, description: 'Purge plan id returned by plan_lifecycle_purge.' },
      decision: { type: 'string', required: true, enum: ['approve', 'reject', 'cancel'], description: 'Review decision for the purge plan.' },
      review_reason: { type: 'string', required: true, description: 'Human-readable review reason for auditability.' },
      now: { type: 'string', description: 'Optional ISO timestamp for deterministic review.' },
    },
    handler: async (ctx, p) => {
      const now = optionalString(deps, 'now', p.now) ?? new Date().toISOString();
      return createLifecycleForgettingServiceForEngine(ctx.engine, () => now).reviewPurgePlan({
        purge_plan_id: stringParam(deps, 'purge_plan_id', p.purge_plan_id),
        decision: reviewDecisionParam(deps, p.decision),
        review_reason: stringParam(deps, 'review_reason', p.review_reason),
        now,
      });
    },
    mutating: true,
    cliHints: { name: 'lifecycle-review-purge-plan' },
  };

  const purge_lifecycle_memory: Operation = {
    name: 'purge_lifecycle_memory',
    description: 'Purge one due expired or archived lifecycle row, leaving a tombstone.',
    params: {
      entity_type: { type: 'string', required: true, description: 'Lifecycle entity type.' },
      entity_id: { type: 'string', required: true, description: 'Lifecycle entity id.' },
      scope_id: { type: 'string', description: 'Lifecycle scope id; defaults to workspace:default.' },
      reason: { type: 'string', description: 'Reason for purge.' },
      content_hash: { type: 'string', description: 'Optional pre-purge content hash.' },
      purge_plan_id: { type: 'string', required: true, description: 'Approved reviewed purge plan id.' },
      now: { type: 'string', description: 'Optional ISO timestamp for deterministic purge.' },
    },
    handler: async (ctx, p) => {
      const now = optionalString(deps, 'now', p.now) ?? new Date().toISOString();
      return createLifecycleForgettingServiceForEngine(ctx.engine, () => now).purgeEntity({
        entity_type: stringParam(deps, 'entity_type', p.entity_type),
        entity_id: stringParam(deps, 'entity_id', p.entity_id),
        scope_id: optionalString(deps, 'scope_id', p.scope_id) ?? 'workspace:default',
        reason: optionalString(deps, 'reason', p.reason) ?? 'manual lifecycle purge',
        content_hash: optionalString(deps, 'content_hash', p.content_hash) ?? null,
        purge_plan_id: stringParam(deps, 'purge_plan_id', p.purge_plan_id),
        now,
      });
    },
    mutating: true,
    cliHints: { name: 'lifecycle-purge' },
  };

  return [
    get_lifecycle_forgetting_report,
    plan_lifecycle_purge,
    restore_lifecycle_memory,
    review_lifecycle_purge_plan,
    purge_lifecycle_memory,
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

function optionalNumber(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new deps.OperationError('invalid_params', `${field} must be a number`);
  }
  return value;
}

function optionalRestoreState(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): 'active' | 'stale' | undefined {
  if (value == null) return undefined;
  const state = stringParam(deps, 'to_lifecycle_state', value);
  if (state !== 'active' && state !== 'stale') {
    throw new deps.OperationError('invalid_params', 'to_lifecycle_state must be active or stale');
  }
  return state;
}

function reviewDecisionParam(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): 'approve' | 'reject' | 'cancel' {
  const decision = stringParam(deps, 'decision', value);
  if (decision !== 'approve' && decision !== 'reject' && decision !== 'cancel') {
    throw new deps.OperationError('invalid_params', 'decision must be approve, reject, or cancel');
  }
  return decision;
}
