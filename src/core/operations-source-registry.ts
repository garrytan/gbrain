import { createHash } from 'crypto';
import { type ConnectorDefinition, getConnectorDefinition } from './connectors/connector-registry.ts';
import {
  CREDENTIAL_PROVIDER_PRIORITY,
  type CredentialHealthStatus,
  type CredentialProvider,
  type CredentialReferenceRecord,
  type CredentialRotationStatus,
  createCredentialReference,
} from './connectors/credential-refs.ts';
import type { BrainEngine } from './engine.ts';
import type { Operation, OperationContext } from './operations.ts';
import { recordMemoryMutationEvent } from './services/memory-mutation-ledger-service.ts';
import {
  buildSourceStatusEvent,
  evaluateRawSourceAccess,
  previewRawSourceIngest,
  registerSource,
  resolveSourceRegistryPolicy,
  type SourceRecord,
  type SourceStatusEventRecord,
} from './services/source-registry-service.ts';
import type {
  RawAccessPolicy,
  RawAccessRequest,
} from './source-registry/raw-access-ledger.ts';
import type {
  RawIngestInput,
  RawIngestPolicy,
  SourceChunkRecord,
  SourceItemEventRecord,
  SourceItemRecord,
  SourceOriginEvent,
} from './source-registry/raw-ingest.ts';
import {
  insertSourceItemEvent,
  mapSourceItem,
  persistRawIngestPlan,
  readSourceItemByExternalId,
  readSourceItemChunks,
} from './source-registry/raw-ingest-store.ts';
import {
  applySourcePolicyOverrides,
  CONSENT_STATES,
  getDefaultSourcePolicy,
  isSourceConsentState,
  isSourceKind,
  SOURCE_KINDS,
  type SourceConsentState,
  type SourceKind,
  type SourcePolicy,
  type SourcePolicyOverride,
} from './source-registry/source-policy.ts';
import type { MemoryMutationOperationName } from './types.ts';

