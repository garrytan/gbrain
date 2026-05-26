import {
  stableId,
  type TaskEventRecord,
} from './assertion-types.ts';

export interface SessionGrant {
  id: string;
  session_id: string;
  realm: string;
  allowed_tools: string[];
  raw_access_policy: unknown;
  write_policy: unknown;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface SessionSourceGrant {
  id: string;
  session_id: string;
  source_id?: string | null;
  source_kind?: string | null;
  raw_scope: string;
  max_chunk_count?: number | null;
  chunk_limit?: number | null;
  valid_from?: string | null;
  valid_until?: string | null;
  sensitivity_ceiling: string;
  expires_at?: string | null;
  revoked_at?: string | null;
}

export interface SessionWriteGrant {
  id: string;
  session_id: string;
  target_scope: string;
  allowed_policy_outcomes: string[];
  expires_at?: string | null;
  revoked_at?: string | null;
}

export interface SessionSourceGrantRequest {
  session_id: string;
  source_id?: string;
  source_kind?: string;
  raw_scope: 'metadata' | 'chunks' | 'full';
  chunk_count?: number;
  sensitivity_level?: string;
  requested_at?: string;
}

export interface SessionWriteGrantRequest {
  session_id: string;
  target_scope: string;
  policy_outcome: string;
  requested_at?: string;
}

export interface GrantDecision {
  allowed: boolean;
  denial_reason: string | null;
}

const SENSITIVITY_ORDER = ['public', 'normal', 'internal', 'personal', 'sensitive', 'secret'];

export function buildSessionGrantPolicyInput(
  grant: {
    session_id: string;
    realm: string;
    allowed_tools: string[];
    raw_access_policy: unknown;
    write_policy: unknown;
    expires_at?: string | null;
    revoked_at?: string | null;
  },
  requestedAt: Date,
) {
  const inactiveReason = inactiveGrantReason(grant, requestedAt);
  return {
    session_id: grant.session_id,
    realm: grant.realm,
    allowed_tools: [...grant.allowed_tools],
    raw_access_policy: grant.raw_access_policy,
    write_policy: grant.write_policy,
    active: inactiveReason === null,
    inactive_reason: inactiveReason,
  };
}

export function evaluateSessionSourceGrant(
  grant: SessionSourceGrant | {
    session_id: string;
    source_id?: string | null;
    source_kind?: string | null;
    raw_scope: string;
    max_chunk_count?: number | null;
    valid_from?: string | null;
    valid_until?: string | null;
    sensitivity_ceiling: string;
    revoked_at?: string | null;
  },
  request: SessionSourceGrantRequest | {
    session_id: string;
    source_id?: string;
    source_kind?: string;
    raw_scope: string;
    chunk_count?: number;
    sensitivity_level?: string;
    requested_at?: Date | string;
  },
): GrantDecision {
  if (grant.session_id !== request.session_id) return deny('session_mismatch');
  if (grant.source_id && request.source_id !== grant.source_id) return deny('source_id_mismatch');
  if (grant.source_kind && request.source_kind !== grant.source_kind) return deny('source_kind_mismatch');
  if (request.raw_scope !== grant.raw_scope) return deny('raw_scope_denied');
  const chunkLimit = 'max_chunk_count' in grant
    ? grant.max_chunk_count
    : 'chunk_limit' in grant
      ? grant.chunk_limit
      : null;
  if (chunkLimit != null && (request.chunk_count ?? 0) > chunkLimit) {
    return deny('chunk_limit_exceeded');
  }
  const timeDecision = evaluateSourceGrantWindow(grant, request.requested_at);
  if (!timeDecision.allowed) return timeDecision;
  if (sensitivityRank(request.sensitivity_level ?? 'normal') > sensitivityRank(grant.sensitivity_ceiling)) {
    return deny('sensitivity_ceiling_exceeded');
  }
  return allow();
}

export function evaluateSessionWriteGrant(
  grant: SessionWriteGrant | {
    session_id: string;
    target_scope: string;
    allowed_policy_outcomes: string[];
    expires_at?: string | null;
    revocation_state?: string;
    revoked_at?: string | null;
  },
  request: SessionWriteGrantRequest | {
    session_id: string;
    target_scope: string;
    policy_outcome: string;
    requested_at?: Date | string;
  },
): GrantDecision {
  if (grant.revoked_at || ('revocation_state' in grant && grant.revocation_state === 'revoked')) return deny('grant_revoked');
  if (grant.session_id !== request.session_id) return deny('session_mismatch');
  if (grant.target_scope !== request.target_scope) return deny('target_scope_denied');
  if (!grant.allowed_policy_outcomes.includes(request.policy_outcome)) {
    return deny('policy_outcome_denied');
  }
  const timeDecision = evaluateGrantWindow(grant, request.requested_at);
  if (!timeDecision.allowed) return timeDecision;
  return allow();
}

export function appendTaskEventAssertionLinks(
  history: readonly TaskEventRecord[],
  input: {
    event: Omit<TaskEventRecord, 'id' | 'generated_assertion_ids' | 'payload_hash'> & {
      id?: string;
      generated_assertion_ids?: string[];
      payload_hash?: string | null;
    };
    assertion_ids: readonly string[];
  },
): TaskEventRecord[] {
  const event: TaskEventRecord = {
    id: input.event.id ?? stableId('task-event', input.event.task_id ?? '', input.event.event_kind, input.event.created_at),
    task_id: input.event.task_id,
    session_id: input.event.session_id,
    event_kind: input.event.event_kind,
    actor: input.event.actor,
    summary: input.event.summary,
    payload_hash: input.event.payload_hash ?? null,
    source_refs: [...input.event.source_refs],
    generated_assertion_ids: [...new Set([...(input.event.generated_assertion_ids ?? []), ...input.assertion_ids])],
    created_at: input.event.created_at,
  };
  return [...history, event];
}

export function linkGeneratedAssertionsToTaskEvent(input: {
  events: ReadonlyArray<Record<string, any>>;
  event: Record<string, any>;
  assertions: ReadonlyArray<Record<string, any> & { id: string }>;
}) {
  const assertionIds = input.assertions.map((assertion) => assertion.id);
  const event = {
    ...structuredClone(input.event),
    generated_assertion_ids: assertionIds,
  };
  return {
    events: [
      ...structuredClone(input.events),
      event,
    ],
    assertions: input.assertions.map((assertion) => ({
      ...structuredClone(assertion),
      origin_session_id: input.event.session_id,
      origin_task_event_id: input.event.id,
      origin_task_id: input.event.task_id ?? input.event.task_thread_id ?? null,
    })),
    lineage: assertionIds.map((assertion_id) => ({
      assertion_id,
      session_id: input.event.session_id,
      task_event_id: input.event.id,
      task_id: input.event.task_id ?? input.event.task_thread_id ?? null,
      link_type: 'generated_from_task_event',
    })),
  };
}

function evaluateGrantWindow(
  grant: { expires_at?: string | null; revoked_at?: string | null },
  requestedAt?: Date | string,
): GrantDecision {
  if (grant.revoked_at) return deny('grant_revoked');
  if (grant.expires_at) {
    const requestTime = toDate(requestedAt ?? new Date()).getTime();
    if (requestTime > new Date(grant.expires_at).getTime()) {
      return deny('grant_expired');
    }
  }
  return allow();
}

function evaluateSourceGrantWindow(
  grant: { valid_from?: string | null; valid_until?: string | null; expires_at?: string | null; revoked_at?: string | null },
  requestedAt?: Date | string,
): GrantDecision {
  if (grant.revoked_at) return deny('grant_revoked');
  const requestTime = toDate(requestedAt ?? new Date()).getTime();
  if (grant.valid_from && requestTime < new Date(grant.valid_from).getTime()) return deny('time_window_not_started');
  const validUntil = grant.valid_until ?? grant.expires_at;
  if (validUntil && requestTime > new Date(validUntil).getTime()) return deny('time_window_expired');
  return allow();
}

function inactiveGrantReason(
  grant: { expires_at?: string | null; revoked_at?: string | null },
  requestedAt: Date,
): string | null {
  if (grant.revoked_at) return 'grant_revoked';
  if (grant.expires_at && requestedAt.getTime() > new Date(grant.expires_at).getTime()) return 'grant_expired';
  return null;
}

function sensitivityRank(value: string): number {
  const index = SENSITIVITY_ORDER.indexOf(value);
  return index === -1 ? SENSITIVITY_ORDER.indexOf('normal') : index;
}

function allow(): GrantDecision {
  return { allowed: true, denial_reason: null };
}

function deny(denial_reason: string): GrantDecision {
  return { allowed: false, denial_reason };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
