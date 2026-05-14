import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { AIConfigError, AITransientError } from './errors.ts';

export const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120;

export interface CodexTokens {
  access_token: string;
  refresh_token: string;
  [key: string]: unknown;
}

export interface CodexRuntimeCredentials {
  provider: 'openai-codex';
  baseURL: string;
  accessToken: string;
  source: string;
  refreshed: boolean;
}

interface AuthStoreCandidate {
  path: string;
  source: string;
  writable: boolean;
}

interface LoadedAuthStore {
  candidate: AuthStoreCandidate;
  payload: Record<string, unknown>;
  state: Record<string, unknown>;
  tokens: CodexTokens;
}

function expandHome(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

function authStoreCandidates(env: Record<string, string | undefined>): AuthStoreCandidate[] {
  const out: AuthStoreCandidate[] = [];
  const explicit = env.GBRAIN_CODEX_AUTH_JSON?.trim();
  if (explicit) {
    out.push({
      path: expandHome(explicit),
      source: 'gbrain-codex-auth-json',
      writable: true,
    });
  }

  const hermesHome = env.HERMES_HOME?.trim()
    ? expandHome(env.HERMES_HOME)
    : join(homedir(), '.hermes');
  out.push({
    path: join(hermesHome, 'auth.json'),
    source: 'hermes-auth-store',
    writable: true,
  });

  const codexHome = env.CODEX_HOME?.trim()
    ? expandHome(env.CODEX_HOME)
    : join(homedir(), '.codex');
  out.push({
    path: join(codexHome, 'auth.json'),
    source: 'codex-cli-auth-store',
    writable: false,
  });

  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findCodexState(payload: Record<string, unknown>): Record<string, unknown> | null {
  const providers = asRecord(payload.providers);
  const providerState = providers ? asRecord(providers['openai-codex']) : null;
  if (providerState) return providerState;

  const directProvider = asRecord(payload['openai-codex']);
  if (directProvider) return directProvider;

  const tokens = asRecord(payload.tokens);
  if (tokens) return payload;

  return null;
}

function extractTokens(state: Record<string, unknown>): CodexTokens | null {
  const raw = asRecord(state.tokens) ?? state;
  const accessToken = raw.access_token;
  const refreshToken = raw.refresh_token;
  if (typeof accessToken !== 'string' || !accessToken.trim()) return null;
  if (typeof refreshToken !== 'string' || !refreshToken.trim()) return null;
  return raw as CodexTokens;
}

function readAuthStore(candidate: AuthStoreCandidate): LoadedAuthStore | null {
  if (!existsSync(candidate.path)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(candidate.path, 'utf8'));
  } catch {
    return null;
  }
  const record = asRecord(payload);
  if (!record) return null;
  const state = findCodexState(record);
  if (!state) return null;
  const tokens = extractTokens(state);
  if (!tokens) return null;
  return { candidate, payload: record, state, tokens };
}

function loadCodexAuthStore(env: Record<string, string | undefined>): LoadedAuthStore | null {
  for (const candidate of authStoreCandidates(env)) {
    const loaded = readAuthStore(candidate);
    if (loaded) return loaded;
  }
  return null;
}

export function hasCodexAuthCandidate(env: Record<string, string | undefined>): boolean {
  return loadCodexAuthStore(env) !== null;
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - input.length % 4) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function jwtExpSeconds(token: string): number | null {
  const claims = jwtClaims(token);
  const exp = claims?.exp;
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
}

export function codexAccessTokenIsExpiring(
  accessToken: string,
  skewSeconds = CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
): boolean {
  const exp = jwtExpSeconds(accessToken);
  if (exp === null) return false;
  const now = Math.floor(Date.now() / 1000);
  return exp <= now + skewSeconds;
}

function redactedRefreshErrorMessage(payload: unknown, status: number): { message: string; relogin: boolean } {
  let message = `Codex token refresh failed with status ${status}.`;
  let relogin = status === 401 || status === 403;
  const obj = asRecord(payload);
  if (!obj) return { message, relogin };

  const err = obj.error;
  if (typeof err === 'string' && err.trim()) {
    const desc = typeof obj.error_description === 'string'
      ? obj.error_description.trim()
      : typeof obj.message === 'string'
      ? obj.message.trim()
      : '';
    message = desc ? `Codex token refresh failed: ${desc}` : `Codex token refresh failed: ${err}`;
    if (['invalid_grant', 'invalid_token', 'invalid_request'].includes(err)) relogin = true;
    if (err === 'refresh_token_reused') relogin = true;
  } else {
    const errObj = asRecord(err);
    const code = typeof errObj?.code === 'string'
      ? errObj.code
      : typeof errObj?.type === 'string'
      ? errObj.type
      : '';
    const nestedMessage = typeof errObj?.message === 'string' ? errObj.message.trim() : '';
    if (nestedMessage) message = `Codex token refresh failed: ${nestedMessage}`;
    if (['invalid_grant', 'invalid_token', 'invalid_request', 'refresh_token_reused'].includes(code)) {
      relogin = true;
    }
  }

  if (message.includes('refresh token') && message.includes('another client')) relogin = true;
  return { message, relogin };
}

export async function refreshCodexOAuthTokens(
  tokens: CodexTokens,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<CodexTokens> {
  const refreshToken = tokens.refresh_token?.trim();
  if (!refreshToken) {
    throw new AIConfigError(
      'Codex auth is missing refresh_token.',
      'Re-authenticate with `hermes auth openai-codex` or `hermes auth`.',
    );
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(CODEX_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_OAUTH_CLIENT_ID,
      }),
    });
  } catch (err) {
    throw new AITransientError('Codex token refresh failed before a response was received.', err);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const { message, relogin } = redactedRefreshErrorMessage(payload, response.status);
    throw new AIConfigError(
      message,
      relogin
        ? 'Re-authenticate with `hermes auth openai-codex` or `hermes auth`.'
        : 'Retry later, or re-authenticate if the problem persists.',
    );
  }

  const obj = asRecord(payload);
  const nextAccess = obj?.access_token;
  if (typeof nextAccess !== 'string' || !nextAccess.trim()) {
    throw new AIConfigError(
      'Codex token refresh response was missing access_token.',
      'Re-authenticate with `hermes auth openai-codex` or `hermes auth`.',
    );
  }

  const nextRefresh = typeof obj?.refresh_token === 'string' && obj.refresh_token.trim()
    ? obj.refresh_token.trim()
    : refreshToken;

  return {
    ...tokens,
    access_token: nextAccess.trim(),
    refresh_token: nextRefresh,
  };
}

