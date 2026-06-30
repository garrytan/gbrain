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
      // Native dims (verified against ollama.com/library, 2026-06):
      // nomic-embed-text 768, mxbai-embed-large 1024, all-minilm 384,
      // bge-m3 1024 (dense), snowflake-arctic-embed2 1024. The per-model
      // native dim is the single source of truth in dims.ts:OLLAMA_NATIVE_DIMS
      // (drives both init-time column sizing and dim validation). default_dims
      // below is only the shorthand-pick fallback (models[0] = nomic).
      models: [
        'nomic-embed-text',
        'mxbai-embed-large',
        'all-minilm',
        'bge-m3',
        'snowflake-arctic-embed2',
      ],
      default_dims: 768, // nomic-embed-text native dim (shorthand `--model ollama` default)
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-04-20',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
    },
  },
  setup_hint:
    'Install Ollama from https://ollama.ai, then `ollama pull <model>` and `ollama serve`. ' +
    'Non-default models (e.g. bge-m3, mxbai-embed-large — 1024-dim) need their native ' +
    '--embedding-dimensions; gbrain fills it in for known models. The embedding dim is ' +
    'sized into the schema at init, so switching models later is a re-init, not an ALTER.',
};
