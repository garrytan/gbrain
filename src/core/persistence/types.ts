/** Public mutation receipts contain outcomes, never queued content or execution credentials. */
export const WRITE_REQUEST_STATES = [
  'queued', 'running', 'recovering', 'committed', 'conflict', 'failed', 'cancelled',
] as const;

export type WriteRequestState = typeof WRITE_REQUEST_STATES[number];

export const WRITE_ERROR_CODES = [
  'writer_lock_unavailable', 'writer_pool_capacity', 'owner_unavailable',
  'recovery_required', 'queue_capacity', 'revision_required', 'revision_conflict',
  'idempotency_conflict', 'source_changed', 'write_pending', 'storage_error', 'cancelled',
  'permission_denied', 'scope_denied', 'invalid_params', 'not_found', 'page_not_found',
  'page_identity_changed', 'write_claim_lost', 'request_too_large', 'response_too_large',
  'writer_registration_required', 'writer_identity_invalid', 'writer_not_initialized',
  'writer_coordinator_required', 'fact_already_expired', 'source_writeback_required',
  'unsupported_mutation_protocol', 'writer_upgrade_required', 'writer_not_quiesced',
  'skill_bundle_required', 'invalid_source_uri',
] as const;

export type WriteErrorCode = typeof WRITE_ERROR_CODES[number];

export const WRITE_HEALTH_REASONS = ['pending', 'waiting_on_earlier_write', 'database_contention', 'writer_busy',
  'revision_changed_repreparing', 'recovery_required', 'writer_pool_capacity', 'owner_unavailable',
  'writer_lock_unavailable', 'consumer_stopping', 'cause_unknown'] as const;
export const WRITE_HEALTH_ASSESSMENTS = ['pending', 'blocked', 'stalled'] as const;
export const WRITE_HEALTH_ACTIONS = ['poll', 'inspect_owner'] as const;
export interface WriteDiagnostic {
  age_ms: number;
  observed_at?: string;
  assessment: typeof WRITE_HEALTH_ASSESSMENTS[number];
  reason: typeof WRITE_HEALTH_REASONS[number];
  next_action: typeof WRITE_HEALTH_ACTIONS[number];
}

export interface WriteReceipt {
  request_id: string;
  state: WriteRequestState;
  /** Milliseconds until polling is useful; null for terminal outcomes. */
  retry_after_ms: number | null;
  revision?: string;
  compacted?: boolean;
  outcome?: Record<string, unknown>;
  persistence?: {
    mode: 'filesystem' | 'database';
    file_written?: boolean;
    git_state?: string;
  };
  created_at?: string;
  updated_at?: string;
  diagnostic?: WriteDiagnostic;
}

/** Wire names stay separate from the engine's camelCase precondition. */
export interface MutationPrecondition {
  expected_revision?: string;
  force?: boolean;
  request_id?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWriteRequestId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isWriteErrorCode(value: unknown): value is WriteErrorCode {
  return typeof value === 'string' && (WRITE_ERROR_CODES as readonly string[]).includes(value);
}

export function isTerminalWriteState(state: WriteRequestState): boolean {
  return state === 'committed' || state === 'conflict' || state === 'failed' || state === 'cancelled';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isWriteDiagnostic(value: unknown): value is WriteDiagnostic {
  if (!isRecord(value) || !Number.isSafeInteger(value.age_ms) || Number(value.age_ms) < 0
    || !(WRITE_HEALTH_ASSESSMENTS as readonly unknown[]).includes(value.assessment)
    || !(WRITE_HEALTH_REASONS as readonly unknown[]).includes(value.reason)
    || !(WRITE_HEALTH_ACTIONS as readonly unknown[]).includes(value.next_action)) return false;
  if (value.observed_at !== undefined) {
    if (typeof value.observed_at !== 'string') return false;
    const utc = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value.observed_at);
    if (!utc || !Number.isFinite(Date.parse(value.observed_at))
      || new Date(value.observed_at).toISOString() !== `${utc[1]}.${(utc[2] ?? '').padEnd(3, '0')}Z`) return false;
  }
  return true;
}

/** Validate a receipt received over a transport before exposing structured retry information. */
export function isWriteReceipt(value: unknown): value is WriteReceipt {
  if (!isRecord(value) || !isWriteRequestId(value.request_id)
    || !(WRITE_REQUEST_STATES as readonly unknown[]).includes(value.state)) return false;
  const retry = value.retry_after_ms;
  if (retry !== null && (typeof retry !== 'number' || !Number.isSafeInteger(retry) || retry < 0)) return false;
  if (isTerminalWriteState(value.state as WriteRequestState) && retry !== null) return false;
  if (value.revision !== undefined && (typeof value.revision !== 'string' || !value.revision)) return false;
  if (value.compacted !== undefined && typeof value.compacted !== 'boolean') return false;
  if (value.outcome !== undefined && !isRecord(value.outcome)) return false;
  if (value.created_at !== undefined && typeof value.created_at !== 'string') return false;
  if (value.updated_at !== undefined && typeof value.updated_at !== 'string') return false;
  if (value.diagnostic !== undefined && (!isWriteDiagnostic(value.diagnostic)
    || isTerminalWriteState(value.state as WriteRequestState))) return false;
  if (value.persistence !== undefined) {
    if (!isRecord(value.persistence) || !['filesystem', 'database'].includes(String(value.persistence.mode))) return false;
    if (value.persistence.file_written !== undefined && typeof value.persistence.file_written !== 'boolean') return false;
    if (value.persistence.git_state !== undefined && typeof value.persistence.git_state !== 'string') return false;
  }
  return true;
}

/** Select public fields explicitly so internal journal columns cannot ride error envelopes. */
export function publicWriteReceipt(receipt: WriteReceipt): WriteReceipt {
  return {
    request_id: receipt.request_id,
    state: receipt.state,
    retry_after_ms: receipt.retry_after_ms,
    ...(receipt.revision !== undefined ? { revision: receipt.revision } : {}),
    ...(receipt.compacted !== undefined ? { compacted: receipt.compacted } : {}),
    ...(receipt.outcome !== undefined ? { outcome: receipt.outcome } : {}),
    ...(receipt.persistence !== undefined ? { persistence: {
      mode: receipt.persistence.mode,
      ...(receipt.persistence.file_written !== undefined ? { file_written: receipt.persistence.file_written } : {}),
      ...(receipt.persistence.git_state !== undefined ? { git_state: receipt.persistence.git_state } : {}),
    } } : {}),
    ...(receipt.created_at !== undefined ? { created_at: receipt.created_at } : {}),
    ...(receipt.updated_at !== undefined ? { updated_at: receipt.updated_at } : {}),
    ...(!isTerminalWriteState(receipt.state) && isWriteDiagnostic(receipt.diagnostic) ? { diagnostic: {
      age_ms: receipt.diagnostic.age_ms, assessment: receipt.diagnostic.assessment,
      reason: receipt.diagnostic.reason, next_action: receipt.diagnostic.next_action,
      ...(receipt.diagnostic.observed_at !== undefined ? { observed_at: receipt.diagnostic.observed_at } : {}),
    } } : {}),
  };
}
