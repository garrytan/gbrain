/**
 * GBrain OAuth 2.1 Provider — implements MCP SDK's OAuthServerProvider.
 *
 * Backed by raw SQL (PGLite or Postgres), not the BrainEngine interface, except the bearer check: given an engine,
 * verifyAccessToken reads the token through engine members (engine-sql/access-credentials.ts BEARER_SQL).
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

import { OAuthGrants, type OAuthTransaction } from './oauth-grants.ts';
import { safeHexEqual } from './timing-safe.ts';
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
import { InvalidTokenError, InvalidClientMetadataError, InvalidClientError, InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { hashToken, generateToken, isUndefinedColumnError } from './utils.ts';
import {
  hasScope,
  assertAllowedScopes,
  filterAllowedScopes,
  parseScopeString,
  InvalidScopeError,
  ALLOWED_SCOPES_LIST,
  dcrScopeViolation,
} from './scope.ts';
import type { AuthInfo as CoreAuthInfo } from './operations.ts';
import { TOKEN_TTL_MAX_SECONDS, authSourcesFromGrant, grantFromClient, grantFromRow, intersectGrantedScopes, privatePagesAuth, type GrantPatch } from './grants/model.ts';
import { assertValidSlugPrefixes, pgArray } from './grants/encoding.ts';
import { rescopeOAuthClient, type RescopeClientOptions, type RescopeClientResult } from './grants/rescope.ts';
import { grantValidationContext, insertClientGrant, type GrantClientMetadata } from './grants/service.ts';
import { manualClientGrant } from './grants/register-grant.ts';
import type { ClientGrant, GrantValidationContext } from './grants/model.ts';
import { resolveTokenGrant, touchTokenLastUsed } from './grants/legacy-token.ts';
import { clientReadShared, sourceReadsFor, tokenReadSources } from './grants/read-shared.ts';
import { NO_SOURCES } from './source-id.ts';

/**
 * A slug-prefix write binding is only meaningful if every entry actually
 * constrains something. `''` (or whitespace) matches every slug under
 * `startsWith`, so one unset variable in a provisioning template would turn
 * a binding into a silent wildcard while still displaying as "fenced".
 * Reject at every write surface: registration, rescope, admin API.
 */
export { assertValidSlugPrefixes } from './grants/encoding.ts';

import type { SqlQuery, SqlValue } from './sql-query.ts';
import type { BrainEngine } from './engine.ts';
import { utcCurrentGrant, type OauthTokenRung } from './engine-sql/access-credentials.ts';
import { storedMinTrust } from './trust/tier.ts';
import { tokenMemberBinding } from './access/token-binding.ts';
import { withAttestRight } from './access/actor-model.ts';
export type { SqlQuery, SqlValue };

