/**
 * OIDC Relying-Party federation for `gbrain serve --http`.
 *
 * gbrain is its own OAuth 2.1 Authorization Server (see oauth-provider.ts): MCP
 * clients (Claude Desktop, ChatGPT) do DCR + authorization_code+PKCE against
 * gbrain directly. By default gbrain's `/authorize` mints a code IMMEDIATELY
 * with no human login — identity is just the registered client. That is fine
 * when a network perimeter (Cloudflare Access gating the tunnel/WARP) already
 * authenticated the human, but it carries NO per-human identity into gbrain.
 *
 * This module adds an OIDC relying-party leg so the human IS authenticated and
 * their SSO identity (email + groups) is bound to the gbrain token, WITHOUT a
 * proxy in the data path injecting a header (that needs Cloudflare to HTTP-
 * proxy the origin). The MCP client's flow is UNCHANGED — it still OAuths
 * against gbrain. gbrain, at `/authorize`, redirects the browser UPSTREAM to
 * Cloudflare Access-for-SaaS (an OIDC IdP federating to Azure AD); on the
 * `/oidc/callback` it exchanges the code, verifies the `id_token`, and binds
 * email/groups to the gbrain authorization code it then mints. See
 * oauth-provider.ts (authorize / completeOidcCallback) for the wiring.
 *
 * DUAL-MODE / BACK-COMPAT: when disabled (GBRAIN_OIDC_ENABLED unset/false) the
 * provider behaves EXACTLY as before (immediate code mint, no identity). The
 * client_credentials grant (machine clients, e.g. the brain-ingest sink) never
 * touches this path — service tokens authenticate by client secret as today.
 *
 * Verification (RS256) reuses the same jose primitives as cf-access-auth.ts:
 * createRemoteJWKSet (TTL cache + kid rotation) + jwtVerify with issuer +
 * audience (=our client_id) + nonce binding.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { createHash, randomBytes } from 'crypto';
import { hasScope, parseScopeString } from './scope.ts';

// ── Config ──────────────────────────────────────────────────────────────────

/** Scopes granted to an authenticated user not matched by the group/domain map. */
export const OIDC_DEFAULT_SCOPE_FALLBACK = 'read';

/** JWKS cache TTL in ms. jose re-fetches on kid-miss regardless of this. */
const DEFAULT_JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_JWKS_COOLDOWN_MS = 30 * 1000; // 30s between forced re-fetches
const DEFAULT_JWKS_TIMEOUT_MS = 5 * 1000; // 5s fetch timeout

/** Discovery + token-exchange HTTP timeout. */
const DEFAULT_HTTP_TIMEOUT_MS = 8 * 1000;

/**
 * group/email-domain → space-delimited gbrain scope string. A login is mapped
 * by UNION-ing the scopes of every matching key (any of the user's group claim
 * values, plus their email domain). No match → OIDC_DEFAULT_SCOPE_FALLBACK
 * (overridable via defaultScope).
 */
export type OidcGroupScopeMap = Record<string, string>;

export interface OidcRpConfig {
  /** Whether the OIDC RP leg is active. When false the provider mints codes as before. */
  enabled: boolean;
  /** Discovery base (the issuer). `{issuer}/.well-known/openid-configuration` is fetched. */
  issuer: string;
  /** Our OIDC client_id at the upstream IdP (also the expected `aud` of the id_token). */
  clientId: string;
  /** Our OIDC client_secret (client_secret_post at the token endpoint). */
  clientSecret: string;
  /** The redirect_uri registered at the IdP — gbrain's own `/oidc/callback`. */
  redirectUri: string;
  /** group/email-domain → scope-string map (see OidcGroupScopeMap). */
  groupScopeMap: OidcGroupScopeMap;
  /** Space-delimited fallback scopes for an authenticated-but-unmapped user. */
  defaultScope: string;
}

