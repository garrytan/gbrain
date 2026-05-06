import type { Recipe } from '../types.ts';

/**
 * GitHub Copilot / Blackbird embeddings.
 *
 * This is not OpenAI-compatible: GitHub's endpoint accepts `{ inputs, model }`
 * and returns `{ embeddings: [{ embedding }] }`, so gateway.ts handles it as a
 * dedicated recipe implementation.
 */
export const copilot: Recipe = {
  id: 'copilot',
  name: 'GitHub Copilot embeddings',
  tier: 'native',
  implementation: 'native-copilot',
  auth_env: {
    required: [],
    optional: [
      'GBRAIN_COPILOT_TOKEN',
      'COPILOT_GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GBRAIN_COPILOT_EMBEDDING_URL',
    ],
    setup_url: 'https://github.com/features/copilot',
  },
  touchpoints: {
    embedding: {
      models: ['metis-1024-I16-Binary'],
      default_dims: 1024,
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-05-06',
    },
  },
  aliases: {
    blackbird: 'metis-1024-I16-Binary',
    metis: 'metis-1024-I16-Binary',
  },
  setup_hint: 'Use GitHub Copilot login or set GBRAIN_COPILOT_TOKEN. Configure `GBRAIN_EMBEDDING_MODEL=copilot:metis-1024-I16-Binary` and `GBRAIN_EMBEDDING_DIMENSIONS=1024`.',
};
