import type { Recipe } from '../types.ts';

export const composioOpenAI: Recipe = {
  id: 'composio-openai',
  name: 'Composio OpenAI',
  tier: 'native',
  implementation: 'composio-openai',
  auth_env: {
    required: ['COMPOSIO_CLI'],
    setup_url: 'https://composio.dev',
  },
  touchpoints: {
    embedding: {
      models: ['text-embedding-3-large', 'text-embedding-3-small'],
      default_dims: 1536,
      dims_options: [256, 512, 768, 1024, 1536, 3072],
      cost_per_1m_tokens_usd: 0.13,
      price_last_verified: '2026-04-20',
      max_batch_tokens: 120000,
      chars_per_token: 4,
      safety_factor: 0.8,
    },
  },
  setup_hint:
    'Install and authenticate the Composio CLI, then set COMPOSIO_CLI to its absolute path. The raw OpenAI key remains inside Composio.',
};
