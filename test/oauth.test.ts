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

// ---------------------------------------------------------------------------
// F1 / F4 — Wrong-client cross-tenant attempts
// ---------------------------------------------------------------------------
//
// The atomic client_id binding lives in the DELETE WHERE clause for auth
// codes (exchange + challenge), refresh tokens (rotate), and revocations.
// Without it, any authenticated client that knew/guessed another client's
// hash could (a) consume the code/refresh on the wrong-client path,
// burning it for the legitimate client, or (b) revoke another client's
// tokens. These tests pin the negative invariant — wrong client fails —
// AND the positive invariant — owner still succeeds atomically afterward.

describe('F1/F4 cross-client isolation', () => {
  test('wrong client cannot consume another client authorization code', async () => {
    const { clientId: ownerId } = await provider.registerClientManual(
      'authcode-owner-test', ['authorization_code'], 'read',
      ['http://localhost:3000/callback'],
    );
    const { clientId: attackerId } = await provider.registerClientManual(
      'authcode-attacker-test', ['authorization_code'], 'read',
      ['http://localhost:3000/callback'],
    );
    const owner = (await provider.clientsStore.getClient(ownerId))!;
    const attacker = (await provider.clientsStore.getClient(attackerId))!;

    let redirectUrl = '';
    const mockRes = { redirect: (url: string) => { redirectUrl = url; } } as any;
    await provider.authorize(owner, {
      codeChallenge: 'challenge',
      redirectUri: 'http://localhost:3000/callback',
      scopes: ['read'],
    }, mockRes);
    const code = new URL(redirectUrl).searchParams.get('code')!;

    // Attacker holding the same code MUST be rejected.
    await expect(provider.exchangeAuthorizationCode(attacker, code)).rejects.toThrow();

    // The atomic predicate's payoff: the legitimate owner can STILL redeem
    // the code afterward. Without it, the attacker would have burned the
    // row in the DELETE and the owner's redemption would 404.
    const tokens = await provider.exchangeAuthorizationCode(owner, code);
    expect(tokens.access_token).toStartWith('gbrain_at_');
  });

  test('wrong client cannot read another client PKCE challenge', async () => {
    const { clientId: ownerId } = await provider.registerClientManual(
      'challenge-owner-test', ['authorization_code'], 'read',
      ['http://localhost:3000/callback'],
    );
    const { clientId: attackerId } = await provider.registerClientManual(
      'challenge-attacker-test', ['authorization_code'], 'read',
      ['http://localhost:3000/callback'],
    );
    const owner = (await provider.clientsStore.getClient(ownerId))!;
    const attacker = (await provider.clientsStore.getClient(attackerId))!;

    let redirectUrl = '';
    const mockRes = { redirect: (url: string) => { redirectUrl = url; } } as any;
    await provider.authorize(owner, {
      codeChallenge: 'owner-challenge',
      redirectUri: 'http://localhost:3000/callback',
      scopes: ['read'],
    }, mockRes);
    const code = new URL(redirectUrl).searchParams.get('code')!;

    await expect(provider.challengeForAuthorizationCode!(attacker, code)).rejects.toThrow();
    await expect(provider.challengeForAuthorizationCode!(owner, code)).resolves.toBe('owner-challenge');
  });

  test('wrong client cannot revoke another client token', async () => {
    const { clientId: ownerId, clientSecret: ownerSecret } = await provider.registerClientManual(
      'revoke-owner-test', ['client_credentials'], 'read',
    );
    const { clientId: attackerId } = await provider.registerClientManual(
      'revoke-attacker-test', ['client_credentials'], 'read',
    );
    const tokens = await provider.exchangeClientCredentials(ownerId, ownerSecret, 'read');
    const attacker = (await provider.clientsStore.getClient(attackerId))!;

    // Attacker tries to revoke owner's token. revokeToken returns void
    // (silent on no-op), so we assert the token still verifies after.
    await provider.revokeToken!(attacker, { token: tokens.access_token });
    const authInfo = await provider.verifyAccessToken(tokens.access_token);
    expect(authInfo.clientId).toBe(ownerId);
  });
});

// ---------------------------------------------------------------------------
// F2 + F3 — Refresh-token cross-client isolation + scope subset
// ---------------------------------------------------------------------------

