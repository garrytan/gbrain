import type { Recipe } from '../types.ts';
import { resolveCodexBaseURL, createCodexResponsesFetch } from '../codex-oauth.ts';

export const openaiCodex: Recipe = {
  id: 'openai-codex',
  name: 'OpenAI Codex OAuth',
  tier: 'native',
  // `gateway.ts` special-cases this recipe to use createOpenAI().responses(...)
  // with a Codex OAuth fetch wrapper. Keeping the implementation on
  // native-openai lets the rest of the recipe registry stay provider-neutral.
  implementation: 'native-openai',
  auth_env: {
    required: [],
    optional: ['HERMES_HOME', 'CODEX_HOME', 'HERMES_CODEX_BASE_URL', 'HERMES_CODEX_REFRESH_TIMEOUT_SECONDS'],
    setup_url: 'https://hermes-agent.nousresearch.com/docs/integrations/providers',
  },
  touchpoints: {
    chat: {
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4'],
      supports_tools: true,
      supports_subagent_loop: true,
      // GBrain's flag controls explicit Anthropic-style cacheControl metadata.
      // OpenAI prompt caching is automatic and must not use that mapping.
      supports_prompt_cache: false,
      // Keep this conservative for the mixed 5.4–5.6 model list. GPT-5.6
      // supports 1.05M, but Recipe currently exposes one limit per touchpoint.
      max_context_tokens: 200000,
      price_last_verified: '2026-07-11',
    },
    expansion: {
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4'],
      price_last_verified: '2026-07-11',
    },
  },
  aliases: {
    'gpt-5.6': 'gpt-5.6-sol',
    'gpt-5.5-codex': 'gpt-5.5',
  },
  setup_hint: 'Authenticate Codex OAuth with Hermes (`hermes auth` / `hermes model`) or the Codex CLI (`codex`). GBrain reads ~/.hermes/auth.json and falls back to ~/.codex/auth.json.',
  resolveOpenAICompatConfig(env) {
    return {
      baseURL: resolveCodexBaseURL(env),
      fetch: createCodexResponsesFetch(env),
    };
  },
};
