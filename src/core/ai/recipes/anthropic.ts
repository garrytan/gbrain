import type { Recipe } from '../types.ts';

/**
 * Anthropic provides language models (expansion, future chunking/enrich) only.
 * Claude has no first-party embedding model as of v0.14 ship date. Users who
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
  },
  setup_hint: 'Get an API key at https://console.anthropic.com/settings/keys, then `export ANTHROPIC_API_KEY=...`',
};
