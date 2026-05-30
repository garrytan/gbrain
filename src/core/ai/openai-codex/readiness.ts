import { defaultTokenStore, redactTokenLike, type TokenStore } from './token-store.ts';
import { isModelCacheFresh, readModelCacheOrNull } from './model-cache.ts';

export type OpenAICodexReadinessStatus =
  | 'not_logged_in'
  | 'token_present'
  | 'needs_refresh'
  | 'cache_missing'
  | 'ready';

export interface OpenAICodexReadiness {
  status: OpenAICodexReadinessStatus;
  ready: boolean;
  hint: string;
  token_expires_at?: string;
  cache_fetched_at?: string;
  models_supported?: number;
}

export interface OpenAICodexReadinessOptions {
  tokenStore?: TokenStore;
  now?: () => Date;
  ttlMs?: number;
  refreshSkewMs?: number;
}

const DEFAULT_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

export async function getOpenAICodexReadiness(
  opts: OpenAICodexReadinessOptions = {},
): Promise<OpenAICodexReadiness> {
  const now = opts.now ?? (() => new Date());
  const ttlMs = opts.ttlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
  const refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const tokenStore = opts.tokenStore ?? defaultTokenStore();

  let token;
  try {
    token = await tokenStore.get();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'not_logged_in',
      ready: false,
      hint: `Unable to inspect openai-codex token store: ${redactTokenLike(msg)}. Run gbrain providers login openai-codex.`,
    };
  }

  if (!token) {
    return {
      status: 'not_logged_in',
      ready: false,
      hint: 'Run gbrain providers login openai-codex to authenticate this GBrain install.',
    };
  }

  const expiresAtMs = Date.parse(token.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs - now().getTime() <= refreshSkewMs) {
    return {
      status: 'needs_refresh',
      ready: false,
      token_expires_at: token.expires_at,
      hint: 'OpenAI Codex OAuth token is expired or near expiry. Run gbrain providers refresh openai-codex.',
    };
  }

  let cache;
  try {
    cache = await readModelCacheOrNull();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: 'cache_missing',
      ready: false,
      token_expires_at: token.expires_at,
      hint: `Unable to inspect openai-codex model cache: ${redactTokenLike(msg)}. Run gbrain providers refresh openai-codex.`,
    };
  }

  if (!cache) {
    return {
      status: 'cache_missing',
      ready: false,
      token_expires_at: token.expires_at,
      hint: 'OpenAI Codex token exists, but model cache is missing. Run gbrain providers refresh openai-codex.',
    };
  }

  const base = {
    token_expires_at: token.expires_at,
    cache_fetched_at: cache.fetched_at,
    models_supported: cache.supported_count,
  };

  if (!isModelCacheFresh(cache, ttlMs, now())) {
    return {
      status: 'token_present',
      ready: false,
      ...base,
      hint: 'OpenAI Codex token exists, but model cache is stale. Run gbrain providers refresh openai-codex.',
    };
  }

  if (cache.supported_count <= 0) {
    return {
      status: 'cache_missing',
      ready: false,
      ...base,
      hint: 'OpenAI Codex model cache has no API-supported models. Run gbrain providers refresh openai-codex.',
    };
  }

  return {
    status: 'ready',
    ready: true,
    ...base,
    hint: 'OpenAI Codex OAuth token and model cache are ready.',
  };
}
