import type { Recipe } from '../types.ts';

/**
 * OpenCode's persistent local server, using credentials owned and refreshed by
 * OpenCode. This is intentionally separate from the OpenCode Zen HTTP API.
 */
export const opencodeServer: Recipe = {
  id: 'opencode-server',
  name: 'OpenCode Server (local OAuth)',
  tier: 'native',
  implementation: 'opencode-server',
  auth_env: {
    required: [],
    optional: [
      'GBRAIN_OPENCODE_SERVER_URL',
      'GBRAIN_OPENCODE_SERVER_USERNAME',
      'GBRAIN_OPENCODE_SERVER_PASSWORD',
      'GBRAIN_OPENCODE_PROVIDER_ID',
      'GBRAIN_OPENCODE_AGENT',
    ],
    setup_url: 'https://opencode.ai/docs/server/',
  },
  touchpoints: {
    chat: {
      models: ['gpt-5.5', 'gpt-5.5-fast', 'gpt-5.4'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      price_last_verified: '2026-07-10',
    },
  },
  setup_hint:
    'Run `opencode providers login --provider OpenAI`, then keep a local-only ' +
    '`opencode serve` process running. Optional connection settings live in ' +
    'GBRAIN_OPENCODE_SERVER_URL/USERNAME/PASSWORD/PROVIDER_ID/AGENT.',
};
