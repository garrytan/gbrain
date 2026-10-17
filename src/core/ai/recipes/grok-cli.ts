import type { Recipe } from '../types.ts';

/** Grok through the signed-in local CLI (SuperGrok subscription, no API key). */
export const grokCli: Recipe = {
  id: 'grok-cli',
  name: 'Grok (via CLI)',
  tier: 'native',
  implementation: 'grok-cli',
  billing: 'subscription',
  auth_env: { required: [] },
  touchpoints: {
    chat: {
      models: ['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 131072,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-10-09',
      default_timeout_ms: 120_000,
    },
  },
  aliases: { default: 'grok-4.7', fast: 'grok-4.7-build-fast' },
  setup_hint: 'Install the Grok CLI and run `grok login`. Set GBRAIN_GROK_CLI_BIN if it is not on PATH.',
};
