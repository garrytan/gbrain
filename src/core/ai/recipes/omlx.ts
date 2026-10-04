import type { Recipe } from '../types.ts';

/**
 * oMLX (jundot/omlx) — local OpenAI-compatible inference server for Apple
 * Silicon. Serves chat/completions/embeddings on a `/v1` endpoint, but its
 * multimodal embedding wire shape deviates from OpenAI's content-array
 * convention: `/v1/embeddings` accepts plain-string `input` for text, and
 * structured `items: [{text}, {image}]` (data-URL or path strings) for
 * multimodal models like Qwen3-VL-Embedding (omlx PRs #369/#373, v0.3.0rc1+).
 *
 * Without a translation shim, gbrain's openai-compatible path sends
 * `input: [{type:'input_text'|'image_url',...}]`, which oMLX rejects
 * ("Input should be a valid string") — the same class of mismatch LM Studio
 * has with embedding-type models (#1908). This recipe ships a compat fetch
 * that rewrites the multimodal content-array body into oMLX's `items` form
 * before the request leaves the gateway, so `omlx:Qwen3-VL-Embedding-2B-mlx`
 * works as a first-class multimodal embedding model with no sidecar proxy.
 *
 * Fail-open: any body that doesn't parse as a gbrain multimodal embeddings
 * request is forwarded untouched.
 */

// Cast through `unknown` — the shim omits `preconnect` (matches azure-openai.ts).
export const omlxEmbeddingsCompatFetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> => {
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === 'POST' && url.includes('/embeddings') && typeof init.body === 'string') {
      const body = JSON.parse(init.body);
      // Rewrite OpenAI content-array `input` → oMLX `items`. Each gbrain
      // multimodal request carries exactly one content entry (see
      // embedMultimodalOpenAICompat), but handle N entries defensively.
      if (Array.isArray(body.input) && body.input.some((item: any) => item && typeof item === 'object')) {
        const items = body.input.map((item: any) => {
          if (item.type === 'image_url' && item.image_url?.url) return { image: item.image_url.url };
          if (item.type === 'input_text') return { text: item.text ?? '' };
          return { text: String(item) };
        });
        const rewritten: Record<string, unknown> = { ...body, items };
        delete rewritten.input;
        // oMLX defaults to the model's native width (VL-Embedding-2B is
        // 2048-native). Inject the Matryoshka target so the response matches
        // the brain's vector column; OMLX_EMBEDDING_DIMENSIONS overrides.
        if (typeof rewritten.dimensions !== 'number') {
          const declared = Number(process.env.OMLX_EMBEDDING_DIMENSIONS);
          rewritten.dimensions = Number.isFinite(declared) && declared > 0 ? declared : 1024;
        }
        init = { ...init, body: JSON.stringify(rewritten) };
      }
    }
  } catch {
    // Fail-open: unparseable body passes through untouched.
  }
  return fetch(input as any, init as any);
}) as unknown as typeof fetch;

export const omlx: Recipe = {
  id: 'omlx',
  name: 'oMLX (local, Apple Silicon)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:1216/v1',
  auth_env: {
    // oMLX requires a Bearer token when an API key is configured server-side;
    // local unauthenticated setups leave OMLX_API_KEY unset and the default
    // resolver sends `Bearer undefined` — oMLX ignores it. Declare optional
    // so both shapes validate.
    required: [],
    optional: ['OMLX_BASE_URL', 'OMLX_API_KEY'],
    setup_url: 'https://github.com/jundot/omlx',
  },
  compat: {
    fetch: omlxEmbeddingsCompatFetch,
  },
  probe: async (baseURL?: string) => {
    const base = (baseURL ?? 'http://localhost:1216').replace(/\/v1\/?$/, '');
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok
        ? { ready: true }
        : { ready: false, hint: `oMLX at ${base} returned ${res.status}. Is \`omlx serve\` running?` };
    } catch {
      return { ready: false, hint: `oMLX at ${base} is unreachable. Is \`omlx serve\` running?` };
    }
  },
  touchpoints: {
    embedding: {
      models: [
        'Qwen3-Embedding-0.6B-mxfp8',
        'Qwen3-Embedding-8B-mxfp8',
        'Qwen3-VL-Embedding-2B-mlx',
        'Qwen3-VL-Embedding-2B-bf16',
        'Qwen3-VL-Embedding-2B-mxfp8',
      ],
      model_dims: {
        // Qwen3-Embedding family native dims (2B=1536, 8B=4096); the 0.6B
        // variant is 1024-native. VL-Embedding-2B is 2048-native but honors
        // Matryoshka `dimensions` down to 1024 (verified live 2026-10-04).
        'Qwen3-Embedding-0.6B-mxfp8': 1024,
        'Qwen3-Embedding-8B-mxfp8': 4096,
        'Qwen3-VL-Embedding-2B-mlx': 1024,
        'Qwen3-VL-Embedding-2B-bf16': 1024,
        'Qwen3-VL-Embedding-2B-mxfp8': 1024,
      },
      default_dims: 1024,
      dims_options: [1024, 1536, 2048],
      trust_custom_dims: true,
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-10-04',
      no_batch_cap: true,
      supports_multimodal: true,
      multimodal_models: [
        'Qwen3-VL-Embedding-2B-mlx',
        'Qwen3-VL-Embedding-2B-bf16',
        'Qwen3-VL-Embedding-2B-mxfp8',
      ],
    },
    expansion: {
      models: [],
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-10-04',
    },
    chat: {
      models: [],
      supports_tools: true,
      supports_subagent_loop: false,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-10-04',
    },
  },
  setup_hint: 'Run `omlx serve` (https://github.com/jundot/omlx); point OMLX_BASE_URL at its /v1 endpoint.',
};
