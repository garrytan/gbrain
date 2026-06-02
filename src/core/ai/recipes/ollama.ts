import type { Recipe } from '../types.ts';

export const ollama: Recipe = {
  id: 'ollama',
  name: 'Ollama (local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:11434/v1',
  auth_env: {
    required: [], // Ollama runs unauthenticated locally; users pass `ollama` as the key.
    optional: ['OLLAMA_BASE_URL', 'OLLAMA_API_KEY'],
    setup_url: 'https://ollama.ai',
  },
  touchpoints: {
    embedding: {
      models: ['nomic-embed-text', 'mxbai-embed-large', 'bge-m3', 'all-minilm'],
      default_dims: 768, // nomic-embed-text native dim
      fixed_dims_by_model: {
        'nomic-embed-text': 768,
        'mxbai-embed-large': 1024,
        'bge-m3': 1024,
        'all-minilm': 384,
      },
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-04-20',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
    },
  },
  aliases: {
    'nomic-embed-text:latest': 'nomic-embed-text',
    'mxbai-embed-large:latest': 'mxbai-embed-large',
    'bge-m3:latest': 'bge-m3',
    'all-minilm:latest': 'all-minilm',
  },
  setup_hint: 'Install Ollama from https://ollama.ai, then `ollama pull nomic-embed-text` and `ollama serve`.',
};
