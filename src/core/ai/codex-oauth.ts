import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { AIConfigError, AITransientError } from './errors.ts';

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120;

type Env = Record<string, string | undefined>;

type AuthStore = Record<string, any>;

interface TokenSet {
  access_token: string;
  refresh_token?: string;
  [key: string]: unknown;
}

interface TokenSource {
  kind: 'provider' | 'pool' | 'codex-cli';
  tokens: TokenSet;
  storePath?: string;
  poolIndex?: number;
}

export function resolveCodexBaseURL(env: Env): string {
  return (env.HERMES_CODEX_BASE_URL ?? '').trim().replace(/\/$/, '') || DEFAULT_CODEX_BASE_URL;
}

function hermesAuthPath(env: Env): string {
  const home = (env.HERMES_HOME ?? '').trim() || join(homedir(), '.hermes');
  return join(home, 'auth.json');
}

function codexCliAuthPath(env: Env): string {
  const home = (env.CODEX_HOME ?? '').trim() || join(homedir(), '.codex');
  return join(home, 'auth.json');
}

function readJsonFile(path: string): AuthStore | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AuthStore;
  } catch {
    return null;
  }
}

function writeJsonFileAtomic(path: string, payload: AuthStore): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

function asTokenSet(value: unknown): TokenSet | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const access = typeof obj.access_token === 'string' ? obj.access_token.trim() : '';
  if (!access) return null;
  const refresh = typeof obj.refresh_token === 'string' ? obj.refresh_token.trim() : '';
  return refresh ? { ...obj, access_token: access, refresh_token: refresh } as TokenSet : { ...obj, access_token: access } as TokenSet;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function accessTokenIsExpiring(token: string, skewSeconds = CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS): boolean {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== 'number') return false;
  return exp <= Math.floor(Date.now() / 1000) + Math.max(0, skewSeconds);
}

function loadCodexTokens(env: Env): TokenSource | null {
  const storePath = hermesAuthPath(env);
  const store = readJsonFile(storePath);
  if (store) {
    const providerTokens = asTokenSet(store.providers?.['openai-codex']?.tokens);
    if (providerTokens) return { kind: 'provider', tokens: providerTokens, storePath };

    const pool = store.credential_pool?.['openai-codex'];
    if (Array.isArray(pool)) {
      for (let i = 0; i < pool.length; i++) {
        const entry = pool[i];
        if (!entry || typeof entry !== 'object') continue;
        const resetAt = (entry as Record<string, unknown>).last_error_reset_at;
        if (typeof resetAt === 'number' && resetAt > Date.now() / 1000) continue;
        const tokens = asTokenSet(entry);
        if (tokens) return { kind: 'pool', tokens, storePath, poolIndex: i };
      }
    }
  }

  const cliTokens = asTokenSet(readJsonFile(codexCliAuthPath(env))?.tokens);
  if (cliTokens) return { kind: 'codex-cli', tokens: cliTokens };
  return null;
}

function persistRefreshedTokens(env: Env, source: TokenSource, refreshed: TokenSet): void {
  const storePath = source.storePath ?? hermesAuthPath(env);
  const store = readJsonFile(storePath) ?? {};
  store.providers = store.providers && typeof store.providers === 'object' ? store.providers : {};
  store.providers['openai-codex'] = store.providers['openai-codex'] && typeof store.providers['openai-codex'] === 'object'
    ? store.providers['openai-codex']
    : {};

  if (source.kind === 'provider' || source.kind === 'codex-cli') {
    store.providers['openai-codex'].tokens = refreshed;
    store.providers['openai-codex'].last_refresh = new Date().toISOString();
    store.providers['openai-codex'].auth_mode = 'chatgpt';
  }

  if (source.kind === 'pool' && typeof source.poolIndex === 'number') {
    store.credential_pool = store.credential_pool && typeof store.credential_pool === 'object' ? store.credential_pool : {};
    const pool = Array.isArray(store.credential_pool['openai-codex']) ? store.credential_pool['openai-codex'] : [];
    const entry = pool[source.poolIndex] && typeof pool[source.poolIndex] === 'object' ? pool[source.poolIndex] : {};
    pool[source.poolIndex] = {
      ...entry,
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? entry.refresh_token,
      last_refresh: new Date().toISOString(),
      last_status: null,
      last_status_at: null,
      last_error_code: null,
      last_error_reason: null,
      last_error_message: null,
      last_error_reset_at: null,
    };
    store.credential_pool['openai-codex'] = pool;
  }

  writeJsonFileAtomic(storePath, store);
}

async function refreshCodexTokens(tokens: TokenSet, timeoutMs: number): Promise<TokenSet> {
  const refresh = typeof tokens.refresh_token === 'string' ? tokens.refresh_token.trim() : '';
  if (!refresh) {
    throw new AIConfigError(
      'OpenAI Codex OAuth token is expired and no refresh_token is available.',
      'Run `codex` once in a terminal, then run `hermes auth` or `hermes model` to refresh OpenAI Codex OAuth.',
    );
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });
  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status === 429) {
    throw new AITransientError('OpenAI Codex OAuth token refresh is rate-limited (429); credentials may still be valid.');
  }
  if (!response.ok) {
    let detail = '';
    try {
      const payload = await response.json() as Record<string, any>;
      const err = payload.error;
      detail = typeof err === 'string'
        ? err
        : typeof err?.message === 'string'
          ? err.message
          : typeof payload.error_description === 'string'
            ? payload.error_description
            : '';
    } catch {
      // Keep generic message.
    }
    throw new AIConfigError(
      `OpenAI Codex OAuth token refresh failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}.`,
      'Run `codex` once in a terminal, then run `hermes auth` or `hermes model` to refresh OpenAI Codex OAuth.',
    );
  }

  const payload = await response.json() as Record<string, unknown>;
  const access = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
  if (!access) {
    throw new AIConfigError('OpenAI Codex OAuth refresh response did not include access_token.');
  }
  const nextRefresh = typeof payload.refresh_token === 'string' && payload.refresh_token.trim()
    ? payload.refresh_token.trim()
    : refresh;
  return { ...tokens, access_token: access, refresh_token: nextRefresh };
}

