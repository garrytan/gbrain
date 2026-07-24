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
      // #2271: modern local embed models added so assertTouchpoint accepts them.
      models: [
        'nomic-embed-text',
        'bge-m3',
        'mxbai-embed-large',
        'all-minilm',
        'qwen3-embed-8b',
        'snowflake-arctic-embed-l-v2',
      ],
      default_dims: 768, // nomic-embed-text native dim (fallback for models absent from model_dims)
      // #2170: Ollama models emit DIFFERENT fixed native widths, but one
      // provider-wide default_dims silently built a 768d schema for 1024d
      // models (bge-m3, mxbai-embed-large) → `gbrain embed` then failed with a
      // dim mismatch. Declare each model's real native width so the schema is
      // sized correctly with no --embedding-dimensions flag.
      model_dims: {
        'nomic-embed-text': 768,
        'bge-m3': 1024,
        'mxbai-embed-large': 1024,
        'all-minilm': 384,
        'qwen3-embed-8b': 4096,
        'snowflake-arctic-embed-l-v2': 1024,
      },
      trust_custom_dims: true, // #2271: locally-pulled model variants may carry non-listed dims
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-04-20',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
    },
  },
  setup_hint: 'Install Ollama from https://ollama.ai, then `ollama pull nomic-embed-text` and `ollama serve`.',
};
