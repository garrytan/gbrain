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

import type { Response } from 'express';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidGrantError,
  InvalidScopeError as OAuthInvalidScopeError,
  InvalidTargetError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { hashToken, generateToken, isUndefinedColumnError } from './utils.ts';
import { hasScope, assertAllowedScopes, parseScopeString } from './scope.ts';
import { ACCESS_TIER_DEFAULT, isAccessTier, resolveStoredAccessTier, tierMin, type AccessTier } from './access-tier.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw SQL query function — works with both PGLite and postgres tagged templates */
export type SqlQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

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

function canonicalResource(value: URL | string | undefined | null): string | undefined {
  if (!value) return undefined;
  const url = value instanceof URL ? new URL(value.href) : new URL(value);
  url.hash = '';
  return url.href;
}

function assertResourceBinding(stored: unknown, requested: URL | undefined, context: 'authorization_code' | 'refresh_token'): URL | undefined {
  const storedHref = typeof stored === 'string' && stored ? canonicalResource(stored) : undefined;
  const requestedHref = canonicalResource(requested);
  if (storedHref && !requestedHref) {
    throw new InvalidTargetError(`${context} resource is required`);
  }
  if (!storedHref && requestedHref) {
    throw new InvalidTargetError(`${context} was not issued for a resource`);
  }
  if (storedHref && requestedHref && storedHref !== requestedHref) {
    throw new InvalidTargetError(`${context} resource does not match original grant`);
  }
  return storedHref ? new URL(storedHref) : undefined;
}

function validateGrantTypes(grantTypes: readonly string[] | undefined, context: string): string[] {
  const allowedGrantTypes = new Set(['client_credentials', 'authorization_code']);
  const grants = (grantTypes || ['client_credentials']).map(String).map(s => s.trim()).filter(Boolean);
  if (grants.length === 0) {
    throw new Error(`${context}: at least one grant type is required`);
  }
  for (const grantType of grants) {
    if (!allowedGrantTypes.has(grantType)) {
      throw new Error(`${context}: unsupported grant type "${grantType}"`);
    }
  }
  return grants;
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
  /** MCP resource URL this provider may issue tokens for. */
  resourceServerUrl?: URL;
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
   * v46 OIDC end-user identity federation. When set, the /authorize endpoint
   * redirects to the OIDC issuer instead of returning the gbrain code
   * immediately. The /oauth/oidc/callback handler in serve-http.ts completes
   * the dance: exchanges the IdP code for an id_token, verifies the token,
   * looks the email up in oauth_user_grants, captures the user_tier into the
   * gbrain code row, then redirects to the original client redirect_uri.
   */
  oidc?: {
    /** OIDC verifier instance from src/core/oidc.ts */
    verifier: import('./oidc.ts').OidcVerifier;
    /** OIDC client_id registered with the issuer (Google, Apple, etc.) */
    clientId: string;
    /** Public URL of this gbrain server (e.g. https://brain.example.com) */
    publicUrl: string;
  };
}

