/** OAuth grant lifecycle. Every grant mutation locks the same client row. */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientError, InvalidGrantError, InvalidRequestError, InvalidTargetError, ServerError, TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { SqlQuery } from './sql-query.ts';
import { generateToken, hashToken } from './utils.ts';
import { hasScope, parseScopeString } from './scope.ts';
import { TOKEN_TTL_MAX_SECONDS, intersectGrantedScopes } from './grants/model.ts';
import { safeHexEqual } from './timing-safe.ts';
import { isStalePlanError } from './retry-matcher.ts';
import { clientHoldsAuthorization, GrantError, recordFirstConsentInTransaction } from './grants/service.ts';

export type OAuthTransaction = <T>(fn: (sql: SqlQuery) => Promise<T>) => Promise<T>;
type ClientRow = Record<string, unknown>;
export function oauthPgArray(values: string[]): string {
  return `{${values.map(s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

function assertActive(row: ClientRow | undefined): asserts row is ClientRow {
  if (!row || row.deleted_at != null) throw new InvalidClientError('Invalid client or client has been revoked');
}

function grantScopes(row: ClientRow, requested?: string[]): string[] {
  const allowed = parseScopeString(row.scope as string | undefined);
  return (requested?.length ? requested : allowed).filter(scope => hasScope(allowed, scope));
}

/**
 * What an owner's consent grants. A self-registered connector repeats its registration scope on every
 * /authorize, so once the owner changes its grant (`gbrain auth rescope --client <id> --scopes ...`) a
 * request that overlaps that grant takes the whole of it, as shown on the consent page. The grant stays
 * the ceiling, a request naming nothing in it still gets nothing, and operator-registered clients keep
 * the requested subset. Refresh never widens (RFC 6749 §6): only a new consent picks up a widening.
 */
function consentScopes(row: ClientRow, requested?: string[]): string[] {
  const granted = grantScopes(row, requested);
  if (row.registered_via !== 'dcr' || granted.length === 0) return granted;
  return grantScopes(row);
}

/**
 * #5222 — the one RFC 8707 resource canonicalizer, shared by /authorize, code
 * exchange, refresh and bearer verification. `canonical` is the server's /mcp
 * resource, derived from the configured public URL and never from `Host` or
 * forwarded headers. The issuer origin is an alias of it (some clients send
 * the origin root even after reading the protected-resource metadata). URL
 * parsing normalizes scheme and host case and default ports; a trailing
 * slash is ignored. Anything else is `invalid_target`, naming the accepted
 * resource so the client fails loudly instead of looping on a token /mcp
 * will refuse.
 */
export function canonicalOAuthResource(requested: URL | string, canonical: URL): URL {
  const accepted = `use ${canonical.toString()} (or its origin ${canonical.origin})`;
  let url: URL;
  try {
    url = new URL(requested.toString());
  } catch {
    throw new InvalidTargetError(`Invalid resource; ${accepted}`);
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (url.origin === canonical.origin && !url.username && !url.password && !url.search && !url.hash
    && (path === '' || path === canonical.pathname.replace(/\/+$/, ''))) {
    return new URL(canonical.toString());
  }
  throw new InvalidTargetError(`Resource ${url.toString()} is not served here; ${accepted}`);
}

/** Compare policy, not a mutable reference or only the display name. */
function policyDigest(row: ClientRow): string {
  const fields = ['client_id', 'client_name', 'redirect_uris', 'grant_types', 'scope',
    'client_secret_hash', 'token_endpoint_auth_method', 'client_secret_expires_at',
    'source_id', 'federated_read', 'bound_tools', 'bound_source_id', 'bound_brain_id',
    'bound_slug_prefixes', 'bound_max_concurrent', 'budget_usd_per_day', 'surface', 'token_ttl',
    'allowed_operations', 'delegated_slug_prefixes', 'delegated_namespace', 'grant_profile',
    'grant_revision', 'grant_repair_reasons', 'registered_via'];
  return hashToken(JSON.stringify(fields.map(field => row[field] ?? null)));
}

export interface OAuthConsentDetails {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  scopes: string[];
  sourceId: string | null;
  allowedSources: string[];
  resource: string | null;
  allowedOperations: string[] | null;
  boundSlugPrefixes: string[] | null;
  delegatedTools: string[] | null;
  delegatedSlugPrefixes: string[] | null;
  delegatedNamespace: string | null;
  expiresAt: number;
  /**
   * #6202: `editable` only for a self-registered client's first consent
   * (`registered_via='dcr'`, revision 0, no `client_credentials`, a source
   * grant); `options` are the active sources then, `[]` otherwise.
   */
  sourceChoice: { editable: boolean; options: Array<{ id: string; name: string }> };
}
interface PendingAuthorization {
  details: OAuthConsentDetails;
  params: AuthorizationParams;
  policy: string;
  status: 'pending' | 'processing' | 'approved' | 'denied' | 'failed';
}

export class OAuthConsentError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/**
 * #9364: how long the immediate predecessor of a refresh token, replayed by the client it was issued to, still gets
 * back the pair that replaced it (a response lost to a stall or timeout, two tabs, parallel MCP clients). Any other
 * replay of a rotated token revokes the whole sign-in family (RFC 9700 §4.14.2).
 */
export const REFRESH_REUSE_GRACE_MS = 60_000;
const FAMILY_REVOKED = Symbol('refresh-family-revoked');
interface SealedPair { tokens: OAuthTokens; resource: string | null; accessExpiresAt: number }

/** The replacement pair is sealed with a key only the holder of the rotated token can derive; the database keeps only its hash. */
function graceKey(token: string): Buffer {
  return Buffer.from(hkdfSync('sha256', token, Buffer.alloc(0), 'gbrain-oauth-refresh-grace-v1', 32));
}

function sealPair(token: string, pair: SealedPair): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', graceKey(token), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(pair), 'utf8'), cipher.final()]);
  return ['v1', ...[iv, body, cipher.getAuthTag()].map(part => part.toString('base64url'))].join('.');
}

function openPair(token: string, sealed: unknown): SealedPair | null {
  const [version, iv, body, tag] = typeof sealed === 'string' ? sealed.split('.') : [];
  if (version !== 'v1' || !iv || !body || !tag) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', graceKey(token), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')) as SealedPair;
  } catch {
    return null;
  }
}

/** Global ceiling on the in-memory pending store; a full store rejects new requests rather than evicting live ones. */
const MAX_PENDING_TOTAL = 1000;
/**
 * Per-client ceiling on requests still awaiting a decision. Without it a handful of callers could fill
 * the global store on behalf of one self-registered client; with it, no single client_id can consume
 * more than a sliver of the capacity every other client shares. Decided (approved/denied/failed) entries
 * stay in the store until expiry but do not count: only the owner can move a request out of `pending`.
 */
const MAX_PENDING_PER_CLIENT = 10;

export class OAuthGrants {
  private readonly pending = new Map<string, PendingAuthorization>();
  private familiesReady = false;
  constructor(private readonly options: {
    sql: SqlQuery;
    transaction?: OAuthTransaction;
    tokenTtl: number;
    refreshTtl: number;
    now?: () => number;
    /** #5222: the canonical /mcp resource; unset keeps exact-match resource semantics. */
    resourceUrl?: URL;
  }) {}

  private canonicalResource(requested: URL | undefined): URL | undefined {
    if (!requested || !this.options.resourceUrl) return requested;
    return canonicalOAuthResource(requested, this.options.resourceUrl);
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  /** v338 adds refresh families; a schema without it keeps plain single-use rotation. Only a positive answer is cached. */
  private async hasRefreshFamilies(sql: SqlQuery): Promise<boolean> {
    if (this.familiesReady) return true;
    const [row] = await sql`SELECT to_regclass('oauth_refresh_rotations') IS NOT NULL AS ready`;
    return this.familiesReady = row?.ready === true;
  }
  private async locked<T>(clientId: string, fn: (sql: SqlQuery, row: ClientRow) => Promise<T>): Promise<T> {
    const options = this.options;
    if (!options.transaction) throw new ServerError('OAuth grant transactions are unavailable');
    // GST-2260: a stale plan on the client read runs the transaction again. That read comes before the callback writes
    // anything, so the second run is safe even when the caller's transaction is not a real one (mcp-provision).
    let entered = false;
    const run = () => options.transaction!(async sql => {
      const [row] = await sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId} FOR UPDATE`;
      entered = true;
      assertActive(row);
      return fn(sql, row);
    });
    try {
      return await run();
    } catch (error) {
      if (entered || !isStalePlanError(error)) throw error;
      return run();
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [id, pending] of this.pending) {
      if (pending.details.expiresAt <= now) this.pending.delete(id);
    }
  }

  /** Synchronous: prune, then enforce the global and per-client ceilings. Callers must not await between this and the insert. */
  private assertCapacity(clientId: string): void {
    this.prune();
    if (this.pending.size >= MAX_PENDING_TOTAL) throw new TooManyRequestsError('Too many pending requests. Try again shortly.');
    let awaiting = 0;
    for (const pending of this.pending.values()) {
      if (pending.status === 'pending' && pending.details.clientId === clientId && ++awaiting >= MAX_PENDING_PER_CLIENT) {
        throw new TooManyRequestsError('Too many pending requests for this client. Complete or wait for an earlier request before starting another.');
      }
    }
  }

  async begin(clientId: string, params: AuthorizationParams): Promise<string> {
    const resource = this.canonicalResource(params.resource);
    this.assertCapacity(clientId);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('S256 PKCE challenge required');
    const [row] = await this.options.sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId}`;
    assertActive(row);
    if (!Array.isArray(row.grant_types) || !row.grant_types.includes('authorization_code')) {
      throw new InvalidClientError('Authorization code grant not authorized for this client');
    }
    if (!Array.isArray(row.redirect_uris) || !row.redirect_uris.some(uri => typeof uri === 'string' && redirectUriMatches(params.redirectUri, uri))) {
      throw new InvalidRequestError('Redirect URI does not match registered client');
    }
    const editable = row.registered_via === 'dcr' && Number(row.grant_revision) === 0
      && !row.grant_types.includes('client_credentials') && row.source_grant !== 'none'
      && !await clientHoldsAuthorization(this.options.sql, clientId);
    const options = editable
      ? (await this.options.sql`SELECT id, name FROM sources WHERE archived = false ORDER BY id`).map(r => ({ id: String(r.id), name: String(r.name) }))
      : [];
    // No await between the capacity check and insert: concurrent DB reads cannot overfill the store or a client's budget.
    this.assertCapacity(clientId);
    const id = generateToken('');
    const details: OAuthConsentDetails = {
      id, clientId, clientName: typeof row.client_name === 'string' ? row.client_name : clientId,
      redirectUri: params.redirectUri, scopes: consentScopes(row, params.scopes),
      sourceId: typeof row.source_id === 'string' ? row.source_id : null,
      allowedSources: Array.isArray(row.federated_read) ? [...row.federated_read] as string[] : [],
      allowedOperations: Array.isArray(row.allowed_operations) ? [...row.allowed_operations] as string[] : null,
      boundSlugPrefixes: Array.isArray(row.bound_slug_prefixes) ? [...row.bound_slug_prefixes] as string[] : null,
      delegatedTools: Array.isArray(row.bound_tools) ? [...row.bound_tools] as string[] : null,
      delegatedSlugPrefixes: Array.isArray(row.delegated_slug_prefixes) ? [...row.delegated_slug_prefixes] as string[] : null,
      delegatedNamespace: typeof row.delegated_namespace === 'string' ? row.delegated_namespace : null,
      resource: resource?.toString() ?? null, expiresAt: this.now() + 10 * 60_000,
      sourceChoice: { editable, options },
    };
    this.pending.set(id, {
      details, params: { ...params, scopes: [...details.scopes], resource },
      policy: policyDigest(row), status: 'pending',
    });
    return id;
  }

  details(id: string): OAuthConsentDetails {
    this.prune();
    const pending = this.pending.get(id);
    if (!pending || pending.status !== 'pending') {
      throw new OAuthConsentError(410, 'authorization_unavailable', 'This request expired, was completed, or the server restarted. Restart the connection from your client.');
    }
    return structuredClone(pending.details);
  }

  hasPending(id: unknown): id is string {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return false;
    try { this.details(id); return true; } catch { return false; }
  }

  async decide(id: string, approve: boolean, choice?: { sourceId: string }): Promise<string> {
    const { sourceChoice } = this.details(id);
    if (choice !== undefined && (!approve || !sourceChoice.editable || !sourceChoice.options.some(o => o.id === choice.sourceId))) {
      // Refused before the claim: the request stays pending and the owner can reload it.
      throw new OAuthConsentError(403, 'invalid_consent', 'Reload this request and review it again before approving.');
    }
    const pending = this.pending.get(id)!;
    pending.status = 'processing'; // claim synchronously before the first await
    const redirect = new URL(pending.params.redirectUri);
    if (pending.params.state) redirect.searchParams.set('state', pending.params.state);
    if (!approve) {
      pending.status = 'denied';
      redirect.searchParams.set('error', 'access_denied');
      return redirect.toString();
    }
    try {
      const code = await this.locked(pending.details.clientId, async (sql, row) => {
        if (pending.details.expiresAt <= this.now()) throw new OAuthConsentError(410, 'authorization_expired', 'This request expired. Restart the connection from your client.');
        if (policyDigest(row) !== pending.policy) throw new OAuthConsentError(409, 'client_policy_changed', 'Client permissions changed. Restart the connection and review the new request.');
        if (sourceChoice.editable) {
          // The first consent always consumes eligibility (revision 0 → 1), with or without a new source.
          try {
            await recordFirstConsentInTransaction(sql, pending.details.clientId, choice?.sourceId, 'owner');
          } catch (error) {
            if (error instanceof GrantError) throw new OAuthConsentError(409, 'client_policy_changed', 'Client permissions changed. Restart the connection and review the new request.');
            throw error;
          }
        }
        const code = generateToken('gbrain_code_');
        await sql`
          INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
            code_challenge_method, redirect_uri, state, resource, expires_at)
          VALUES (${hashToken(code)}, ${pending.details.clientId}, ${oauthPgArray(pending.details.scopes)},
            ${pending.params.codeChallenge}, ${'S256'}, ${pending.params.redirectUri},
            ${pending.params.state ?? null}, ${pending.details.resource}, ${Math.floor(this.now() / 1000) + 600})
        `;
        return code;
      });
      pending.status = 'approved';
      redirect.searchParams.set('code', code);
      return redirect.toString();
    } catch (error) {
      pending.status = 'failed'; // uncertain commit is terminal; never retry this request
      throw error;
    }
  }

  async exchangeCode(clientId: string, code: string, verifier?: string, redirectUri?: string, resource?: URL, secretHash?: string): Promise<OAuthTokens> {
    const requested = this.canonicalResource(resource);
    return this.locked(clientId, async (sql, client) => {
      this.assertCredentialPolicy(client, secretHash);
      const [row] = await sql`SELECT * FROM oauth_codes WHERE code_hash = ${hashToken(code)} AND client_id = ${clientId} FOR UPDATE`;
      if (!row || !Number.isFinite(Number(row.expires_at)) || Number(row.expires_at) <= Math.floor(this.now() / 1000) || row.expires_at == null) throw new InvalidGrantError('Authorization code not found or expired');
      if (redirectUri === undefined || redirectUri !== row.redirect_uri) throw new InvalidGrantError('Redirect URI does not match authorization code');
      if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
        || row.code_challenge_method !== 'S256'
        || createHash('sha256').update(verifier).digest('base64url') !== row.code_challenge) {
        throw new InvalidGrantError('Invalid S256 PKCE verifier');
      }
      const target = this.resource(row.resource, requested);
      const scopes = this.currentScopes(client, row.scopes as string[]);
      await sql`DELETE FROM oauth_codes WHERE code_hash = ${hashToken(code)} AND client_id = ${clientId}`;
      const family = await this.hasRefreshFamilies(sql) ? generateToken('') : undefined;
      return this.issue(sql, client, scopes, target, true, 'authorization_code', family);
    });
  }

  async refresh(clientId: string, token: string, requested?: string[], resource?: URL, secretHash?: string): Promise<OAuthTokens> {
    const requestedResource = this.canonicalResource(resource);
    const outcome = await this.locked(clientId, async (sql, client) => {
      this.assertCredentialPolicy(client, secretHash);
      const families = await this.hasRefreshFamilies(sql);
      const [row] = await sql`SELECT * FROM oauth_tokens WHERE token_hash = ${hashToken(token)} AND token_type = 'refresh' AND client_id = ${clientId} FOR UPDATE`;
      if (!row && families) return this.replay(sql, clientId, token, requested, requestedResource);
      if (!row) throw new InvalidGrantError('Refresh token not found');
      if (row.expires_at == null || !Number.isFinite(Number(row.expires_at)) || Number(row.expires_at) <= Math.floor(this.now() / 1000)) throw new InvalidGrantError('Refresh token expired');
      const original = Array.isArray(row.scopes) ? row.scopes as string[] : [];
      if (requested?.some(scope => !hasScope(original, scope))) throw new InvalidGrantError('Requested scope exceeds refresh token grant');
      if (requested?.some(scope => !hasScope(parseScopeString(client.scope as string | undefined), scope))) throw new InvalidGrantError('Requested scope exceeds current client grant');
      const scopes = this.currentScopes(client, requested ?? original);
      const target = this.resource(row.resource, requestedResource);
      await sql`DELETE FROM oauth_tokens WHERE token_hash = ${hashToken(token)} AND token_type = 'refresh' AND client_id = ${clientId}`;
      if (!families) return this.issue(sql, client, scopes, target, true, 'refresh_token');
      const family = typeof row.family_id === 'string' && row.family_id ? row.family_id : generateToken('');
      const tokens = await this.issue(sql, client, scopes, target, true, 'refresh_token', family);
      const nowMs = this.now();
      const sealed = sealPair(token, { tokens, resource: target?.toString() ?? null, accessExpiresAt: Math.floor(nowMs / 1000) + Number(tokens.expires_in) });
      await sql`UPDATE oauth_refresh_rotations SET sealed_pair = NULL WHERE client_id = ${clientId} AND sealed_pair IS NOT NULL AND rotated_at_ms <= ${nowMs - REFRESH_REUSE_GRACE_MS}`;
      await sql`INSERT INTO oauth_refresh_rotations (token_hash, client_id, family_id, replaced_by_hash, rotated_at_ms, expires_at, sealed_pair)
        VALUES (${hashToken(token)}, ${clientId}, ${family}, ${hashToken(tokens.refresh_token!)}, ${nowMs}, ${Number(row.expires_at)}, ${sealed})`;
      return tokens;
    });
    if (outcome === FAMILY_REVOKED) throw new InvalidGrantError('Refresh token was already used; this sign-in has been revoked. Reconnect the client.');
    return outcome;
  }

  /**
   * A refresh token that is no longer live. Only the immediate predecessor of the family's live refresh token, sent
   * by the client it was issued to inside the grace window, gets the sealed replacement pair back. Anything else that
   * matches a rotation (another client, after the window, an older ancestor, a family already revoked) deletes every
   * token of the family, under the owning client's row lock, and commits before the caller is refused.
   */
  private async replay(sql: SqlQuery, clientId: string, token: string, requested?: string[], requestedResource?: URL): Promise<OAuthTokens | typeof FAMILY_REVOKED> {
    const [rotation] = await sql`SELECT * FROM oauth_refresh_rotations WHERE token_hash = ${hashToken(token)} FOR UPDATE`;
    if (!rotation) throw new InvalidGrantError('Refresh token not found');
    const family = String(rotation.family_id);
    const nowMs = this.now();
    const inWindow = rotation.client_id === clientId && Number(rotation.rotated_at_ms) > nowMs - REFRESH_REUSE_GRACE_MS && rotation.sealed_pair != null;
    const [replacement] = inWindow
      ? await sql`SELECT 1 AS live FROM oauth_tokens WHERE token_hash = ${String(rotation.replaced_by_hash)} AND token_type = 'refresh' AND client_id = ${clientId} AND family_id = ${family}`
      : [];
    const pair = replacement ? openPair(token, rotation.sealed_pair) : null;
    if (!pair) {
      if (rotation.client_id !== clientId) await sql`SELECT client_id FROM oauth_clients WHERE client_id = ${String(rotation.client_id)} FOR UPDATE`;
      await sql`DELETE FROM oauth_tokens WHERE family_id = ${family}`;
      await sql`UPDATE oauth_refresh_rotations SET sealed_pair = NULL WHERE family_id = ${family}`;
      return FAMILY_REVOKED;
    }
    if (requested?.some(scope => !hasScope(parseScopeString(pair.tokens.scope), scope))) throw new InvalidGrantError('Requested scope exceeds refresh token grant');
    if (requestedResource && requestedResource.toString() !== pair.resource) throw new InvalidGrantError('Requested resource exceeds the approved grant');
    return { ...pair.tokens, expires_in: Math.max(0, pair.accessExpiresAt - Math.floor(nowMs / 1000)) };
  }

  private currentScopes(client: ClientRow, original: string[]): string[] {
    const allowed = parseScopeString(client.scope as string | undefined);
    return intersectGrantedScopes(original ?? [], allowed);
  }

  private assertCredentialPolicy(client: ClientRow, secretHash?: string): void {
    if ((client.client_secret_hash ?? undefined) !== secretHash) throw new InvalidClientError('Client credentials changed; authenticate again');
    const expires = Number(client.client_secret_expires_at);
    if (secretHash && expires > 0 && expires <= Math.floor(this.now() / 1000)) throw new InvalidClientError('Client credentials expired');
  }

  /** `requested` is already canonical; a stored origin-bound grant from before #5222 canonicalizes the same way. */
  private resource(stored: unknown, requested?: URL): URL | undefined {
    if (typeof stored === 'string' && stored) {
      let approved: URL;
      try {
        approved = this.canonicalResource(new URL(stored))!;
      } catch {
        throw new InvalidGrantError('The approved grant is bound to a resource this server does not serve; reconnect the client');
      }
      if (requested && requested.toString() !== approved.toString()) throw new InvalidGrantError('Requested resource exceeds the approved grant');
      return approved;
    }
    return requested; // pre-resource grants remain valid on upgrade
  }

  async clientCredentials(clientId: string, secret: string, requested?: string): Promise<OAuthTokens> {
    return this.locked(clientId, async (sql, client) => {
      if (!Array.isArray(client.grant_types) || !client.grant_types.includes('client_credentials')) throw new InvalidGrantError('Client credentials grant not authorized for this client');
      if (typeof client.client_secret_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(client.client_secret_hash) || !safeHexEqual(client.client_secret_hash, hashToken(secret))) throw new InvalidClientError('Invalid client secret');
      this.assertCredentialPolicy(client, client.client_secret_hash);
      return this.issue(sql, client, grantScopes(client, requested ? parseScopeString(requested) : undefined), undefined, false, 'client_credentials');
    });
  }

  async revokeToken(clientId: string, token: string, secretHash?: string): Promise<void> {
    await this.locked(clientId, async (sql, client) => {
      this.assertCredentialPolicy(client, secretHash);
      await sql`DELETE FROM oauth_tokens WHERE token_hash = ${hashToken(token)} AND client_id = ${clientId}`;
    });
  }

  async revokeClient(clientId: string): Promise<void> {
    if (!this.options.transaction) throw new ServerError('OAuth grant transactions are unavailable');
    await this.options.transaction(async sql => {
      const [row] = await sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId} FOR UPDATE`;
      if (!row) return;
      // Inspect optional schema before the statement; catching a missing column inside a PG transaction aborts it.
      if ('deleted_at' in row) await sql`UPDATE oauth_clients SET deleted_at = now() WHERE client_id = ${clientId}`;
      else await sql`DELETE FROM oauth_clients WHERE client_id = ${clientId}`;
      await sql`DELETE FROM oauth_codes WHERE client_id = ${clientId}`;
      await sql`DELETE FROM oauth_tokens WHERE client_id = ${clientId}`;
      if (await this.hasRefreshFamilies(sql)) await sql`DELETE FROM oauth_refresh_rotations WHERE client_id = ${clientId}`;
    });
  }

  /** Rotation records outlive their family's grace only until the rotated token would have expired. */
  async sweepExpiredRotations(): Promise<number> {
    if (!await this.hasRefreshFamilies(this.options.sql)) return 0;
    return (await this.options.sql`DELETE FROM oauth_refresh_rotations WHERE expires_at < ${Math.floor(this.now() / 1000)} RETURNING 1`).length;
  }

  /**
   * GST-359 C1: each token records the grant that issued it (oauth_tokens.grant_type); only client_credentials tokens
   * may attest an actor. grant_type is migration-only (v286, beside oauth_clients.attest_actor), so a schema without it
   * issues unmarked tokens, which never attest. The locked client row tells which: a failed INSERT would abort the
   * surrounding transaction, so the schema is inspected before the statement.
   */
  private async issue(sql: SqlQuery, client: ClientRow, scopes: string[], resource: URL | undefined, refresh: boolean, grant: 'authorization_code' | 'refresh_token' | 'client_credentials', family?: string): Promise<OAuthTokens> {
    const clientId = client.client_id as string;
    const override = Number(client.token_ttl);
    const ttl = Math.min(Number.isFinite(override) && override > 0 ? override : this.options.tokenTtl, TOKEN_TTL_MAX_SECONDS);
    const now = Math.floor(this.now() / 1000);
    const marked = 'attest_actor' in client;
    const insert = (token: string, type: 'access' | 'refresh', expiresAt: number) => family
      ? sql`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource, created_at, grant_type, family_id)
          VALUES (${hashToken(token)}, ${type}, ${clientId}, ${oauthPgArray(scopes)}, ${expiresAt}, ${resource?.toString() ?? null}, to_timestamp(${now}), ${grant}, ${family})`
      : marked
      ? sql`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource, created_at, grant_type)
          VALUES (${hashToken(token)}, ${type}, ${clientId}, ${oauthPgArray(scopes)}, ${expiresAt}, ${resource?.toString() ?? null}, to_timestamp(${now}), ${grant})`
      : sql`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource, created_at)
          VALUES (${hashToken(token)}, ${type}, ${clientId}, ${oauthPgArray(scopes)}, ${expiresAt}, ${resource?.toString() ?? null}, to_timestamp(${now}))`;
    const access = generateToken('gbrain_at_');
    await insert(access, 'access', now + ttl);
    const result: OAuthTokens = { access_token: access, token_type: 'bearer', expires_in: ttl, scope: scopes.join(' ') };
    if (refresh) {
      const token = generateToken('gbrain_rt_');
      await insert(token, 'refresh', now + this.options.refreshTtl);
      result.refresh_token = token;
    }
    return result;
  }
}
