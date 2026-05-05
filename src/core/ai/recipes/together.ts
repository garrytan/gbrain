import type { Recipe } from '../types.ts';

/**
 * Together AI hosts open-weights models on shared infrastructure with an
 * OpenAI-compatible endpoint. House for Qwen, Llama-3.3-70B-Turbo, and other
 * non-frontier models that sit between DeepSeek's price and Groq's speed.
 */
export const together: Recipe = {
  id: 'together',
  name: 'Together AI',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.together.xyz/v1',
  auth_env: {
    required: ['TOGETHER_API_KEY'],
    setup_url: 'https://api.together.ai/settings/api-keys',
  },
  touchpoints: {
    chat: {
      models: [
        'Qwen/Qwen2.5-72B-Instruct-Turbo',
        'meta-llama/Llama-3.3-70B-Instruct-Turbo',
        'deepseek-ai/DeepSeek-V3',
        'mistralai/Mixtral-8x22B-Instruct-v0.1',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 131072,
      cost_per_1m_input_usd: 0.88, // Llama-3.3-70B-Turbo baseline
      cost_per_1m_output_usd: 0.88,
      price_last_verified: '2026-04-20',
    },
  },
  setup_hint: 'Get an API key at https://api.together.ai/settings/api-keys, then `export TOGETHER_API_KEY=...`',
};