interface PendingOidcAuthorization {
  clientId: string;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  clientState?: string;
  resource?: string;
  nonce: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Clients Store
// ---------------------------------------------------------------------------

class GBrainClientsStore implements OAuthRegisteredClientsStore {
  constructor(private sql: SqlQuery) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    // deleted_at IS NULL: a soft-deleted client must not authenticate at
    // /token, /authorize, or /revoke. The verifyAccessToken JOIN already
    // catches issued tokens at use time, but failing earlier here means
    // the SDK's authenticateClient middleware rejects refresh-token
    // rotations and authorization-code redemptions cleanly without
    // depending on the downstream gate. Falls back to the unfiltered
    // query on pre-v33 schemas where deleted_at hasn't been added yet
    // (mirrors the verifyAccessToken UndefinedColumn fallback pattern).
    let rows;
    try {
      rows = await this.sql`
        SELECT client_id, client_secret_hash, client_name, redirect_uris,
               grant_types, scope, token_endpoint_auth_method,
               client_id_issued_at, client_secret_expires_at
        FROM oauth_clients WHERE client_id = ${clientId} AND deleted_at IS NULL
      `;
    } catch (e) {
      if (!isUndefinedColumnError(e, 'deleted_at')) throw e;
      rows = await this.sql`
        SELECT client_id, client_secret_hash, client_name, redirect_uris,
               grant_types, scope, token_endpoint_auth_method,
               client_id_issued_at, client_secret_expires_at
        FROM oauth_clients WHERE client_id = ${clientId}
      `;
    }
    if (rows.length === 0) return undefined;
    const r = rows[0];
    return {
      client_id: r.client_id as string,
      client_secret: r.client_secret_hash as string | undefined,
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
    const grantTypes = validateGrantTypes(client.grant_types, 'registerClient');
    if (grantTypes.includes('authorization_code') && (!client.redirect_uris || client.redirect_uris.length === 0)) {
      throw new Error('authorization_code clients require at least one redirect_uri');
    }

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

    const clientId = generateToken('gbrain_cl_');
    const clientSecret = generateToken('gbrain_cs_');
    const secretHash = hashToken(clientSecret);
    const now = Math.floor(Date.now() / 1000);

    try {
      await this.sql`
        INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                    grant_types, scope, token_endpoint_auth_method,
                                    client_id_issued_at, access_tier)
        VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                ${pgArray((client.redirect_uris || []).map(String))},
                ${pgArray(grantTypes)},
                ${client.scope || ''}, ${client.token_endpoint_auth_method || 'client_secret_post'},
                ${now}, ${'None'})
      `;
    } catch (e) {
      if (isUndefinedColumnError(e, 'access_tier')) {
        throw new Error('Database is missing oauth_clients.access_tier; run `gbrain apply-migrations --yes` before enabling dynamic client registration.');
      }
      throw e;
    }

    return {
      ...client,
      grant_types: grantTypes,
      client_id: clientId,
      client_secret: clientSecret,
      client_id_issued_at: now,
    };
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
  private resourceServerUrl?: URL;
  /** v46 OIDC config; when undefined, /authorize uses the legacy rubber-stamp flow. */
  private oidc?: NonNullable<GBrainOAuthProviderOptions['oidc']>;
  private readonly pendingOidc = new Map<string, PendingOidcAuthorization>();

  constructor(options: GBrainOAuthProviderOptions) {
    this.sql = options.sql;
    this._clientsStore = new GBrainClientsStore(this.sql);
    this.dcrDisabled = options.dcrDisabled === true;
    this.tokenTtl = options.tokenTtl || 3600;
    this.refreshTtl = options.refreshTtl || 30 * 24 * 3600;
    this.oidc = options.oidc;
    this.resourceServerUrl = options.resourceServerUrl;
  }

  /** True when v46 OIDC federation is wired. serve-http.ts uses this to gate the /oauth/oidc/callback route. */
  get oidcEnabled(): boolean { return this.oidc !== undefined; }

  /** Public OIDC config for serve-http.ts callback handler. Throws if not configured. */
  getOidcConfig(): NonNullable<GBrainOAuthProviderOptions['oidc']> {
    if (!this.oidc) throw new Error('OIDC not configured');
    return this.oidc;
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

  private validateAuthorizationScopes(client: OAuthClientInformationFull, requestedScopes: readonly string[] | undefined): string[] {
    const scopes = [...(requestedScopes || [])];
    assertAllowedScopes(scopes);
    const allowedScopes = parseScopeString(client.scope);
    for (const scope of scopes) {
      if (!hasScope(allowedScopes, scope)) {
        throw new OAuthInvalidScopeError(`Requested scope "${scope}" exceeds this client's registered scope`);
      }
    }
    return scopes;
  }

  private assertClientGrantType(client: OAuthClientInformationFull, grantType: 'client_credentials' | 'authorization_code'): void {
    const grants = (client.grant_types as string[]) || [];
    if (!grants.includes(grantType)) {
      throw new InvalidGrantError(`${grantType} grant not authorized for this client`);
    }
  }

  private assertResourceAllowed(resource: URL | undefined, context: string): URL | undefined {
    if (!this.resourceServerUrl) return resource;
    if (!resource) {
      throw new InvalidTargetError(`${context} resource is required`);
    }
    if (!checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidTargetError(`${context} resource is not served by this MCP server`);
    }
    return resource;
  }

  async authenticateClientSecret(
    clientId: string,
    clientSecret: string,
    grantType: 'client_credentials' | 'authorization_code',
  ): Promise<OAuthClientInformationFull> {
    const client = await this._clientsStore.getClient(clientId);
    if (!client) throw new Error('Client not found');
    this.assertClientGrantType(client, grantType);
    if (client.client_secret !== hashToken(clientSecret)) throw new Error('Invalid client secret');
    return client;
  }

  // -------------------------------------------------------------------------
  // Authorization Code Flow
  // -------------------------------------------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.assertClientGrantType(client, 'authorization_code');
    if (params.resource) {
      this.assertResourceAllowed(params.resource, 'authorization_code');
    }
    const scopes = this.validateAuthorizationScopes(client, params.scopes);
    if (this.oidc) {
      this.prunePendingOidc();
      const state = generateToken('gbrain_oidc_');
      const nonce = generateToken('gbrain_nonce_');
      this.pendingOidc.set(state, {
        clientId: client.client_id,
        scopes,
        codeChallenge: params.codeChallenge,
        redirectUri: params.redirectUri,
        clientState: params.state,
        resource: params.resource?.toString(),
        nonce,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      });

      const discovery = await this.oidc.verifier.getDiscovery();
      const oidcRedirect = new URL(discovery.authorization_endpoint);
      oidcRedirect.searchParams.set('client_id', this.oidc.clientId);
      oidcRedirect.searchParams.set('redirect_uri', this.oidcCallbackUrl());
      oidcRedirect.searchParams.set('response_type', 'code');
      oidcRedirect.searchParams.set('scope', 'openid email');
      oidcRedirect.searchParams.set('state', state);
      oidcRedirect.searchParams.set('nonce', nonce);
      res.redirect(oidcRedirect.toString());
      return;
    }

    const code = await this.createInternalAuthorizationCode(client.client_id, {
      scopes,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      state: params.state,
      resource: params.resource,
    });
    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) redirectUrl.searchParams.set('state', params.state);
    res.redirect(redirectUrl.toString());
  }

