import type { Recipe } from '../types.ts';

/**
 * GPT via the local `codex` CLI binary, using its built-in ChatGPT OAuth
 * session (ChatGPT Plus/Pro subscription). No OPENAI_API_KEY needed — the
 * CLI manages its own auth state and the gateway dispatches via subprocess.
 *
 * The GPT sibling of the `claude-cli` recipe (#334 lineage): subscribers
 * want Minions subagent dispatch and chat fallback to run against their
 * existing ChatGPT subscription instead of paying per-token API charges.
 * The recipe sits alongside the existing `openai` recipe so users pick per
 * call: `openai:gpt-5.6` (API key + per-token billing) vs
 * `codex-cli:gpt-5.6-terra` (OAuth subscription, no API key).
 *
 * Chat-only. Embeddings still route through openai/google/voyage the way
 * the `claude-cli` recipe documents.
 *
 * Auth: `auth_env.required: []` because the CLI handles auth itself. The
 * `codex` binary on PATH (or `GBRAIN_CODEX_CLI_BIN`) IS the auth surface;
 * there is nothing for the gateway to forward.
 *
 * Setup expectation: Codex CLI installed and logged in (`codex login`), or
 * `GBRAIN_CODEX_CLI_BIN` pointing at the binary.
 */
export const codexCli: Recipe = {
  id: 'codex-cli',
  name: 'GPT (via Codex CLI)',
  tier: 'native',
  implementation: 'codex-cli',
  // The CLI owns auth; no env vars are required from the gateway side.
  auth_env: {
    required: [],
  },
  touchpoints: {
    // No embedding or expansion touchpoints — chat-only.
    chat: {
      models: [
        'gpt-5.6-terra',
        'gpt-5.6-sol',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      // The CLI handles caching internally and does not surface it via the
      // standard cache_control control plane. From the gateway's POV the
      // model does not support prompt caching.
      supports_prompt_cache: false,
      max_context_tokens: 400000,
      // Cost figures match the underlying OpenAI API tier, but the actual
      // bill is borne by the subscription. We report them for the budget
      // ledger's per-call accounting; operators on flat-rate subscriptions
      // can treat the numbers as nominal.
      cost_per_1m_input_usd: 1.25,
      cost_per_1m_output_usd: 10.0,
      price_last_verified: '2026-07-29',
    },
  },
  // Friendly aliases so config strings stay short. Verified against
  // `codex exec -m <id>` on Codex CLI as of 2026-07-29.
  aliases: {
    'terra': 'gpt-5.6-terra',
    'sol': 'gpt-5.6-sol',
  },
  setup_hint:
    'Install the Codex CLI (`codex`) and run `codex login` once. ' +
    'Set GBRAIN_CODEX_CLI_BIN if the binary is not on PATH.',
};
