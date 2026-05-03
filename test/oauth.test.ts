import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { GBrainOAuthProvider, coerceTimestamp } from '../src/core/oauth-provider.ts';
import { hashToken, generateToken } from '../src/core/utils.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';

// ---------------------------------------------------------------------------
// Test setup: in-memory PGLite with OAuth tables
// ---------------------------------------------------------------------------

let db: PGlite;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;
let provider: GBrainOAuthProvider;

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);

  // Create a tagged template wrapper for PGLite
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows;
  };

  provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });
}, 30_000); // PGLITE_SCHEMA_SQL execution under full-suite load can exceed default 5s

afterAll(async () => {
  if (db) await db.close();
}, 15_000);

// ---------------------------------------------------------------------------
// hashToken + generateToken utilities
// ---------------------------------------------------------------------------

describe('hashToken', () => {
  test('produces consistent SHA-256 hex', () => {
    const hash = hashToken('test-token');
    expect(hash).toHaveLength(64);
    expect(hashToken('test-token')).toBe(hash); // deterministic
  });

  test('different inputs produce different hashes', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('generateToken', () => {
  test('produces prefixed random hex', () => {
    const token = generateToken('gbrain_cl_');
    expect(token).toStartWith('gbrain_cl_');
    expect(token).toHaveLength('gbrain_cl_'.length + 64); // 32 bytes = 64 hex chars
  });

  test('tokens are unique', () => {
    const a = generateToken('test_');
    const b = generateToken('test_');
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// coerceTimestamp — postgres BIGINT-as-string boundary helper
// ---------------------------------------------------------------------------

describe('coerceTimestamp', () => {
  test('null returns undefined', () => {
    expect(coerceTimestamp(null)).toBeUndefined();
  });

  test('undefined returns undefined', () => {
    expect(coerceTimestamp(undefined)).toBeUndefined();
  });

  test('numeric string coerces to number', () => {
    // The actual production path: postgres-js with prepare:false returns
    // BIGINT columns as strings.
    expect(coerceTimestamp('12345')).toBe(12345);
    expect(coerceTimestamp('1735689600')).toBe(1735689600);
  });

  test('native number passes through', () => {
    // Direct-PG users on prepare:true get native numbers.
    expect(coerceTimestamp(12345)).toBe(12345);
    expect(coerceTimestamp(0)).toBe(0);
  });

  test('non-finite input throws (fail-closed contract)', () => {
    // The load-bearing change vs Number(): corrupt rows fail loud at the
    // boundary instead of letting NaN flow through to the SDK as a
    // fake-valid `expiresAt`.
    expect(() => coerceTimestamp('not-a-number')).toThrow(/non-finite/);
    expect(() => coerceTimestamp(NaN)).toThrow(/non-finite/);
    expect(() => coerceTimestamp(Infinity)).toThrow(/non-finite/);
    expect(() => coerceTimestamp(-Infinity)).toThrow(/non-finite/);
  });
});

// ---------------------------------------------------------------------------
// Client Registration
// ---------------------------------------------------------------------------

describe('client registration', () => {
  test('registerClientManual creates a client', async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(
      'test-agent', ['client_credentials'], 'read write',
    );
    expect(clientId).toStartWith('gbrain_cl_');
    expect(clientSecret).toStartWith('gbrain_cs_');

    // Verify client exists in DB
    const client = await provider.clientsStore.getClient(clientId);
    expect(client).toBeDefined();
    expect(client!.client_name).toBe('test-agent');
  });

  test('getClient returns undefined for unknown client', async () => {
    const client = await provider.clientsStore.getClient('nonexistent');
    expect(client).toBeUndefined();
  });

  test('duplicate client_id is rejected', async () => {
    const { clientId } = await provider.registerClientManual(
      'dup-test', ['client_credentials'], 'read',
    );
    // Try to insert same client_id directly
    await expect(
      sql`INSERT INTO oauth_clients (client_id, client_name, scope) VALUES (${clientId}, ${'dup'}, ${'read'})`,
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Client Credentials Exchange
// ---------------------------------------------------------------------------

describe('client credentials', () => {
  let clientId: string;
  let clientSecret: string;

  beforeAll(async () => {
    const result = await provider.registerClientManual(
      'cc-test-agent', ['client_credentials'], 'read write',
    );
    clientId = result.clientId;
    clientSecret = result.clientSecret;
  });

  test('valid exchange returns access token', async () => {
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret, 'read');
    expect(tokens.access_token).toStartWith('gbrain_at_');
    expect(tokens.token_type).toBe('bearer');
    expect(tokens.expires_in).toBe(60);
    expect(tokens.scope).toBe('read');
  });

  test('no refresh token issued for CC grant', async () => {
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret, 'read');
    expect(tokens.refresh_token).toBeUndefined();
  });

  test('wrong secret is rejected', async () => {
    await expect(
      provider.exchangeClientCredentials(clientId, 'wrong-secret', 'read'),
    ).rejects.toThrow('Invalid client secret');
  });

  test('client without CC grant is rejected', async () => {
    const { clientId: noCC } = await provider.registerClientManual(
      'no-cc-agent', ['authorization_code'], 'read',
    );
    await expect(
      provider.exchangeClientCredentials(noCC, 'any-secret', 'read'),
    ).rejects.toThrow('not authorized');
  });

  test('scope is filtered to allowed scopes', async () => {
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret, 'read write admin');
    // Client only has 'read write', admin should be filtered out
    expect(tokens.scope).not.toContain('admin');
  });
});

// ---------------------------------------------------------------------------
// Token Verification
// ---------------------------------------------------------------------------

describe('verifyAccessToken', () => {
  test('valid token returns auth info', async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(
      'verify-test', ['client_credentials'], 'read write',
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret, 'read');
    const authInfo = await provider.verifyAccessToken(tokens.access_token);

    expect(authInfo.clientId).toBe(clientId);
    expect(authInfo.scopes).toContain('read');
    expect(authInfo.token).toBe(tokens.access_token);
  });

  test('expired token is rejected', async () => {
    // Insert a token that's already expired
    const expiredToken = generateToken('gbrain_at_');
    const hash = hashToken(expiredToken);
    const firstClient = (await sql`SELECT client_id FROM oauth_clients LIMIT 1`)[0];
    await sql`
      INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
      VALUES (${hash}, ${'access'}, ${firstClient.client_id as string}, ${'{read}'}, ${Math.floor(Date.now() / 1000) - 100})
    `;
    await expect(provider.verifyAccessToken(expiredToken)).rejects.toThrow('expired');
  });

  test('unknown token is rejected', async () => {
    await expect(provider.verifyAccessToken('nonexistent-token')).rejects.toThrow('Invalid token');
  });

  test('NULL expires_at is treated as expired (fail-closed)', async () => {
    // Schema declares oauth_tokens.expires_at as nullable BIGINT (schema.sql:372).
    // Hand-modified or corrupt rows could land with NULL; verifyAccessToken must
    // fail-closed, not return an undefined-bearing AuthInfo that the SDK accepts.
    const nullExpiryToken = generateToken('gbrain_at_');
    const hash = hashToken(nullExpiryToken);
    const firstClient = (await sql`SELECT client_id FROM oauth_clients LIMIT 1`)[0];
    await sql`
      INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
      VALUES (${hash}, ${'access'}, ${firstClient.client_id as string}, ${'{read}'}, ${null})
    `;
    await expect(provider.verifyAccessToken(nullExpiryToken)).rejects.toThrow('expired');
  });

  test('cascade-deleted client invalidates its tokens (Invalid token, not Expired)', async () => {
    // revoke-client does DELETE FROM oauth_clients WHERE client_id = ...
    // The schema-level FK cascade (schema.sql:370) wipes oauth_tokens too.
    // verifyAccessToken on a previously-minted token from that client must
    // fail with "Invalid token" (cascade purged the row) — distinct from
    // "Token expired" so logs distinguish the failure modes.
    const { clientId, clientSecret } = await provider.registerClientManual(
      'cascade-test', ['client_credentials'], 'read',
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret, 'read');
    await sql`DELETE FROM oauth_clients WHERE client_id = ${clientId}`;
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow('Invalid token');
  });

  test('expiresAt is always a number (not string) — SDK bearerAuth compat', async () => {
    // Regression: postgres driver with prepare:false returns integers as strings.
    // MCP SDK's bearerAuth middleware checks typeof === 'number' and rejects strings.
    // verifyAccessToken must cast to Number() before returning.
    const { clientId, clientSecret } = await provider.registerClientManual(
      'typeof-test', ['client_credentials'], 'read',
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret, 'read');
    const authInfo = await provider.verifyAccessToken(tokens.access_token);

    expect(typeof authInfo.expiresAt).toBe('number');
    expect(Number.isNaN(authInfo.expiresAt)).toBe(false);
    expect(authInfo.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('legacy access_tokens fallback works', async () => {
    // Insert a legacy bearer token
    const legacyToken = generateToken('gbrain_');
    const hash = hashToken(legacyToken);
    await sql`
      INSERT INTO access_tokens (id, name, token_hash)
      VALUES (${crypto.randomUUID()}, ${'legacy-agent'}, ${hash})
    `;

    const authInfo = await provider.verifyAccessToken(legacyToken);
    expect(authInfo.clientId).toBe('legacy-agent');
    expect(authInfo.scopes).toEqual(['read', 'write', 'admin']); // grandfathered full access
  });
});

// ---------------------------------------------------------------------------
// Token Revocation
// ---------------------------------------------------------------------------

describe('revokeToken', () => {
  test('revoked token no longer verifies', async () => {
    const { clientId, clientSecret } = await provider.registerClientManual(
      'revoke-test', ['client_credentials'], 'read',
    );
    const tokens = await provider.exchangeClientCredentials(clientId, clientSecret, 'read');

    // Verify token works
    const authInfo = await provider.verifyAccessToken(tokens.access_token);
    expect(authInfo.clientId).toBe(clientId);

    // Revoke it
    const client = (await provider.clientsStore.getClient(clientId))!;
    await provider.revokeToken!(client, { token: tokens.access_token });

    // Should no longer verify
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  test('revoking already-revoked token is a no-op', async () => {
    // This should not throw
    const client = (await provider.clientsStore.getClient(
      (await sql`SELECT client_id FROM oauth_clients LIMIT 1`)[0].client_id as string,
    ))!;
    await provider.revokeToken!(client, { token: 'already-gone' });
    // No error = pass
  });
});

// ---------------------------------------------------------------------------
// Authorization Code Flow
// ---------------------------------------------------------------------------

describe('authorization code flow', () => {
  test('code issuance and exchange', async () => {
    const { clientId } = await provider.registerClientManual(
      'authcode-test', ['authorization_code'], 'read write',
      ['http://localhost:3000/callback'],
    );
    const client = (await provider.clientsStore.getClient(clientId))!;

    // Mock Express response for authorize
    let redirectUrl = '';
    const mockRes = {
      redirect: (url: string) => { redirectUrl = url; },
    } as any;

    await provider.authorize(client, {
      codeChallenge: 'test-challenge-hash',
      redirectUri: 'http://localhost:3000/callback',
      scopes: ['read', 'write'],
      state: 'test-state',
    }, mockRes);

    expect(redirectUrl).toContain('code=gbrain_code_');
    expect(redirectUrl).toContain('state=test-state');

    // Extract code from redirect URL
    const url = new URL(redirectUrl);
    const code = url.searchParams.get('code')!;

    // Exchange code for tokens
    const tokens = await provider.exchangeAuthorizationCode(client, code);
    expect(tokens.access_token).toStartWith('gbrain_at_');
    expect(tokens.refresh_token).toBeDefined(); // Auth code flow includes refresh
  });

  test('code is single-use', async () => {
    const { clientId } = await provider.registerClientManual(
      'single-use-test', ['authorization_code'], 'read',
      ['http://localhost:3000/callback'],
    );
    const client = (await provider.clientsStore.getClient(clientId))!;

    let redirectUrl = '';
    const mockRes = { redirect: (url: string) => { redirectUrl = url; } } as any;

    await provider.authorize(client, {
      codeChallenge: 'challenge',
      redirectUri: 'http://localhost:3000/callback',
      scopes: ['read'],
    }, mockRes);

    const code = new URL(redirectUrl).searchParams.get('code')!;

    // First exchange works
    await provider.exchangeAuthorizationCode(client, code);

    // Second exchange fails (code consumed)
    await expect(provider.exchangeAuthorizationCode(client, code)).rejects.toThrow();
  });

  test('expired code is rejected', async () => {
    // Insert an already-expired code
    const expiredCode = generateToken('gbrain_code_');
    const hash = hashToken(expiredCode);
    const firstClient = (await sql`SELECT client_id FROM oauth_clients LIMIT 1`)[0];

    await sql`
      INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
                                redirect_uri, expires_at)
      VALUES (${hash}, ${firstClient.client_id as string}, ${'{read}'},
              ${'challenge'}, ${'http://localhost/cb'}, ${Math.floor(Date.now() / 1000) - 100})
    `;

    const client = (await provider.clientsStore.getClient(firstClient.client_id as string))!;
    await expect(provider.exchangeAuthorizationCode(client, expiredCode)).rejects.toThrow();
  });

  // CSO finding #2 regression. The pre-fix SELECT-then-DELETE pattern let two
  // concurrent token requests with the same code both pass the SELECT, both
  // running DELETE (no-op on second) and both calling issueTokens. The fix is
  // DELETE...RETURNING in one statement; this test fires N=10 concurrent
  // exchanges and asserts exactly one succeeds.
  test('concurrent exchange requests: only one succeeds (TOCTOU race)', async () => {
    const { clientId } = await provider.registerClientManual(
      'toctou-code-test', ['authorization_code'], 'read',
      ['http://localhost:3000/callback'],
    );
    const client = (await provider.clientsStore.getClient(clientId))!;

    let redirectUrl = '';
    const mockRes = { redirect: (url: string) => { redirectUrl = url; } } as any;
    await provider.authorize(client, {
      codeChallenge: 'challenge',
      redirectUri: 'http://localhost:3000/callback',
      scopes: ['read'],
    }, mockRes);
    const code = new URL(redirectUrl).searchParams.get('code')!;

    const N = 10;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => provider.exchangeAuthorizationCode(client, code)),
    );
    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(N - 1);
  });
});

// ---------------------------------------------------------------------------
// Refresh Token
// ---------------------------------------------------------------------------

describe('refresh token', () => {
  test('valid refresh rotates tokens', async () => {
    const { clientId } = await provider.registerClientManual(
      'refresh-test', ['authorization_code'], 'read write',
      ['http://localhost:3000/callback'],
    );
    const client = (await provider.clientsStore.getClient(clientId))!;

    let redirectUrl = '';
    const mockRes = { redirect: (url: string) => { redirectUrl = url; } } as any;

    await provider.authorize(client, {
      codeChallenge: 'challenge',
      redirectUri: 'http://localhost:3000/callback',
      scopes: ['read', 'write'],
    }, mockRes);

    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    // Refresh
    const newTokens = await provider.exchangeRefreshToken(client, tokens.refresh_token!, ['read']);
    expect(newTokens.access_token).not.toBe(tokens.access_token);
    expect(newTokens.refresh_token).toBeDefined();
    expect(newTokens.refresh_token).not.toBe(tokens.refresh_token); // rotated

    // Old refresh token should no longer work
    await expect(provider.exchangeRefreshToken(client, tokens.refresh_token!)).rejects.toThrow();
  });

  // CSO finding #3 regression. Same TOCTOU pattern as auth code; the fix is
  // DELETE...RETURNING. Detection of stolen refresh tokens (RFC 6749 §10.4)
  // depends on second-use failure, so two concurrent succeed = no detection.
  test('concurrent refresh requests: only one succeeds (TOCTOU race)', async () => {
    const { clientId } = await provider.registerClientManual(
      'toctou-refresh-test', ['authorization_code'], 'read',
      ['http://localhost:3000/callback'],
    );
    const client = (await provider.clientsStore.getClient(clientId))!;

    let redirectUrl = '';
    const mockRes = { redirect: (url: string) => { redirectUrl = url; } } as any;
    await provider.authorize(client, {
      codeChallenge: 'challenge',
      redirectUri: 'http://localhost:3000/callback',
      scopes: ['read'],
    }, mockRes);
    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(client, code);

    const N = 10;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => provider.exchangeRefreshToken(client, tokens.refresh_token!)),
    );
    const successes = results.filter(r => r.status === 'fulfilled');
    expect(successes.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Token Sweep
// ---------------------------------------------------------------------------

describe('sweepExpiredTokens', () => {
  test('removes expired tokens', async () => {
    // Insert some expired tokens
    const firstClient = (await sql`SELECT client_id FROM oauth_clients LIMIT 1`)[0];
    const expired1 = hashToken(generateToken('sweep_'));
    const expired2 = hashToken(generateToken('sweep_'));

    await sql`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
              VALUES (${expired1}, ${'access'}, ${firstClient.client_id as string}, ${'{read}'}, ${1})`;
    await sql`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
              VALUES (${expired2}, ${'access'}, ${firstClient.client_id as string}, ${'{read}'}, ${2})`;

    await provider.sweepExpiredTokens();

    // Verify they're gone
    const remaining = await sql`SELECT count(*)::int as count FROM oauth_tokens WHERE expires_at < 100`;
    expect(remaining[0].count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scope Annotations
// ---------------------------------------------------------------------------

describe('operation scope annotations', () => {
  test('all operations have a scope', () => {
    const { operations } = require('../src/core/operations.ts');
    for (const op of operations) {
      expect(op.scope, `${op.name} missing scope`).toBeDefined();
      expect(['read', 'write', 'admin']).toContain(op.scope);
    }
  });

  test('mutating operations are write or admin scoped', () => {
    const { operations } = require('../src/core/operations.ts');
    for (const op of operations) {
      if (op.mutating) {
        expect(['write', 'admin'], `${op.name} is mutating but not write/admin`).toContain(op.scope);
      }
    }
  });

  test('sync_brain and file_upload are localOnly', () => {
    const { operationsByName } = require('../src/core/operations.ts');
    expect(operationsByName.sync_brain.localOnly).toBe(true);
    expect(operationsByName.file_upload.localOnly).toBe(true);
  });

  test('file_list and file_url are localOnly', () => {
    const { operationsByName } = require('../src/core/operations.ts');
    expect(operationsByName.file_list.localOnly).toBe(true);
    expect(operationsByName.file_url.localOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CSO finding #5 — pgArray escape + DCR redirect_uri validation
// ---------------------------------------------------------------------------

describe('redirect_uri validation (DCR)', () => {
  test('http://localhost is allowed (loopback exception)', async () => {
    const result = await provider.clientsStore.registerClient!({
      client_name: 'localhost-ok',
      redirect_uris: ['http://localhost:3000/callback'],
      grant_types: ['authorization_code'],
      scope: 'read',
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(result.client_id).toStartWith('gbrain_cl_');
  });

  test('https:// is allowed', async () => {
    const result = await provider.clientsStore.registerClient!({
      client_name: 'https-ok',
      redirect_uris: ['https://example.com/callback'],
      grant_types: ['authorization_code'],
      scope: 'read',
      token_endpoint_auth_method: 'client_secret_post',
    });
    expect(result.client_id).toStartWith('gbrain_cl_');
  });

  test('plaintext http:// (non-loopback) is rejected', async () => {
    await expect(
      provider.clientsStore.registerClient!({
        client_name: 'http-rejected',
        redirect_uris: ['http://example.com/callback'],
        grant_types: ['authorization_code'],
        scope: 'read',
        token_endpoint_auth_method: 'client_secret_post',
      }),
    ).rejects.toThrow(/https/);
  });

  test('non-URL string is rejected', async () => {
    await expect(
      provider.clientsStore.registerClient!({
        client_name: 'garbage',
        redirect_uris: ['not-a-url'],
        grant_types: ['authorization_code'],
        scope: 'read',
        token_endpoint_auth_method: 'client_secret_post',
      }),
    ).rejects.toThrow();
  });

  // pgArray escape regression: an element containing a comma must be stored
  // as ONE element, not parsed by Postgres as TWO. Without the fix, the
  // comma would smuggle a second redirect_uri into the registered list.
  test('redirect_uri with embedded comma stored as single element', async () => {
    // Use a localhost URI with comma in the path so it passes HTTPS validation.
    const trickyUri = 'http://localhost:3000/cb,evil';
    const result = await provider.clientsStore.registerClient!({
      client_name: 'comma-test',
      redirect_uris: [trickyUri],
      grant_types: ['authorization_code'],
      scope: 'read',
      token_endpoint_auth_method: 'client_secret_post',
    });

    // Read back from the DB and confirm exactly one element.
    const stored = await provider.clientsStore.getClient(result.client_id);
    expect(stored).toBeDefined();
    expect(stored!.redirect_uris).toHaveLength(1);
    expect(stored!.redirect_uris[0]).toBe(trickyUri);
  });
});
