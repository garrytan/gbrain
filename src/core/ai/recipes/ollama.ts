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
      models: ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm'],
      default_dims: 768, // nomic-embed-text native dim
      // BENCH Mur A: allow 1024d local multilingual embedders (bge-m3,
      // multilingual-e5-large, snowflake-arctic-embed2). Native dims of
      // the model; ollama returns them verbatim (dims.ts emits no
      // dimensions field for the ollama openai-compat path).
      dims_options: [768, 1024],
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-04-20',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
    },
  },
  setup_hint: 'Install Ollama from https://ollama.ai, then `ollama pull nomic-embed-text` and `ollama serve`.',
};