  private oidcCallbackUrl(): string {
    const oidc = this.getOidcConfig();
    return `${oidc.publicUrl.replace(/\/+$/, '')}/oauth/oidc/callback`;
  }

  private prunePendingOidc(now = Math.floor(Date.now() / 1000)): void {
    for (const [state, pending] of this.pendingOidc) {
      if (pending.expiresAt <= now) this.pendingOidc.delete(state);
    }
  }

  private async createInternalAuthorizationCode(
    clientId: string,
    params: {
      scopes: string[];
      codeChallenge: string;
      redirectUri: string;
      state?: string;
      resource?: URL | string;
      federated?: { subjectEmail: string; subjectIss: string; userTier: AccessTier };
    },
  ): Promise<string> {
    const code = generateToken('gbrain_code_');
    const codeHash = hashToken(code);
    const expiresAt = Math.floor(Date.now() / 1000) + 600;
    const resource = params.resource instanceof URL ? params.resource.toString() : params.resource;

    try {
      await this.sql`
        INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
                                  code_challenge_method, redirect_uri, state, resource,
                                  subject_email, subject_iss, user_tier, expires_at)
        VALUES (${codeHash}, ${clientId},
                ${pgArray(params.scopes || [])},
                ${params.codeChallenge}, ${'S256'},
                ${params.redirectUri}, ${params.state || null},
                ${resource || null},
                ${params.federated?.subjectEmail ?? null},
                ${params.federated?.subjectIss ?? null},
                ${params.federated?.userTier ?? null},
                ${expiresAt})
      `;
    } catch (e) {
      if (!isUndefinedColumnError(e, 'subject_email')
          && !isUndefinedColumnError(e, 'subject_iss')
          && !isUndefinedColumnError(e, 'user_tier')) throw e;
      if (params.federated) {
        throw new Error('Database is missing v46 OIDC identity columns; run `gbrain apply-migrations --yes` before enabling OIDC federation.');
      }
      await this.sql`
        INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
                                  code_challenge_method, redirect_uri, state, resource, expires_at)
        VALUES (${codeHash}, ${clientId},
                ${pgArray(params.scopes || [])},
                ${params.codeChallenge}, ${'S256'},
                ${params.redirectUri}, ${params.state || null},
                ${resource || null}, ${expiresAt})
      `;
    }

    return code;
  }

