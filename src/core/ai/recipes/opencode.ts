import type { Recipe } from '../types.ts';

/**
 * OpenCode Zen exposes curated coding models behind OpenAI-compatible chat
 * completions for non-OpenAI/non-Anthropic models.
 *
 * The provider id is intentionally `opencode` so config reflects the account
 * and billing surface: one OpenCode Zen key can route DeepSeek, MiniMax, GLM,
 * Kimi, and other Zen-hosted models.
 */
export const opencode: Recipe = {
  id: 'opencode',
  name: 'OpenCode Zen',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://opencode.ai/zen/v1',
  auth_env: {
    required: ['OPENCODE_API_KEY'],
    setup_url: 'https://opencode.ai/auth',
  },
  touchpoints: {
    chat: {
      models: [
        'deepseek-v4-pro',
        'deepseek-v4-flash',
        'minimax-m3',
        'minimax-m2.7',
        'minimax-m2.5',
        'glm-5.2',
        'glm-5.1',
        'glm-5',
        'kimi-k2.7-code',
        'kimi-k2.6',
        'kimi-k2.5',
        'grok-build-0.1',
        'big-pickle',
        'mimo-v2.5-free',
        'north-mini-code-free',
        'nemotron-3-ultra-free',
        'deepseek-v4-flash-free',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 128000,
      price_last_verified: '2026-07-03',
    },
  },
  setup_hint: 'Create an OpenCode Zen API key at https://opencode.ai/auth, then `export OPENCODE_API_KEY=...` and use `opencode:<model-id>`.',
};
