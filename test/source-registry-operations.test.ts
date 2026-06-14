import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createCredentialReference } from '../src/core/connectors/credential-refs.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { type Operation, type OperationContext, operations } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

setDefaultTimeout(Number(process.env.TEST_TIMEOUT_MS ?? 20_000));

const PGLITE_SOURCE_REGISTRY_TEST_TIMEOUT_MS = 60_000;
const AWS_ACCESS_KEY_FIXTURE = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

function getOperation(name: string): Operation {
  const operation = operations.find((candidate) => candidate.name === name);
  if (!operation) throw new Error(`Operation not found: ${name}`);
  return operation;
}

async function createSqliteHarness(label: string): Promise<{
  engine: BrainEngine;
  ctx: (dryRun?: boolean) => OperationContext;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-source-registry-ops-${label}-`));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();
  return {
    engine,
    ctx: (dryRun = false) => ({
      engine,
      config: { engine: 'sqlite', database_path: databasePath },
      logger: console,
      dryRun,
    } as unknown as OperationContext),
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(label: string): Promise<{
  engine: BrainEngine;
  ctx: (dryRun?: boolean) => OperationContext;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-source-registry-ops-${label}-`));
  const databasePath = join(dir, 'brain.pglite');
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  await engine.initSchema();
  return {
    engine,
    ctx: (dryRun = false) => ({
      engine,
      config: { engine: 'pglite', database_path: databasePath },
      logger: console,
      dryRun,
    } as unknown as OperationContext),
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function insertCredentialReference(engine: BrainEngine, id: string): void {
  const ref = createCredentialReference({
    id,
    connector_id: 'gmail',
    account_id: stableTestId('connector-account', 'gmail', 'gmail://me@example.com'),
    provider: 'credential_gateway',
    reference: 'credential-gateway://gmail/primary',
    scopes: ['gmail.readonly'],
    now: '2026-05-22T02:19:00.000Z',
  });
  const db = (engine as any).database;
  db.query(`
    INSERT INTO credential_refs (
      id, connector_id, account_id, provider, reference, scopes_json,
      expires_at, last_used_at, rotation_status, health_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ref.id,
    ref.connector_id,
    ref.account_id,
    ref.provider,
    ref.reference,
    JSON.stringify(ref.scopes),
    ref.expires_at,
    ref.last_used_at,
    ref.rotation_status,
    ref.health_status,
    ref.created_at,
    ref.updated_at,
  );
}

function stableTestId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
}

async function countSourceItemEvents(
  engine: BrainEngine,
  sourceItemId: string,
  eventType: string,
): Promise<number> {
  const candidate = engine as any;
  if (candidate.database) {
    return Number(candidate.database.query(`
      SELECT COUNT(*) AS count
      FROM source_item_events
      WHERE source_item_id = ? AND event_type = ?
    `).get(sourceItemId, eventType).count);
  }
  const rows = candidate.sql?.unsafe
    ? await candidate.sql.unsafe(`
      SELECT COUNT(*) AS count
      FROM source_item_events
      WHERE source_item_id = $1 AND event_type = $2
    `, [sourceItemId, eventType])
    : candidate.db
      ? (await candidate.db.query(`
        SELECT COUNT(*) AS count
        FROM source_item_events
        WHERE source_item_id = $1 AND event_type = $2
      `, [sourceItemId, eventType])).rows
      : null;
  if (!rows) throw new Error('source item event count requires a SQL-backed engine');
  return Number(rows[0]?.count ?? 0);
}

describe('source registry operations', () => {
  test('source-choice operations are exposed with CLI hints', () => {
    expect(getOperation('register_source').cliHints?.name).toBe('source-register');
    expect(getOperation('register_connector_source').cliHints?.name).toBe('connector-register');
    expect(getOperation('ingest_connector_item').cliHints?.name).toBe('connector-ingest-item');
    expect(getOperation('record_connector_sync_success').cliHints?.name).toBe('connector-record-sync-success');
    expect(getOperation('record_connector_item_deletion').cliHints?.name).toBe('connector-record-deletion');
    expect(getOperation('record_connector_failure').cliHints?.name).toBe('connector-record-failure');
    expect(getOperation('list_source_items').cliHints?.name).toBe('source-items');
    expect(getOperation('list_sources').cliHints?.name).toBe('source-list');
    expect(getOperation('get_source').cliHints?.name).toBe('source-get');
    expect(getOperation('register_source').mutating).toBe(true);
    expect(getOperation('ingest_connector_item').mutating).toBe(true);
    expect(getOperation('list_sources').mutating).toBe(false);
  });

  test('preview raw ingest redacts session-capture chunks after raw ingest store extraction', async () => {
    const harness = await createSqliteHarness('raw-store-extraction');
    try {
      const registered = await getOperation('register_source').handler(harness.ctx(), {
        source_kind: 'codex_session',
        display_name: 'Codex Sessions',
        locator: 'codex://sessions',
        consent_state: 'granted',
        now: '2026-06-03T01:00:00.000Z',
      }) as any;

      const preview = await getOperation('preview_raw_ingest').handler(harness.ctx(), {
        source_id: registered.source.id,
        external_id: 'session-1/event-1',
        origin_event: 'session_capture',
        title: 'Agent session event',
        chunk_texts: [`The user pasted AWS key ${AWS_ACCESS_KEY_FIXTURE} and asked to remember a preference.`],
        parser_version: 'agent-session:v1',
        policy: {
          consent_state: 'granted',
          enabled: true,
          raw_copy_mode: 'metadata_chunks',
          automatic_canonical_write_authority: 'candidate',
        },
        now: '2026-06-03T01:01:00.000Z',
      }) as any;

      expect(preview.chunks[0].redacted_text).toContain('[REDACTED:aws_access_key_id]');
      expect(preview.chunks[0].redacted_text).not.toContain(AWS_ACCESS_KEY_FIXTURE);
      expect(preview.secret_detections).toHaveLength(1);
      expect(preview.secret_detections[0].secret_type).toBe('aws_access_key_id');
    } finally {
      await harness.cleanup();
    }
  });

  for (const [label, createHarness] of [
    ['sqlite', createSqliteHarness],
    ['pglite', createPgliteHarness],
  ] as const) {
    const timeoutMs = createHarness === createPgliteHarness
      ? PGLITE_SOURCE_REGISTRY_TEST_TIMEOUT_MS
      : undefined;

    test(`connector source registration persists minimal consent and remains inspectable on ${label}`, async () => {
      const harness = await createHarness(`connector-${label}`);
      try {
        const registered = await getOperation('register_connector_source').handler(harness.ctx(), {
          connector_id: 'gmail',
          display_name: 'Primary Gmail',
          account_locator: 'gmail://me@example.com',
          consent_state: 'granted',
          now: '2026-05-22T02:00:00.000Z',
        }) as any;

        expect(registered.source).toMatchObject({
          kind: 'email',
          connector_id: 'gmail',
          display_name: 'Primary Gmail',
          locator: 'gmail://me@example.com',
          consent_state: 'granted',
          enabled: true,
        });
        expect(registered.connector_account).toMatchObject({
          connector_id: 'gmail',
          source_id: registered.source.id,
          account_locator: 'gmail://me@example.com',
          status: 'active',
        });
        expect(registered.connector_grants.map((grant: any) => [grant.scope, grant.grant_state])).toEqual([
          ['gmail.readonly', 'granted'],
        ]);
        expect(registered.connector_sync_state).toMatchObject({
          connector_id: 'gmail',
          account_id: registered.connector_account.id,
          health_status: 'unknown',
        });

        const listed = await getOperation('list_sources').handler(harness.ctx(), {
          connector_id: 'gmail',
        }) as any;

        expect(listed.sources).toHaveLength(1);
        expect(listed.sources[0]).toMatchObject({
          source: {
            id: registered.source.id,
            connector_id: 'gmail',
            consent_state: 'granted',
          },
          policy: {
            policy: {
              source_kind: 'email',
            },
            processing: {
              can_ingest: true,
            },
          },
          connector_account: {
            id: registered.connector_account.id,
            status: 'active',
          },
          connector_sync_state: {
            health_status: 'unknown',
          },
        });

        const inspected = await getOperation('get_source').handler(harness.ctx(), {
          source_id: registered.source.id,
        }) as any;

        expect(inspected.source.id).toBe(registered.source.id);
        expect(inspected.status_events.map((event: any) => event.event_type)).toEqual(['registered']);
        expect(inspected.connector_grants.map((grant: any) => grant.scope)).toEqual(['gmail.readonly']);
      } finally {
        await harness.cleanup();
      }
    }, timeoutMs);
  }

  test('connector registration without a credential reference is inspectable but not healthy', async () => {
    const harness = await createSqliteHarness('connector-missing-credential');
    try {
      const registered = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'gmail',
        display_name: 'Primary Gmail',
        account_locator: 'gmail://me@example.com',
        consent_state: 'granted',
        now: '2026-05-22T02:10:00.000Z',
      }) as any;

      expect(registered.connector_account.credential_ref_id).toBeNull();
      expect(registered.connector_sync_state.health_status).toBe('unknown');
    } finally {
      await harness.cleanup();
    }
  });

  test('connector registration can persist and inspect credential references without raw DB writes', async () => {
    const harness = await createSqliteHarness('connector-inline-credential');
    try {
      const registered = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'gmail',
        display_name: 'Primary Gmail',
        account_locator: 'gmail://me@example.com',
        consent_state: 'granted',
        credential_ref: {
          provider: 'credential_gateway',
          reference: 'credential-gateway://gmail/primary',
          scopes: ['gmail.readonly'],
          expires_at: '2026-06-22T00:00:00.000Z',
        },
        now: '2026-05-22T02:12:00.000Z',
      }) as any;

      expect(registered.connector_account.credential_ref_id).toBe(registered.credential_ref.id);
      expect(registered.credential_ref).toMatchObject({
        connector_id: 'gmail',
        account_id: registered.connector_account.id,
        provider: 'credential_gateway',
        reference: 'credential-gateway://gmail/primary',
        scopes: ['gmail.readonly'],
        expires_at: '2026-06-22T00:00:00.000Z',
        last_used_at: null,
        rotation_status: 'current',
        health_status: 'healthy',
      });

      const inspected = await getOperation('get_source').handler(harness.ctx(), {
        source_id: registered.source.id,
      }) as any;

      expect(inspected.credential_ref).toMatchObject({
        id: registered.credential_ref.id,
        provider: 'credential_gateway',
        reference: 'credential-gateway://gmail/primary',
        scopes: ['gmail.readonly'],
        health_status: 'healthy',
      });
      expect(JSON.stringify(inspected.credential_ref)).not.toContain('sk-');
      expect(JSON.stringify(inspected.credential_ref)).not.toContain('raw_secret');
    } finally {
      await harness.cleanup();
    }
  });

  test('connector item raw ingest is persisted and inspectable without canonical writes', async () => {
    const harness = await createSqliteHarness('connector-raw-ingest');
    try {
      insertCredentialReference(harness.engine, 'credential-ref:gmail:primary');
      const registered = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'gmail',
        display_name: 'Primary Gmail',
        account_locator: 'gmail://me@example.com',
        consent_state: 'granted',
        credential_ref_id: 'credential-ref:gmail:primary',
        now: '2026-05-22T02:20:00.000Z',
      }) as any;

      const ingested = await getOperation('ingest_connector_item').handler(harness.ctx(), {
        source_id: registered.source.id,
        connector_id: 'gmail',
        external_id: 'message-1',
        locator: 'gmail://message/1',
        title: 'Runtime review',
        body: 'Remember that connector output must stay in raw ingest.',
        now: '2026-05-22T02:21:00.000Z',
      }) as any;

      expect(ingested.status).toBe('ingested');
      expect(ingested.item.raw_copy_mode).toBe('summary_only');
      expect(ingested.item).toMatchObject({
        source_id: registered.source.id,
        external_id: 'message-1',
        origin_event: 'connector_sync',
        locator: 'gmail://message/1',
        title: 'Runtime review',
        metadata_json: {
          connector_id: 'gmail',
        },
      });
      expect(ingested.chunks[0]).toMatchObject({
        source_item_id: ingested.item.id,
        chunk_text: 'Remember that connector output must stay in raw ingest.',
        prompt_injection_risk: 'none',
        secret_risk: 'none',
      });

      const listed = await getOperation('list_source_items').handler(harness.ctx(), {
        source_id: registered.source.id,
        include_chunks: true,
      }) as any;

      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]).toMatchObject({
        external_id: 'message-1',
        chunks: [{
          id: ingested.chunks[0].id,
          chunk_text: 'Remember that connector output must stay in raw ingest.',
        }],
      });

      const skipped = await getOperation('ingest_connector_item').handler(harness.ctx(), {
        source_id: registered.source.id,
        connector_id: 'gmail',
        external_id: 'message-1',
        body: 'Remember that connector output must stay in raw ingest.',
        now: '2026-05-22T02:22:00.000Z',
      }) as any;

      expect(skipped.status).toBe('skipped');
      expect(skipped.reason).toBe('unchanged_content_hash');
    } finally {
      await harness.cleanup();
    }
  });

  test('connector ingest inherits persisted source policy overrides', async () => {
    const harness = await createSqliteHarness('connector-policy-inheritance');
    try {
      insertCredentialReference(harness.engine, 'credential-ref:gmail:primary');
      const registered = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'gmail',
        display_name: 'Primary Gmail',
        account_locator: 'gmail://me@example.com',
        consent_state: 'granted',
        credential_ref_id: 'credential-ref:gmail:primary',
        now: '2026-05-22T03:20:00.000Z',
      }) as any;
      const db = (harness.engine as any).database;
      db.query(`
        UPDATE source_policies
        SET raw_copy_mode = 'metadata_only'
        WHERE source_kind = 'email'
      `).run();
      db.query(`
        INSERT INTO source_policy_overrides (
          id, source_id, dimension, override_value, reason, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'source-policy-override:gmail-raw-copy',
        registered.source.id,
        'raw_copy_mode',
        JSON.stringify('full'),
        'test override',
        'agent:test',
        '2026-05-22T03:21:00.000Z',
      );

      const ingested = await getOperation('ingest_connector_item').handler(harness.ctx(), {
        source_id: registered.source.id,
        connector_id: 'gmail',
        external_id: 'message-policy',
        body: 'Persisted connector policy must shape raw ingest.',
        now: '2026-05-22T03:22:00.000Z',
      }) as any;

      expect(ingested.item.raw_copy_mode).toBe('full');
    } finally {
      await harness.cleanup();
    }
  });

  test('revoked connector source prevents item ingest before raw access', async () => {
    const harness = await createSqliteHarness('connector-revoked-ingest');
    try {
      const registered = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'gmail',
        display_name: 'Primary Gmail',
        account_locator: 'gmail://me@example.com',
        consent_state: 'revoked',
        now: '2026-05-22T03:30:00.000Z',
      }) as any;

      await expect(getOperation('ingest_connector_item').handler(harness.ctx(), {
        source_id: registered.source.id,
        connector_id: 'gmail',
        external_id: 'message-revoked',
        body: 'Should not be ingested.',
        now: '2026-05-22T03:31:00.000Z',
      })).rejects.toThrow('source consent revoked prevents ingest');
    } finally {
      await harness.cleanup();
    }
  });

  test('connector failure records source health event and updates connector sync health', async () => {
    const harness = await createSqliteHarness('connector-failure');
    try {
      const registered = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'gmail',
        display_name: 'Primary Gmail',
        account_locator: 'gmail://me@example.com',
        consent_state: 'granted',
        now: '2026-05-22T03:40:00.000Z',
      }) as any;

      const failure = await getOperation('record_connector_failure').handler(harness.ctx(), {
        source_id: registered.source.id,
        connector_id: 'gmail',
        error_message: 'credential expired',
        now: '2026-05-22T03:41:00.000Z',
      }) as any;

      expect(failure.status).toBe('recorded');
      expect(failure.status_event).toMatchObject({
        source_id: registered.source.id,
        event_type: 'connector_sync_failed',
        reason: 'credential expired',
      });
      const inspected = await getOperation('get_source').handler(harness.ctx(), {
        source_id: registered.source.id,
      }) as any;
      expect(inspected.connector_sync_state).toMatchObject({
        health_status: 'unhealthy',
        failure_count: 1,
        last_error: 'credential expired',
      });
      expect(inspected.status_events.map((event: any) => event.event_type)).toContain('connector_sync_failed');
    } finally {
      await harness.cleanup();
    }
  });

  test('connector sync success persists cursor progress and clears prior failure health', async () => {
    const harness = await createSqliteHarness('connector-sync-success');
    try {
      const registered = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'gmail',
        display_name: 'Primary Gmail',
        account_locator: 'gmail://me@example.com',
        consent_state: 'granted',
        now: '2026-05-22T03:43:00.000Z',
      }) as any;
      await getOperation('record_connector_failure').handler(harness.ctx(), {
        source_id: registered.source.id,
        connector_id: 'gmail',
        error_message: 'temporary provider outage',
        now: '2026-05-22T03:44:00.000Z',
      });

      const success = await getOperation('record_connector_sync_success').handler(harness.ctx(), {
        source_id: registered.source.id,
        connector_id: 'gmail',
        cursor_json: { next_page_token: 'page-2' },
        sync_started_at: '2026-05-22T03:45:00.000Z',
        now: '2026-05-22T03:46:00.000Z',
        ingested_count: 2,
        skipped_count: 1,
      }) as any;

      expect(success.status).toBe('recorded');
      expect(success.connector_sync_state).toMatchObject({
        cursor_json: { next_page_token: 'page-2' },
        last_sync_started_at: '2026-05-22T03:45:00.000Z',
        last_sync_finished_at: '2026-05-22T03:46:00.000Z',
        last_success_at: '2026-05-22T03:46:00.000Z',
        health_status: 'healthy',
        failure_count: 0,
        last_error: null,
        metadata_json: {
          ingested_count: 2,
          skipped_count: 1,
        },
      });

      const inspected = await getOperation('get_source').handler(harness.ctx(), {
        source_id: registered.source.id,
      }) as any;
      expect(inspected.status_events.map((event: any) => event.event_type)).toEqual([
        'registered',
        'connector_sync_failed',
        'connector_sync_succeeded',
      ]);
      expect(inspected.connector_sync_state.cursor_json).toEqual({ next_page_token: 'page-2' });
    } finally {
      await harness.cleanup();
    }
  });

  for (const [label, createHarness] of [
    ['sqlite', createSqliteHarness],
    ['pglite', createPgliteHarness],
  ] as const) {
    const timeoutMs = createHarness === createPgliteHarness
      ? PGLITE_SOURCE_REGISTRY_TEST_TIMEOUT_MS
      : undefined;

    test(`connector item deletion records archive-for-retention event without purging raw item on ${label}`, async () => {
      const harness = await createHarness(`connector-deletion-${label}`);
      try {
        const registered = await getOperation('register_connector_source').handler(harness.ctx(), {
          connector_id: 'calendar',
          display_name: 'Work Calendar',
          account_locator: 'calendar://work',
          consent_state: 'granted',
          now: '2026-05-22T03:50:00.000Z',
        }) as any;
        const ingested = await getOperation('ingest_connector_item').handler(harness.ctx(), {
          source_id: registered.source.id,
          connector_id: 'calendar',
          external_id: 'event-deleted',
          body: 'Event body retained for policy review.',
          now: '2026-05-22T03:51:00.000Z',
        }) as any;

        const deletion = await getOperation('record_connector_item_deletion').handler(harness.ctx(), {
          source_id: registered.source.id,
          connector_id: 'calendar',
          external_id: 'event-deleted',
          deleted_at: '2026-05-22T03:52:00.000Z',
          now: '2026-05-22T03:52:00.000Z',
        }) as any;
        const listed = await getOperation('list_source_items').handler(harness.ctx(), {
          source_id: registered.source.id,
          include_chunks: true,
        }) as any;

        expect(deletion).toMatchObject({
          status: 'recorded',
          action: 'archive_for_retention',
          purge_immediately: false,
          source_item_id: ingested.item.id,
        });
        expect(listed.items[0]).toMatchObject({
          id: ingested.item.id,
          ingest_status: 'ready',
          chunks: [{
            source_item_id: ingested.item.id,
            chunk_text: 'Event body retained for policy review.',
          }],
        });
        await expect(countSourceItemEvents(
          harness.engine,
          ingested.item.id,
          'source_deleted_archived',
        )).resolves.toBe(1);

        const duplicateDeletion = await getOperation('record_connector_item_deletion').handler(harness.ctx(), {
          source_id: registered.source.id,
          connector_id: 'calendar',
          external_id: 'event-deleted',
          deleted_at: '2026-05-22T03:53:00.000Z',
          now: '2026-05-22T03:53:00.000Z',
        }) as any;
        expect(duplicateDeletion).toMatchObject({
          status: 'skipped',
          reason: 'already_archived',
          source_item_id: ingested.item.id,
        });
        await expect(countSourceItemEvents(
          harness.engine,
          ingested.item.id,
          'source_deleted_archived',
        )).resolves.toBe(1);

        const reingested = await getOperation('ingest_connector_item').handler(harness.ctx(), {
          source_id: registered.source.id,
          connector_id: 'calendar',
          external_id: 'event-deleted',
          body: 'Event body retained for policy review.',
          now: '2026-05-22T03:54:00.000Z',
        }) as any;
        expect(reingested).toMatchObject({
          status: 'updated',
          item: {
            id: ingested.item.id,
          },
        });
        await expect(countSourceItemEvents(
          harness.engine,
          ingested.item.id,
          'source_deleted_archived',
        )).resolves.toBe(0);

        const deletionAfterReingest = await getOperation('record_connector_item_deletion').handler(harness.ctx(), {
          source_id: registered.source.id,
          connector_id: 'calendar',
          external_id: 'event-deleted',
          deleted_at: '2026-05-22T03:55:00.000Z',
          now: '2026-05-22T03:55:00.000Z',
        }) as any;
        expect(deletionAfterReingest).toMatchObject({
          status: 'recorded',
          source_item_id: ingested.item.id,
        });
        await expect(countSourceItemEvents(
          harness.engine,
          ingested.item.id,
          'source_deleted_archived',
        )).resolves.toBe(1);
      } finally {
        await harness.cleanup();
      }
    }, timeoutMs);
  }

  test('connector item deletion respects revoked source policy before archive mutation', async () => {
    const harness = await createSqliteHarness('connector-deletion-revoked');
    try {
      const registered = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'calendar',
        display_name: 'Work Calendar',
        account_locator: 'calendar://work',
        consent_state: 'granted',
        now: '2026-05-22T04:00:00.000Z',
      }) as any;
      const ingested = await getOperation('ingest_connector_item').handler(harness.ctx(), {
        source_id: registered.source.id,
        connector_id: 'calendar',
        external_id: 'event-revoked',
        body: 'Event body retained for policy review.',
        now: '2026-05-22T04:01:00.000Z',
      }) as any;
      await getOperation('revoke_source_consent').handler(harness.ctx(), {
        source_id: registered.source.id,
        reason: 'operator revoked connector consent',
        now: '2026-05-22T04:02:00.000Z',
      });

      await expect(getOperation('record_connector_item_deletion').handler(harness.ctx(), {
        source_id: registered.source.id,
        connector_id: 'calendar',
        external_id: 'event-revoked',
        deleted_at: '2026-05-22T04:03:00.000Z',
        now: '2026-05-22T04:03:00.000Z',
      })).rejects.toThrow('source policy prevents connector deletion/archive');

      const db = (harness.engine as any).database;
      expect(db.query('SELECT COUNT(*) AS count FROM source_item_events WHERE source_item_id = ? AND event_type = ?').get(
        ingested.item.id,
        'source_deleted_archived',
      ).count).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  test('connector item deletion respects paused source policy before archive mutation', async () => {
    const harness = await createSqliteHarness('connector-deletion-paused');
    try {
      const registered = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'calendar',
        display_name: 'Work Calendar',
        account_locator: 'calendar://work',
        consent_state: 'granted',
        now: '2026-05-22T04:10:00.000Z',
      }) as any;
      const ingested = await getOperation('ingest_connector_item').handler(harness.ctx(), {
        source_id: registered.source.id,
        connector_id: 'calendar',
        external_id: 'event-paused',
        body: 'Event body retained for policy review.',
        now: '2026-05-22T04:11:00.000Z',
      }) as any;
      await getOperation('pause_source_processing').handler(harness.ctx(), {
        source_id: registered.source.id,
        reason: 'operator paused connector processing',
        now: '2026-05-22T04:12:00.000Z',
      });

      await expect(getOperation('record_connector_item_deletion').handler(harness.ctx(), {
        source_id: registered.source.id,
        connector_id: 'calendar',
        external_id: 'event-paused',
        deleted_at: '2026-05-22T04:13:00.000Z',
        now: '2026-05-22T04:13:00.000Z',
      })).rejects.toThrow('source policy prevents connector deletion/archive');

      const db = (harness.engine as any).database;
      expect(db.query('SELECT COUNT(*) AS count FROM source_item_events WHERE source_item_id = ? AND event_type = ?').get(
        ingested.item.id,
        'source_deleted_archived',
      ).count).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });

  test('connector item raw ingest persists on the Postgres-compatible SQL path', async () => {
    const harness = await createPgliteHarness('connector-raw-ingest-pglite');
    try {
      const registered = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'calendar',
        display_name: 'Work Calendar',
        account_locator: 'calendar://work',
        consent_state: 'granted',
        now: '2026-05-22T02:40:00.000Z',
      }) as any;

      const ingested = await getOperation('ingest_connector_item').handler(harness.ctx(), {
        source_id: registered.source.id,
        connector_id: 'calendar',
        external_id: 'event-1',
        title: 'Runtime review',
        body: 'Runtime review with connector persistence follow-up.',
        now: '2026-05-22T02:41:00.000Z',
      }) as any;

      const listed = await getOperation('list_source_items').handler(harness.ctx(), {
        source_id: registered.source.id,
        include_chunks: true,
      }) as any;

      expect(ingested.status).toBe('ingested');
      expect(listed.items[0]).toMatchObject({
        external_id: 'event-1',
        chunks: [{
          source_item_id: ingested.item.id,
          chunk_text: 'Runtime review with connector persistence follow-up.',
        }],
      });
    } finally {
      await harness.cleanup();
    }
  }, PGLITE_SOURCE_REGISTRY_TEST_TIMEOUT_MS);

  test('generic source registration persists source status history for inspection', async () => {
    const harness = await createSqliteHarness('generic');
    try {
      const registered = await getOperation('register_source').handler(harness.ctx(), {
        source_kind: 'markdown_file',
        display_name: 'Workspace Notes',
        locator: 'file:///workspace/notes',
        consent_state: 'granted',
        now: '2026-05-22T02:30:00.000Z',
      }) as any;

      const inspected = await getOperation('get_source').handler(harness.ctx(), {
        source_id: registered.source.id,
      }) as any;

      expect(inspected.source).toMatchObject({
        id: registered.source.id,
        kind: 'markdown_file',
        locator: 'file:///workspace/notes',
        consent_state: 'granted',
        enabled: true,
      });
      expect(inspected.policy.processing.can_ingest).toBe(true);
      expect(inspected.status_events[0]).toMatchObject({
        source_id: registered.source.id,
        event_type: 'registered',
        next_state: 'granted',
      });
    } finally {
      await harness.cleanup();
    }
  });

  test('source inspection uses persisted policy data and active overrides', async () => {
    const harness = await createSqliteHarness('persisted-policy');
    try {
      const registered = await getOperation('register_source').handler(harness.ctx(), {
        source_kind: 'email',
        display_name: 'Policy-backed Email',
        locator: 'email://policy-backed',
        consent_state: 'granted',
        now: '2026-05-22T03:00:00.000Z',
      }) as any;
      const db = (harness.engine as any).database;
      db.query(`
        UPDATE source_policies
        SET raw_copy_mode = 'metadata_only'
        WHERE source_kind = 'email'
      `).run();
      db.query(`
        INSERT INTO source_policy_overrides (
          id, source_id, dimension, override_value, reason, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'source-policy-override:email-raw-copy',
        registered.source.id,
        'raw_copy_mode',
        JSON.stringify('full'),
        'test override',
        'agent:test',
        '2026-05-22T03:01:00.000Z',
      );
      db.query(`
        INSERT INTO source_policy_overrides (
          id, source_id, dimension, override_value, reason, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'source-policy-override:email-llm-access',
        registered.source.id,
        'llm_access',
        JSON.stringify('none_unless_requested'),
        'test processing override',
        'agent:test',
        '2026-05-22T03:02:00.000Z',
      );

      const inspected = await getOperation('get_source').handler(harness.ctx(), {
        source_id: registered.source.id,
      }) as any;

      expect(inspected.source.policy_id).toBe(registered.source.policy_id);
      expect(inspected.policy_storage.persisted_policy).toMatchObject({
        id: registered.source.policy_id,
        source_kind: 'email',
        raw_copy_mode: 'metadata_only',
      });
      expect(inspected.policy_storage.active_overrides).toEqual([{
        dimension: 'raw_copy_mode',
        value: 'full',
      }, {
        dimension: 'llm_access',
        value: 'none_unless_requested',
      }]);
      expect(inspected.policy.policy.raw_copy_mode).toBe('full');
      expect(inspected.policy.processing.can_use_llm).toBe(false);
      expect(inspected.policy.applied_overrides).toEqual(['raw_copy_mode', 'llm_access']);
    } finally {
      await harness.cleanup();
    }
  });

  test('connector registration validates credential reference connector ownership', async () => {
    const harness = await createSqliteHarness('connector-credential-mismatch');
    try {
      const ref = createCredentialReference({
        id: 'credential-ref:calendar:work',
        connector_id: 'calendar',
        account_id: 'connector-account:calendar:work',
        provider: 'credential_gateway',
        reference: 'credential-gateway://calendar/work',
        scopes: ['calendar.readonly'],
        now: '2026-05-22T04:00:00.000Z',
      });
      const db = (harness.engine as any).database;
      db.query(`
        INSERT INTO credential_refs (
          id, connector_id, account_id, provider, reference, scopes_json,
          expires_at, last_used_at, rotation_status, health_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ref.id,
        ref.connector_id,
        ref.account_id,
        ref.provider,
        ref.reference,
        JSON.stringify(ref.scopes),
        ref.expires_at,
        ref.last_used_at,
        ref.rotation_status,
        ref.health_status,
        ref.created_at,
        ref.updated_at,
      );

      await expect(getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'gmail',
        display_name: 'Primary Gmail',
        account_locator: 'gmail://me@example.com',
        consent_state: 'granted',
        credential_ref_id: ref.id,
        now: '2026-05-22T04:01:00.000Z',
      })).rejects.toThrow('credential_ref_id is registered for calendar, not gmail');
    } finally {
      await harness.cleanup();
    }
  });

  test('connector registration refuses unhealthy credential references before claiming healthy sync', async () => {
    const harness = await createSqliteHarness('connector-credential-health');
    try {
      const ref = createCredentialReference({
        id: 'credential-ref:gmail:expired',
        connector_id: 'gmail',
        account_id: stableTestId('connector-account', 'gmail', 'gmail://me@example.com'),
        provider: 'credential_gateway',
        reference: 'credential-gateway://gmail/expired',
        scopes: ['gmail.readonly'],
        health_status: 'expired',
        now: '2026-05-22T04:05:00.000Z',
      });
      const db = (harness.engine as any).database;
      db.query(`
        INSERT INTO credential_refs (
          id, connector_id, account_id, provider, reference, scopes_json,
          expires_at, last_used_at, rotation_status, health_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ref.id,
        ref.connector_id,
        ref.account_id,
        ref.provider,
        ref.reference,
        JSON.stringify(ref.scopes),
        ref.expires_at,
        ref.last_used_at,
        ref.rotation_status,
        ref.health_status,
        ref.created_at,
        ref.updated_at,
      );

      await expect(getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'gmail',
        display_name: 'Primary Gmail',
        account_locator: 'gmail://me@example.com',
        consent_state: 'granted',
        credential_ref_id: ref.id,
        now: '2026-05-22T04:06:00.000Z',
      })).rejects.toThrow('credential_ref_id health_status must be healthy, got expired');
    } finally {
      await harness.cleanup();
    }
  });

  test('source item inspection lists non-ready ingest statuses', async () => {
    const harness = await createSqliteHarness('source-item-statuses');
    try {
      const registered = await getOperation('register_source').handler(harness.ctx(), {
        source_kind: 'markdown_file',
        display_name: 'Workspace Notes',
        locator: 'file:///workspace/statuses',
        consent_state: 'granted',
        now: '2026-05-22T04:10:00.000Z',
      }) as any;
      const db = (harness.engine as any).database;
      db.query(`
        INSERT INTO source_items (
          id, source_id, external_id, origin_event, content_hash, raw_copy_mode, ingest_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'source-item:failed-status',
        registered.source.id,
        'failed-item',
        'manual_entry',
        'hash',
        'metadata_chunks',
        'failed',
      );

      const listed = await getOperation('list_source_items').handler(harness.ctx(), {
        source_id: registered.source.id,
      }) as any;

      expect(listed.items[0].ingest_status).toBe('failed');
    } finally {
      await harness.cleanup();
    }
  });

  test('register source and connector source are idempotent for identical retries', async () => {
    const harness = await createSqliteHarness('source-idempotence');
    try {
      const firstSource = await getOperation('register_source').handler(harness.ctx(), {
        source_kind: 'markdown_file',
        display_name: 'Workspace Notes',
        locator: 'file:///workspace/idempotent',
        consent_state: 'granted',
        now: '2026-05-22T04:20:00.000Z',
      }) as any;
      const secondSource = await getOperation('register_source').handler(harness.ctx(), {
        source_kind: 'markdown_file',
        display_name: 'Workspace Notes',
        locator: 'file:///workspace/idempotent',
        consent_state: 'granted',
        now: '2026-05-22T04:21:00.000Z',
      }) as any;

      expect(secondSource.status).toBe('already_registered');
      expect(secondSource.source.id).toBe(firstSource.source.id);

      const firstConnector = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'calendar',
        display_name: 'Work Calendar',
        account_locator: 'calendar://work/idempotent',
        consent_state: 'granted',
        now: '2026-05-22T04:22:00.000Z',
      }) as any;
      const secondConnector = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'calendar',
        display_name: 'Work Calendar',
        account_locator: 'calendar://work/idempotent',
        consent_state: 'granted',
        now: '2026-05-22T04:23:00.000Z',
      }) as any;

      expect(secondConnector.status).toBe('already_registered');
      expect(secondConnector.source.id).toBe(firstConnector.source.id);
      expect(secondConnector.connector_account.id).toBe(firstConnector.connector_account.id);
    } finally {
      await harness.cleanup();
    }
  });

  test('list_sources can filter connector sources by exact locator', async () => {
    const harness = await createSqliteHarness('connector-locator-filter');
    try {
      const first = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'meeting_transcripts',
        display_name: 'Meeting Transcripts: one',
        account_locator: 'file:///tmp/meetings/one',
        consent_state: 'granted',
        now: '2026-06-14T00:00:00.000Z',
      }) as any;
      await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'meeting_transcripts',
        display_name: 'Meeting Transcripts: two',
        account_locator: 'file:///tmp/meetings/two',
        consent_state: 'revoked',
        now: '2026-06-14T00:01:00.000Z',
      });

      const listed = await getOperation('list_sources').handler(harness.ctx(), {
        connector_id: 'meeting_transcripts',
        locator: 'file:///tmp/meetings/one',
      }) as any;

      expect(listed.sources).toHaveLength(1);
      expect(listed.sources[0].source.id).toBe(first.source.id);
    } finally {
      await harness.cleanup();
    }
  });

  test('list_sources can filter overlapping blocked connector sources before applying limit', async () => {
    const harness = await createSqliteHarness('connector-locator-overlap-blocked-filter');
    try {
      const blocked = await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'meeting_transcripts',
        display_name: 'Meeting Transcripts: blocked child',
        account_locator: 'file:///tmp/meetings/blocked/child.md',
        consent_state: 'revoked',
        now: '2026-06-14T00:00:00.000Z',
      }) as any;
      await getOperation('register_connector_source').handler(harness.ctx(), {
        connector_id: 'meeting_transcripts',
        display_name: 'Meeting Transcripts: unrelated granted',
        account_locator: 'file:///tmp/meetings/unrelated.md',
        consent_state: 'granted',
        now: '2026-06-14T00:01:00.000Z',
      });

      const listed = await getOperation('list_sources').handler(harness.ctx(), {
        connector_id: 'meeting_transcripts',
        locator_overlap: 'file:///tmp/meetings/blocked',
        blocked_for_ingest: true,
        limit: 1,
      }) as any;

      expect(listed.sources).toHaveLength(1);
      expect(listed.sources[0].source.id).toBe(blocked.source.id);
    } finally {
      await harness.cleanup();
    }
  });
});
