/**
 * Google-Workspace login gate for the browser OAuth `authorization_code` flow.
 *
 * OPT-IN. Everything here is dormant unless `serve --http` is started with
 * `--oauth-login-hd <domain>`. When the gate is enabled, a remote MCP client
 * (Claude Code) doing the browser `/authorize` flow must first sign in with a
 * Google account on the allowed hosted domain (`hd`) before gbrain's OAuth
 * provider issues an authorization code. This makes Dynamic Client
 * Registration safe to enable: today `/authorize` issues a code to anyone.
 *
 * This module is dependency-light and fully unit-testable. It holds only pure
 * functions plus a small JWKS cache; no Express, no DB, no process state. The
 * wiring (routes, cookies, redirects) lives in `src/commands/serve-http.ts`.
 *
 * JWT/JWKS: gbrain has no `jose` dependency (checked package.json), so RS256
 * verification is implemented with Node's built-in `crypto`. We verify the
 * Google-minted `id_token` against Google's published JWKS rather than trusting
 * the token endpoint response blindly.
 *
 * Google OIDC endpoints (constants, not config — they are stable and public):
 *   - authorization:  https://accounts.google.com/o/oauth2/v2/auth
 *   - token:          https://oauth2.googleapis.com/token
 *   - JWKS:           https://www.googleapis.com/oauth2/v3/certs
 */

