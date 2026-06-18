import type { Recipe } from '../types.ts';

/**
 * OpenCode Go exposes an OpenAI-compatible chat endpoint with a flat model
 * namespace (for example `kimi-k2.6`). We keep this as a chat-only provider for
 * GBrain LLM-bound extraction; embeddings stay on the configured embedding
 * provider.
 */
export const opencodeGo: Recipe = {
  id: 'opencode-go',
  name: 'OpenCode Go',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://opencode.ai/zen/go/v1',
  auth_env: {
    required: ['OPENCODE_GO_API_KEY'],
    setup_url: 'https://opencode.ai/',
  },
  default_headers: {
    // Without an explicit User-Agent, the endpoint can return Cloudflare 1010
    // before the OpenAI-compatible API layer sees the request.
    'User-Agent': 'Hermes Agent',
  },
  touchpoints: {
    chat: {
      models: [
        'kimi-k2.6',
        'kimi-k2.5',
        'glm-5.1',
        'glm-5',
        'mimo-v2.5-pro',
        'mimo-v2.5',
        'mimo-v2-pro',
        'mimo-v2-omni',
        'minimax-m2.7',
        'minimax-m2.5',
        'qwen3.7-max',
        'qwen3.6-plus',
        'qwen3.5-plus',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 128000,
      price_last_verified: '2026-06-18',
    },
  },
  setup_hint: 'Set OPENCODE_GO_API_KEY and use a flat OpenCode Go model id such as opencode-go:kimi-k2.6.',
};
