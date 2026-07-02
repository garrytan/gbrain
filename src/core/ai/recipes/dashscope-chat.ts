import type { Recipe } from '../types.ts';

/**
 * Alibaba DashScope Chat (百炼). OpenAI-compatible /v1/chat/completions
 * endpoint for Qwen series chat models. Distinct from the `dashscope`
 * recipe which is embedding-only.
 *
 * Reference: https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
 */
export const dashscopeChat: Recipe = {
  id: 'dashscope-chat',
  name: 'DashScope Chat (Qwen)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  auth_env: {
    required: ['DASHSCOPE_API_KEY'],
    setup_url: 'https://help.aliyun.com/zh/model-studio/getting-started/',
  },
  touchpoints: {
    chat: {
      models: ['qwen3.7-plus'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 1000000,
      cost_per_1m_input_usd: 0.32,
      cost_per_1m_output_usd: 1.28,
      price_last_verified: '2026-06-25',
    },
  },
  setup_hint:
    'Shares DASHSCOPE_API_KEY with the `dashscope` embedding recipe. Get a key at https://help.aliyun.com/zh/model-studio/getting-started/',
};
