/**
 * Unit tests for the OPT-IN Google-Workspace login gate
 * (src/core/oauth-google-login.ts).
 *
 * Pure-function coverage: state sign/verify (tamper + expiry rejected),
 * session sign/verify, id_token verification (reject wrong aud / wrong iss /
 * expired / wrong hd / email_verified=false / bad signature) using a locally
 * generated RSA keypair to mint test id_tokens and a stub JWKS, build-auth-url
 * shape, the open-redirect guard, and the fail-fast config resolver.
 *
 * No network, no DB, no Express — every function under test is pure given its
 * inputs (id_token verification takes the JWKS as an argument).
 */

import { describe, test, expect } from 'bun:test';
import { generateKeyPairSync, createSign, createHash, randomUUID } from 'node:crypto';
import {
  resolveGoogleLoginConfig,
  base64urlEncode,
  base64urlDecode,
  signState,
  verifyState,
  signSession,
  verifySession,
  signPkce,
  verifyPkce,
  generateCodeVerifier,
  codeChallengeS256,
  generateNonce,
  safeReturnUrl,
  buildGoogleAuthUrl,
  verifyGoogleIdToken,
  IdTokenError,
  GOOGLE_AUTH_URL,
  type GoogleJwks,
  type IdTokenClaims,
} from '../src/core/oauth-google-login.ts';

const SECRET = 'test-session-secret-which-is-long-enough';
const NOW = 1_900_000_000; // fixed reference time for deterministic exp checks

// ---------------------------------------------------------------------------
// resolveGoogleLoginConfig (fail-fast)
// ---------------------------------------------------------------------------

describe('resolveGoogleLoginConfig', () => {
  test('returns undefined (gate OFF) when --oauth-login-hd is unset', () => {
    expect(resolveGoogleLoginConfig({})).toBeUndefined();
    expect(resolveGoogleLoginConfig({ oauthLoginHd: '   ' })).toBeUndefined();
  });

  test('throws naming each missing required flag when hd is set', () => {
    expect(() => resolveGoogleLoginConfig({ oauthLoginHd: 'example.com' })).toThrow(
      /--oauth-google-client-id/,
    );
    try {
      resolveGoogleLoginConfig({ oauthLoginHd: 'example.com', oauthGoogleClientId: 'id' });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      // The "... are missing" clause names exactly the two unsupplied flags.
      const missingClause = msg.split(' are missing')[0];
      expect(missingClause).toContain('--oauth-google-client-secret');
      expect(missingClause).toContain('--oauth-session-secret');
      expect(missingClause).not.toContain('--oauth-google-client-id');
    }
  });

  test('resolves a full config when all flags present', () => {
    const cfg = resolveGoogleLoginConfig({
      oauthLoginHd: 'example.com',
      oauthGoogleClientId: 'cid',
      oauthGoogleClientSecret: 'csecret',
      oauthSessionSecret: 'ssecret',
    });
    expect(cfg).toEqual({
      hd: 'example.com',
      clientId: 'cid',
      clientSecret: 'csecret',
      sessionSecret: 'ssecret',
    });
  });
});

// ---------------------------------------------------------------------------
// signState / verifyState
// ---------------------------------------------------------------------------