  /**
   * Complete the OIDC code-grant on behalf of /oauth/oidc/callback in
   * serve-http.ts. Given the IdP code + the state we issued at /authorize,
   * exchanges the IdP code, verifies the id_token, looks up the email in
   * oauth_user_grants, and (if granted) updates the gbrain oauth_codes row
   * with subject_email/subject_iss/user_tier so the subsequent /token
   * exchange mints a tier-narrowed access_token. Returns the original
   * redirect_uri + (gbrain code OR error) so the caller can issue the
   * final user-agent redirect.
   */
  async completeOidcCallback(
    idpCode: string,
    state: string,
    idpError?: string,
  ): Promise<{ redirectUri: string; clientState: string; gbrainCode?: string; error?: { code: string; description: string } }> {
    if (!this.oidc) throw new Error('OIDC not configured');

    this.prunePendingOidc();
    const pending = this.pendingOidc.get(state);
    if (!pending) throw new Error('OIDC state not found or expired');
    this.pendingOidc.delete(state);
    const redirectUri = pending.redirectUri;
    const clientState = pending.clientState ?? '';

    // IdP error short-circuit. The user denied consent at Google's prompt
    // (or the issuer rejected the auth request). Bubble the error back to
    // the original client redirect_uri so it can show a meaningful message
    // rather than swallow the failure server-side.
    if (idpError) {
      return {
        redirectUri,
        clientState,
        error: { code: idpError, description: 'OIDC issuer reported an error' },
      };
    }

    let identity;
    try {
      const tokens = await this.oidc.verifier.exchangeCodeForTokens(
        idpCode,
        this.oidcCallbackUrl(),
      );
      identity = await this.oidc.verifier.verifyIdToken(tokens.id_token, { nonce: pending.nonce });
    } catch (e) {
      return {
        redirectUri,
        clientState,
        error: {
          code: 'access_denied',
          description: 'OIDC verification failed',
        },
      };
    }

    // Email -> tier lookup. Only active grants (revoked_at IS NULL).
    const grantRows = await this.sql`
      SELECT access_tier FROM oauth_user_grants
      WHERE email = ${identity.email} AND revoked_at IS NULL
    `;
    if (grantRows.length === 0) {
      return {
        redirectUri,
        clientState,
        error: {
          code: 'access_denied',
          description: 'Access denied',
        },
      };
    }
    const userTier = resolveStoredAccessTier(grantRows[0].access_tier);
    if (userTier === 'None') {
      return {
        redirectUri,
        clientState,
        error: {
          code: 'access_denied',
          description: 'Access denied',
        },
      };
    }

    const gbrainCode = await this.createInternalAuthorizationCode(pending.clientId, {
      scopes: pending.scopes,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      state: pending.clientState,
      resource: pending.resource,
      federated: {
        subjectEmail: identity.email,
        subjectIss: identity.issuer,
        userTier,
      },
    });

    return { redirectUri, clientState, gbrainCode };
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
    this.assertClientGrantType(client, 'authorization_code');
    // OAuth 2.1 / RFC 9700 §4.1.3: redirect_uri MUST be sent at /token if it
    // was sent at /authorize. gbrain's /authorize requires it (oauth_codes
    // schema is NOT NULL), so /token MUST receive it too. Earlier versions
    // had a back-compat branch that omitted the binding when redirect_uri
    // was absent at /token; that defeated the F7c redirect_uri binding for
    // any client willing to skip the parameter. Reject up-front.
    if (redirectUri === undefined) {
      throw new Error('redirect_uri is required for authorization_code exchange');
    }
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
    // v46: also project subject_email/subject_iss/user_tier from the code
    // row so the federated end-user identity captured at /authorize survives
    // into the issued access_token. The columns are nullable - rows minted
    // by non-OIDC flows leave them as null and tokens get no end-user attribution.
    // F7c: bind redirect_uri into the DELETE atomically. The single-branch
    // form is now safe because the rejection above ensures redirect_uri is
    // always defined here.
    let rows;
    try {
      rows = await this.sql`
        DELETE FROM oauth_codes
        WHERE code_hash = ${codeHash}
          AND client_id = ${client.client_id}
          AND redirect_uri = ${redirectUri}
          AND expires_at > ${now}
        RETURNING client_id, scopes, resource, subject_email, subject_iss, user_tier
      `;
    } catch (e) {
      // Pre-v46 schema fallback: same DELETE without v46 columns. The
      // resulting tokens won't carry subject_email; that's correct on a
      // database that doesn't have the column yet.
      if (!isUndefinedColumnError(e, 'subject_email')
          && !isUndefinedColumnError(e, 'subject_iss')
          && !isUndefinedColumnError(e, 'user_tier')) throw e;
      rows = await this.sql`
        DELETE FROM oauth_codes
        WHERE code_hash = ${codeHash}
          AND client_id = ${client.client_id}
          AND redirect_uri = ${redirectUri}
          AND expires_at > ${now}
        RETURNING client_id, scopes, resource
      `;
    }
    if (rows.length === 0) throw new Error('Authorization code not found or expired');

    const codeRow = rows[0];

    // Issue tokens. v46 federated identity (if present) flows through to
    // issueTokens so the new oauth_tokens row carries the same email + tier
    // captured at /authorize. issueTokens handles the column-absent case.
    const scopes = (codeRow.scopes as string[]) || [];
    const subjectEmail = (codeRow.subject_email as string | null | undefined) ?? undefined;
    const subjectIss = (codeRow.subject_iss as string | null | undefined) ?? undefined;
    const userTierRaw = (codeRow.user_tier as string | null | undefined) ?? undefined;
    let userTier = userTierRaw && isAccessTier(userTierRaw) ? userTierRaw : undefined;
    if (subjectEmail) {
      if (!subjectIss || !userTier) {
        throw new InvalidGrantError('OIDC authorization code is missing federated identity fields');
      }
      const grants = await this.sql`
        SELECT access_tier FROM oauth_user_grants
        WHERE email = ${subjectEmail} AND revoked_at IS NULL
      `;
      if (grants.length === 0) {
        throw new InvalidGrantError('OIDC grant is no longer active');
      }
      userTier = resolveStoredAccessTier(grants[0].access_tier);
      if (userTier === 'None') {
        throw new InvalidGrantError('OIDC grant does not allow access');
      }
    }
    const storedResource = this.assertResourceAllowed(
      assertResourceBinding(codeRow.resource, resource, 'authorization_code'),
      'authorization_code',
    );
    return this.issueTokens(client.client_id, scopes, storedResource, true, undefined, {
      subjectEmail, subjectIss, userTier,
    });
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
    // v46: pull subject_email/subject_iss/user_tier so a refresh-rotated
    // access token preserves the original code-grant's federated identity
    // snapshot. Pre-v46 schema falls back to the v45 RETURNING shape.
    let rows;
    try {
      rows = await this.sql`
        DELETE FROM oauth_tokens
        WHERE token_hash = ${tokenHash}
          AND token_type = 'refresh'
          AND client_id = ${client.client_id}
        RETURNING client_id, scopes, expires_at, resource, subject_email, subject_iss, user_tier
      `;
    } catch (e) {
      if (!isUndefinedColumnError(e, 'subject_email')
          && !isUndefinedColumnError(e, 'subject_iss')
          && !isUndefinedColumnError(e, 'user_tier')) throw e;
      rows = await this.sql`
        DELETE FROM oauth_tokens
        WHERE token_hash = ${tokenHash}
          AND token_type = 'refresh'
          AND client_id = ${client.client_id}
        RETURNING client_id, scopes, expires_at, resource
      `;
    }
    if (rows.length === 0) throw new Error('Refresh token not found');

    const row = rows[0];
    // NULL expires_at is treated as expired (fail-closed). Schema permits NULL
    // even though issueTokens always sets it, so a corrupt or hand-modified row
    // can't ride past validation.
    const expiresAt = coerceTimestamp(row.expires_at);
    if (expiresAt === undefined || expiresAt < now) throw new Error('Refresh token expired');

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
    // v46: forward the federated identity snapshot if present. issueTokens
    // handles the pre-v46 schema case where the columns are absent.
    const subjectEmail = (row.subject_email as string | null | undefined) ?? undefined;
    const subjectIss = (row.subject_iss as string | null | undefined) ?? undefined;
    const userTierRaw = (row.user_tier as string | null | undefined) ?? undefined;
    let userTier = userTierRaw && isAccessTier(userTierRaw) ? userTierRaw : undefined;
    if (subjectEmail) {
      const grants = await this.sql`
        SELECT access_tier FROM oauth_user_grants
        WHERE email = ${subjectEmail} AND revoked_at IS NULL
      `;
      if (grants.length === 0) {
        throw new Error(`OIDC grant for ${subjectEmail} is no longer active`);
      }
      userTier = resolveStoredAccessTier(grants[0].access_tier);
      if (userTier === 'None') {
        throw new Error(`OIDC grant for ${subjectEmail} does not allow access`);
      }
    }
    const storedResource = this.assertResourceAllowed(
      assertResourceBinding(row.resource, resource, 'refresh_token'),
      'refresh_token',
    );
    return this.issueTokens(client.client_id, tokenScopes, storedResource, true, undefined, {
      subjectEmail, subjectIss, userTier,
    });
  }

