import type { Recipe } from '../types.ts';

export const openrouter: Recipe = {
  id: 'openrouter',
  name: 'OpenRouter',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://openrouter.ai/api/v1',
  auth_env: {
    required: ['OPENROUTER_API_KEY'],
    optional: ['OPENROUTER_BASE_URL'],
    setup_url: 'https://openrouter.ai/settings/keys',
  },
  touchpoints: {
    embedding: {
      models: ['openai/text-embedding-3-small'],
      default_dims: 1536,
      cost_per_1m_tokens_usd: 0.02,
      price_last_verified: '2026-05-19',
      max_batch_tokens: 8192,
    },
    chat: {
      models: [
        'openai/gpt-5.2',
        'anthropic/claude-haiku-4.5',
        'google/gemini-3-flash',
        'deepseek/deepseek-chat',
      ],
      supports_tools: true,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      price_last_verified: '2026-05-19',
    },
  },
  setup_hint: 'Get an API key at https://openrouter.ai/settings/keys, then `export OPENROUTER_API_KEY=...` and use `openrouter:<model-id>`.',
};
