import type { Recipe } from '../types.ts';
import { AIConfigError } from '../errors.ts';
import { execSync } from 'node:child_process';

// Entra (keyless) auth, same shape as azure-openai.ts. The helper is copied
// rather than shared because that recipe's internals are deliberately private
// (only its test seam is exported) and it ships with its own tests; a shared
// module would mean editing a file this recipe is supposed to leave alone.
// Both caches are tiny and independent.
let _entraToken: { token: string; fetchedAt: number } | null = null;
const ENTRA_TOKEN_TTL_MS = 45 * 60 * 1000; // refresh well before the ~60-90min expiry

function fetchEntraToken(): string {
  const now = Date.now();
  if (_entraToken && now - _entraToken.fetchedAt < ENTRA_TOKEN_TTL_MS) {
    return _entraToken.token;
  }
  let token = '';
  try {
    token = execSync(
      'az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken -o tsv',
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000 },
    ).trim();
  } catch {
    throw new AIConfigError(
      'Azure OpenAI (v1 route, Entra/keyless): could not get an access token via `az account get-access-token`.',
      'Run `az login` and ensure your identity has the "Cognitive Services OpenAI User" role on the resource.',
    );
  }
  if (!token) {
    throw new AIConfigError(
      'Azure OpenAI (v1 route, Entra/keyless): `az account get-access-token` returned an empty token.',
      'Run `az login` and verify the active subscription owns the Azure OpenAI resource.',
    );
  }
  _entraToken = { token, fetchedAt: now };
  return token;
}

/** @internal test seam: pre-populate (or clear) the Entra token cache so unit
 * tests never shell out to `az`. */
export function __setEntraTokenForTests(token: string | null): void {
  _entraToken = token === null ? null : { token, fetchedAt: Date.now() };
}

/** Entra/keyless mode is explicit opt-in only (AZURE_OPENAI_USE_ENTRA=1). A
 * missing api-key must never silently shell out to `az` — that surprises CI
 * boxes and every environment without the Azure CLI. */
function isEntraMode(env: Record<string, string | undefined>): boolean {
  return env.AZURE_OPENAI_USE_ENTRA === '1';
}

/**
 * Azure OpenAI over the OpenAI-compatible `/openai/v1/` route.
 *
 * The older `azure-openai` recipe uses the classic deployment-scoped URL:
 *
 *   {ENDPOINT}/openai/deployments/{DEPLOYMENT}/embeddings?api-version=...
 *
 * That puts one deployment name in the base URL, so a single process can only
 * ever reach one deployment — you can't run embeddings and chat at the same
 * time. The v1 route takes the deployment name in the request body as `model`
 * instead:
 *
 *   {ENDPOINT}/openai/v1/embeddings
 *   {ENDPOINT}/openai/v1/chat/completions
 *
 * so one recipe covers embedding, expansion and chat, and the deployment is
 * whatever `provider:model` string you configure. Name your deployments after
 * the model ids (Azure's default) and `src/core/ai/dims.ts` will thread the
 * `dimensions` parameter for `text-embedding-3-*` as usual.
 *
 * Auth matches the classic recipe: `api-key:` header, or an Entra bearer when
 * AZURE_OPENAI_USE_ENTRA=1. `api-version` is optional here — the v1 route
 * doesn't need it — and is only spliced into the URL when the env var is set.
 *
 * Reference: https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle
 */
