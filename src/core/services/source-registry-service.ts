import { createHash } from 'crypto';
import {
  type SourceConsentState,
  type SourceKind,
  resolveSourcePolicy,
  type ResolvedSourcePolicy,
  type SourcePolicyInput,
} from '../source-registry/source-policy.ts';
import {
  buildRawIngestPlan,
  type RawIngestInput,
  type RawIngestPlan,
  type RawIngestPolicy,
} from '../source-registry/raw-ingest.ts';
import {
  buildRawAccessLedgerEntry,
  evaluateRawAccessRequest,
  type RawAccessDecision,
  type RawAccessLedgerEntry,
  type RawAccessPolicy,
  type RawAccessRequest,
} from '../source-registry/raw-access-ledger.ts';

export interface RawAccessEvaluation {
  decision: RawAccessDecision;
  ledger_entry: RawAccessLedgerEntry;
}

export interface SourceRegistrationInput {
  id?: string;
  kind: SourceKind;
  display_name: string;
  connector_id?: string | null;
  locator?: string | null;
  consent_state: SourceConsentState;
  enabled?: boolean;
  paused_at?: string | null;
  policy_id?: string | null;
  metadata_json?: Record<string, unknown>;
  actor_ref?: string;
  reason?: string;
  now?: string;
}

export interface SourceRecord {
  id: string;
  kind: SourceKind;
  display_name: string;
  connector_id: string | null;
  locator: string | null;
  consent_state: SourceConsentState;
  enabled: boolean;
  paused_at: string | null;
  policy_id: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface SourceStatusEventInput {
  id?: string;
  source_id: string;
  event_type: string;
  previous_state?: string | null;
  next_state?: string | null;
  actor_ref?: string;
  reason?: string;
  metadata_json?: Record<string, unknown>;
  created_at?: string;
}

export interface SourceStatusEventRecord {
  id: string;
  source_id: string;
  event_type: string;
  previous_state: string | null;
  next_state: string | null;
  actor_ref: string;
  reason: string;
  metadata_json: Record<string, unknown>;
  created_at: string;
}

export interface SourceRegistrationPlan {
  source: SourceRecord;
  status_events: SourceStatusEventRecord[];
}

export function resolveSourceRegistryPolicy(input: SourcePolicyInput): ResolvedSourcePolicy {
  return resolveSourcePolicy(input);
}

export function registerSource(input: SourceRegistrationInput): SourceRegistrationPlan {
  const now = input.now ?? new Date().toISOString();
  const source: SourceRecord = {
    id: input.id ?? stableId('source', input.kind, input.locator ?? input.display_name),
    kind: input.kind,
    display_name: input.display_name,
    connector_id: input.connector_id ?? null,
    locator: input.locator ?? null,
    consent_state: input.consent_state,
    enabled: input.consent_state === 'granted' && (input.enabled ?? true),
    paused_at: input.paused_at ?? null,
    policy_id: input.policy_id ?? null,
    metadata_json: input.metadata_json ?? {},
    created_at: now,
    updated_at: now,
    archived_at: null,
  };

  return {
    source,
    status_events: [
      buildSourceStatusEvent({
        source_id: source.id,
        event_type: 'registered',
        previous_state: null,
        next_state: source.consent_state,
        actor_ref: input.actor_ref ?? 'mbrain:source_registry',
        reason: input.reason ?? 'source registered',
        metadata_json: {
          source_kind: source.kind,
          consent_state: source.consent_state,
        },
        created_at: now,
      }),
    ],
  };
}

export function buildSourceStatusEvent(input: SourceStatusEventInput): SourceStatusEventRecord {
  const createdAt = input.created_at ?? new Date().toISOString();
  return {
    id: input.id ?? stableId(
      'source-status-event',
      input.source_id,
      input.event_type,
      input.previous_state ?? '',
      input.next_state ?? '',
      createdAt,
    ),
    source_id: input.source_id,
    event_type: input.event_type,
    previous_state: input.previous_state ?? null,
    next_state: input.next_state ?? null,
    actor_ref: input.actor_ref ?? 'mbrain:source_registry',
    reason: input.reason ?? '',
    metadata_json: input.metadata_json ?? {},
    created_at: createdAt,
  };
}

export function appendSourceStatusEvent(
  history: readonly SourceStatusEventRecord[],
  input: SourceStatusEventInput,
): SourceStatusEventRecord[] {
  return [...history, buildSourceStatusEvent(input)];
}

export function previewRawSourceIngest(
  input: RawIngestInput,
  policy: RawIngestPolicy,
): RawIngestPlan {
  return buildRawIngestPlan(input, policy);
}

export function evaluateRawSourceAccess(
  request: RawAccessRequest,
  policy: RawAccessPolicy,
): RawAccessEvaluation {
  const decision = evaluateRawAccessRequest(request, policy);
  return {
    decision,
    ledger_entry: buildRawAccessLedgerEntry(request, decision),
  };
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
}
