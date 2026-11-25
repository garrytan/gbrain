/**
 * creds/providers/google — Google OAuth2 client (BYO + relay-minted).
 *
 * Hand-rolled fetch client, no googleapis dependency (house style: see
 * github-source.ts). Everything is fetchImpl-injectable for tests.
 *
 * Flow shapes supported:
 *  - loopback / paste (BYO Desktop-app client) — PKCE S256,
 *    access_type=offline&prompt=consent so a refresh_token is always minted.
 *  - hosted relay (gbrain.io's verified client) — tokens arrive via the
 *    relay claim; refresh routes through the relay (client_ref on the vault
 *    entry decides; see relay-client.ts).
 *
 * invalid_grant is sub-classified into the credential error catalog:
 * clock skew (local clock vs Google's Date response header), the 7-day
 * Testing-mode expiry (age heuristic on last_refresh_ok_at/connected_at),
 * and plain revocation.
 */

import { createHash, randomBytes } from 'node:crypto';

import { CredentialError } from '../errors.ts';
import { grantGeneration, isGrantVault, type CredentialEntry, type CredentialVault, type ProviderClientRecord } from '../vault.ts';
import { refreshViaRelay, relayUrl } from '../relay-client.ts';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export const GOOGLE_PROVIDER = 'google';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
export const GMAIL_SENDAS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs';

/** Service name → scope. All read-only; the connector never writes to Google. */
export const GOOGLE_SERVICE_SCOPES: Record<'gmail' | 'calendar' | 'contacts', string> = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
};

export const GOOGLE_BASE_SCOPES = ['openid', 'email'];

/**
 * The ingest (read-only) profile: every scope gbrain's import, the ingest
 * mint and gwscli read commands may hold in a persisted token. Anything else
 * is treated as write-capable, unknown scopes included.
 */
export const GOOGLE_INGEST_SCOPES: readonly string[] = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/tasks.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
];

/** Identity scopes Google may report back in place of (or beside) openid/email. */
const IDENTITY_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];

const READ_ONLY_SCOPES = new Set([...IDENTITY_SCOPES, ...GOOGLE_INGEST_SCOPES]);

/** The scopes in a set that can change data (everything not read-only). */
export function writeCapableScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => !READ_ONLY_SCOPES.has(s));
}

/** Throws write_scope_refused unless every scope is read-only; the guard in front of every token persist. */
export function assertIngestOnly(scopes: readonly string[], where: string): void {
  const write = writeCapableScopes(scopes);
  if (write.length > 0) throw new CredentialError('write_scope_refused', ` (${where}: ${write.join(', ')})`);
}

/**
 * Google's one-click Personal-mode page: it creates a private Cloud project
 * and a Desktop agent client for the signed-in account, with the Workspace
 * REST and MCP APIs enabled. Only that account can consent with the client.
 */
export function personalModeSetupUrl(account?: string): string {
  const p = new URLSearchParams({ apis: 'ws,wsmcp,tasksmcp', clientType: 'desktop', isAgent: 'true' });
  if (account) p.set('authuser', account);
  return `https://console.cloud.google.com/auth/overview/personal?${p.toString()}`;
}

export function scopesForServices(services: Array<'gmail' | 'calendar' | 'contacts'>): string[] {
  const svc = services.map((s) => GOOGLE_SERVICE_SCOPES[s]);
  return [...GOOGLE_BASE_SCOPES, ...svc];
}

// ── Client-credential intake ─────────────────────────────────────────────────

