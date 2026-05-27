import { createHash, randomBytes } from 'crypto';
import { redactTokenLike, type OpenAICodexTokenRecord, type TokenStore } from './token-store.ts';

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export async function createPkcePair(randomSource: () => Uint8Array = () => randomBytes(32)): Promise<PkcePair> {
  const verifier = base64Url(randomSource());
  const challenge = createHash('sha256').update(verifier).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return { verifier, challenge, method: 'S256' };
}

export interface BuildAuthorizationUrlOptions {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopes: string[];
  extraParams?: Record<string, string>;
}

export function buildAuthorizationUrl(opts: BuildAuthorizationUrlOptions): URL {
  const url = new URL(opts.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', opts.scopes.join(' '));
  for (const [key, value] of Object.entries(opts.extraParams ?? {})) {
    url.searchParams.set(key, value);
  }
  return url;
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

export function parseOAuthCallback(callbackUrl: string, expectedState: string): { code: string } {
  const url = new URL(callbackUrl);
  if (!isLoopback(url.hostname)) {
    throw new Error('OAuth callback must be bound to a loopback host.');
  }
  const state = url.searchParams.get('state');
  if (!state || state !== expectedState) {
    throw new Error('OAuth callback state mismatch.');
  }
  const oauthError = url.searchParams.get('error');
  if (oauthError) {
    throw new Error(`OAuth callback returned error: ${redactTokenLike(oauthError)}`);
  }
  const code = url.searchParams.get('code');
  if (!code) throw new Error('OAuth callback missing authorization code.');
  return { code };
}

function accountIdFromAccessToken(accessToken: string): string | undefined {
  try {
    const part = accessToken.split('.')[1];
    if (!part) return undefined;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as Record<string, unknown>;
    const auth = payload['https://api.openai.com/auth'];
    if (!auth || typeof auth !== 'object') return undefined;
    const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

function toTokenRecord(json: unknown, now: Date, fallbackRefreshToken?: string): OpenAICodexTokenRecord {
  if (!json || typeof json !== 'object') throw new Error('OAuth token response must be an object');
  const v = json as Record<string, unknown>;
  if (typeof v.access_token !== 'string' || v.access_token.length === 0) throw new Error('OAuth token response missing access_token');
  const expiresIn = typeof v.expires_in === 'number' ? v.expires_in : 3600;
  const accountId = typeof v.account_id === 'string' ? v.account_id : accountIdFromAccessToken(v.access_token);
  return {
    access_token: v.access_token,
    refresh_token: typeof v.refresh_token === 'string' ? v.refresh_token : fallbackRefreshToken,
    expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    token_type: typeof v.token_type === 'string' ? v.token_type : 'Bearer',
    ...(typeof v.scope === 'string' ? { scope: v.scope } : {}),
    ...(accountId ? { account_id: accountId } : {}),
  };
}

async function parseTokenResponse(resp: Response, now: Date, fallbackRefreshToken?: string): Promise<OpenAICodexTokenRecord> {
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`OAuth token endpoint failed with HTTP ${resp.status}: ${redactTokenLike(text)}`);
  }
  try {
    return toTokenRecord(JSON.parse(text), now, fallbackRefreshToken);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`OAuth token response invalid: ${redactTokenLike(msg)}`);
  }
}

export interface ExchangeAuthorizationCodeOptions {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  now?: () => Date;
  fetch?: FetchLike;
}

export async function exchangeAuthorizationCode(opts: ExchangeAuthorizationCodeOptions): Promise<OpenAICodexTokenRecord> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    redirect_uri: opts.redirectUri,
  });
  const fetchImpl = opts.fetch ?? fetch;
  const resp = await fetchImpl(opts.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return parseTokenResponse(resp, opts.now?.() ?? new Date());
}

export interface RefreshOpenAICodexTokenOptions {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  now?: () => Date;
  fetch?: FetchLike;
}

export async function refreshOpenAICodexToken(opts: RefreshOpenAICodexTokenOptions): Promise<OpenAICodexTokenRecord> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: opts.clientId,
    refresh_token: opts.refreshToken,
  });
  const fetchImpl = opts.fetch ?? fetch;
  const resp = await fetchImpl(opts.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  return parseTokenResponse(resp, opts.now?.() ?? new Date(), opts.refreshToken);
}

export function singleFlightRefresh(
  refresh: () => Promise<OpenAICodexTokenRecord>,
  tokenStore: TokenStore,
): () => Promise<OpenAICodexTokenRecord> {
  let inFlight: Promise<OpenAICodexTokenRecord> | null = null;
  return async () => {
    if (!inFlight) {
      inFlight = refresh()
        .then(async (token) => {
          await tokenStore.set(token);
          return token;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}
