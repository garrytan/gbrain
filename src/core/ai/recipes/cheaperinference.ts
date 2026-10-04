import type { Recipe } from '../types.ts';

/**
 * Cheaper Inference exposes an OpenAI-compatible API at
 * https://api.cheaperinference.com/v1 (/chat/completions). One key routes to
 * models from several labs; model ids are bare (`gpt-5.4-mini`, not
 * `openai/gpt-5.4-mini`).
 *
 * Verified against the live /v1/models catalog on 2026-10-04. Every model
 * listed below is a `type: "text"` row there.
 *
 * No embedding touchpoint: the gateway has no /embeddings surface.
 */
export const cheaperinference: Recipe = {
  id: 'cheaperinference',
  name: 'Cheaper Inference',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.cheaperinference.com/v1',
  auth_env: {
    required: ['CHEAPER_INFERENCE_API_KEY'],
    setup_url: 'https://cheaperinference.com/signup',
  },
  touchpoints: {
    expansion: {
      models: ['gpt-5.4-mini', 'gpt-5.4'],
    },
    chat: {
      models: ['gpt-5.4-mini', 'gpt-5.4', 'claude-sonnet-5', 'gemini-3.1-pro'],
      supports_tools: true,
      // Same call as the Moonshot and Mistral recipes: ordinary tool calls are
      // fine, but gbrain's subagent loop stays Anthropic-pinned for stable
      // tool_use_id behavior across crashes/replays.
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      // Smallest window in the list (gpt-5.4-mini, 400K per live /v1/models).
      max_context_tokens: 400_000,
    },
  },
  setup_hint: 'Get an API key at https://cheaperinference.com/signup, then `export CHEAPER_INFERENCE_API_KEY=...` and use `cheaperinference:gpt-5.4-mini`.',
};