/**
 * Resolve OIDC RP config from env.
 *
 * Env keys:
 *   - GBRAIN_OIDC_ENABLED           ("1"/"true"/"on" to enable; default off)
 *   - GBRAIN_OIDC_ISSUER            (discovery base; REQUIRED when enabled)
 *   - GBRAIN_OIDC_CLIENT_ID         (REQUIRED when enabled)
 *   - GBRAIN_OIDC_CLIENT_SECRET     (REQUIRED when enabled)
 *   - GBRAIN_OIDC_REDIRECT_URI      (REQUIRED when enabled; gbrain's /oidc/callback)
 *   - GBRAIN_OIDC_GROUP_SCOPE_MAP   (JSON object, default "{}")
 *   - GBRAIN_OIDC_DEFAULT_SCOPE     (default "read")
 *
 * When `enabled` is true but a required field is blank, `enabled` is forced
 * false (fail-closed to the pre-OIDC behavior rather than half-wiring a broken
 * federation that would 500 every /authorize). The caller logs the downgrade.
 */
export function resolveOidcRpConfig(env: NodeJS.ProcessEnv = process.env): OidcRpConfig {
  const enabledRaw = (env.GBRAIN_OIDC_ENABLED ?? '').trim().toLowerCase();
  const wantEnabled = enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === 'on';
  const issuer = (env.GBRAIN_OIDC_ISSUER || '').trim().replace(/\/+$/, '');
  const clientId = (env.GBRAIN_OIDC_CLIENT_ID || '').trim();
  const clientSecret = (env.GBRAIN_OIDC_CLIENT_SECRET || '').trim();
  const redirectUri = (env.GBRAIN_OIDC_REDIRECT_URI || '').trim();
  const defaultScope = (env.GBRAIN_OIDC_DEFAULT_SCOPE || OIDC_DEFAULT_SCOPE_FALLBACK).trim();
  const groupScopeMap = parseGroupScopeMap(env.GBRAIN_OIDC_GROUP_SCOPE_MAP);

  const haveRequired = !!(issuer && clientId && clientSecret && redirectUri);
  return {
    enabled: wantEnabled && haveRequired,
    issuer,
    clientId,
    clientSecret,
    redirectUri,
    groupScopeMap,
    defaultScope,
  };
}

/**
 * Parse GBRAIN_OIDC_GROUP_SCOPE_MAP JSON into a validated OidcGroupScopeMap.
 * Drops malformed entries rather than throwing — a typo in one entry must not
 * crash startup or silently widen access (an entry whose value isn't a string
 * is skipped, so it grants nothing).
 */
export function parseGroupScopeMap(raw: string | undefined): OidcGroupScopeMap {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: OidcGroupScopeMap = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val === 'string' && val.trim()) out[key] = val.trim();
  }
  return out;
}

// ── Discovery + verifier types ───────────────────────────────────────────────

export interface OidcEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint?: string;
}

export interface OidcIdentity {
  /** `sub` claim — the IdP's stable subject identifier. */
  subject: string;
  /** Verified `email` claim (lowercased). */
  email: string;
  /** Group claim values, if present (Azure-AD-via-Access varies; may be []). */
  groups: string[];
  /** The full verified id_token payload (debugging / future claims). */
  payload: JWTPayload;
}

export class OidcRpError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'discovery_failed'
      | 'token_exchange_failed'
      | 'invalid_id_token'
      | 'nonce_mismatch'
      | 'missing_email'
      | 'misconfigured',
  ) {
    super(message);
    this.name = 'OidcRpError';
  }
}

// ── PKCE (gbrain → upstream IdP) ──────────────────────────────────────────────

/** base64url with no padding (RFC 7636 §3 / RFC 4648 §5). */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a PKCE verifier + S256 challenge for the gbrain→IdP authorization
 * leg. The verifier is stored in oauth_pending and replayed at the callback's
 * token exchange; the challenge travels on the upstream authorize redirect.
 */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32)); // 43-char high-entropy verifier
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ── group/email → scope mapping ───────────────────────────────────────────────

/**
 * Map a verified identity to the set of gbrain scopes the IDENTITY is allowed.
 * UNION the scope strings of every matching group claim plus the email-domain
 * key; if nothing matches, fall back to `config.defaultScope`. The caller
 * (oauth-provider) then INTERSECTS this with the client's requested/registered
 * scopes (via hasScope) so neither side can escalate the other.
 */