  // -------------------------------------------------------------------------
  // Token Verification
  // -------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenHash = hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    // Try OAuth tokens first. JOIN oauth_clients in the same query so
    // verifyAccessToken returns client_name + access_tier in AuthInfo —
    // eliminates the separate per-request lookup at serve-http.ts
    // that was the N+1 hot path (see PR #586 review D14=B).
    //
    // The INNER JOIN is load-bearing for the access_tier read: an
    // oauth_tokens row without a matching oauth_clients row (orphan
    // from a partial cascade) MUST NOT be silently treated as Full
    // tier. The FK normally guarantees the row exists; the explicit
    // INNER JOIN fail-closes if it doesn't, surfacing as 'Invalid
    // token' rather than admitting the request.
    //
    // c.deleted_at IS NULL gates the soft-delete window: the dashboard
    // revoke path soft-deletes the client and purges its tokens in two
    // non-atomic statements, so a token can race the purge. This
    // predicate makes the JOIN itself reject any soft-deleted client's
    // surviving token, regardless of whether the purge ever ran.
    let oauthRows;
    try {
      // v46: also pull subject_email/subject_iss/user_tier so federated
      // OIDC tokens carry the verified end-user identity into AuthInfo.
      // The columns are nullable for client_credentials tokens that have
      // no end-user behind them; verifyAccessToken treats null user_tier
      // as "client tier wins" (no narrowing).
      oauthRows = await this.sql`
        SELECT t.client_id, t.scopes, t.expires_at, t.resource,
               t.subject_email, t.subject_iss, t.user_tier,
               c.client_name, c.access_tier
        FROM oauth_tokens t
        INNER JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
          AND c.deleted_at IS NULL
      `;
    } catch (e) {
      if (isUndefinedColumnError(e, 'subject_email') || isUndefinedColumnError(e, 'subject_iss') || isUndefinedColumnError(e, 'user_tier')) {
        // Pre-v46 schema: no end-user identity columns. Fall back to the
        // v45 SELECT shape (no subject fields). The next catch ladder
        // handles pre-v45 / pre-deleted_at cases the same way as before.
        try {
          oauthRows = await this.sql`
            SELECT t.client_id, t.scopes, t.expires_at, t.resource,
                   ${null} as subject_email, ${null} as subject_iss, ${null} as user_tier,
                   c.client_name, c.access_tier
            FROM oauth_tokens t
            INNER JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
              AND c.deleted_at IS NULL
          `;
        } catch (fallbackErr) {
          if (isUndefinedColumnError(fallbackErr, 'access_tier')) {
            try {
              oauthRows = await this.sql`
                SELECT t.client_id, t.scopes, t.expires_at, t.resource,
                       ${null} as subject_email, ${null} as subject_iss, ${null} as user_tier,
                       c.client_name, ${ACCESS_TIER_DEFAULT} as access_tier
                FROM oauth_tokens t
                INNER JOIN oauth_clients c ON c.client_id = t.client_id
                WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
                  AND c.deleted_at IS NULL
              `;
            } catch (fallbackErr2) {
              if (!isUndefinedColumnError(fallbackErr2, 'deleted_at')) throw fallbackErr2;
              oauthRows = await this.sql`
                SELECT t.client_id, t.scopes, t.expires_at, t.resource,
                       ${null} as subject_email, ${null} as subject_iss, ${null} as user_tier,
                       c.client_name, ${ACCESS_TIER_DEFAULT} as access_tier
                FROM oauth_tokens t
                INNER JOIN oauth_clients c ON c.client_id = t.client_id
                WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
              `;
            }
          } else if (isUndefinedColumnError(fallbackErr, 'deleted_at')) {
            try {
              oauthRows = await this.sql`
                SELECT t.client_id, t.scopes, t.expires_at, t.resource,
                       ${null} as subject_email, ${null} as subject_iss, ${null} as user_tier,
                       c.client_name, c.access_tier
                FROM oauth_tokens t
                INNER JOIN oauth_clients c ON c.client_id = t.client_id
                WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
              `;
            } catch (fallbackErr2) {
              if (!isUndefinedColumnError(fallbackErr2, 'access_tier')) throw fallbackErr2;
              oauthRows = await this.sql`
                SELECT t.client_id, t.scopes, t.expires_at, t.resource,
                       ${null} as subject_email, ${null} as subject_iss, ${null} as user_tier,
                       c.client_name, ${ACCESS_TIER_DEFAULT} as access_tier
                FROM oauth_tokens t
                INNER JOIN oauth_clients c ON c.client_id = t.client_id
                WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
              `;
            }
          } else {
            throw fallbackErr;
          }
        }
      } else if (isUndefinedColumnError(e, 'access_tier')) {
        // Pre-v45 database during an upgrade window: preserve legacy OAuth
        // behavior by treating matching clients as Full tier until migrations
        // add the column. Keep the INNER JOIN + deleted_at gate when present.
        try {
          oauthRows = await this.sql`
            SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, ${ACCESS_TIER_DEFAULT} as access_tier
            FROM oauth_tokens t
            INNER JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
              AND c.deleted_at IS NULL
          `;
        } catch (fallbackErr) {
          if (!isUndefinedColumnError(fallbackErr, 'deleted_at')) throw fallbackErr;
          oauthRows = await this.sql`
            SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, ${ACCESS_TIER_DEFAULT} as access_tier
            FROM oauth_tokens t
            INNER JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
          `;
        }
      } else if (isUndefinedColumnError(e, 'deleted_at')) {
        // Pre-soft-delete schema: preserve legacy verification. Revocation
        // races are fixed once migrations add deleted_at.
        try {
          oauthRows = await this.sql`
            SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.access_tier
            FROM oauth_tokens t
            INNER JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
          `;
        } catch (fallbackErr) {
          if (!isUndefinedColumnError(fallbackErr, 'access_tier')) throw fallbackErr;
          oauthRows = await this.sql`
            SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, ${ACCESS_TIER_DEFAULT} as access_tier
            FROM oauth_tokens t
            INNER JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
          `;
        }
      } else {
        throw e;
      }
    }