export interface AgentClientBindings {
  boundTools?: string[];
  boundSourceId?: string;
  boundBrainId?: string;
  boundSlugPrefixes?: string[];
  boundMaxConcurrent?: number;
  budgetUsdPerDay?: string | null;
  delegatedSlugPrefixes?: string[] | null;
  delegatedNamespace?: 'prefixes' | 'job';
  allowedOperations?: string[] | null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
 * Re-throw non-OAuth registration errors as `InvalidClientMetadataError` so
 * the MCP SDK register handler returns HTTP 400 `invalid_client_metadata`
 * instead of a generic 500 `server_error`. Already-OAuth errors pass through.
 */
function asClientMetadataError(err: unknown): never {
  if (err instanceof InvalidClientMetadataError) throw err;
  // Duck-type OAuthError from the SDK (has .errorCode) without importing the
  // base class — keeps the dependency surface stable across SDK versions.
  if (err && typeof err === 'object' && 'errorCode' in err) throw err;
  const message = err instanceof Error ? err.message : String(err);
  console.warn(`[gbrain dcr] rejected registration: ${message}`);
  throw new InvalidClientMetadataError(message);
}

/**
 * Validate a redirect_uri for the DCR path.
 *
 * Allowed:
 * - `https://` (production web clients)
 * - loopback `http://` (127.0.0.1 / ::1 / localhost) — RFC 8252 §7.3
 * - custom URI schemes (`warp://`, `myapp://`, …) — RFC 8252 §7.1 native apps
 *
 * Rejected:
 * - non-loopback plaintext `http://` (auth-code exfiltration over the network)
 * - unparseable strings
 *
 * Throws `InvalidClientMetadataError` (OAuthError → SDK maps to HTTP 400
 * `invalid_client_metadata`) so DCR validation failures never surface as
 * opaque 500s. CLI registration bypasses this gate (operator-trusted).
 */
export function validateRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new InvalidClientMetadataError(`Invalid redirect_uri: not a parseable URL: ${uri}`);
  }
  const isLoopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]'
    || parsed.hostname === '::1';
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopback) return;
  // Native-app custom schemes (anything other than http/https). Require a
  // non-empty scheme name so bare strings like "://x" can't sneak through,
  // and reject browser-executable pseudo-schemes: a javascript:/data:/
  // vbscript:/blob: "redirect" is script injection, not a native-app callback.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const scheme = parsed.protocol.replace(/:$/, '');
    const pseudoSchemes = new Set(['javascript', 'data', 'vbscript', 'blob']);
    if (pseudoSchemes.has(scheme.toLowerCase())) {
      throw new InvalidClientMetadataError(
        `redirect_uri scheme '${scheme}:' is a browser pseudo-scheme, not a native-app scheme: ${uri}`,
      );
    }
    if (scheme.length > 0) return;
  }
  throw new InvalidClientMetadataError(
    `redirect_uri must use https://, a native-app custom scheme, or http:// loopback: ${uri}`,
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
  /**
   * The brain's engine. When set, the bearer check (verifyAccessToken) reads the token and stamps its last use through
   * engine members, so a store with no raw SQL (the Rust engine) authenticates its tokens; `sql` serves the rest.
   */
  engine?: BrainEngine;
  /** Required for grant issuance/rotation/revocation; registration and verification need only sql. */
  transaction?: OAuthTransaction;
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
  /** #5222: the canonical /mcp resource from the configured public URL; grants canonicalize `resource` against it. */
  resourceUrl?: URL;
  /**
   * Allow the consent-bypassing `client_credentials` grant on the unauthenticated
   * Dynamic Client Registration path. Default false (#1353): a self-registered
   * DCR client defaults to `authorization_code` (owner approval on /authorize),
   * and an explicit `client_credentials` request is rejected. Operators who opt
   * in via `--enable-dcr-insecure` get anonymous READ-ONLY machine clients: the
   * DCR scope ceiling (`dcrScopeViolation` in scope.ts) caps them at `read`.
   * Manual CLI / admin registration is unaffected (operator-trusted).
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
    private engine?: BrainEngine,
  ) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    // An engine reads the whole row through its member; a soft-deleted client is no client, as the SQL filter has it.
    const rows: Record<string, unknown>[] = this.engine
      ? await this.engine.readOauthClient(clientId).then(row => row && row.deleted_at == null ? [{ ...row }] : [])
      : await this.sql`
      SELECT client_id, client_secret_hash, client_name, redirect_uris,
             grant_types, scope, token_endpoint_auth_method,
             client_id_issued_at, client_secret_expires_at
      FROM oauth_clients WHERE client_id = ${clientId}
        AND (to_jsonb(oauth_clients)->>'deleted_at') IS NULL
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
    // DCR is unauthenticated network input. Every validation failure here
    // MUST become InvalidClientMetadataError (HTTP 400) — plain Errors are
    // converted to opaque 500 server_error by the MCP SDK register handler,
    // which is what broke Warp/rmcp clients against gbrain.
    let authMethod: TokenEndpointAuthMethod;
    let registeredScope: string;
    let grantTypes: string[];
    try {
      // redirect_uri: https / loopback http / native custom schemes only.
      // Non-loopback plaintext http is still rejected (auth-code exfil).
      // CLI registrations bypass this gate (operator-trusted).
      for (const uri of client.redirect_uris || []) {
        validateRedirectUri(String(uri));
      }

      // v0.42 (#1353): the DCR path is the unauthenticated network entry point.
      // `client_credentials` skips /authorize owner approval entirely, so a
      // self-registered DCR client must NOT get it unless the operator opted in
      // via `--enable-dcr-insecure`. Gated BEFORE the scope ceiling: when the
      // grant is not on offer at all the reply must say so, not "limited to
      // read" (which implies it is available narrower). CLI/admin paths bypass this.
      grantTypes = client.grant_types?.length ? client.grant_types : ['authorization_code'];
      if (!this.allowClientCredentialsDcr && grantTypes.includes('client_credentials')) {
        throw new InvalidClientMetadataError(
          'client_credentials grant is not permitted via dynamic client registration; ' +
          'restart the server with --enable-dcr-insecure to allow it, or register the ' +
          'client via the gbrain CLI / admin API.',
        );
      }

      // Scope policy for DCR: (1) ceiling — anonymous registration may hold
      // at most `read write` (`read` for an allowed client_credentials
      // registration); privileged scopes are REJECTED as 400, never silently
      // dropped (scope.ts). The ceiling depends on the grant default above.
      // (2) filter unknowns (RFC 7591 value replacement) instead of
      // hard-rejecting: OIDC-flavored stacks append `offline_access` /
      // `openid`. Empty-after-filter with a non-empty request is a hard 400.
      const requestedScopes = parseScopeString(client.scope);
      const ceilingViolation = dcrScopeViolation(requestedScopes, grantTypes);
      if (ceilingViolation) throw new InvalidClientMetadataError(ceilingViolation);
      const { allowed, dropped } = filterAllowedScopes(requestedScopes);
      if (dropped.length > 0) {
        console.warn(
          `[gbrain dcr] dropping unknown scopes from registration ` +
          `(client_name=${client.client_name || 'unnamed'}): ${dropped.join(' ')}`,
        );
      }
      if (requestedScopes.length > 0 && allowed.length === 0) {
        throw new InvalidClientMetadataError(
          `No recognized scopes in request (${requestedScopes.join(' ')}). ` +
          `Allowed: ${ALLOWED_SCOPES_LIST.join(', ')}.`,
        );
      }
      registeredScope = allowed.join(' ');

      // v0.41.3 (T5): validate token_endpoint_auth_method on the DCR path so
      // `--enable-dcr` is not the looser entry point. CLI and admin paths gate
      // through the same `validateTokenEndpointAuthMethod` helper — all three
      // registration entry points share one allow-list.
      authMethod = validateTokenEndpointAuthMethod(client.token_endpoint_auth_method);

    } catch (err) {
      asClientMetadataError(err);
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
    // #6202: registered_via='dcr' marks the client as self-registered, so its
    // owner picks its source at the first consent (OAuthGrants.begin). A brain
    // without the column yet (new server before the migration) falls through to
    // the unmarked ladder: the client keeps today's read-only consent.
    const insertUnmarked = async (): Promise<void> => {
      try {
        await this.sql`
          INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                      grant_types, scope, token_endpoint_auth_method,
                                      client_id_issued_at, source_id, federated_read)
          VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                  ${pgArray((client.redirect_uris || []).map(String))},
                  ${pgArray(grantTypes)},
                  ${registeredScope}, ${authMethod},
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
                      ${registeredScope}, ${authMethod},
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
                        ${registeredScope}, ${authMethod},
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
                    ${registeredScope}, ${authMethod},
                    ${now})
          `;
        } else {
          throw err;
        }
      }
    };
    // #2179: the optional `token_ttl_seconds` hint (dcrRegistrationContext): absent or malformed → server default; out of
    // range → clamped into [dcrTtlMin, dcrTtlMax]; never rejected. Persisted into token_ttl and echoed as stored.
    let effectiveTtl: number | undefined;
    const requestedTtl = dcrRegistrationContext.getStore()?.tokenTtlSeconds;
    const clampedTtl = typeof requestedTtl === 'number' && Number.isFinite(requestedTtl)
      ? clampDcrTokenTtl(requestedTtl, this.dcrTtlMin, this.dcrTtlMax) : undefined;
    // An engine stores the row, ttl included, through its typed member (a Rust brain too); an older schema uses the ladder.
    if (this.engine) {
      try {
        await this.engine.insertOauthClient({ client_id: clientId, client_secret_hash: secretHash, client_name: client.client_name || 'unnamed',
          redirect_uris: (client.redirect_uris || []).map(String), grant_types: grantTypes, scope: registeredScope, token_endpoint_auth_method: authMethod,
          client_id_issued_at: now, source_id: 'default', federated_read: ['default'], registered_via: 'dcr', ...(clampedTtl !== undefined ? { token_ttl: clampedTtl } : {}) });
        return this.registrationResponse(client, clientId, clientSecret, registeredScope, now, clampedTtl);
      } catch (err) {
        if (!isUndefinedColumnError(err, 'registered_via')) throw err;
      }
    }
    try {
      await this.sql`
        INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                    grant_types, scope, token_endpoint_auth_method,
                                    client_id_issued_at, source_id, federated_read, registered_via)
        VALUES (${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
                ${pgArray((client.redirect_uris || []).map(String))},
                ${pgArray(grantTypes)},
                ${registeredScope}, ${authMethod},
                ${now}, ${'default'}, ${pgArray(['default'])}, ${'dcr'})
      `;
    } catch (err) {
      if (!isUndefinedColumnError(err, 'registered_via')) throw err;
      await insertUnmarked();
    }

    if (clampedTtl !== undefined) {
      const clamped = clampedTtl;
      try {
        await this.sql`UPDATE oauth_clients SET token_ttl = ${clamped} WHERE client_id = ${clientId}`;
        effectiveTtl = clamped;
      } catch (e) {
        // Pre-migration schema without the token_ttl column: keep the
        // registration, but do NOT echo a TTL that wasn't persisted.
        if (!isUndefinedColumnError(e, 'token_ttl')) throw e;
      }
    }

    return this.registrationResponse(client, clientId, clientSecret, registeredScope, now, effectiveTtl);
  }

  /** RFC 7591 §3.2.1: no `client_secret` for a public client, the secret once for a confidential one, the filtered scope, and the TTL only as stored. */
  private registrationResponse(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>, clientId: string,
    clientSecret: string | undefined, registeredScope: string, now: number, effectiveTtl: number | undefined): OAuthClientInformationFull {
    const response: OAuthClientInformationFull = { ...client, scope: registeredScope, client_id: clientId, client_id_issued_at: now };
    if (clientSecret) response.client_secret = clientSecret;
    if (effectiveTtl !== undefined) (response as Record<string, unknown>).token_ttl_seconds = effectiveTtl;
    return response;
  }
}

