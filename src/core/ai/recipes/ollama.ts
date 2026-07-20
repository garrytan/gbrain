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
      // Each carries its own native dim (qwen3-embed-8b=4096, arctic-l-v2=1024);
      // the recipe-wide default_dims below is only the nomic fallback, so users
      // of the larger models pass --embedding-dimensions (allowed via
      // trust_custom_dims). Per-model dims metadata is a tracked follow-up.
      models: [
        'nomic-embed-text',
        'mxbai-embed-large',
        'all-minilm',
        'qwen3-embed-8b',
        'snowflake-arctic-embed-l-v2',
      ],
      default_dims: 768, // nomic-embed-text native dim
      trust_custom_dims: true, // #2271: local models carry varied native dims
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-04-20',
      // Ollama's batch capacity depends on the locally loaded model + the
      // OLLAMA_NUM_PARALLEL config; no static cap to declare. v0.32 (#779).
      no_batch_cap: true,
    },
    chat: {
      // Ollama serves whatever model the user has pulled. The openai-compat
      // tier does NOT enforce this list at runtime — users pass any local
      // model id (e.g. `ollama:qwen2.5:14b`, `ollama:llama3.1:8b`). The list
      // below is a curated entry point for the wizard, not an allow-list.
      // Matches openrouter.ts pattern (catalog spans many models).
      models: [],
      // Tool calling is per-model on Ollama. Qwen2.5, Llama 3.1+, Mistral
      // (recent), and Granite all support /v1 tool calls via Ollama's
      // OpenAI-compat layer. Conservative true; gateway surfaces upstream
      // 4xx if the chosen model lacks tool support.
      supports_tools: true,
      // Same gate as openrouter: the real subagent-loop gate is
      // isAnthropicProvider() in src/core/model-config.ts which hard-pins
      // gbrain's subagent infra to Anthropic-direct (stable tool_use_id
      // across crashes/replays). Informational only.
      supports_subagent_loop: false,
      // Ollama has no Anthropic-style ephemeral prompt cache.
      supports_prompt_cache: false,
      // No max_context_tokens: catalog spans 4K (tiny models) to 1M+
      // (Llama 3.1 / Qwen2.5 long-context variants). Per-model rather than
      // recipe-wide. Let upstream errors surface per-model.
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-06-08',
    },
  },
  setup_hint: 'Install Ollama from https://ollama.ai, then `ollama pull <model>` and `ollama serve`. For chat: `ollama:qwen2.5:14b` or any pulled model. For embeddings: `ollama:nomic-embed-text` (768d).',
};