    if (oauthRows.length > 0) {
      const row = oauthRows[0];
      // NULL expires_at is treated as expired (fail-closed). Schema permits NULL,
      // and the SDK's bearerAuth requires `typeof expiresAt === 'number'` — we
      // throw here rather than return an undefined-bearing AuthInfo.
      const expiresAt = coerceTimestamp(row.expires_at);
      if (expiresAt === undefined || expiresAt < now) {
        throw new Error('Token expired');
      }
      // v46 tier resolution: if the token was minted via OIDC code-grant
      // and we captured a snapshot of the end-user's tier at exchange
      // time, the effective tier is the more-restrictive of (client
      // tier, user tier). user_tier is null on client_credentials
      // tokens; in that case the client tier wins. Revoking the user
      // grant after mint takes effect on next mint, not on already-
      // issued tokens (snapshot semantics, intentional - matches how
      // `set-tier` behaves on the client side).
      const clientTier = resolveStoredAccessTier(row.access_tier);
      const userTierRaw = row.user_tier as string | null | undefined;
      const userTier = userTierRaw && isAccessTier(userTierRaw) ? userTierRaw : undefined;
      const resolvedTier = userTier ? tierMin(clientTier, userTier) : clientTier;
      const subjectEmail = (row.subject_email as string | null) ?? undefined;
      const subjectIss = (row.subject_iss as string | null) ?? undefined;
      return {
        token,
        clientId: row.client_id as string,
        clientName: (row.client_name as string | null) ?? undefined,
        scopes: (row.scopes as string[]) || [],
        expiresAt,
        resource: row.resource ? new URL(row.resource as string) : undefined,
        tier: resolvedTier,
        ...(subjectEmail ? { subjectEmail } : {}),
        ...(subjectIss ? { subjectIss } : {}),
      } as AuthInfo;
    }