export const azureOpenAIV1: Recipe = {
  id: 'azure-openai-v1',
  name: 'Azure OpenAI (v1 route)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  // base_url_default omitted: Azure URLs are env-templated only.
  auth_env: {
    // No AZURE_OPENAI_DEPLOYMENT: the deployment travels in the request body.
    required: ['AZURE_OPENAI_ENDPOINT'],
    optional: ['AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_USE_ENTRA', 'AZURE_OPENAI_API_VERSION'],
    setup_url:
      'https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle',
  },
  touchpoints: {
    embedding: {
      models: ['text-embedding-3-large', 'text-embedding-3-small'],
      // Native size of text-embedding-3-large. Matryoshka truncation to any
      // smaller option is threaded by dims.ts as `dimensions`.
      default_dims: 3072,
      dims_options: [256, 512, 768, 1024, 1536, 3072],
      cost_per_1m_tokens_usd: 0.13,
      price_last_verified: '2026-08-01',
      max_batch_tokens: 8192,
    },
    expansion: {
      // openai-compat tier accepts any model id; these are the common
      // deployment names. Point at whatever you deployed.
      models: ['gpt-5.2', 'gpt-4o-mini'],
    },
    chat: {
      models: ['gpt-5.2', 'gpt-4o-mini'],
      supports_tools: true,
      supports_subagent_loop: true,
      // Azure serves no Anthropic-style cache_control breakpoints on this route.
      supports_prompt_cache: false,
      max_context_tokens: 200000,
    },
  },
  resolveAuth(env) {
    // Entra/keyless: returning an `Authorization: Bearer …` pair makes the
    // gateway use the SDK's native bearer path, so no double-auth.
    if (isEntraMode(env)) {
      return { headerName: 'Authorization', token: `Bearer ${fetchEntraToken()}` };
    }
    // Key mode: Azure wants `api-key:` (no Bearer). The unified seam routes
    // this through `headers` instead of the SDK's apiKey field.
    return { headerName: 'api-key', token: env.AZURE_OPENAI_API_KEY! };
  },
  resolveOpenAICompatConfig(env) {
    const endpoint = env.AZURE_OPENAI_ENDPOINT?.replace(/\/+$/, '');
    if (!endpoint) {
      throw new AIConfigError(
        `Azure OpenAI (v1 route) requires AZURE_OPENAI_ENDPOINT.`,
        'Find your endpoint at portal.azure.com → Azure OpenAI resource → Keys and Endpoint.',
      );
    }
    // The SDK appends /embeddings and /chat/completions to this.
    const baseURL = `${endpoint}/openai/v1`;
    const apiVersion = env.AZURE_OPENAI_API_VERSION;
    const entra = isEntraMode(env);
    // Cast through `any` because TS's `typeof fetch` includes a `preconnect`
    // method that wrappers don't need (the AI SDK never calls it).
    const wrappedFetch = (async (input: any, init: any) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.toString()
          : (input as Request).url;
      // Unlike the deployment-scoped route, api-version is optional here. Only
      // splice it in when the user asked for one (e.g. `preview` to reach
      // features that aren't GA yet).
      let finalUrl = url;
      if (apiVersion && !url.includes('api-version=')) {
        const sep = url.includes('?') ? '&' : '?';
        finalUrl = `${url}${sep}api-version=${encodeURIComponent(apiVersion)}`;
      }
      const finalInput =
        finalUrl === url
          ? input
          : typeof input === 'string' || input instanceof URL
          ? finalUrl
          : new Request(finalUrl, input as Request);
      if (entra) {
        // Refresh the AAD bearer on every request: the gateway caches model
        // instances (auth is baked in at instantiation), so a long-running
        // process would otherwise send an expired token after ~1h. The 45-min
        // TTL cache keeps `az` invocations rare.
        const headers = new Headers(
          init?.headers ??
            (typeof finalInput !== 'string' && !(finalInput instanceof URL)
              ? (finalInput as Request).headers
              : undefined),
        );
        headers.set('Authorization', `Bearer ${fetchEntraToken()}`);
        init = { ...init, headers };
      }
      return fetch(finalInput, init);
    }) as unknown as typeof fetch;
    return { baseURL, fetch: wrappedFetch };
  },
  setup_hint:
    'Azure portal → Azure OpenAI resource. Set AZURE_OPENAI_ENDPOINT, and either AZURE_OPENAI_API_KEY or keyless Entra auth (`az login` + "Cognitive Services OpenAI User" role; force with AZURE_OPENAI_USE_ENTRA=1). The deployment name is the model name, e.g. azure-openai-v1:text-embedding-3-large. Set AZURE_OPENAI_API_VERSION only if the route asks for one.',
};
