import type { Recipe } from '../types.ts';

export const openaiCodex: Recipe = {
  id: 'openai-codex',
  name: 'OpenAI Codex OAuth',
  tier: 'native',
  implementation: 'codex-oauth',
  auth_env: {
    required: [],
    optional: ['GBRAIN_CODEX_AUTH_JSON', 'HERMES_CODEX_BASE_URL', 'CODEX_HOME'],
    setup_url: 'https://hermes-agent.nousresearch.com/docs',
  },
  touchpoints: {
    chat: {
      models: ['gpt-5.3-codex'],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      price_last_verified: '2026-05-06',
    },
  },
  aliases: {
    'gpt-5-codex': 'gpt-5.3-codex',
    codex: 'gpt-5.3-codex',
  },
  setup_hint: 'Uses existing Hermes/Codex OAuth auth files; no OPENAI_API_KEY export. Run `hermes auth add openai-codex` or Codex CLI login first.',
};
