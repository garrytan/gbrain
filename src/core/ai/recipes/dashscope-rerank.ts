import type { Recipe } from '../types.ts';

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
