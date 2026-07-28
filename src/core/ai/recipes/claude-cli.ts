import type { Recipe } from '../types.ts';

/**
 * Claude via the local `claude` CLI binary, using its built-in OAuth session
 * (Claude Code / Claude Max subscription). No ANTHROPIC_API_KEY needed — the
 * CLI manages its own auth state and the gateway dispatches via subprocess.
 *
 * Solves the #334 case where Max subscribers want Minions subagent dispatch
 * to run against their existing subscription instead of paying per-token API
 * charges. The recipe sits alongside the existing `anthropic` recipe so users
 * pick per call: `anthropic:claude-sonnet-4-6` (API key + per-token billing)
 * vs `claude-cli:claude-sonnet-4-6` (OAuth subscription, no API key).
 *
 * Chat-only. Claude has no first-party embedding model; users wanting an
 * Anthropic chat path with embeddings still combine this with openai/google/
 * voyage for embedding the way the existing `anthropic` recipe documents.
 *
 * Auth: `auth_env.required: []` because the CLI handles auth itself. The
 * `claude` binary on PATH (or `GBRAIN_CLAUDE_CLI_BIN`) IS the auth surface;
 * there is nothing for the gateway to forward.
 *
 * Setup expectation: `claude` CLI installed and logged in (Claude Code
 * onboarding does this), or `GBRAIN_CLAUDE_CLI_BIN` pointing at the binary.
 */
export const claudeCli: Recipe = {
  id: 'claude-cli',
  name: 'Claude (via CLI)',
  tier: 'native',
  implementation: 'claude-cli',
  // The CLI owns auth; no env vars are required from the gateway side.
  auth_env: {
    required: [],
  },
  touchpoints: {
    // No embedding or expansion touchpoints — chat-only.
    chat: {
      models: [
        'claude-opus-4-7',
        'claude-sonnet-4-6',
        'claude-haiku-4-5-20251001',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      // The CLI handles caching internally and does not surface it via the
      // standard cache_control control plane. From the gateway's POV the
      // model does not support prompt caching.
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      // Cost figures match the underlying Claude API tier, but the actual
      // bill is borne by the subscription. We report them for the budget
      // ledger's per-call accounting; operators on flat-rate subscriptions
      // can treat the numbers as nominal.
      cost_per_1m_input_usd: 3.0,
      cost_per_1m_output_usd: 15.0,
      price_last_verified: '2026-06-17',
    },
  },
  // Friendly aliases mirror the `anthropic` recipe so config strings stay
  // portable: switching `anthropic:claude-sonnet-4-6` to `claude-cli:claude-sonnet-4-6`
  // is a one-token edit. Reverse aliases rewrite legacy IDs back to canonical.
  aliases: {
    'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
    'claude-sonnet-4-6-20250929': 'claude-sonnet-4-6',
    'sonnet': 'claude-sonnet-4-6',
    'haiku': 'claude-haiku-4-5-20251001',
    'opus': 'claude-opus-4-7',
  },
  setup_hint:
    'Install Claude Code (`claude` CLI) and run `claude` once to log in. ' +
    'Set GBRAIN_CLAUDE_CLI_BIN if the binary is not on PATH.',
};
