import type { Recipe } from '../types.ts';

/**
 * MiniMax transport shim (#1977). MiniMax's `/v1/embeddings` endpoint is NOT
 * OpenAI-compatible at the wire level despite the recipe's
 * `implementation: 'openai-compatible'`:
 *  - Request: requires `texts` (the AI SDK sends `input`) plus an optional
 *    `type: 'db' | 'query'` asymmetric-retrieval field, and rejects OpenAI's
 *    `encoding_format`.
 *  - Response: returns `{vectors: number[][], total_tokens}` where the AI
 *    SDK's Zod schema expects `{data: [{embedding, index}], usage}`.
 *
 * Chat (`/chat/completions`) IS OpenAI-compatible, and this same fetch is
 * applied to every openai-compatible touchpoint by `applyOpenAICompatConfig`,
 * so everything outside the embeddings path passes through untouched — and
 * the response rewrite parses via `resp.clone()` only (never consume the
 * body of a response we return as-is; the DeepSeek shim rule). Fail-open:
 * any rewrite error returns the original request/response.
 *
 * @internal exported for tests.
 */
// Cast through `unknown` because Bun's `typeof fetch` carries a `preconnect`
// member the arrow function does not implement (matches deepseek.ts).
export const minimaxCompatFetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const isEmbeddings = url.includes('/embeddings');

  // OUTBOUND (embeddings only): `input` → `texts`, default `type: 'db'`
  // (the recipe's documented symmetric default — the AI SDK adapter strips
  // the `type` threaded via providerOptions before it reaches the wire,
  // same class as #1400), and drop `encoding_format` (not a MiniMax param).
  if (isEmbeddings && init?.body && typeof init.body === 'string') {
    try {
      const parsed = JSON.parse(init.body);
      if (
        parsed && typeof parsed === 'object' &&
        parsed.input !== undefined && parsed.texts === undefined
      ) {
        parsed.texts = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
        delete parsed.input;
        delete parsed.encoding_format;
        if (parsed.type === undefined) parsed.type = 'db';
        // Drop Content-Length so fetch recomputes from the new body.
        const headers = new Headers(init.headers ?? {});
        headers.delete('content-length');
        init = { ...init, body: JSON.stringify(parsed), headers };
      }
    } catch {
      // Body wasn't JSON — pass through untouched.
    }
  }

  const res = await fetch(input as any, init as any);

  // INBOUND (embeddings only): `{vectors: [[...]]}` → `{data: [{embedding}]}`.
  // Anything else (chat completions, MiniMax base_resp errors, non-JSON)
  // returns the ORIGINAL response with its body unread.
  if (!isEmbeddings || !res.ok) return res;
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.toLowerCase().includes('application/json')) return res;
  try {
    const json = await res.clone().json();
    if (!json || typeof json !== 'object' || !Array.isArray(json.vectors)) return res;
    const totalTokens = typeof json.total_tokens === 'number' ? json.total_tokens : 0;
    const rewritten = {
      object: 'list',
      data: (json.vectors as number[][]).map((embedding, index) => ({
        object: 'embedding',
        embedding,
        index,
      })),
      model: typeof json.model === 'string' ? json.model : 'embo-01',
      usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
    };
    // Fresh header set: the body changed, so upstream content-length /
    // content-encoding would now be wrong.
    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(JSON.stringify(rewritten), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  } catch {
    return res;
  }
}) as unknown as typeof fetch;

/**
 * MiniMax (海螺AI). `/embeddings` endpoint at api.minimaxi.com (wire shape
 * normalized by `minimaxCompatFetch` above); OpenAI-compatible
 * `/chat/completions`. The flagship embedding model is `embo-01` (1536 dims).
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
      // Model list from MiniMax's /v1/models (#1977). Chat is genuinely
      // OpenAI-compatible — no wire rewrite needed (minimaxCompatFetch
      // passes non-embedding requests through untouched).
      models: [
        'MiniMax-M3',
        'MiniMax-M2.7',
        'MiniMax-M2.7-highspeed',
        'MiniMax-M2.5',
        'MiniMax-M2.5-highspeed',
        'MiniMax-M2.1',
        'MiniMax-M2.1-highspeed',
        'MiniMax-M2',
      ],
      supports_tools: false,
      supports_subagent_loop: false,
    },
  },
  setup_hint:
    'Get an API key at https://www.minimaxi.com, then `export MINIMAX_API_KEY=...`',
  compat: { fetch: minimaxCompatFetch },
};
