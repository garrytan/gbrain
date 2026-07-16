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
      // MiniMax docs don't publish a hard batch-token cap; declare a
      // conservative 4096-token budget so the gateway pre-splits before
      // hitting whatever undocumented server-side limit exists. Recursive
      // halving in the gateway catches token-limit errors at runtime.
      max_batch_tokens: 4096,
    },
    chat: {
      models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5', 'MiniMax-M2.5-highspeed', 'MiniMax-M2.1', 'MiniMax-M2.1-highspeed', 'MiniMax-M2'],
      supports_tools: false,
      supports_prompt_cache: false,
      max_context_tokens: 1_000_000,
    },
  },
  resolveOpenAICompatConfig(env: Record<string, string | undefined>) {
    // MiniMax uses the same Authorization header shape as the standard
    // openai-compatible path; auth is handled by the gateway via
    // applyResolveAuth so we return baseURL only.
    const baseURL = env.MINIMAX_BASE_URL ?? this.base_url_default!;
    // Custom fetch wrapper:
    //  - Request:  rename `input` → `texts`, inject `type: 'db'`
    //  - Response: rewrite `{vectors: [[...]]}` → `{data: [{embedding}]}`
    //    so the AI SDK's openai-compatible Zod schema parses it correctly.
    const wrappedFetch = (async (input: any, init: any) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      let baseInit = init ?? {};
      if (baseInit.body && typeof baseInit.body === 'string') {
        try {
          const parsed = JSON.parse(baseInit.body);
          if (parsed && typeof parsed === 'object') {
            let mutated = false;
            // Rewrite: AI SDK sends `input: [...]`, MiniMax wants `texts: [...]`.
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
        } catch {
          // Body wasn't JSON — pass through untouched.
        }
      }
      const resp = await fetch(url, baseInit);
      // Rewrite response: MiniMax → `{vectors: [[...]]}`, AI SDK wants `{data: [{embedding}]}`.
      const contentType = resp.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const json = await resp.json();
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
      }
      return resp;
    }) as typeof fetch;
    return { baseURL, fetch: wrappedFetch };
  },
  setup_hint:
    'Get an API key at https://www.minimaxi.com, then `export MINIMAX_API_KEY=...`',
};