// ---------------------------------------------------------------------------
// OAuth Provider
// ---------------------------------------------------------------------------

/**
 * The registration-time checks, the minted id and secret, and the grant of a manual client registration: everything
 * registerClientManual decides before its SQL. `grant(context)` builds and validates the scoped grant (the up-to-date
 * schema branch). auth.ts registerScopedClient shares it on the engine path.
 */
export function planManualClient(
  name: string,
  grantTypes: string[],
  scopes: string,
  redirectUris: string[] = [],
  sourceId: string = 'default',
  federatedRead?: string[],
  tokenEndpointAuthMethod?: string,
  agentBindings?: AgentClientBindings,
  grantPatch?: GrantPatch,
): ManualClientPlan {
  // v0.28: ALLOWED_SCOPES allowlist. Reject `--scopes "read flying-unicorn"`
  // at registration so meaningless scope strings can't pile up in the DB.
  // Pre-allowlist clients keep working (allowlist is registration-time;
  // existing rows aren't re-validated).
  assertAllowedScopes(parseScopeString(scopes));

  // A bound_slug_prefixes entry that is empty or whitespace-only makes
  // `startsWith` true for every slug — a binding that looks set in
  // `auth list` and the admin UI while fencing nothing. Reject at
  // registration, the same way source ids are validated.
  if (agentBindings?.boundTools && (agentBindings.boundTools.length === 0 || agentBindings.boundTools.some(tool => typeof tool !== 'string' || !tool.trim()))) {
    throw new Error('--bound-tools requires at least one non-empty tool name');
  }
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
  const metadata: GrantClientMetadata = { secretHash, redirectUris, grantTypes, authMethod, issuedAt: now };
  const grant = (context: GrantValidationContext): ClientGrant => manualClientGrant({ clientId, name, scopes, sourceId, federated, agentBindings, grantPatch }, context);
  return { clientId, clientSecret, secretHash, authMethod, now, federated, metadata, grant };
}

