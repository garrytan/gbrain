import type { Recipe } from '../types.ts';

/**
 * OpenAI Codex / ChatGPT-plan OAuth provider.
 *
 * Runtime support is intentionally separate from the API-key `openai` recipe:
 * tokens live in the OpenAI Codex OAuth TokenStore, models are discovered
 * dynamically, and gateway wiring must use the native openai-codex adapter
 * rather than the static OpenAI API-key path.
 */
export const openaiCodex: Recipe = {
  id: 'openai-codex',
  name: 'OpenAI Codex OAuth',
  tier: 'native',
  // Placeholder until the native per-call adapter lands. Do not route live
  // gateway calls through this recipe before gateway.ts adds the openai-codex
  // native adapter seam.
  implementation: 'openai-compatible',
  auth_env: {
    required: [],
    setup_url: 'https://developers.openai.com/codex',
  },
  touchpoints: {
    expansion: {
      // Dynamic model discovery fills this at runtime. The static recipe uses
      // a sentinel for provider-list/explain only.
      models: ['dynamic'],
      cost_per_1m_tokens_usd: undefined,
    },
    chat: {
      models: ['dynamic'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 128000,
    },
  },
  setup_hint: 'Run `gbrain providers login openai-codex`, then `gbrain providers refresh openai-codex`. No OpenAI API key required.',
};
