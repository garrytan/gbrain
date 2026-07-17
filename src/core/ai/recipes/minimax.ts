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
    optional: ['MINIMAX_GROUP_ID', 'MINIMAX_BASE_URL'],
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
      max_context_tokens: 1_000_000,
      cost_per_1m_input_usd: 0.07,
      cost_per_1m_output_usd: 0.14,
      price_last_verified: '2026-07-17',
    },
  },
  resolveOpenAICompatConfig(env: Record<string, string | undefined>) {
    const baseURL = env.MINIMAX_BASE_URL ?? this.base_url_default!;

    const wrappedFetch = (async (input: RequestInfo | URL | Request, init?: RequestInit) => {
      // Normalize URL: string / URL / Request.url → string URL.
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;

      // If input is a Request, rebuild it from url so method/headers/body are preserved.
      // If string/URL, use init as-is.
      const finalInit: RequestInit | undefined =
        typeof input === 'string' || input instanceof URL
          ? init
          : undefined;

      const doFetch = async (attemptInit: RequestInit | undefined, retryCount = 0): Promise<Response> => {
        const resp = await fetch(url, attemptInit);
        const contentType = resp.headers.get('content-type') ?? '';

        if (!contentType.includes('application/json')) {
          return resp;
        }

        let json: unknown;
        try {
          json = await resp.json();
        } catch {
          // Non-JSON body despite content-type: pass through as-is.
          return resp;
        }

        const baseResp = (json as Record<string, unknown>)?.base_resp as Record<string, unknown> | undefined;
        const isRateLimit =
          baseResp?.status_code === 1002 ||
          String(baseResp?.status_msg ?? '').includes('rate limit');

        if (isRateLimit && retryCount < 5) {
          const waitMs = Math.min(1000 * 2 ** retryCount, 30_000);
          const jitter = Math.random() * 200;
          await new Promise(r => setTimeout(r, waitMs + jitter));
          return doFetch(attemptInit, retryCount + 1);
        }

        // Rewrite response: MiniMax `{vectors: [[...]]}` → AI SDK `{data: [{embedding}]}`.
        if (json && typeof json === 'object' && Array.isArray((json as Record<string, unknown>).vectors)) {
          const vectors = (json as { vectors: number[][]; model?: string; total_tokens?: number }).vectors;
          const outHeaders = new Headers(resp.headers);
          outHeaders.delete('content-length');
          outHeaders.delete('content-encoding');
          const rewritten = {
            object: 'list',
            data: vectors.map((vec, i) => ({ object: 'embedding', embedding: vec, index: i })),
            model: (json as { model?: string }).model ?? 'embo-01',
            usage: {
              prompt_tokens: (json as { total_tokens?: number }).total_tokens ?? 0,
              total_tokens: (json as { total_tokens?: number }).total_tokens ?? 0,
            },
          };
          return new Response(JSON.stringify(rewritten), {
            status: resp.status,
            statusText: resp.statusText,
            headers: outHeaders,
          });
        }

        return resp;
      };

      let baseInit = finalInit ?? {};
      if (baseInit.body && typeof baseInit.body === 'string') {
        try {
          const parsed = JSON.parse(baseInit.body);
          if (parsed && typeof parsed === 'object') {
            let mutated = false;
            // AI SDK sends `input: [...]`, MiniMax wants `texts: [...]`.
            if ((parsed as Record<string, unknown>).input !== undefined && (parsed as Record<string, unknown>).texts === undefined) {
              (parsed as Record<string, unknown>).texts = (parsed as Record<string, unknown>).input;
              delete (parsed as Record<string, unknown>).input;
              // Inject type:'db' only for embedding-shaped requests.
              if ((parsed as Record<string, unknown>).type === undefined) {
                (parsed as Record<string, unknown>).type = 'db';
              }
              mutated = true;
            }
            if (mutated) {
              const headers = new Headers(baseInit.headers ?? {});
              headers.delete('content-length');
              baseInit = { ...baseInit, body: JSON.stringify(parsed), headers };
            }
          }
        } catch (e) {
          // Request body is not valid JSON: send as-is but warn for debugging.
          console.warn('[minimax] request body is not valid JSON, sending as-is', e);
        }
      }

      return doFetch(baseInit, 0);
    }) as unknown as typeof fetch;

    return { baseURL, fetch: wrappedFetch };
  },
  setup_hint:
    'Get an API key at https://www.minimaxi.com, then `export MINIMAX_API_KEY=...`',
};
