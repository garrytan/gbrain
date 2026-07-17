import type { Recipe } from '../types.ts';

/**
 * MiniMax (海螺AI). OpenAI-compatible /embeddings endpoint at
 * api.minimax.chat. The flagship embedding model is `embo-01` (1536 dims).
 *
 * MiniMax's API takes an extra `type: 'db' | 'query'` field for asymmetric
 * retrieval. gbrain currently has no notion of "this is a document vs a
 * query" at the embed-call site (embed() takes only texts), so we default
 * to `type: 'db'` for the indexing path. Queries also embed with `type:
 * 'db'`, making retrieval symmetric. This sacrifices some retrieval
 * quality vs. a true asymmetric setup but works correctly. A follow-up
 * TODO will thread query/document context through the embed seam for
 * full asymmetric support.
 *
 * Reference: https://www.minimaxi.com/document/guides/embeddings
 */
export const minimax: Recipe = {
  id: 'minimax',
  name: 'MiniMax (海螺AI)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.minimaxi.com/v1',
  auth_env: {
    required: ['MINIMAX_API_KEY'],
    optional: ['MINIMAX_GROUP_ID'],
    setup_url: 'https://www.minimaxi.com/document/guides/embeddings',
  },
  touchpoints: {
    embedding: {
      models: ['embo-01'],
      default_dims: 1536,
      cost_per_1m_tokens_usd: 0.07,
      price_last_verified: '2026-05-09',
      max_batch_tokens: 4096,
    },
    chat: {
      models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2'],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 1_000_000,
      cost_per_1m_input_usd: 0.07,
      cost_per_1m_output_usd: 0.14,
      price_last_verified: '2026-07-17',
    },
  },
  resolveOpenAICompatConfig(env: Record<string, string | undefined>) {
    const baseURL = env.MINIMAX_BASE_URL ?? this.base_url_default!;

    const wrappedFetch = (async (input: any, init: any) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      const doFetch = async (attemptInit: any): Promise<Response> => {
        const resp = await fetch(url, attemptInit);
        const contentType = resp.headers.get('content-type') ?? '';

        if (!contentType.includes('application/json')) {
          return resp;
        }

        const json = await resp.json();

        // Detect MiniMax rate-limit (status_code 1002).
        const isRateLimit =
          json?.base_resp?.status_code === 1002 ||
          json?.base_resp?.status_msg?.includes?.('rate limit');

        if (isRateLimit && attemptInit._retryCount < 5) {
          const waitMs = Math.min(1000 * 2 ** attemptInit._retryCount, 30_000);
          const jitter = Math.random() * 200;
          await new Promise(r => setTimeout(r, waitMs + jitter));
          return doFetch({ ...attemptInit, _retryCount: attemptInit._retryCount + 1 });
        }

        // Rewrite response: MiniMax -> `{vectors: [[...]]}`, AI SDK wants `{data: [{embedding}]}`.
        if (json && typeof json === 'object' && Array.isArray(json.vectors)) {
          const rewritten = {
            object: 'list',
            data: json.vectors.map((vec: number[], i: number) => ({
              object: 'embedding',
              embedding: vec,
              index: i,
            })),
            model: json.model ?? 'embo-01',
            usage: {
              prompt_tokens: json.total_tokens ?? 0,
              total_tokens: json.total_tokens ?? 0,
            },
          };
          return new Response(JSON.stringify(rewritten), {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
          });
        }

        // Not rewritten — pass through (errors, non-embedding responses).
        return resp;
      };

      let baseInit = init ?? {};
      if (baseInit.body && typeof baseInit.body === 'string') {
        try {
          const parsed = JSON.parse(baseInit.body);
          if (parsed && typeof parsed === 'object') {
            let mutated = false;
            // AI SDK sends `input: [...]`, MiniMax wants `texts: [...]`.
            if (parsed.input !== undefined && parsed.texts === undefined) {
              parsed.texts = parsed.input;
              delete parsed.input;
              mutated = true;
            }
            // Always inject type:'db' for the document (indexing) side.
            if (parsed.type === undefined) {
              parsed.type = 'db';
              mutated = true;
            }
            if (mutated) {
              const headers = new Headers(baseInit.headers ?? {});
              headers.delete('content-length');
              baseInit = { ...baseInit, body: JSON.stringify(parsed), headers };
            }
          }
        } catch {}
      }

      return doFetch({ ...baseInit, _retryCount: 0 });
    }) as typeof fetch;

    return { baseURL, fetch: wrappedFetch };
  },
  setup_hint:
    'Get an API key at https://www.minimaxi.com, then `export MINIMAX_API_KEY=...`',
};
