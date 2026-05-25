/**
 * v0.37.7.0 #1166 — OAuth confidential clients regression test.
 *
 * The MCP SDK's clientAuth middleware does `client.client_secret !==
 * presented_secret` plaintext compare. gbrain stores SHA-256 hashes,
 * so the SDK's compare always failed for confidential authorization_code
 * and refresh_token grants. v0.34.1.0 fixed PUBLIC PKCE clients
 * (client_secret = undefined); confidential clients regressed.
 *
 * Fix: provider gains `verifyConfidentialClientSecret(clientId, secret)`
 * that does hash-then-compare ourselves. The serve-http /token middleware
 * uses this BEFORE delegating to exchangeAuthorizationCode /
 * exchangeRefreshToken. Public clients fall through to the SDK as today.
 *
 * Hermetic via PGLite in-memory.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await (engine as any).db.exec('DELETE FROM oauth_tokens');
  await (engine as any).db.exec('DELETE FROM oauth_codes');
  await (engine as any).db.exec('DELETE FROM oauth_clients');
});

describe('verifyConfidentialClientSecret (#1166)', () => {
  test('confidential client_secret_post: returns client on correct secret', async () => {
    const reg = await provider.registerClientManual('test-conf', ['authorization_code'], 'read write', ['https://example.test/cb']);
    expect(reg.clientId).toBeTruthy();
    expect(reg.clientSecret!).toBeTruthy();

    const client = await provider.verifyConfidentialClientSecret(reg.clientId, reg.clientSecret!);
    expect(client.client_id).toBe(reg.clientId);
  });

  test('wrong secret → throws "Invalid client" (RFC 6749 opaque error)', async () => {
    const reg = await provider.registerClientManual('test-conf', ['authorization_code'], 'read', ['https://example.test/cb']);
    await expect(
      provider.verifyConfidentialClientSecret(reg.clientId, 'wrong-secret'),
    ).rejects.toThrow(/Invalid client/);
  });

  test('non-existent client → throws "Invalid client"', async () => {
    await expect(
      provider.verifyConfidentialClientSecret('does-not-exist', 'anything'),
    ).rejects.toThrow(/Invalid client/);
  });

  test('public client (token_endpoint_auth_method=none) refuses confidential path', async () => {
    // Public PKCE clients are registered via the SDK's DCR path with
    // `token_endpoint_auth_method: 'none'` — those store
    // client_secret_hash = NULL. registerClientManual sets a secret
    // unconditionally, so we test the rejection by directly inserting
    // a public-client row.
    await engine.executeRaw(
      `INSERT INTO oauth_clients
        (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method)
        VALUES ('public-pkce', NULL, 'public', $1, $2, 'read', 'none')`,
      [
        ['https://example.test/cb'],
        ['authorization_code'],
      ],
    );

    await expect(
      provider.verifyConfidentialClientSecret('public-pkce', 'any-secret'),
    ).rejects.toThrow(/Invalid client/);
  });

  test('case-insensitive secret? NO — must be exact match', async () => {
    const reg = await provider.registerClientManual('test-case', ['authorization_code'], 'read', ['https://example.test/cb']);
    const wrongCase = reg.clientSecret!.toUpperCase();
    if (wrongCase !== reg.clientSecret!) {
      await expect(
        provider.verifyConfidentialClientSecret(reg.clientId, wrongCase),
      ).rejects.toThrow(/Invalid client/);
    }
  });

  test('soft-deleted client → throws "Client has been revoked"', async () => {
    const reg = await provider.registerClientManual('to-revoke', ['authorization_code'], 'read', ['https://example.test/cb']);
    await engine.executeRaw(
      `UPDATE oauth_clients SET deleted_at = NOW() WHERE client_id = $1`,
      [reg.clientId],
    );
    await expect(
      provider.verifyConfidentialClientSecret(reg.clientId, reg.clientSecret!),
    ).rejects.toThrow(/revoked/);
  });
});

describe('confidential-client full flow #1166', () => {
  test('verify-then-exchange refresh token end-to-end', async () => {
    const reg = await provider.registerClientManual('full-flow-rt', ['authorization_code', 'refresh_token'], 'read', ['https://example.test/cb']);

    // Mint an initial token pair via client_credentials (simpler than
    // /authorize round-trip in a unit test).
    await engine.executeRaw(
      `UPDATE oauth_clients SET grant_types = $1 WHERE client_id = $2`,
      [['client_credentials', 'refresh_token'], reg.clientId],
    );
    const initial = await provider.exchangeClientCredentials(reg.clientId, reg.clientSecret!, 'read');
    // client_credentials grants don't issue refresh tokens (RFC 6749
    // 4.4.3), so we manually insert a refresh token to test the
    // verify-then-rotate path.
    const refreshToken = 'rt_' + Buffer.from(Math.random().toString()).toString('hex');
    const { hashToken } = await import('../src/core/utils.ts');
    await engine.executeRaw(
      `INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
       VALUES ($1, 'refresh', $2, $3, $4)`,
      [hashToken(refreshToken), reg.clientId, ['read'], Math.floor(Date.now() / 1000) + 3600],
    );

    // verify → exchange round-trip with the correct secret
    const client = await provider.verifyConfidentialClientSecret(reg.clientId, reg.clientSecret!);
    const rotated = await provider.exchangeRefreshToken(client, refreshToken);
    expect(rotated.access_token).toBeTruthy();
    expect(rotated.refresh_token).toBeTruthy();
    expect(rotated.refresh_token).not.toBe(refreshToken); // rotated

    // Original refresh token is now consumed; second use rejected.
    await expect(
      provider.exchangeRefreshToken(client, refreshToken),
    ).rejects.toThrow(/not found/);
  });
});
