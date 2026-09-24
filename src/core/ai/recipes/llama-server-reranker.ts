import type { Recipe } from '../types.ts';

export const llamaServerReranker: Recipe = {
  id: 'llama-server-reranker',
  name: 'llama.cpp llama-server (reranker, local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  // Distinct default port from the embedding recipe (8080) so a user
  // running both locally can keep them on separate servers.
  base_url_default: 'http://localhost:8081/v1',
  auth_env: {
    required: [],
    optional: ['LLAMA_SERVER_RERANKER_BASE_URL', 'LLAMA_SERVER_RERANKER_API_KEY'],
    setup_url:
      'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
  },
  touchpoints: {
    reranker: {
      models: [], // user-provided; whatever model the server was launched with
      // Informational placeholder for docs/wizard copy. Real model id is set
      // by the user via `gbrain config set search.reranker.model
      // llama-server-reranker:<--alias value>`.
      default_model: 'qwen3-reranker-4b',
      // Local inference cost — consumed by budget-tracker.ts's rerank
      // pricing lookup (via FREE_LOCAL_RERANK_PROVIDERS) so callers with
      // `--max-cost` don't hard-fail. NOT for API billing; local rerank
      // costs electricity, not tokens.
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-05-23',
      max_payload_bytes: 5_000_000,
      // Leaf-only path. `base_url_default` already provides the `/v1`
      // prefix; the gateway concatenates the two to call `…/v1/rerank`.
      // llama-server also serves `/reranking`, `/v1/reranking`, and bare
      // `/rerank` aliases — we pin the OpenAI-style `/rerank` path under
      // the existing `/v1` prefix.
      path: '/rerank',
      // CPU-only first-call warmup on a 4B cross-encoder can take 8-15s.
      // The default 5s in gateway.ts:DEFAULT_RERANK_TIMEOUT_MS would
      // fail-open silently. Caller's `input.timeoutMs` and the
      // `search.reranker.timeout_ms` config key still win when set.
      default_timeout_ms: 30_000,
    },
  },
  setup_hint:
    'Build llama.cpp, then `llama-server --model <gguf-path> --alias ' +
    '<short-id> --reranking --port 8081`. The --alias makes provider:model ' +
    'strings short (without it, /v1/models defaults the id to the gguf file ' +
    'path). Then `gbrain config set search.reranker.model ' +
    'llama-server-reranker:<short-id>` and `gbrain config set ' +
    'provider_base_urls.llama-server-reranker http://<host>:8081/v1`.',
};
