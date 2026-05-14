import type { Recipe } from '../types.ts';
import { DEFAULT_CODEX_BASE_URL } from '../codex-oauth.ts';

export const openaiCodex: Recipe = {
  id: 'openai-codex',
  name: 'OpenAI Codex (OAuth)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: DEFAULT_CODEX_BASE_URL,
  auth_env: {
    required: [],
    optional: [
      'GBRAIN_CODEX_AUTH_JSON',
      'GBRAIN_CODEX_BASE_URL',
      'HERMES_HOME',
      'HERMES_CODEX_BASE_URL',
      'CODEX_HOME',
    ],
    setup_url: 'https://github.com/openai/codex',
  },
  touchpoints: {
    chat: {
      models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-5', 'gpt-5.3-codex'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 272000,
      price_last_verified: '2026-05-13',
    },
  },
  setup_hint:
    'Authenticate with Hermes (`hermes auth openai-codex` or `hermes auth`) or set GBRAIN_CODEX_AUTH_JSON to a Hermes-compatible auth.json file.',
};