/** Strip smart quotes, zero-width chars, and whitespace a chat paste picks up. */
export function sanitizePastedValue(v: string): string {
  return v
    .replace(/[‘’“”′″`'"]/g, '')
    .replace(/[​-‍﻿]/g, '')
    .trim();
}

export function looksLikeClientId(v: string): boolean {
  return /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(v);
}

export function looksLikeClientSecret(v: string): boolean {
  // Modern secrets are GOCSPX-…; legacy secrets are 24 opaque chars.
  return /^GOCSPX-[\w-]+$/.test(v) || /^[\w-]{20,}$/.test(v);
}

/** The Google Cloud project NUMBER is the client id's leading digits. */
export function projectNumberFromClientId(clientId: string): string | null {
  const m = clientId.match(/^(\d+)-/);
  return m ? m[1] : null;
}

/** Deep link to enable an API for the client's project. */
export function apiEnableLink(api: 'gmail' | 'calendar-json' | 'people', clientId?: string): string {
  const project = clientId ? projectNumberFromClientId(clientId) : null;
  const base = `https://console.cloud.google.com/apis/library/${api}.googleapis.com`;
  return project ? `${base}?project=${project}` : base;
}

export interface ParsedClientJson {
  client_id: string;
  client_secret: string;
}

/**
 * Parse a downloaded client_secret*.json. Detects the #1 setup mistake — a
 * "Web application" client — at intake, before Google ever gets to error.
 */
export function parseClientJson(raw: string): ParsedClientJson {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new CredentialError('client_json_unreadable', undefined, e);
  }
  if (parsed.web !== undefined) {
    throw new CredentialError('client_json_wrong_type');
  }
  const installed = parsed.installed as Record<string, unknown> | undefined;
  const clientId = sanitizePastedValue(String(installed?.client_id ?? ''));
  const clientSecret = sanitizePastedValue(String(installed?.client_secret ?? ''));
  if (!installed || !looksLikeClientId(clientId) || clientSecret.length === 0) {
    throw new CredentialError('client_json_unreadable');
  }
  return { client_id: clientId, client_secret: clientSecret };
}

/** Validate hand-pasted client credentials (fail fast, at intake). */
export function validateClientPair(clientId: string, clientSecret: string): ParsedClientJson {
  const id = sanitizePastedValue(clientId);
  const secret = sanitizePastedValue(clientSecret);
  if (!looksLikeClientId(id) || !looksLikeClientSecret(secret)) {
    throw new CredentialError('client_shape_invalid');
  }
  return { client_id: id, client_secret: secret };
}

// ── PKCE ─────────────────────────────────────────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): PkcePair {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ── Authorization URL ────────────────────────────────────────────────────────

export interface AuthUrlInput {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  /** Pre-select the account on re-auth so a multi-account browser can't pick the wrong one. */
  loginHint?: string;
}

export function buildAuthUrl(input: AuthUrlInput): string {
  const p = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: input.scopes.join(' '),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    // Always re-prompt: Google only re-issues a refresh_token on a
    // consent-prompted grant; a silent grant would leave us tokenless.
    prompt: 'consent',
    // Never merge earlier grants of this client: the grant gbrain stores is
    // exactly the read-only set it asked for, so a write scope another tool
    // once got from the same client can never ride into the vault.
    include_granted_scopes: 'false',
  });
  if (input.loginHint) p.set('login_hint', input.loginHint);
  return `${GOOGLE_AUTH_URL}?${p.toString()}`;
}

// ── Token endpoint ───────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
}

interface TokenErrorBody {
  error?: string;
  error_description?: string;
}

/** Clock-skew check: local clock vs the Date header Google sent. */
function clockSkewMs(res: Response): number | null {
  const date = res.headers.get('date');
  if (!date) return null;
  const serverMs = Date.parse(date);
  if (!Number.isFinite(serverMs)) return null;
  return Date.now() - serverMs;
}

const CLOCK_SKEW_LIMIT_MS = 60_000;

async function postToken(
  params: Record<string, string>,
  fetchImpl: FetchImpl,
): Promise<{ res: Response; body: TokenResponse & TokenErrorBody }> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse & TokenErrorBody;
  return { res, body };
}

