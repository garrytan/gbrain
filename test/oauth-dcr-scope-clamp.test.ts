/**
 * DCR scope-clamp security test (src/core/oauth-provider.ts registerClient).
 *
 * A self-registered PUBLIC client (token_endpoint_auth_method='none', PKCE-only
 * — the surface a browser/agent registers without operator review) must NEVER
 * be able to grant itself `write` or `admin`. registerClient clamps its scope
 * to `read`. Confidential DCR clients keep their requested scope, and admin-
 * minted clients (registerClientManual) are unaffected.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';

let db: PGlite;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;
let provider: GBrainOAuthProvider;
// Second provider with the Google login gate ENABLED — exercises the
// CRITICAL-1 DCR hardening path. Shares the same DB.
let gatedProvider: GBrainOAuthProvider;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows;
  };
  provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
  gatedProvider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300, loginGateEnabled: true });
}, 30_000);

afterAll(async () => {
  if (db) await db.close();
}, 15_000);

async function storedScope(clientId: string): Promise<string> {
  const rows = await sql`SELECT scope FROM oauth_clients WHERE client_id = ${clientId}`;
  return rows[0].scope as string;
}

async function storedRow(
  clientId: string,
): Promise<{ scope: string; grant_types: string[]; token_endpoint_auth_method: string; client_secret_hash: string | null }> {
  const rows = await sql`
    SELECT scope, grant_types, token_endpoint_auth_method, client_secret_hash
    FROM oauth_clients WHERE client_id = ${clientId}
  `;
  return rows[0];
}

describe('DCR scope clamp (registerClient)', () => {
  test('public client (none) requesting "read write admin" is clamped to "read"', async () => {
    const reg = await provider.clientsStore.registerClient!({
      client_name: 'browser-dcr',
      redirect_uris: ['https://app.example.com/callback'],
      grant_types: ['authorization_code'],
      scope: 'read write admin',
      token_endpoint_auth_method: 'none',
    } as any);
    expect(reg.scope).toBe('read');
    expect(await storedScope(reg.client_id)).toBe('read');
    // Public client: no secret issued.
    expect(reg.client_secret).toBeUndefined();
  });

  test('public client (none) requesting "write" is clamped to "read"', async () => {
    const reg = await provider.clientsStore.registerClient!({
      client_name: 'browser-dcr-2',
      redirect_uris: ['https://app.example.com/cb'],
      grant_types: ['authorization_code'],
      scope: 'write',
      token_endpoint_auth_method: 'none',
    } as any);
    expect(reg.scope).toBe('read');
    expect(await storedScope(reg.client_id)).toBe('read');
  });

  test('confidential DCR client keeps its requested scope (not clamped)', async () => {
    const reg = await provider.clientsStore.registerClient!({
      client_name: 'confidential-dcr',
      redirect_uris: ['https://app.example.com/cb'],
      grant_types: ['authorization_code'],
      scope: 'read write',
      token_endpoint_auth_method: 'client_secret_post',
    } as any);
    expect(reg.scope).toBe('read write');
    expect(await storedScope(reg.client_id)).toBe('read write');
    // Confidential client: secret issued.
    expect(typeof reg.client_secret).toBe('string');
  });

  test('admin-minted client (registerClientManual) is unaffected by the clamp', async () => {
    const { clientId } = await provider.registerClientManual(
      'admin-minted',
      ['authorization_code'],
      'read write',
      ['https://app.example.com/cb'],
      'default',
      undefined,
      'none', // even a public admin-minted client keeps its scope
    );
    expect(await storedScope(clientId)).toBe('read write');
  });
});

// ---------------------------------------------------------------------------
// CRITICAL-1: with the Google login gate ENABLED, the DCR /register path
// (registerClient) hardens EVERY self-registration — confidential or public —
// to public (none) + ['authorization_code','refresh_token'] + read. This
// forces every self-registered client through /authorize (→ the gate) and
// caps it at read, closing the confidential-client client_credentials bypass.
// ---------------------------------------------------------------------------

describe('DCR login-gate hardening (registerClient, gate ENABLED)', () => {
  test('confidential client_credentials admin registration is forced public + authz_code/refresh + read', async () => {
    const reg = await gatedProvider.clientsStore.registerClient!({
      client_name: 'attacker-confidential',
      redirect_uris: ['https://app.example.com/cb'],
      grant_types: ['client_credentials'],
      scope: 'admin',
      token_endpoint_auth_method: 'client_secret_post',
    } as any);

    // Echoed DCR response is hardened.
    expect(reg.token_endpoint_auth_method).toBe('none');
    expect(reg.scope).toBe('read');
    expect(reg.grant_types).toEqual(['authorization_code', 'refresh_token']);
    // Public client → no secret minted (the client_credentials path is dead).
    expect(reg.client_secret).toBeUndefined();

    // Stored row agrees with the echoed response.
    const row = await storedRow(reg.client_id);
    expect(row.token_endpoint_auth_method).toBe('none');
    expect(row.scope).toBe('read');
    expect(row.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(row.client_secret_hash).toBeNull();
  });

  test('mixed grant_types: client_credentials stripped, authorization_code retained', async () => {
    const reg = await gatedProvider.clientsStore.registerClient!({
      client_name: 'attacker-mixed',
      redirect_uris: ['https://app.example.com/cb'],
      grant_types: ['authorization_code', 'client_credentials'],
      scope: 'write',
      token_endpoint_auth_method: 'client_secret_post',
    } as any);
    expect(reg.grant_types).toEqual(['authorization_code']);
    expect(reg.token_endpoint_auth_method).toBe('none');
    expect(reg.scope).toBe('read');
    expect((await storedRow(reg.client_id)).grant_types).toEqual(['authorization_code']);
  });

  test('public PKCE client is also clamped to read (unchanged outcome, gate-on path)', async () => {
    const reg = await gatedProvider.clientsStore.registerClient!({
      client_name: 'public-gated',
      redirect_uris: ['https://app.example.com/cb'],
      grant_types: ['authorization_code', 'refresh_token'],
      scope: 'read write admin',
      token_endpoint_auth_method: 'none',
    } as any);
    expect(reg.token_endpoint_auth_method).toBe('none');
    expect(reg.scope).toBe('read');
    expect(reg.grant_types).toEqual(['authorization_code', 'refresh_token']);
  });

  test('gate DISABLED leaves confidential client_credentials DCR behavior unchanged', async () => {
    // Same registration as the first gated test but via the ungated provider.
    const reg = await provider.clientsStore.registerClient!({
      client_name: 'confidential-ungated',
      redirect_uris: ['https://app.example.com/cb'],
      grant_types: ['client_credentials'],
      scope: 'read write',
      token_endpoint_auth_method: 'client_secret_post',
    } as any);
    // Confidential, secret issued, grants + scope preserved (prior behavior).
    expect(reg.token_endpoint_auth_method).toBe('client_secret_post');
    expect(reg.scope).toBe('read write');
    expect(reg.grant_types).toEqual(['client_credentials']);
    expect(typeof reg.client_secret).toBe('string');
    const row = await storedRow(reg.client_id);
    expect(row.token_endpoint_auth_method).toBe('client_secret_post');
    expect(row.grant_types).toEqual(['client_credentials']);
    expect(row.client_secret_hash).not.toBeNull();
  });

  test('operator path (registerClientManual) is unaffected even when gate is enabled', async () => {
    // registerClientManual on the GATED provider must still honor a
    // confidential client_credentials admin minting (the operator/admin path).
    const { clientId, clientSecret } = await gatedProvider.registerClientManual(
      'operator-machine',
      ['client_credentials'],
      'admin',
      [],
      'default',
      undefined,
      'client_secret_post',
    );
    const row = await storedRow(clientId);
    expect(row.token_endpoint_auth_method).toBe('client_secret_post');
    expect(row.scope).toBe('admin');
    expect(row.grant_types).toEqual(['client_credentials']);
    expect(row.client_secret_hash).not.toBeNull();
    expect(typeof clientSecret).toBe('string');
  });
});
