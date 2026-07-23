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
    },
    expansion: {
      // #2507: gemini-2.0-* ids are retired server-side (HTTP 404 "no longer
      // available"). Current GA ids + the rolling -latest alias Google serves.
      models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest'],
      cost_per_1m_tokens_usd: 0.10,
      price_last_verified: '2026-07-21',
    },
    chat: {
      // #2507: refreshed from retired gemini-2.0-flash* / gemini-1.5-pro to
      // the current GA family. The -latest ids are rolling aliases Google
      // serves directly on v1beta.
      models: [
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-pro-latest',
        'gemini-flash-latest',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 1000000, // Gemini 2.5 Pro
      cost_per_1m_input_usd: 0.30, // gemini-2.5-flash baseline
      cost_per_1m_output_usd: 2.50,
      price_last_verified: '2026-07-21',
    },
  },
  setup_hint: 'Get an API key at https://aistudio.google.com/apikey, then `export GOOGLE_GENERATIVE_AI_API_KEY=...`',
};
