import type { Recipe } from '../types.ts';

/** Jev supplies typed relevance judgments through TypeSafe's System One API. */
export const typesafe: Recipe = {
  id: 'typesafe',
  name: 'TypeSafe (Jev)',
  // Reranking uses native HTTP; no OpenAI chat or embedding surface is declared.
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.typesafe.ai/v1',
  auth_env: {
    required: ['TYPESAFE_API_KEY'],
    setup_url: 'https://console.typesafe.ai',
  },
  touchpoints: {
    reranker: {
      models: ['jev-1.13.0', 'jev-latest'],
      default_model: 'jev-1.13.0',
      wire_format: 'typesafe-systemone',
      path: '/systemone',
      // Application ceiling, not a claim about the upstream API's limits.
      max_payload_bytes: 1_000_000,
      cost_per_1m_tokens_usd: 0.042,
      price_last_verified: '2026-09-17',
    },
  },
  setup_hint:
    'Get an API key at https://console.typesafe.ai, set TYPESAFE_API_KEY, then ' +
    '`gbrain config set search.reranker.model typesafe:jev-1.13.0` and ' +
    '`gbrain config set search.reranker.enabled true`.',
};