describe('signState / verifyState', () => {
  const payload = { return_url: '/authorize?x=1', nonce: randomUUID(), exp: NOW + 600 };

  test('round-trips a valid state', () => {
    const value = signState(payload, SECRET);
    expect(verifyState(value, SECRET, NOW)).toEqual(payload);
  });

  test('rejects a tampered body', () => {
    const value = signState(payload, SECRET);
    const [body, sig] = value.split('.');
    const tampered =
      base64urlEncode(JSON.stringify({ ...payload, return_url: 'https://evil.example/authorize' })) +
      '.' +
      sig;
    expect(verifyState(tampered, SECRET, NOW)).toBeNull();
    void body;
  });

  test('rejects a wrong signature / wrong secret', () => {
    const value = signState(payload, SECRET);
    expect(verifyState(value, 'different-secret', NOW)).toBeNull();
  });

  test('rejects an expired state (beyond clock skew)', () => {
    const expired = { ...payload, exp: NOW - 600 };
    const value = signState(expired, SECRET);
    expect(verifyState(value, SECRET, NOW)).toBeNull();
  });

  test('rejects malformed input', () => {
    expect(verifyState(undefined, SECRET, NOW)).toBeNull();
    expect(verifyState('', SECRET, NOW)).toBeNull();
    expect(verifyState('no-dot', SECRET, NOW)).toBeNull();
    expect(verifyState('.onlysig', SECRET, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// signSession / verifySession
// ---------------------------------------------------------------------------

describe('signSession / verifySession', () => {
  const payload = { email: 'alice@example.com', exp: NOW + 3600 };

  test('round-trips a valid session', () => {
    const value = signSession(payload, SECRET);
    expect(verifySession(value, SECRET, NOW)).toEqual(payload);
  });

  test('rejects tamper, wrong secret, and expiry', () => {
    const value = signSession(payload, SECRET);
    const [, sig] = value.split('.');
    const tampered = base64urlEncode(JSON.stringify({ email: 'evil@elsewhere.com', exp: payload.exp })) + '.' + sig;
    expect(verifySession(tampered, SECRET, NOW)).toBeNull();
    expect(verifySession(value, 'nope', NOW)).toBeNull();
    expect(verifySession(signSession({ email: 'a@b.c', exp: NOW - 1 }, SECRET), SECRET, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// safeReturnUrl (open-redirect guard)
// ---------------------------------------------------------------------------

describe('safeReturnUrl', () => {
  const base = 'https://brain.example.com';

  test('accepts same-origin /authorize path (relative)', () => {
    expect(safeReturnUrl('/authorize?response_type=code', base)).toBe(
      'https://brain.example.com/authorize?response_type=code',
    );
  });

  test('accepts same-origin /authorize path (absolute)', () => {
    expect(safeReturnUrl('https://brain.example.com/authorize?a=1', base)).toBe(
      'https://brain.example.com/authorize?a=1',
    );
  });

  test('rejects off-origin redirect', () => {
    expect(safeReturnUrl('https://evil.example.com/authorize', base)).toBeNull();
    expect(safeReturnUrl('//evil.example.com/authorize', base)).toBeNull();
  });

  test('rejects non-/authorize paths', () => {
    expect(safeReturnUrl('/admin', base)).toBeNull();
    expect(safeReturnUrl('/authorized-evil', base)).toBeNull();
    expect(safeReturnUrl('https://brain.example.com/mcp', base)).toBeNull();
  });

  test('rejects unparseable input', () => {
    expect(safeReturnUrl('http://[bad', base)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildGoogleAuthUrl
// ---------------------------------------------------------------------------

describe('buildGoogleAuthUrl', () => {
  test('builds the Google auth URL with the required params (incl. PKCE + nonce)', () => {
    const url = new URL(
      buildGoogleAuthUrl({
        clientId: 'cid',
        redirectUri: 'https://brain.example.com/login/google/callback',
        hd: 'example.com',
        state: 'STATEVALUE',
        codeChallenge: 'CHALLENGE',
        nonce: 'NONCEVALUE',
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_URL);
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://brain.example.com/login/google/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email');
    expect(url.searchParams.get('hd')).toBe('example.com');
    expect(url.searchParams.get('access_type')).toBe('online');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('state')).toBe('STATEVALUE');
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBe('NONCEVALUE');
  });
});

// ---------------------------------------------------------------------------
// PKCE helpers + signed PKCE/nonce cookie
// ---------------------------------------------------------------------------

describe('PKCE helpers', () => {
  test('generateCodeVerifier produces a 43+ char base64url string', () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(/^[A-Za-z0-9_-]+$/.test(v)).toBe(true);
  });

  test('codeChallengeS256 is base64url(SHA256(verifier)) and deterministic', () => {
    const v = generateCodeVerifier();
    const c1 = codeChallengeS256(v);
    const c2 = codeChallengeS256(v);
    expect(c1).toBe(c2);
    expect(/^[A-Za-z0-9_-]+$/.test(c1)).toBe(true);
    // Different verifiers → different challenges.
    expect(codeChallengeS256(generateCodeVerifier())).not.toBe(c1);
  });

  test('generateNonce is non-empty base64url', () => {
    const n = generateNonce();
    expect(n.length).toBeGreaterThan(0);
    expect(/^[A-Za-z0-9_-]+$/.test(n)).toBe(true);
  });
});

describe('signPkce / verifyPkce', () => {
  const payload = { verifier: generateCodeVerifier(), nonce: generateNonce(), exp: NOW + 600 };

  test('round-trips a valid PKCE/nonce cookie', () => {
    const value = signPkce(payload, SECRET);
    expect(verifyPkce(value, SECRET, NOW)).toEqual(payload);
  });

  test('rejects tamper, wrong secret, and expiry', () => {
    const value = signPkce(payload, SECRET);
    const [, sig] = value.split('.');
    const tampered = base64urlEncode(JSON.stringify({ ...payload, verifier: 'attacker' })) + '.' + sig;
    expect(verifyPkce(tampered, SECRET, NOW)).toBeNull();
    expect(verifyPkce(value, 'nope', NOW)).toBeNull();
    expect(verifyPkce(signPkce({ ...payload, exp: NOW - 600 }, SECRET), SECRET, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyGoogleIdToken — locally-minted RSA keypair + stub JWKS
// ---------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-kid-1';

function stubJwks(): GoogleJwks {
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return { keys: [{ kid: KID, kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig' }] };
}

function mintIdToken(
  claims: Partial<IdTokenClaims>,
  opts: { kid?: string; alg?: string; signWith?: 'good' | 'bad' } = {},
): string {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? KID, typ: 'JWT' };
  const body: IdTokenClaims = {
    iss: 'https://accounts.google.com',
    aud: 'cid',
    sub: '12345',
    email: 'alice@example.com',
    email_verified: true,
    hd: 'example.com',
    exp: NOW + 600,
    iat: NOW,
    ...claims,
  };
  const headerB64 = base64urlEncode(JSON.stringify(header));
  const payloadB64 = base64urlEncode(JSON.stringify(body));
  const signingInput = `${headerB64}.${payloadB64}`;

  let signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  // A bad signature: sign with a DIFFERENT freshly-generated key.
  const keyToUse =
    opts.signWith === 'bad'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      : privateKey;
  const sig = base64urlEncode(signer.sign(keyToUse));
  return `${signingInput}.${sig}`;
}

const VERIFY_OPTS = { clientId: 'cid', hd: 'example.com', now: NOW };

describe('verifyGoogleIdToken', () => {
  test('accepts a fully-valid id_token', () => {
    const token = mintIdToken({});
    const claims = verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS);
    expect(claims.email).toBe('alice@example.com');
    expect(claims.hd).toBe('example.com');
  });

  test('accepts the bare-domain iss form', () => {
    const token = mintIdToken({ iss: 'accounts.google.com' });
    expect(verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS).email).toBe('alice@example.com');
  });

  test('rejects a bad signature (signed with a different key)', () => {
    const token = mintIdToken({}, { signWith: 'bad' });
    expect(() => verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS)).toThrow(IdTokenError);
    expect(() => verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS)).toThrow(/signature/);
  });

  test('rejects wrong aud', () => {
    const token = mintIdToken({ aud: 'someone-else' });
    expect(() => verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS)).toThrow(/aud/);
  });

  test('rejects wrong iss', () => {
    const token = mintIdToken({ iss: 'https://evil.example.com' });
    expect(() => verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS)).toThrow(/iss/);
  });

  test('rejects an expired token', () => {
    const token = mintIdToken({ exp: NOW - 600 });
    expect(() => verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS)).toThrow(/expired/);
  });

  test('rejects wrong hosted domain', () => {
    const token = mintIdToken({ hd: 'other-company.com' });
    expect(() => verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS)).toThrow(/hosted domain/);
  });

  test('rejects a missing hd claim', () => {
    const token = mintIdToken({ hd: undefined });
    expect(() => verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS)).toThrow(/hosted domain/);
  });

  test('rejects email_verified=false', () => {
    const token = mintIdToken({ email_verified: false });
    expect(() => verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS)).toThrow(/not verified/);
  });

  test('rejects alg=none', () => {
    const token = mintIdToken({}, { alg: 'none' });
    expect(() => verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS)).toThrow(/alg/);
  });

  test('rejects alg=HS256 (RS/HS confusion) before any signature work', () => {
    const token = mintIdToken({}, { alg: 'HS256' });
    expect(() => verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS)).toThrow(/alg/);
  });

  test('rejects email_verified absent (undefined), not only false', () => {
    const token = mintIdToken({ email_verified: undefined });
    expect(() => verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS)).toThrow(/not verified/);
  });

  test('rejects when no JWKS key matches the kid', () => {
    const token = mintIdToken({}, { kid: 'unknown-kid' });
    expect(() => verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS)).toThrow(/JWKS key/);
  });

  test('rejects a non-JWT shaped token', () => {
    expect(() => verifyGoogleIdToken('not.a', stubJwks(), VERIFY_OPTS)).toThrow(/well-formed/);
  });

  // Nonce binding (MEDIUM-2). When an expected nonce is supplied, the id_token's
  // nonce claim must match it constant-time; a mismatch or a missing claim is
  // rejected. When no nonce is expected (pure-function callers), it's skipped.
  test('accepts a matching nonce when one is expected', () => {
    const token = mintIdToken({ nonce: 'expected-nonce' });
    const claims = verifyGoogleIdToken(token, stubJwks(), { ...VERIFY_OPTS, nonce: 'expected-nonce' });
    expect(claims.email).toBe('alice@example.com');
  });

  test('rejects a mismatched nonce', () => {
    const token = mintIdToken({ nonce: 'attacker-nonce' });
    expect(() => verifyGoogleIdToken(token, stubJwks(), { ...VERIFY_OPTS, nonce: 'expected-nonce' })).toThrow(/nonce/);
  });

  test('rejects a missing nonce claim when one is expected', () => {
    const token = mintIdToken({ nonce: undefined });
    expect(() => verifyGoogleIdToken(token, stubJwks(), { ...VERIFY_OPTS, nonce: 'expected-nonce' })).toThrow(/nonce/);
  });

  test('skips the nonce check when no expected nonce is supplied', () => {
    const token = mintIdToken({ nonce: 'whatever' });
    expect(verifyGoogleIdToken(token, stubJwks(), VERIFY_OPTS).email).toBe('alice@example.com');
  });
});
