import type { Recipe } from '../types.ts';

/**
 * Anthropic provides language models (expansion + chat) only.
 * Claude has no first-party embedding model as of v0.27 ship date. Users who
 * want a fully Anthropic stack would still use OpenAI or Google for embedding.
 */
export const anthropic: Recipe = {
  id: 'anthropic',
  name: 'Anthropic',
  tier: 'native',
  implementation: 'native-anthropic',
  auth_env: {
    required: ['ANTHROPIC_API_KEY'],
    setup_url: 'https://console.anthropic.com/settings/keys',
  },
  touchpoints: {
    // No embedding model available.
    expansion: {
      models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6-20250929'],
      cost_per_1m_tokens_usd: 0.25,
      price_last_verified: '2026-04-20',
    },
    chat: {
      models: [
        'claude-opus-4-7',
        'claude-sonnet-4-6-20250929',
        'claude-haiku-4-5-20251001',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: true,
      max_context_tokens: 200000,
      cost_per_1m_input_usd: 3.0, // sonnet-class baseline
      cost_per_1m_output_usd: 15.0,
      price_last_verified: '2026-04-20',
    },
  },
  // Friendly undated aliases (Codex F-OV-5).
  aliases: {
    'claude-sonnet-4-6': 'claude-sonnet-4-6-20250929',
    'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  },
  setup_hint: 'Get an API key at https://console.anthropic.com/settings/keys, then `export ANTHROPIC_API_KEY=...`',
};