import {
  createHash,
  createHmac,
  createPublicKey,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/**
 * Accepted `iss` claim values for a Google-minted id_token. Google emits one
 * of these two forms; both are valid per the OIDC discovery document.
 */
export const GOOGLE_ISSUERS = new Set<string>([
  'accounts.google.com',
  'https://accounts.google.com',
]);

/** Default login-session cookie name. Mirrors the `gbrain_admin` cookie style. */
export const LOGIN_SESSION_COOKIE = 'gbrain_login';

/**
 * Short-lived cookie that carries the PKCE `code_verifier` + OIDC `nonce` for
 * the gbrain↔Google round-trip, bound to THIS browser. Scoped to the callback
 * path and signed with the session secret. Cleared after the callback runs.
 */
export const LOGIN_PKCE_COOKIE = 'gbrain_login_pkce';

/** Clock-skew leeway (seconds) applied to `exp` checks on state + id_token. */
export const CLOCK_SKEW_SECONDS = 60;

/** Login-session TTL (seconds). ~12h, per spec. */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** Signed-state TTL (seconds). Short — the login round-trip is interactive. */
export const STATE_TTL_SECONDS = 10 * 60;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Resolved Google login-gate configuration. Constructed once at startup by
 * `resolveGoogleLoginConfig` from the CLI flags. When the gate is disabled the
 * whole object is `undefined` and the middleware is a pass-through.
 */
export interface GoogleLoginConfig {
  /** Allowed Google hosted domain (the `hd` claim), e.g. `raavasolutions.com`. */
  hd: string;
  /** Google OAuth client id (web application credentials). */
  clientId: string;
  /** Google OAuth client secret. */
  clientSecret: string;
  /** HMAC key used to sign both the login-session cookie and the state value. */
  sessionSecret: string;
}

export interface GoogleLoginFlags {
  oauthLoginHd?: string;
  oauthGoogleClientId?: string;
  oauthGoogleClientSecret?: string;
  oauthSessionSecret?: string;
}

/**
 * Fail-fast resolver. Returns `undefined` when `--oauth-login-hd` is unset
 * (gate OFF — byte-for-byte unchanged behavior). When `--oauth-login-hd` IS
 * set, the google client id/secret and session secret are all REQUIRED;
 * throwing here makes the server refuse to start with a clear error rather
 * than half-enabling the gate.
 */
export function resolveGoogleLoginConfig(flags: GoogleLoginFlags): GoogleLoginConfig | undefined {
  const hd = flags.oauthLoginHd?.trim();
  if (!hd) return undefined;

  const missing: string[] = [];
  const clientId = flags.oauthGoogleClientId?.trim();
  const clientSecret = flags.oauthGoogleClientSecret?.trim();
  const sessionSecret = flags.oauthSessionSecret?.trim();
  if (!clientId) missing.push('--oauth-google-client-id');
  if (!clientSecret) missing.push('--oauth-google-client-secret');
  if (!sessionSecret) missing.push('--oauth-session-secret');

  if (missing.length > 0) {
    throw new Error(
      `--oauth-login-hd is set (Google login gate enabled) but ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} missing. ` +
        'All of --oauth-google-client-id, --oauth-google-client-secret, and ' +
        '--oauth-session-secret are required when the gate is on.',
    );
  }

  return { hd, clientId: clientId!, clientSecret: clientSecret!, sessionSecret: sessionSecret! };
}

// ---------------------------------------------------------------------------
// base64url helpers (no external dep)
// ---------------------------------------------------------------------------

export function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * Constant-time string compare for HMAC signatures. Length mismatch returns
 * false without throwing (callers route to a clean rejection).
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function hmac(secret: string, data: string): string {
  return base64urlEncode(createHmac('sha256', secret).update(data).digest());
}

// ---------------------------------------------------------------------------
// PKCE (RFC 7636) — binds the gbrain↔Google leg to one browser
// ---------------------------------------------------------------------------

/**
 * Generate a high-entropy PKCE `code_verifier` (RFC 7636 §4.1). 32 random
 * bytes → 43-char base64url string, well within the 43–128 char range the RFC
 * mandates. Pure aside from the CSPRNG.
 */
export function generateCodeVerifier(): string {
  return base64urlEncode(randomBytes(32));
}

/**
 * Derive the S256 `code_challenge` from a `code_verifier` (RFC 7636 §4.2):
 * `base64url(SHA256(ASCII(verifier)))`. Pure.
 */
export function codeChallengeS256(verifier: string): string {
  return base64urlEncode(createHash('sha256').update(verifier).digest());
}

/**
 * Generate a random OIDC `nonce` to bind the id_token to this login attempt
 * (replay defense). 16 random bytes → base64url. Pure aside from the CSPRNG.
 */
export function generateNonce(): string {
  return base64urlEncode(randomBytes(16));
}

// ---------------------------------------------------------------------------
// Signed state (CSRF + return-url carrier for the Google round-trip)
// ---------------------------------------------------------------------------

export interface StatePayload {
  /** The original `/authorize` URL (path + query) to redirect back to. */
  return_url: string;
  /** Random nonce; binds this state value to one login attempt. */
  nonce: string;
  /** Expiry, Unix epoch seconds. */
  exp: number;
}

/**
 * Sign a state payload as `<base64url(json)>.<hmac>`. The HMAC covers the
 * encoded payload so any tamper (return_url, nonce, exp) invalidates it.
 */
export function signState(payload: StatePayload, secret: string): string {
  const body = base64urlEncode(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}

/**
 * Verify + decode a signed state value. Returns the payload on success, or
 * `null` on any failure: malformed, bad signature, or expired. Pure — caller
 * supplies `now` for deterministic tests (defaults to wall clock).
 */
export function verifyState(
  value: string | undefined,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): StatePayload | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!safeEqual(sig, hmac(secret, body))) return null;
  let payload: StatePayload;
  try {
    payload = JSON.parse(base64urlDecode(body).toString('utf8')) as StatePayload;
  } catch {
    return null;
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof payload.return_url !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  if (payload.exp + CLOCK_SKEW_SECONDS < now) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Signed session cookie ({email, exp})
// ---------------------------------------------------------------------------

export interface SessionPayload {
  email: string;
  /** Expiry, Unix epoch seconds. */
  exp: number;
}

export function signSession(payload: SessionPayload, secret: string): string {
  const body = base64urlEncode(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}

/**
 * Verify + decode a session cookie. Returns the payload on success, `null` on
 * malformed / bad-signature / expired. No clock-skew leeway on the session
 * (it is our own cookie; a 12h TTL has ample margin).
 */
export function verifySession(
  value: string | undefined,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): SessionPayload | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!safeEqual(sig, hmac(secret, body))) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(base64urlDecode(body).toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof payload.email !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  if (payload.exp < now) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Signed PKCE/nonce cookie ({verifier, nonce, exp}) — browser binding
// ---------------------------------------------------------------------------

export interface PkcePayload {
  /** PKCE code_verifier sent to Google's token endpoint on the callback. */
  verifier: string;
  /** OIDC nonce; must equal the id_token's `nonce` claim on the callback. */
  nonce: string;
  /** Expiry, Unix epoch seconds. */
  exp: number;
}

/**
 * Sign a PKCE/nonce payload as `<base64url(json)>.<hmac>`, identical in shape to
 * the state + session carriers. The cookie holding this is HttpOnly + Secure +
 * SameSite=Lax + path-scoped to the callback, so a valid value is bound to the
 * browser that started the login.
 */
export function signPkce(payload: PkcePayload, secret: string): string {
  const body = base64urlEncode(JSON.stringify(payload));
  return `${body}.${hmac(secret, body)}`;
}

/**
 * Verify + decode the PKCE/nonce cookie. Returns the payload on success, `null`
 * on malformed / bad-signature / expired (with CLOCK_SKEW_SECONDS leeway, like
 * the state carrier). Pure — caller supplies `now` for deterministic tests.
 */
export function verifyPkce(
  value: string | undefined,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
): PkcePayload | null {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!safeEqual(sig, hmac(secret, body))) return null;
  let payload: PkcePayload;
  try {
    payload = JSON.parse(base64urlDecode(body).toString('utf8')) as PkcePayload;
  } catch {
    return null;
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof payload.verifier !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  if (payload.exp + CLOCK_SKEW_SECONDS < now) return null;
  return payload;
}

// ---------------------------------------------------------------------------
// Open-redirect guard
// ---------------------------------------------------------------------------

/**
 * Only allow a `return_url` that is same-origin as `publicBaseUrl` AND whose
 * path is prefixed `/authorize`. Returns the safe absolute URL string on
 * success, or `null` on rejection (off-origin, wrong path, unparseable).
 *
 * This is the open-redirect guard required by the spec: a signed state value
 * could in principle be replayed, but the destination is still constrained to
 * this server's `/authorize` so it can never bounce a browser to an attacker
 * origin.
 */
export function safeReturnUrl(returnUrl: string, publicBaseUrl: string): string | null {
  let base: URL;
  let target: URL;
  try {
    base = new URL(publicBaseUrl);
    // Resolve against base so a path-only return_url ("/authorize?...") is
    // accepted and an absolute off-origin URL is caught by the origin check.
    target = new URL(returnUrl, base);
  } catch {
    return null;
  }
  if (target.origin !== base.origin) return null;
  if (target.pathname !== '/authorize' && !target.pathname.startsWith('/authorize/')) {
    return null;
  }
  return target.toString();
}

// ---------------------------------------------------------------------------
// Build Google auth URL
// ---------------------------------------------------------------------------

export interface BuildAuthUrlArgs {
  clientId: string;
  redirectUri: string;
  hd: string;
  state: string;
  /** PKCE S256 challenge (base64url(SHA256(verifier))). */
  codeChallenge: string;
  /** OIDC nonce; echoed back in the id_token's `nonce` claim. */
  nonce: string;
}

/**
 * Build the Google authorization-endpoint URL. Fixed params per spec:
 * `response_type=code`, `scope=openid email`, `access_type=online`,
 * `prompt=select_account`. `hd` constrains the account picker to the allowed
 * hosted domain (defense-in-depth; the id_token `hd` claim is still verified
 * server-side — `hd` here is a hint, the claim check is the boundary).
 *
 * Carries PKCE (`code_challenge` + `code_challenge_method=S256`) and the OIDC
 * `nonce` so the gbrain↔Google leg is bound to one browser: the matching
 * `code_verifier` + `nonce` live in a signed, browser-scoped cookie and are
 * checked on the callback.
 */
export function buildGoogleAuthUrl(args: BuildAuthUrlArgs): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set('client_id', args.clientId);
  u.searchParams.set('redirect_uri', args.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'openid email');
  u.searchParams.set('hd', args.hd);
  u.searchParams.set('access_type', 'online');
  u.searchParams.set('prompt', 'select_account');
  u.searchParams.set('state', args.state);
  u.searchParams.set('code_challenge', args.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('nonce', args.nonce);
  return u.toString();
}

// ---------------------------------------------------------------------------
// JWKS (RS256 id_token verification, no jose dependency)
// ---------------------------------------------------------------------------

/** A single RSA JWK from Google's certs endpoint. */
export interface GoogleJwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

export interface GoogleJwks {
  keys: GoogleJwk[];
}

/**
 * Convert an RSA JWK ({n, e}) into a Node `KeyObject` for signature
 * verification. Uses the JWK import path built into Node's crypto — no PEM
 * hand-assembly, no external dep.
 */
function jwkToKeyObject(jwk: GoogleJwk) {
  return createPublicKey({
    key: { kty: 'RSA', n: jwk.n, e: jwk.e },
    format: 'jwk',
  });
}

/**
 * Decoded JWT shape returned by `verifyGoogleIdToken`. Only the claims we
 * assert on are typed; Google includes more.
 */
export interface IdTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  email_verified?: boolean;
  hd?: string;
  nonce?: string;
  exp: number;
  iat?: number;
  [k: string]: unknown;
}

export class IdTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdTokenError';
  }
}

