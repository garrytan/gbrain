import { describe, expect, test } from 'bun:test';
import {
  CONNECTOR_CLASSES,
  getConnectorDefinition,
} from '../src/core/connectors/connector-registry.ts';
import { createCredentialReference } from '../src/core/connectors/credential-refs.ts';
import {
  createPersonalDataConnectorService,
  type ConnectorSourceItem,
} from '../src/core/services/personal-data-connector-service.ts';
import { resolveSourceRegistryPolicy } from '../src/core/services/source-registry-service.ts';

const now = '2026-05-22T00:00:00.000Z';

describe('personal data connector service', () => {
  test('connector registry supports every planned personal source class', () => {
    expect(CONNECTOR_CLASSES).toEqual([
      'agent_session_import',
      'filesystem_markdown_documents',
      'pdf_document_import',
      'meeting_transcripts',
      'code_repositories',
      'email',
      'calendar',
      'browser_bookmarks_history',
      'chat_exports',
      'slack_discord',
      'generic_archive_import',
    ]);
    expect(getConnectorDefinition('gmail')).toMatchObject({
      id: 'gmail',
      class: 'email',
      source_kind: 'email',
    });
  });

  test('connector registers source and inherits source policy', () => {
    const service = createPersonalDataConnectorService({ now: () => now });
    const registration = service.registerConnectorSource({
      connector_id: 'gmail',
      display_name: 'Primary Gmail',
      account_locator: 'gmail://me@example.com',
      consent_state: 'granted',
    });

    expect(registration.source).toMatchObject({
      kind: 'email',
      connector_id: 'gmail',
      display_name: 'Primary Gmail',
      locator: 'gmail://me@example.com',
      consent_state: 'granted',
      enabled: true,
    });
    expect(registration.policy.policy).toMatchObject(
      resolveSourceRegistryPolicy({
        source_kind: 'email',
        consent_state: 'granted',
        enabled: true,
      }).policy,
    );
    expect(registration.status_events[0]).toMatchObject({
      event_type: 'registered',
      next_state: 'granted',
    });
  });

  test('sync is idempotent by external id and content hash', () => {
    const service = createPersonalDataConnectorService({ now: () => now });
    const source = service.registerConnectorSource({
      connector_id: 'gmail',
      display_name: 'Primary Gmail',
      account_locator: 'gmail://me@example.com',
      consent_state: 'granted',
    }).source;
    const credential = createCredentialReference({
      connector_id: 'gmail',
      account_id: 'connector-account:gmail:primary',
      provider: 'credential_gateway',
      reference: 'credential-gateway://gmail/primary',
      scopes: ['gmail.readonly'],
      now,
    });
    const items: ConnectorSourceItem[] = [{
      external_id: 'message-1',
      locator: 'gmail://message/1',
      title: 'Launch notes',
      body: 'Remember that the launch notes moved to the Postgres runtime tracker.',
      updated_at: '2026-05-21T12:00:00.000Z',
    }];

    const first = service.syncConnector({
      connector_id: 'gmail',
      source,
      credential,
      loadItems: () => items,
    });
    const second = service.syncConnector({
      connector_id: 'gmail',
      source,
      credential,
      loadItems: () => items,
      existing_items: first.raw_ingest_plans.map((plan) => plan.item),
    });

    expect(first.raw_ingest_plans).toHaveLength(1);
    expect(second.raw_ingest_plans).toHaveLength(0);
    expect(second.skipped_external_ids).toEqual(['message-1']);
    expect(first.raw_ingest_plans[0]?.item.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('connector item becomes source item and chunks through raw ingest', () => {
    const service = createPersonalDataConnectorService({ now: () => now });
    const source = service.registerConnectorSource({
      connector_id: 'calendar',
      display_name: 'Work Calendar',
      account_locator: 'calendar://work',
      consent_state: 'granted',
    }).source;
    const credential = createCredentialReference({
      connector_id: 'calendar',
      account_id: 'connector-account:calendar:work',
      provider: 'os_keychain',
      reference: 'keychain://mbrain/calendar/work',
      scopes: ['calendar.readonly'],
      now,
    });

    const result = service.syncConnector({
      connector_id: 'calendar',
      source,
      credential,
      loadItems: () => [{
        external_id: 'event-1',
        locator: 'calendar://event/1',
        title: 'Runtime review',
        body: 'Runtime review with DB migration follow-up.',
      }],
    });

    expect(result.raw_ingest_plans[0]?.item).toMatchObject({
      source_id: source.id,
      external_id: 'event-1',
      origin_event: 'connector_sync',
      locator: 'calendar://event/1',
      title: 'Runtime review',
    });
    expect(result.raw_ingest_plans[0]?.chunks[0]).toMatchObject({
      source_item_id: result.raw_ingest_plans[0]?.item.id,
      chunk_text: 'Runtime review with DB migration follow-up.',
      prompt_injection_risk: 'none',
      secret_risk: 'none',
    });
  });

  test('sync rejects preloaded connector data so authorization gates provider access', () => {
    const service = createPersonalDataConnectorService({ now: () => now });
    const source = service.registerConnectorSource({
      connector_id: 'gmail',
      display_name: 'Primary Gmail',
      account_locator: 'gmail://me@example.com',
      consent_state: 'granted',
    }).source;
    const credential = createCredentialReference({
      connector_id: 'gmail',
      account_id: 'connector-account:gmail:primary',
      provider: 'credential_gateway',
      reference: 'credential-gateway://gmail/primary',
      scopes: ['gmail.readonly'],
      now,
    });

    expect(() => service.syncConnector({
      connector_id: 'gmail',
      source,
      credential,
      items: [{
        external_id: 'message-1',
        body: 'Already fetched before authorization.',
      }],
    } as unknown as Parameters<typeof service.syncConnector>[0])).toThrow('connector sync requires loadItems so authorization gates provider access');
  });

  test('sync requires an item loader instead of falling through to a runtime TypeError', () => {
    const service = createPersonalDataConnectorService({ now: () => now });
    const source = service.registerConnectorSource({
      connector_id: 'gmail',
      display_name: 'Primary Gmail',
      account_locator: 'gmail://me@example.com',
      consent_state: 'granted',
    }).source;
    const credential = createCredentialReference({
      connector_id: 'gmail',
      account_id: 'connector-account:gmail:primary',
      provider: 'credential_gateway',
      reference: 'credential-gateway://gmail/primary',
      scopes: ['gmail.readonly'],
      now,
    });

    expect(() => service.syncConnector({
      connector_id: 'gmail',
      source,
      credential,
    } as unknown as Parameters<typeof service.syncConnector>[0])).toThrow('connector sync requires loadItems so authorization gates provider access');
  });

  test('revoked source prevents sync before connector access', () => {
    const service = createPersonalDataConnectorService({ now: () => now });
    const source = service.registerConnectorSource({
      connector_id: 'slack',
      display_name: 'Team Slack',
      account_locator: 'slack://workspace/team',
      consent_state: 'revoked',
    }).source;
    const credential = createCredentialReference({
      connector_id: 'slack',
      account_id: 'connector-account:slack:team',
      provider: 'credential_gateway',
      reference: 'credential-gateway://slack/team',
      scopes: ['channels.history'],
      now,
    });
    let loadCalled = false;

    expect(() => service.syncConnector({
      connector_id: 'slack',
      source,
      credential,
      loadItems: () => {
        loadCalled = true;
        return [{
          external_id: 'message-1',
          body: 'Should not be read.',
        }];
      },
    })).toThrow('source consent revoked prevents connector sync');
    expect(loadCalled).toBe(false);
  });

  test('granted source loads connector items only after sync authorization', () => {
    const service = createPersonalDataConnectorService({ now: () => now });
    const source = service.registerConnectorSource({
      connector_id: 'slack',
      display_name: 'Team Slack',
      account_locator: 'slack://workspace/team',
      consent_state: 'granted',
    }).source;
    const credential = createCredentialReference({
      connector_id: 'slack',
      account_id: 'connector-account:slack:team',
      provider: 'credential_gateway',
      reference: 'credential-gateway://slack/team',
      scopes: ['channels.history'],
      now,
    });
    let loadCalled = false;

    const result = service.syncConnector({
      connector_id: 'slack',
      source,
      credential,
      loadItems: () => {
        loadCalled = true;
        return [{
          external_id: 'message-1',
          body: 'Loaded after consent check.',
        }];
      },
    });

    expect(loadCalled).toBe(true);
    expect(result.raw_ingest_plans[0]?.item.external_id).toBe('message-1');
  });

  test('connector failure records source health event without source mutation', () => {
    const service = createPersonalDataConnectorService({ now: () => now });
    const source = service.registerConnectorSource({
      connector_id: 'browser_history',
      display_name: 'Browser History',
      account_locator: 'browser://profile/default',
      consent_state: 'granted',
    }).source;

    const event = service.recordConnectorFailure({
      source,
      connector_id: 'browser_history',
      error: new Error('profile locked'),
    });

    expect(event).toMatchObject({
      source_id: source.id,
      event_type: 'connector_sync_failed',
      previous_state: 'granted',
      next_state: 'granted',
      reason: 'profile locked',
      metadata_json: {
        connector_id: 'browser_history',
        health_status: 'unhealthy',
      },
    });
    expect(source.consent_state).toBe('granted');
  });

  test('source deletion maps to retention policy instead of silent purge', () => {
    const service = createPersonalDataConnectorService({ now: () => now });
    const source = service.registerConnectorSource({
      connector_id: 'generic_archive',
      display_name: 'Archive Import',
      account_locator: 'archive://import/2026-05',
      consent_state: 'granted',
    }).source;

    const deletion = service.planSourceDeletion({
      source,
      external_id: 'archive-item-1',
      content_hash: 'sha256:old',
      deleted_at: '2026-05-22T01:00:00.000Z',
    });

    expect(deletion).toMatchObject({
      source_id: source.id,
      external_id: 'archive-item-1',
      action: 'archive_for_retention',
      retention_policy: 'manual_purge_review',
      purge_immediately: false,
    });
  });
});
