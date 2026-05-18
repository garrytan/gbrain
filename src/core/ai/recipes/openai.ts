import type { Recipe } from '../types.ts';

export const openai: Recipe = {
  id: 'openai',
  name: 'OpenAI',
  tier: 'native',
  implementation: 'native-openai',
  auth_env: {
    required: ['OPENAI_API_KEY'],
    optional: ['OPENAI_ORG_ID', 'OPENAI_PROJECT'],
    setup_url: 'https://platform.openai.com/api-keys',
  },
  touchpoints: {
    embedding: {
      models: ['text-embedding-3-large', 'text-embedding-3-small'],
      default_dims: 1536,
      dims_options: [256, 512, 768, 1024, 1536, 3072],
      cost_per_1m_tokens_usd: 0.13,
      price_last_verified: '2026-04-20',
      // OpenAI's documented per-request embedding token cap is 300K. Without
      // a declared batch cap, a single page whose chunks sum past 300K
      // tokens (e.g. vendored Unicode tables, large generated code) is
      // rejected by the API and the whole page is dropped from indexing.
      // Closes #1080: gateway-level pre-split is the safety net. The shrink-
      // on-miss fallback in embedSubBatch handles tokenizer-density variance.
      max_batch_tokens: 300_000,
      chars_per_token: 4, // tiktoken English avg
    },
    expansion: {
      models: ['gpt-5.2', 'gpt-4o-mini'],
      cost_per_1m_tokens_usd: 0.15,
      price_last_verified: '2026-04-20',
    },
    chat: {
      models: ['gpt-5.2', 'gpt-4o-mini'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      cost_per_1m_input_usd: 1.25, // gpt-5.2 baseline
      cost_per_1m_output_usd: 10.0,
      price_last_verified: '2026-04-20',
    },
  },
  setup_hint: 'Get an API key at https://platform.openai.com/api-keys, then `export OPENAI_API_KEY=...`',
};
