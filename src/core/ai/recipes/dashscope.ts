import type { Recipe } from '../types.ts';

/**
 * Alibaba DashScope (灵积). OpenAI-compatible /embeddings endpoint at
 * dashscope-intl.aliyuncs.com. Hosts text-embedding-v2 (older) and
 * text-embedding-v3 (current; Matryoshka-aware up to 1024 dims).
 *
 * Reference: https://help.aliyun.com/zh/model-studio/getting-started/
 *
 * Note: the international endpoint requires a region-aware DASHSCOPE_API_KEY.
 * China-region users typically point at https://dashscope.aliyuncs.com/...
 * via cfg.base_urls['dashscope']. v0.32 ships with the international
 * default; users override per the recipe convention.
 */
export const dashscope: Recipe = {
  id: 'dashscope',
  name: 'Alibaba DashScope (灵积)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  auth_env: {
    required: ['DASHSCOPE_API_KEY'],
    setup_url: 'https://help.aliyun.com/zh/model-studio/getting-started/',
  },
  touchpoints: {
    chat: {
      // DashScope OpenAI-compatible /chat/completions — Qwen series.
      // qwen-max: strongest reasoning (think/deep tier)
      // qwen-plus: balanced cost/quality (judge/utility tier)
      // qwen-turbo: fastest/cheapest (lightweight tasks)
      models: ['qwen3.7-plus', 'qwen3.7-max', 'qwen3-plus', 'qwen3-max', 'qwen-max', 'qwen-plus', 'qwen-turbo'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 131072,
      // Pricing is extremely low (~¥0.004/1k tokens for qwen-plus);
      // cost gating is effectively a non-issue. USD estimates below.
      cost_per_1m_input_usd: 0.14,  // qwen-plus approximate
      cost_per_1m_output_usd: 0.56,
      price_last_verified: '2026-07-02',
    },
    embedding: {
      models: ['text-embedding-v3', 'text-embedding-v2'],
      default_dims: 1024,
      dims_options: [64, 128, 256, 512, 768, 1024],
      // Alibaba doesn't publish a hard batch-token cap for the OpenAI-compat
      // path. Conservative declaration so the gateway pre-splits before
      // hitting whatever undocumented server-side limit exists.
      max_batch_tokens: 8192,
      // DashScope rejects batches >10 items regardless of token count.
      max_batch_items: 10,
      // text-embedding-v3 mixes English + CJK heavily; the tokenizer is
      // closer to Voyage density than OpenAI tiktoken for CJK-dominant
      // content. Conservative chars_per_token=2 leaves headroom.
      chars_per_token: 2,
    },
  },
  setup_hint:
    'Get an API key at https://help.aliyun.com/zh/model-studio/getting-started/, then `export DASHSCOPE_API_KEY=...`',
};
