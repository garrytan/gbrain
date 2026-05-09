/**
 * OIDC id_token verifier.
 *
 * Generic over any OIDC issuer (Google, Apple, Microsoft, Okta, ...).
 * Provides discovery doc caching, JWKS handling via jose's
 * createRemoteJWKSet, fail-closed id_token verification, and an
 * authorization-code -> tokens exchange.
 *
 * The verifier is deliberately conservative: every check is fail-closed
 * and maps cleanly to a typed OidcError code. Callers (oauth-provider,
 * serve-http) can pattern match on the error code and decide how to
 * surface the failure to the end user.
 */

import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
} from 'jose';
import type { JWTPayload, JWTHeaderParameters, FlattenedJWSInput } from 'jose';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
}

export interface VerifiedIdentity {
  email: string;
  emailVerified: boolean;
  subject: string;
  issuer: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
}

export interface DiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

export type OidcErrorCode =
  | 'discovery_failed'
  | 'jwks_failed'
  | 'signature_invalid'
  | 'expired'
  | 'audience_mismatch'
  | 'issuer_mismatch'
  | 'email_unverified'
  | 'no_email'
  | 'malformed';

export class OidcError extends Error {
  constructor(public code: OidcErrorCode, message: string) {
    super(message);
    this.name = 'OidcError';
  }
}

export interface TokenExchangeResult {
  id_token: string;
  access_token: string;
}

