import type { Recipe } from '../types.ts';

export const openaiCodex: Recipe = {
  id: 'openai-codex',
  name: 'OpenAI Codex (ChatGPT plan)',
  tier: 'codex-responses',
  implementation: 'codex-responses',
  base_url_default: 'https://chatgpt.com/backend-api/codex',
  // Auth is resolved from Codex-plan credentials, not OPENAI_API_KEY.
  auth_env: {
    required: [],
    optional: ['OPENAI_CODEX_ACCESS_TOKEN'],
    setup_url: 'https://chatgpt.com/codex',
  },
  enforce_model_allowlist: true,
  touchpoints: {
    chat: {
      models: ['gpt-5.5'],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      // Plan-billed metadata only. Leave per-token API prices undefined so
      // the budget tracker does not treat Codex as ordinary metered $0 public
      // OpenAI API usage.
      price_last_verified: '2026-06-02',
      billing: {
        mode: 'plan-billed',
        display: 'ChatGPT/Codex plan billing; public API spend is $0, subscription quota/rate limits still apply.',
        quota_hint: 'Subject to ChatGPT/Codex plan quotas and rate limits.',
      },
    },
  },
  setup_hint:
    'Uses ChatGPT/Codex plan auth, not OPENAI_API_KEY. Uses the Codex Responses streaming transport; text chat only, no embeddings/tools/subagent loop.',
};
