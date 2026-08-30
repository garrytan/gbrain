import type { Recipe } from '../types.ts';

/**
 * OpenAI Codex through the installed, logged-in `codex exec` CLI.
 *
 * This is a local subscription path, not an API-key provider. The subprocess
 * owns auth and GBrain never reads Codex OAuth credentials. Chat only: Codex
 * does not provide embeddings through this CLI adapter.
 *
 * Reasoning defaults to `low`, a conservative latency/usage setting. Override
 * it through the existing provider chat-options seam:
 * `provider_chat_options.codex-cli.reasoningEffort = medium`.
 */
export const codexCli: Recipe = {
  id: 'codex-cli',
  name: 'OpenAI Codex (via CLI)',
  tier: 'native',
  implementation: 'codex-cli',
  auth_env: {
    required: [],
  },
  touchpoints: {
    chat: {
      // Verified against the installed codex-cli 0.147.0.
      // First entry is the provider-picker default.
      models: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 128_000,
      // Local CLI startup plus post-call token-budget enforcement needs more
      // room than the 5s network probe default.
      default_timeout_ms: 30_000,
    },
  },
  setup_hint:
    'Install Codex CLI, run `codex login`, and select models with `codex-cli:<model>`. ' +
    'For subagents, enable the existing gateway loop with ' +
    '`gbrain config set agent.use_gateway_loop true`. ' +
    'Set GBRAIN_CODEX_CLI_BIN only when codex is not on PATH.',
};
