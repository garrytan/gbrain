import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { SCHEMA_SQL } from '../src/core/schema-embedded.ts';
import {
  CREDENTIAL_PROVIDER_PRIORITY,
  createCredentialReference,
  selectCredentialProvider,
} from '../src/core/connectors/credential-refs.ts';

const now = '2026-05-22T00:00:00.000Z';

describe('connector credential references', () => {
  test('schema declares credential and connector account tables without raw secret columns', () => {
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS credential_refs');
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS connector_accounts');
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS connector_grants');
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS connector_sync_states');
    expect(SCHEMA_SQL).not.toContain('raw_secret');
    expect(SCHEMA_SQL).not.toContain('credential_secret');
  });

  test('credential reference stores provider metadata without raw secret material', () => {
    const ref = createCredentialReference({
      connector_id: 'gmail',
      account_id: 'connector-account:gmail:primary',
      provider: 'credential_gateway',
      reference: 'credential-gateway://gmail/primary',
      scopes: ['gmail.readonly'],
      expires_at: '2026-06-22T00:00:00.000Z',
      now,
    });

    expect(ref).toMatchObject({
      connector_id: 'gmail',
      account_id: 'connector-account:gmail:primary',
      provider: 'credential_gateway',
      reference: 'credential-gateway://gmail/primary',
      scopes: ['gmail.readonly'],
      rotation_status: 'current',
      health_status: 'healthy',
      created_at: now,
      updated_at: now,
    });
    expect(JSON.stringify(ref)).not.toContain('sk-');
    expect(JSON.stringify(ref)).not.toContain('secret');
  });

  test('credential reference rejects raw secret-looking values', () => {
    expect(() => createCredentialReference({
      connector_id: 'gmail',
      account_id: 'connector-account:gmail:primary',
      provider: 'credential_gateway',
      reference: 'sk-test1234567890abcdef',
      scopes: ['gmail.readonly'],
      now,
    })).toThrow('credential reference must use an external provider URI');

    expect(() => createCredentialReference({
      connector_id: 'gmail',
      account_id: 'connector-account:gmail:primary',
      provider: 'os_keychain',
      reference: 'credential-gateway://gmail/primary',
      scopes: ['gmail.readonly'],
      now,
    })).toThrow('credential provider os_keychain requires reference prefix');
  });

  test('credential provider priority prefers broker before local fallbacks', () => {
    expect(CREDENTIAL_PROVIDER_PRIORITY).toEqual([
      'credential_gateway',
      'os_keychain',
      'password_manager',
      'local_encrypted_vault',
    ]);
    expect(selectCredentialProvider(['local_encrypted_vault', 'os_keychain'])).toBe('os_keychain');
    expect(selectCredentialProvider(['password_manager', 'credential_gateway'])).toBe('credential_gateway');
  });

  test('connector migration installs raw ingest substrate for existing databases', () => {
    const migrationSource = readFileSync(new URL('../src/core/migrate.ts', import.meta.url), 'utf-8');
    const sqliteSource = readFileSync(new URL('../src/core/sqlite-engine.ts', import.meta.url), 'utf-8');
    const migration = migrationSource.slice(
      migrationSource.indexOf("name: 'personal_data_connector_foundations'"),
      migrationSource.indexOf('export const LATEST_VERSION'),
    );
    const sqliteConnectorSchema = sqliteSource.slice(
      sqliteSource.indexOf('private ensureConnectorSchema'),
      sqliteSource.indexOf('private ensureMaintenanceRuntimeSchema'),
    );

    for (const source of [migration, sqliteConnectorSchema]) {
      expect(source).toContain('CREATE TABLE IF NOT EXISTS sources');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS source_policies');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS source_policy_overrides');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS source_authority_rules');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS source_retention_rules');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS source_llm_rules');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS source_status_events');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS source_items');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS source_chunks');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS source_item_events');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS secret_detections');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS prompt_injection_flags');
      expect(source).toContain('CREATE TABLE IF NOT EXISTS ingest_attempts');
    }
  });
});