function writeAuthStore(loaded: LoadedAuthStore, tokens: CodexTokens): void {
  if (!loaded.candidate.writable) return;
  loaded.state.tokens = tokens;
  loaded.state.last_refresh = new Date().toISOString();
  loaded.state.auth_mode = 'chatgpt';
  mkdirSync(dirname(loaded.candidate.path), { recursive: true });
  const tmp = `${loaded.candidate.path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(loaded.payload, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best-effort on platforms/filesystems that do not support chmod.
  }
  renameSync(tmp, loaded.candidate.path);
}

function resolveCodexBaseURL(
  env: Record<string, string | undefined>,
  loaded: LoadedAuthStore,
): string {
  const fromEnv = env.GBRAIN_CODEX_BASE_URL?.trim()
    || env.HERMES_CODEX_BASE_URL?.trim()
    || '';
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const stateBaseURL = loaded.state.base_url;
  if (typeof stateBaseURL === 'string' && stateBaseURL.trim()) {
    return stateBaseURL.trim().replace(/\/+$/, '');
  }
  return DEFAULT_CODEX_BASE_URL;
}

export async function resolveCodexRuntimeCredentials(
  env: Record<string, string | undefined>,
  opts: {
    forceRefresh?: boolean;
    refreshIfExpiring?: boolean;
    refreshSkewSeconds?: number;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<CodexRuntimeCredentials> {
  const loaded = loadCodexAuthStore(env);
  if (!loaded) {
    throw new AIConfigError(
      'No OpenAI Codex OAuth credentials found.',
      'Authenticate with Hermes (`hermes auth openai-codex` or `hermes auth`), or set GBRAIN_CODEX_AUTH_JSON to a Hermes-compatible auth.json file.',
    );
  }

  let tokens = loaded.tokens;
  const shouldRefresh = opts.forceRefresh === true
    || (opts.refreshIfExpiring !== false
      && codexAccessTokenIsExpiring(
        tokens.access_token,
        opts.refreshSkewSeconds ?? CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
      ));

  let refreshed = false;
  if (shouldRefresh) {
    tokens = await refreshCodexOAuthTokens(tokens, { fetchImpl: opts.fetchImpl });
    refreshed = true;
    if (loaded.candidate.writable) {
      writeAuthStore(loaded, tokens);
    }
  }

  return {
    provider: 'openai-codex',
    baseURL: resolveCodexBaseURL(env, loaded),
    accessToken: tokens.access_token,
    source: loaded.candidate.source,
    refreshed,
  };
}

export function codexRequestHeaders(accessToken: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'codex_cli_rs/0.0.0 (gbrain)',
    originator: 'codex_cli_rs',
  };
  const authClaims = asRecord(jwtClaims(accessToken)?.['https://api.openai.com/auth']);
  const accountId = authClaims?.chatgpt_account_id;
  if (typeof accountId === 'string' && accountId.trim()) {
    headers['ChatGPT-Account-ID'] = accountId.trim();
  }
  return headers;
}
