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
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-04-20',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
    },
    expansion: {
      // Advisory local-model entry points. Ollama accepts arbitrary installed
      // model ids on the openai-compatible tier; users can still configure
      // ollama:<any-local-model>.
      models: ['qwen3.6:27b', 'qwen3.6:8b', 'llama3.2', 'mistral'],
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-05-25',
    },
    chat: {
      // Same advisory list as expansion. The gateway routes chat through
      // Ollama's native /api/chat endpoint so thinking models can run with
      // think:false; the /v1 OpenAI-compatible endpoint does not expose that
      // knob reliably.
      models: ['qwen3.6:27b', 'qwen3.6:8b', 'llama3.2', 'mistral'],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-05-25',
    },
  },
  setup_hint: 'Install Ollama from https://ollama.ai, then `ollama pull nomic-embed-text` for embeddings and `ollama pull qwen3.6:27b` (or another local chat model) for chat/expansion. Run `ollama serve`.',
};
