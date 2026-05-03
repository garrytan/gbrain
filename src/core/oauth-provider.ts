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
import { hashToken, generateToken } from './utils.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw SQL query function — works with both PGLite and postgres tagged templates */
type SqlQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>;

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
}

// ---------------------------------------------------------------------------
// Clients Store
// ---------------------------------------------------------------------------

class GBrainClientsStore implements OAuthRegisteredClientsStore {
  constructor(private sql: SqlQuery) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const rows = await this.sql`
      SELECT client_id, client_secret_hash, client_name, redirect_uris,
             grant_types, scope, token_endpoint_auth_method,
             client_id_issued_at, client_secret_expires_at
      FROM oauth_clients WHERE client_id = ${clientId}
    `;
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
    // Enforce HTTPS for all redirect_uris on the DCR path (RFC 6749 §3.1.2.1).
    // Without this, an attacker could register a non-loopback http:// URI and
    // exfiltrate auth codes over plaintext. CLI registrations bypass this gate
    // (operators are trusted; they can register http:// for testing).
    for (const uri of client.redirect_uris || []) {
      validateRedirectUri(String(uri));
    }

    const clientId = generateToken('gbrain_cl_');
    const clientSecret = generateToken('gbrain_cs_');
    const secretHash = hashToken(clientSecret);
    const now = Math.floor(Date.now() / 1000);

    await this.sql`
      INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                  grant_types, scope, token_endpoint_auth_method,
                                  client_id_issued_at)
      VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
              ${pgArray((client.redirect_uris || []).map(String))},
              ${pgArray(client.grant_types || ['client_credentials'])},
              ${client.scope || ''}, ${client.token_endpoint_auth_method || 'client_secret_post'},
              ${now})
    `;

