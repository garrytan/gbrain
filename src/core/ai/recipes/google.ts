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
      // 2026-06-06: cap was missing. Without max_batch_tokens the gateway's
      // `embed()` runs the no-pre-split fast path (one big embedMany), and
      // Gemini's :batchEmbedContents endpoint charges 1 RPM per ITEM in the
      // batch (verified via direct 100-item probe → 429, limit 100). For
      // the free tier we cap so each sub-batch is ~1 chunk, each sub-batch
      // costs 1 RPM, and a 143-chunk embed fits in ~90s.
      max_batch_tokens: 150,
      chars_per_token: 4,
      safety_factor: 1.0,
    },
    expansion: {
      models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite'],
      cost_per_1m_tokens_usd: 0.10,
      price_last_verified: '2026-04-20',
    },
    chat: {
      models: ['gemini-2.0-flash-exp', 'gemini-2.0-flash', 'gemini-1.5-pro'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 1000000, // Gemini 1.5 Pro
      cost_per_1m_input_usd: 0.30,
      cost_per_1m_output_usd: 1.20,
      price_last_verified: '2026-04-20',
    },
  },
  setup_hint: 'Get an API key at https://aistudio.google.com/apikey, then `export GOOGLE_GENERATIVE_AI_API_KEY=...`',
};
