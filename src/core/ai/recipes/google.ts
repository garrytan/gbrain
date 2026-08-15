import type { Recipe } from '../types.ts';

export const google: Recipe = {
  id: 'google',
  name: 'Google Gemini',
  tier: 'native',
  implementation: 'native-google',
  auth_env: {
    required: ['GOOGLE_GENERATIVE_AI_API_KEY'],
    setup_url: 'https://aistudio.google.com/apikey',
  },
  touchpoints: {
    embedding: {
      models: ['gemini-embedding-001'],
      default_dims: 768,
      dims_options: [768, 1536, 3072],
      cost_per_1m_tokens_usd: 0.15,
      price_last_verified: '2026-04-20',
      // Gemini's embedding endpoint has a low per-request cap relative to
      // Voyage. Declaring max_batch_tokens makes the gateway pre-split bulk
      // batches proactively (splitByTokenBudget) instead of relying solely on
      // the recursive-halving retry on a token-limit rejection. Conservative
      // value: each gemini-embedding-001 input tops out at 2048 tokens, so a
      // 20k budget × 0.8 safety keeps a batch well within request limits while
      // staying efficient. chars_per_token ~4 matches Gemini's SentencePiece
      // density on English. Tunable; recursion stays the backstop.
      max_batch_tokens: 20_000,
      chars_per_token: 4,
      safety_factor: 0.8,
    },
    expansion: {
      models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite'],
      cost_per_1m_tokens_usd: 0.10,
      price_last_verified: '2026-04-20',
    },
    chat: {
      // gemini-1.5-pro was retired by Google (#3510) — deliberately NOT
      // listed. Default-slot guard tests validate hardcoded defaults against
      // this list, so re-adding a dead model here masks dead defaults.
      models: ['gemini-2.0-flash-exp', 'gemini-2.0-flash'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 1000000, // Gemini 2.0 Flash
      cost_per_1m_input_usd: 0.30,
      cost_per_1m_output_usd: 1.20,
      price_last_verified: '2026-04-20',
    },
  },
  setup_hint: 'Get an API key at https://aistudio.google.com/apikey, then `export GOOGLE_GENERATIVE_AI_API_KEY=...`',
};
