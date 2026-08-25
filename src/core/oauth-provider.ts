/**
 * GBrain OAuth 2.1 Provider — implements MCP SDK's OAuthServerProvider.
 *
 * Backed by raw SQL (PGLite or Postgres), not the BrainEngine interface.
 * OAuth is infrastructure, not brain operations.
 *
 * Supports:
 * - Client registration (manual via CLI or Dynamic Client Registration)
 * - Authorization code flow with PKCE (for ChatGPT, browser-based clients)
 * - Client credentials flow (for machine-to-machine: Perplexity, Claude)
 * - Token refresh with rotation
 * - Token revocation
 * - Legacy access_tokens fallback for backward compat
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Response } from 'express';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo as SdkAuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError, InvalidClientMetadataError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { hashToken, generateToken, isUndefinedColumnError } from './utils.ts';
import { assertValidSourceId } from './source-id.ts';
import { hasScope, assertAllowedScopes, parseScopeString, InvalidScopeError } from './scope.ts';
import type { AuthInfo as CoreAuthInfo } from './operations.ts';
import { parseLegacyTokenScope, parseTakesHoldersAllowList, coerceLegacyPermissions, normalizeTokenScopes } from './legacy-token-scope.ts';

/**
 * A slug-prefix write binding is only meaningful if every entry actually
 * constrains something. `''` (or whitespace) matches every slug under
 * `startsWith`, so one unset variable in a provisioning template would turn
 * a binding into a silent wildcard while still displaying as "fenced".
 * Reject at every write surface: registration, rescope, admin API.
 */
export function assertValidSlugPrefixes(prefixes: readonly string[]): void {
  for (const p of prefixes) {
    if (typeof p !== 'string' || p.trim() === '') {
      throw new Error('bound_slug_prefixes entries must be non-empty, non-whitespace slug prefixes (e.g. "emp-alice/")');
    }
    if (p !== p.trim()) {
      throw new Error(`bound_slug_prefixes entry "${p}" has leading/trailing whitespace; slugs never do, so it would fence nothing`);
    }
    // Slugs are lowercased by validateSlug before storage, so a prefix with
    // uppercase in it cannot correspond to anything actually written.
    if (p !== p.toLowerCase()) {
      throw new Error(`bound_slug_prefixes entry "${p}" must be lowercase; stored slugs are lowercased, so a mixed-case prefix fences unpredictably`);
    }
    // Require an explicit segment boundary. Slug namespaces collide on their
    // own naming scheme — `emp-alice` and `emp-alice-2` are different people —
    // and a boundary-less entry reads as "everything starting with these
    // characters". The matcher is boundary-aware regardless, but saying it at
    // registration is what stops an operator writing a binding whose meaning
    // isn't what it looks like.
    if (!p.endsWith('/') && !p.endsWith('/*')) {
      throw new Error(`bound_slug_prefixes entry "${p}" must end with "/" (or "/*"); a boundary-less prefix reads as a character prefix, so "${p}" would look like it covers only "${p}/..." while naming sibling namespaces like "${p}-2/..."`);
    }
  }
}
import type { SqlQuery, SqlValue } from './sql-query.ts';
export type { SqlQuery, SqlValue };

export interface AgentClientBindings {
  boundTools?: string[];
  boundSourceId?: string;
  boundBrainId?: string;
  boundSlugPrefixes?: string[];
  boundMaxConcurrent?: number;
  budgetUsdPerDay?: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Convert a JS array to a PostgreSQL array literal for PGLite compat.
 *
 * PGLite's `db.query(sql, params)` rejects JS arrays bound directly to TEXT[]
 * columns ("insufficient data left in message"), so we hand-build the array
 * literal `{...}` and let Postgres parse it on insert.
 *
 * SECURITY: every element is wrapped in double quotes with `"` and `\`
 * escaped. Without this, an element containing a comma (e.g., a malicious
 * `redirect_uri` containing `,`) would be parsed by Postgres as MULTIPLE
 * array elements, smuggling values past validation. See CSO finding #5.
 */
function pgArray(arr: string[]): string {
  if (!arr || arr.length === 0) return '{}';
  const escaped = arr.map(s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${escaped.join(',')}}`;
}

/**
 * Allow-list of RFC 7591 §2 `token_endpoint_auth_method` values gbrain
 * accepts at registration. Three values, chosen because the SDK's
 * `mcpAuthRouter` advertises exactly these three in
 * `token_endpoint_auth_methods_supported`:
 *
 * - `client_secret_post` — confidential client; secret in body (default)
 * - `client_secret_basic` — confidential client; secret in Authorization header
 * - `none` — public PKCE-only client (Claude Code, Cursor, ChatGPT custom connector)
 *
 * Three call sites enforce this set:
 *   1. CLI `gbrain auth register-client` (src/commands/auth.ts)
 *   2. Admin `POST /admin/api/register-client` (src/commands/serve-http.ts)
 *   3. DCR `POST /register` (this file, GBrainClientsStore.registerClient)
 *
 * **Read-tolerant by design.** `getClient` returns whatever is stored
 * verbatim — legacy rows with non-allowlist values (e.g. pre-v0.41.3
 * direct UPDATEs) continue to function. The validator gates new writes
 * ONLY; we don't break operators with hand-edited rows on upgrade.
 */
export type TokenEndpointAuthMethod = 'client_secret_post' | 'client_secret_basic' | 'none';

export const ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS = new Set<TokenEndpointAuthMethod>([
  'client_secret_post',
  'client_secret_basic',
  'none',
]);

export class InvalidTokenEndpointAuthMethodError extends Error {
  readonly code = 'invalid_token_endpoint_auth_method';
  constructor(value: unknown) {
    super(
      `Invalid token_endpoint_auth_method: ${JSON.stringify(value)}. ` +
      `Expected one of: ${Array.from(ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS).join(', ')}. ` +
      `RFC 7591 §2 — see https://datatracker.ietf.org/doc/html/rfc7591#section-2.`,
    );
    this.name = 'InvalidTokenEndpointAuthMethodError';
  }
}

/**
 * Validate a token_endpoint_auth_method value at the registration boundary.
 * Throws `InvalidTokenEndpointAuthMethodError` on rejection; returns the
 * typed value on success. Returns `'client_secret_post'` for undefined input
 * (RFC 7591 default).
 *
 * Apply at every registration entry point (CLI, admin endpoint, DCR). Do
 * NOT apply on read — legacy oauth_clients rows with non-allowlist values
 * must continue to function unchanged.
 */
export function validateTokenEndpointAuthMethod(value: unknown): TokenEndpointAuthMethod {
  if (value === undefined || value === null || value === '') return 'client_secret_post';
  if (typeof value !== 'string') throw new InvalidTokenEndpointAuthMethodError(value);
  if (!ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS.has(value as TokenEndpointAuthMethod)) {
    throw new InvalidTokenEndpointAuthMethodError(value);
  }
  return value as TokenEndpointAuthMethod;
}

/**
 * Validate a redirect_uri per RFC 6749 §3.1.2.1.
 *
 * Production redirect_uris MUST be HTTPS. The only allowed plaintext
 * exceptions are loopback (127.0.0.1, ::1, localhost) which are unreachable
 * from the network. Throws a descriptive error on rejection.
 *
 * Used by the DCR (Dynamic Client Registration) path; the CLI registration
 * path trusts the operator and bypasses this gate.
 */
function validateRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid redirect_uri: not a parseable URL: ${uri}`);
  }
  const isLoopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]'
    || parsed.hostname === '::1';
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopback) return;
  throw new Error(
    `redirect_uri must use https:// (or http://localhost for loopback): ${uri}`,
  );
}

