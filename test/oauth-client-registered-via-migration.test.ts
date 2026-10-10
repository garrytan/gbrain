/**
 * #6202 migration ladder for `oauth_clients.registered_via` (PGLite; the
 * Postgres arm is test/e2e/oauth-client-registered-via-postgres.test.ts):
 * fresh bootstrap, rows that exist before the migration stay NULL (read-only
 * consent), a repeated migration is a no-op, an old server's insert after the
 * migration stays NULL, and a new server before the migration still registers
 * DCR clients through the undefined-column fallback with no picker.
 *
 * R3/R4: one engine per describe in beforeAll, disconnect in afterAll.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { TEST_PKCE_CHALLENGE } from './helpers/oauth.ts';

const REDIRECT = 'https://dcr-client.example.com/callback';
const migration = MIGRATIONS.find(m => m.name === 'oauth_client_registered_via')!;

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  provider = new GBrainOAuthProvider({
    sql: sqlQueryForEngine(engine),
    transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))),
  });
}, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 15_000);

const registerDcr = async () => (await provider.clientsStore.registerClient!({
  client_name: 'ladder-example', redirect_uris: [REDIRECT], grant_types: ['authorization_code'], scope: 'read', token_endpoint_auth_method: 'none',
} as never)).client_id;
const marker = async (clientId: string) => (await engine.executeRaw<{ registered_via?: string | null }>(
  'SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]))[0]!.registered_via;
const editable = async (clientId: string) => provider.grants.details(await provider.grants.begin(clientId, {
  codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: REDIRECT, scopes: ['read'],
})).sourceChoice.editable;
const hasColumn = async () => (await engine.executeRaw(
  `SELECT 1 FROM information_schema.columns WHERE table_name = 'oauth_clients' AND column_name = 'registered_via'`)).length === 1;
const oldServerInsert = (clientId: string) => engine.executeRaw(
  `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method, client_id_issued_at, source_id, federated_read)
   VALUES ($1, 'old-server-example', ARRAY[$2], ARRAY['authorization_code'], 'read', 'none', 0, 'default', ARRAY['default'])`, [clientId, REDIRECT]);

describe('oauth_client_registered_via migration (#6202)', () => {
  test('is registered, idempotent, and constrains the value to dcr', async () => {
    expect(migration).toBeDefined();
    expect(migration.idempotent).toBe(true);
    expect(await hasColumn()).toBe(true);
    await oldServerInsert('constraint-example');
    await expect(engine.executeRaw(`UPDATE oauth_clients SET registered_via = 'operator' WHERE client_id = 'constraint-example'`)).rejects.toThrow();
  });

  test('fresh bootstrap: a DCR registration is marked and its first consent is editable', async () => {
    const clientId = await registerDcr();
    expect(await marker(clientId)).toBe('dcr');
    expect(await editable(clientId)).toBe(true);
  });

  test('new server before the migration: DCR falls back to the unmarked insert and consent stays read-only', async () => {
    await engine.executeRaw('ALTER TABLE oauth_clients DROP COLUMN registered_via');
    try {
      const clientId = await registerDcr();
      expect(await marker(clientId)).toBeUndefined();
      expect(await editable(clientId)).toBe(false);
      await oldServerInsert('pre-migration-example');
    } finally {
      await engine.executeRaw(migration.sql);
    }
    expect(await hasColumn()).toBe(true);
  });

  test('rows from before the migration stay NULL and read-only; a repeat run changes nothing', async () => {
    expect(await marker('pre-migration-example')).toBeNull();
    expect(await editable('pre-migration-example')).toBe(false);
    await engine.executeRaw(migration.sql);
    expect(await marker('pre-migration-example')).toBeNull();
  });

  test('the runner applies it on an upgraded brain whose version predates it', async () => {
    await engine.executeRaw('ALTER TABLE oauth_clients DROP COLUMN registered_via');
    await engine.setConfig('version', String(migration.version - 1));
    await engine.initSchema();
    expect(await hasColumn()).toBe(true);
    expect(Number(await engine.getConfig('version'))).toBeGreaterThanOrEqual(migration.version);
  });

  test('an old server inserting after the migration leaves the marker NULL, so consent is read-only', async () => {
    await oldServerInsert('old-server-after-example');
    expect(await marker('old-server-after-example')).toBeNull();
    expect(await editable('old-server-after-example')).toBe(false);
  });
});
