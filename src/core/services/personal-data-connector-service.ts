import { getConnectorDefinition } from '../connectors/connector-registry.ts';
import type { CredentialReferenceRecord } from '../connectors/credential-refs.ts';
import {
  planConnectorSync,
  type ConnectorSourceItem,
  type ConnectorSyncPlan,
} from '../connectors/connector-sync.ts';
import type { RawIngestPolicy, SourceItemRecord } from '../source-registry/raw-ingest.ts';
import {
  getDefaultSourcePolicy,
  type SourceConsentState,
} from '../source-registry/source-policy.ts';
import {
  buildSourceStatusEvent,
  registerSource,
  resolveSourceRegistryPolicy,
  type SourceRecord,
  type SourceRegistrationPlan,
  type SourceStatusEventRecord,
} from './source-registry-service.ts';

export type { ConnectorSourceItem } from '../connectors/connector-sync.ts';

export interface PersonalDataConnectorDeps {
  now: () => string;
}

export interface RegisterConnectorSourceInput {
  connector_id: string;
  display_name: string;
  account_locator: string;
  consent_state: SourceConsentState;
}

export interface ConnectorSourceRegistration extends SourceRegistrationPlan {
  policy: ReturnType<typeof resolveSourceRegistryPolicy>;
}

export interface SyncConnectorInput {
  connector_id: string;
  source: SourceRecord;
  credential: CredentialReferenceRecord;
  loadItems: () => ConnectorSourceItem[];
  existing_items?: SourceItemRecord[];
}

export interface ConnectorFailureInput {
  connector_id: string;
  source: SourceRecord;
  error: Error;
}

export interface SourceDeletionPlanInput {
  source: SourceRecord;
  external_id: string;
  content_hash: string;
  deleted_at: string;
}

export interface SourceDeletionPlan {
  source_id: string;
  external_id: string;
  content_hash: string;
  deleted_at: string;
  action: 'archive_for_retention';
  retention_policy: string;
  purge_immediately: false;
}

export interface PersonalDataConnectorService {
  registerConnectorSource(input: RegisterConnectorSourceInput): ConnectorSourceRegistration;
  syncConnector(input: SyncConnectorInput): ConnectorSyncPlan;
  recordConnectorFailure(input: ConnectorFailureInput): SourceStatusEventRecord;
  planSourceDeletion(input: SourceDeletionPlanInput): SourceDeletionPlan;
}

export function createPersonalDataConnectorService(
  deps: PersonalDataConnectorDeps,
): PersonalDataConnectorService {
  return {
    registerConnectorSource(input) {
      const connector = getConnectorDefinition(input.connector_id);
      const plan = registerSource({
        kind: connector.source_kind,
        display_name: input.display_name,
        connector_id: connector.id,
        locator: input.account_locator,
        consent_state: input.consent_state,
        actor_ref: 'mbrain:connector_registry',
        reason: 'connector source registered',
        now: deps.now(),
      });
      return {
        ...plan,
        policy: resolveSourceRegistryPolicy({
          source_kind: plan.source.kind,
          consent_state: plan.source.consent_state,
          enabled: plan.source.enabled,
          paused_at: plan.source.paused_at,
        }),
      };
    },

    syncConnector(input) {
      if (input.source.connector_id !== input.connector_id) {
        throw new Error(`source is registered for ${input.source.connector_id ?? 'no connector'}, not ${input.connector_id}`);
      }
      if (input.credential.connector_id !== input.connector_id) {
        throw new Error(`credential is registered for ${input.credential.connector_id}, not ${input.connector_id}`);
      }
      if ('items' in input || typeof input.loadItems !== 'function') {
        throw new Error('connector sync requires loadItems so authorization gates provider access');
      }
      const policy = resolveSourceRegistryPolicy({
        source_kind: input.source.kind,
        consent_state: input.source.consent_state,
        enabled: input.source.enabled,
        paused_at: input.source.paused_at,
      });
      if (!policy.processing.can_ingest) {
        throw new Error(`source consent ${input.source.consent_state} prevents connector sync`);
      }

      return planConnectorSync({
        source: input.source,
        items: input.loadItems(),
        existing_items: input.existing_items,
        policy: toRawIngestPolicy(policy),
        now: deps.now(),
      });
    },

    recordConnectorFailure(input) {
      return buildSourceStatusEvent({
        source_id: input.source.id,
        event_type: 'connector_sync_failed',
        previous_state: input.source.consent_state,
        next_state: input.source.consent_state,
        actor_ref: `connector:${input.connector_id}`,
        reason: input.error.message,
        metadata_json: {
          connector_id: input.connector_id,
          health_status: 'unhealthy',
        },
        created_at: deps.now(),
      });
    },

    planSourceDeletion(input) {
      const policy = getDefaultSourcePolicy(input.source.kind);
      return {
        source_id: input.source.id,
        external_id: input.external_id,
        content_hash: input.content_hash,
        deleted_at: input.deleted_at,
        action: 'archive_for_retention',
        retention_policy: policy.purge_policy,
        purge_immediately: false,
      };
    },
  };
}

function toRawIngestPolicy(
  resolved: ReturnType<typeof resolveSourceRegistryPolicy>,
): RawIngestPolicy {
  return {
    consent_state: resolved.consent_state,
    enabled: resolved.processing.can_ingest,
    raw_copy_mode: resolved.policy.raw_copy_mode,
    automatic_canonical_write_authority: resolved.policy.automatic_canonical_write_authority,
  };
}
