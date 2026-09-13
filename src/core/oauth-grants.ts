/** OAuth grant lifecycle. Every grant mutation locks the same client row. */
import { createHash } from 'node:crypto';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientError, InvalidGrantError, InvalidRequestError, ServerError, TooManyRequestsError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { SqlQuery } from './sql-query.ts';
import { generateToken, hashToken } from './utils.ts';
import { hasScope, parseScopeString } from './scope.ts';
import { intersectGrantedScopes } from './grants/model.ts';
import { safeHexEqual } from './timing-safe.ts';

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

/** Compare policy, not a mutable reference or only the display name. */
function policyDigest(row: ClientRow): string {
  const fields = ['client_id', 'client_name', 'redirect_uris', 'grant_types', 'scope',
    'client_secret_hash', 'token_endpoint_auth_method', 'client_secret_expires_at',
    'source_id', 'federated_read', 'bound_tools', 'bound_source_id', 'bound_brain_id',
    'bound_slug_prefixes', 'bound_max_concurrent', 'budget_usd_per_day', 'surface', 'token_ttl',
    'allowed_operations', 'delegated_slug_prefixes', 'delegated_namespace', 'grant_profile',
    'grant_revision', 'grant_repair_reasons'];
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

export class OAuthGrants {
  private readonly pending = new Map<string, PendingAuthorization>();
  constructor(private readonly options: {
    sql: SqlQuery;
    transaction?: OAuthTransaction;
    tokenTtl: number;
    refreshTtl: number;
    now?: () => number;
  }) {}

  private now(): number { return (this.options.now ?? Date.now)(); }
  private async locked<T>(clientId: string, fn: (sql: SqlQuery, row: ClientRow) => Promise<T>): Promise<T> {
    if (!this.options.transaction) throw new ServerError('OAuth grant transactions are unavailable');
    return this.options.transaction(async sql => {
      const [row] = await sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId} FOR UPDATE`;
      assertActive(row);
      return fn(sql, row);
    });
  }

  private prune(): void {
    const now = this.now();
    for (const [id, pending] of this.pending) {
      if (pending.details.expiresAt <= now) this.pending.delete(id);
    }
  }

  async begin(clientId: string, params: AuthorizationParams): Promise<string> {
    this.prune();
    if (this.pending.size >= 1000) throw new TooManyRequestsError('Too many pending requests. Try again shortly.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidRequestError('S256 PKCE challenge required');
    const [row] = await this.options.sql`SELECT * FROM oauth_clients WHERE client_id = ${clientId}`;
    assertActive(row);
    if (!Array.isArray(row.grant_types) || !row.grant_types.includes('authorization_code')) {
      throw new InvalidClientError('Authorization code grant not authorized for this client');
    }
    if (!Array.isArray(row.redirect_uris) || !row.redirect_uris.some(uri => typeof uri === 'string' && redirectUriMatches(params.redirectUri, uri))) {
      throw new InvalidRequestError('Redirect URI does not match registered client');
    }
    // No await between the capacity check and insert: concurrent DB reads cannot overfill the store.
    this.prune();
    if (this.pending.size >= 1000) throw new TooManyRequestsError('Too many pending requests. Try again shortly.');
    const id = generateToken('');
    const details: OAuthConsentDetails = {
      id, clientId, clientName: typeof row.client_name === 'string' ? row.client_name : clientId,
      redirectUri: params.redirectUri, scopes: grantScopes(row, params.scopes),
      sourceId: typeof row.source_id === 'string' ? row.source_id : null,
      allowedSources: Array.isArray(row.federated_read) ? [...row.federated_read] as string[] : [],
      allowedOperations: Array.isArray(row.allowed_operations) ? [...row.allowed_operations] as string[] : null,
      boundSlugPrefixes: Array.isArray(row.bound_slug_prefixes) ? [...row.bound_slug_prefixes] as string[] : null,
      delegatedTools: Array.isArray(row.bound_tools) ? [...row.bound_tools] as string[] : null,
      delegatedSlugPrefixes: Array.isArray(row.delegated_slug_prefixes) ? [...row.delegated_slug_prefixes] as string[] : null,
      delegatedNamespace: typeof row.delegated_namespace === 'string' ? row.delegated_namespace : null,
      resource: params.resource?.toString() ?? null, expiresAt: this.now() + 10 * 60_000,
    };
    this.pending.set(id, {
      details, params: { ...params, scopes: [...details.scopes], resource: params.resource ? new URL(params.resource) : undefined },
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

  async decide(id: string, approve: boolean): Promise<string> {
    this.details(id);
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
      const target = this.resource(row.resource, resource);
      const scopes = this.currentScopes(client, row.scopes as string[]);
      await sql`DELETE FROM oauth_codes WHERE code_hash = ${hashToken(code)} AND client_id = ${clientId}`;
      return this.issue(sql, client, scopes, target, true);
    });
  }

  async refresh(clientId: string, token: string, requested?: string[], resource?: URL, secretHash?: string): Promise<OAuthTokens> {
    return this.locked(clientId, async (sql, client) => {
      this.assertCredentialPolicy(client, secretHash);
      const [row] = await sql`SELECT * FROM oauth_tokens WHERE token_hash = ${hashToken(token)} AND token_type = 'refresh' AND client_id = ${clientId} FOR UPDATE`;
      if (!row) throw new InvalidGrantError('Refresh token not found');
      if (row.expires_at == null || !Number.isFinite(Number(row.expires_at)) || Number(row.expires_at) <= Math.floor(this.now() / 1000)) throw new InvalidGrantError('Refresh token expired');
      const original = Array.isArray(row.scopes) ? row.scopes as string[] : [];
      if (requested?.some(scope => !hasScope(original, scope))) throw new InvalidGrantError('Requested scope exceeds refresh token grant');
      if (requested?.some(scope => !hasScope(parseScopeString(client.scope as string | undefined), scope))) throw new InvalidGrantError('Requested scope exceeds current client grant');
      const scopes = this.currentScopes(client, requested ?? original);
      const target = this.resource(row.resource, resource);
      await sql`DELETE FROM oauth_tokens WHERE token_hash = ${hashToken(token)} AND token_type = 'refresh' AND client_id = ${clientId}`;
      return this.issue(sql, client, scopes, target, true);
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

  private resource(stored: unknown, requested?: URL): URL | undefined {
    if (typeof stored === 'string' && stored) {
      if (requested && requested.toString() !== stored) throw new InvalidGrantError('Requested resource exceeds the approved grant');
      return new URL(stored);
    }
    return requested; // pre-resource grants remain valid on upgrade
  }

  async clientCredentials(clientId: string, secret: string, requested?: string): Promise<OAuthTokens> {
    return this.locked(clientId, async (sql, client) => {
      if (!Array.isArray(client.grant_types) || !client.grant_types.includes('client_credentials')) throw new InvalidGrantError('Client credentials grant not authorized for this client');
      if (typeof client.client_secret_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(client.client_secret_hash) || !safeHexEqual(client.client_secret_hash, hashToken(secret))) throw new InvalidClientError('Invalid client secret');
      this.assertCredentialPolicy(client, client.client_secret_hash);
      return this.issue(sql, client, grantScopes(client, requested ? parseScopeString(requested) : undefined), undefined, false);
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
    });
  }

  private async issue(sql: SqlQuery, client: ClientRow, scopes: string[], resource: URL | undefined, refresh: boolean): Promise<OAuthTokens> {
    const clientId = client.client_id as string;
    const override = Number(client.token_ttl);
    const ttl = Number.isFinite(override) && override > 0 ? override : this.options.tokenTtl;
    const now = Math.floor(this.now() / 1000);
    const access = generateToken('gbrain_at_');
    await sql`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
      VALUES (${hashToken(access)}, ${'access'}, ${clientId}, ${oauthPgArray(scopes)}, ${now + ttl}, ${resource?.toString() ?? null})`;
    const result: OAuthTokens = { access_token: access, token_type: 'bearer', expires_in: ttl, scope: scopes.join(' ') };
    if (refresh) {
      const token = generateToken('gbrain_rt_');
      await sql`INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
        VALUES (${hashToken(token)}, ${'refresh'}, ${clientId}, ${oauthPgArray(scopes)}, ${now + this.options.refreshTtl}, ${resource?.toString() ?? null})`;
      result.refresh_token = token;
    }
    return result;
  }
}
