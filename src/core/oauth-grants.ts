/** OAuth grant lifecycle. Every grant mutation locks the same client row. */
import { createHash } from 'node:crypto';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientError, InvalidGrantError, InvalidRequestError, InvalidTargetError, ServerError, TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { SqlQuery } from './sql-query.ts';
import type { BrainEngine } from './engine.ts';
import { normalizeOauthClientRow } from './engine-sql/oauth-clients.ts';
import { normalizeOauthCodeRow, oauthPgArray, type OauthTokenInsert } from './engine-sql/access-credentials.ts';
import { generateToken, hashToken } from './utils.ts';
import { hasScope, parseScopeString } from './scope.ts';
import { TOKEN_TTL_MAX_SECONDS, intersectGrantedScopes } from './grants/model.ts';
import { safeHexEqual } from './timing-safe.ts';
import { isStalePlanError } from './retry-matcher.ts';
import { clientHoldsAuthorization, GrantError, recordFirstConsentInTransaction } from './grants/service.ts';

/**
 * `tx` is the engine handle bound to the same transaction as `sql` (serve-http passes it): with it the grant's client lock,
 * code and token statements run as engine members on that transaction (a store with no raw SQL, the Rust engine, runs them
 * in its one write transaction); without it they are the same statements through `sql`.
 */