/** What planManualClient decided. */
export interface ManualClientPlan {
  clientId: string;
  clientSecret?: string;
  secretHash: string | null;
  authMethod: TokenEndpointAuthMethod;
  now: number;
  federated: string[];
  metadata: GrantClientMetadata;
  grant(context: GrantValidationContext): ClientGrant;
}

export class GBrainOAuthProvider implements OAuthServerProvider {
  // The SDK otherwise consumes the verifier and calls our exchange with
  // undefined. This provider validates S256 itself before consuming the code,
  // for both the SDK's public-client route and our confidential-client route.
  readonly skipLocalPkceValidation = true;
  private sql: SqlQuery;
  private engine?: BrainEngine;
  private transaction?: OAuthTransaction;
  private _clientsStore: GBrainClientsStore;
  private readonly dcrDisabled: boolean;
  private tokenTtl: number;
  private refreshTtl: number;
  readonly grants: OAuthGrants;

  constructor(options: GBrainOAuthProviderOptions) {
    this.sql = options.sql;
    this.engine = options.engine;
    this.transaction = options.transaction;
    this.dcrDisabled = options.dcrDisabled === true;
    this.tokenTtl = options.tokenTtl || 3600;
    this.refreshTtl = options.refreshTtl || 30 * 24 * 3600;
    this.grants = new OAuthGrants({ sql: this.sql, engine: options.engine, transaction: options.transaction, tokenTtl: this.tokenTtl, refreshTtl: this.refreshTtl, resourceUrl: options.resourceUrl });
    // #2179 fail-closed: an unset DCR max is bounded by the operator's own
    // token TTL — never a fixed permissive ceiling — so a self-registering
    // client cannot elect a longer-lived token than the server default
    // unless the admin explicitly configured a wider window.
    const dcrTtlMin = Math.min(options.dcrTtlMinSeconds ?? DEFAULT_DCR_TTL_MIN_SECONDS, TOKEN_TTL_MAX_SECONDS);
    const dcrTtlMax = Math.min(options.dcrTtlMaxSeconds ?? Math.max(this.tokenTtl, dcrTtlMin), TOKEN_TTL_MAX_SECONDS);
    this._clientsStore = new GBrainClientsStore(
      this.sql,
      options.allowClientCredentialsDcr === true,
      dcrTtlMin,
      dcrTtlMax,
      options.engine,
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
    const id = await this.grants.begin(client.client_id, params);
    res.redirect(`/admin/?oauth_request=${id}#oauth-consent`);
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const codeHash = hashToken(authorizationCode);
    // F1 hardening: bind client_id atomically so a wrong client cannot read
    // another client's PKCE challenge. Pre-fix the SELECT didn't filter on
    // client_id at all.
    if (this.engine) return this.challengeOrRefuse(await this.engine.readOauthCodeChallenge(codeHash, client.client_id, Math.floor(Date.now() / 1000)));
    const rows = await this.sql`
      SELECT code_challenge FROM oauth_codes
      JOIN oauth_clients ON oauth_clients.client_id = oauth_codes.client_id
      WHERE (to_jsonb(oauth_clients)->>'deleted_at') IS NULL
        AND code_hash = ${codeHash}
        AND oauth_codes.client_id = ${client.client_id}
        AND oauth_codes.expires_at > ${Math.floor(Date.now() / 1000)}
    `;
    return this.challengeOrRefuse(rows.length === 0 ? null : rows[0].code_challenge as string);
  }

  private challengeOrRefuse(challenge: string | null): string {
    if (challenge === null) throw new InvalidGrantError('Authorization code not found or expired');
    return challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    return this.grants.exchangeCode(client.client_id, authorizationCode, codeVerifier, redirectUri, resource, client.client_secret);
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
    return this.grants.refresh(client.client_id, refreshToken, scopes, resource, client.client_secret);
  }

  // -------------------------------------------------------------------------
  // Token Verification
  // -------------------------------------------------------------------------

  /**
   * One rung of the bearer check's OAuth token read: through the engine member when the provider has an engine (a store
   * that keeps no OAuth tokens finds none), else the statement `viaSql` sends (BEARER_SQL.oauth_rungs keeps both equal).
   */
  private oauthTokenRows(rung: OauthTokenRung, tokenHash: string, viaSql: () => Promise<Record<string, unknown>[]>): Promise<Record<string, unknown>[]> {
    return this.engine ? this.engine.readOauthAccessTokenRows(tokenHash, rung) : viaSql().then((rows) => rows.map(utcCurrentGrant));
  }

  /** The bearer check's legacy access_tokens read: the engine member when set, else the same statement (BEARER_SQL). */
  private async legacyTokenRows(tokenHash: string): Promise<Record<string, unknown>[]> {
    if (this.engine) {
      const row = await this.engine.readActiveAccessTokenByHash(tokenHash, 'provider');
      return row ? [row] : [];
    }
    return this.sql`
      SELECT * FROM access_tokens
      WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
    `;
  }

  async verifyAccessToken(token: string, opts?: { touch?: boolean }): Promise<SdkAuthInfo> {
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
      oauthRows = await this.oauthTokenRows(0, tokenHash, () => this.sql`
        SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes, to_jsonb(t)->>'grant_type' AS token_grant,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
               c.source_id, c.federated_read, c.bound_slug_prefixes,
               c.surface, c.surface_set_by
        FROM oauth_tokens t
        LEFT JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
      `);
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
        oauthRows = await this.oauthTokenRows(1, tokenHash, () => this.sql`
          SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
                 c.source_id, c.federated_read, c.bound_slug_prefixes
          FROM oauth_tokens t
          LEFT JOIN oauth_clients c ON c.client_id = t.client_id
          WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
        `);
      } catch (errS) {
        if (!missingOAuthColumn(errS)) throw errS;
        try {
          // v85 missing: keep source_id + federated_read, drop the fence column.
          oauthRows = await this.oauthTokenRows(2, tokenHash, () => this.sql`
            SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources,
                   c.source_id, c.federated_read
            FROM oauth_tokens t
            LEFT JOIN oauth_clients c ON c.client_id = t.client_id
            WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
          `);
        } catch (err2) {
          if (!missingOAuthColumn(err2)) throw err2;
          try {
            // v61 missing: source_id only.
            oauthRows = await this.oauthTokenRows(3, tokenHash, () => this.sql`
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources, c.source_id
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
            `);
          } catch (err3) {
            if (!missingOAuthColumn(err3)) throw err3;
            // Truly pre-v60: pre-v0.34 projection.
            oauthRows = await this.oauthTokenRows(4, tokenHash, () => this.sql`
              SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name, c.scope AS current_scopes,
               (to_jsonb(c) - 'client_secret_hash') AS current_grant,
               EXISTS(SELECT 1 FROM sources s WHERE s.id = to_jsonb(c)->>'source_id'
                 AND NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)) AS source_active,
               ARRAY(SELECT s.id FROM sources s WHERE NOT COALESCE((to_jsonb(s)->>'archived')::boolean, false)
                 AND s.id IN (SELECT jsonb_array_elements_text(COALESCE(NULLIF(to_jsonb(c)->'federated_read', 'null'::jsonb), jsonb_build_array(to_jsonb(c)->>'source_id'))))) AS active_read_sources
              FROM oauth_tokens t
              LEFT JOIN oauth_clients c ON c.client_id = t.client_id
              WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
          AND c.client_id IS NOT NULL AND (to_jsonb(c)->>'deleted_at') IS NULL
            `);
          }
        }
      }
    }

