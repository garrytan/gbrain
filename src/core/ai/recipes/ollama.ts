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
    expansion: {
      // Desktop ordinary-model saves intentionally route query expansion to
      // the same model as chat. Ollama model ids are installation-specific.
      models: [],
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-07-17',
    },
    chat: {
      // Ollama exposes OpenAI-compatible chat completions. The concrete model
      // list is installation-specific and is discovered from /api/tags by the
      // desktop app, so the recipe intentionally does not hard-code models.
      models: [],
      supports_tools: true,
      // PMBrain routes non-Anthropic subagents through the canonical gateway
      // tool loop, which generates and persists its own stable execution ids.
      // Verified against the local Ollama OpenAI/tool-call surface; individual
      // models that do not implement tools still fail with their native error.
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-07-17',
    },
    embedding: {
      models: ['nomic-embed-text', 'mxbai-embed-large', 'all-minilm'],
      default_dims: 768, // nomic-embed-text native dim
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-04-20',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
    },
  },
  setup_hint: 'Install Ollama from https://ollama.ai, pull a chat or embedding model, then run `ollama serve`.',
};
