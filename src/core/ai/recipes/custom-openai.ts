import type { Recipe } from '../types.ts';

/**
 * User-supplied OpenAI-compatible endpoint.
 *
 * The provider id is intentionally fixed instead of dynamically registering
 * arbitrary recipe ids. A single stable id keeps model routing, config
 * validation and packaged sidecars deterministic while still allowing local
 * servers such as vLLM, LM Studio, Xinference and LocalAI to expose any model
 * ids they serve.
 */
export const customOpenAI: Recipe = {
  id: 'custom-openai',
  name: 'Custom OpenAI-compatible',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  auth_env: {
    required: [],
    optional: ['CUSTOM_OPENAI_API_KEY'],
  },
  touchpoints: {
    embedding: {
      models: [],
      user_provided_models: true,
      default_dims: 0,
      no_batch_cap: true,
    },
    expansion: {
      models: [],
    },
    chat: {
      models: [],
      supports_tools: true,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
    },
  },
  setup_hint:
    'Set provider_base_urls.custom-openai to the endpoint base URL, then use custom-openai:<model>. CUSTOM_OPENAI_API_KEY is optional.',
};
