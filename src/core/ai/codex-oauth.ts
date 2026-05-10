import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { AIConfigError } from './errors.ts';

export const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const ACCESS_TOKEN_REDACTION = '[REDACTED]';
const DEFAULT_REFRESH_SKEW_SECONDS = 120;

type AuthShape = Record<string, any>;

export interface CodexOAuthCredentials {
  provider: 'openai-codex';
  source: string;
  baseUrl: string;
  accessToken: string;
  refreshToken: string;
  lastRefresh?: string;
}

export interface LoadCodexOAuthOptions {
  refreshIfExpiring?: boolean;
  refreshSkewSeconds?: number;
}

export interface CodexChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

export interface CodexChatOptions {
  model: string;
  system?: string;
  messages: CodexChatMessage[];
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

export interface CodexChatResponse {
  text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  stopReason: 'end' | 'length' | 'content_filter' | 'refusal' | 'tool_calls' | 'other';
  providerMetadata?: Record<string, unknown>;
}

export function redactCodexSecret(value: string): string {
  if (!value) return value;
  return value
    .replace(/(access_token\s*[=:]\s*)([^\s,&}]+)/gi, `$1${ACCESS_TOKEN_REDACTION}`)
    .replace(/(refresh_token\s*[=:]\s*)([^\s,&}]+)/gi, `$1${ACCESS_TOKEN_REDACTION}`)
    .replace(/(Authorization\s*:\s*Bearer\s+)([^\s]+)/gi, `$1${ACCESS_TOKEN_REDACTION}`);
}

function homeDir(): string {
  return process.env.HOME || homedir();
}

function candidateAuthPaths(): string[] {
  const explicit = process.env.GBRAIN_CODEX_AUTH_JSON?.trim();
  if (explicit) return [explicit];
  const codexHome = process.env.CODEX_HOME?.trim() || join(homeDir(), '.codex');
  return [
    join(homeDir(), '.hermes', 'auth.json'),
    join(codexHome, 'auth.json'),
  ];
}

function readJson(path: string): AuthShape | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new AIConfigError(
      `Codex OAuth auth file is not valid JSON: ${path}`,
      'Re-authenticate with `hermes auth add openai-codex` or set GBRAIN_CODEX_AUTH_JSON to a valid auth file.',
    );
  }
}

function extractTokens(payload: AuthShape): { tokens: AuthShape; baseUrl?: string; lastRefresh?: string } | null {
  // Explicit / Codex CLI shape: { tokens: { access_token, refresh_token }, ... }
  if (payload?.tokens && typeof payload.tokens === 'object') {
    return {
      tokens: payload.tokens,
      baseUrl: payload.base_url ?? payload.baseUrl,
      lastRefresh: payload.last_refresh ?? payload.lastRefresh,
    };
  }

  // Hermes multi-provider shape: { providers: { 'openai-codex': { tokens, base_url } } }
  const provider = payload?.providers?.['openai-codex'] ?? payload?.auth?.['openai-codex'];
  if (provider?.tokens && typeof provider.tokens === 'object') {
    return {
      tokens: provider.tokens,
      baseUrl: provider.base_url ?? provider.baseUrl ?? payload.base_url,
      lastRefresh: provider.last_refresh ?? provider.lastRefresh,
    };
  }

  // Some stores are directly keyed by provider id.
  const direct = payload?.['openai-codex'];
  if (direct?.tokens && typeof direct.tokens === 'object') {
    return {
      tokens: direct.tokens,
      baseUrl: direct.base_url ?? direct.baseUrl,
      lastRefresh: direct.last_refresh ?? direct.lastRefresh,
    };
  }

  return null;
}

function decodeJwtPayload(token: string): Record<string, any> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf-8'));
  } catch {
    return null;
  }
}

export function isCodexAccessTokenExpiring(accessToken: string, skewSeconds = DEFAULT_REFRESH_SKEW_SECONDS): boolean {
  const payload = decodeJwtPayload(accessToken);
  const exp = Number(payload?.exp ?? 0);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return exp <= nowSeconds + skewSeconds;
}

export async function refreshCodexOAuthCredentials(creds: CodexOAuthCredentials): Promise<CodexOAuthCredentials> {
  if (!creds.refreshToken) {
    throw new AIConfigError('Codex OAuth refresh token is missing.', 'Run `hermes auth add openai-codex` to re-authenticate.');
  }
  const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: CODEX_OAUTH_CLIENT_ID,
    }),
  });
  if (!response.ok) {
    throw new AIConfigError(
      `Codex OAuth refresh failed with status ${response.status}.`,
      'Run `hermes auth add openai-codex` if the refresh token expired or was consumed by another client.',
    );
  }
  const payload = await response.json() as Record<string, any>;
  const accessToken = String(payload.access_token ?? '').trim();
  if (!accessToken) {
    throw new AIConfigError('Codex OAuth refresh response did not include an access token.');
  }
  return {
    ...creds,
    accessToken,
    refreshToken: String(payload.refresh_token ?? creds.refreshToken).trim(),
    lastRefresh: new Date().toISOString(),
  };
}