type OperationErrorCtor = new (
  code: 'invalid_params',
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

const SOURCE_ORIGIN_EVENTS = [
  'initial_import',
  'connector_sync',
  'manual_entry',
  'user_direct_entry',
  'session_capture',
  'markdown_edit',
] as const satisfies readonly SourceOriginEvent[];

const SOURCE_POLICY_DIMENSIONS = [
  'source_kind',
  'ingest_mode',
  'index_mode',
  'extraction_mode',
  'raw_copy_mode',
  'chunk_retention',
  'llm_access',
  'runner_access',
  'automatic_canonical_write_authority',
  'candidate_route_conditions',
  'conflict_route_conditions',
  'forgetting_lifecycle',
  'restore_window',
  'purge_policy',
  'export_reconcile_behavior',
] as const satisfies readonly (keyof SourcePolicy)[];

const CREDENTIAL_ROTATION_STATUSES = ['current', 'rotation_due', 'rotating', 'revoked'] as const;
const CREDENTIAL_HEALTH_STATUSES = ['healthy', 'unhealthy', 'expired', 'unknown'] as const;

export function createSourceRegistryOperations(
  deps: { OperationError: OperationErrorCtor },
): Operation[] {
  const register_source: Operation = {
    name: 'register_source',
    description: 'Persist a source registry record and append-only minimal-consent status event.',
    params: {
      source_kind: { type: 'string', required: true, enum: [...SOURCE_KINDS], description: 'Source kind to register.' },
      display_name: { type: 'string', required: true, description: 'Human-readable source name.' },
      connector_id: { type: 'string', nullable: true, description: 'Optional connector id.' },
      locator: { type: 'string', nullable: true, description: 'Optional stable source locator.' },
      consent_state: { type: 'string', required: true, enum: [...CONSENT_STATES], description: 'Minimal source consent state.' },
      enabled: { type: 'boolean', description: 'Whether the source should be enabled when consent is granted.' },
      paused_at: { type: 'string', nullable: true, description: 'Optional ISO timestamp when the source is paused.' },
      policy_id: { type: 'string', nullable: true, description: 'Optional linked policy id.' },
      metadata_json: { type: 'object', description: 'Optional source metadata.' },
      actor_ref: { type: 'string', description: 'Actor that registered the source.' },
      reason: { type: 'string', description: 'Registration reason.' },
      now: { type: 'string', description: 'Optional ISO registration timestamp.' },
    },
    handler: async (ctx, p) => persistSourceRegistration(deps, ctx, {
      kind: sourceKind(deps, p.source_kind),
      display_name: requiredString(deps, 'display_name', p.display_name),
      connector_id: optionalNullableString(deps, 'connector_id', p.connector_id),
      locator: optionalNullableString(deps, 'locator', p.locator),
      consent_state: consentState(deps, p.consent_state),
      enabled: optionalBoolean(deps, 'enabled', p.enabled),
      paused_at: optionalNullableString(deps, 'paused_at', p.paused_at),
      policy_id: optionalNullableString(deps, 'policy_id', p.policy_id),
      metadata_json: optionalObject(deps, 'metadata_json', p.metadata_json),
      actor_ref: optionalString(deps, 'actor_ref', p.actor_ref),
      reason: optionalString(deps, 'reason', p.reason),
      now: optionalString(deps, 'now', p.now),
    }),
    mutating: true,
    cliHints: { name: 'source-register' },
  };

  const preview_source_registration: Operation = {
    name: 'preview_source_registration',
    description: 'Build a source registry record and initial append-only status event for minimal consent onboarding.',
    params: {
      source_kind: { type: 'string', required: true, enum: [...SOURCE_KINDS], description: 'Source kind to register.' },
      display_name: { type: 'string', required: true, description: 'Human-readable source name.' },
      connector_id: { type: 'string', nullable: true, description: 'Optional connector id.' },
      locator: { type: 'string', nullable: true, description: 'Optional stable source locator.' },
      consent_state: { type: 'string', required: true, enum: [...CONSENT_STATES], description: 'Minimal source consent state.' },
      enabled: { type: 'boolean', description: 'Whether the source should be enabled when consent is granted.' },
      paused_at: { type: 'string', nullable: true, description: 'Optional ISO timestamp when the source is paused.' },
      policy_id: { type: 'string', nullable: true, description: 'Optional linked policy id.' },
      metadata_json: { type: 'object', description: 'Optional source metadata.' },
      actor_ref: { type: 'string', description: 'Actor that registered the source.' },
      reason: { type: 'string', description: 'Registration reason.' },
      now: { type: 'string', description: 'Optional ISO registration timestamp.' },
    },
    handler: async (_ctx, p) => registerSource({
      kind: sourceKind(deps, p.source_kind),
      display_name: requiredString(deps, 'display_name', p.display_name),
      connector_id: optionalNullableString(deps, 'connector_id', p.connector_id),
      locator: optionalNullableString(deps, 'locator', p.locator),
      consent_state: consentState(deps, p.consent_state),
      enabled: optionalBoolean(deps, 'enabled', p.enabled),
      paused_at: optionalNullableString(deps, 'paused_at', p.paused_at),
      policy_id: optionalNullableString(deps, 'policy_id', p.policy_id),
      metadata_json: optionalObject(deps, 'metadata_json', p.metadata_json),
      actor_ref: optionalString(deps, 'actor_ref', p.actor_ref),
      reason: optionalString(deps, 'reason', p.reason),
      now: optionalString(deps, 'now', p.now),
    }),
    cliHints: { name: 'source-registration-preview' },
  };

  const register_connector_source: Operation = {
    name: 'register_connector_source',
    description: 'Persist a connector-backed source choice, account, default grants, and sync health shell.',
    params: {
      connector_id: { type: 'string', required: true, description: 'Connector registry id.' },
      display_name: { type: 'string', required: true, description: 'Human-readable source/account name.' },
      account_locator: { type: 'string', required: true, description: 'Stable connector account locator.' },
      consent_state: { type: 'string', required: true, enum: [...CONSENT_STATES], description: 'Minimal source consent state.' },
      credential_ref_id: { type: 'string', nullable: true, description: 'Optional credential reference id.' },
      credential_ref: { type: 'object', description: 'Optional credential reference metadata to persist without raw credential secrets.' },
      metadata_json: { type: 'object', description: 'Optional connector account metadata.' },
      actor_ref: { type: 'string', description: 'Actor that registered the connector source.' },
      reason: { type: 'string', description: 'Registration reason.' },
      now: { type: 'string', description: 'Optional ISO registration timestamp.' },
    },
    handler: async (ctx, p) => {
      const connector = connectorDefinition(deps, p.connector_id);
      const now = optionalString(deps, 'now', p.now) ?? new Date().toISOString();
      const accountLocator = requiredString(deps, 'account_locator', p.account_locator);
      const accountId = connectorAccountId(connector.id, accountLocator);
      const credentialRefIdParam = optionalNullableString(deps, 'credential_ref_id', p.credential_ref_id) ?? null;
      const inlineCredentialRef = optionalCredentialReference(deps, {
        connector,
        account_id: accountId,
        value: p.credential_ref,
        now,
      });
      if (credentialRefIdParam && inlineCredentialRef) {
        throw invalidParams(deps, 'credential_ref_id and credential_ref cannot both be provided');
      }
      const credentialRefId = credentialRefIdParam ?? inlineCredentialRef?.id ?? null;
      const registration = buildPersistedSourceRegistration({
        kind: connector.source_kind,
        display_name: requiredString(deps, 'display_name', p.display_name),
        connector_id: connector.id,
        locator: accountLocator,
        consent_state: consentState(deps, p.consent_state),
        metadata_json: optionalObject(deps, 'metadata_json', p.metadata_json),
        actor_ref: optionalString(deps, 'actor_ref', p.actor_ref) ?? 'mbrain:connector_registry',
        reason: optionalString(deps, 'reason', p.reason) ?? 'connector source registered',
        now,
      });
      const connectorRecords = buildConnectorRegistrationRecords(deps, {
        connector,
        source: registration.source,
        account_locator: accountLocator,
        credential_ref_id: credentialRefId,
        metadata_json: optionalObject(deps, 'metadata_json', p.metadata_json) ?? {},
        now,
      });
      if (inlineCredentialRef) {
        validateCredentialReferenceRecord(deps, connector, connectorRecords.account.id, inlineCredentialRef);
      } else {
        await validateCredentialReference(
          deps,
          ctx.engine,
          connector,
          connectorRecords.account.id,
          connectorRecords.account.credential_ref_id,
        );
      }

      if (ctx.dryRun) {
        return {
          status: 'dry_run',
          ...registration,
          credential_ref: inlineCredentialRef,
          connector_account: connectorRecords.account,
          connector_grants: connectorRecords.grants,
          connector_sync_state: connectorRecords.sync_state,
        };
      }

      const existing = await readFullSourceRecord(ctx.engine, registration.source.id);
      if (existing) {
        const connectorAccount = await readConnectorAccount(ctx.engine, existing.id);
        const connectorGrants = connectorAccount
          ? await readConnectorGrants(ctx.engine, connectorAccount.id)
          : [];
        const connectorSyncState = connectorAccount
          ? await readConnectorSyncState(ctx.engine, connectorAccount.id, connectorAccount.connector_id)
          : null;
        const credentialRef = connectorAccount?.credential_ref_id
          ? await readCredentialReference(ctx.engine, connectorAccount.credential_ref_id)
          : null;
        return {
          status: 'already_registered',
          source: existing,
          status_events: await readSourceStatusEvents(ctx.engine, existing.id),
          policy: (await inspectSourcePolicy(ctx.engine, existing)).resolved,
          credential_ref: credentialRef,
          connector_account: connectorAccount,
          connector_grants: connectorGrants,
          connector_sync_state: connectorSyncState,
        };
      }

      await ctx.engine.transaction(async (tx) => {
        if (inlineCredentialRef) {
          await insertCredentialReference(tx, inlineCredentialRef);
        }
        await insertSourceRegistration(deps, tx, registration);
        await insertConnectorAccount(tx, connectorRecords.account);
        for (const grant of connectorRecords.grants) {
          await insertConnectorGrant(tx, grant);
        }
        await insertConnectorSyncState(tx, connectorRecords.sync_state);
      });

      return {
        status: 'applied',
        ...registration,
        credential_ref: inlineCredentialRef,
        connector_account: connectorRecords.account,
        connector_grants: connectorRecords.grants,
        connector_sync_state: connectorRecords.sync_state,
      };
    },
    mutating: true,
    cliHints: { name: 'connector-register' },
  };

  const list_sources: Operation = {
    name: 'list_sources',
    description: 'List persisted source registry records with resolved policy and connector inspection state.',
    params: {
      source_kind: { type: 'string', enum: [...SOURCE_KINDS], description: 'Optional source kind filter.' },
      connector_id: { type: 'string', description: 'Optional connector id filter.' },
      consent_state: { type: 'string', enum: [...CONSENT_STATES], description: 'Optional minimal consent filter.' },
      enabled: { type: 'boolean', description: 'Optional enabled filter.' },
      limit: { type: 'number', description: 'Maximum rows to return.' },
    },
    handler: async (ctx, p) => listSourceInspectionRows(ctx.engine, {
      source_kind: optionalSourceKind(deps, p.source_kind),
      connector_id: optionalString(deps, 'connector_id', p.connector_id),
      consent_state: optionalConsentState(deps, p.consent_state),
      enabled: optionalBoolean(deps, 'enabled', p.enabled),
      limit: optionalNumber(deps, 'limit', p.limit) ?? 100,
    }),
    mutating: false,
    cliHints: { name: 'source-list' },
  };

  const get_source: Operation = {
    name: 'get_source',
    description: 'Inspect one persisted source registry record, policy, connector state, and status history.',
    params: {
      source_id: { type: 'string', required: true, description: 'Source id to inspect.' },
    },
    handler: async (ctx, p) => getSourceInspectionRow(
      deps,
      ctx.engine,
      requiredString(deps, 'source_id', p.source_id),
    ),
    mutating: false,
    cliHints: { name: 'source-get', positional: ['source_id'] },
  };

  const resolve_source_policy: Operation = {
    name: 'resolve_source_policy',
    description: 'Resolve source registry policy defaults, overrides, and processing gates for a source.',
    params: {
      source_kind: { type: 'string', required: true, enum: [...SOURCE_KINDS], description: 'Source kind to resolve.' },
      consent_state: { type: 'string', required: true, enum: [...CONSENT_STATES], description: 'Minimal source consent state.' },
      enabled: { type: 'boolean', description: 'Whether the source is enabled.' },
      paused_at: { type: 'string', nullable: true, description: 'Optional ISO timestamp when the source was paused.' },
      overrides: { type: 'object', description: 'Advanced policy overrides keyed by policy dimension.' },
    },
    handler: async (_ctx, p) => resolveSourceRegistryPolicy({
      source_kind: sourceKind(deps, p.source_kind),
      consent_state: consentState(deps, p.consent_state),
      enabled: optionalBoolean(deps, 'enabled', p.enabled),
      paused_at: optionalNullableString(deps, 'paused_at', p.paused_at),
      overrides: optionalObject(deps, 'overrides', p.overrides) as any,
    }),
    cliHints: { name: 'source-policy-resolve' },
  };

  const preview_raw_ingest: Operation = {
    name: 'preview_raw_ingest',
    description: 'Build a raw source ingest provenance plan with chunk safety flags and raw-copy policy decisions.',
    params: {
      source_id: { type: 'string', required: true, description: 'Registered source id.' },
      external_id: { type: 'string', required: true, description: 'Source-native item id.' },
      origin_event: { type: 'string', required: true, enum: [...SOURCE_ORIGIN_EVENTS], description: 'Origin event that produced this source item.' },
      locator: { type: 'string', nullable: true, description: 'Optional source locator.' },
      title: { type: 'string', description: 'Optional source item title.' },
      chunk_texts: { type: 'array', required: true, items: { type: 'string' }, description: 'Selected raw chunks to retain.' },
      parser_version: { type: 'string', required: true, description: 'Parser version used to produce chunks.' },
      extractor_version: { type: 'string', description: 'Extractor version expected to consume chunks.' },
      now: { type: 'string', description: 'Optional ISO ingest timestamp.' },
      expires_at: { type: 'string', nullable: true, description: 'Optional ISO chunk expiry timestamp.' },
      requested_raw_copy: { type: 'boolean', description: 'Whether a full raw copy was requested.' },
      raw_text: { type: 'string', description: 'Optional full raw text used for hashing/raw-copy decisions.' },
      policy: { type: 'object', required: true, description: 'Resolved source policy subset for raw ingest.' },
    },
    handler: async (_ctx, p) => previewRawSourceIngest(rawIngestInput(deps, p), rawIngestPolicy(deps, p.policy)),
    cliHints: { name: 'raw-ingest-preview' },
  };

  const ingest_connector_item: Operation = {
    name: 'ingest_connector_item',
    description: 'Persist one connector item into raw source items and chunks without direct canonical writes.',
    params: {
      source_id: { type: 'string', required: true, description: 'Registered connector source id.' },
      connector_id: { type: 'string', required: true, description: 'Connector registry id expected on the source.' },
      external_id: { type: 'string', required: true, description: 'Connector-native item id.' },
      locator: { type: 'string', nullable: true, description: 'Optional source locator.' },
      title: { type: 'string', description: 'Optional item title.' },
      body: { type: 'string', required: true, description: 'Connector item body to map into raw ingest chunks.' },
      source_created_at: { type: 'string', nullable: true, description: 'Optional source-created timestamp.' },
      source_updated_at: { type: 'string', nullable: true, description: 'Optional source-updated timestamp.' },
      metadata_json: { type: 'object', description: 'Optional source item metadata.' },
      parser_version: { type: 'string', description: 'Optional parser version.' },
      now: { type: 'string', description: 'Optional ISO ingest timestamp.' },
    },
    handler: async (ctx, p) => ingestConnectorItem(deps, ctx, {
      source_id: requiredString(deps, 'source_id', p.source_id),
      connector_id: requiredString(deps, 'connector_id', p.connector_id),
      external_id: requiredString(deps, 'external_id', p.external_id),
      locator: optionalNullableString(deps, 'locator', p.locator),
      title: optionalString(deps, 'title', p.title),
      body: requiredString(deps, 'body', p.body),
      source_created_at: optionalNullableString(deps, 'source_created_at', p.source_created_at),
      source_updated_at: optionalNullableString(deps, 'source_updated_at', p.source_updated_at),
      metadata_json: optionalObject(deps, 'metadata_json', p.metadata_json),
      parser_version: optionalString(deps, 'parser_version', p.parser_version),
      now: optionalString(deps, 'now', p.now),
    }),
    mutating: true,
    cliHints: { name: 'connector-ingest-item' },
  };

  const list_source_items: Operation = {
    name: 'list_source_items',
    description: 'List persisted raw source items and optional chunks for source/connector inspection.',
    params: {
      source_id: { type: 'string', required: true, description: 'Source id to inspect.' },
      include_chunks: { type: 'boolean', description: 'Include source chunks for each item.' },
      limit: { type: 'number', description: 'Maximum items to return.' },
    },
    handler: async (ctx, p) => listSourceItems(ctx.engine, {
      source_id: requiredString(deps, 'source_id', p.source_id),
      include_chunks: optionalBoolean(deps, 'include_chunks', p.include_chunks) ?? false,
      limit: optionalNumber(deps, 'limit', p.limit) ?? 100,
    }),
    mutating: false,
    cliHints: { name: 'source-items' },
  };

  const record_connector_failure: Operation = {
    name: 'record_connector_failure',
    description: 'Record a connector failure as source status history and connector sync health.',
    params: {
      source_id: { type: 'string', required: true, description: 'Registered connector source id.' },
      connector_id: { type: 'string', required: true, description: 'Connector registry id expected on the source.' },
      error_message: { type: 'string', required: true, description: 'Connector failure message.' },
      now: { type: 'string', description: 'Optional ISO failure timestamp.' },
    },
    handler: async (ctx, p) => recordConnectorFailure(deps, ctx, {
      source_id: requiredString(deps, 'source_id', p.source_id),
      connector_id: requiredString(deps, 'connector_id', p.connector_id),
      error_message: requiredString(deps, 'error_message', p.error_message),
      now: optionalString(deps, 'now', p.now) ?? new Date().toISOString(),
    }),
    mutating: true,
    cliHints: { name: 'connector-record-failure' },
  };

  const record_connector_sync_success: Operation = {
    name: 'record_connector_sync_success',
    description: 'Record a completed connector sync with cursor progress and inspectable healthy sync state.',
    params: {
      source_id: { type: 'string', required: true, description: 'Registered connector source id.' },
      connector_id: { type: 'string', required: true, description: 'Connector registry id expected on the source.' },
      cursor_json: { type: 'object', required: true, description: 'Connector cursor to use for the next incremental sync.' },
      sync_started_at: { type: 'string', nullable: true, description: 'Optional ISO timestamp when the sync started.' },
      now: { type: 'string', description: 'Optional ISO timestamp when the sync finished.' },
      ingested_count: { type: 'number', description: 'Number of items ingested or updated during this sync.' },
      skipped_count: { type: 'number', description: 'Number of unchanged items skipped during this sync.' },
      metadata_json: { type: 'object', description: 'Optional sync metadata.' },
    },
    handler: async (ctx, p) => recordConnectorSyncSuccess(deps, ctx, {
      source_id: requiredString(deps, 'source_id', p.source_id),
      connector_id: requiredString(deps, 'connector_id', p.connector_id),
      cursor_json: requiredObject(deps, 'cursor_json', p.cursor_json),
      sync_started_at: optionalNullableString(deps, 'sync_started_at', p.sync_started_at),
      now: optionalString(deps, 'now', p.now) ?? new Date().toISOString(),
      ingested_count: optionalNonNegativeNumber(deps, 'ingested_count', p.ingested_count) ?? 0,
      skipped_count: optionalNonNegativeNumber(deps, 'skipped_count', p.skipped_count) ?? 0,
      metadata_json: optionalObject(deps, 'metadata_json', p.metadata_json),
    }),
    mutating: true,
    cliHints: { name: 'connector-record-sync-success' },
  };

  const record_connector_item_deletion: Operation = {
    name: 'record_connector_item_deletion',
    description: 'Record a connector deletion/archive signal without silently purging retained raw ingest data.',
    params: {
      source_id: { type: 'string', required: true, description: 'Registered connector source id.' },
      connector_id: { type: 'string', required: true, description: 'Connector registry id expected on the source.' },
      external_id: { type: 'string', required: true, description: 'Connector-native item id.' },
      deleted_at: { type: 'string', required: true, description: 'Source deletion timestamp.' },
      now: { type: 'string', description: 'Optional ISO event timestamp.' },
    },
    handler: async (ctx, p) => recordConnectorItemDeletion(deps, ctx, {
      source_id: requiredString(deps, 'source_id', p.source_id),
      connector_id: requiredString(deps, 'connector_id', p.connector_id),
      external_id: requiredString(deps, 'external_id', p.external_id),
      deleted_at: requiredString(deps, 'deleted_at', p.deleted_at),
      now: optionalString(deps, 'now', p.now) ?? new Date().toISOString(),
    }),
    mutating: true,
    cliHints: { name: 'connector-record-deletion' },
  };

  const evaluate_raw_access: Operation = {
    name: 'evaluate_raw_access',
    description: 'Evaluate and audit a scoped raw source chunk access request.',
    params: {
      actor_type: { type: 'string', required: true, description: 'Actor type, for example runner, daemon, mcp, cli, or llm.' },
      actor_id: { type: 'string', required: true, description: 'Stable actor id.' },
      session_id: { type: 'string', nullable: true, description: 'Optional session id.' },
      job_id: { type: 'string', nullable: true, description: 'Optional job id.' },
      source_id: { type: 'string', required: true, description: 'Source id.' },
      source_item_id: { type: 'string', required: true, description: 'Source item id.' },
      chunk_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Explicit source chunk ids requested.' },
      reason: { type: 'string', required: true, description: 'Why raw chunk access is needed.' },
      input: { type: 'string', description: 'Optional input text to hash in the ledger.' },
      prompt: { type: 'string', description: 'Optional prompt text to hash in the ledger.' },
      requested_at: { type: 'string', description: 'Optional ISO request timestamp.' },
      policy: { type: 'object', required: true, description: 'Resolved source policy subset for raw access.' },
    },
    handler: async (_ctx, p) => evaluateRawSourceAccess(rawAccessRequest(deps, p), rawAccessPolicy(deps, p.policy)),
    cliHints: { name: 'raw-access-evaluate' },
  };

  const pause_source_processing: Operation = {
    name: 'pause_source_processing',
    description: 'Plan an auditable source pause transition for report-driven source repair workflows.',
    params: {
      source_id: { type: 'string', required: true, description: 'Source id to pause.' },
      reason: { type: 'string', required: true, description: 'Reason for pausing source processing.' },
      actor_ref: { type: 'string', description: 'Actor requesting the pause.' },
      now: { type: 'string', description: 'Optional ISO timestamp for deterministic status events.' },
    },
    handler: async (ctx, p) => {
      const sourceId = requiredString(deps, 'source_id', p.source_id);
      const now = optionalString(deps, 'now', p.now) ?? new Date().toISOString();
      return executeSourceControlMutation(deps, ctx, {
        operation: 'pause_source_processing',
        event_type: 'paused',
        next_state: 'paused',
        source_id: sourceId,
        reason: requiredString(deps, 'reason', p.reason),
        actor_ref: optionalString(deps, 'actor_ref', p.actor_ref) ?? 'mbrain:source_registry',
        now,
      });
    },
    mutating: true,
    cliHints: { name: 'source-pause' },
  };

  const revoke_source_consent: Operation = {
    name: 'revoke_source_consent',
    description: 'Plan an auditable source consent revocation transition for report-driven source repair workflows.',
    params: {
      source_id: { type: 'string', required: true, description: 'Source id to revoke.' },
      reason: { type: 'string', required: true, description: 'Reason for revoking source consent.' },
      actor_ref: { type: 'string', description: 'Actor requesting the revocation.' },
      now: { type: 'string', description: 'Optional ISO timestamp for deterministic status events.' },
    },
    handler: async (ctx, p) => {
      const sourceId = requiredString(deps, 'source_id', p.source_id);
      const now = optionalString(deps, 'now', p.now) ?? new Date().toISOString();
      return executeSourceControlMutation(deps, ctx, {
        operation: 'revoke_source_consent',
        event_type: 'revoked',
        next_state: 'revoked',
        source_id: sourceId,
        reason: requiredString(deps, 'reason', p.reason),
        actor_ref: optionalString(deps, 'actor_ref', p.actor_ref) ?? 'mbrain:source_registry',
        now,
      });
    },
    mutating: true,
    cliHints: { name: 'source-revoke' },
  };

  return [
    register_source,
    preview_source_registration,
    register_connector_source,
    list_sources,
    get_source,
    resolve_source_policy,
    preview_raw_ingest,
    ingest_connector_item,
    list_source_items,
    record_connector_failure,
    record_connector_sync_success,
    record_connector_item_deletion,
    evaluate_raw_access,
    pause_source_processing,
    revoke_source_consent,
  ];
}

interface SourceControlMutationInput {
  operation: Extract<MemoryMutationOperationName, 'pause_source_processing' | 'revoke_source_consent'>;
  event_type: 'paused' | 'revoked';
  next_state: 'paused' | 'revoked';
  source_id: string;
  reason: string;
  actor_ref: string;
  now: string;
}

interface SourceRow {
  id: string;
  kind?: string;
  display_name?: string;
  connector_id?: string | null;
  locator?: string | null;
  consent_state: string;
  enabled: boolean | number;
  paused_at?: string | Date | null;
  policy_id?: string | null;
  metadata_json?: string | Record<string, unknown> | null;
  created_at?: string | Date;
  updated_at?: string | Date;
  archived_at?: string | Date | null;
}

type QueryableEngine = BrainEngine & {
  database?: {
    query<T = Record<string, unknown>>(sql: string): {
      get(...params: unknown[]): T | null;
      all(...params: unknown[]): T[];
      run(...params: unknown[]): unknown;
    };
  };
  db?: { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> };
  sql?: { unsafe(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> };
};

interface SourceInspectionFilters {
  source_kind?: SourceKind;
  connector_id?: string;
  consent_state?: SourceConsentState;
  enabled?: boolean;
  limit: number;
}

interface PersistedSourceRegistration {
  status?: 'applied' | 'dry_run' | 'already_registered';
  source: SourceRecord;
  status_events: SourceStatusEventRecord[];
  policy: ReturnType<typeof resolveSourceRegistryPolicy>;
}

interface ConnectorAccountRecord {
  id: string;
  connector_id: string;
  source_id: string;
  account_locator: string;
  display_name: string;
  credential_ref_id: string | null;
  status: 'active' | 'paused' | 'revoked' | 'failed';
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ConnectorGrantRecord {
  id: string;
  account_id: string;
  scope: string;
  grant_state: 'granted' | 'denied' | 'revoked';
  granted_at: string | null;
  revoked_at: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ConnectorSyncStateRecord {
  id: string;
  account_id: string;
  connector_id: string;
  cursor_json: Record<string, unknown>;
  last_sync_started_at: string | null;
  last_sync_finished_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  health_status: 'healthy' | 'unhealthy' | 'paused' | 'revoked' | 'unknown';
  failure_count: number;
  last_error: string | null;
  metadata_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ConnectorRegistrationRecords {
  account: ConnectorAccountRecord;
  grants: ConnectorGrantRecord[];
  sync_state: ConnectorSyncStateRecord;
}

interface ConnectorItemIngestInput {
  source_id: string;
  connector_id: string;
  external_id: string;
  locator?: string | null;
  title?: string;
  body: string;
  source_created_at?: string | null;
  source_updated_at?: string | null;
  metadata_json?: Record<string, unknown>;
  parser_version?: string;
  now?: string;
}

interface SourceItemsListInput {
  source_id: string;
  include_chunks: boolean;
  limit: number;
}

interface ConnectorFailureOperationInput {
  source_id: string;
  connector_id: string;
  error_message: string;
  now: string;
}

interface ConnectorSyncSuccessOperationInput {
  source_id: string;
  connector_id: string;
  cursor_json: Record<string, unknown>;
  sync_started_at?: string | null;
  now: string;
  ingested_count: number;
  skipped_count: number;
  metadata_json?: Record<string, unknown>;
}

interface ConnectorDeletionOperationInput {
  source_id: string;
  connector_id: string;
  external_id: string;
  deleted_at: string;
  now: string;
}

interface CredentialReferenceInspectionRow {
  id: string;
  connector_id: string;
  account_id: string;
  provider: string;
  reference: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  rotation_status: string;
  health_status: string;
  created_at: string;
  updated_at: string;
}

async function persistSourceRegistration(
  deps: { OperationError: OperationErrorCtor },
  ctx: OperationContext,
  input: Parameters<typeof buildPersistedSourceRegistration>[0],
): Promise<PersistedSourceRegistration> {
  const registration = buildPersistedSourceRegistration(input);
  if (ctx.dryRun) {
    return {
      status: 'dry_run',
      ...registration,
    };
  }
  const existing = await readFullSourceRecord(ctx.engine, registration.source.id);
  if (existing) {
    return {
      status: 'already_registered',
      source: existing,
      status_events: await readSourceStatusEvents(ctx.engine, existing.id),
      policy: (await inspectSourcePolicy(ctx.engine, existing)).resolved,
    };
  }
  await ctx.engine.transaction(async (tx) => {
    await insertSourceRegistration(deps, tx, registration);
  });
  return {
    status: 'applied',
    ...registration,
  };
}

function buildPersistedSourceRegistration(
  input: Parameters<typeof registerSource>[0],
): PersistedSourceRegistration {
  const plan = registerSource(input);
  plan.source.policy_id = plan.source.policy_id ?? stableId('source-policy', plan.source.kind);
  return {
    ...plan,
    policy: resolveSourceRegistryPolicy({
      source_kind: plan.source.kind,
      consent_state: plan.source.consent_state,
      enabled: plan.source.enabled,
      paused_at: plan.source.paused_at,
    }),
  };
}

async function insertSourceRegistration(
  deps: { OperationError: OperationErrorCtor },
  engine: BrainEngine,
  registration: Pick<PersistedSourceRegistration, 'source' | 'status_events'>,
): Promise<void> {
  await upsertSourcePolicyRecord(
    engine,
    registration.source.policy_id ?? stableId('source-policy', registration.source.kind),
    getDefaultSourcePolicy(registration.source.kind),
    registration.source.created_at,
  );
  await insertSourceRecord(engine, registration.source);
  for (const event of registration.status_events) {
    await insertSourceStatusEvent(engine, event);
  }
}

async function upsertSourcePolicyRecord(
  engine: BrainEngine,
  id: string,
  policy: SourcePolicy,
  now: string,
): Promise<void> {
  const candidate = engine as QueryableEngine;
  const values = [
    id,
    policy.source_kind,
    policy.ingest_mode,
    policy.index_mode,
    policy.extraction_mode,
    policy.raw_copy_mode,
    policy.chunk_retention,
    policy.llm_access,
    policy.runner_access,
    policy.automatic_canonical_write_authority,
    JSON.stringify(policy.candidate_route_conditions),
    JSON.stringify(policy.conflict_route_conditions),
    policy.forgetting_lifecycle,
    policy.restore_window,
    policy.purge_policy,
    policy.export_reconcile_behavior,
    now,
    now,
  ];
  if (candidate.database) {
    candidate.database.query(`
      INSERT INTO source_policies (
        id, source_kind, ingest_mode, index_mode, extraction_mode, raw_copy_mode,
        chunk_retention, llm_access, runner_access, automatic_canonical_write_authority,
        candidate_route_conditions, conflict_route_conditions, forgetting_lifecycle,
        restore_window, purge_policy, export_reconcile_behavior, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_kind) DO UPDATE SET updated_at = excluded.updated_at
    `).run(...values);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      INSERT INTO source_policies (
        id, source_kind, ingest_mode, index_mode, extraction_mode, raw_copy_mode,
        chunk_retention, llm_access, runner_access, automatic_canonical_write_authority,
        candidate_route_conditions, conflict_route_conditions, forgetting_lifecycle,
        restore_window, purge_policy, export_reconcile_behavior, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17, $18)
      ON CONFLICT(source_kind) DO UPDATE SET updated_at = excluded.updated_at
    `, values);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      INSERT INTO source_policies (
        id, source_kind, ingest_mode, index_mode, extraction_mode, raw_copy_mode,
        chunk_retention, llm_access, runner_access, automatic_canonical_write_authority,
        candidate_route_conditions, conflict_route_conditions, forgetting_lifecycle,
        restore_window, purge_policy, export_reconcile_behavior, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17, $18)
      ON CONFLICT(source_kind) DO UPDATE SET updated_at = excluded.updated_at
    `, values);
    return;
  }
  throw new Error('source policy operations require a SQL-backed engine');
}

async function insertSourceRecord(engine: BrainEngine, source: SourceRecord): Promise<void> {
  const candidate = engine as QueryableEngine;
  const values = [
    source.id,
    source.kind,
    source.display_name,
    source.connector_id,
    source.locator,
    source.consent_state,
    source.enabled,
    source.paused_at,
    source.policy_id,
    JSON.stringify(source.metadata_json),
    source.created_at,
    source.updated_at,
    source.archived_at,
  ];
  if (candidate.database) {
    candidate.database.query(`
      INSERT INTO sources (
        id, kind, display_name, connector_id, locator, consent_state, enabled, paused_at,
        policy_id, metadata_json, created_at, updated_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...values);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      INSERT INTO sources (
        id, kind, display_name, connector_id, locator, consent_state, enabled, paused_at,
        policy_id, metadata_json, created_at, updated_at, archived_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
    `, values);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      INSERT INTO sources (
        id, kind, display_name, connector_id, locator, consent_state, enabled, paused_at,
        policy_id, metadata_json, created_at, updated_at, archived_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
    `, values);
    return;
  }
  throw new Error('source registration operations require a SQL-backed engine');
}

function connectorDefinition(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): ConnectorDefinition {
  const connectorId = requiredString(deps, 'connector_id', value);
  try {
    return getConnectorDefinition(connectorId);
  } catch (error) {
    throw invalidParams(deps, error instanceof Error ? error.message : String(error));
  }
}

async function validateCredentialReference(
  deps: { OperationError: OperationErrorCtor },
  engine: BrainEngine,
  connector: ConnectorDefinition,
  accountId: string,
  credentialRefId: string | null,
): Promise<void> {
  if (!credentialRefId) return;
  const credential = await readCredentialReference(engine, credentialRefId);
  if (!credential) {
    throw invalidParams(deps, `credential_ref_id not found: ${credentialRefId}`);
  }
  validateCredentialReferenceRecord(deps, connector, accountId, credential);
}

function validateCredentialReferenceRecord(
  deps: { OperationError: OperationErrorCtor },
  connector: ConnectorDefinition,
  accountId: string,
  credential: Pick<CredentialReferenceInspectionRow, 'connector_id' | 'account_id' | 'scopes' | 'health_status' | 'rotation_status'>,
): void {
  if (credential.connector_id !== connector.id) {
    throw invalidParams(deps, `credential_ref_id is registered for ${credential.connector_id}, not ${connector.id}`);
  }
  if (credential.account_id !== accountId) {
    throw invalidParams(deps, `credential_ref_id is registered for account ${credential.account_id}, not ${accountId}`);
  }
  const missingScopes = connector.default_scopes.filter((scope) => !credential.scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw invalidParams(deps, `credential_ref_id is missing connector scopes: ${missingScopes.join(', ')}`);
  }
  if (credential.health_status !== 'healthy') {
    throw invalidParams(deps, `credential_ref_id health_status must be healthy, got ${credential.health_status}`);
  }
  if (credential.rotation_status === 'revoked') {
    throw invalidParams(deps, 'credential_ref_id rotation_status must not be revoked');
  }
}

function optionalCredentialReference(
  deps: { OperationError: OperationErrorCtor },
  input: {
    connector: ConnectorDefinition;
    account_id: string;
    value: unknown;
    now: string;
  },
): CredentialReferenceRecord | null {
  const value = optionalObject(deps, 'credential_ref', input.value);
  if (!value) return null;
  try {
    return createCredentialReference({
      id: optionalString(deps, 'credential_ref.id', value.id),
      connector_id: input.connector.id,
      account_id: input.account_id,
      provider: credentialProvider(deps, 'credential_ref.provider', value.provider),
      reference: requiredString(deps, 'credential_ref.reference', value.reference),
      scopes: stringArray(deps, 'credential_ref.scopes', value.scopes),
      expires_at: optionalNullableString(deps, 'credential_ref.expires_at', value.expires_at),
      now: input.now,
      rotation_status: optionalCredentialRotationStatus(deps, 'credential_ref.rotation_status', value.rotation_status),
      health_status: optionalCredentialHealthStatus(deps, 'credential_ref.health_status', value.health_status),
    });
  } catch (error) {
    if (error instanceof deps.OperationError) throw error;
    throw invalidParams(deps, error instanceof Error ? error.message : String(error));
  }
}

async function readCredentialReference(
  engine: BrainEngine,
  credentialRefId: string,
): Promise<CredentialReferenceInspectionRow | null> {
  const candidate = engine as QueryableEngine;
  const sql = `
    SELECT id, connector_id, account_id, provider, reference, scopes_json,
           expires_at, last_used_at, rotation_status, health_status, created_at, updated_at
    FROM credential_refs
    WHERE id = ?
  `;
  if (candidate.database) {
    const row = candidate.database.query<Record<string, unknown>>(sql).get(credentialRefId);
    return row ? normalizeCredentialReference(row) : null;
  }
  const pgSql = sql.replace('?', '$1');
  const rows = candidate.sql?.unsafe
    ? await candidate.sql.unsafe(pgSql, [credentialRefId])
    : candidate.db
      ? (await candidate.db.query(pgSql, [credentialRefId])).rows
      : null;
  if (!rows) throw new Error('credential reference inspection requires a SQL-backed engine');
  return rows[0] ? normalizeCredentialReference(rows[0]) : null;
}

function buildConnectorRegistrationRecords(
  _deps: { OperationError: OperationErrorCtor },
  input: {
    connector: ConnectorDefinition;
    source: SourceRecord;
    account_locator: string;
    credential_ref_id: string | null;
    metadata_json: Record<string, unknown>;
    now: string;
  },
): ConnectorRegistrationRecords {
  const accountId = connectorAccountId(input.connector.id, input.account_locator);
  const accountStatus = connectorAccountStatus(input.source);
  const grantState = connectorGrantState(input.source);
  return {
    account: {
      id: accountId,
      connector_id: input.connector.id,
      source_id: input.source.id,
      account_locator: input.account_locator,
      display_name: input.source.display_name,
      credential_ref_id: input.credential_ref_id,
      status: accountStatus,
      metadata_json: input.metadata_json,
      created_at: input.now,
      updated_at: input.now,
    },
    grants: input.connector.default_scopes.map((scope) => ({
      id: stableId('connector-grant', accountId, scope),
      account_id: accountId,
      scope,
      grant_state: grantState,
      granted_at: grantState === 'granted' ? input.now : null,
      revoked_at: grantState === 'revoked' ? input.now : null,
      metadata_json: {},
      created_at: input.now,
      updated_at: input.now,
    })),
    sync_state: {
      id: stableId('connector-sync-state', accountId, input.connector.id),
      account_id: accountId,
      connector_id: input.connector.id,
      cursor_json: {},
      last_sync_started_at: null,
      last_sync_finished_at: null,
      last_success_at: null,
      last_failure_at: null,
      health_status: connectorHealthStatus(input.source, input.credential_ref_id),
      failure_count: 0,
      last_error: null,
      metadata_json: {},
      created_at: input.now,
      updated_at: input.now,
    },
  };
}

function connectorAccountId(connectorId: string, accountLocator: string): string {
  return stableId('connector-account', connectorId, accountLocator);
}

function connectorAccountStatus(source: SourceRecord): ConnectorAccountRecord['status'] {
  if (source.consent_state === 'revoked') return 'revoked';
  if (!source.enabled) return 'paused';
  return 'active';
}

function connectorGrantState(source: SourceRecord): ConnectorGrantRecord['grant_state'] {
  if (source.consent_state === 'granted') return 'granted';
  if (source.consent_state === 'revoked') return 'revoked';
  return 'denied';
}

function connectorHealthStatus(
  source: SourceRecord,
  credentialRefId: string | null,
): ConnectorSyncStateRecord['health_status'] {
  if (source.consent_state === 'revoked') return 'revoked';
  if (!source.enabled) return 'paused';
  if (!credentialRefId) return 'unknown';
  return 'healthy';
}

async function insertCredentialReference(engine: BrainEngine, credential: CredentialReferenceRecord): Promise<void> {
  const candidate = engine as QueryableEngine;
  const values = [
    credential.id,
    credential.connector_id,
    credential.account_id,
    credential.provider,
    credential.reference,
    JSON.stringify(credential.scopes),
    credential.expires_at,
    credential.last_used_at,
    credential.rotation_status,
    credential.health_status,
    credential.created_at,
    credential.updated_at,
  ];
  if (candidate.database) {
    candidate.database.query(`
      INSERT INTO credential_refs (
        id, connector_id, account_id, provider, reference, scopes_json,
        expires_at, last_used_at, rotation_status, health_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...values);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      INSERT INTO credential_refs (
        id, connector_id, account_id, provider, reference, scopes_json,
        expires_at, last_used_at, rotation_status, health_status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
    `, values);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      INSERT INTO credential_refs (
        id, connector_id, account_id, provider, reference, scopes_json,
        expires_at, last_used_at, rotation_status, health_status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
    `, values);
    return;
  }
  throw new Error('credential reference operations require a SQL-backed engine');
}

async function insertConnectorAccount(engine: BrainEngine, account: ConnectorAccountRecord): Promise<void> {
  const candidate = engine as QueryableEngine;
  const values = [
    account.id,
    account.connector_id,
    account.source_id,
    account.account_locator,
    account.display_name,
    account.credential_ref_id,
    account.status,
    JSON.stringify(account.metadata_json),
    account.created_at,
    account.updated_at,
  ];
  if (candidate.database) {
    candidate.database.query(`
      INSERT INTO connector_accounts (
        id, connector_id, source_id, account_locator, display_name, credential_ref_id,
        status, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...values);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      INSERT INTO connector_accounts (
        id, connector_id, source_id, account_locator, display_name, credential_ref_id,
        status, metadata_json, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
    `, values);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      INSERT INTO connector_accounts (
        id, connector_id, source_id, account_locator, display_name, credential_ref_id,
        status, metadata_json, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
    `, values);
    return;
  }
  throw new Error('connector registration operations require a SQL-backed engine');
}

async function insertConnectorGrant(engine: BrainEngine, grant: ConnectorGrantRecord): Promise<void> {
  const candidate = engine as QueryableEngine;
  const values = [
    grant.id,
    grant.account_id,
    grant.scope,
    grant.grant_state,
    grant.granted_at,
    grant.revoked_at,
    JSON.stringify(grant.metadata_json),
    grant.created_at,
    grant.updated_at,
  ];
  if (candidate.database) {
    candidate.database.query(`
      INSERT INTO connector_grants (
        id, account_id, scope, grant_state, granted_at, revoked_at, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...values);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      INSERT INTO connector_grants (
        id, account_id, scope, grant_state, granted_at, revoked_at, metadata_json, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
    `, values);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      INSERT INTO connector_grants (
        id, account_id, scope, grant_state, granted_at, revoked_at, metadata_json, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
    `, values);
    return;
  }
  throw new Error('connector registration operations require a SQL-backed engine');
}

async function insertConnectorSyncState(engine: BrainEngine, syncState: ConnectorSyncStateRecord): Promise<void> {
  const candidate = engine as QueryableEngine;
  const values = [
    syncState.id,
    syncState.account_id,
    syncState.connector_id,
    JSON.stringify(syncState.cursor_json),
    syncState.last_sync_started_at,
    syncState.last_sync_finished_at,
    syncState.last_success_at,
    syncState.last_failure_at,
    syncState.health_status,
    syncState.failure_count,
    syncState.last_error,
    JSON.stringify(syncState.metadata_json),
    syncState.created_at,
    syncState.updated_at,
  ];
  if (candidate.database) {
    candidate.database.query(`
      INSERT INTO connector_sync_states (
        id, account_id, connector_id, cursor_json, last_sync_started_at, last_sync_finished_at,
        last_success_at, last_failure_at, health_status, failure_count, last_error, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...values);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      INSERT INTO connector_sync_states (
        id, account_id, connector_id, cursor_json, last_sync_started_at, last_sync_finished_at,
        last_success_at, last_failure_at, health_status, failure_count, last_error, metadata_json,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
    `, values);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      INSERT INTO connector_sync_states (
        id, account_id, connector_id, cursor_json, last_sync_started_at, last_sync_finished_at,
        last_success_at, last_failure_at, health_status, failure_count, last_error, metadata_json,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
    `, values);
    return;
  }
  throw new Error('connector registration operations require a SQL-backed engine');
}

async function ingestConnectorItem(
  deps: { OperationError: OperationErrorCtor },
  ctx: OperationContext,
  input: ConnectorItemIngestInput,
): Promise<Record<string, unknown>> {
  const source = await readFullSourceRecord(ctx.engine, input.source_id);
  if (!source) {
    throw invalidParams(deps, `source_id not found: ${input.source_id}`);
  }
  if (source.connector_id !== input.connector_id) {
    throw invalidParams(deps, `source_id is registered for ${source.connector_id ?? 'no connector'}, not ${input.connector_id}`);
  }
  const policy = (await inspectSourcePolicy(ctx.engine, source)).resolved;
  const plan = previewRawSourceIngest({
    source_id: source.id,
    external_id: input.external_id,
    origin_event: 'connector_sync',
    locator: input.locator,
    title: input.title,
    chunk_texts: [input.body],
    raw_text: input.body,
    parser_version: input.parser_version ?? `${source.kind}-connector:v1`,
    now: input.now,
  }, rawIngestPolicyFromResolved(policy));
  plan.item.source_created_at = input.source_created_at ?? null;
  plan.item.source_updated_at = input.source_updated_at ?? null;
  plan.item.metadata_json = {
    ...input.metadata_json,
    connector_id: source.connector_id,
  };

  const existing = await readSourceItemByExternalId(ctx.engine, source.id, input.external_id);
  if (existing?.content_hash === plan.item.content_hash) {
    return {
      status: 'skipped',
      reason: 'unchanged_content_hash',
      item: existing,
    };
  }

  if (ctx.dryRun) {
    return {
      status: existing ? 'would_update' : 'would_ingest',
      ...plan,
    };
  }

  await ctx.engine.transaction(async (tx) => {
    await persistRawIngestPlan(tx, plan);
  });

  return {
    status: existing ? 'updated' : 'ingested',
    ...plan,
  };
}

function rawIngestPolicyFromResolved(
  resolved: ReturnType<typeof resolveSourceRegistryPolicy>,
): RawIngestPolicy {
  return {
    consent_state: resolved.consent_state,
    enabled: resolved.processing.can_ingest,
    raw_copy_mode: resolved.policy.raw_copy_mode,
    automatic_canonical_write_authority: resolved.policy.automatic_canonical_write_authority,
  };
}

async function recordConnectorFailure(
  deps: { OperationError: OperationErrorCtor },
  ctx: OperationContext,
  input: ConnectorFailureOperationInput,
): Promise<Record<string, unknown>> {
  const source = await requireConnectorSource(deps, ctx.engine, input.source_id, input.connector_id);
  const account = await readConnectorAccount(ctx.engine, source.id);
  if (!account) throw invalidParams(deps, `connector account not found for source_id: ${source.id}`);
  const event = buildSourceStatusEvent({
    source_id: source.id,
    event_type: 'connector_sync_failed',
    previous_state: source.consent_state,
    next_state: source.consent_state,
    actor_ref: `connector:${input.connector_id}`,
    reason: input.error_message,
    metadata_json: {
      connector_id: input.connector_id,
      health_status: 'unhealthy',
    },
    created_at: input.now,
  });

  if (ctx.dryRun) {
    return { status: 'dry_run', source_id: source.id, status_event: event };
  }

  await ctx.engine.transaction(async (tx) => {
    await insertSourceStatusEvent(tx, event);
    await updateConnectorFailureHealth(tx, account, input.error_message, input.now);
  });

  const syncState = await readConnectorSyncState(ctx.engine, account.id, account.connector_id);
  return {
    status: 'recorded',
    source_id: source.id,
    connector_account_id: account.id,
    status_event: event,
    connector_sync_state: syncState,
  };
}

async function recordConnectorSyncSuccess(
  deps: { OperationError: OperationErrorCtor },
  ctx: OperationContext,
  input: ConnectorSyncSuccessOperationInput,
): Promise<Record<string, unknown>> {
  const source = await requireConnectorSource(deps, ctx.engine, input.source_id, input.connector_id);
  const policy = (await inspectSourcePolicy(ctx.engine, source)).resolved;
  if (!policy.processing.can_ingest) {
    throw invalidParams(deps, `source consent ${source.consent_state} prevents sync success`);
  }
  const account = await readConnectorAccount(ctx.engine, source.id);
  if (!account) throw invalidParams(deps, `connector account not found for source_id: ${source.id}`);
  const metadata = {
    ...input.metadata_json,
    connector_id: input.connector_id,
    health_status: 'healthy',
    ingested_count: input.ingested_count,
    skipped_count: input.skipped_count,
  };
  const event = buildSourceStatusEvent({
    source_id: source.id,
    event_type: 'connector_sync_succeeded',
    previous_state: source.consent_state,
    next_state: source.consent_state,
    actor_ref: `connector:${input.connector_id}`,
    reason: 'connector sync completed',
    metadata_json: metadata,
    created_at: input.now,
  });
  const syncStartedAt = input.sync_started_at ?? input.now;

  if (ctx.dryRun) {
    return {
      status: 'dry_run',
      source_id: source.id,
      connector_account_id: account.id,
      status_event: event,
      connector_sync_state_patch: {
        cursor_json: input.cursor_json,
        last_sync_started_at: syncStartedAt,
        last_sync_finished_at: input.now,
        last_success_at: input.now,
        health_status: 'healthy',
        failure_count: 0,
        last_error: null,
        metadata_json: metadata,
      },
    };
  }

  await ctx.engine.transaction(async (tx) => {
    await insertSourceStatusEvent(tx, event);
    await updateConnectorSuccessHealth(tx, account, {
      cursor_json: input.cursor_json,
      sync_started_at: syncStartedAt,
      sync_finished_at: input.now,
      metadata_json: metadata,
    });
  });

  const syncState = await readConnectorSyncState(ctx.engine, account.id, account.connector_id);
  return {
    status: 'recorded',
    source_id: source.id,
    connector_account_id: account.id,
    status_event: event,
    connector_sync_state: syncState,
  };
}

async function recordConnectorItemDeletion(
  deps: { OperationError: OperationErrorCtor },
  ctx: OperationContext,
  input: ConnectorDeletionOperationInput,
): Promise<Record<string, unknown>> {
  const source = await requireConnectorSource(deps, ctx.engine, input.source_id, input.connector_id);
  const item = await readSourceItemByExternalId(ctx.engine, source.id, input.external_id);
  if (!item) {
    throw invalidParams(deps, `source item not found for external_id: ${input.external_id}`);
  }
  const event: SourceItemEventRecord = {
    id: stableId('source-item-event', item.id, 'source_deleted_archived', input.deleted_at),
    source_item_id: item.id,
    event_type: 'source_deleted_archived',
    created_at: input.now,
  };

  if (ctx.dryRun) {
    return {
      status: 'dry_run',
      action: 'archive_for_retention',
      purge_immediately: false,
      source_item_id: item.id,
      source_id: source.id,
      external_id: item.external_id,
      deleted_at: input.deleted_at,
      event,
    };
  }

  await ctx.engine.transaction(async (tx) => {
    await insertSourceItemEvent(tx, event);
  });

  return {
    status: 'recorded',
    action: 'archive_for_retention',
    purge_immediately: false,
    source_item_id: item.id,
    source_id: source.id,
    external_id: item.external_id,
    deleted_at: input.deleted_at,
    event,
  };
}

async function requireConnectorSource(
  deps: { OperationError: OperationErrorCtor },
  engine: BrainEngine,
  sourceId: string,
  connectorId: string,
): Promise<SourceRecord> {
  const source = await readFullSourceRecord(engine, sourceId);
  if (!source) throw invalidParams(deps, `source_id not found: ${sourceId}`);
  if (source.connector_id !== connectorId) {
    throw invalidParams(deps, `source_id is registered for ${source.connector_id ?? 'no connector'}, not ${connectorId}`);
  }
  return source;
}

async function updateConnectorFailureHealth(
  engine: BrainEngine,
  account: ConnectorAccountRecord,
  errorMessage: string,
  now: string,
): Promise<void> {
  const candidate = engine as QueryableEngine;
  if (candidate.database) {
    candidate.database.query(`
      UPDATE connector_sync_states
      SET health_status = 'unhealthy',
          failure_count = failure_count + 1,
          last_failure_at = ?,
          last_error = ?,
          updated_at = ?
      WHERE account_id = ? AND connector_id = ?
    `).run(now, errorMessage, now, account.id, account.connector_id);
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      UPDATE connector_sync_states
      SET health_status = 'unhealthy',
          failure_count = failure_count + 1,
          last_failure_at = $1,
          last_error = $2,
          updated_at = $1
      WHERE account_id = $3 AND connector_id = $4
    `, [now, errorMessage, account.id, account.connector_id]);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      UPDATE connector_sync_states
      SET health_status = 'unhealthy',
          failure_count = failure_count + 1,
          last_failure_at = $1,
          last_error = $2,
          updated_at = $1
      WHERE account_id = $3 AND connector_id = $4
    `, [now, errorMessage, account.id, account.connector_id]);
    return;
  }
  throw new Error('connector failure operations require a SQL-backed engine');
}

async function updateConnectorSuccessHealth(
  engine: BrainEngine,
  account: ConnectorAccountRecord,
  input: {
    cursor_json: Record<string, unknown>;
    sync_started_at: string;
    sync_finished_at: string;
    metadata_json: Record<string, unknown>;
  },
): Promise<void> {
  const candidate = engine as QueryableEngine;
  const cursorJson = JSON.stringify(input.cursor_json);
  const metadataJson = JSON.stringify(input.metadata_json);
  if (candidate.database) {
    candidate.database.query(`
      UPDATE connector_sync_states
      SET cursor_json = ?,
          last_sync_started_at = ?,
          last_sync_finished_at = ?,
          last_success_at = ?,
          health_status = 'healthy',
          failure_count = 0,
          last_error = NULL,
          metadata_json = ?,
          updated_at = ?
      WHERE account_id = ? AND connector_id = ?
    `).run(
      cursorJson,
      input.sync_started_at,
      input.sync_finished_at,
      input.sync_finished_at,
      metadataJson,
      input.sync_finished_at,
      account.id,
      account.connector_id,
    );
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      UPDATE connector_sync_states
      SET cursor_json = $1::jsonb,
          last_sync_started_at = $2,
          last_sync_finished_at = $3,
          last_success_at = $3,
          health_status = 'healthy',
          failure_count = 0,
          last_error = NULL,
          metadata_json = $4::jsonb,
          updated_at = $3
      WHERE account_id = $5 AND connector_id = $6
    `, [
      cursorJson,
      input.sync_started_at,
      input.sync_finished_at,
      metadataJson,
      account.id,
      account.connector_id,
    ]);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      UPDATE connector_sync_states
      SET cursor_json = $1::jsonb,
          last_sync_started_at = $2,
          last_sync_finished_at = $3,
          last_success_at = $3,
          health_status = 'healthy',
          failure_count = 0,
          last_error = NULL,
          metadata_json = $4::jsonb,
          updated_at = $3
      WHERE account_id = $5 AND connector_id = $6
    `, [
      cursorJson,
      input.sync_started_at,
      input.sync_finished_at,
      metadataJson,
      account.id,
      account.connector_id,
    ]);
    return;
  }
  throw new Error('connector success operations require a SQL-backed engine');
}

async function listSourceInspectionRows(
  engine: BrainEngine,
  filters: SourceInspectionFilters,
): Promise<{ sources: Record<string, unknown>[] }> {
  const sources = (await readAllSourceRecords(engine))
    .filter((source) => !filters.source_kind || source.kind === filters.source_kind)
    .filter((source) => !filters.connector_id || source.connector_id === filters.connector_id)
    .filter((source) => !filters.consent_state || source.consent_state === filters.consent_state)
    .filter((source) => filters.enabled === undefined || source.enabled === filters.enabled)
    .slice(0, filters.limit);

  const inspected = [];
  for (const source of sources) {
    inspected.push(await buildSourceInspection(engine, source, false));
  }
  return { sources: inspected };
}

async function getSourceInspectionRow(
  deps: { OperationError: OperationErrorCtor },
  engine: BrainEngine,
  sourceId: string,
): Promise<Record<string, unknown>> {
  const source = await readFullSourceRecord(engine, sourceId);
  if (!source) {
    throw invalidParams(deps, `source_id not found: ${sourceId}`);
  }
  return buildSourceInspection(engine, source, true);
}

async function buildSourceInspection(
  engine: BrainEngine,
  source: SourceRecord,
  includeStatusEvents: boolean,
): Promise<Record<string, unknown>> {
  const policyInspection = await inspectSourcePolicy(engine, source);
  const connectorAccount = source.connector_id
    ? await readConnectorAccount(engine, source.id)
    : null;
  const connectorGrants = connectorAccount
    ? await readConnectorGrants(engine, connectorAccount.id)
    : [];
  const connectorSyncState = connectorAccount
    ? await readConnectorSyncState(engine, connectorAccount.id, connectorAccount.connector_id)
    : null;
  const credentialRef = connectorAccount?.credential_ref_id
    ? await readCredentialReference(engine, connectorAccount.credential_ref_id)
    : null;
  const inspection: Record<string, unknown> = {
    source,
    policy: policyInspection.resolved,
    policy_storage: {
      persisted_policy: policyInspection.persisted_policy,
      active_overrides: policyInspection.active_overrides,
    },
    credential_ref: credentialRef,
    connector_account: connectorAccount,
    connector_grants: connectorGrants,
    connector_sync_state: connectorSyncState,
  };
  if (includeStatusEvents) {
    inspection.status_events = await readSourceStatusEvents(engine, source.id);
  }
  return inspection;
}

async function inspectSourcePolicy(
  engine: BrainEngine,
  source: SourceRecord,
): Promise<{
  resolved: ReturnType<typeof resolveSourceRegistryPolicy>;
  persisted_policy: (SourcePolicy & { id: string }) | null;
  active_overrides: SourcePolicyOverride[];
}> {
  const persistedPolicy = await readPersistedSourcePolicy(engine, source);
  const activeOverrides = await readSourcePolicyOverrides(engine, source.id);
  if (!persistedPolicy) {
    return {
      resolved: resolveSourceRegistryPolicy({
        source_kind: source.kind,
        consent_state: source.consent_state,
        enabled: source.enabled,
        paused_at: source.paused_at,
        overrides: activeOverrides,
      }),
      persisted_policy: null,
      active_overrides: activeOverrides,
    };
  }
  const { id: _id, ...storedPolicy } = persistedPolicy;
  const policy = applySourcePolicyOverrides(storedPolicy, activeOverrides);
  const defaultResolved = resolveSourceRegistryPolicy({
    source_kind: source.kind,
    consent_state: source.consent_state,
    enabled: source.enabled,
    paused_at: source.paused_at,
    overrides: activeOverrides,
  });
  return {
    resolved: {
      ...defaultResolved,
      policy,
      processing: sourceProcessingForPolicy(policy, defaultResolved.processing.blocked_by),
      applied_overrides: activeOverrides.map((override) => override.dimension),
    },
    persisted_policy: persistedPolicy,
    active_overrides: activeOverrides,
  };
}

function sourceProcessingForPolicy(
  policy: SourcePolicy,
  blockers: string[],
): ReturnType<typeof resolveSourceRegistryPolicy>['processing'] {
  const allowed = blockers.length === 0;
  return {
    can_ingest: allowed,
    can_index: allowed,
    can_extract: allowed,
    can_use_llm: allowed && policy.llm_access !== 'none_unless_requested',
    can_use_runner: allowed && policy.runner_access !== 'none_unless_requested',
    can_auto_write: allowed && policyAllowsAutomaticCanonicalWrite(policy.automatic_canonical_write_authority),
    blocked_by: blockers,
  };
}

function policyAllowsAutomaticCanonicalWrite(authority: string): boolean {
  const normalized = authority.toLowerCase();
  if (normalized.includes('verify_first')) return false;
  if (normalized === 'candidate' || normalized.startsWith('candidate')) return false;
  return normalized.includes('auto');
}

async function readAllSourceRecords(engine: BrainEngine): Promise<SourceRecord[]> {
  const rows = await queryRows(engine, `
    SELECT id, kind, display_name, connector_id, locator, consent_state, enabled, paused_at,
           policy_id, metadata_json, created_at, updated_at, archived_at
    FROM sources
    ORDER BY updated_at DESC, created_at DESC, id ASC
  `);
  return rows.map(normalizeSourceRecord);
}

async function listSourceItems(
  engine: BrainEngine,
  input: SourceItemsListInput,
): Promise<{ source_id: string; items: Array<SourceItemRecord & { chunks?: SourceChunkRecord[] }> }> {
  const candidate = engine as QueryableEngine;
  const sql = `
    SELECT id, source_id, external_id, origin_event, locator, title, source_created_at, source_updated_at,
           ingested_at, content_hash, metadata_json, raw_copy_mode, raw_copy_ref, sensitivity_level,
           ingest_status, retention_policy_id
    FROM source_items
    WHERE source_id = ?
    ORDER BY ingested_at DESC, id ASC
    LIMIT ?
  `;
  const rows = candidate.database
    ? candidate.database.query<Record<string, unknown>>(sql).all(input.source_id, input.limit)
    : candidate.sql?.unsafe
      ? await candidate.sql.unsafe(sql.replace('?', '$1').replace('?', '$2'), [input.source_id, input.limit])
      : candidate.db
        ? (await candidate.db.query(sql.replace('?', '$1').replace('?', '$2'), [input.source_id, input.limit])).rows
        : null;
  if (!rows) throw new Error('source item inspection operations require a SQL-backed engine');

  const items: Array<SourceItemRecord & { chunks?: SourceChunkRecord[] }> = [];
  for (const row of rows) {
    const item = mapSourceItem(row);
    items.push(input.include_chunks ? {
      ...item,
      chunks: await readSourceItemChunks(engine, item.id),
    } : item);
  }
  return { source_id: input.source_id, items };
}

async function readFullSourceRecord(engine: BrainEngine, sourceId: string): Promise<SourceRecord | null> {
  const candidate = engine as QueryableEngine;
  const sql = `
    SELECT id, kind, display_name, connector_id, locator, consent_state, enabled, paused_at,
           policy_id, metadata_json, created_at, updated_at, archived_at
    FROM sources
    WHERE id = ?
  `;
  if (candidate.database) {
    const row = candidate.database.query<Record<string, unknown>>(sql).get(sourceId);
    return row ? normalizeSourceRecord(row) : null;
  }
  const pgSql = sql.replace('?', '$1');
  const rows = candidate.sql?.unsafe
    ? await candidate.sql.unsafe(pgSql, [sourceId])
    : candidate.db
      ? (await candidate.db.query(pgSql, [sourceId])).rows
      : null;
  if (!rows) throw new Error('source inspection operations require a SQL-backed engine');
  return rows[0] ? normalizeSourceRecord(rows[0]) : null;
}

async function readPersistedSourcePolicy(
  engine: BrainEngine,
  source: SourceRecord,
): Promise<(SourcePolicy & { id: string }) | null> {
  const candidate = engine as QueryableEngine;
  const sql = `
    SELECT id, source_kind, ingest_mode, index_mode, extraction_mode, raw_copy_mode,
           chunk_retention, llm_access, runner_access, automatic_canonical_write_authority,
           candidate_route_conditions, conflict_route_conditions, forgetting_lifecycle,
           restore_window, purge_policy, export_reconcile_behavior
    FROM source_policies
    WHERE id = ? OR source_kind = ?
    ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `;
  if (candidate.database) {
    const row = candidate.database.query<Record<string, unknown>>(sql).get(
      source.policy_id ?? '',
      source.kind,
      source.policy_id ?? '',
    );
    return row ? normalizePersistedSourcePolicy(row) : null;
  }
  const pgSql = sql.replace('?', '$1').replace('?', '$2').replace('?', '$3');
  const rows = candidate.sql?.unsafe
    ? await candidate.sql.unsafe(pgSql, [source.policy_id ?? '', source.kind, source.policy_id ?? ''])
    : candidate.db
      ? (await candidate.db.query(pgSql, [source.policy_id ?? '', source.kind, source.policy_id ?? ''])).rows
      : null;
  if (!rows) throw new Error('source policy inspection operations require a SQL-backed engine');
  return rows[0] ? normalizePersistedSourcePolicy(rows[0]) : null;
}

async function readSourcePolicyOverrides(
  engine: BrainEngine,
  sourceId: string,
): Promise<SourcePolicyOverride[]> {
  const candidate = engine as QueryableEngine;
  const sql = `
    SELECT dimension, override_value
    FROM source_policy_overrides
    WHERE source_id = ? AND revoked_at IS NULL
    ORDER BY created_at ASC, id ASC
  `;
  if (candidate.database) {
    return candidate.database.query<Record<string, unknown>>(sql).all(sourceId).map(normalizeSourcePolicyOverride);
  }
  const pgSql = sql.replace('?', '$1');
  const rows = candidate.sql?.unsafe
    ? await candidate.sql.unsafe(pgSql, [sourceId])
    : candidate.db
      ? (await candidate.db.query(pgSql, [sourceId])).rows
      : null;
  if (!rows) throw new Error('source policy inspection operations require a SQL-backed engine');
  return rows.map(normalizeSourcePolicyOverride);
}

async function readSourceStatusEvents(
  engine: BrainEngine,
  sourceId: string,
): Promise<SourceStatusEventRecord[]> {
  const candidate = engine as QueryableEngine;
  const sql = `
    SELECT id, source_id, event_type, previous_state, next_state, actor_ref, reason, metadata_json, created_at
    FROM source_status_events
    WHERE source_id = ?
    ORDER BY created_at ASC, id ASC
  `;
  if (candidate.database) {
    return candidate.database.query<Record<string, unknown>>(sql).all(sourceId).map(normalizeStatusEventRecord);
  }
  const pgSql = sql.replace('?', '$1');
  const rows = candidate.sql?.unsafe
    ? await candidate.sql.unsafe(pgSql, [sourceId])
    : candidate.db
      ? (await candidate.db.query(pgSql, [sourceId])).rows
      : null;
  if (!rows) throw new Error('source inspection operations require a SQL-backed engine');
  return rows.map(normalizeStatusEventRecord);
}

async function readConnectorAccount(
  engine: BrainEngine,
  sourceId: string,
): Promise<ConnectorAccountRecord | null> {
  const candidate = engine as QueryableEngine;
  const sql = `
    SELECT id, connector_id, source_id, account_locator, display_name, credential_ref_id,
           status, metadata_json, created_at, updated_at
    FROM connector_accounts
    WHERE source_id = ?
    ORDER BY updated_at DESC, id ASC
    LIMIT 1
  `;
  if (candidate.database) {
    const row = candidate.database.query<Record<string, unknown>>(sql).get(sourceId);
    return row ? normalizeConnectorAccount(row) : null;
  }
  const pgSql = sql.replace('?', '$1');
  const rows = candidate.sql?.unsafe
    ? await candidate.sql.unsafe(pgSql, [sourceId])
    : candidate.db
      ? (await candidate.db.query(pgSql, [sourceId])).rows
      : null;
  if (!rows) throw new Error('source inspection operations require a SQL-backed engine');
  return rows[0] ? normalizeConnectorAccount(rows[0]) : null;
}

async function readConnectorGrants(
  engine: BrainEngine,
  accountId: string,
): Promise<ConnectorGrantRecord[]> {
  const candidate = engine as QueryableEngine;
  const sql = `
    SELECT id, account_id, scope, grant_state, granted_at, revoked_at, metadata_json, created_at, updated_at
    FROM connector_grants
    WHERE account_id = ?
    ORDER BY scope ASC
  `;
  if (candidate.database) {
    return candidate.database.query<Record<string, unknown>>(sql).all(accountId).map(normalizeConnectorGrant);
  }
  const pgSql = sql.replace('?', '$1');
  const rows = candidate.sql?.unsafe
    ? await candidate.sql.unsafe(pgSql, [accountId])
    : candidate.db
      ? (await candidate.db.query(pgSql, [accountId])).rows
      : null;
  if (!rows) throw new Error('source inspection operations require a SQL-backed engine');
  return rows.map(normalizeConnectorGrant);
}

async function readConnectorSyncState(
  engine: BrainEngine,
  accountId: string,
  connectorId: string,
): Promise<ConnectorSyncStateRecord | null> {
  const candidate = engine as QueryableEngine;
  const sql = `
    SELECT id, account_id, connector_id, cursor_json, last_sync_started_at, last_sync_finished_at,
           last_success_at, last_failure_at, health_status, failure_count, last_error, metadata_json,
           created_at, updated_at
    FROM connector_sync_states
    WHERE account_id = ? AND connector_id = ?
    LIMIT 1
  `;
  if (candidate.database) {
    const row = candidate.database.query<Record<string, unknown>>(sql).get(accountId, connectorId);
    return row ? normalizeConnectorSyncState(row) : null;
  }
  const pgSql = sql.replace('?', '$1').replace('?', '$2');
  const rows = candidate.sql?.unsafe
    ? await candidate.sql.unsafe(pgSql, [accountId, connectorId])
    : candidate.db
      ? (await candidate.db.query(pgSql, [accountId, connectorId])).rows
      : null;
  if (!rows) throw new Error('source inspection operations require a SQL-backed engine');
  return rows[0] ? normalizeConnectorSyncState(rows[0]) : null;
}

async function queryRows(engine: BrainEngine, sql: string): Promise<Record<string, unknown>[]> {
  const candidate = engine as QueryableEngine;
  if (candidate.database) {
    return candidate.database.query<Record<string, unknown>>(sql).all();
  }
  if (candidate.sql?.unsafe) {
    return candidate.sql.unsafe(sql);
  }
  if (candidate.db) {
    return (await candidate.db.query(sql)).rows;
  }
  throw new Error('source inspection operations require a SQL-backed engine');
}

function normalizeSourceRecord(row: Record<string, unknown>): SourceRecord {
  const kind = String(row.kind);
  const consent = String(row.consent_state);
  if (!isSourceKind(kind)) {
    throw new Error(`stored source has invalid kind: ${kind}`);
  }
  if (!isSourceConsentState(consent)) {
    throw new Error(`stored source has invalid consent_state: ${consent}`);
  }
  return {
    id: String(row.id),
    kind,
    display_name: String(row.display_name),
    connector_id: nullableString(row.connector_id),
    locator: nullableString(row.locator),
    consent_state: consent,
    enabled: booleanFromDb(row.enabled),
    paused_at: nullableDateString(row.paused_at),
    policy_id: nullableString(row.policy_id),
    metadata_json: jsonRecord(row.metadata_json),
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
    archived_at: nullableDateString(row.archived_at),
  };
}

function normalizeStatusEventRecord(row: Record<string, unknown>): SourceStatusEventRecord {
  return {
    id: String(row.id),
    source_id: String(row.source_id),
    event_type: String(row.event_type),
    previous_state: nullableString(row.previous_state),
    next_state: nullableString(row.next_state),
    actor_ref: String(row.actor_ref ?? ''),
    reason: String(row.reason ?? ''),
    metadata_json: jsonRecord(row.metadata_json),
    created_at: dateString(row.created_at),
  };
}

function normalizePersistedSourcePolicy(row: Record<string, unknown>): SourcePolicy & { id: string } {
  const sourceKind = String(row.source_kind);
  if (!isSourceKind(sourceKind)) {
    throw new Error(`stored source policy has invalid source_kind: ${sourceKind}`);
  }
  return {
    id: String(row.id),
    source_kind: sourceKind,
    ingest_mode: String(row.ingest_mode),
    index_mode: String(row.index_mode),
    extraction_mode: String(row.extraction_mode),
    raw_copy_mode: String(row.raw_copy_mode),
    chunk_retention: String(row.chunk_retention),
    llm_access: String(row.llm_access),
    runner_access: String(row.runner_access),
    automatic_canonical_write_authority: String(row.automatic_canonical_write_authority),
    candidate_route_conditions: jsonStringArray(row.candidate_route_conditions),
    conflict_route_conditions: jsonStringArray(row.conflict_route_conditions),
    forgetting_lifecycle: String(row.forgetting_lifecycle),
    restore_window: String(row.restore_window),
    purge_policy: String(row.purge_policy),
    export_reconcile_behavior: String(row.export_reconcile_behavior),
  };
}

function normalizeSourcePolicyOverride(row: Record<string, unknown>): SourcePolicyOverride {
  const dimension = String(row.dimension);
  if (!SOURCE_POLICY_DIMENSIONS.includes(dimension as keyof SourcePolicy)) {
    throw new Error(`stored source policy override has invalid dimension: ${dimension}`);
  }
  return {
    dimension: dimension as keyof SourcePolicy,
    value: jsonValue(row.override_value) as string | string[],
  };
}

function normalizeCredentialReference(row: Record<string, unknown>): CredentialReferenceInspectionRow {
  return {
    id: String(row.id),
    connector_id: String(row.connector_id),
    account_id: String(row.account_id),
    provider: String(row.provider ?? ''),
    reference: String(row.reference ?? ''),
    scopes: jsonStringArray(row.scopes_json),
    expires_at: nullableDateString(row.expires_at),
    last_used_at: nullableDateString(row.last_used_at),
    rotation_status: String(row.rotation_status ?? ''),
    health_status: String(row.health_status ?? ''),
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function normalizeConnectorAccount(row: Record<string, unknown>): ConnectorAccountRecord {
  return {
    id: String(row.id),
    connector_id: String(row.connector_id),
    source_id: String(row.source_id),
    account_locator: String(row.account_locator),
    display_name: String(row.display_name ?? ''),
    credential_ref_id: nullableString(row.credential_ref_id),
    status: connectorAccountRecordStatus(row.status),
    metadata_json: jsonRecord(row.metadata_json),
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function normalizeConnectorGrant(row: Record<string, unknown>): ConnectorGrantRecord {
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    scope: String(row.scope),
    grant_state: connectorGrantRecordState(row.grant_state),
    granted_at: nullableDateString(row.granted_at),
    revoked_at: nullableDateString(row.revoked_at),
    metadata_json: jsonRecord(row.metadata_json),
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function normalizeConnectorSyncState(row: Record<string, unknown>): ConnectorSyncStateRecord {
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    connector_id: String(row.connector_id),
    cursor_json: jsonRecord(row.cursor_json),
    last_sync_started_at: nullableDateString(row.last_sync_started_at),
    last_sync_finished_at: nullableDateString(row.last_sync_finished_at),
    last_success_at: nullableDateString(row.last_success_at),
    last_failure_at: nullableDateString(row.last_failure_at),
    health_status: connectorSyncHealthRecordStatus(row.health_status),
    failure_count: Number(row.failure_count ?? 0),
    last_error: nullableString(row.last_error),
    metadata_json: jsonRecord(row.metadata_json),
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

function connectorAccountRecordStatus(value: unknown): ConnectorAccountRecord['status'] {
  const status = String(value);
  if (status === 'active' || status === 'paused' || status === 'revoked' || status === 'failed') return status;
  throw new Error(`stored connector account has invalid status: ${status}`);
}

function connectorGrantRecordState(value: unknown): ConnectorGrantRecord['grant_state'] {
  const state = String(value);
  if (state === 'granted' || state === 'denied' || state === 'revoked') return state;
  throw new Error(`stored connector grant has invalid state: ${state}`);
}

function connectorSyncHealthRecordStatus(value: unknown): ConnectorSyncStateRecord['health_status'] {
  const status = String(value);
  if (status === 'healthy' || status === 'unhealthy' || status === 'paused' || status === 'revoked' || status === 'unknown') {
    return status;
  }
  throw new Error(`stored connector sync state has invalid health_status: ${status}`);
}

async function executeSourceControlMutation(
  deps: { OperationError: OperationErrorCtor },
  ctx: OperationContext,
  input: SourceControlMutationInput,
): Promise<Record<string, unknown>> {
  const existing = await readSourceRow(ctx.engine, input.source_id);
  if (!existing) {
    throw invalidParams(deps, `source_id not found: ${input.source_id}`);
  }
  assertSourceControlEligible(deps, existing, input);
  const sourcePatch = input.operation === 'revoke_source_consent'
    ? { id: input.source_id, consent_state: 'revoked', enabled: false, paused_at: input.now }
    : { id: input.source_id, enabled: false, paused_at: input.now };

  if (ctx.dryRun) {
    return {
      action: input.operation,
      source_id: input.source_id,
      status: 'dry_run',
      source_patch: sourcePatch,
      status_event: buildSourceControlStatusEvent(existing, input),
      requires_mutation_ledger: true,
    };
  }

  const appliedResult = await ctx.engine.transaction(async (tx) => {
    const lockedExisting = await readSourceRow(tx, input.source_id);
    if (!lockedExisting) {
      throw invalidParams(deps, `source_id not found: ${input.source_id}`);
    }
    assertSourceControlEligible(deps, lockedExisting, input);
    const statusEvent = buildSourceControlStatusEvent(lockedExisting, input);
    const applied = await applySourcePatch(tx, input);
    if (!applied) {
      assertSourceControlEligible(deps, await readSourceRow(tx, input.source_id), input);
      throw invalidParams(deps, `source_id could not be updated: ${input.source_id}`);
    }
    await insertSourceStatusEvent(tx, statusEvent);
    const mutationEvent = await recordMemoryMutationEvent(tx, {
      session_id: 'memory-review-report',
      realm_id: 'work',
      actor: input.actor_ref,
      operation: input.operation,
      target_kind: 'source_record',
      target_id: input.source_id,
      scope_id: 'workspace:default',
      source_refs: [`Source: memory review report ${input.operation} for ${input.source_id}`],
      result: 'applied',
      metadata: {
        reason: input.reason,
        status_event_id: statusEvent.id,
        status_event_type: statusEvent.event_type,
      },
      created_at: input.now,
      decided_at: input.now,
      applied_at: input.now,
    });
    return { statusEvent, mutationEvent };
  });

  return {
    action: input.operation,
    source_id: input.source_id,
    status: 'applied',
    source_patch: sourcePatch,
    status_event: appliedResult.statusEvent,
    mutation_event: appliedResult.mutationEvent,
  };
}

function assertSourceControlEligible(
  deps: { OperationError: OperationErrorCtor },
  source: SourceRow | null,
  input: SourceControlMutationInput,
): asserts source is SourceRow {
  if (!source) throw invalidParams(deps, `source_id not found: ${input.source_id}`);
  if (input.operation === 'pause_source_processing' && !sourceEnabled(source.enabled)) {
    throw invalidParams(deps, `source_id must refer to an enabled source: ${input.source_id}`);
  }
  if (input.operation === 'revoke_source_consent' && source.consent_state === 'revoked') {
    throw invalidParams(deps, `source_id must refer to a source whose consent is not already revoked: ${input.source_id}`);
  }
}

function buildSourceControlStatusEvent(
  source: SourceRow,
  input: SourceControlMutationInput,
): ReturnType<typeof buildSourceStatusEvent> {
  return buildSourceStatusEvent({
    source_id: input.source_id,
    event_type: input.event_type,
    previous_state: input.operation === 'pause_source_processing'
      ? sourceEnabled(source.enabled) ? 'enabled' : 'paused'
      : String(source.consent_state),
    next_state: input.next_state,
    actor_ref: input.actor_ref,
    reason: input.reason,
    created_at: input.now,
  });
}

function sourceEnabled(value: SourceRow['enabled']): boolean {
  return value === true || value === 1;
}

async function readSourceRow(engine: BrainEngine, sourceId: string): Promise<SourceRow | null> {
  const candidate = engine as QueryableEngine;
  if (candidate.database) {
    return candidate.database.query<SourceRow>(`
      SELECT id, consent_state, enabled
      FROM sources
      WHERE id = ?
    `).get(sourceId);
  }
  if (candidate.sql?.unsafe) {
    const rows = await candidate.sql.unsafe(`
      SELECT id, consent_state, enabled
      FROM sources
      WHERE id = $1
    `, [sourceId]);
    return rows[0] as unknown as SourceRow | undefined ?? null;
  }
  if (candidate.db) {
    const result = await candidate.db.query(`
      SELECT id, consent_state, enabled
      FROM sources
      WHERE id = $1
    `, [sourceId]);
    return result.rows[0] as unknown as SourceRow | undefined ?? null;
  }
  throw new Error('source control operations require a SQL-backed engine');
}

async function applySourcePatch(engine: BrainEngine, input: SourceControlMutationInput): Promise<boolean> {
  const candidate = engine as QueryableEngine;
  if (candidate.database) {
    if (input.operation === 'revoke_source_consent') {
      const result = candidate.database.query(`
        UPDATE sources
        SET consent_state = 'revoked', enabled = 0, paused_at = ?, updated_at = ?
        WHERE id = ? AND consent_state <> 'revoked'
      `).run(input.now, input.now, input.source_id);
      return changedRows(result) > 0;
    }
    const result = candidate.database.query(`
      UPDATE sources
      SET enabled = 0, paused_at = ?, updated_at = ?
      WHERE id = ? AND enabled <> 0
    `).run(input.now, input.now, input.source_id);
    return changedRows(result) > 0;
  }
  if (candidate.sql?.unsafe) {
    if (input.operation === 'revoke_source_consent') {
      const rows = await candidate.sql.unsafe(`
        UPDATE sources
        SET consent_state = 'revoked', enabled = false, paused_at = $1, updated_at = $1
        WHERE id = $2 AND consent_state <> 'revoked'
        RETURNING id
      `, [input.now, input.source_id]);
      return rows.length > 0;
    }
    const rows = await candidate.sql.unsafe(`
      UPDATE sources
      SET enabled = false, paused_at = $1, updated_at = $1
      WHERE id = $2 AND enabled = true
      RETURNING id
    `, [input.now, input.source_id]);
    return rows.length > 0;
  }
  if (candidate.db) {
    if (input.operation === 'revoke_source_consent') {
      const result = await candidate.db.query(`
        UPDATE sources
        SET consent_state = 'revoked', enabled = false, paused_at = $1, updated_at = $1
        WHERE id = $2 AND consent_state <> 'revoked'
        RETURNING id
      `, [input.now, input.source_id]);
      return result.rows.length > 0;
    }
    const result = await candidate.db.query(`
      UPDATE sources
      SET enabled = false, paused_at = $1, updated_at = $1
      WHERE id = $2 AND enabled = true
      RETURNING id
    `, [input.now, input.source_id]);
    return result.rows.length > 0;
  }
  throw new Error('source control operations require a SQL-backed engine');
}

function changedRows(result: unknown): number {
  if (typeof result === 'object' && result !== null && 'changes' in result) {
    const changes = (result as { changes?: unknown }).changes;
    if (typeof changes === 'number') return changes;
  }
  return 0;
}

async function insertSourceStatusEvent(
  engine: BrainEngine,
  event: ReturnType<typeof buildSourceStatusEvent>,
): Promise<void> {
  const candidate = engine as QueryableEngine;
  if (candidate.database) {
    candidate.database.query(`
      INSERT INTO source_status_events (
        id, source_id, event_type, previous_state, next_state, actor_ref, reason, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.source_id,
      event.event_type,
      event.previous_state,
      event.next_state,
      event.actor_ref,
      event.reason,
      JSON.stringify(event.metadata_json),
      event.created_at,
    );
    return;
  }
  if (candidate.sql?.unsafe) {
    await candidate.sql.unsafe(`
      INSERT INTO source_status_events (
        id, source_id, event_type, previous_state, next_state, actor_ref, reason, metadata_json, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
    `, [
      event.id,
      event.source_id,
      event.event_type,
      event.previous_state,
      event.next_state,
      event.actor_ref,
      event.reason,
      JSON.stringify(event.metadata_json),
      event.created_at,
    ]);
    return;
  }
  if (candidate.db) {
    await candidate.db.query(`
      INSERT INTO source_status_events (
        id, source_id, event_type, previous_state, next_state, actor_ref, reason, metadata_json, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
    `, [
      event.id,
      event.source_id,
      event.event_type,
      event.previous_state,
      event.next_state,
      event.actor_ref,
      event.reason,
      JSON.stringify(event.metadata_json),
      event.created_at,
    ]);
    return;
  }
  throw new Error('source control operations require a SQL-backed engine');
}

function invalidParams(
  deps: { OperationError: OperationErrorCtor },
  message: string,
): Error {
  return new deps.OperationError('invalid_params', message);
}

function requiredString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParams(deps, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | undefined {
  if (value == null) return undefined;
  return requiredString(deps, field, value);
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
    throw invalidParams(deps, `${field} must be a boolean`);
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
    throw invalidParams(deps, `${field} must be a number`);
  }
  const parsed = Math.trunc(value);
  if (parsed < 1) {
    throw invalidParams(deps, `${field} must be greater than 0`);
  }
  return parsed;
}

function optionalNonNegativeNumber(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidParams(deps, `${field} must be a number`);
  }
  const parsed = Math.trunc(value);
  if (parsed < 0) {
    throw invalidParams(deps, `${field} must be greater than or equal to 0`);
  }
  return parsed;
}

function optionalObject(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (!isPlainObject(value)) {
    throw invalidParams(deps, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredObject(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): Record<string, unknown> {
  const parsed = optionalObject(deps, field, value);
  if (!parsed) throw invalidParams(deps, `${field} must be an object`);
  return parsed;
}

function stringArray(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string[] {
  if (!Array.isArray(value)) {
    throw invalidParams(deps, `${field} must be an array of strings`);
  }
  return value.map((entry, index) => requiredString(deps, `${field}[${index}]`, entry));
}

function credentialProvider(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): CredentialProvider {
  const parsed = requiredString(deps, field, value);
  if (CREDENTIAL_PROVIDER_PRIORITY.includes(parsed as CredentialProvider)) return parsed as CredentialProvider;
  throw invalidParams(deps, `${field} must be one of ${CREDENTIAL_PROVIDER_PRIORITY.join(', ')}`);
}

function optionalCredentialRotationStatus(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): CredentialRotationStatus | undefined {
  if (value == null) return undefined;
  const parsed = requiredString(deps, field, value);
  if (CREDENTIAL_ROTATION_STATUSES.includes(parsed as CredentialRotationStatus)) {
    return parsed as CredentialRotationStatus;
  }
  throw invalidParams(deps, `${field} must be one of ${CREDENTIAL_ROTATION_STATUSES.join(', ')}`);
}

function optionalCredentialHealthStatus(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): CredentialHealthStatus | undefined {
  if (value == null) return undefined;
  const parsed = requiredString(deps, field, value);
  if (CREDENTIAL_HEALTH_STATUSES.includes(parsed as CredentialHealthStatus)) {
    return parsed as CredentialHealthStatus;
  }
  throw invalidParams(deps, `${field} must be one of ${CREDENTIAL_HEALTH_STATUSES.join(', ')}`);
}

function sourceKind(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): SourceKind {
  const raw = requiredString(deps, 'source_kind', value);
  if (!isSourceKind(raw)) {
    throw invalidParams(deps, `source_kind must be one of: ${SOURCE_KINDS.join(', ')}`);
  }
  return raw;
}

function consentState(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): SourceConsentState {
  const raw = requiredString(deps, 'consent_state', value);
  if (!isSourceConsentState(raw)) {
    throw invalidParams(deps, `consent_state must be one of: ${CONSENT_STATES.join(', ')}`);
  }
  return raw;
}

function originEvent(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): SourceOriginEvent {
  const raw = requiredString(deps, 'origin_event', value);
  if (!SOURCE_ORIGIN_EVENTS.includes(raw as SourceOriginEvent)) {
    throw invalidParams(deps, `origin_event must be one of: ${SOURCE_ORIGIN_EVENTS.join(', ')}`);
  }
  return raw as SourceOriginEvent;
}

function optionalSourceKind(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): SourceKind | undefined {
  if (value == null) return undefined;
  return sourceKind(deps, value);
}

function optionalConsentState(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): SourceConsentState | undefined {
  if (value == null) return undefined;
  return consentState(deps, value);
}

function rawIngestInput(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
): RawIngestInput {
  const input: RawIngestInput = {
    source_id: requiredString(deps, 'source_id', p.source_id),
    external_id: requiredString(deps, 'external_id', p.external_id),
    origin_event: originEvent(deps, p.origin_event),
    chunk_texts: stringArray(deps, 'chunk_texts', p.chunk_texts),
    parser_version: requiredString(deps, 'parser_version', p.parser_version),
  };
  const locator = optionalNullableString(deps, 'locator', p.locator);
  if (locator !== undefined || p.locator === null) input.locator = locator;
  const title = optionalString(deps, 'title', p.title);
  if (title !== undefined) input.title = title;
  const extractorVersion = optionalString(deps, 'extractor_version', p.extractor_version);
  if (extractorVersion !== undefined) input.extractor_version = extractorVersion;
  const now = optionalString(deps, 'now', p.now);
  if (now !== undefined) input.now = now;
  const expiresAt = optionalNullableString(deps, 'expires_at', p.expires_at);
  if (expiresAt !== undefined || p.expires_at === null) input.expires_at = expiresAt;
  const requestedRawCopy = optionalBoolean(deps, 'requested_raw_copy', p.requested_raw_copy);
  if (requestedRawCopy !== undefined) input.requested_raw_copy = requestedRawCopy;
  const rawText = optionalString(deps, 'raw_text', p.raw_text);
  if (rawText !== undefined) input.raw_text = rawText;
  return input;
}

function rawIngestPolicy(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): RawIngestPolicy {
  const policy = requiredObject(deps, 'policy', value);
  return {
    consent_state: requiredString(deps, 'policy.consent_state', policy.consent_state),
    enabled: optionalBoolean(deps, 'policy.enabled', policy.enabled) ?? true,
    raw_copy_mode: requiredString(deps, 'policy.raw_copy_mode', policy.raw_copy_mode),
    automatic_canonical_write_authority: requiredString(
      deps,
      'policy.automatic_canonical_write_authority',
      policy.automatic_canonical_write_authority,
    ),
  };
}

function rawAccessRequest(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
): RawAccessRequest {
  return {
    actor_type: requiredString(deps, 'actor_type', p.actor_type),
    actor_id: requiredString(deps, 'actor_id', p.actor_id),
    session_id: optionalNullableString(deps, 'session_id', p.session_id),
    job_id: optionalNullableString(deps, 'job_id', p.job_id),
    source_id: requiredString(deps, 'source_id', p.source_id),
    source_item_id: requiredString(deps, 'source_item_id', p.source_item_id),
    chunk_ids: stringArray(deps, 'chunk_ids', p.chunk_ids),
    reason: requiredString(deps, 'reason', p.reason),
    input: optionalString(deps, 'input', p.input),
    prompt: optionalString(deps, 'prompt', p.prompt),
    requested_at: optionalString(deps, 'requested_at', p.requested_at),
  };
}

function rawAccessPolicy(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): RawAccessPolicy {
  const policy = requiredObject(deps, 'policy', value);
  return {
    consent_state: requiredString(deps, 'policy.consent_state', policy.consent_state),
    enabled: optionalBoolean(deps, 'policy.enabled', policy.enabled) ?? true,
    runner_access: optionalString(deps, 'policy.runner_access', policy.runner_access),
    llm_access: optionalString(deps, 'policy.llm_access', policy.llm_access),
    paused_at: optionalNullableString(deps, 'policy.paused_at', policy.paused_at),
  };
}

function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function booleanFromDb(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  return String(value);
}

function dateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function nullableDateString(value: unknown): string | null {
  if (value == null) return null;
  return dateString(value);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return isPlainObject(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  if (isPlainObject(value)) return value as Record<string, unknown>;
  return {};
}

function jsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function jsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
}
