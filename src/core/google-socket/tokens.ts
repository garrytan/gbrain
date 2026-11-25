/**
 * Tokens for the socket. `mint` hands out read-only access tokens from an
 * in-memory cache keyed by (account, profile, scopes, grant generation); a
 * minted token is never written to the vault, so sync's own token slot is
 * untouched. The broker's write-capable token is refreshed the same way and
 * lives only in this process's memory. Each refresh runs under the vault's
 * per-grant refresh lease, and a refresh token Google rotates is written back
 * compare-and-swap on the generation it was read under.
 */
import { CredentialError } from '../creds/errors.ts';
import {
  GOOGLE_BASE_SCOPES, GOOGLE_INGEST_SCOPES, GOOGLE_PROVIDER, assertIngestOnly, effectiveScopes, refreshAccessToken, writeCapableScopes,
  type FetchImpl, type TokenResponse,
} from '../creds/providers/google.ts';
import { credentialId, grantGeneration, isGrantVault, type CredentialEntry, type CredentialVault, type ProviderClientRecord } from '../creds/vault.ts';
import { SocketError, type SocketErrorCode } from './protocol.ts';

const REMINT_MARGIN_MS = 5 * 60_000;

export interface MintedToken { access_token: string; expires_at: string; scopes: string[]; account: string }
export interface ActToken { token: string; generation: number; client_id: string; account: string }

interface Cached { token: string; expiresAtMs: number; scopes: string[]; generation: number }

/** Maps a credential failure onto the socket's codes. */
export function socketCodeFor(error: unknown): SocketError {
  if (error instanceof SocketError) return error;
  if (error instanceof CredentialError) {
    const map: Partial<Record<string, SocketErrorCode>> = {
      not_connected: 'not_connected', no_refresh_token: 'not_connected', invalid_grant_revoked: 'revoked', invalid_grant_testing_expiry: 'revoked',
      client_user_mismatch: 'client_user_mismatch', write_scope_refused: 'write_scope_refused', client_record_mismatch: 'not_connected',
      invalid_client: 'revoked', rate_limited: 'rate_limited',
    };
    return new SocketError(map[error.code] ?? 'upstream', error.message);
  }
  return new SocketError('internal', (error as Error)?.message ?? 'unexpected failure');
}

export class SocketTokens {
  private readonly ingest = new Map<string, Cached>();
  private readonly act = new Map<string, Cached & { client_id: string }>();

  constructor(private readonly vault: CredentialVault, private readonly fetchImpl: FetchImpl = fetch, private readonly now: () => number = Date.now) {}

  private async entry(account: string): Promise<CredentialEntry> {
    const e = await this.vault.get(credentialId(GOOGLE_PROVIDER, account));
    if (!e) throw new SocketError('not_connected', `no Google connection for ${account}`);
    if (e.client_ref === 'hosted-relay') throw new SocketError('client_not_agent', `${account} is connected through the hosted relay, whose client secret never leaves gbrain.io; connect it with its own client (gbrain google setup --personal)`);
    return e;
  }

  private async clientFor(e: CredentialEntry): Promise<ProviderClientRecord> {
    const client = isGrantVault(this.vault) && e.meta.client_id
      ? await this.vault.getClientById(GOOGLE_PROVIDER, e.meta.client_id, e.meta.account)
      : await this.vault.getClient(GOOGLE_PROVIDER);
    if (!client) throw new SocketError('not_connected', `no OAuth client on file for ${e.meta.account}`);
    return client;
  }

