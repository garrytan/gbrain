import { AIConfigError } from '../errors.ts';
import type { Recipe } from '../types.ts';

/** Canonical key first; JEV_TYPESAFE_API_KEY is accepted as an alias. Key presence never selects a provider. */
export const TYPESAFE_KEY_ENV = ['TYPESAFE_API_KEY', 'JEV_TYPESAFE_API_KEY'] as const;

export function typesafeApiKey(env: Record<string, string | undefined>): { key: string; from: string } | null {
  for (const name of TYPESAFE_KEY_ENV) {
    const key = env[name]?.trim();
    if (key) return { key, from: name };
  }
  return null;
}

/**
 * TypeSafe's Jev: typed System One decisions (`decide`) and native
 * four-level relevance scoring (`reranker`) over POST /v1/systemone. No chat
 * or embedding surface. Bills input tokens only.
 */
export const typesafe: Recipe = {
  id: 'typesafe',
  name: 'TypeSafe (Jev)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.typesafe.ai/v1',
  auth_env: {
    required: ['TYPESAFE_API_KEY'],
    optional: ['JEV_TYPESAFE_API_KEY'],
    setup_url: 'https://console.typesafe.ai',
  },
  touchpoints: {
    reranker: {
      models: ['jev-1.13.0', 'jev-latest', 'jev-preview'],
      default_model: 'jev-1.13.0',
      wire_format: 'typesafe-systemone',
      score_semantics: 'rubric',
      path: '/systemone',
      // Application ceiling, not a claim about the upstream API's limits.
      max_payload_bytes: 1_000_000,
      cost_per_1m_tokens_usd: 0.042,
      price_last_verified: '2026-09-30',
    },
    decide: {
      models: ['jev-1.13.0'],
      default_model: 'jev-1.13.0',
      aliases: ['jev-latest', 'jev-preview'],
      path: '/systemone',
      max_payload_bytes: 1_000_000,
      max_request_tokens: 64_000,
      max_state_question_tokens: 32_000,
      cost_per_1m_tokens_usd: 0.042,
      price_last_verified: '2026-09-30',
    },
  },
  resolveAuth(env) {
    const found = typesafeApiKey(env);
    if (!found) {
      throw new AIConfigError('TypeSafe (Jev) requires TYPESAFE_API_KEY (JEV_TYPESAFE_API_KEY is accepted too).', typesafe.setup_hint);
    }
    return { headerName: 'Authorization', token: `Bearer ${found.key}` };
  },
  authPresent(env) {
    return typesafeApiKey(env) !== null;
  },
  setup_hint:
    'Get an API key at https://console.typesafe.ai, set TYPESAFE_API_KEY, then run ' +
    '`gbrain decide probe`. For reranking: `gbrain decide enable rerank`.',
};