export function mapIdentityToScopes(
  identity: Pick<OidcIdentity, 'email' | 'groups'>,
  config: Pick<OidcRpConfig, 'groupScopeMap' | 'defaultScope'>,
): string[] {
  const granted = new Set<string>();
  const add = (s: string) => {
    for (const scope of parseScopeString(s)) granted.add(scope);
  };

  const at = identity.email.indexOf('@');
  const domain = at >= 0 ? identity.email.slice(at + 1).toLowerCase() : '';
  if (domain && config.groupScopeMap[domain]) add(config.groupScopeMap[domain]);
  for (const group of identity.groups) {
    if (config.groupScopeMap[group]) add(config.groupScopeMap[group]);
  }

  if (granted.size === 0) add(config.defaultScope);
  return Array.from(granted);
}

/**
 * Intersect a client's requested scopes with what the identity is allowed.
 * `hasScope` honors implication (an `admin` identity grant satisfies a `read`
 * request), matching the clamp semantics in oauth-provider.exchange* paths.
 */
export function clampScopes(requestedScopes: string[], identityScopes: string[]): string[] {
  return requestedScopes.filter(s => hasScope(identityScopes, s));
}

// ── Group claim extraction (shape-tolerant) ───────────────────────────────────

/**
 * Extract the `groups` claim regardless of the exact shape Cloudflare/Azure
 * emits: `groups: string[]` (common), `groups: string` (single), or
 * `custom.groups: string[]`. A missing claim yields `[]` (the user still gets
 * the default-scope mapping, never a hard failure). Mirrors cf-access-auth.ts.
 */
export function extractGroups(payload: JWTPayload): string[] {
  const collect = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.filter((g): g is string => typeof g === 'string');
    if (typeof v === 'string' && v.length > 0) return [v];
    return [];
  };
  const top = collect((payload as Record<string, unknown>).groups);
  if (top.length > 0) return top;
  const custom = (payload as Record<string, unknown>).custom;
  if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
    return collect((custom as Record<string, unknown>).groups);
  }
  return [];
}

// ── The RP runtime ─────────────────────────────────────────────────────────────

export interface OidcRp {
  readonly config: OidcRpConfig;
  /** Build the upstream authorize URL (lazily resolves discovery on first use). */
  buildAuthorizationUrl(params: { state: string; nonce: string; codeChallenge: string }): Promise<string>;
  /**
   * Exchange the IdP authorization code, verify the id_token (iss/aud/exp +
   * nonce), and return the bound identity. Throws OidcRpError on any failure.
   */
  exchangeCode(code: string, codeVerifier: string, expectedNonce: string): Promise<OidcIdentity>;
}

interface CreateOidcRpOpts {
  /** Test override for the JWKS key resolver (offline verification). */
  getKey?: JWTVerifyGetKey;
  /** Test override for fetch (discovery + token exchange). */
  fetchImpl?: typeof fetch;
}

/**
 * Build an OIDC RP runtime. Discovery + JWKS are resolved lazily on first use
 * and cached for the process lifetime (jose's createRemoteJWKSet keeps the key
 * cache warm with kid-rotation); a discovery failure is not cached so a
 * transient IdP outage at startup self-heals on the next request.
 */