  /** One refresh for an explicit scope set, under the refresh lease; persists only a rotated refresh token. */
  private async refresh(e: CredentialEntry, scope: string[]): Promise<{ token: TokenResponse; generation: number; client: ProviderClientRecord }> {
    const release = isGrantVault(this.vault) && this.vault.leaseRefresh ? await this.vault.leaseRefresh(e.id, grantGeneration(e) ?? 0) : null;
    try {
      const current = await this.vault.get(e.id);
      if (!current) throw new SocketError('not_connected', `the Google connection for ${e.meta.account} was removed`);
      e = current;
      const generation = grantGeneration(e) ?? 0;
      const client = await this.clientFor(e);
      const token = await refreshAccessToken(e, client, this.fetchImpl, new Date(this.now()), scope.join(' '));
      const after = await this.vault.get(e.id);
      if (!after || (grantGeneration(after) ?? 0) !== generation) {
        throw new SocketError('not_connected', `the Google connection for ${e.meta.account} was removed or replaced during the refresh; call again`);
      }
      if (token.refresh_token && isGrantVault(this.vault)) {
        await this.vault.casUpdateTokens(e.id, generation, { secret: { refresh_token: token.refresh_token }, meta: {} });
      }
      return { token, generation, client };
    } finally {
      release?.();
    }
  }

  async mintIngest(account: string): Promise<MintedToken> {
    try {
      const e = await this.entry(account);
      const generation = grantGeneration(e) ?? 0;
      const granted = e.meta.scopes ?? [];
      const ingest = granted.filter(s => GOOGLE_INGEST_SCOPES.includes(s));
      if (ingest.length === 0) throw new SocketError('insufficient_scope', `${account} was never consented for a read-only Google scope`);
      const scope = [...GOOGLE_BASE_SCOPES.filter(s => granted.includes(s)), ...ingest];
      const key = `${account}\u0000ingest\u0000${scope.join(' ')}`;
      const hit = this.ingest.get(key);
      if (hit && hit.generation === generation && hit.expiresAtMs - REMINT_MARGIN_MS > this.now()) {
        return { access_token: hit.token, expires_at: new Date(hit.expiresAtMs).toISOString(), scopes: hit.scopes, account };
      }
      const { token, generation: refreshed } = await this.refresh(e, scope);
      const scopes = await effectiveScopes(token, this.fetchImpl, scope, true);
      if (scopes.length === 0) throw new SocketError('write_scope_refused', 'Google did not confirm the scopes of the minted token, so it was not handed out');
      assertIngestOnly(scopes, 'minted token');
      const expiresAtMs = this.now() + token.expires_in * 1000;
      this.ingest.set(key, { token: token.access_token, expiresAtMs, scopes, generation: refreshed });
      return { access_token: token.access_token, expires_at: new Date(expiresAtMs).toISOString(), scopes, account };
    } catch (error) {
      throw socketCodeFor(error);
    }
  }

  /** The broker's write-capable token: never returned over the socket, never persisted. */
  async actToken(account: string): Promise<ActToken> {
    try {
      const e = await this.entry(account);
      const generation = grantGeneration(e) ?? 0;
      const granted = e.meta.scopes ?? [];
      if (writeCapableScopes(granted).length === 0) {
        throw new SocketError('insufficient_scope', `${account} holds read-only scopes only; write scopes are added by incremental consent when the broker goes live`);
      }
      const hit = this.act.get(account);
      if (hit && hit.generation === generation && hit.expiresAtMs - REMINT_MARGIN_MS > this.now()) {
        return { token: hit.token, generation, client_id: hit.client_id, account };
      }
      const { token, client, generation: refreshed } = await this.refresh(e, granted);
      const expiresAtMs = this.now() + token.expires_in * 1000;
      this.act.set(account, { token: token.access_token, expiresAtMs, scopes: granted, generation: refreshed, client_id: client.client_id });
      return { token: token.access_token, generation: refreshed, client_id: client.client_id, account };
    } catch (error) {
      throw socketCodeFor(error);
    }
  }

  /** The vault generation now, so a held write can be checked against the grant it was prompted under. */
  async generationOf(account: string): Promise<number | null> {
    return grantGeneration(await this.vault.get(credentialId(GOOGLE_PROVIDER, account)));
  }

  dropAct(account: string): void { this.act.delete(account); }
}
