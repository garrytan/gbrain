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
        'mxbai-embed-large',
        'all-minilm',
        'qwen3-embed-8b',
        'snowflake-arctic-embed-l-v2',
        'bge-m3',
      ],
      // #2051: per-model native dims. Ollama serves models spanning 384..4096,
      // so the recipe-wide default_dims below is only correct for nomic. Without
      // this map `init --embedding-model ollama:bge-m3` built a 768-wide column
      // for a model that emits 1024, and the mismatch only surfaced at first
      // insert. Resolved via `embeddingDimsForModel()`; unlisted models still
      // fall back to default_dims, and trust_custom_dims keeps an explicit
      // --embedding-dimensions override working for models not named here.
      model_dims: {
        'nomic-embed-text': 768,
        'mxbai-embed-large': 1024,
        'all-minilm': 384,
        'qwen3-embed-8b': 4096,
        'snowflake-arctic-embed-l-v2': 1024,
        'bge-m3': 1024,
      },
      default_dims: 768, // nomic-embed-text native dim
      trust_custom_dims: true, // #2271: local models carry varied native dims
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-04-20',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
    },
    expansion: {
      models: ['qwen2.5-coder:14b'],
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-06-26',
    },
    chat: {
      // Model ids are user-managed; this informational default makes the chat
      // capability visible in provider discovery without constraining custom tags.
      models: ['qwen2.5-coder:14b'],
      // Chat completion is provider-wide, but tool support varies by loaded
      // model. Keep the subagent capability gate conservative.
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      supports_structured_outputs: false,
      // Provider-wide routing ceiling only; Ollama still enforces each loaded
      // model's actual context window at request time.
      max_context_tokens: 128_000,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-08-18',
      // Local cold starts can exceed the generic 5-second provider probe.
      default_timeout_ms: 180_000,
    },
  },
  setup_hint: 'Install Ollama from https://ollama.ai, then `ollama pull nomic-embed-text` for embeddings and `ollama pull qwen2.5-coder:14b` for local chat. Start it with `ollama serve`. Custom local model tags are accepted.',
};