export function createOidcRp(config: OidcRpConfig, opts: CreateOidcRpOpts = {}): OidcRp {
  if (!config.enabled) throw new OidcRpError('createOidcRp called with disabled config', 'misconfigured');
  const fetchImpl = opts.fetchImpl ?? fetch;

  let discovery: Promise<{ endpoints: OidcEndpoints; getKey: JWTVerifyGetKey }> | null = null;

  async function resolve(): Promise<{ endpoints: OidcEndpoints; getKey: JWTVerifyGetKey }> {
    if (discovery) return discovery;
    discovery = (async () => {
      const url = `${config.issuer}/.well-known/openid-configuration`;
      let doc: Record<string, unknown>;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`discovery HTTP ${res.status}`);
        doc = (await res.json()) as Record<string, unknown>;
      } catch (e) {
        throw new OidcRpError(`OIDC discovery failed (${url}): ${(e as Error).message}`, 'discovery_failed');
      }
      const issuer = String(doc.issuer ?? '');
      const authorizationEndpoint = String(doc.authorization_endpoint ?? '');
      const tokenEndpoint = String(doc.token_endpoint ?? '');
      const jwksUri = String(doc.jwks_uri ?? '');
      if (!issuer || !authorizationEndpoint || !tokenEndpoint || !jwksUri) {
        throw new OidcRpError('OIDC discovery doc missing required endpoints', 'discovery_failed');
      }
      // Pin the issuer to the configured value: a discovery doc that advertises
      // a different issuer than we trust is a misconfiguration/spoof — fail
      // closed rather than trust the document's self-reported identity.
      if (issuer !== config.issuer) {
        throw new OidcRpError(
          `OIDC discovery issuer mismatch: doc=${issuer} configured=${config.issuer}`,
          'discovery_failed',
        );
      }
      const endpoints: OidcEndpoints = {
        issuer,
        authorizationEndpoint,
        tokenEndpoint,
        jwksUri,
        userinfoEndpoint: doc.userinfo_endpoint ? String(doc.userinfo_endpoint) : undefined,
      };
      const getKey =
        opts.getKey ??
        createRemoteJWKSet(new URL(jwksUri), {
          cacheMaxAge: DEFAULT_JWKS_CACHE_MAX_AGE_MS,
          cooldownDuration: DEFAULT_JWKS_COOLDOWN_MS,
          timeoutDuration: DEFAULT_JWKS_TIMEOUT_MS,
        });
      return { endpoints, getKey };
    })().catch(err => {
      discovery = null; // don't cache a failed resolution — retry next request
      throw err;
    });
    return discovery;
  }

  return {
    config,

    async buildAuthorizationUrl({ state, nonce, codeChallenge }): Promise<string> {
      const { endpoints } = await resolve();
      const u = new URL(endpoints.authorizationEndpoint);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', config.clientId);
      u.searchParams.set('redirect_uri', config.redirectUri);
      u.searchParams.set('scope', 'openid email profile groups');
      u.searchParams.set('state', state);
      u.searchParams.set('nonce', nonce);
      u.searchParams.set('code_challenge', codeChallenge);
      u.searchParams.set('code_challenge_method', 'S256');
      return u.toString();
    },

    async exchangeCode(code, codeVerifier, expectedNonce): Promise<OidcIdentity> {
      const { endpoints, getKey } = await resolve();

      // 1. Exchange the IdP authorization code (client_secret_post + PKCE).
      let idToken: string;
      try {
        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: config.redirectUri,
          code_verifier: codeVerifier,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        });
        const res = await fetchImpl(endpoints.tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body,
          signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`token endpoint HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
        }
        const json = (await res.json()) as Record<string, unknown>;
        const tok = json.id_token;
        if (typeof tok !== 'string' || !tok) throw new Error('token response missing id_token');
        idToken = tok;
      } catch (e) {
        if (e instanceof OidcRpError) throw e;
        throw new OidcRpError(`OIDC token exchange failed: ${(e as Error).message}`, 'token_exchange_failed');
      }

      // 2. Verify the id_token: signature (JWKS) + iss + aud(=client_id) + exp.
      let payload: JWTPayload;
      try {
        const result = await jwtVerify(idToken, getKey, {
          issuer: endpoints.issuer,
          audience: config.clientId,
          algorithms: ['RS256'],
        });
        payload = result.payload;
      } catch (e) {
        throw new OidcRpError(`OIDC id_token verification failed: ${(e as Error).message}`, 'invalid_id_token');
      }

      // 3. Bind the nonce: defends against id_token replay / injection across
      //    sessions. The nonce we generated at /authorize MUST match.
      if (typeof payload.nonce !== 'string' || payload.nonce !== expectedNonce) {
        throw new OidcRpError('OIDC id_token nonce mismatch', 'nonce_mismatch');
      }

      const emailRaw = (payload as Record<string, unknown>).email;
      if (typeof emailRaw !== 'string' || emailRaw.length === 0) {
        throw new OidcRpError('OIDC id_token missing email claim', 'missing_email');
      }
      const subject = typeof payload.sub === 'string' ? payload.sub : '';
      return {
        subject,
        email: emailRaw.toLowerCase(),
        groups: extractGroups(payload),
        payload,
      };
    },
  };
}
