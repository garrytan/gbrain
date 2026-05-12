import type { Recipe } from '../types.ts';
import { AIConfigError } from '../errors.ts';

const DEFAULT_API_VERSION = '2024-10-21'; // stable Azure OpenAI version as of 2026-05

/**
 * Azure OpenAI. The first recipe in v0.32 to exercise both seams:
 *   - resolveAuth returns `{headerName: 'api-key', token: <key>}` instead of
 *     Authorization: Bearer (Azure's API explicitly requires `api-key:` and
 *     rejects double-auth).
 *   - resolveOpenAICompatConfig templates the URL from env + injects an
 *     `?api-version=` query param via a custom fetch wrapper.
 *
 * Azure's URL shape:
 *   {ENDPOINT}/openai/deployments/{DEPLOYMENT}/embeddings?api-version=...
 *
 * The AI SDK's openai-compatible adapter appends `/embeddings` to the
 * baseURL, so we set baseURL to `{ENDPOINT}/openai/deployments/{DEPLOYMENT}`
 * and let the SDK's path-suffix handle the rest. The api-version query is
 * spliced via the fetch wrapper because the SDK has no native query-param
 * option.
 *
 * Reference: https://learn.microsoft.com/en-us/azure/ai-services/openai/
 */
export const azureOpenAI: Recipe = {
  id: 'azure-openai',
  name: 'Azure OpenAI',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  // base_url_default omitted: Azure URLs are env-templated only.
  auth_env: {
    required: [
      'AZURE_OPENAI_API_KEY',
      'AZURE_OPENAI_ENDPOINT',
      'AZURE_OPENAI_DEPLOYMENT',
    ],
    optional: ['AZURE_OPENAI_API_VERSION'],
    setup_url:
      'https://learn.microsoft.com/en-us/azure/ai-services/openai/quickstart',
  },
  touchpoints: {
    embedding: {
      models: [
        'text-embedding-3-large',
        'text-embedding-3-small',
        'text-embedding-ada-002',
      ],
      default_dims: 1536,
      // Matryoshka via text-embedding-3-*; ada-002 is fixed at 1536.
      dims_options: [256, 512, 768, 1024, 1536, 3072],
      cost_per_1m_tokens_usd: 0.13,
      price_last_verified: '2026-05-10',
      max_batch_tokens: 8192,
    },
  },
  resolveAuth(env) {
    const key = env.AZURE_OPENAI_API_KEY;
    if (!key) {
      throw new AIConfigError(
        `Azure OpenAI requires AZURE_OPENAI_API_KEY.`,
        'Get a key from your Azure portal: https://learn.microsoft.com/en-us/azure/ai-services/openai/quickstart',
      );
    }
    // Azure uses `api-key:` (no Bearer); the unified seam routes this
    // through `headers` instead of the SDK's apiKey field to avoid any
    // double-auth Authorization header sneaking in.
    return { headerName: 'api-key', token: key };
  },
  resolveOpenAICompatConfig(env) {
    const endpoint = env.AZURE_OPENAI_ENDPOINT?.replace(/\/+$/, '');
    const deployment = env.AZURE_OPENAI_DEPLOYMENT;
    if (!endpoint) {
      throw new AIConfigError(
        `Azure OpenAI requires AZURE_OPENAI_ENDPOINT.`,
        'Find your endpoint at portal.azure.com → Azure OpenAI resource → Keys and Endpoint.',
      );
    }
    if (!deployment) {
      throw new AIConfigError(
        `Azure OpenAI requires AZURE_OPENAI_DEPLOYMENT.`,
        'Each Azure OpenAI deployment has its own URL path. Set AZURE_OPENAI_DEPLOYMENT to the deployment name from your Azure portal.',
      );
    }
    const apiVersion = env.AZURE_OPENAI_API_VERSION ?? DEFAULT_API_VERSION;
    const baseURL = `${endpoint}/openai/deployments/${deployment}`;
    // Custom fetch wrapper splices ?api-version=... onto every request.
    // Azure rejects requests without it.
    // Cast through `any` because TS's `typeof fetch` includes a `preconnect`
    // method that wrappers don't need (the AI SDK never calls it).
    const wrappedFetch = (async (input: any, init: any) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
          ? input.toString()
          : (input as Request).url;
      const sep = url.includes('?') ? '&' : '?';
      const finalUrl = url.includes('api-version=')
        ? url
        : `${url}${sep}api-version=${encodeURIComponent(apiVersion)}`;
      const finalInput =
        typeof input === 'string' || input instanceof URL
          ? finalUrl
          : new Request(finalUrl, input as Request);
      return fetch(finalInput, init);
    }) as unknown as typeof fetch;
    return { baseURL, fetch: wrappedFetch };
  },
  setup_hint:
    'Azure portal → Azure OpenAI resource. Set AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT. Optionally AZURE_OPENAI_API_VERSION (default 2024-10-21).',
};