    if (oauthRows.length > 0) {
      const row = oauthRows[0];
      const currentGrant = row.current_grant && typeof row.current_grant === 'object' ? row.current_grant as Record<string, unknown> : {};
      for (const field of ['allowed_operations', 'grant_revision', 'grant_profile', 'grant_repair_reasons', 'bound_tools', 'bound_source_id', 'bound_brain_id', 'delegated_slug_prefixes', 'delegated_namespace', 'bound_max_concurrent', 'budget_usd_per_day']) row[field] = currentGrant[field];
      row.client_deleted_at = currentGrant.deleted_at;
      row.grant_projection_present = 'allowed_operations' in currentGrant;
      if (row.client_deleted_at != null || row.current_scopes == null) throw new InvalidTokenError('Client revoked or missing');
      const issuedScopes = Array.isArray(row.scopes) ? row.scopes as string[] : [];
      const effectiveScopes = intersectGrantedScopes(issuedScopes, parseScopeString(String(row.current_scopes)));
      const grantProjectionDegraded = row.grant_profile != null && (row.grant_projection_present !== true || !Array.isArray(row.allowed_operations));
      if (grantProjectionDegraded) throw new InvalidTokenError('Client grant schema incomplete; run gbrain apply-migrations --yes');
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
      // Grant membership is live: archiving a previously granted source must
      // not leave its old snapshot readable. A wholly inactive grant exposes
      // no operations; authenticated capability metadata can explain why.
      if (rowSourceId !== undefined && row.source_active === false) effectiveScopes.length = 0;
      if (allowedSources?.length && Array.isArray(row.active_read_sources)) {
        allowedSources = allowedSources.filter(id => (row.active_read_sources as string[]).includes(id));
        if (allowedSources.length === 0) effectiveScopes.length = 0;
      }
      const shared = await clientReadShared(sourceReadsFor(this.engine, this.sql), currentGrant, allowedSources ?? [rowSourceId ?? 'default'], effectiveScopes.length > 0, async () => (await tokenMemberBinding(this.sql, currentGrant, currentGrant.client_id_issued_at, this.engine)).member?.id ?? null);
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
      // The explicit no-source grant: every read and write refuses
      // (NO_SOURCES, the same sentinel a `--sources none` token carries).
      const sourcesNone = currentGrant.source_grant === 'none';
      const clientHolders = Array.isArray(currentGrant.takes_holders)
        ? (currentGrant.takes_holders as unknown[]).filter((h): h is string => typeof h === 'string') : undefined;
      return {
        token,
        clientId: row.client_id as string,
        principal: { kind: 'oauth_client', id: row.client_id as string },
        ...withAttestRight(await tokenMemberBinding(this.sql, currentGrant, currentGrant.client_id_issued_at, this.engine), currentGrant, row.token_grant), ...shared?.flags,
        clientName: (row.client_name as string | null) ?? undefined,
        scopes: effectiveScopes,
        issuedScopes,
        sourceActive: rowSourceId === undefined ? undefined : row.source_active === true,
        allowedOperations: Array.isArray(row.allowed_operations) ? row.allowed_operations as string[] : null,
        grantRevision: Number(row.grant_revision ?? 0),
        grantProfile: typeof row.grant_profile === 'string' ? row.grant_profile : null,
        grantRepairReasons: Array.isArray(row.grant_repair_reasons) ? row.grant_repair_reasons as string[] : [],
        tokenTtlSeconds: currentGrant.token_ttl == null ? null : Number(currentGrant.token_ttl),
        boundTools: Array.isArray(row.bound_tools) ? row.bound_tools as string[] : null,
        boundSourceId: typeof row.bound_source_id === 'string' ? row.bound_source_id : null,
        boundBrainId: typeof row.bound_brain_id === 'string' ? row.bound_brain_id : null,
        delegatedSlugPrefixes: Array.isArray(row.delegated_slug_prefixes) ? row.delegated_slug_prefixes as string[] : null,
        delegatedNamespace: row.delegated_namespace === 'job' ? 'job' : 'prefixes',
        boundMaxConcurrent: Number(row.bound_max_concurrent ?? 1),
        budgetUsdPerDay: row.budget_usd_per_day == null ? null : String(row.budget_usd_per_day),
        expiresAt,
        resource: row.resource ? new URL(row.resource as string) : undefined,
        // v0.34.1 (#861, D2): source-isolation scope from oauth_clients.
        // Undefined when the row predates v60 or when the brain itself
        // predates v60 (fell through to the legacy projection above).
        sourceId: sourcesNone ? NO_SOURCES : rowSourceId,
        // v0.34.1 (#876): federated read scope. sourceScopeOpts in
        // operations.ts prefers this array over scalar sourceId when set
        // and non-empty.
        allowedSources: sourcesNone ? [] : shared?.allowedSources ?? allowedSources,
        ...(sourcesNone ? { hasSourceGrant: true } : {}),
        // Per-client takes holders; undefined → the /mcp dispatch site's fail-closed ['world'].
        ...(clientHolders ? { takesHoldersAllowList: clientHolders } : {}),
        // v0.42.72.0: write fence — consumed by enforceClientSlugFence in
        // operations.ts on every direct slug-mutating write op.
        boundSlugPrefixes,
        ...(fenceProjectionDegraded ? { fenceProjectionDegraded: true } : {}),
        // WP4: per-client surface + operator-lock marker (amendment 19).
        ...(rowSurface !== undefined ? { surface: rowSurface } : {}),
        ...(rowSurfaceSetBy !== undefined ? { surfaceSetBy: rowSurfaceSetBy } : {}),
        // #5575 (CEO-18): the client's read floor; current_grant is the whole row, so no projection rung needs it.
        ...(storedMinTrust(currentGrant.min_trust) ? { minTrust: storedMinTrust(currentGrant.min_trust) } : {}),
        // GBRA-156 / GBRA-575: private pages and private facts in the sources the client's grant names (source_id + federated_read), never its bound source.
        ...(sourcesNone || rowSourceId === undefined ? {} : privatePagesAuth(grantFromClient(grantFromRow({ ...currentGrant, source_id: rowSourceId, federated_read: allowedSources ?? [] })))),
      } as CoreAuthInfo as SdkAuthInfo;
    }