/**
 * Coerce an OAuth timestamp column (Unix epoch seconds, BIGINT) into a JS
 * number, or undefined for SQL NULL.
 *
 * Why this exists: postgres.js with `prepare: false` (the auto-detected setting
 * on Supabase PgBouncer / port 6543; see src/core/db.ts:resolvePrepare) returns
 * BIGINT columns as strings. Two surfaces break on that: (1) the MCP SDK's
 * bearerAuth middleware checks `typeof authInfo.expiresAt === 'number'` and
 * rejects strings; (2) RFC 7591 §3.2.1 requires `client_id_issued_at` and
 * `client_secret_expires_at` to be JSON numbers in DCR responses, not strings.
 *
 * Throws on non-finite (NaN/Infinity) so corrupt rows fail loud at the boundary
 * instead of letting `expiresAt: NaN` flow through to the SDK as a fake-valid
 * token. Returns undefined for SQL NULL so callers decide NULL semantics
 * explicitly. For OAuth, the comparison sites treat NULL as "expired"
 * (fail-closed); the DCR response sites preserve undefined per RFC 7591
 * (the `client_secret_expires_at` field is optional, undefined means
 * "did not expire").
 */
export function coerceTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`coerceTimestamp: non-finite timestamp value ${JSON.stringify(value)}`);
  }
  return n;
}

interface GBrainOAuthProviderOptions {
  sql: SqlQuery;
  /** Default token TTL in seconds (default: 3600 = 1 hour) */
  tokenTtl?: number;
  /** Default refresh token TTL in seconds (default: 30 days) */
  refreshTtl?: number;
  /**
   * Disable Dynamic Client Registration (RFC 7591) while keeping the rest of
   * the OAuth surface intact. When true, `clientsStore.registerClient` is not
   * surfaced to the SDK router, so POST `/register` returns 404 even though
   * the underlying provider can still register clients programmatically via
   * `registerClientManual`. Replaces the previous monkey-patching pattern in
   * serve-http.ts (cleanup, not a security fix — DCR was never reachable
   * before mcpAuthRouter ran).
   */
  dcrDisabled?: boolean;
  /**
   * Allow the consent-bypassing `client_credentials` grant on the unauthenticated
   * Dynamic Client Registration path. Default false (#1353): a self-registered
   * DCR client defaults to `authorization_code` (which goes through /authorize
   * consent), and an explicit `client_credentials` request is rejected. Operators
   * who genuinely need machine-to-machine DCR clients opt in via
   * `--enable-dcr-insecure`. Manual CLI / admin registration is unaffected
   * (operator-trusted, registers grants directly).
   */
  allowClientCredentialsDcr?: boolean;
  /**
   * #2179: lower bound (seconds) for DCR-requested per-client token TTLs.
   * Requests below it clamp up. Default DEFAULT_DCR_TTL_MIN_SECONDS (300).
   */
  dcrTtlMinSeconds?: number;
  /**
   * #2179: upper bound (seconds) for DCR-requested per-client token TTLs.
   * Requests above it clamp down. Unset defaults FAIL-CLOSED to
   * max(tokenTtl, dcrTtlMinSeconds): an anonymous DCR registrant can never
   * elect a longer-lived token than the operator's own --token-ttl unless
   * the admin explicitly widened the window.
   */
  dcrTtlMaxSeconds?: number;
}

// ---------------------------------------------------------------------------
// DCR token TTL (#2179)
// ---------------------------------------------------------------------------

/**
 * Default lower clamp bound for DCR-requested token TTLs (#2179). Admins
 * override via the `oauth.dcr_ttl_min_seconds` / `oauth.dcr_ttl_max_seconds`
 * config keys, read once by `gbrain serve --http` at startup. There is
 * deliberately NO fixed default max: an unset max derives fail-closed from
 * the operator's --token-ttl (`max(tokenTtl, min)`), so a self-registering
 * client can never out-live the server default without explicit admin opt-in.
 */
export const DEFAULT_DCR_TTL_MIN_SECONDS = 300; // 5 minutes

/**
 * Clamp a DCR-requested token TTL into the admin-configured [min, max]
 * window. Bounds are REQUIRED — callers resolve them (fail-closed) first.
 * Never rejects (#2179): out-of-range values clamp to the nearest bound.
 * Non-integer requests floor; an inverted window collapses to the min bound.
 */
export function clampDcrTokenTtl(
  requested: number,
  min: number,
  max: number,
): number {
  const lo = Math.max(1, Math.floor(min));
  const hi = Math.max(lo, Math.floor(max));
  return Math.min(hi, Math.max(lo, Math.floor(requested)));
}

/**
 * Request-scoped carrier for the `token_ttl_seconds` DCR extension field
 * (#2179). The MCP SDK's /register handler validates the request body against
 * a strict schema and STRIPS unknown members before they reach
 * `clientsStore.registerClient`, so serve-http's /register middleware parses
 * the raw body and runs the SDK chain inside this AsyncLocalStorage context;
 * the store reads it back out at registration time. No context (CLI, admin
 * API, programmatic registration) means "no TTL request" — default behavior.
 */
export const dcrRegistrationContext = new AsyncLocalStorage<{ tokenTtlSeconds?: number }>();

// ---------------------------------------------------------------------------
// Clients Store
// ---------------------------------------------------------------------------

class GBrainClientsStore implements OAuthRegisteredClientsStore {
  // #2179: DCR TTL bounds are required — the provider resolves fail-closed
  // defaults (max bounded by tokenTtl); no permissive fallback lives here.
  constructor(
    private sql: SqlQuery,
    private allowClientCredentialsDcr: boolean,
    private dcrTtlMin: number,
    private dcrTtlMax: number,
  ) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const rows = await this.sql`
      SELECT client_id, client_secret_hash, client_name, redirect_uris,
             grant_types, scope, token_endpoint_auth_method,
             client_id_issued_at, client_secret_expires_at
      FROM oauth_clients WHERE client_id = ${clientId}
    `;
    if (rows.length === 0) return undefined;
    const r = rows[0];
    // v0.34.1 (#909): public clients (token_endpoint_auth_method='none')
    // have client_secret_hash = NULL. Normalize SQL NULL to JS undefined
    // so SDK middleware that checks `client.client_secret === undefined`
    // (not `=== null`) correctly identifies the client as public and
    // skips the secret-comparison branch on /token.
    const rawSecret = r.client_secret_hash;
    return {
      client_id: r.client_id as string,
      client_secret: rawSecret == null ? undefined : (rawSecret as string),
      client_name: r.client_name as string,
      redirect_uris: (r.redirect_uris as string[]) || [],
      grant_types: (r.grant_types as string[]) || ['client_credentials'],
      scope: r.scope as string | undefined,
      token_endpoint_auth_method: r.token_endpoint_auth_method as string | undefined,
      client_id_issued_at: coerceTimestamp(r.client_id_issued_at),
      client_secret_expires_at: coerceTimestamp(r.client_secret_expires_at),
    };
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    // Enforce HTTPS for all redirect_uris on the DCR path (RFC 6749 §3.1.2.1).
    // Without this, an attacker could register a non-loopback http:// URI and
    // exfiltrate auth codes over plaintext. CLI registrations bypass this gate
    // (operators are trusted; they can register http:// for testing).
    for (const uri of client.redirect_uris || []) {
      validateRedirectUri(String(uri));
    }

    // v0.28: ALLOWED_SCOPES allowlist. RFC 6749 §5.2 invalid_scope. The DCR
    // path is reachable by any unauthenticated network caller when --enable-dcr
    // is on, so this is the security-relevant gate (manual CLI registration
    // is operator-trusted).
    assertAllowedScopes(parseScopeString(client.scope));

    // v0.41.3 (T5): validate token_endpoint_auth_method on the DCR path so
    // `--enable-dcr` is not the looser entry point. CLI and admin paths gate
    // through the same `validateTokenEndpointAuthMethod` helper — all three
    // registration entry points share one allow-list.
    const authMethod = validateTokenEndpointAuthMethod(client.token_endpoint_auth_method);

