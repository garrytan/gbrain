import type { Recipe } from '../types.ts';

/**
 * AMD Radeon cloud (developer.amd.com.cn) — OpenAI-compatible chat models
 * over the radeon API gateway. Free-tier micro-billed endpoint; no embedding
 * touchpoint (embedding stays on NVIDIA / Ollama etc.).
 *
 * Model ids are case-sensitive on the wire (`Qwen3.8-Flash-Next` etc. —
 * /models lists them capitalised), so aliases exist for the lower-cased
 * friendly forms users type in `provider:model` strings.
 *
 * Measured (2026-09-16): DeepSeek-V4-Flash returns `reasoning` in the
 * response body (thinking mode bills output tokens) and declares
 * `tools: true` on the gateway; Qwen3.8-Flash-Next returns `reasoning`
 * too. supports_tools is declared false until tool-calling/replay stability
 * is proven through a real adapter test, mirroring NVIDIA's treatment of
 * Nemotron.
 */
export const amd: Recipe = {
  id: 'amd',
  name: 'AMD Radeon Cloud',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://developer.amd.com.cn/radeon/api/v1',
  auth_env: {
    required: ['AMD_API_KEY'],
    optional: ['AMD_BASE_URL'],
    setup_url: 'https://developer.amd.com.cn/',
  },
  aliases: {
    'qwen-3.8-next-flash': 'Qwen3.8-Flash-Next',
    'qwen3.8-flash-next': 'Qwen3.8-Flash-Next',
    'qwen3.8-flash': 'Qwen3.8-Flash-Next',
    'qwen3.8-27b': 'Qwen3.8-27B',
    'deepseek-v4-flash': 'DeepSeek-V4-Flash',
    'minicpm5-2b': 'MiniCPM5-2B',
  },
  // No resolveAuth override: plain `Authorization: Bearer <key>`, which
  // defaultResolveAuth derives from auth_env.required (IRON RULE: only Azure
  // overrides resolveAuth).
  touchpoints: {
    chat: {
      models: [
        'DeepSeek-V4-Flash',
        'Qwen3.8-Flash-Next',
        'Qwen3.8-27B',
        'MiniCPM5-2B',
      ],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_structured_outputs: true,
      // DeepSeek-V4-Flash reasons by default (bills reasoning as output);
      // Qwen3.8-* also emit a `reasoning` field.
      thinking_by_default: (modelId) => modelId.includes('DeepSeek'),
      model_context_tokens: {
        'DeepSeek-V4-Flash': 1048576,
        'Qwen3.8-Flash-Next': 262144,
        'Qwen3.8-27B': 262144,
        'MiniCPM5-2B': 131072,
      },
      cost_per_1m_input_usd: 0.14,
      cost_per_1m_output_usd: 0.28,
      price_last_verified: '2026-09-16',
    },
  },
  setup_hint: 'Get a Radeon cloud API key at https://developer.amd.com.cn/, then `export AMD_API_KEY=...`.',
};