/**
 * Verify a Google id_token (RS256 JWT) against a JWKS and assert all claims
 * required by the gate. PURE given a JWKS — no network — so it is fully
 * unit-testable with a locally-generated RSA keypair + stub JWKS.
 *
 * Checks, in order:
 *   1. header alg === RS256 and a matching `kid` exists in the JWKS
 *   2. RS256 signature verifies against that key
 *   3. iss ∈ GOOGLE_ISSUERS
 *   4. aud === expectedClientId
 *   5. exp > now (with CLOCK_SKEW_SECONDS leeway)
 *   6. hd === expectedHd
 *   7. email_verified === true
 *   8. nonce === expectedNonce (only when `opts.nonce` is supplied) — binds the
 *      token to the login attempt that minted the matching browser cookie.
 *      Constant-time compared so a mismatch leaks no timing signal.
 *
 * Throws `IdTokenError` with a specific message on the first failed check;
 * returns the decoded claims on success.
 */
export function verifyGoogleIdToken(
  idToken: string,
  jwks: GoogleJwks,
  opts: { clientId: string; hd: string; nonce?: string; now?: number },
): IdTokenClaims {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new IdTokenError('id_token is not a well-formed JWT');
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let claims: IdTokenClaims;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString('utf8'));
  } catch {
    throw new IdTokenError('id_token header is not valid JSON');
  }
  try {
    claims = JSON.parse(base64urlDecode(payloadB64).toString('utf8')) as IdTokenClaims;
  } catch {
    throw new IdTokenError('id_token payload is not valid JSON');
  }

  if (header.alg !== 'RS256') {
    throw new IdTokenError(`unexpected id_token alg ${JSON.stringify(header.alg)}; expected RS256`);
  }
  const jwk = jwks.keys.find(k => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) throw new IdTokenError(`no matching JWKS key for kid ${JSON.stringify(header.kid)}`);

  // RS256 signature verification over `header.payload`.
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const ok = verifier.verify(jwkToKeyObject(jwk), base64urlDecode(sigB64));
  if (!ok) throw new IdTokenError('id_token signature verification failed');

  if (!GOOGLE_ISSUERS.has(claims.iss)) {
    throw new IdTokenError(`unexpected id_token iss ${JSON.stringify(claims.iss)}`);
  }
  if (claims.aud !== opts.clientId) {
    throw new IdTokenError('id_token aud does not match the configured client_id');
  }
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS < now) {
    throw new IdTokenError('id_token is expired');
  }
  if (claims.hd !== opts.hd) {
    throw new IdTokenError(
      `id_token hd ${JSON.stringify(claims.hd)} is not the allowed hosted domain`,
    );
  }
  if (claims.email_verified !== true) {
    throw new IdTokenError('id_token email is not verified');
  }
  // Nonce binding: only enforced when the caller supplies an expected nonce
  // (the gate always does; the pure unit tests can omit it). `safeEqual`
  // returns false on a length mismatch or a missing claim, so a token without
  // a `nonce` claim is rejected when one is expected.
  if (opts.nonce !== undefined) {
    if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, opts.nonce)) {
      throw new IdTokenError('id_token nonce does not match the login attempt');
    }
  }
  return claims;
}