    // v0.42 (#1353): the DCR path is the unauthenticated network entry point.
    // `client_credentials` skips /authorize consent entirely, so a self-
    // registered DCR client must NOT get it by default. Default the grant to
    // `authorization_code` (the consent-bearing flow) when unspecified, and
    // reject an explicit `client_credentials` request unless the operator opted
    // in via `--enable-dcr-insecure`. Manual CLI/admin registration bypasses
    // this store method, so operators can still mint machine clients directly.
    const grantTypes = (client.grant_types && client.grant_types.length > 0)
      ? client.grant_types
      : ['authorization_code'];
    if (!this.allowClientCredentialsDcr && grantTypes.includes('client_credentials')) {
      throw new InvalidClientMetadataError(
        'client_credentials grant is not permitted via dynamic client registration; ' +
        'restart the server with --enable-dcr-insecure to allow it, or register the ' +
        'client via the gbrain CLI / admin API.',
      );
    }

    const clientId = generateToken('gbrain_cl_');
    // v0.34.1 (#909): RFC 7591 §2 — clients that authenticate at the token
    // endpoint via PKCE alone declare `token_endpoint_auth_method: "none"`.
    // For those clients the authorization server MUST NOT issue a client
    // secret. Pre-fix, unconditional secret generation made the MCP SDK's
    // clientAuth middleware check `client.client_secret` on every request,
    // rejecting valid public-client (Claude Code, Cursor) flows.
    //
    // We persist secret_hash = NULL for public clients so `getClient` and
    // the SDK's clientAuth path can detect them via `client_secret_hash IS
    // NULL` and skip the secret comparison. Confidential clients (default
    // `client_secret_post` and explicit `client_secret_basic`) still mint
    // a secret as before.
    const isPublicClient = authMethod === 'none';
    const clientSecret = isPublicClient ? undefined : generateToken('gbrain_cs_');
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    const now = Math.floor(Date.now() / 1000);

    // v0.34.1 (#861, D2 + D13 + #876): DCR clients get source_id='default'
    // (matches legacy fallback) and federated_read=['default'] (read scope
    // == write scope). Operators who need narrower / wider scope rescope
    // via the CLI later. Pre-v60/v61 brain falls through to the legacy
    // projection (no source_id / federated_read column yet).
    try {
      await this.sql`
        INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                    grant_types, scope, token_endpoint_auth_method,
                                    client_id_issued_at, source_id, federated_read)
        VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                ${pgArray((client.redirect_uris || []).map(String))},
                ${pgArray(grantTypes)},
                ${client.scope || ''}, ${authMethod},
                ${now}, ${'default'}, ${pgArray(['default'])})
      `;
    } catch (err) {
      if (isUndefinedColumnError(err, 'federated_read')) {
        try {
          await this.sql`
            INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                        grant_types, scope, token_endpoint_auth_method,
                                        client_id_issued_at, source_id)
            VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                    ${pgArray((client.redirect_uris || []).map(String))},
                    ${pgArray(grantTypes)},
                    ${client.scope || ''}, ${authMethod},
                    ${now}, ${'default'})
          `;
        } catch (err2) {
          if (isUndefinedColumnError(err2, 'source_id')) {
            await this.sql`
              INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                          grant_types, scope, token_endpoint_auth_method,
                                          client_id_issued_at)
              VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                      ${pgArray((client.redirect_uris || []).map(String))},
                      ${pgArray(grantTypes)},
                      ${client.scope || ''}, ${authMethod},
                      ${now})
            `;
          } else {
            throw err2;
          }
        }
      } else if (isUndefinedColumnError(err, 'source_id')) {
        await this.sql`
          INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                      grant_types, scope, token_endpoint_auth_method,
                                      client_id_issued_at)
          VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                  ${pgArray((client.redirect_uris || []).map(String))},
                  ${pgArray(grantTypes)},
                  ${client.scope || ''}, ${authMethod},
                  ${now})
        `;
      } else {
        throw err;
      }
    }

    // #2179: optional `token_ttl_seconds` hint from the DCR request body,
    // carried via dcrRegistrationContext (the SDK strips unknown body
    // members). Fail-safe posture: absent or malformed → server default TTL;
    // out-of-range → clamped into [dcrTtlMin, dcrTtlMax]; never rejected.
    // Persist into oauth_clients.token_ttl (the same per-client override the
    // admin API writes) and echo the EFFECTIVE value in the registration
    // response so the caller can show the user what it actually got.
    let effectiveTtl: number | undefined;
    const requestedTtl = dcrRegistrationContext.getStore()?.tokenTtlSeconds;
    if (typeof requestedTtl === 'number' && Number.isFinite(requestedTtl)) {
      const clamped = clampDcrTokenTtl(requestedTtl, this.dcrTtlMin, this.dcrTtlMax);
      try {
        await this.sql`UPDATE oauth_clients SET token_ttl = ${clamped} WHERE client_id = ${clientId}`;
        effectiveTtl = clamped;
      } catch (e) {
        // Pre-migration schema without the token_ttl column: keep the
        // registration, but do NOT echo a TTL that wasn't persisted.
        if (!isUndefinedColumnError(e, 'token_ttl')) throw e;
      }
    }

    // Public clients: omit `client_secret` entirely from the response so
    // the wire payload matches RFC 7591 §3.2.1 ("if the client is a
    // public client, the authorization server MUST NOT issue a client
    // secret"). Confidential clients return the freshly-generated secret
    // exactly once — same shape as before.
    const response: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: now,
    };
    if (clientSecret) response.client_secret = clientSecret;
    if (effectiveTtl !== undefined) {
      (response as Record<string, unknown>).token_ttl_seconds = effectiveTtl;
    }
    return response;
  }
}

// ---------------------------------------------------------------------------
// OAuth Provider
// ---------------------------------------------------------------------------

export class GBrainOAuthProvider implements OAuthServerProvider {
  private sql: SqlQuery;
  private _clientsStore: GBrainClientsStore;
  private readonly dcrDisabled: boolean;
  private tokenTtl: number;
  private refreshTtl: number;

  constructor(options: GBrainOAuthProviderOptions) {
    this.sql = options.sql;
    this.dcrDisabled = options.dcrDisabled === true;
    this.tokenTtl = options.tokenTtl || 3600;
    this.refreshTtl = options.refreshTtl || 30 * 24 * 3600;
    // #2179 fail-closed: an unset DCR max is bounded by the operator's own
    // token TTL — never a fixed permissive ceiling — so a self-registering
    // client cannot elect a longer-lived token than the server default
    // unless the admin explicitly configured a wider window.
    const dcrTtlMin = options.dcrTtlMinSeconds ?? DEFAULT_DCR_TTL_MIN_SECONDS;
    const dcrTtlMax = options.dcrTtlMaxSeconds ?? Math.max(this.tokenTtl, dcrTtlMin);
    this._clientsStore = new GBrainClientsStore(
      this.sql,
      options.allowClientCredentialsDcr === true,
      dcrTtlMin,
      dcrTtlMax,
    );
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    if (this.dcrDisabled) {
      // Surface getClient only — without registerClient the SDK's mcpAuthRouter
      // does not wire up the /register DCR endpoint. Replaces the prior
      // monkey-patch in serve-http.ts; the outcome is identical (DCR off-by-
      // default), but the API expresses intent on the constructor instead of
      // requiring callers to mutate `_clientsStore` after construction.
      return {
        getClient: this._clientsStore.getClient.bind(this._clientsStore),
      } as OAuthRegisteredClientsStore;
    }
    return this._clientsStore;
  }

  // -------------------------------------------------------------------------
  // Authorization Code Flow
  // -------------------------------------------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const code = generateToken('gbrain_code_');
    const codeHash = hashToken(code);
    const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minute TTL