    return {
      ...client,
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
  private tokenTtl: number;
  private refreshTtl: number;

  constructor(options: GBrainOAuthProviderOptions) {
    this.sql = options.sql;
    this._clientsStore = new GBrainClientsStore(this.sql);
    this.tokenTtl = options.tokenTtl || 3600;
    this.refreshTtl = options.refreshTtl || 30 * 24 * 3600;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
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

    await this.sql`
      INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
                                code_challenge_method, redirect_uri, state, resource, expires_at)
      VALUES (${codeHash}, ${client.client_id},
              ${pgArray(params.scopes || [])},
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
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const codeHash = hashToken(authorizationCode);
    const rows = await this.sql`
      SELECT code_challenge FROM oauth_codes
      WHERE code_hash = ${codeHash} AND expires_at > ${Math.floor(Date.now() / 1000)}
    `;
    if (rows.length === 0) throw new Error('Authorization code not found or expired');
    return rows[0].code_challenge as string;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeHash = hashToken(authorizationCode);
    const now = Math.floor(Date.now() / 1000);

    // Atomic single-use: DELETE...RETURNING in one statement closes the
    // TOCTOU window. RFC 6749 §10.5 requires auth codes be single-use; the
    // earlier SELECT-then-DELETE pattern let two concurrent token requests
    // both pass the SELECT before either ran the DELETE, issuing two valid
    // token pairs from one code. With RETURNING, the second request gets
    // zero rows back and fails cleanly. See CSO finding #2.
    const rows = await this.sql`
      DELETE FROM oauth_codes
      WHERE code_hash = ${codeHash} AND expires_at > ${now}
      RETURNING client_id, scopes, resource
    `;
    if (rows.length === 0) throw new Error('Authorization code not found or expired');

    const codeRow = rows[0];
    if (codeRow.client_id !== client.client_id) throw new Error('Client mismatch');

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

    // Atomic rotation: DELETE...RETURNING closes the TOCTOU window. RFC 6749
    // §10.4 detection of stolen refresh tokens depends on second-use failure;
    // the earlier SELECT-then-DELETE pattern let attacker + victim both
    // succeed, defeating that signal. See CSO finding #3.
    const rows = await this.sql`
      DELETE FROM oauth_tokens
      WHERE token_hash = ${tokenHash} AND token_type = 'refresh'
      RETURNING client_id, scopes, expires_at
    `;
    if (rows.length === 0) throw new Error('Refresh token not found');

    const row = rows[0];
    if (row.client_id !== client.client_id) throw new Error('Client mismatch');
    // NULL expires_at is treated as expired (fail-closed). Schema permits NULL
    // even though issueTokens always sets it, so a corrupt or hand-modified row
    // can't ride past validation.
    const expiresAt = coerceTimestamp(row.expires_at);
    if (expiresAt === undefined || expiresAt < now) throw new Error('Refresh token expired');

    const tokenScopes = scopes || (row.scopes as string[]) || [];
    return this.issueTokens(client.client_id, tokenScopes, resource, true);
  }

  // -------------------------------------------------------------------------
  // Token Verification
  // -------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const tokenHash = hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    // Try OAuth tokens first. JOIN oauth_clients in the same query so
    // verifyAccessToken returns client_name in AuthInfo — eliminates the
    // separate per-request lookup at serve-http.ts that was the N+1 hot
    // path (see PR #586 review D14=B).
    const oauthRows = await this.sql`
      SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name
      FROM oauth_tokens t
      LEFT JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
    `;

    if (oauthRows.length > 0) {
      const row = oauthRows[0];
      // NULL expires_at is treated as expired (fail-closed). Schema permits NULL,
      // and the SDK's bearerAuth requires `typeof expiresAt === 'number'` — we
      // throw here rather than return an undefined-bearing AuthInfo.
      const expiresAt = coerceTimestamp(row.expires_at);
      if (expiresAt === undefined || expiresAt < now) {
        throw new Error('Token expired');
      }
      return {
        token,
        clientId: row.client_id as string,
        clientName: (row.client_name as string | null) ?? undefined,
        scopes: (row.scopes as string[]) || [],
        expiresAt,
        resource: row.resource ? new URL(row.resource as string) : undefined,
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
      } as AuthInfo;
    }

    throw new Error('Invalid token');
  }

  // -------------------------------------------------------------------------
  // Token Revocation
  // -------------------------------------------------------------------------

  async revokeToken(
    _client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashToken(request.token);
    await this.sql`DELETE FROM oauth_tokens WHERE token_hash = ${tokenHash}`;
  }

  // -------------------------------------------------------------------------
  // Client Credentials (called by custom handler, not SDK)
  // -------------------------------------------------------------------------

  async exchangeClientCredentials(
    clientId: string,
    clientSecret: string,
    requestedScope?: string,
  ): Promise<OAuthTokens> {
    const client = await this._clientsStore.getClient(clientId);
    if (!client) throw new Error('Client not found');

    // Check if client has been revoked (soft-deleted)
    try {
      const [revoked] = await this.sql`SELECT deleted_at FROM oauth_clients WHERE client_id = ${clientId} AND deleted_at IS NOT NULL`;
      if (revoked) throw new Error('Client has been revoked');
    } catch (e) {
      // deleted_at column may not exist on PGLite/older schemas — skip check
      if (e instanceof Error && e.message === 'Client has been revoked') throw e;
    }

    // Check grant type first (before verifying secret)
    const grants = (client.grant_types as string[]) || [];
    if (!grants.includes('client_credentials')) {
      throw new Error('Client credentials grant not authorized for this client');
    }

    // Verify secret
    const secretHash = hashToken(clientSecret);
    if (client.client_secret !== secretHash) throw new Error('Invalid client secret');

    // Determine scopes
    const allowedScopes = (client.scope || '').split(' ').filter(Boolean);
    const requestedScopes = requestedScope ? requestedScope.split(' ').filter(Boolean) : allowedScopes;
    const grantedScopes = requestedScopes.filter(s => allowedScopes.includes(s));

    // Per-client TTL override (stored in oauth_clients.token_ttl)
    // Column may not exist on PGLite/older schemas — graceful fallback
    let clientTtl: number | undefined;
    try {
      const ttlRows = await this.sql`SELECT token_ttl FROM oauth_clients WHERE client_id = ${clientId}`;
      if (ttlRows.length > 0 && ttlRows[0].token_ttl) clientTtl = Number(ttlRows[0].token_ttl);
    } catch { /* token_ttl column doesn't exist — use server default */ }

    // Client credentials: access token only, NO refresh token (RFC 6749 4.4.3)
    return this.issueTokens(clientId, grantedScopes, undefined, false, clientTtl);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async sweepExpiredTokens(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.sql`
      DELETE FROM oauth_tokens WHERE expires_at < ${now}
    `;
    const deletedCodes = await this.sql`
      DELETE FROM oauth_codes WHERE expires_at < ${now}
    `;
    return (result as any).count || 0;
  }

  // -------------------------------------------------------------------------
  // CLI Registration Helper
  // -------------------------------------------------------------------------

  async registerClientManual(
    name: string,
    grantTypes: string[],
    scopes: string,
    redirectUris: string[] = [],
  ): Promise<{ clientId: string; clientSecret: string }> {
    const clientId = generateToken('gbrain_cl_');
    const clientSecret = generateToken('gbrain_cs_');
    const secretHash = hashToken(clientSecret);
    const now = Math.floor(Date.now() / 1000);

    await this.sql`
      INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                  grant_types, scope, client_id_issued_at)
      VALUES (${clientId}, ${secretHash}, ${name},
              ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${scopes}, ${now})
    `;

    return { clientId, clientSecret };
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
  ): Promise<OAuthTokens> {
    const accessToken = generateToken('gbrain_at_');
    const accessHash = hashToken(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const effectiveTtl = ttlOverride || this.tokenTtl;
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