// ---------------------------------------------------------------------------
// JWKS cache (by kid) — runtime network fetch, not unit-tested
// ---------------------------------------------------------------------------

/**
 * Small process-lifetime JWKS cache. Google rotates signing keys; we cache the
 * full keyset and re-fetch when the requested `kid` is absent (key rotation)
 * or the soft TTL has elapsed. `fetchImpl` is injectable for tests.
 */
export class GoogleJwksCache {
  private cached: GoogleJwks | null = null;
  private fetchedAt = 0;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { ttlMs?: number; fetchImpl?: typeof fetch } = {}) {
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000; // 1h soft TTL
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Return a JWKS that contains `kid`. Serves from cache when fresh and the
   * kid is present; otherwise re-fetches Google's certs endpoint once.
   */
  async getForKid(kid: string | undefined): Promise<GoogleJwks> {
    const fresh = this.cached && Date.now() - this.fetchedAt < this.ttlMs;
    const hasKid = !!this.cached && (!kid || this.cached.keys.some(k => k.kid === kid));
    if (fresh && hasKid) return this.cached!;
    return this.refresh();
  }

  private async refresh(): Promise<GoogleJwks> {
    const res = await this.fetchImpl(GOOGLE_CERTS_URL);
    if (!res.ok) throw new IdTokenError(`JWKS fetch failed: ${res.status}`);
    const json = (await res.json()) as GoogleJwks;
    if (!json || !Array.isArray(json.keys)) throw new IdTokenError('JWKS response malformed');
    this.cached = json;
    this.fetchedAt = Date.now();
    return json;
  }
}

// ---------------------------------------------------------------------------
// Token exchange (runtime network call, not unit-tested)
// ---------------------------------------------------------------------------

export interface GoogleTokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/**
 * Exchange a Google authorization `code` for tokens at the Google token
 * endpoint. POSTs the form per OAuth 2.0. `fetchImpl` is injectable for tests.
 */
export async function exchangeGoogleCode(
  args: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    /** PKCE code_verifier matching the code_challenge sent at /authorize. */
    codeVerifier?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<GoogleTokenResponse> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    grant_type: 'authorization_code',
  });
  if (args.codeVerifier !== undefined) body.set('code_verifier', args.codeVerifier);
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new IdTokenError(`Google token exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}