    // Scope clamp (RFC 6749 §3.3): the SDK's authorize handler splits
    // `?scope=...` verbatim and forwards the raw list to the provider, so
    // the provider MUST clamp against the client's registered grant. Without
    // this, a `read`-registered client requesting `?scope=admin` would have
    // `['admin']` stored in oauth_codes and returned by exchangeAuthorizationCode
    // as a fully-admin access token. Mirrors the filter pattern already used
    // by exchangeClientCredentials (this file) and exchangeRefreshToken's F3
    // subset enforcement (RFC 6749 §6) so all three grant entry points clamp
    // consistently. When the client requests NO scope, RFC 6749 §3.3 lets the
    // server fall back to a default — we default to the client's full
    // registered scope (matching exchangeClientCredentials, which already does
    // `requestedScope ? ... : allowedScopes`). Previously an omitted request
    // granted the empty set, which then propagated into the access+refresh
    // tokens and never self-healed: every op failed `insufficient_scope` even
    // though the client was registered with `read write`. Clients that omit
    // `scope` on /authorize (e.g. some MCP connectors) hit this. Still clamped
    // to the allowed set, so an explicit over-broad request can't escalate.
    const allowedScopes = parseScopeString(client.scope);
    const requestedScopes = (params.scopes && params.scopes.length) ? params.scopes : allowedScopes;
    const grantedScopes = requestedScopes.filter(s => hasScope(allowedScopes, s));

    await this.sql`
      INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
                                code_challenge_method, redirect_uri, state, resource, expires_at)
      VALUES (${codeHash}, ${client.client_id},
              ${pgArray(grantedScopes)},
              ${params.codeChallenge}, ${'S256'},
              ${params.redirectUri}, ${params.state || null},
              ${params.resource?.toString() || null}, ${expiresAt})
    `;