export type OAuthTransaction = <T>(fn: (sql: SqlQuery, tx?: BrainEngine) => Promise<T>) => Promise<T>;
type ClientRow = Record<string, unknown>;
/** An engine member's typed row as the plain record the grant logic reads, or undefined when the member found none. */
const asRow = (row: object | null): Record<string, unknown> | undefined => row ? { ...row } : undefined;
export { oauthPgArray };

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
  // The bigint columns read as a string on one engine and a number on another: digest the normalized row, so the row
  // `begin` read and the row `locked` read agree whichever way each was read.
  const normalized = normalizeOauthClientRow(row) as unknown as ClientRow;
  return hashToken(JSON.stringify(fields.map(field => normalized[field] ?? null)));
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
  constructor(private readonly options: {
    sql: SqlQuery;
    /** The brain's engine: `begin` reads the client through it, so a store with no raw SQL (the Rust engine) serves the consent. */
    engine?: BrainEngine;
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
  private async locked<T>(clientId: string, fn: (sql: SqlQuery, row: ClientRow, tx?: BrainEngine) => Promise<T>): Promise<T> {
    const options = this.options;
    if (!options.transaction) throw new ServerError('OAuth grant transactions are unavailable');
    // GST-2260: a stale plan on the client read runs the transaction again. That read comes before the callback writes
    // anything, so the second run is safe even when the caller's transaction is not a real one (mcp-provision).
    let entered = false;
    const run = () => options.transaction!(async (sql, tx) => {
      const row: ClientRow | undefined = tx ? asRow(await tx.readOauthClientForUpdate(clientId))
        : (await sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId} FOR UPDATE`)[0];
      entered = true;
      assertActive(row);
      return fn(sql, row, tx);
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
    const engine = this.options.engine;
    const row: ClientRow | undefined = engine ? asRow(await engine.readOauthClient(clientId))
      : (await this.options.sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId}`)[0];
    assertActive(row);
    if (!Array.isArray(row.grant_types) || !row.grant_types.includes('authorization_code')) {
      throw new InvalidClientError('Authorization code grant not authorized for this client');
    }
    if (!Array.isArray(row.redirect_uris) || !row.redirect_uris.some(uri => typeof uri === 'string' && redirectUriMatches(params.redirectUri, uri))) {
      throw new InvalidRequestError('Redirect URI does not match registered client');
    }
    const editable = row.registered_via === 'dcr' && Number(row.grant_revision) === 0
      && !row.grant_types.includes('client_credentials') && row.source_grant !== 'none'
      && !await clientHoldsAuthorization(engine ?? this.options.sql, clientId);
    // An engine lists the active sources through its member; ids sort byte for byte, so every engine and locale shows one order.
    const options = !editable ? []
      : engine ? (await engine.listAllSources({ includeArchived: false })).map(r => ({ id: String(r.id), name: String(r.name) })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        : (await this.options.sql`SELECT id, name FROM sources WHERE archived = false ORDER BY id COLLATE "C"`).map(r => ({ id: String(r.id), name: String(r.name) }));
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
      const code = await this.locked(pending.details.clientId, async (sql, row, tx) => {
        if (pending.details.expiresAt <= this.now()) throw new OAuthConsentError(410, 'authorization_expired', 'This request expired. Restart the connection from your client.');
        if (policyDigest(row) !== pending.policy) throw new OAuthConsentError(409, 'client_policy_changed', 'Client permissions changed. Restart the connection and review the new request.');
        if (sourceChoice.editable) {
          // The first consent always consumes eligibility (revision 0 → 1), with or without a new source.
          try {
            await recordFirstConsentInTransaction(tx ?? sql, pending.details.clientId, choice?.sourceId, 'owner');
          } catch (error) {
            if (error instanceof GrantError) throw new OAuthConsentError(409, 'client_policy_changed', 'Client permissions changed. Restart the connection and review the new request.');
            throw error;
          }
        }
        const code = generateToken('gbrain_code_');
        const expiresAt = Math.floor(this.now() / 1000) + 600;
        if (tx) {
          await tx.insertOauthCode({ code_hash: hashToken(code), client_id: pending.details.clientId, scopes: pending.details.scopes,
            code_challenge: pending.params.codeChallenge, code_challenge_method: 'S256', redirect_uri: pending.params.redirectUri,
            state: pending.params.state ?? null, resource: pending.details.resource, expires_at: expiresAt });
        } else {
          await sql`
          INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
            code_challenge_method, redirect_uri, state, resource, expires_at)
          VALUES (${hashToken(code)}, ${pending.details.clientId}, ${oauthPgArray(pending.details.scopes)},
            ${pending.params.codeChallenge}, ${'S256'}, ${pending.params.redirectUri},
            ${pending.params.state ?? null}, ${pending.details.resource}, ${expiresAt})
        `;
        }
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
    return this.locked(clientId, async (sql, client, tx) => {
      this.assertCredentialPolicy(client, secretHash);
      const row: Record<string, unknown> | undefined = tx ? asRow(await tx.readOauthCodeForUpdate(hashToken(code), clientId))
        : (await sql`SELECT * FROM oauth_codes WHERE code_hash = ${hashToken(code)} AND client_id = ${clientId} FOR UPDATE`)[0];
      if (!row || !Number.isFinite(Number(row.expires_at)) || Number(row.expires_at) <= Math.floor(this.now() / 1000) || row.expires_at == null) throw new InvalidGrantError('Authorization code not found or expired');
      if (redirectUri === undefined || redirectUri !== row.redirect_uri) throw new InvalidGrantError('Redirect URI does not match authorization code');
      if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
        || row.code_challenge_method !== 'S256'
        || createHash('sha256').update(verifier).digest('base64url') !== row.code_challenge) {
        throw new InvalidGrantError('Invalid S256 PKCE verifier');
      }
      const target = this.resource(row.resource, requested);
      const scopes = this.currentScopes(client, row.scopes as string[]);
      if (tx) await tx.deleteOauthCode(hashToken(code), clientId);
      else await sql`DELETE FROM oauth_codes WHERE code_hash = ${hashToken(code)} AND client_id = ${clientId}`;
      return this.issue(sql, tx, client, scopes, target, true, 'authorization_code');
    });
  }

  async refresh(clientId: string, token: string, requested?: string[], resource?: URL, secretHash?: string): Promise<OAuthTokens> {
    const requestedResource = this.canonicalResource(resource);
    return this.locked(clientId, async (sql, client, tx) => {
      this.assertCredentialPolicy(client, secretHash);
      const row: Record<string, unknown> | undefined = tx ? asRow(await tx.readOauthRefreshTokenForUpdate(hashToken(token), clientId))
        : (await sql`SELECT * FROM oauth_tokens WHERE token_hash = ${hashToken(token)} AND token_type = 'refresh' AND client_id = ${clientId} FOR UPDATE`)[0];
      if (!row) throw new InvalidGrantError('Refresh token not found');
      if (row.expires_at == null || !Number.isFinite(Number(row.expires_at)) || Number(row.expires_at) <= Math.floor(this.now() / 1000)) throw new InvalidGrantError('Refresh token expired');
      const original = Array.isArray(row.scopes) ? row.scopes as string[] : [];
      if (requested?.some(scope => !hasScope(original, scope))) throw new InvalidGrantError('Requested scope exceeds refresh token grant');
      if (requested?.some(scope => !hasScope(parseScopeString(client.scope as string | undefined), scope))) throw new InvalidGrantError('Requested scope exceeds current client grant');
      const scopes = this.currentScopes(client, requested ?? original);
      const target = this.resource(row.resource, requestedResource);
      if (tx) await tx.deleteOauthRefreshToken(hashToken(token), clientId);
      else await sql`DELETE FROM oauth_tokens WHERE token_hash = ${hashToken(token)} AND token_type = 'refresh' AND client_id = ${clientId}`;
      return this.issue(sql, tx, client, scopes, target, true, 'refresh_token');
    });
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
    return this.locked(clientId, async (sql, client, tx) => {
      if (!Array.isArray(client.grant_types) || !client.grant_types.includes('client_credentials')) throw new InvalidGrantError('Client credentials grant not authorized for this client');
      if (typeof client.client_secret_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(client.client_secret_hash) || !safeHexEqual(client.client_secret_hash, hashToken(secret))) throw new InvalidClientError('Invalid client secret');
      this.assertCredentialPolicy(client, client.client_secret_hash);
      return this.issue(sql, tx, client, grantScopes(client, requested ? parseScopeString(requested) : undefined), undefined, false, 'client_credentials');
    });
  }

  async revokeToken(clientId: string, token: string, secretHash?: string): Promise<void> {
    await this.locked(clientId, async (sql, client, tx) => {
      this.assertCredentialPolicy(client, secretHash);
      if (tx) await tx.deleteOauthTokenByHash(hashToken(token), clientId);
      else await sql`DELETE FROM oauth_tokens WHERE token_hash = ${hashToken(token)} AND client_id = ${clientId}`;
    });
  }

  async revokeClient(clientId: string): Promise<void> {
    if (!this.options.transaction) throw new ServerError('OAuth grant transactions are unavailable');
    await this.options.transaction(async (sql, tx) => {
      if (tx) {
        // An engine brain has run its migrations, so the row has `deleted_at`: the revoke is the soft delete.
        if (!await tx.readOauthClientForUpdate(clientId)) return;
        await tx.softDeleteOauthClient(clientId);
        await tx.deleteOauthClientCodes(clientId);
        await tx.deleteOauthClientTokens(clientId);
        return;
      }
      const [row] = await sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId} FOR UPDATE`;
      if (!row) return;
      // Inspect optional schema before the statement; catching a missing column inside a PG transaction aborts it.
      if ('deleted_at' in row) await sql`UPDATE oauth_clients SET deleted_at = now() WHERE client_id = ${clientId}`;
      else await sql`DELETE FROM oauth_clients WHERE client_id = ${clientId}`;
      await sql`DELETE FROM oauth_codes WHERE client_id = ${clientId}`;
      await sql`DELETE FROM oauth_tokens WHERE client_id = ${clientId}`;
    });
  }

  /**
   * GST-359 C1: each token records the grant that issued it (oauth_tokens.grant_type); only client_credentials tokens
   * may attest an actor. grant_type is migration-only (v286, beside oauth_clients.attest_actor), so a schema without it
   * issues unmarked tokens, which never attest. The locked client row tells which: a failed INSERT would abort the
   * surrounding transaction, so the schema is inspected before the statement.
   */
  private async issue(sql: SqlQuery, tx: BrainEngine | undefined, client: ClientRow, scopes: string[], resource: URL | undefined, refresh: boolean, grant: 'authorization_code' | 'refresh_token' | 'client_credentials'): Promise<OAuthTokens> {
    const clientId = client.client_id as string;
    const override = Number(client.token_ttl);
    const ttl = Math.min(Number.isFinite(override) && override > 0 ? override : this.options.tokenTtl, TOKEN_TTL_MAX_SECONDS);
    const now = Math.floor(this.now() / 1000);
    const marked = 'attest_actor' in client;
    const access = generateToken('gbrain_at_');
    const result: OAuthTokens = { access_token: access, token_type: 'bearer', expires_in: ttl, scope: scopes.join(' ') };
    const tokens: Array<{ token: string; type: 'access' | 'refresh'; expiresAt: number }> = [{ token: access, type: 'access', expiresAt: now + ttl }];
    if (refresh) {
      const token = generateToken('gbrain_rt_');
      tokens.push({ token, type: 'refresh', expiresAt: now + this.options.refreshTtl });
      result.refresh_token = token;
    }
    if (tx) {
      // The member runs on the grant's transaction handle (never the pool): the client row is locked by this transaction,
      // and a write on another connection would wait on the foreign key to it. The Rust store runs the rows in one write.
      const rows: OauthTokenInsert[] = tokens.map(t => ({ token_hash: hashToken(t.token), token_type: t.type, client_id: clientId,
        scopes, expires_at: t.expiresAt, resource: resource?.toString() ?? null, created_at: now, ...(marked ? { grant_type: grant } : {}) }));
      await tx.issueOauthTokens(rows);
      return result;
    }
    const insert = (token: string, type: 'access' | 'refresh', expiresAt: number) => marked
      ? sql`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource, created_at, grant_type)
          VALUES (${hashToken(token)}, ${type}, ${clientId}, ${oauthPgArray(scopes)}, ${expiresAt}, ${resource?.toString() ?? null}, to_timestamp(${now}), ${grant})`
      : sql`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource, created_at)
          VALUES (${hashToken(token)}, ${type}, ${clientId}, ${oauthPgArray(scopes)}, ${expiresAt}, ${resource?.toString() ?? null}, to_timestamp(${now}))`;
    for (const t of tokens) await insert(t.token, t.type, t.expiresAt);
    return result;
  }
}
