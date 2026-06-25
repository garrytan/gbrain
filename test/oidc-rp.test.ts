/**
 * OIDC relying-party federation unit tests (oidc-rp.ts).
 *
 * Pure config/mapping helpers + an offline end-to-end of createOidcRp: a local
 * RS256 key signs an id_token, fetch is stubbed for discovery + token exchange,
 * and the JWKS resolver is injected (getKey) so verification runs with no
 * network. Mirrors the offline-verifier approach in cf-access-auth's tests.
 */

import { describe, test, expect } from 'bun:test';
import { SignJWT, generateKeyPair } from 'jose';
import { createHash } from 'crypto';
import {
  resolveOidcRpConfig,
  parseGroupScopeMap,
  generatePkcePair,
  mapIdentityToScopes,
  clampScopes,
  extractGroups,
  createOidcRp,
  OidcRpError,
  type OidcRpConfig,
} from '../src/core/oidc-rp.ts';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('resolveOidcRpConfig', () => {
  test('disabled by default (no env)', () => {
    const c = resolveOidcRpConfig({});
    expect(c.enabled).toBe(false);
  });

  test('enabled only when ALL required fields present', () => {
    const base = {
      GBRAIN_OIDC_ENABLED: 'true',
      GBRAIN_OIDC_ISSUER: 'https://idp.example.com/oidc/abc',
      GBRAIN_OIDC_CLIENT_ID: 'cid',
      GBRAIN_OIDC_CLIENT_SECRET: 'secret',
      GBRAIN_OIDC_REDIRECT_URI: 'https://brain.example.com/oidc/callback',
    };
    expect(resolveOidcRpConfig(base).enabled).toBe(true);
    // Missing any one required field → fail closed to disabled.
    for (const k of ['GBRAIN_OIDC_ISSUER', 'GBRAIN_OIDC_CLIENT_ID', 'GBRAIN_OIDC_CLIENT_SECRET', 'GBRAIN_OIDC_REDIRECT_URI']) {
      const env = { ...base, [k]: '' };
      expect(resolveOidcRpConfig(env).enabled).toBe(false);
    }
  });

  test('trailing slash stripped from issuer; defaults applied', () => {
    const c = resolveOidcRpConfig({
      GBRAIN_OIDC_ENABLED: '1',
      GBRAIN_OIDC_ISSUER: 'https://idp.example.com/oidc/abc/',
      GBRAIN_OIDC_CLIENT_ID: 'cid',
      GBRAIN_OIDC_CLIENT_SECRET: 'secret',
      GBRAIN_OIDC_REDIRECT_URI: 'https://brain.example.com/oidc/callback',
    });
    expect(c.issuer).toBe('https://idp.example.com/oidc/abc');
    expect(c.defaultScope).toBe('read');
  });
});

describe('parseGroupScopeMap', () => {
  test('valid object kept; non-string values dropped; malformed → {}', () => {
    expect(parseGroupScopeMap('{"bravurasecurity.com":"read write","g1":"admin"}')).toEqual({
      'bravurasecurity.com': 'read write',
      g1: 'admin',
    });
    expect(parseGroupScopeMap('{"g":123,"h":"read"}')).toEqual({ h: 'read' });
    expect(parseGroupScopeMap('not json')).toEqual({});
    expect(parseGroupScopeMap('[1,2]')).toEqual({});
    expect(parseGroupScopeMap(undefined)).toEqual({});
  });
});

