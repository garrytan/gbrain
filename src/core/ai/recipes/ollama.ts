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
      // #2552: Ollama's true batch capacity depends on the locally loaded
      // model + OLLAMA_NUM_PARALLEL, but the previous `no_batch_cap: true`
      // meant a whole page went out in ONE request — on a CPU-only box that
      // multiplies latency past the fetch timeout and the backfill starves
      // with no surfaced error. Ollama doesn't return a recognizable
      // token-limit error either, so the recursive-halving safety net never
      // fires; a conservative static pre-split cap is the only guard.
      // 4096 tokens x 2 chars/token ~= 8K chars per request (code-dense
      // pages run ~2 chars/token, not the tiktoken-ish 4).
      max_batch_tokens: 4096,
      chars_per_token: 2,
    },
  },
  setup_hint: 'Install Ollama from https://ollama.ai, then `ollama pull nomic-embed-text` and `ollama serve`.',
};
