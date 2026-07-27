import type { Recipe } from '../types.ts';

/**
 * Moonshot AI / Kimi Open Platform. Kimi exposes an OpenAI-compatible
 * /v1/chat/completions API at https://api.moonshot.ai/v1.
 *
 * Verified against Kimi API docs and live /v1/models on 2026-06-23.
 * The recipe is local-production glue until upstream GBrain carries a native
 * Moonshot recipe; keep it registered in the local patch registry.
 */
export const moonshot: Recipe = {
  id: 'moonshot',
  name: 'Moonshot AI / Kimi',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.moonshot.ai/v1',
  auth_env: {
    required: ['MOONSHOT_API_KEY'],
    setup_url: 'https://platform.kimi.ai/console/api-keys',
  },
  touchpoints: {
    expansion: {
      models: ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2.5'],
      // Kimi pricing varies by current promotional/account terms; do not use
      // this advisory field for budget enforcement. Canonical budget pricing
      // belongs in src/core/model-pricing.ts when verified for the account.
      price_last_verified: '2026-06-23',
    },
    chat: {
      models: ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6', 'kimi-k2.5'],
      supports_tools: true,
      // Kimi tool calling is enough for ordinary chat/tool calls. GBrain's
      // subagent loop remains Anthropic-pinned because upstream requires stable
      // Anthropic-style tool_use_id behavior across crashes/replays.
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 256000,
      price_last_verified: '2026-06-23',
    },
  },
  setup_hint: 'Get an API key at https://platform.kimi.ai/console/api-keys, then `export MOONSHOT_API_KEY=...` and use `moonshot:kimi-k2.7-code`.',
};