export async function resolveCodexOAuthAccessToken(env: Env): Promise<string> {
  const source = loadCodexTokens(env);
  if (!source) {
    throw new AIConfigError(
      'No OpenAI Codex OAuth credentials found in Hermes or Codex CLI auth stores.',
      'Run `codex` once in a terminal, then run `hermes auth` or `hermes model` to authenticate OpenAI Codex.',
    );
  }

  let tokens = source.tokens;
  if (accessTokenIsExpiring(tokens.access_token)) {
    const timeoutRaw = Number(env.HERMES_CODEX_REFRESH_TIMEOUT_SECONDS ?? '20');
    const timeoutMs = Math.max(5_000, Number.isFinite(timeoutRaw) ? timeoutRaw * 1000 : 20_000);
    tokens = await refreshCodexTokens(tokens, timeoutMs);
    try {
      persistRefreshedTokens(env, source, tokens);
    } catch (err) {
      throw new AIConfigError(
        `OpenAI Codex OAuth token refreshed but could not be persisted: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return tokens.access_token;
}

function cloneHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  out.delete('content-length');
  out.set('content-type', 'application/json');
  out.set('accept', 'text/event-stream');
  return out;
}

function parseCodexSse(text: string): Record<string, unknown> {
  let completed: Record<string, any> | null = null;
  const outputByIndex = new Map<number, unknown>();
  let lastError: Record<string, unknown> | null = null;

  for (const frame of text.split(/\r?\n\r?\n/)) {
    if (!frame.trim()) continue;
    let event = '';
    const dataLines: string[] = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join('\n');
    if (raw === '[DONE]') continue;
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(raw) as Record<string, any>;
    } catch {
      continue;
    }
    if (event === 'response.output_item.done' && payload.item) {
      const idx = typeof payload.output_index === 'number' ? payload.output_index : outputByIndex.size;
      outputByIndex.set(idx, payload.item);
    } else if ((event === 'response.completed' || event === 'response.incomplete') && payload.response) {
      completed = payload.response as Record<string, any>;
    } else if (event === 'error' || payload.type === 'error') {
      lastError = payload;
    }
  }

  if (!completed) {
    throw new AITransientError(`OpenAI Codex stream ended without response.completed${lastError ? `: ${JSON.stringify(lastError)}` : ''}`);
  }

  const output = [...outputByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, item]) => item);
  if ((!Array.isArray(completed.output) || completed.output.length === 0) && output.length > 0) {
    completed.output = output;
  }
  return completed;
}

function responseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  const requestId = upstream.headers.get('x-request-id') ?? upstream.headers.get('openai-request-id');
  if (requestId) headers.set('x-request-id', requestId);
  return headers;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const obj = part as Record<string, unknown>;
      if (typeof obj.text === 'string') return obj.text;
      if (typeof obj.content === 'string') return obj.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function hoistDeveloperInstructions(body: Record<string, unknown>): void {
  if (typeof body.instructions === 'string' && body.instructions.trim()) return;
  const input = body.input;
  if (!Array.isArray(input)) return;
  const instructionParts: string[] = [];
  const kept: unknown[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      kept.push(item);
      continue;
    }
    const obj = item as Record<string, unknown>;
    const role = typeof obj.role === 'string' ? obj.role : '';
    if (role === 'developer' || role === 'system') {
      const text = contentToText(obj.content).trim();
      if (text) instructionParts.push(text);
      continue;
    }
    kept.push(item);
  }
  if (instructionParts.length > 0) {
    body.instructions = instructionParts.join('\n\n');
    body.input = kept;
  }
}

export function createCodexResponsesFetch(env: Env): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const original = input instanceof Request ? input : new Request(input, init);
    const url = new URL(original.url);
    if (!url.pathname.endsWith('/responses')) {
      const passthroughHeaders = new Headers(original.headers);
      passthroughHeaders.set('Authorization', `Bearer ${await resolveCodexOAuthAccessToken(env)}`);
      return fetch(original, { headers: passthroughHeaders, signal: init?.signal ?? original.signal });
    }

    const token = await resolveCodexOAuthAccessToken(env);
    const headers = cloneHeaders(original.headers);
    headers.set('Authorization', `Bearer ${token}`);

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await original.text()) as Record<string, unknown>;
    } catch (err) {
      throw new AIConfigError(`OpenAI Codex request body was not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    body.stream = true;
    body.store = false;
    hoistDeveloperInstructions(body);
    // ChatGPT's Codex backend currently rejects this otherwise-standard Responses field.
    delete body.max_output_tokens;

    const upstream = await fetch(url, {
      method: original.method || 'POST',
      headers,
      body: JSON.stringify(body),
      signal: init?.signal ?? original.signal,
    });

    if (!upstream.ok) return upstream;

    const streamed = await upstream.text();
    const completed = parseCodexSse(streamed);
    return new Response(JSON.stringify(completed), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream),
    });
  }) as typeof fetch;
}
