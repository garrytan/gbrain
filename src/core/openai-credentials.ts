import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DEFAULT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

type EnvLike = Record<string, string | undefined>;

export interface OpenAICredentials {
  apiKey: string;
  baseURL?: string;
  source: 'env' | 'hermes-auth-store' | 'codex-cli';
  authMode: 'api-key' | 'chatgpt';
}

export interface ResolveOpenAICredentialsOpts {
  env?: EnvLike;
  homeDir?: string;
}

export function resolveOpenAICredentials(opts: ResolveOpenAICredentialsOpts = {}): OpenAICredentials | null {
  const env = opts.env || (process.env as EnvLike);
  const homeDir = opts.homeDir || homedir();

  const envApiKey = normalize(env.OPENAI_API_KEY);
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      baseURL: normalizeBaseURL(env.OPENAI_BASE_URL),
      source: 'env',
      authMode: 'api-key',
    };
  }

  const hermesCreds = readHermesCodexCredentials(homeDir, env);
  if (hermesCreds) return hermesCreds;

  return readCodexCliCredentials(homeDir, env);
}

export function hasOpenAICredentials(opts: ResolveOpenAICredentialsOpts = {}): boolean {
  return !!resolveOpenAICredentials(opts);
}

function readHermesCodexCredentials(homeDir: string, env: EnvLike): OpenAICredentials | null {
  const authPath = join(homeDir, '.hermes', 'auth.json');
  const authStore = readJson(authPath);
  const providers = authStore?.providers;
  const codex = isRecord(providers) ? providers['openai-codex'] : null;
  if (!isRecord(codex)) return null;

  const tokens = codex.tokens;
  if (!isRecord(tokens)) return null;

  const accessToken = normalize(tokens.access_token);
  if (!accessToken) return null;

  return {
    apiKey: accessToken,
    baseURL: normalizeBaseURL(env.HERMES_CODEX_BASE_URL) || DEFAULT_CODEX_BASE_URL,
    source: 'hermes-auth-store',
    authMode: 'chatgpt',
  };
}

function readCodexCliCredentials(homeDir: string, env: EnvLike): OpenAICredentials | null {
  const codexHome = normalize(env.CODEX_HOME) || join(homeDir, '.codex');
  const authPath = join(codexHome, 'auth.json');
  const payload = readJson(authPath);
  const tokens = payload?.tokens;
  if (!isRecord(tokens)) return null;

  const accessToken = normalize(tokens.access_token);
  if (!accessToken) return null;

  return {
    apiKey: accessToken,
    baseURL: normalizeBaseURL(env.HERMES_CODEX_BASE_URL) || DEFAULT_CODEX_BASE_URL,
    source: 'codex-cli',
    authMode: 'chatgpt',
  };
}

function readJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBaseURL(value: unknown): string | undefined {
  const normalized = normalize(value).replace(/\/+$/, '');
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export { DEFAULT_CODEX_BASE_URL };
