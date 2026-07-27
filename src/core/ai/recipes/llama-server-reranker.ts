import type { Recipe } from '../types.ts';

/**
 * llama.cpp's `llama-server --reranking` exposes a cross-encoder reranker
 * over an OpenAI-style HTTP surface. Distinct from the sibling `llama-server`
 * recipe (which serves embeddings) because `--reranking` and `--embeddings`
 * are mutually exclusive at server-launch time — one process can't do both,
 * so two recipes with independent base URLs is the cleanest topology.
 *
 * Wire shape matches ZeroEntropy: request is `{model, query, documents,
 * top_n?}`, response is `{results: [{index, relevance_score}]}`. Path is
 * the only delta — llama-server serves `/rerank` under its `/v1` prefix.
 * Because the recipe's `base_url_default` already ends in `/v1` (matching
 * the convention every other openai-compat recipe uses), the touchpoint
 * `path` here is the LEAF only (`/rerank`); the gateway concatenates
 * `${base_url}${path}` to produce the actual `…/v1/rerank` URL.
 *
 * Like the embedding recipe, this ships with `models: []` because the model
 * identity is whatever the user launched llama-server with. Users MUST set
 * `search.reranker.model llama-server-reranker:<id>` where `<id>` matches
 * the `--alias` they passed at launch — without `--alias`, `/v1/models`
 * defaults the id to the gguf file path, which makes provider:model strings
 * ugly. The setup_hint guides them.
 *
 * Reference:
 *   https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
 *
 * Covers two user-facing cases:
 *   - Qwen3-Reranker (0.6B / 4B / 8B) GGUF via llama.cpp
 *   - ZeroEntropy zerank-2 / zerank-1-small self-hosted via llama.cpp
 *     (FEASIBLE — wire shapes match — but quality parity with ZE-hosted is
 *     NOT guaranteed; users self-hosting ZE should pin their own eval)
 */
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
      // Match ZE's per-request cap; llama.cpp has no upstream cap of its
      // own but the pre-flight guard is a defensive ceiling.
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
