/**
 * External-issuer JWT verification (src/core/external-token-verifier.ts +
 * the verifyAccessToken external branch in src/core/oauth-provider.ts).
 *
 * OWN PGlite instance (mirrors oauth-surface-ladder.test.ts): these tests
 * mutate process.env for the module-level verifier singleton, which would
 * poison shared-db suites that also exercise verifyAccessToken.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { resetExternalTokenVerifierCache } from '../src/core/external-token-verifier.ts';
import type { AuthInfo as CoreAuthInfo } from '../src/core/operations.ts';

const ISSUER = 'https://gateway.test.example';
const AUDIENCE = 'gbrain';

let db: PGlite;
let sql: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any>;
let provider: GBrainOAuthProvider;
let privateKey: CryptoKey;
let savedEnv: Record<string, string | undefined>;

const ENV_KEYS = [
  'GBRAIN_EXTERNAL_TOKEN_ISSUER',
  'GBRAIN_EXTERNAL_TOKEN_AUDIENCE',
  'GBRAIN_EXTERNAL_TOKEN_CALLER_MAP',
  'GBRAIN_EXTERNAL_TOKEN_JWKS',
  'GBRAIN_EXTERNAL_TOKEN_JWKS_URI',
] as const;

async function signJwt(claims: Record<string, unknown>, opts?: { issuer?: string; audience?: string; expired?: boolean }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(opts?.issuer ?? ISSUER)
    .setAudience(opts?.audience ?? AUDIENCE)
    .setIssuedAt(opts?.expired ? now - 600 : now)
    .setExpirationTime(opts?.expired ? now - 300 : now + 300)
    .sign(privateKey);
}

beforeAll(async () => {
  db = new PGlite({ extensions: { vector, pg_trgm } });
  await db.exec(PGLITE_SCHEMA_SQL);
  sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows;
  };
  provider = new GBrainOAuthProvider({ sql, tokenTtl: 60, refreshTtl: 300 });

  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey as CryptoKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'test-key';
  jwk.alg = 'RS256';

  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  process.env.GBRAIN_EXTERNAL_TOKEN_ISSUER = ISSUER;
  process.env.GBRAIN_EXTERNAL_TOKEN_AUDIENCE = AUDIENCE;
  process.env.GBRAIN_EXTERNAL_TOKEN_CALLER_MAP = JSON.stringify({
    'litellm-user-a': 'acl-client-a',
    'someone@example.com': 'acl-client-b',
    'stale-caller': 'acl-client-gone',
  });
  process.env.GBRAIN_EXTERNAL_TOKEN_JWKS = JSON.stringify({ keys: [jwk] });
  delete process.env.GBRAIN_EXTERNAL_TOKEN_JWKS_URI;
  resetExternalTokenVerifierCache();

  await sql`
    INSERT INTO sources (id, name) VALUES ('source-a', 'Source A'), ('source-b', 'Source B'), ('infra-curated', 'Infra')
  `;
  await sql`
    INSERT INTO oauth_clients (client_id, client_name, scope, source_id, federated_read)
    VALUES ('acl-client-a', 'ACL Client A', 'read write', 'source-a', '{"source-a","infra-curated"}'),
           ('acl-client-b', 'ACL Client B', 'read', 'source-b', '{"source-b"}')
  `;
  await sql`
    INSERT INTO oauth_clients (client_id, client_name, scope, deleted_at)
    VALUES ('acl-client-gone', 'Deleted', 'read', now())
  `;
}, 30_000);

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetExternalTokenVerifierCache();
  if (db) await db.close();
}, 15_000);

describe('external-issuer JWT verification', () => {
  test('mapped sub resolves to the registered client with its source scope', async () => {
    const token = await signJwt({ sub: 'litellm-user-a' });
    const info = (await provider.verifyAccessToken(token)) as unknown as CoreAuthInfo;
    expect(info.clientId).toBe('acl-client-a');
    expect(info.clientName).toBe('ACL Client A');
    expect(info.scopes).toEqual(['read', 'write']);
    expect(info.sourceId).toBe('source-a');
    expect(info.allowedSources).toEqual(['source-a', 'infra-curated']);
    expect(typeof info.expiresAt).toBe('number');
    // Audit identity of the exact gateway key — several keys can map to one
    // client_id, so the request log needs the JWT sub, not just the client.
    expect(info.externalSub).toBe('litellm-user-a');
  });

  test('email fallback maps when sub is unmapped', async () => {
    const token = await signJwt({ sub: 'unmapped-internal-id', email: 'someone@example.com' });
    const info = (await provider.verifyAccessToken(token)) as unknown as CoreAuthInfo;
    expect(info.clientId).toBe('acl-client-b');
    expect(info.allowedSources).toEqual(['source-b']);
    // The map matched on email, so email IS the audit identity here.
    expect(info.externalSub).toBe('someone@example.com');
  });

  test('verified JWT with unmapped subject is rejected (fail closed)', async () => {
    const token = await signJwt({ sub: 'not-in-the-map' });
    await expect(provider.verifyAccessToken(token)).rejects.toThrow('Invalid token');
  });

  test('expired JWT is rejected', async () => {
    const token = await signJwt({ sub: 'litellm-user-a' }, { expired: true });
    await expect(provider.verifyAccessToken(token)).rejects.toThrow('Invalid token');
  });

  test('wrong audience is rejected', async () => {
    const token = await signJwt({ sub: 'litellm-user-a' }, { audience: 'somebody-else' });
    await expect(provider.verifyAccessToken(token)).rejects.toThrow('Invalid token');
  });

  test('JWT signed by a different key is rejected', async () => {
    const rogue = await generateKeyPair('RS256');
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub: 'litellm-user-a' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(rogue.privateKey as CryptoKey);
    await expect(provider.verifyAccessToken(token)).rejects.toThrow('Invalid token');
  });

  test('mapped caller whose client row is soft-deleted is rejected', async () => {
    const token = await signJwt({ sub: 'stale-caller' });
    await expect(provider.verifyAccessToken(token)).rejects.toThrow('Invalid token');
  });

  test('non-JWT bearer still takes the opaque-token path', async () => {
    await expect(provider.verifyAccessToken('not-a-jwt-opaque-token')).rejects.toThrow('Invalid token');
  });
});