describe('generatePkcePair', () => {
  test('challenge is base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(base64url(createHash('sha256').update(verifier).digest()));
    // base64url charset only (no +/=)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('mapIdentityToScopes + clampScopes', () => {
  const cfg = { groupScopeMap: { 'bravurasecurity.com': 'read write', admins: 'admin' }, defaultScope: 'read' };

  test('email domain match', () => {
    expect(new Set(mapIdentityToScopes({ email: 'a@bravurasecurity.com', groups: [] }, cfg))).toEqual(
      new Set(['read', 'write']),
    );
  });

  test('group match unions with domain', () => {
    const scopes = mapIdentityToScopes({ email: 'a@bravurasecurity.com', groups: ['admins'] }, cfg);
    expect(new Set(scopes)).toEqual(new Set(['read', 'write', 'admin']));
  });

  test('no match falls back to defaultScope', () => {
    expect(mapIdentityToScopes({ email: 'x@other.com', groups: [] }, cfg)).toEqual(['read']);
  });

  test('clampScopes intersects requested with identity (admin implies read)', () => {
    expect(clampScopes(['read', 'write', 'admin'], ['read', 'write'])).toEqual(['read', 'write']);
    // admin identity satisfies a read request via hasScope implication
    expect(clampScopes(['read'], ['admin'])).toEqual(['read']);
    // requesting more than identity allows is dropped
    expect(clampScopes(['admin'], ['read'])).toEqual([]);
  });
});

describe('extractGroups', () => {
  test('array / single string / custom.groups / missing', () => {
    expect(extractGroups({ groups: ['a', 'b'] } as any)).toEqual(['a', 'b']);
    expect(extractGroups({ groups: 'solo' } as any)).toEqual(['solo']);
    expect(extractGroups({ custom: { groups: ['c'] } } as any)).toEqual(['c']);
    expect(extractGroups({} as any)).toEqual([]);
  });
});

describe('createOidcRp.exchangeCode (offline)', () => {
  const issuer = 'https://idp.example.com/oidc/abc';
  const clientId = 'test-client-id';

  async function setup() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const config: OidcRpConfig = {
      enabled: true,
      issuer,
      clientId,
      clientSecret: 'shh',
      redirectUri: 'https://brain.example.com/oidc/callback',
      groupScopeMap: {},
      defaultScope: 'read',
    };
    const sign = async (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuedAt()
        .setIssuer(issuer)
        .setAudience(clientId)
        .setExpirationTime('5m')
        .sign(privateKey);
    // fetch stub: discovery doc + token endpoint.
    const makeFetch =
      (idToken: string): typeof fetch =>
      (async (url: string | URL | Request) => {
        const u = String(url);
        if (u.endsWith('/.well-known/openid-configuration')) {
          return new Response(
            JSON.stringify({
              issuer,
              authorization_endpoint: `${issuer}/authorization`,
              token_endpoint: `${issuer}/token`,
              jwks_uri: `${issuer}/jwks`,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u === `${issuer}/token`) {
          return new Response(JSON.stringify({ id_token: idToken, token_type: 'Bearer' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch;
    return { config, publicKey, sign, makeFetch };
  }

  test('happy path: verified identity with email + groups + nonce', async () => {
    const { config, publicKey, sign, makeFetch } = await setup();
    const idToken = await sign({ email: 'Bart.Allan@bravurasecurity.com', groups: ['staff'], nonce: 'n1' });
    const rp = createOidcRp(config, { getKey: (async () => publicKey) as any, fetchImpl: makeFetch(idToken) });
    const identity = await rp.exchangeCode('code', 'verifier', 'n1');
    expect(identity.email).toBe('bart.allan@bravurasecurity.com'); // lowercased
    expect(identity.groups).toEqual(['staff']);
    expect(identity.subject).toBeDefined();
  });

  test('nonce mismatch rejected', async () => {
    const { config, publicKey, sign, makeFetch } = await setup();
    const idToken = await sign({ email: 'a@bravurasecurity.com', nonce: 'n1' });
    const rp = createOidcRp(config, { getKey: (async () => publicKey) as any, fetchImpl: makeFetch(idToken) });
    await expect(rp.exchangeCode('code', 'verifier', 'WRONG')).rejects.toMatchObject({ code: 'nonce_mismatch' });
  });

  test('missing email rejected', async () => {
    const { config, publicKey, sign, makeFetch } = await setup();
    const idToken = await sign({ nonce: 'n1' });
    const rp = createOidcRp(config, { getKey: (async () => publicKey) as any, fetchImpl: makeFetch(idToken) });
    await expect(rp.exchangeCode('code', 'verifier', 'n1')).rejects.toMatchObject({ code: 'missing_email' });
  });

  test('discovery issuer mismatch fails closed', async () => {
    const { config, publicKey, sign } = await setup();
    const idToken = await sign({ email: 'a@bravurasecurity.com', nonce: 'n1' });
    const badFetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/.well-known/openid-configuration')) {
        return new Response(
          JSON.stringify({
            issuer: 'https://evil.example.com',
            authorization_endpoint: `${issuer}/authorization`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const rp = createOidcRp(config, { getKey: (async () => publicKey) as any, fetchImpl: badFetch });
    await expect(rp.exchangeCode('code', 'verifier', 'n1')).rejects.toMatchObject({ code: 'discovery_failed' });
  });

  test('createOidcRp throws on disabled config', () => {
    expect(() => createOidcRp({ enabled: false } as OidcRpConfig)).toThrow(OidcRpError);
  });
});
