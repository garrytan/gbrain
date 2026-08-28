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
import type { CredentialEntry, CredentialVault, ProviderClientRecord } from '../vault.ts';
import { refreshViaRelay, relayUrl } from '../relay-client.ts';

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export const GOOGLE_PROVIDER = 'google';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
export const GMAIL_SENDAS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs';

/** Service name → scope. All read-only; the connector never writes to Google. */
export const GOOGLE_SERVICE_SCOPES: Record<'gmail' | 'calendar' | 'contacts', string> = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  contacts: 'https://www.googleapis.com/auth/contacts.readonly',
};

export const GOOGLE_BASE_SCOPES = ['openid', 'email'];

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
    // Incremental auth: keep previously granted scopes on re-consent.
    include_granted_scopes: 'true',
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

export async function refreshAccessToken(
  entry: CredentialEntry,
  client: ProviderClientRecord,
  fetchImpl: FetchImpl = fetch,
  now: Date = new Date(),
): Promise<TokenResponse> {
  if (!entry.secret.refresh_token) throw new CredentialError('not_connected', ` for ${entry.id}`);
  const { res, body } = await postToken(
    {
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: entry.secret.refresh_token,
      grant_type: 'refresh_token',
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
      if (
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

/**
 * Hands out a live access token for one vault entry, refreshing before
 * expiry and persisting rotations back to the vault. Routes refresh by
 * client_ref: byo entries hit Google directly with the stored client
 * credentials; hosted-relay entries refresh through the gbrain.io relay
 * (the confidential client's secret never leaves the server).
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
    const expMs = e.secret.expiry ? Date.parse(e.secret.expiry) : 0;
    if (e.secret.access_token && Number.isFinite(expMs) && expMs - EXPIRY_MARGIN_MS > Date.now()) {
      return e.secret.access_token;
    }
    return this.forceRefresh();
  }

  async forceRefresh(): Promise<string> {
    const e = await this.entry();
    let token: TokenResponse;
    if (e.client_ref === 'hosted-relay') {
      const base = relayUrl();
      if (!base) throw new CredentialError('relay_disabled');
      token = await refreshViaRelay(base, e, this.fetchImpl);
    } else {
      const client = await this.vault.getClient(GOOGLE_PROVIDER);
      if (!client) throw new CredentialError('not_connected', ` (no OAuth client on file)`);
      token = await refreshAccessToken(e, client, this.fetchImpl);
    }
    const nowIso = new Date().toISOString();
    // RE-READ before persisting: the network round-trip is long enough for a
    // concurrent connect/disconnect to have changed the entry. Merging only
    // the token fields into the FRESH entry prevents (a) reverting a
    // re-connect's new scopes/refresh_token with this stale spread and
    // (b) resurrecting a credential the user just disconnected.
    const fresh = await this.vault.get(this.credentialIdValue);
    if (!fresh) throw new CredentialError('not_connected', ` for ${this.credentialIdValue} (removed mid-refresh)`);
    const updated: CredentialEntry = {
      ...fresh,
      secret: {
        ...fresh.secret,
        access_token: token.access_token,
        expiry: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        // Google may rotate the refresh token; persist the new one.
        ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
      },
      meta: { ...fresh.meta, last_refresh_ok_at: nowIso },
    };
    await this.vault.put(updated);
    return token.access_token;
  }
}
