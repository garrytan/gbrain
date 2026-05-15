import type { Recipe } from '../types.ts';

export const lmstudio: Recipe = {
  id: 'lmstudio',
  name: 'LM Studio (local MLX)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:1234/v1',
  auth_env: {
    required: [], // LM Studio runs unauthenticated locally; users pass `lm-studio` as the key.
    optional: ['LMSTUDIO_BASE_URL', 'LMSTUDIO_API_KEY'],
    setup_url: 'https://lmstudio.ai',
  },
  touchpoints: {
    embedding: {
      models: [
        'text-embedding-nomic-embed-text-v1.5',
        'nomic-embed-text-v1.5',
        'text-embedding-bge-large-en-v1.5',
        'text-embedding-mxbai-embed-large-v1',
      ],
      default_dims: 768, // nomic-embed-text-v1.5 native dim
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-05-15',
      // LM Studio's batch capacity depends on the loaded model + the
      // operator's chosen context window; no static cap to declare.
      no_batch_cap: true,
    },
  },
  setup_hint: 'Install LM Studio from https://lmstudio.ai, load `text-embedding-nomic-embed-text-v1.5` (or another embedding model), and start the server on port 1234 (Developer tab → Start Server).',
};