    // Fallback: legacy access_tokens table (backward compat)
    const legacyRows = await this.sql`
      SELECT name FROM access_tokens
      WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
    `;

    if (legacyRows.length > 0) {
      // Legacy tokens get full admin access (grandfather in).
      // For legacy tokens, name = clientId = clientName (single identifier).
      // Update last_used_at
      await this.sql`
        UPDATE access_tokens SET last_used_at = now() WHERE token_hash = ${tokenHash}
      `;
      const name = legacyRows[0].name as string;
      return {
        token,
        clientId: name,
        clientName: name,
        scopes: ['read', 'write', 'admin'],
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600, // Legacy tokens never expire — set 1yr future
        // Legacy tokens grandfathered with Full tier (matches the
        // pre-v45 "all admin" grant). Operators that want tier
        // enforcement should rotate to OAuth clients via
        // `gbrain auth register-client --tier <tier>`.
        tier: 'Full' as AccessTier,
      } as AuthInfo;
    }

    throw new Error('Invalid token');
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

  async exchangeClientCredentials(
    clientId: string,
    clientSecret: string,
    requestedScope?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const client = await this.authenticateClientSecret(clientId, clientSecret, 'client_credentials');

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

    resource = this.assertResourceAllowed(resource, 'client_credentials');

    // Determine scopes. v0.28 swaps exact-string-match for hasScope so a
    // client whose grant is `admin` can mint tokens that include implied
    // scopes like `sources_admin` (admin implies all). Tokens are still
    // capped by what the client was registered for — this only changes how
    // the cap is computed.
    const allowedScopes = parseScopeString(client.scope);
    const requestedScopes = requestedScope ? parseScopeString(requestedScope) : allowedScopes;
    const grantedScopes = requestedScopes.filter(s => hasScope(allowedScopes, s));

    // Per-client TTL override (stored in oauth_clients.token_ttl)
    // Column may not exist on PGLite/older schemas — graceful fallback
    let clientTtl: number | undefined;
    try {
      const ttlRows = await this.sql`SELECT token_ttl FROM oauth_clients WHERE client_id = ${clientId}`;
      if (ttlRows.length > 0 && ttlRows[0].token_ttl) clientTtl = Number(ttlRows[0].token_ttl);
    } catch (e) {
      // F5 hardening: same posture as the deleted_at probe above. Only the
      // "column doesn't exist" path is a non-fatal fall-through.
      if (!isUndefinedColumnError(e, 'token_ttl')) throw e;
    }

    // Client credentials: access token only, NO refresh token (RFC 6749 4.4.3)
    return this.issueTokens(clientId, grantedScopes, resource, false, clientTtl);
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
    accessTier: AccessTier = ACCESS_TIER_DEFAULT,
  ): Promise<{ clientId: string; clientSecret: string }> {
    // v0.28: ALLOWED_SCOPES allowlist. Reject `--scopes "read flying-unicorn"`
    // at registration so meaningless scope strings can't pile up in the DB.
    // Pre-allowlist clients keep working (allowlist is registration-time;
    // existing rows aren't re-validated).
    assertAllowedScopes(parseScopeString(scopes));

    if (!isAccessTier(accessTier)) {
      throw new Error(`registerClientManual: invalid accessTier "${accessTier}"`);
    }
    grantTypes = validateGrantTypes(grantTypes, 'registerClientManual');
    for (const uri of redirectUris) {
      validateRedirectUri(uri);
    }
    if (grantTypes.includes('authorization_code') && redirectUris.length === 0) {
      throw new Error('authorization_code clients require at least one redirect_uri');
    }

    const clientId = generateToken('gbrain_cl_');
    const clientSecret = generateToken('gbrain_cs_');
    const secretHash = hashToken(clientSecret);
    const now = Math.floor(Date.now() / 1000);

    try {
      await this.sql`
        INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                    grant_types, scope, client_id_issued_at, access_tier)
        VALUES (${clientId}, ${secretHash}, ${name},
                ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${now}, ${accessTier})
      `;
    } catch (e) {
      if (!isUndefinedColumnError(e, 'access_tier')) throw e;
      if (accessTier !== ACCESS_TIER_DEFAULT) {
        throw new Error('Database is missing oauth_clients.access_tier; run `gbrain apply-migrations --yes` before registering a restricted-tier client.');
      }
      // Back-compat for operators who register a legacy Full client before
      // running v45. The column default cannot exist yet, so omit it.
      await this.sql`
        INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                    grant_types, scope, client_id_issued_at)
        VALUES (${clientId}, ${secretHash}, ${name},
                ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${now})
      `;
    }

    return { clientId, clientSecret };
  }