describe('F2/F3 refresh hardening', () => {
  test('wrong client cannot burn another client refresh token', async () => {
    const { clientId: ownerId } = await provider.registerClientManual(
      'refresh-owner-test', ['authorization_code'], 'read',
      ['http://localhost:3000/callback'],
    );
    const { clientId: attackerId } = await provider.registerClientManual(
      'refresh-attacker-test', ['authorization_code'], 'read',
      ['http://localhost:3000/callback'],
    );
    const owner = (await provider.clientsStore.getClient(ownerId))!;
    const attacker = (await provider.clientsStore.getClient(attackerId))!;

    let redirectUrl = '';
    const mockRes = { redirect: (url: string) => { redirectUrl = url; } } as any;
    await provider.authorize(owner, {
      codeChallenge: 'challenge',
      redirectUri: 'http://localhost:3000/callback',
      scopes: ['read'],
    }, mockRes);
    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = await provider.exchangeAuthorizationCode(owner, code);

    // Attacker rejected.
    await expect(provider.exchangeRefreshToken(attacker, tokens.refresh_token!)).rejects.toThrow();

    // Owner still redeems atomically — the row was not burned by the
    // attacker's attempt.
    const rotated = await provider.exchangeRefreshToken(owner, tokens.refresh_token!);
    expect(rotated.access_token).toStartWith('gbrain_at_');
    expect(rotated.refresh_token).toBeDefined();
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
  });

  test('refresh cannot request scopes outside the original grant (F3)', async () => {
    // Client allowed scopes 'read write', but the user only authorized 'read'.
    // The refresh token row carries the granted scope, NOT the client's
    // currently-allowed scopes (codex C9). Requesting 'write' on refresh
    // must fail even though the client could mint a fresh write-scoped
    // token via a new authorize round trip.
    const { clientId } = await provider.registerClientManual(
      'refresh-scope-test', ['authorization_code'], 'read write',
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

    // Attempt to escalate to write — must reject.
    await expect(
      provider.exchangeRefreshToken(client, tokens.refresh_token!, ['read', 'write']),
    ).rejects.toThrow(/scope/i);
  });
});

// ---------------------------------------------------------------------------
// F5 — fail-loud column probes (was: bare catch{})
// ---------------------------------------------------------------------------

describe('F5 verifyAccessToken / client_credentials column probes', () => {
  test('non-schema SQL failures are not swallowed by client credentials soft-delete probe', async () => {
    // Synthesize a non-schema error (SQLSTATE 57P01 = admin_shutdown) and
    // make sure the catch block re-throws instead of silently treating
    // the client as not-revoked. Without the predicate this throw used to
    // disappear into the void.
    const sqlFailure = Object.assign(new Error('database session failed'), { code: '57P01' });
    const fakeSql = async (strings: TemplateStringsArray): Promise<Record<string, unknown>[]> => {
      const query = strings.join('$');
      if (query.includes('SELECT client_id, client_secret_hash')) {
        return [{
          client_id: 'gbrain_cl_fake',
          client_secret_hash: hashToken('secret'),
          client_name: 'fake',
          redirect_uris: [],
          grant_types: ['client_credentials'],
          scope: 'read',
          client_id_issued_at: 1,
        }];
      }
      if (query.includes('SELECT deleted_at')) throw sqlFailure;
      return [];
    };
    const failingProvider = new GBrainOAuthProvider({ sql: fakeSql as any });

    await expect(
      failingProvider.exchangeClientCredentials('gbrain_cl_fake', 'secret', 'read'),
    ).rejects.toThrow('database session failed');
  });
});

// ---------------------------------------------------------------------------
// F6 — sweepExpiredTokens returns a meaningful count across both engines
// ---------------------------------------------------------------------------

describe('F6 sweepExpiredTokens count', () => {
  test('returns count > 0 after deleting expired rows', async () => {
    const firstClient = (await sql`SELECT client_id FROM oauth_clients LIMIT 1`)[0];
    const t1 = hashToken(generateToken('sweep_count_'));
    const t2 = hashToken(generateToken('sweep_count_'));
    await sql`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
              VALUES (${t1}, ${'access'}, ${firstClient.client_id as string}, ${'{read}'}, ${1})`;
    await sql`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
              VALUES (${t2}, ${'access'}, ${firstClient.client_id as string}, ${'{read}'}, ${2})`;

    const swept = await provider.sweepExpiredTokens();

    // Pre-fix: returned 0 on PGLite/postgres.js even when rows were deleted
    // because (result as any).count was unset on at least one path. With
    // RETURNING 1 + result.length, the actual row count flows back.
    expect(swept).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// F7c — auth code redirect_uri validated on /token (RFC 6749 §4.1.3)
// ---------------------------------------------------------------------------

describe('F7c redirect_uri binding on auth code exchange', () => {
  test('matching redirect_uri succeeds', async () => {
    const { clientId } = await provider.registerClientManual(
      'redir-match-test', ['authorization_code'], 'read',
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

    const tokens = await provider.exchangeAuthorizationCode(
      client, code, undefined, 'http://localhost:3000/callback',
    );
    expect(tokens.access_token).toStartWith('gbrain_at_');
  });

  test('mismatched redirect_uri rejects', async () => {
    const { clientId } = await provider.registerClientManual(
      'redir-mismatch-test', ['authorization_code'], 'read',
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

    // Attacker submitting the auth code with a different redirect_uri (e.g.,
    // an attacker-controlled callback URL) MUST be rejected. RFC 6749 §4.1.3.
    await expect(
      provider.exchangeAuthorizationCode(
        client, code, undefined, 'https://attacker.example/cb',
      ),
    ).rejects.toThrow();
  });

  test('empty-string redirect_uri does NOT bypass the binding', async () => {
    // D15 / adversarial-review fix: `redirectUri ? ...` would treat empty string
    // as falsy and silently fall through to the no-redirect-uri branch,
    // letting an attacker submit `redirect_uri=""` to bypass the predicate.
    // The fix uses `redirectUri !== undefined`. This test asserts the bypass
    // is closed: an empty-string redirect_uri must reject (zero-row DELETE
    // since stored value is the original non-empty URI), not slip through.
    const { clientId } = await provider.registerClientManual(
      'redir-empty-test', ['authorization_code'], 'read',
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

    await expect(
      provider.exchangeAuthorizationCode(client, code, undefined, ''),
    ).rejects.toThrow();
  });

  test('omitted redirect_uri (back-compat) still succeeds', async () => {
    // Existing callers that don't pass redirectUri keep working — the
    // predicate only fires when redirectUri is provided. This protects
    // against breaking SDK consumers that haven't adopted the parameter
    // yet, while still hardening the path for those that have.
    const { clientId } = await provider.registerClientManual(
      'redir-omitted-test', ['authorization_code'], 'read',
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
    expect(tokens.access_token).toStartWith('gbrain_at_');
  });
});

// ---------------------------------------------------------------------------
// F12 — DCR disable via constructor option (cleanup, not security)
// ---------------------------------------------------------------------------

describe('F12 dcrDisabled constructor option', () => {
  test('clientsStore omits registerClient when dcrDisabled=true', () => {
    const dcrOff = new GBrainOAuthProvider({ sql, dcrDisabled: true });
    const store = dcrOff.clientsStore;
    expect(typeof store.getClient).toBe('function');
    // SDK's mcpAuthRouter checks for registerClient before wiring up the
    // /register endpoint. Absence of the method == DCR endpoint not exposed.
    expect((store as any).registerClient).toBeUndefined();
  });

  test('clientsStore exposes registerClient when dcrDisabled is false/unset', () => {
    const dcrOn = new GBrainOAuthProvider({ sql });
    expect(typeof dcrOn.clientsStore.registerClient).toBe('function');
  });

  test('registerClientManual still works on dcrDisabled providers (CLI path)', async () => {
    // The CLI code path uses registerClientManual, which is independent of
    // the DCR /register endpoint. dcrDisabled must NOT break it.
    const dcrOff = new GBrainOAuthProvider({ sql, dcrDisabled: true });
    const result = await dcrOff.registerClientManual(
      'dcr-disabled-cli-test', ['client_credentials'], 'read',
    );
    expect(result.clientId).toStartWith('gbrain_cl_');
    expect(result.clientSecret).toStartWith('gbrain_cs_');
  });
});
