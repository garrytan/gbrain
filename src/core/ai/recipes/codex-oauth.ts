import type { Recipe } from '../types.ts';

export const CODEX_OAUTH_MODELS = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] as const;

/** ChatGPT subscription models dispatched through the official Codex runtime. */
export const codexOAuth: Recipe = {
  id: 'codex-oauth',
  name: 'OpenAI Codex (ChatGPT OAuth)',
  tier: 'native',
  implementation: 'codex-oauth',
  auth_env: { required: ['GBRAIN_CODEX_HOME', 'GBRAIN_CODEX_CLI_BIN'] },
  touchpoints: {
    chat: {
      models: [...CODEX_OAUTH_MODELS],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      supports_structured_outputs: true,
    },
  },
  aliases: {
    luna: 'gpt-5.6-luna',
    terra: 'gpt-5.6-terra',
    sol: 'gpt-5.6-sol',
  },
  setup_hint:
    'Set GBRAIN_CODEX_HOME and absolute GBRAIN_CODEX_CLI_BIN for a dedicated owner-only Codex 0.147 runtime, then use the Codex device login there. ' +
    'GBrain verifies ChatGPT auth, the locked model catalog, and max reasoning on every call.',
};