    // Fallback: legacy access_tokens table (backward compat). SELECT * keeps
    // every schema generation readable: pre-v38 rows have no permissions,
    // pre-F3 rows no grant columns, and `scopes` (original schema) must never
    // drop out of the projection, or normalizeTokenScopes(undefined) would
    // grandfather a scoped token to full admin (ship-review P1).
    const legacyRows = await this.legacyTokenRows(tokenHash);

    if (legacyRows.length > 0) {
      // For legacy tokens, name = clientId = clientName (single identifier).
      // #2833: debounced fire-and-forget last_used_at update that never blocks
      // or fails verification; shared with src/mcp/http-transport.ts.
      if (opts?.touch !== false) void touchTokenLastUsed(this.engine ?? this.sql, legacyRows[0]);
      const name = legacyRows[0].name as string;
      // One grant shape (grants/model.ts), shared with the legacy HTTP
      // transport so the two cannot drift. Unified rows read the columns,
      // fail-closed on drift; a row still on the legacy shape is converted on
      // this read (resolveTokenGrant). Scopes: NULL (every token minted before
      // #4043) is grandfathered full access; an array is honored as-is,
      // including [] as deny. Takes holders null → the /mcp dispatch site
      // defaults to the fail-closed ['world'].
      const grant = await resolveTokenGrant(this.sql, legacyRows[0], this.engine);
      return {
        token,
        clientId: name,
        principal: { kind: 'legacy_token', id: String(legacyRows[0].id) },
        ...withAttestRight(await tokenMemberBinding(this.sql, legacyRows[0], legacyRows[0].created_at, this.engine), legacyRows[0], 'legacy'),
        clientName: name,
        scopes: grant.scopes,
        ...(grant.allowedOperations === null ? {} : { allowedOperations: grant.allowedOperations }),
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600, // Legacy tokens never expire — set 1yr future
        // #3242 parity: hasSourceGrant=false only on the historical no-grant
        // floor, the one case that may widen unqualified reads.
        ...await tokenReadSources(sourceReadsFor(this.engine, this.sql), grant, async () => (await tokenMemberBinding(this.sql, legacyRows[0], legacyRows[0].created_at, this.engine)).member?.id ?? null),
        takesHoldersAllowList: grant.takesHolders ?? undefined,
        ...(storedMinTrust(legacyRows[0].min_trust) ? { minTrust: storedMinTrust(legacyRows[0].min_trust) } : {}),
        ...privatePagesAuth(grant),
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
    await this.grants.revokeToken(client.client_id, request.token, client.client_secret);
  }

  /** Owner-triggered revocation serializes with every grant path. */
  async revokeClient(clientId: string): Promise<void> {
    await this.grants.revokeClient(clientId);
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
    if (!client || typeof client.client_secret !== 'string' || !/^[a-f0-9]{64}$/i.test(client.client_secret) || !safeHexEqual(client.client_secret, hashToken(presentedSecret))) {
      throw new InvalidClientError('Invalid client or client has been revoked');
    }
    return client;
  }

  async exchangeClientCredentials(
    clientId: string,
    clientSecret: string,
    requestedScope?: string,
  ): Promise<OAuthTokens> {
    return this.grants.clientCredentials(clientId, clientSecret, requestedScope);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async sweepExpiredTokens(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    // With an engine, the sweep runs through the engine member (engine-sql/access-credentials.ts OAUTH_SWEEP_SQL, the same
    // two statements), so a store with no raw SQL (the Rust engine) sweeps too.
    if (this.engine) return this.engine.deleteExpiredOauthCredentials(now);
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
    return result.length + deletedCodes.length + await this.grants.sweepExpiredRotations();
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
    grantPatch?: GrantPatch,
  ): Promise<{ clientId: string; clientSecret?: string }> {
    const { clientId, clientSecret, secretHash, authMethod, now, federated, metadata, grant } = planManualClient(
      name, grantTypes, scopes, redirectUris, sourceId, federatedRead, tokenEndpointAuthMethod, agentBindings, grantPatch);
    const schema = await this.sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'oauth_clients'
        AND column_name IN ('grant_revision', 'allowed_operations', 'delegated_slug_prefixes', 'delegated_namespace', 'grant_profile', 'grant_repair_reasons', 'surface', 'surface_set_by', 'token_ttl', 'source_id', 'federated_read', 'bound_slug_prefixes', 'bound_tools', 'bound_source_id', 'bound_brain_id', 'bound_max_concurrent', 'budget_usd_per_day')`;
    if (schema.length === 17) {
      const built = grant(await grantValidationContext(this.sql));
      // GST-1113: with a transaction, the scope-source check and the insert commit together under the source row locks.
      await (this.transaction ? this.transaction(sql => insertClientGrant(sql, built, metadata)) : insertClientGrant(this.sql, built, metadata));
      return { clientId, clientSecret };
    }
    if (grantPatch || hasScope(parseScopeString(scopes), 'agent')) {
      throw new Error('Client grants require an up-to-date OAuth schema; run gbrain apply-migrations --yes');
    }
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
  async rescopeClient(clientId: string, opts: RescopeClientOptions): Promise<RescopeClientResult> {
    return rescopeOAuthClient(this.engine ?? this.sql, clientId, opts);
  }

}