  /**
   * Update an existing OAuth client's access_tier. Used by
   * `gbrain auth set-tier <client_id> <tier>`. Returns true when the
   * row was updated, false when no client matched the supplied id.
   * Throws on an invalid tier so a typo at the CLI fails loudly.
   */
  async setClientAccessTier(clientId: string, accessTier: AccessTier): Promise<boolean> {
    if (!isAccessTier(accessTier)) {
      throw new Error(`setClientAccessTier: invalid tier "${accessTier}"`);
    }
    // deleted_at IS NULL: refuse to mutate a tombstoned client's tier.
    // Operators get a "no client matched" return on a soft-deleted id
    // rather than a misleading success that has no effect.
    let rows;
    try {
      rows = await this.sql`
        UPDATE oauth_clients SET access_tier = ${accessTier}
        WHERE client_id = ${clientId} AND deleted_at IS NULL
        RETURNING client_id
      `;
    } catch (e) {
      if (isUndefinedColumnError(e, 'access_tier')) {
        throw new Error('Database is missing oauth_clients.access_tier; run `gbrain apply-migrations --yes` before setting client tiers.');
      }
      throw e;
    }
    return rows.length > 0;
  }

  // -------------------------------------------------------------------------
  // Internal: Issue access + optional refresh tokens
  // -------------------------------------------------------------------------

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: URL | undefined,
    includeRefresh: boolean,
    ttlOverride?: number,
    federated?: { subjectEmail?: string; subjectIss?: string; userTier?: AccessTier },
  ): Promise<OAuthTokens> {
    const accessToken = generateToken('gbrain_at_');
    const accessHash = hashToken(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const effectiveTtl = ttlOverride || this.tokenTtl;
    const accessExpiry = now + effectiveTtl;

    // v46 federated identity insert. The columns are nullable; for
    // client_credentials and other non-OIDC paths the federated arg is
    // undefined and the projected nulls preserve pre-v46 behavior.
    // Pre-v46 schema fallback drops the federated columns entirely.
    const subjectEmail = federated?.subjectEmail ?? null;
    const subjectIss = federated?.subjectIss ?? null;
    const userTier = federated?.userTier ?? null;
    try {
      await this.sql`
        INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource,
                                  subject_email, subject_iss, user_tier)
        VALUES (${accessHash}, ${'access'}, ${clientId},
                ${pgArray(scopes)}, ${accessExpiry}, ${resource?.toString() || null},
                ${subjectEmail}, ${subjectIss}, ${userTier})
      `;
    } catch (e) {
      if (!isUndefinedColumnError(e, 'subject_email')
          && !isUndefinedColumnError(e, 'subject_iss')
          && !isUndefinedColumnError(e, 'user_tier')) throw e;
      if (federated?.subjectEmail || federated?.subjectIss || federated?.userTier) {
        throw new Error('Database is missing v46 OIDC identity columns; run `gbrain apply-migrations --yes` before enabling OIDC federation.');
      }
      await this.sql`
        INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
        VALUES (${accessHash}, ${'access'}, ${clientId},
                ${pgArray(scopes)}, ${accessExpiry}, ${resource?.toString() || null})
      `;
    }

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

      // Refresh tokens carry the same federated identity so a refresh
      // mint produces a fresh access_token bound to the same email + iss
      // + user_tier snapshot. Revoking the user grant takes effect on
      // the NEXT mint after refresh; in-flight refresh-rotated tokens
      // retain the snapshot from the original code-grant exchange.
      try {
        await this.sql`
          INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource,
                                    subject_email, subject_iss, user_tier)
          VALUES (${refreshHash}, ${'refresh'}, ${clientId},
                  ${pgArray(scopes)}, ${refreshExpiry}, ${resource?.toString() || null},
                  ${subjectEmail}, ${subjectIss}, ${userTier})
        `;
      } catch (e) {
        if (!isUndefinedColumnError(e, 'subject_email')
            && !isUndefinedColumnError(e, 'subject_iss')
            && !isUndefinedColumnError(e, 'user_tier')) throw e;
        if (federated?.subjectEmail || federated?.subjectIss || federated?.userTier) {
          throw new Error('Database is missing v46 OIDC identity columns; run `gbrain apply-migrations --yes` before enabling OIDC federation.');
        }
        await this.sql`
          INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
          VALUES (${refreshHash}, ${'refresh'}, ${clientId},
                  ${pgArray(scopes)}, ${refreshExpiry}, ${resource?.toString() || null})
        `;
      }

      result.refresh_token = refreshToken;
    }

    return result;
  }
}
