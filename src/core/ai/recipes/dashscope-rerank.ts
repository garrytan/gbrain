import type { Recipe } from '../types.ts';

/**
 * Alibaba DashScope (灵积) reranker. DashScope's OpenAI-compatible surface
 * splits by capability: embeddings live under `/compatible-mode/v1` (see the
 * sibling `dashscope` recipe) while rerank lives under `/compatible-api/v1`
 * with a PLURAL leaf — `POST {base}/reranks`. Wire shape matches ZeroEntropy:
 * request `{model, query, documents, top_n?}`, response
 * `{results: [{index, relevance_score}]}` — so it rides gateway.rerank()'s
 * native path with only the recipe-pluggable `path` override (v0.40.6.1).
 *
 * This is a SEPARATE recipe rather than a reranker touchpoint on `dashscope`
 * because the two capabilities need different base URLs (`compatible-mode`
 * vs `compatible-api`) and `provider_base_urls` is keyed by recipe id — one
 * recipe can't point embeddings and rerank at different prefixes. Same
 * topology precedent as llama-server vs llama-server-reranker.
 *
 * Live-verified against the China endpoint (2026-07): `/reranks` with
 * `qwen3-rerank` → 200 `results[].relevance_score`; `/rerank` (singular)
 * → 404; `gte-rerank-v2` → 404 "Unsupported model for OpenAI compatibility
 * mode" (native-API only, so it is deliberately NOT listed here).
 *
 * Note: the international endpoint requires a region-aware DASHSCOPE_API_KEY.
 * China-region users point at https://dashscope.aliyuncs.com/compatible-api/v1
 * via `provider_base_urls['dashscope-rerank']`, mirroring the embedding
 * recipe's convention.
 */
export const dashscopeRerank: Recipe = {
  id: 'dashscope-rerank',
  name: 'Alibaba DashScope (灵积, reranker)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://dashscope-intl.aliyuncs.com/compatible-api/v1',
  auth_env: {
    required: ['DASHSCOPE_API_KEY'],
    setup_url: 'https://help.aliyun.com/zh/model-studio/getting-started/',
  },
  touchpoints: {
    reranker: {
      // Only the model verified live on the OpenAI-compat /reranks surface.
      // gte-rerank-v2 exists on DashScope's native API but the compat path
      // rejects it ("Unsupported model for OpenAI compatibility mode").
      models: ['qwen3-rerank'],
      default_model: 'qwen3-rerank',
      // Mirror ZE's defensive per-request ceiling; gateway.rerank()
      // pre-flights body size and fails open.
      max_payload_bytes: 5_000_000,
      // PLURAL leaf under compatible-api — the whole reason this recipe
      // exists. `${base_url}${path}` → `…/compatible-api/v1/reranks`.
      path: '/reranks',
      // Hosted API: no local warmup, but cross-region latency can exceed
      // the 5s gateway default (same rationale as llama-server-reranker).
      default_timeout_ms: 30_000,
    },
  },
  setup_hint:
    'Get an API key at https://help.aliyun.com/zh/model-studio/getting-started/, then ' +
    '`export DASHSCOPE_API_KEY=...` and `gbrain config set search.reranker.model ' +
    'dashscope-rerank:qwen3-rerank`. China-region accounts: `gbrain config set ' +
    'provider_base_urls.dashscope-rerank https://dashscope.aliyuncs.com/compatible-api/v1`.',
};
