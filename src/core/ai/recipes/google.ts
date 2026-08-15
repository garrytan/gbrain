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
      // gemini-3.5-flash-lite is the cheapest live GA tier ($0.30/M input).
      // The 2.5-flash-lite floor ($0.10/M) is cheaper but Google set the 2.5
      // family's retirement for 2026-10-16 — listing it here would re-create
      // the dead-default class two months out.
      models: ['gemini-3.5-flash-lite', 'gemini-3.5-flash'],
      cost_per_1m_tokens_usd: 0.30,
      price_last_verified: '2026-08-08',
    },
    chat: {
      // gemini-1.5-pro was retired by Google (#3510) and the 2.0-flash
      // family was shut down 2026-06-01 — deliberately NOT listed.
      // Default-slot guard tests validate hardcoded defaults against this
      // list, so re-adding a dead model here masks dead defaults. The 2.5
      // family is live but retires 2026-10-16, so the list is 3.x-only.
      models: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 1000000, // Gemini 3.x Flash family
      cost_per_1m_input_usd: 1.50, // gemini-3.6-flash baseline
      cost_per_1m_output_usd: 7.50,
      price_last_verified: '2026-08-08',
    },
  },
  setup_hint: 'Get an API key at https://aistudio.google.com/apikey, then `export GOOGLE_GENERATIVE_AI_API_KEY=...`',
};