function writeUpdatedTokens(path: string, original: AuthShape, creds: CodexOAuthCredentials): void {
  const update = (node: AuthShape) => {
    if (!node.tokens) node.tokens = {};
    node.tokens.access_token = creds.accessToken;
    node.tokens.refresh_token = creds.refreshToken;
    node.last_refresh = creds.lastRefresh;
  };

  if (original?.tokens) update(original);
  else if (original?.providers?.['openai-codex']) update(original.providers['openai-codex']);
  else if (original?.['openai-codex']) update(original['openai-codex']);
  else return;

  writeFileSync(path, JSON.stringify(original, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

export function loadCodexOAuthCredentials(options: LoadCodexOAuthOptions = {}): CodexOAuthCredentials {
  for (const path of candidateAuthPaths()) {
    const payload = readJson(path);
    if (!payload) continue;
    const extracted = extractTokens(payload);
    if (!extracted) continue;
    const accessToken = String(extracted.tokens.access_token ?? '').trim();
    const refreshToken = String(extracted.tokens.refresh_token ?? '').trim();
    if (!accessToken || !refreshToken) continue;

    let creds: CodexOAuthCredentials = {
      provider: 'openai-codex',
      source: path,
      baseUrl: String(process.env.HERMES_CODEX_BASE_URL || extracted.baseUrl || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, ''),
      accessToken,
      refreshToken,
      lastRefresh: extracted.lastRefresh,
    };

    if (options.refreshIfExpiring !== false && isCodexAccessTokenExpiring(creds.accessToken, options.refreshSkewSeconds)) {
      throw new AIConfigError(
        'Codex OAuth access token is expiring and must be refreshed asynchronously before use.',
        'Use refreshCodexOAuthCredentials() in an async chat path, or run `hermes auth add openai-codex` to refresh auth.',
      );
    }
    return creds;
  }

  throw new AIConfigError(
    'Codex OAuth credentials were not found.',
    'Run `hermes auth add openai-codex`, log in with Codex CLI, or set GBRAIN_CODEX_AUTH_JSON to an auth JSON path.',
  );
}


function contentToText(content: CodexChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

function responseText(payload: Record<string, any>): string {
  if (typeof payload.output_text === 'string') return payload.output_text;
  const out = payload.output;
  if (!Array.isArray(out)) return '';
  const parts: string[] = [];
  for (const item of out) {
    const content = item?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block?.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('');
}

function mapCodexStopReason(status: string | undefined, incompleteReason: string | undefined): CodexChatResponse['stopReason'] {
  if (status === 'completed') return 'end';
  if (incompleteReason === 'max_output_tokens') return 'length';
  if (incompleteReason === 'content_filter') return 'content_filter';
  return 'other';
}

export async function runCodexOAuthChat(opts: CodexChatOptions): Promise<CodexChatResponse> {
  let creds = loadCodexOAuthCredentials({ refreshIfExpiring: false });
  if (isCodexAccessTokenExpiring(creds.accessToken)) {
    creds = await refreshCodexOAuthCredentials(creds);
    const original = readJson(creds.source);
    if (original) writeUpdatedTokens(creds.source, original, creds);
  }

  const input: Array<Record<string, string>> = [];
  if (opts.system?.trim()) input.push({ role: 'system', content: opts.system });
  for (const message of opts.messages) {
    if (message.role === 'tool') continue;
    const text = contentToText(message.content);
    if (!text) continue;
    input.push({ role: message.role, content: text });
  }

  const response = await fetch(`${creds.baseUrl}/responses`, {
    method: 'POST',
    signal: opts.abortSignal,
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      input,
      ...(opts.maxTokens ? { max_output_tokens: opts.maxTokens } : {}),
    }),
  });

  if (!response.ok) {
    const detail = redactCodexSecret(await response.text().catch(() => ''));
    throw new AIConfigError(
      `Codex Responses request failed with status ${response.status}.`,
      detail || 'Check your Hermes/Codex OAuth login with `hermes auth add openai-codex`.',
    );
  }

  const payload = await response.json() as Record<string, any>;
  const usage = payload.usage ?? {};
  return {
    text: responseText(payload),
    usage: {
      input_tokens: Number(usage.input_tokens ?? usage.inputTokens ?? 0),
      output_tokens: Number(usage.output_tokens ?? usage.outputTokens ?? 0),
    },
    stopReason: mapCodexStopReason(payload.status, payload.incomplete_details?.reason),
    providerMetadata: { codex: { id: payload.id, status: payload.status } },
  };
}
