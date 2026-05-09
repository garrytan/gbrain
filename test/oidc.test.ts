/**
 * Tests for src/core/oidc.ts
 *
 * Spins up a tiny Bun.serve mock IdP that exposes:
 *   /.well-known/openid-configuration
 *   /jwks
 *   /token
 *
 * The tests sign id_tokens with a generated RS256 key pair, then assert
 * that valid tokens verify and that each individual claim mutation
 * triggers the matching OidcError code.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  SignJWT,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
} from 'jose';
import {
  OidcError,
  OidcVerifier,
  DISCOVERY_CACHE_TTL_MS,
} from '../src/core/oidc.ts';

interface KeyState {
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
  kid: string;
  alg: string;
}

const CLIENT_ID = 'test-client-id.apps.example.com';
const CLIENT_SECRET = 'test-secret';
const TOKEN_PATH = '/token';
const JWKS_PATH = '/jwks';
const DISCOVERY_PATH = '/.well-known/openid-configuration';

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let issuer: string;
let activeKey: KeyState;
let discoveryHits = 0;
let jwksHits = 0;
let tokenEndpointResponse: { status: number; body: string } | null = null;

async function makeKey(kid: string, alg = 'RS256'): Promise<KeyState> {
  const { privateKey, publicKey } = await generateKeyPair(alg, {
    extractable: true,
  });
  const publicJwk = (await exportJWK(publicKey)) as Record<string, unknown>;
  publicJwk.kid = kid;
  publicJwk.alg = alg;
  publicJwk.use = 'sig';
  return { privateKey, publicJwk, kid, alg };
}

async function signToken(
  claims: Record<string, unknown>,
  opts: { kid?: string; alg?: string; key?: CryptoKey } = {},
): Promise<string> {
  const kid = opts.kid ?? activeKey.kid;
  const alg = opts.alg ?? activeKey.alg;
  const key = opts.key ?? activeKey.privateKey;
  const jwt = new SignJWT(claims as any).setProtectedHeader({ alg, kid });
  return jwt.sign(key);
}

function defaultClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: issuer,
    aud: CLIENT_ID,
    sub: 'sub-12345',
    iat: now,
    exp: now + 600,
    email: 'Alice@Example.com',
    email_verified: true,
    ...overrides,
  };
}

beforeAll(async () => {
  activeKey = await makeKey('key-1');
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === DISCOVERY_PATH) {
        discoveryHits += 1;
        return new Response(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${baseUrl}/authorize`,
            token_endpoint: `${baseUrl}${TOKEN_PATH}`,
            jwks_uri: `${baseUrl}${JWKS_PATH}`,
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.pathname === JWKS_PATH) {
        jwksHits += 1;
        return new Response(
          JSON.stringify({ keys: [activeKey.publicJwk] }),
          {
            headers: {
              'content-type': 'application/json',
              'cache-control': 'public, max-age=3600',
            },
          },
        );
      }
      if (url.pathname === TOKEN_PATH) {
        if (tokenEndpointResponse) {
          return new Response(tokenEndpointResponse.body, {
            status: tokenEndpointResponse.status,
            headers: { 'content-type': 'application/json' },
          });
        }
        const text = await req.text();
        const params = new URLSearchParams(text);
        const id_token = await signToken(
          defaultClaims({ code: params.get('code') }),
        );
        return new Response(
          JSON.stringify({ id_token, access_token: 'access-abc' }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
  issuer = baseUrl;
});

afterAll(() => {
  server.stop(true);
});

function newVerifier(): OidcVerifier {
  return new OidcVerifier({
    issuerUrl: issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
}

describe('OidcVerifier discovery', () => {
  test('fetches and parses the discovery doc', async () => {
    const v = newVerifier();
    const doc = await v.getDiscovery();
    expect(doc.issuer).toBe(issuer);
    expect(doc.token_endpoint).toBe(`${baseUrl}${TOKEN_PATH}`);
    expect(doc.jwks_uri).toBe(`${baseUrl}${JWKS_PATH}`);
    expect(doc.authorization_endpoint).toBe(`${baseUrl}/authorize`);
  });

  test('caches the discovery doc within TTL', async () => {
    const v = newVerifier();
    discoveryHits = 0;
    await v.getDiscovery();
    await v.getDiscovery();
    await v.getDiscovery();
    expect(discoveryHits).toBe(1);
    // Spec sanity: TTL is 1 hour.
    expect(DISCOVERY_CACHE_TTL_MS).toBe(60 * 60 * 1000);
  });

  test('throws OidcError(discovery_failed) when issuer is unreachable', async () => {
    const v = new OidcVerifier({
      issuerUrl: 'http://127.0.0.1:1', // unlikely to be listening
      clientId: CLIENT_ID,
    });
    let caught: unknown;
    try {
      await v.getDiscovery();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OidcError);
    expect((caught as OidcError).code).toBe('discovery_failed');
  });
});

describe('OidcVerifier verifyIdToken happy path', () => {
  test('verifies a valid id_token and returns normalized identity', async () => {
    const v = newVerifier();
    const token = await signToken(defaultClaims());
    const id = await v.verifyIdToken(token);
    expect(id.email).toBe('alice@example.com');
    expect(id.emailVerified).toBe(true);
    expect(id.subject).toBe('sub-12345');
    expect(id.issuer).toBe(issuer);
    expect(id.audience).toBe(CLIENT_ID);
    expect(typeof id.issuedAt).toBe('number');
    expect(typeof id.expiresAt).toBe('number');
    expect(id.expiresAt).toBeGreaterThan(id.issuedAt);
  });

  test('accepts aud as an array containing clientId', async () => {
    const v = newVerifier();
    const token = await signToken(
      defaultClaims({ aud: ['other', CLIENT_ID, 'another'] }),
    );
    const id = await v.verifyIdToken(token);
    expect(id.audience).toBe(CLIENT_ID);
  });
});

describe('OidcVerifier verifyIdToken negative cases', () => {
  test('malformed: not a JWS', async () => {
    const v = newVerifier();
    let caught: unknown;
    try {
      await v.verifyIdToken('not.a.jwt.at.all');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OidcError);
    expect((caught as OidcError).code).toBe('malformed');
  });

  test('malformed: empty string', async () => {
    const v = newVerifier();
    let caught: unknown;
    try {
      await v.verifyIdToken('');
    } catch (e) {
      caught = e;
    }
    expect((caught as OidcError).code).toBe('malformed');
  });

  test('malformed: only two segments', async () => {
    const v = newVerifier();
    let caught: unknown;
    try {
      await v.verifyIdToken('aaa.bbb');
    } catch (e) {
      caught = e;
    }
    expect((caught as OidcError).code).toBe('malformed');
  });

  test('signature_invalid: tampered signature', async () => {
    const v = newVerifier();
    const token = await signToken(defaultClaims());
    const parts = token.split('.');
    // Flip the last char of the signature segment.
    const sig = parts[2];
    const mutated = sig[sig.length - 1] === 'A' ? sig.slice(0, -1) + 'B' : sig.slice(0, -1) + 'A';
    parts[2] = mutated;
    const bad = parts.join('.');
    let caught: unknown;
    try {
      await v.verifyIdToken(bad);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OidcError);
    expect((caught as OidcError).code).toBe('signature_invalid');
  });

  test('signature_invalid: signed with the wrong key', async () => {
    const v = newVerifier();
    const otherKey = await makeKey('key-1'); // same kid, different key
    const token = await signToken(defaultClaims(), {
      key: otherKey.privateKey,
      kid: 'key-1',
    });
    let caught: unknown;
    try {
      await v.verifyIdToken(token);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OidcError);
    expect((caught as OidcError).code).toBe('signature_invalid');
  });

  test('issuer_mismatch: wrong iss', async () => {
    const v = newVerifier();
    const token = await signToken(defaultClaims({ iss: 'https://evil.example' }));
    let caught: unknown;
    try {
      await v.verifyIdToken(token);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OidcError);
    expect((caught as OidcError).code).toBe('issuer_mismatch');
  });

  test('audience_mismatch: aud is a different string', async () => {
    const v = newVerifier();
    const token = await signToken(defaultClaims({ aud: 'someone-else' }));
    let caught: unknown;
    try {
      await v.verifyIdToken(token);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OidcError);
    expect((caught as OidcError).code).toBe('audience_mismatch');
  });

  test('audience_mismatch: aud array missing clientId', async () => {
    const v = newVerifier();
    const token = await signToken(defaultClaims({ aud: ['a', 'b'] }));
    let caught: unknown;
    try {
      await v.verifyIdToken(token);
    } catch (e) {
      caught = e;
    }
    expect((caught as OidcError).code).toBe('audience_mismatch');
  });

  test('expired: exp in the past', async () => {
    const v = newVerifier();
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      defaultClaims({ iat: now - 7200, exp: now - 3600 }),
    );
    let caught: unknown;
    try {
      await v.verifyIdToken(token);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OidcError);
    expect((caught as OidcError).code).toBe('expired');
  });

  test('expired: iat far in the future', async () => {
    const v = newVerifier();
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      defaultClaims({ iat: now + 3600, exp: now + 7200 }),
    );
    let caught: unknown;
    try {
      await v.verifyIdToken(token);
    } catch (e) {
      caught = e;
    }
    expect((caught as OidcError).code).toBe('expired');
  });

  test('email_unverified: claim is false', async () => {
    const v = newVerifier();
    const token = await signToken(defaultClaims({ email_verified: false }));
    let caught: unknown;
    try {
      await v.verifyIdToken(token);
    } catch (e) {
      caught = e;
    }
    expect((caught as OidcError).code).toBe('email_unverified');
  });

  test('email_unverified: claim missing', async () => {
    const v = newVerifier();
    const claims = defaultClaims();
    delete claims.email_verified;
    const token = await signToken(claims);
    let caught: unknown;
    try {
      await v.verifyIdToken(token);
    } catch (e) {
      caught = e;
    }
    expect((caught as OidcError).code).toBe('email_unverified');
  });

  test('email_unverified: claim is the string "true" (not boolean)', async () => {
    const v = newVerifier();
    const token = await signToken(defaultClaims({ email_verified: 'true' }));
    let caught: unknown;
    try {
      await v.verifyIdToken(token);
    } catch (e) {
      caught = e;
    }
    expect((caught as OidcError).code).toBe('email_unverified');
  });

  test('no_email: email claim missing', async () => {
    const v = newVerifier();
    const claims = defaultClaims();
    delete claims.email;
    const token = await signToken(claims);
    let caught: unknown;
    try {
      await v.verifyIdToken(token);
    } catch (e) {
      caught = e;
    }
    expect((caught as OidcError).code).toBe('no_email');
  });

  test('no_email: email is whitespace', async () => {
    const v = newVerifier();
    const token = await signToken(defaultClaims({ email: '   ' }));
    let caught: unknown;
    try {
      await v.verifyIdToken(token);
    } catch (e) {
      caught = e;
    }
    expect((caught as OidcError).code).toBe('no_email');
  });
});

describe('OidcVerifier JWKS rotation', () => {
  test('rotates: new kid + new key triggers JWKS refetch and verifies', async () => {
    const v = newVerifier();
    // Warm cache with current key.
    const t1 = await signToken(defaultClaims());
    await v.verifyIdToken(t1);
    const jwksHitsBefore = jwksHits;

    // Rotate active key. Old kid is no longer in the JWKS.
    activeKey = await makeKey('key-2');

    // First verify with new kid: jose's remote set will refetch on
    // unknown kid; our cache is also cleared on JWKSNoMatchingKey.
    const t2 = await signToken(defaultClaims());
    const id = await v.verifyIdToken(t2);
    expect(id.email).toBe('alice@example.com');
    expect(jwksHits).toBeGreaterThan(jwksHitsBefore);
  });
});

describe('OidcVerifier exchangeCodeForTokens', () => {
  test('exchanges code for id_token and access_token', async () => {
    const v = newVerifier();
    tokenEndpointResponse = null;
    const result = await v.exchangeCodeForTokens('the-code', `${baseUrl}/cb`);
    expect(typeof result.id_token).toBe('string');
    expect(result.id_token.split('.')).toHaveLength(3);
    expect(result.access_token).toBe('access-abc');
  });

  test('throws OidcError(malformed) when token endpoint omits id_token', async () => {
    const v = newVerifier();
    tokenEndpointResponse = {
      status: 200,
      body: JSON.stringify({ access_token: 'only-access' }),
    };
    let caught: unknown;
    try {
      await v.exchangeCodeForTokens('the-code', `${baseUrl}/cb`);
    } catch (e) {
      caught = e;
    } finally {
      tokenEndpointResponse = null;
    }
    expect(caught).toBeInstanceOf(OidcError);
    expect((caught as OidcError).code).toBe('malformed');
  });

  test('throws OidcError(discovery_failed) on non-2xx token response', async () => {
    const v = newVerifier();
    tokenEndpointResponse = {
      status: 400,
      body: JSON.stringify({ error: 'invalid_grant' }),
    };
    let caught: unknown;
    try {
      await v.exchangeCodeForTokens('the-code', `${baseUrl}/cb`);
    } catch (e) {
      caught = e;
    } finally {
      tokenEndpointResponse = null;
    }
    expect(caught).toBeInstanceOf(OidcError);
    expect((caught as OidcError).code).toBe('discovery_failed');
  });

  test('throws when clientSecret is missing', async () => {
    const v = new OidcVerifier({ issuerUrl: issuer, clientId: CLIENT_ID });
    let caught: unknown;
    try {
      await v.exchangeCodeForTokens('the-code', `${baseUrl}/cb`);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(OidcError);
  });
});