export interface ExchangeInput {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export async function exchangeCode(
  input: ExchangeInput,
  fetchImpl: FetchImpl = fetch,
): Promise<TokenResponse> {
  const { res, body } = await postToken(
    {
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: input.codeVerifier,
    },
    fetchImpl,
  );
  if (!res.ok) {
    const err = body.error ?? '';
    if (err === 'invalid_client') throw new CredentialError('invalid_client');
    if (err === 'invalid_grant') {
      const skew = clockSkewMs(res);
      if (skew !== null && Math.abs(skew) > CLOCK_SKEW_LIMIT_MS) {
        throw new CredentialError('invalid_grant_clock_skew', `${Math.round(skew / 1000)}s`);
      }
      // An auth code is single-use and short-lived; on exchange, invalid_grant
      // is almost always reuse or expiry of the code itself.
      throw new CredentialError('code_reused', undefined, body.error_description);
    }
    if (err === 'redirect_uri_mismatch') throw new CredentialError('redirect_uri_mismatch');
    if (isClientUserMismatch(body)) throw new CredentialError('client_user_mismatch');
    throw new CredentialError('upstream', `: token exchange HTTP ${res.status} ${err}`.trimEnd());
  }
  if (!body.refresh_token) throw new CredentialError('no_refresh_token');
  return body;
}

/** Days since the newest proof-of-life on the entry; drives the Testing-expiry heuristic. */
export function daysSinceLastProofOfLife(entry: CredentialEntry, now: Date = new Date()): number {
  const anchor = entry.meta.last_refresh_ok_at ?? entry.meta.connected_at;
  const anchorMs = Date.parse(anchor);
  if (!Number.isFinite(anchorMs)) return 0;
  return (now.getTime() - anchorMs) / 86_400_000;
}

const TESTING_EXPIRY_MIN_DAYS = 6;
const PERSONAL_CONFIRM_DAYS = 7;

function isClientUserMismatch(body: TokenErrorBody): boolean {
  return body.error === 'client_user_mismatch' || /client_user_mismatch/i.test(body.error_description ?? '');
}

/**
 * The scope subset a refresh asks for: only when the grant on file holds a
 * write-capable scope, the refresh requests the grant's read-only part
 * (RFC 6749 §6 downscoping), so a persisted token is ingest-only whether or
 * not Google narrows it; the caller still checks what Google returned.
 */
export function refreshScopeFor(entry: CredentialEntry): string | undefined {
  const granted = entry.meta.scopes ?? [];
  if (writeCapableScopes(granted).length === 0) return undefined;
  const readOnly = granted.filter((s) => READ_ONLY_SCOPES.has(s));
  return readOnly.length > 0 ? readOnly.join(' ') : undefined;
}

export async function refreshAccessToken(
  entry: CredentialEntry,
  client: ProviderClientRecord,
  fetchImpl: FetchImpl = fetch,
  now: Date = new Date(),
  scope: string | undefined = refreshScopeFor(entry),
): Promise<TokenResponse> {
  if (!entry.secret.refresh_token) throw new CredentialError('not_connected', ` for ${entry.id}`);
  const { res, body } = await postToken(
    {
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: entry.secret.refresh_token,
      grant_type: 'refresh_token',
      ...(scope ? { scope } : {}),
    },
    fetchImpl,
  );
  if (!res.ok) {
    const err = body.error ?? '';
    if (err === 'invalid_client') throw new CredentialError('invalid_client');
    if (err === 'invalid_grant') {
      const skew = clockSkewMs(res);
      if (skew !== null && Math.abs(skew) > CLOCK_SKEW_LIMIT_MS) {
        throw new CredentialError('invalid_grant_clock_skew', `${Math.round(skew / 1000)}s`);
      }
      if (isClientUserMismatch(body)) throw new CredentialError('client_user_mismatch');
      // A Personal-mode client never expires weekly, but the flag alone is
      // not proof (the console project's user type is unreadable): the
      // Testing-expiry reading stays until a refresh 7+ days after consent
      // has succeeded.
      const provenPersonal = entry.meta.client_mode === 'personal' && entry.meta.personal_confirmed_at !== undefined;
      if (
        !provenPersonal &&
        entry.meta.consent_publish_state !== 'production' &&
        daysSinceLastProofOfLife(entry, now) >= TESTING_EXPIRY_MIN_DAYS
      ) {
        throw new CredentialError('invalid_grant_testing_expiry');
      }
      throw new CredentialError('invalid_grant_revoked');
    }
    throw new CredentialError('upstream', `: token refresh HTTP ${res.status} ${err}`.trimEnd());
  }
  return body;
}

// ── Identity fetches ─────────────────────────────────────────────────────────

export async function fetchUserinfoEmail(
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string> {
  const res = await fetchImpl(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new CredentialError('upstream', `: userinfo HTTP ${res.status}`);
  const body = (await res.json()) as { email?: string };
  if (!body.email) throw new CredentialError('upstream', ': userinfo returned no email');
  return body.email.toLowerCase();
}

/** The scopes Google says an access token carries (tokeninfo; the token goes in the POST body, never a URL). */
export async function fetchTokenScopes(accessToken: string, fetchImpl: FetchImpl = fetch): Promise<string[]> {
  const res = await fetchImpl(GOOGLE_TOKENINFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ access_token: accessToken }).toString(),
  });
  if (!res.ok) throw new CredentialError('upstream', `: tokeninfo HTTP ${res.status}`);
  const body = (await res.json()) as { scope?: string };
  return (body.scope ?? '').split(/\s+/).filter(Boolean);
}

