import type { Recipe } from '../types.ts';
import { deepseekReasoningContentCompatFetch } from './deepseek.ts';

/**
 * Atlas Cloud exposes an OpenAI-compatible chat-completions API. The curated
 * model below is present in Atlas Cloud's public catalog with tools, JSON mode,
 * structured outputs, and a 1M-token context window (verified 2026-08-07).
 *
 * Pricing is deliberately omitted: account terms may vary, and gbrain's
 * budget enforcement must not rely on an unverified recipe-level estimate.
 */
export const atlascloud: Recipe = {
  id: 'atlascloud',
  name: 'Atlas Cloud',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.atlascloud.ai/v1',
  auth_env: {
    required: ['ATLASCLOUD_API_KEY'],
    setup_url: 'https://www.atlascloud.ai/console/api-keys',
  },
  touchpoints: {
    expansion: {
      models: ['deepseek-ai/deepseek-v4-pro'],
    },
    chat: {
      models: ['deepseek-ai/deepseek-v4-pro'],
      supports_tools: true,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      supports_structured_outputs: true,
      max_context_tokens: 1_048_576,
    },
  },
  setup_hint:
    'Create an API key at https://www.atlascloud.ai/console/api-keys, then `export ATLASCLOUD_API_KEY=...` and use `atlascloud:deepseek-ai/deepseek-v4-pro`.',
  compat: { fetch: deepseekReasoningContentCompatFetch },
};
