import type { Recipe } from '../types.ts';

/** OpenAI models through the signed-in Codex CLI (ChatGPT subscription). */
export const codexCli: Recipe = {
  id: 'codex-cli',
  name: 'Codex (via CLI)',
  tier: 'native',
  implementation: 'codex-cli',
  billing: 'subscription',
  auth_env: { required: [] },
  touchpoints: {
    chat: {
      models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-10-14',
      default_timeout_ms: 120_000,
    },
  },
  aliases: { default: 'gpt-6.1-sol', fast: 'gpt-6-luna' },
  setup_hint: 'Install the Codex CLI and run `codex login`. Set GBRAIN_CODEX_CLI_BIN if it is not on PATH.',
};