/**
 * The effective scopes of a token response: Google's own `scope` field, or
 * tokeninfo when the response omits it and `mustConfirm` is set (else the
 * grant recorded at consent, which a token can never exceed).
 */
export async function effectiveScopes(token: TokenResponse, fetchImpl: FetchImpl, fallback: readonly string[], mustConfirm: boolean): Promise<string[]> {
  const listed = token.scope?.split(/\s+/).filter(Boolean) ?? [];
  if (listed.length > 0) return listed;
  if (mustConfirm) return fetchTokenScopes(token.access_token, fetchImpl);
  return [...fallback];
}

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const ID_TOKEN_SKEW_MS = 300_000;

/**
 * The account an ID token names, after checking its claims: issuer, audience
 * (our client), expiry, and a verified email. The token came straight from
 * Google's token endpoint over TLS, which OpenID Connect Core 3.1.3.7 accepts
 * in place of a signature check. Throws identity_unproven on any mismatch.
 */
export function verifyIdTokenClaims(idToken: string, clientId: string, nowMs: number = Date.now()): string {
  const parts = idToken.split('.');
  let claims: Record<string, unknown>;
  try {
    if (parts.length !== 3) throw new Error('not a JWT');
    claims = JSON.parse(Buffer.from(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')) as Record<string, unknown>;
  } catch {
    throw new CredentialError('identity_unproven', ' (the ID token is unreadable)');
  }
  const aud = claims.aud;
  const audOk = typeof aud === 'string' ? aud === clientId : Array.isArray(aud) && aud.includes(clientId);
  if (!GOOGLE_ISSUERS.has(String(claims.iss))) throw new CredentialError('identity_unproven', ' (the ID token is not from Google)');
  if (!audOk) throw new CredentialError('identity_unproven', ' (the ID token was issued to a different client)');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 + ID_TOKEN_SKEW_MS < nowMs) throw new CredentialError('identity_unproven', ' (the ID token has expired)');
  if (typeof claims.email !== 'string' || claims.email.length === 0) throw new CredentialError('identity_unproven', ' (the ID token carries no email)');
  if (claims.email_verified === false || claims.email_verified === 'false') throw new CredentialError('identity_unproven', ' (the ID token email is not verified)');
  return claims.email.toLowerCase();
}

/**
 * Proves which account a fresh grant belongs to: a valid ID token when Google
 * sent one, else the OpenID userinfo answer for the access token.
 */
export async function proveGrantIdentity(token: TokenResponse, clientId: string | undefined, fetchImpl: FetchImpl = fetch): Promise<string> {
  if (token.id_token && clientId) return verifyIdTokenClaims(token.id_token, clientId);
  try {
    return await fetchUserinfoEmail(token.access_token, fetchImpl);
  } catch (e) {
    throw new CredentialError('identity_unproven', ' (no ID token and the userinfo read failed)', e);
  }
}

/** Best-effort: sendAs aliases are readable under gmail.readonly. */
export async function fetchSendAsAliases(
  accessToken: string,
  fetchImpl: FetchImpl = fetch,
): Promise<string[]> {
  try {
    const res = await fetchImpl(GMAIL_SENDAS_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { sendAs?: Array<{ sendAsEmail?: string }> };
    return (body.sendAs ?? [])
      .map((s) => (s.sendAsEmail ?? '').toLowerCase())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

// ── Token provider (the AppTokenProvider pattern, vault-persisted) ──────────

const EXPIRY_MARGIN_MS = 5 * 60_000;
function tokenStillFresh(e: CredentialEntry): boolean {
  const expMs = e.secret.expiry ? Date.parse(e.secret.expiry) : 0;
  return !!e.secret.access_token && Number.isFinite(expMs) && expMs - EXPIRY_MARGIN_MS > Date.now();
}

/**
 * Hands out a live access token for one vault entry, refreshing before
 * expiry and persisting rotations back to the vault. Routes refresh by
 * client_ref: byo entries hit Google directly with the client record that
 * minted them (selected by the entry's client_id); hosted-relay entries
 * refresh through the gbrain.io relay (the confidential client's secret
 * never leaves the server).
 *
 * Custody (GST-3849): a persisted access token is read-only. A refresh whose
 * effective scopes include a write-capable scope is never written, and every
 * write is a compare-and-swap on the grant generation it read, so a refresh
 * that loses a race with a disconnect or reconnect cannot write back.
 */
export class GoogleTokenProvider {
  constructor(
    private readonly vault: CredentialVault,
    private readonly credentialIdValue: string,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  async entry(): Promise<CredentialEntry> {
    const e = await this.vault.get(this.credentialIdValue);
    if (!e) throw new CredentialError('not_connected', ` for ${this.credentialIdValue}`);
    return e;
  }

  async getAccessToken(): Promise<string> {
    const e = await this.entry();
    // A token stored before GST-3849 under a grant that holds a write scope may
    // itself be write-capable; it is refreshed (read-only) instead of handed out.
    const trusted = e.meta.access_token_read_only === true || writeCapableScopes(e.meta.scopes ?? []).length === 0;
    if (trusted && tokenStillFresh(e)) return e.secret.access_token!;
    return this.forceRefresh();
  }

  forceRefresh(): Promise<string> {
    return this.refreshOnce();
  }

  /** The client that minted this entry's tokens; never a different one. */
  private async clientFor(e: CredentialEntry): Promise<ProviderClientRecord> {
    if (isGrantVault(this.vault) && e.meta.client_id) {
      const byId = await this.vault.getClientById(GOOGLE_PROVIDER, e.meta.client_id, e.meta.account);
      if (!byId) throw new CredentialError('client_record_mismatch', ` for ${e.id}`);
      if (byId.account && byId.account !== (e.meta.account ?? '').toLowerCase()) {
        throw new CredentialError('client_record_mismatch', ` for ${e.id} (the client on file belongs to another account)`);
      }
      return byId;
    }
    const client = await this.vault.getClient(GOOGLE_PROVIDER);
    if (!client) throw new CredentialError('not_connected', ` (no OAuth client on file)`);
    return client;
  }

  private async refreshOnce(): Promise<string> {
    const start = await this.entry();
    let generation = grantGeneration(start) ?? 0;
    const release = isGrantVault(this.vault) && this.vault.leaseRefresh
      ? await this.vault.leaseRefresh(this.credentialIdValue, generation)
      : null;
    try {
      // Another process may have refreshed while this one waited for the lease.
      const e = release ? await this.entry() : start;
      if (release && grantGeneration(e) === generation && tokenStillFresh(e) && e.secret.access_token !== start.secret.access_token) {
        return e.secret.access_token!;
      }
      // A reconnect may have committed a new grant while this call waited: refresh
      // that grant, and write back against its generation, not the one read before.
      generation = grantGeneration(e) ?? 0;
      let token: TokenResponse;
      if (e.client_ref === 'hosted-relay') {
        const base = relayUrl();
        if (!base) throw new CredentialError('relay_disabled');
        token = await refreshViaRelay(base, e, this.fetchImpl);
      } else {
        token = await refreshAccessToken(e, await this.clientFor(e), this.fetchImpl);
      }
      const granted = e.meta.scopes ?? [];
      const mustConfirm = e.meta.client_mode === 'personal' || writeCapableScopes(granted).length > 0;
      assertIngestOnly(await effectiveScopes(token, this.fetchImpl, granted, mustConfirm), 'refreshed token');
      const now = new Date();
      const nowIso = now.toISOString();
      const confirm = e.meta.client_mode === 'personal' && !e.meta.personal_confirmed_at &&
        (now.getTime() - Date.parse(e.meta.connected_at)) / 86_400_000 >= PERSONAL_CONFIRM_DAYS;
      const secret = {
        access_token: token.access_token,
        expiry: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        // Google may rotate the refresh token; persist the new one.
        ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
      };
      const meta = { last_refresh_ok_at: nowIso, access_token_read_only: true, ...(confirm ? { personal_confirmed_at: nowIso } : {}) };
      if (isGrantVault(this.vault)) {
        await this.vault.casUpdateTokens(this.credentialIdValue, generation, { secret, meta });
        return token.access_token;
      }
      // Vaults without compare-and-swap: re-read and merge only the token
      // fields into the FRESH entry, so a concurrent reconnect or disconnect
      // is neither reverted nor resurrected.
      const fresh = await this.vault.get(this.credentialIdValue);
      if (!fresh) throw new CredentialError('not_connected', ` for ${this.credentialIdValue} (removed mid-refresh)`);
      if (grantGeneration(fresh) !== generation) throw new CredentialError('vault_generation_changed', ` for ${this.credentialIdValue}`);
      await this.vault.put({ ...fresh, secret: { ...fresh.secret, ...secret }, meta: { ...fresh.meta, ...meta } });
      return token.access_token;
    } finally {
      release?.();
    }
  }
}
