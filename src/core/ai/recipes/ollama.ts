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
      models: ['nomic-embed-text', 'qwen3-embedding:0.6b', 'qwen3-embedding', 'mxbai-embed-large', 'bge-m3', 'all-minilm'],
      default_dims: 768, // nomic-embed-text native dim
      model_dims: {
        'nomic-embed-text': 768,
        'qwen3-embedding:0.6b': 1024,
        'qwen3-embedding': 4096,
        'mxbai-embed-large': 1024,
        'bge-m3': 1024,
        'all-minilm': 384,
      },
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-06-06',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
    },
  },
  setup_hint: 'Install Ollama from https://ollama.ai, then `ollama pull nomic-embed-text` (or `ollama pull qwen3-embedding:0.6b`) and `ollama serve`.',
};
