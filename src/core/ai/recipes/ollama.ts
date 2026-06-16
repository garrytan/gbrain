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
      models: ['qwen3-embedding:4b', 'qwen3-embedding', 'qwen3-embedding:0.6b', 'qwen3-embedding:8b', 'nomic-embed-text', 'mxbai-embed-large', 'all-minilm'],
      default_dims: 1536, // Qwen3-Embedding supports user-defined 32-4096 dims; keep existing OpenAI-sized brains compatible.
      dims_options: [768, 1024, 1536, 2048, 2560, 4096],
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-06-15',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
    },
  },
  setup_hint: 'Install Ollama from https://ollama.ai, then `ollama pull nomic-embed-text` and `ollama serve`.',
};