    // Redirect back with the code
    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) redirectUrl.searchParams.set('state', params.state);
    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const codeHash = hashToken(authorizationCode);
    // F1 hardening: bind client_id atomically so a wrong client cannot read
    // another client's PKCE challenge. Pre-fix the SELECT didn't filter on
    // client_id at all.
    const rows = await this.sql`
      SELECT code_challenge FROM oauth_codes
      WHERE code_hash = ${codeHash}
        AND client_id = ${client.client_id}
        AND expires_at > ${Math.floor(Date.now() / 1000)}
    `;
    if (rows.length === 0) throw new Error('Authorization code not found or expired');
    return rows[0].code_challenge as string;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeHash = hashToken(authorizationCode);
    const now = Math.floor(Date.now() / 1000);

    // F1 + F7c hardening: bind client_id AND redirect_uri atomically into the
    // DELETE WHERE clause. RFC 6749 §10.5 requires auth codes be single-use;
    // RFC 6749 §4.1.3 requires the token endpoint validate redirect_uri
    // matches the value sent at /authorize. The previous SELECT-then-compare
    // pattern (a) burned the code on the wrong-client path so the legitimate
    // client could not retry, and (b) ignored redirect_uri on exchange
    // entirely. With RETURNING, the second request — or any wrong-client /
    // wrong-redirect-uri attempt — gets zero rows back and fails cleanly.
    // The legitimate client's code stays available for one valid redemption.
    //
    // Use `redirectUri !== undefined` rather than truthy — an attacker
    // submitting `redirect_uri=""` (empty string) at /token would otherwise
    // hit the falsy branch and bypass the binding entirely.
    const rows = redirectUri !== undefined
      ? await this.sql`
          DELETE FROM oauth_codes
          WHERE code_hash = ${codeHash}
            AND client_id = ${client.client_id}
            AND redirect_uri = ${redirectUri}
            AND expires_at > ${now}
          RETURNING client_id, scopes, resource
        `
      : await this.sql`
          DELETE FROM oauth_codes
          WHERE code_hash = ${codeHash}
            AND client_id = ${client.client_id}
            AND expires_at > ${now}
          RETURNING client_id, scopes, resource
        `;
    if (rows.length === 0) throw new Error('Authorization code not found or expired');

    const codeRow = rows[0];

    // Issue tokens
    const scopes = (codeRow.scopes as string[]) || [];
    return this.issueTokens(client.client_id, scopes, resource, true);
  }

  // -------------------------------------------------------------------------
  // Refresh Token
  // -------------------------------------------------------------------------

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const tokenHash = hashToken(refreshToken);
    const now = Math.floor(Date.now() / 1000);

    // F2 hardening: bind client_id atomically into the DELETE WHERE clause.
    // RFC 6749 §10.4 detection of stolen refresh tokens depends on second-use
    // failure. The previous SELECT-then-DELETE pattern + post-hoc client
    // compare let an attacker who guessed/stole a refresh token burn it on
    // the wrong-client path, defeating the stolen-token signal for the
    // legitimate client. With the predicate in the DELETE, wrong-client
    // attempts get zero rows back; the legitimate client retains the row
    // for one valid rotation.
    const rows = await this.sql`
      DELETE FROM oauth_tokens
      WHERE token_hash = ${tokenHash}
        AND token_type = 'refresh'
        AND client_id = ${client.client_id}
      RETURNING client_id, scopes, expires_at
    `;
    // #4532: InvalidGrantError (not bare Error) — the SDK's token handler maps
    // OAuthError subclasses to their RFC 6749 wire shape (400 invalid_grant)
    // and everything else to a 500 Internal Server Error. A refresh with a
    // rotated/expired token is a routine client condition (RFC 6749 §5.2
    // invalid_grant), and the 500 made well-behaved MCP clients treat it as a
    // server outage instead of re-running the authorization flow.
    if (rows.length === 0) throw new InvalidGrantError('Refresh token not found');

    const row = rows[0];
    // NULL expires_at is treated as expired (fail-closed). Schema permits NULL
    // even though issueTokens always sets it, so a corrupt or hand-modified row
    // can't ride past validation.
    const expiresAt = coerceTimestamp(row.expires_at);
    if (expiresAt === undefined || expiresAt < now) throw new InvalidGrantError('Refresh token expired');

    // F3 hardening: requested scopes on refresh MUST be a subset of the
    // original grant on this refresh token's row. RFC 6749 §6: "the scope of
    // the access token … MUST NOT include any scope not originally granted by
    // the resource owner." Scope is checked against the row's scopes (the
    // grant), NOT against the client's currently-allowed scopes (which can
    // expand later). Omitted scope (`undefined`) inherits the original grant
    // verbatim and stays distinct from an explicit empty array.
    //
    // v0.28: hasScope replaces exact-string-match so an `admin` grant CAN
    // refresh down to `sources_admin` (admin implies all). Without this,
    // gstack /setup-gbrain Path 4 — which mints a sources_admin-scoped
    // refresh — would fail when the brain admin's bootstrap token was
    // issued at the `admin` tier.
    const grantedScopes = (row.scopes as string[]) || [];
    if (scopes && scopes.some(s => !hasScope(grantedScopes, s))) {
      throw new Error('Requested scope exceeds refresh token grant');
    }
    const tokenScopes = scopes ?? grantedScopes;
    return this.issueTokens(client.client_id, tokenScopes, resource, true);
  }

  // -------------------------------------------------------------------------
  // Token Verification
  // -------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<SdkAuthInfo> {
    const tokenHash = hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    // Try OAuth tokens first. JOIN oauth_clients in the same query so
    // verifyAccessToken returns client_name AND source_id in AuthInfo —
    // eliminates the separate per-request lookup at serve-http.ts that
    // was the N+1 hot path (see PR #586 review D14=B; v0.34.1 #861 D2
    // adds the source_id thread on the same JOIN).
    //
    // v0.34.1 (#861): the JOIN guards on a c.source_id column that
    // migration v60 adds. Pre-v60 brains throw a "column does not exist"
    // error here — caught at the boundary via isUndefinedColumnError so
    // unmigrated brains degrade to "no source scope" rather than refusing
    // every token verification.
    let oauthRows: Record<string, unknown>[];
    try {
      oauthRows = await this.sql`
        SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name,
               c.source_id, c.federated_read, c.bound_slug_prefixes,
               c.surface, c.surface_set_by
        FROM oauth_tokens t
        LEFT JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
      `;
    } catch (err) {
      // Degrade ladder for brains that haven't run apply-migrations yet:
      // surface/surface_set_by (v127) → bound_slug_prefixes (v85) →
      // federated_read (v61) → source_id (v60) → pre-v0.34 base projection.
      // Auth must keep working the whole way down.
      //
      // `isUndefinedColumnError(err, name)` canNOT actually tell us WHICH
      // column was missing — with SQLSTATE 42703 present it returns true for
      // any undefined column, and the name is only consulted in the message
      // fallback. So the ladder must not branch on the reported name; it
      // walks every narrower projection in turn, each guarded, and only
      // rethrows once the narrowest one still fails. (Branching on the name
      // is what made the first cut of this hard-fail every token
      // verification on a pre-v61 brain.)
      // Any of the optional columns may be the missing one, and on the
      // message-fallback path (drivers that don't surface SQLSTATE) the name
      // is what identifies it — so probe all five at every rung (ENG-9:
      // surface + surface_set_by ship in one migration and go missing
      // together, so BOTH names are probed).
      const missingOAuthColumn = (e: unknown): boolean =>
        isUndefinedColumnError(e, 'surface') ||
        isUndefinedColumnError(e, 'surface_set_by') ||
        isUndefinedColumnError(e, 'bound_slug_prefixes') ||
        isUndefinedColumnError(e, 'federated_read') ||
        isUndefinedColumnError(e, 'source_id');
      if (!missingOAuthColumn(err)) throw err;
      try {
        // v127 missing: drop the surface columns first, keep the fence
        // column (WP4 amendment 17 — the NEW top rung). Surface degrade is
        // fail-OPEN by design: the serve-http ceiling still bounds every
        // request, so a missing per-client surface only means "server
        // surface applies", never a widened catalog.
        oauthRows = await this.sql`
          SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name,
                 c.source_id, c.federated_read, c.bound_slug_prefixes
          FROM oauth_tokens t
          LEFT JOIN oauth_clients c ON c.client_id = t.client_id
          WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
        `;
      } catch (errS) {
        if (!missingOAuthColumn(errS)) throw errS;
        try {
          // v85 missing: keep source_id + federated_read, drop the fence column.
          oauthRows = await this.sql`
            SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name,
                   c.source_id, c.federated_read
            FROM oauth_tokens t
            LEFT JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
          `;
        } catch (err2) {
          if (!missingOAuthColumn(err2)) throw err2;
          try {
            // v61 missing: source_id only.
            oauthRows = await this.sql`
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.source_id
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
            `;
          } catch (err3) {
            if (!missingOAuthColumn(err3)) throw err3;
            // Truly pre-v60: pre-v0.34 projection.
            oauthRows = await this.sql`
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
            `;
          }
        }
      }
    }

    if (oauthRows.length > 0) {
      const row = oauthRows[0];
      // NULL expires_at is treated as expired (fail-closed). Schema permits NULL,
      // and the SDK's bearerAuth requires `typeof expiresAt === 'number'` — we
      // throw here rather than return an undefined-bearing AuthInfo.
      const expiresAt = coerceTimestamp(row.expires_at);
      if (expiresAt === undefined || expiresAt < now) {
        throw new InvalidTokenError('Token expired');
      }
      // v0.34.1 (#876): federated_read normalization. SELECT returns
      // either a JS array (Postgres / PGLite text[] driver mapping) or
      // undefined when the legacy projection ran (pre-v61 brain). Empty
      // array vs undefined matters: empty array = explicit no-federated-
      // read; undefined = column missing on this brain.
      const federatedRaw = row.federated_read;
      const rowSourceId = (row.source_id as string | null) ?? undefined;
      let allowedSources = Array.isArray(federatedRaw)
        ? (federatedRaw as string[])
        : undefined;
      // Degraded-projection safety: `resolveRequestedScope` only authorizes an
      // explicitly requested `source_id` when `allowedSources` is a NON-EMPTY
      // array — with it undefined, a remote caller naming any source is
      // accepted. On a brain missing `federated_read` the ladder above returns
      // exactly that undefined, so a client scoped to one source could read
      // every other source by passing `source_id`. Synthesize the client's own
      // source as its grant so the authorization check stays armed. (Legacy
      // `access_tokens` keep their historical scope handling below — this only
      // covers the OAuth rows whose column we just dropped.)
      if (allowedSources === undefined && rowSourceId !== undefined) {
        allowedSources = [rowSourceId];
      }
      // v0.42.72.0: slug-prefix write binding. Array (even empty — the
      // fence treats [] as deny-all, matching submit_agent's fail-closed
      // posture) when the client carries a binding; undefined when the
      // column is NULL, the projection degraded, or the brain predates
      // the column.
      const boundRaw = row.bound_slug_prefixes;
      const boundSlugPrefixes = Array.isArray(boundRaw)
        ? (boundRaw as string[])
        : undefined;
      // Fail CLOSED on the fence axis. If the projection degraded, we do not
      // know whether this client carries a binding, and "column absent" is
      // indistinguishable from "no binding" downstream. On a genuinely
      // pre-v85 brain no binding can exist and this is harmless; the case
      // that matters is a partially broken schema (interrupted migration,
      // restored dump missing one column) where bindings DO exist and every
      // bound client would otherwise be silently unfenced.
      const fenceProjectionDegraded = !('bound_slug_prefixes' in row);
      // WP4 (D2): per-client tool surface. Raw TEXT threaded as-is — the
      // value space is OPEN (amendment 18; future tiers write tier names into
      // this column), so parsing/warning happens at the serve-http resolution
      // site, not here. Undefined when the column is NULL, the projection
      // degraded (v127 rung), or the brain predates v127. Surface degrade is
      // fail-open by design: the server ceiling still bounds every request.
      const rowSurface = typeof row.surface === 'string' ? row.surface : undefined;
      const rowSurfaceSetBy = typeof row.surface_set_by === 'string' ? row.surface_set_by : undefined;
      return {
        token,
        clientId: row.client_id as string,
        clientName: (row.client_name as string | null) ?? undefined,
        scopes: (row.scopes as string[]) || [],
        expiresAt,
        resource: row.resource ? new URL(row.resource as string) : undefined,
        // v0.34.1 (#861, D2): source-isolation scope from oauth_clients.
        // Undefined when the row predates v60 or when the brain itself
        // predates v60 (fell through to the legacy projection above).
        sourceId: rowSourceId,
        // v0.34.1 (#876): federated read scope. sourceScopeOpts in
        // operations.ts prefers this array over scalar sourceId when set
        // and non-empty.
        allowedSources,
        // v0.42.72.0: write fence — consumed by enforceClientSlugFence in
        // operations.ts on every direct slug-mutating write op.
        boundSlugPrefixes,
        ...(fenceProjectionDegraded ? { fenceProjectionDegraded: true } : {}),
        // WP4: per-client surface + operator-lock marker (amendment 19).
        ...(rowSurface !== undefined ? { surface: rowSurface } : {}),
        ...(rowSurfaceSetBy !== undefined ? { surfaceSetBy: rowSurfaceSetBy } : {}),
      } as CoreAuthInfo as SdkAuthInfo;
    }

    // Fallback: legacy access_tokens table (backward compat). Modern legacy
    // rows may carry permissions.source_id from the pre-OAuth bearer-token
    // path; OAuth transport must preserve that same source grant instead of
    // pinning every legacy token to `default`.
    let legacyRows: Record<string, unknown>[];
    try {
      legacyRows = await this.sql`
        SELECT name, permissions, scopes FROM access_tokens
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
      `;
    } catch (err) {
      if (isUndefinedColumnError(err, 'permissions')) {
        // Pre-v38 brain: no permissions column. scopes is ORIGINAL schema, so
        // it must stay in the degraded SELECT — dropping it here would route
        // normalizeTokenScopes(undefined) into the grandfather branch and
        // silently promote a scoped token to full admin on any brain whose
        // permissions projection fails (ship-review P1). Only if scopes
        // ITSELF is missing (out-of-tree schema) does the ladder fall to
        // name-only — and that brain predates scoped minting entirely.
        try {
          legacyRows = await this.sql`
            SELECT name, scopes FROM access_tokens
            WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
          `;
        } catch (err2) {
          if (!isUndefinedColumnError(err2, 'scopes')) throw err2;
          legacyRows = await this.sql`
            SELECT name FROM access_tokens
            WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
          `;
        }
      } else {
        throw err;
      }
    }

    if (legacyRows.length > 0) {
      // For legacy tokens, name = clientId = clientName (single identifier).
      // #2833: debounced fire-and-forget last_used_at update — only writes
      // once per token per 60s, and NEVER blocks or fails verification (a
      // slow/broken UPDATE used to hang or 401 every legacy-token request).
      // Mirrors src/mcp/http-transport.ts validateToken; the SQL-level WHERE
      // keeps the debounce race-tolerant under concurrent requests.
      this.sql`
        UPDATE access_tokens
        SET last_used_at = now()
        WHERE token_hash = ${tokenHash}
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')
      `.catch(() => { /* fire-and-forget */ });
      const name = legacyRows[0].name as string;
      const permissions = coerceLegacyPermissions(legacyRows[0].permissions);
      const { sourceId, allowedSources } = parseLegacyTokenScope(permissions?.source_id);
      // #2529: thread the stored takes-holders grant, mirroring the legacy
      // HTTP transport's validateToken (both decode via coerceLegacyPermissions
      // + parseTakesHoldersAllowList so they cannot drift). Undefined (no array
      // grant, or the pre-v29 no-permissions-column fallback above) → the /mcp
      // dispatch site defaults to the fail-closed ['world']. An explicit []
      // grant is preserved as deny-all.
      const takesHoldersAllowList = parseTakesHoldersAllowList(permissions?.takes_holders);
      // #4043 least-privilege: the original-schema `scopes TEXT[]` column is
      // the scope store. NULL/absent (every token minted before this feature)
      // → grandfathered full access, byte-identical behavior. An array is
      // filtered to known scopes and honored as-is — including [] as deny.
      const grantedScopes = normalizeTokenScopes(legacyRows[0].scopes);
      return {
        token,
        clientId: name,
        clientName: name,
        scopes: grantedScopes ?? ['read', 'write', 'admin'],
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600, // Legacy tokens never expire — set 1yr future
        // Legacy tokens without an explicit permissions.source_id grant keep
        // the historical 'default' source floor. Array grants become
        // allowedSources for federated reads, matching legacy HTTP transport.
        sourceId,
        allowedSources,
        // #3242 parity with src/mcp/http-transport.ts: only the historical
        // no-grant floor may widen unqualified reads to the federated set.
        hasSourceGrant: permissions?.source_id != null,
        takesHoldersAllowList,
      } as CoreAuthInfo as SdkAuthInfo;
    }

    throw new InvalidTokenError('Invalid token');
  }

  // -------------------------------------------------------------------------
  // Token Revocation
  // -------------------------------------------------------------------------

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashToken(request.token);
    // F4 hardening: bind client_id so a client can only revoke its own
    // tokens. RFC 7009 §2.1: "The authorization server first validates the
    // client credentials … and then verifies whether the token was issued
    // to the client making the revocation request." Pre-fix, any
    // authenticated client that knew (or guessed) another client's token
    // hash could revoke it.
    await this.sql`
      DELETE FROM oauth_tokens
      WHERE token_hash = ${tokenHash}
        AND client_id = ${client.client_id}
    `;
  }

  // -------------------------------------------------------------------------
  // Client Credentials (called by custom handler, not SDK)
  // -------------------------------------------------------------------------

  /**
   * v0.37.7.0 #1166 — verify a confidential client's secret without
   * spending it. Returns the validated client info on success, throws
   * with an opaque "Invalid client" message on failure (mirrors RFC 6749
   * §5.2 invalid_client semantics). Used by the serve-http custom
   * /token handler for `authorization_code` + `refresh_token` grants on
   * confidential clients, since the SDK's plaintext compare in
   * clientAuth.js can't see our hash-only storage.
   *
   * Public clients (token_endpoint_auth_method === 'none') return
   * `client_secret_hash = NULL` from getClient; this method refuses
   * them so the SDK's PKCE path stays the canonical surface.
   */
  async verifyConfidentialClientSecret(
    clientId: string,
    presentedSecret: string,
  ): Promise<OAuthClientInformationFull> {
    const client = await this._clientsStore.getClient(clientId);
    if (!client) throw new Error('Invalid client');
    // Public client — refuse to use this hash-compare path.
    if (client.client_secret === undefined) {
      throw new Error('Invalid client');
    }
    const presentedHash = hashToken(presentedSecret);
    // client.client_secret is the stored SHA-256 hash (getClient returns
    // it as the `client_secret` field per the v0.34.1.0 normalization).
    // Compare via SHA-256-then-equals; constant-time compare a follow-up.
    if (client.client_secret !== presentedHash) {
      throw new Error('Invalid client');
    }
    // Soft-delete probe — same shape as exchangeClientCredentials.
    try {
      const [revoked] = await this.sql`SELECT deleted_at FROM oauth_clients WHERE client_id = ${clientId} AND deleted_at IS NOT NULL`;
      if (revoked) throw new Error('Client has been revoked');
    } catch (e) {
      if (e instanceof Error && e.message === 'Client has been revoked') throw e;
      if (!isUndefinedColumnError(e, 'deleted_at')) throw e;
    }
    return client;
  }

  async exchangeClientCredentials(
    clientId: string,
    clientSecret: string,
    requestedScope?: string,
  ): Promise<OAuthTokens> {
    const client = await this._clientsStore.getClient(clientId);
    if (!client) throw new Error('Client not found');

    // Check if client has been revoked (soft-deleted). The deleted_at column
    // is recent — pre-migration brains don't have it, so the probe must
    // tolerate that one specific failure mode without swallowing real errors
    // (lock timeouts, network blips, auth failures).
    try {
      const [revoked] = await this.sql`SELECT deleted_at FROM oauth_clients WHERE client_id = ${clientId} AND deleted_at IS NOT NULL`;
      if (revoked) throw new Error('Client has been revoked');
    } catch (e) {
      // F5 hardening: surface anything that ISN'T a missing-column error.
      // Bare `catch {}` masked DB outages as "client not revoked" — fail-open
      // posture in a security-sensitive code path.
      if (e instanceof Error && e.message === 'Client has been revoked') throw e;
      if (!isUndefinedColumnError(e, 'deleted_at')) throw e;
    }

    // Check grant type first (before verifying secret)
    const grants = (client.grant_types as string[]) || [];
    if (!grants.includes('client_credentials')) {
      throw new Error('Client credentials grant not authorized for this client');
    }

    // Verify secret
    const secretHash = hashToken(clientSecret);
    if (client.client_secret !== secretHash) throw new Error('Invalid client secret');

    // Determine scopes. v0.28 swaps exact-string-match for hasScope so a
    // client whose grant is `admin` can mint tokens that include implied
    // scopes like `sources_admin` (admin implies all). Tokens are still
    // capped by what the client was registered for — this only changes how
    // the cap is computed.
    const allowedScopes = parseScopeString(client.scope);
    const requestedScopes = requestedScope ? parseScopeString(requestedScope) : allowedScopes;
    const grantedScopes = requestedScopes.filter(s => hasScope(allowedScopes, s));

    // Client credentials: access token only, NO refresh token (RFC 6749 4.4.3)
    // Per-client TTL (oauth_clients.token_ttl) is applied inside issueTokens
    // so all three grant paths honor it (#2179).
    return this.issueTokens(clientId, grantedScopes, undefined, false);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async sweepExpiredTokens(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    // F6 hardening: postgres.js and PGLite expose deleted-row count on
    // different shapes; `(result as any).count` returned 0 on at least one
    // engine even when rows were deleted, and codes were never counted at
    // all. RETURNING 1 + array length is portable across both engines.
    const result = await this.sql`
      DELETE FROM oauth_tokens WHERE expires_at < ${now} RETURNING 1
    `;
    const deletedCodes = await this.sql`
      DELETE FROM oauth_codes WHERE expires_at < ${now} RETURNING 1
    `;
    return result.length + deletedCodes.length;
  }

  // -------------------------------------------------------------------------
  // CLI Registration Helper
  // -------------------------------------------------------------------------

  async registerClientManual(
    name: string,
    grantTypes: string[],
    scopes: string,
    redirectUris: string[] = [],
    sourceId: string = 'default',
    federatedRead?: string[],
    tokenEndpointAuthMethod?: string,
    agentBindings?: AgentClientBindings,
  ): Promise<{ clientId: string; clientSecret?: string }> {
    // v0.28: ALLOWED_SCOPES allowlist. Reject `--scopes "read flying-unicorn"`
    // at registration so meaningless scope strings can't pile up in the DB.
    // Pre-allowlist clients keep working (allowlist is registration-time;
    // existing rows aren't re-validated).
    assertAllowedScopes(parseScopeString(scopes));

    // A bound_slug_prefixes entry that is empty or whitespace-only makes
    // `startsWith` true for every slug — a binding that looks set in
    // `auth list` and the admin UI while fencing nothing. Reject at
    // registration, the same way source ids are validated.
    if (agentBindings?.boundSlugPrefixes) {
      // Same rule as rescopeClient: an empty list is ambiguous. It registers
      // as deny-all for every direct write while printing an empty binding
      // line, so an operator cannot tell it from an unbound client.
      if (agentBindings.boundSlugPrefixes.length === 0) {
        throw new Error('--bound-slug-prefixes cannot be an empty list (pass prefixes, or omit the flag for full-source write authority)');
      }
      assertValidSlugPrefixes(agentBindings.boundSlugPrefixes);
    }

    // v0.41.3 (T1+T2): validate token_endpoint_auth_method at the registration
    // boundary. Throws InvalidTokenEndpointAuthMethodError on bad input.
    // Default is `client_secret_post` (RFC 7591 §2).
    const authMethod = validateTokenEndpointAuthMethod(tokenEndpointAuthMethod);

    const clientId = generateToken('gbrain_cl_');
    // v0.41.3 (T2): atomic public-client INSERT. When the caller declares
    // `tokenEndpointAuthMethod: 'none'` we mint NO secret and INSERT with
    // client_secret_hash = NULL in a single statement. Pre-fix, the admin
    // endpoint did INSERT-then-UPDATE which left a confidential row stranded
    // if the UPDATE failed mid-flight (codex F4). Confidential clients
    // (`client_secret_post` / `client_secret_basic`) get the secret minted
    // and hashed as before.
    const isPublicClient = authMethod === 'none';
    const clientSecret = isPublicClient ? undefined : generateToken('gbrain_cs_');
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    const now = Math.floor(Date.now() / 1000);

    // v0.34.1 (#861 + #876): persist source_id AND federated_read so
    // verifyAccessToken can populate both AuthInfo fields. Defaults:
    //   source_id = 'default' (matches v60 backfill)
    //   federated_read = [source_id] when omitted (a non-federated client
    //                    has read scope == write scope, the v0.33 default)
    const federated = federatedRead && federatedRead.length > 0 ? federatedRead : [sourceId];
    try {
      if (agentBindings) {
        await this.sql`
          INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                      grant_types, scope, token_endpoint_auth_method,
                                      client_id_issued_at,
                                      source_id, federated_read,
                                      bound_tools, bound_source_id, bound_brain_id,
                                      bound_slug_prefixes, bound_max_concurrent, budget_usd_per_day)
          VALUES (${clientId}, ${secretHash}, ${name},
                  ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now},
                  ${sourceId}, ${pgArray(federated)},
                  ${agentBindings.boundTools ? pgArray(agentBindings.boundTools) : null},
                  ${agentBindings.boundSourceId ?? null}, ${agentBindings.boundBrainId ?? null},
                  ${agentBindings.boundSlugPrefixes ? pgArray(agentBindings.boundSlugPrefixes) : null},
                  ${agentBindings.boundMaxConcurrent ?? 1}, ${agentBindings.budgetUsdPerDay ?? null})
        `;
      } else {
        await this.sql`
          INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                      grant_types, scope, token_endpoint_auth_method,
                                      client_id_issued_at,
                                      source_id, federated_read)
          VALUES (${clientId}, ${secretHash}, ${name},
                  ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now},
                  ${sourceId}, ${pgArray(federated)})
        `;
      }
    } catch (err) {
      if (agentBindings && (
        isUndefinedColumnError(err, 'bound_tools') ||
        isUndefinedColumnError(err, 'bound_source_id') ||
        isUndefinedColumnError(err, 'bound_brain_id') ||
        isUndefinedColumnError(err, 'bound_slug_prefixes') ||
        isUndefinedColumnError(err, 'bound_max_concurrent') ||
        isUndefinedColumnError(err, 'budget_usd_per_day')
      )) {
        throw new Error('register-client --bound-* flags require an up-to-date OAuth schema; run `gbrain apply-migrations --yes` and retry.');
      }
      // Pre-v60 / pre-v61 brain: column missing. Fall back through both
      // projections so registration still works until apply-migrations.
      if (isUndefinedColumnError(err, 'federated_read')) {
        // v60-only brain: source_id but no federated_read.
        try {
          await this.sql`
            INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                        grant_types, scope, token_endpoint_auth_method,
                                        client_id_issued_at, source_id)
            VALUES (${clientId}, ${secretHash}, ${name},
                    ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now}, ${sourceId})
          `;
        } catch (err2) {
          if (isUndefinedColumnError(err2, 'source_id')) {
            await this.sql`
              INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                          grant_types, scope, token_endpoint_auth_method,
                                          client_id_issued_at)
              VALUES (${clientId}, ${secretHash}, ${name},
                      ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now})
            `;
          } else {
            throw err2;
          }
        }
      } else if (isUndefinedColumnError(err, 'source_id')) {
        await this.sql`
          INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                      grant_types, scope, token_endpoint_auth_method,
                                      client_id_issued_at)
          VALUES (${clientId}, ${secretHash}, ${name},
                  ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${authMethod}, ${now})
        `;
      } else {
        throw err;
      }
    }

    return { clientId, clientSecret };
  }

  /**
   * v0.42.x (#1914): admin-gated rescope for an existing OAuth client.
   *
   * DCR clients self-register with source_id='default' +
   * federated_read=['default'] and MUST NOT be able to widen their own
   * scope (fail-closed trust). This is the trusted-operator surface that
   * changes it afterward: `gbrain auth rescope-client` (local CLI) and
   * POST /admin/api/rescope-client (requireAdmin) both route here.
   *
   * Omitted fields are left untouched (COALESCE). Takes effect on the
   * client's NEXT request even for already-issued tokens, because
   * verifyAccessToken re-reads oauth_clients on every verification.
   */
  async rescopeClient(
    clientId: string,
    opts: {
      sourceId?: string;
      federatedRead?: string[];
      boundSlugPrefixes?: string[] | null;
      /**
       * WP4 (D2/amendment 19): per-client tool surface. Tri-state —
       * undefined = untouched, null = clear (both surface AND
       * surface_set_by go NULL), value = set + surface_set_by='operator'
       * (the operator lock: request_tools persist cannot override it).
       */
      surface?: 'verbs' | 'starter' | 'full' | null;
    },
  ): Promise<{ clientId: string; clientName: string; sourceId: string; federatedRead: string[]; boundSlugPrefixes?: string[] | null; surface?: string | null; surfaceOld?: string | null }> {
    const { sourceId, federatedRead, boundSlugPrefixes, surface } = opts;
    if (sourceId === undefined && federatedRead === undefined && boundSlugPrefixes === undefined && surface === undefined) {
      throw new Error('rescope-client requires --source, --federated-read, --bound-slug-prefixes, and/or --surface');
    }
    if (sourceId !== undefined) assertValidSourceId(sourceId);
    if (federatedRead !== undefined) {
      if (federatedRead.length === 0) {
        throw new Error('--federated-read cannot be empty (pass at least one source id)');
      }
      for (const s of federatedRead) assertValidSourceId(s);
    }
    // WP4: only the three known surfaces are OPERATOR-writable here; the
    // column value space stays open (amendment 18) for future tier writers,
    // but this surface validates so a typo'd rescope fails loud, not silent.
    if (surface !== undefined && surface !== null
        && surface !== 'verbs' && surface !== 'starter' && surface !== 'full') {
      throw new Error(`--surface must be verbs | starter | full | clear (got "${String(surface)}")`);
    }
    // v0.42.72.0: bound_slug_prefixes rescope, so channel-membership churn
    // (the qm-harness roster case) updates the write fence in place instead
    // of forcing a register+rotate cycle. Tri-state: undefined = untouched,
    // null = clear the binding (client returns to unbound full-source write
    // authority), non-empty array = replace. Empty array is rejected here —
    // it means deny-all at the fence, which an operator should express by
    // revoking write scope, not by an ambiguous empty list.
    if (Array.isArray(boundSlugPrefixes)) {
      if (boundSlugPrefixes.length === 0) {
        throw new Error('--bound-slug-prefixes cannot be an empty list (pass prefixes, or "none" to clear the binding)');
      }
      assertValidSlugPrefixes(boundSlugPrefixes);
    }
    let rows: Record<string, unknown>[];
    // WP4: when the surface axis is being touched, capture the OLD value
    // first so callers can write the amendment-32 audit row ({old, new}).
    let surfaceOld: string | null | undefined;
    try {
      if (surface !== undefined) {
        const prior = await this.sql`
          SELECT surface FROM oauth_clients WHERE client_id = ${clientId}
        `;
        surfaceOld = prior.length > 0 ? ((prior[0].surface as string | null) ?? null) : null;
      }
      // Only touch bound_slug_prefixes / surface when the caller actually
      // passed them. Naming a column unconditionally would make a plain
      // `rescope-client --source wiki` fail on a brain that has the v60/v61
      // OAuth columns but not v85's bound_* set (or v127's surface set) — a
      // regression on an axis the caller never asked about.
      const surfaceSetBy = surface === null ? null : 'operator';
      if (boundSlugPrefixes === undefined && surface === undefined) {
        rows = await this.sql`
            UPDATE oauth_clients
               SET source_id = COALESCE(${sourceId ?? null}::text, source_id),
                   federated_read = COALESCE(${federatedRead ? pgArray(federatedRead) : null}::text[], federated_read)
             WHERE client_id = ${clientId}
             RETURNING client_id, client_name, source_id, federated_read
          `;
      } else if (boundSlugPrefixes === undefined) {
        rows = await this.sql`
            UPDATE oauth_clients
               SET source_id = COALESCE(${sourceId ?? null}::text, source_id),
                   federated_read = COALESCE(${federatedRead ? pgArray(federatedRead) : null}::text[], federated_read),
                   surface = ${surface ?? null}::text,
                   surface_set_by = ${surfaceSetBy}::text
             WHERE client_id = ${clientId}
             RETURNING client_id, client_name, source_id, federated_read, surface, surface_set_by
          `;
      } else if (surface === undefined) {
        rows = await this.sql`
            UPDATE oauth_clients
               SET source_id = COALESCE(${sourceId ?? null}::text, source_id),
                   federated_read = COALESCE(${federatedRead ? pgArray(federatedRead) : null}::text[], federated_read),
                   bound_slug_prefixes = ${boundSlugPrefixes ? pgArray(boundSlugPrefixes) : null}::text[]
             WHERE client_id = ${clientId}
             RETURNING client_id, client_name, source_id, federated_read, bound_slug_prefixes
          `;
      } else {
        rows = await this.sql`
            UPDATE oauth_clients
               SET source_id = COALESCE(${sourceId ?? null}::text, source_id),
                   federated_read = COALESCE(${federatedRead ? pgArray(federatedRead) : null}::text[], federated_read),
                   bound_slug_prefixes = ${boundSlugPrefixes ? pgArray(boundSlugPrefixes) : null}::text[],
                   surface = ${surface ?? null}::text,
                   surface_set_by = ${surfaceSetBy}::text
             WHERE client_id = ${clientId}
             RETURNING client_id, client_name, source_id, federated_read, bound_slug_prefixes, surface, surface_set_by
          `;
      }
    } catch (err) {
      if (
        isUndefinedColumnError(err, 'source_id') ||
        isUndefinedColumnError(err, 'federated_read') ||
        isUndefinedColumnError(err, 'bound_slug_prefixes') ||
        isUndefinedColumnError(err, 'surface') ||
        isUndefinedColumnError(err, 'surface_set_by')
      ) {
        throw new Error('rescope-client requires an up-to-date OAuth schema; run `gbrain apply-migrations --yes` and retry.');
      }
      // FK oauth_clients.source_id → sources(id): translate the raw 23503
      // into an actionable message.
      if ((err as { code?: string })?.code === '23503') {
        throw new Error(`Source "${sourceId}" does not exist. Create it first: gbrain sources add ${sourceId} ...`);
      }
      throw err;
    }
    if (rows.length === 0) {
      throw new Error(`No OAuth client found with id "${clientId}"`);
    }
    const row = rows[0];
    return {
      clientId: row.client_id as string,
      clientName: (row.client_name as string | null) ?? '',
      sourceId: (row.source_id as string | null) ?? 'default',
      federatedRead: Array.isArray(row.federated_read) ? (row.federated_read as string[]) : [],
      // undefined = the column wasn't read this call (caller left the
      // binding untouched), which is distinct from null = no binding set.
      boundSlugPrefixes: 'bound_slug_prefixes' in row
        ? (Array.isArray(row.bound_slug_prefixes) ? (row.bound_slug_prefixes as string[]) : null)
        : undefined,
      // WP4: undefined = surface untouched this call; null = cleared.
      ...(surface !== undefined
        ? { surface: (row.surface as string | null) ?? null, surfaceOld: surfaceOld ?? null }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Internal: Issue access + optional refresh tokens
  // -------------------------------------------------------------------------

  /**
   * Per-client TTL override lookup (oauth_clients.token_ttl). Set by the
   * admin API, the CLI, or a DCR `token_ttl_seconds` request (#2179).
   * Column may not exist on older schemas — graceful fallback to undefined.
   */
  private async lookupClientTokenTtl(clientId: string): Promise<number | undefined> {
    try {
      const ttlRows = await this.sql`SELECT token_ttl FROM oauth_clients WHERE client_id = ${clientId}`;
      if (ttlRows.length > 0 && ttlRows[0].token_ttl) return Number(ttlRows[0].token_ttl);
    } catch (e) {
      // F5 hardening posture: only the "column doesn't exist" path is a
      // non-fatal fall-through.
      if (!isUndefinedColumnError(e, 'token_ttl')) throw e;
    }
    return undefined;
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: URL | undefined,
    includeRefresh: boolean,
  ): Promise<OAuthTokens> {
    const accessToken = generateToken('gbrain_at_');
    const accessHash = hashToken(accessToken);
    const now = Math.floor(Date.now() / 1000);
    // #2179: the per-client override lives here (not in individual grant
    // handlers) so client_credentials, authorization_code AND refresh
    // issuance all honor oauth_clients.token_ttl consistently.
    const effectiveTtl = (await this.lookupClientTokenTtl(clientId)) || this.tokenTtl;
    const accessExpiry = now + effectiveTtl;

    await this.sql`
      INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
      VALUES (${accessHash}, ${'access'}, ${clientId},
              ${pgArray(scopes)}, ${accessExpiry}, ${resource?.toString() || null})
    `;

    const result: OAuthTokens = {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: effectiveTtl,
      scope: scopes.join(' '),
    };

    if (includeRefresh) {
      const refreshToken = generateToken('gbrain_rt_');
      const refreshHash = hashToken(refreshToken);
      const refreshExpiry = now + this.refreshTtl;

      await this.sql`
        INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
        VALUES (${refreshHash}, ${'refresh'}, ${clientId},
                ${pgArray(scopes)}, ${refreshExpiry}, ${resource?.toString() || null})
      `;

      result.refresh_token = refreshToken;
    }

    return result;
  }
}