export interface VerifyIdTokenOptions {
  /** Expected nonce originally sent on the OIDC authorization request. */
  nonce?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Discovery doc cache TTL in milliseconds. 1 hour matches the typical
 *  Cache-Control max-age served by Google. Exposed as a constant so tests
 *  and tuning can reach it without changing the call sites. */
export const DISCOVERY_CACHE_TTL_MS = 60 * 60 * 1000;

/** Default JWKS cache TTL when no Cache-Control header is present. */
export const DEFAULT_JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

/** Allowed clock skew for iat in the future. Spec is "iat < now + 60s". */
const IAT_FUTURE_SKEW_SECONDS = 60;

/** Trim and lowercase an email per the spec's normalization rule. */
function normalizeEmail(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Discovery + JWKS cache state
// ---------------------------------------------------------------------------

interface DiscoveryCacheEntry {
  doc: DiscoveryDocument;
  fetchedAt: number;
}

interface JwksCacheEntry {
  // jose returns a getKey function; the shape matches JWTVerifyGetKey but
  // we type it loosely here to avoid leaking jose generics across the
  // public API surface.
  getKey: (
    header: JWTHeaderParameters,
    input: FlattenedJWSInput,
  ) => Promise<CryptoKey>;
  fetchedAt: number;
  ttlMs: number;
  jwksUri: string;
}

// ---------------------------------------------------------------------------
// OidcVerifier
// ---------------------------------------------------------------------------

export class OidcVerifier {
  private readonly config: OidcConfig;
  private discoveryCache: DiscoveryCacheEntry | null = null;
  private jwksCache: JwksCacheEntry | null = null;

  constructor(config: OidcConfig) {
    if (!config.issuerUrl) {
      throw new OidcError('discovery_failed', 'issuerUrl is required');
    }
    if (!config.clientId) {
      throw new OidcError('audience_mismatch', 'clientId is required');
    }
    // Strip trailing slash so we can predictably append the well-known path.
    const issuerUrl = config.issuerUrl.replace(/\/+$/, '');
    this.config = { ...config, issuerUrl };
  }

  /**
   * Fetch (or return cached) OIDC discovery document.
   *
   * On fetch failure: returns the previously cached doc if any, else
   * throws OidcError('discovery_failed'). This degrades gracefully when
   * the IdP has a transient outage but we already proved the doc exists.
   */
  async getDiscovery(): Promise<DiscoveryDocument> {
    const now = Date.now();
    if (
      this.discoveryCache &&
      now - this.discoveryCache.fetchedAt < DISCOVERY_CACHE_TTL_MS
    ) {
      return this.discoveryCache.doc;
    }

    const url = `${this.config.issuerUrl}/.well-known/openid-configuration`;
    let response: Response;
    try {
      response = await fetch(url);
    } catch (err) {
      if (this.discoveryCache) return this.discoveryCache.doc;
      throw new OidcError(
        'discovery_failed',
        `failed to fetch discovery doc at ${url}: ${(err as Error).message}`,
      );
    }

    if (!response.ok) {
      if (this.discoveryCache) return this.discoveryCache.doc;
      throw new OidcError(
        'discovery_failed',
        `discovery doc fetch returned ${response.status} for ${url}`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      if (this.discoveryCache) return this.discoveryCache.doc;
      throw new OidcError(
        'discovery_failed',
        `discovery doc at ${url} was not valid JSON: ${(err as Error).message}`,
      );
    }

    const doc = body as Partial<DiscoveryDocument>;
    if (
      !doc ||
      typeof doc.authorization_endpoint !== 'string' ||
      typeof doc.token_endpoint !== 'string' ||
      typeof doc.jwks_uri !== 'string' ||
      typeof doc.issuer !== 'string'
    ) {
      if (this.discoveryCache) return this.discoveryCache.doc;
      throw new OidcError(
        'discovery_failed',
        `discovery doc at ${url} was missing required fields`,
      );
    }

    const validated: DiscoveryDocument = {
      authorization_endpoint: doc.authorization_endpoint,
      token_endpoint: doc.token_endpoint,
      jwks_uri: doc.jwks_uri,
      issuer: doc.issuer,
    };
    if (validated.issuer !== this.config.issuerUrl) {
      if (this.discoveryCache) return this.discoveryCache.doc;
      throw new OidcError(
        'issuer_mismatch',
        `discovery issuer '${validated.issuer}' does not match configured issuer '${this.config.issuerUrl}'`,
      );
    }

    this.discoveryCache = { doc: validated, fetchedAt: now };
    return validated;
  }

  /**
   * Resolve (and cache) a JWKS getKey function for the current jwks_uri.
   *
   * jose's createRemoteJWKSet has its own internal cache; we layer ours
   * on top so callers can introspect freshness, force rotation by
   * invalidating, and so tests don't have to reach into jose internals.
   */
  private async getJwks(): Promise<JwksCacheEntry['getKey']> {
    const discovery = await this.getDiscovery();
    const now = Date.now();

    if (
      this.jwksCache &&
      this.jwksCache.jwksUri === discovery.jwks_uri &&
      now - this.jwksCache.fetchedAt < this.jwksCache.ttlMs
    ) {
      return this.jwksCache.getKey;
    }

    let getKey: JwksCacheEntry['getKey'];
    let ttlMs = DEFAULT_JWKS_CACHE_TTL_MS;
    try {
      // Probe the JWKS endpoint once to read Cache-Control. We do not
      // hand the bytes to jose; jose will fetch again on first use, but
      // its remote set has its own internal cooldown, so this is cheap.
      const probe = await fetch(discovery.jwks_uri);
      if (!probe.ok) {
        throw new Error(`jwks fetch returned ${probe.status}`);
      }
      // Drain the body so the connection can be reused.
      await probe.arrayBuffer();
      const cc = probe.headers.get('cache-control');
      if (cc) {
        const m = /max-age\s*=\s*(\d+)/i.exec(cc);
        if (m) {
          const seconds = Number.parseInt(m[1], 10);
          if (Number.isFinite(seconds) && seconds > 0) {
            ttlMs = seconds * 1000;
          }
        }
      }
      getKey = createRemoteJWKSet(new URL(discovery.jwks_uri)) as JwksCacheEntry['getKey'];
    } catch (err) {
      throw new OidcError(
        'jwks_failed',
        `failed to load JWKS at ${discovery.jwks_uri}: ${(err as Error).message}`,
      );
    }

    this.jwksCache = {
      getKey,
      fetchedAt: now,
      ttlMs,
      jwksUri: discovery.jwks_uri,
    };
    return getKey;
  }

  /**
   * Verify an OIDC id_token.
   *
   * Order of checks (fail-closed) is documented in the module spec; do
   * not reorder without updating the consuming call sites' expectations.
   */
  async verifyIdToken(idToken: string, options: VerifyIdTokenOptions = {}): Promise<VerifiedIdentity> {
    if (typeof idToken !== 'string' || idToken.length === 0) {
      throw new OidcError('malformed', 'id_token must be a non-empty string');
    }
    const segments = idToken.split('.');
    if (segments.length !== 3) {
      throw new OidcError(
        'malformed',
        `id_token must have 3 segments, got ${segments.length}`,
      );
    }
    for (const seg of segments) {
      if (seg.length === 0) {
        throw new OidcError('malformed', 'id_token has an empty segment');
      }
    }

    const discovery = await this.getDiscovery();

    let payload: JWTPayload;
    let attemptedRotationRefetch = false;
    // We loop at most twice: once with the cached JWKS and (on
    // JWKSNoMatchingKey) once after forcing a fresh JWKS getKey closure.
    // This handles the case where the IdP rotated kid faster than
    // jose's internal cooldown.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const getKey = await this.getJwks();
      try {
        const result = await jwtVerify(idToken, getKey, {
          // We do issuer / audience validation explicitly below so we
          // can attach our typed error codes. jose still validates exp
          // and nbf automatically; we map JWTExpired below.
        });
        payload = result.payload;
        break;
      } catch (err) {
        if (
          err instanceof joseErrors.JWKSNoMatchingKey &&
          !attemptedRotationRefetch
        ) {
          // The kid was not in the JWKS jose currently sees. jose's
          // own remote set has a cooldown (default 30s) that may block
          // an immediate refetch, so we drop our cached getKey closure
          // and rebuild it via createRemoteJWKSet to trigger a fresh
          // fetch through jose's internals on the next jwtVerify call.
          this.jwksCache = null;
          attemptedRotationRefetch = true;
          continue;
        }
        if (err instanceof joseErrors.JWKSNoMatchingKey) {
          this.jwksCache = null;
          throw new OidcError(
            'jwks_failed',
            'no JWKS key matches the id_token kid',
          );
        }
        if (err instanceof joseErrors.JWTExpired) {
          throw new OidcError('expired', `id_token expired: ${err.message}`);
        }
        if (err instanceof joseErrors.JWTClaimValidationFailed) {
          // jose validates nbf and (when configured) iss/aud/sub here.
          // We do not configure those, so reaching this branch likely
          // means an nbf in the future; treat as a time-class failure.
          throw new OidcError(
            'expired',
            `id_token claim validation failed: ${err.message}`,
          );
        }
        if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
          throw new OidcError(
            'signature_invalid',
            'id_token signature is invalid',
          );
        }
        if (
          err instanceof joseErrors.JWSInvalid ||
          err instanceof joseErrors.JWTInvalid
        ) {
          throw new OidcError(
            'malformed',
            `id_token is malformed: ${err.message}`,
          );
        }
        if (
          err instanceof joseErrors.JWKSInvalid ||
          err instanceof joseErrors.JWKSTimeout
        ) {
          this.jwksCache = null;
          throw new OidcError('jwks_failed', `JWKS error: ${err.message}`);
        }
        // Anything else from jose is a signature-class failure as far
        // as the caller is concerned: we did not get a verified payload.
        throw new OidcError(
          'signature_invalid',
          `id_token verification failed: ${(err as Error).message}`,
        );
      }
    }

    // iss must match discovery's declared issuer exactly.
    if (typeof payload.iss !== 'string' || payload.iss !== discovery.issuer) {
      throw new OidcError(
        'issuer_mismatch',
        `id_token iss '${String(payload.iss)}' does not match discovery issuer '${discovery.issuer}'`,
      );
    }

    // aud check: string === clientId OR array contains clientId.
    const aud = payload.aud;
    let audMatches = false;
    let audValue = '';
    if (typeof aud === 'string') {
      audMatches = aud === this.config.clientId;
      audValue = aud;
    } else if (Array.isArray(aud)) {
      audMatches = aud.includes(this.config.clientId);
      audValue = aud.join(',');
    }
    if (!audMatches) {
      throw new OidcError(
        'audience_mismatch',
        `id_token aud '${audValue}' does not match clientId '${this.config.clientId}'`,
      );
    }
    if (Array.isArray(aud) && aud.length > 1) {
      if (payload.azp !== this.config.clientId) {
        throw new OidcError(
          'audience_mismatch',
          `id_token azp '${String(payload.azp)}' does not match clientId '${this.config.clientId}'`,
        );
      }
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
      throw new OidcError(
        'expired',
        `id_token expired at ${payload.exp} (now ${nowSeconds})`,
      );
    }
    if (typeof payload.iat !== 'number' || payload.iat > nowSeconds + IAT_FUTURE_SKEW_SECONDS) {
      throw new OidcError(
        'expired',
        `id_token iat ${payload.iat} is too far in the future (now ${nowSeconds})`,
      );
    }
    if (options.nonce !== undefined && payload.nonce !== options.nonce) {
      throw new OidcError(
        'malformed',
        `id_token nonce did not match the authorization request`,
      );
    }

    // email_verified must be strictly true. Anything else (false, missing,
    // string 'true', undefined) is a fail.
    if (payload.email_verified !== true) {
      throw new OidcError(
        'email_unverified',
        'id_token email_verified is not true',
      );
    }

    const email = normalizeEmail(payload.email);
    if (email.length === 0) {
      throw new OidcError('no_email', 'id_token has no email claim');
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new OidcError('malformed', 'id_token has no subject claim');
    }

    return {
      email,
      emailVerified: true,
      subject: payload.sub,
      issuer: payload.iss,
      audience: this.config.clientId,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    };
  }

  /**
   * Exchange an authorization code for tokens at the discovery
   * token_endpoint. The caller is responsible for the redirect_uri
   * matching what was registered with the IdP.
   */
  async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
  ): Promise<TokenExchangeResult> {
    if (!this.config.clientSecret) {
      throw new OidcError(
        'discovery_failed',
        'clientSecret is required for code exchange',
      );
    }
    const discovery = await this.getDiscovery();
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('redirect_uri', redirectUri);
    body.set('client_id', this.config.clientId);
    body.set('client_secret', this.config.clientSecret);

    let response: Response;
    try {
      response = await fetch(discovery.token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'accept': 'application/json',
        },
        body: body.toString(),
      });
    } catch (err) {
      throw new OidcError(
        'discovery_failed',
        `token endpoint fetch failed: ${(err as Error).message}`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new OidcError(
        'discovery_failed',
        `token endpoint returned ${response.status}: ${text}`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (err) {
      throw new OidcError(
        'discovery_failed',
        `token endpoint response was not JSON: ${(err as Error).message}`,
      );
    }

    const obj = payload as Record<string, unknown>;
    if (typeof obj.id_token !== 'string' || obj.id_token.length === 0) {
      throw new OidcError(
        'malformed',
        'token endpoint response did not include id_token',
      );
    }
    const accessToken =
      typeof obj.access_token === 'string' ? obj.access_token : '';
    return {
      id_token: obj.id_token,
      access_token: accessToken,
    };
  }

  /**
   * Test-only hook. Clears caches so tests can force a refetch without
   * waiting for the TTL. Not part of the documented public API but
   * exposed because the alternative is reaching into private state.
   */
  _clearCachesForTest(): void {
    this.discoveryCache = null;
    this.jwksCache = null;
  }
}
