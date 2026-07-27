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
    embedding: {
      models: ['text-embedding-v3', 'text-embedding-v2'],
      default_dims: 1024,
      dims_options: [64, 128, 256, 512, 768, 1024],
      // Alibaba doesn't publish a hard batch-token cap for the OpenAI-compat
      // path. Conservative declaration so the gateway pre-splits before
      // hitting whatever undocumented server-side limit exists.
      max_batch_tokens: 8192,
      // text-embedding-v3 mixes English + CJK heavily; the tokenizer is
      // closer to Voyage density than OpenAI tiktoken for CJK-dominant
      // content. Conservative chars_per_token=2 leaves headroom.
      chars_per_token: 2,
    },
  },
  setup_hint:
    'Get an API key at https://help.aliyun.com/zh/model-studio/getting-started/, then `export DASHSCOPE_API_KEY=...`',
};
