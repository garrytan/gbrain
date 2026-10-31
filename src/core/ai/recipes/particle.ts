import type { Recipe } from '../types.ts';

/**
 * Particle exposes an OpenAI-compatible /v1/chat/completions endpoint. Its
 * Responses API is WebSocket-only, so gbrain uses Chat Completions alone.
 * Requests name `particle-1`; responses and /v1/models report
 * `particle-ai/particle-1`, so both ids are listed. Thinking is on by
 * default and bills as output; `reasoning_effort: 'none'` turns it off
 * (thinking-off.ts). Reasoning arrives in `reasoning_content`, which the
 * openai-compatible adapter keeps out of the answer text; no compat shim
 * promotes it. US-only traffic can point `provider_base_urls.particle` at
 * https://us.api.particle.ai/v1.
 */
export const particle: Recipe = {
  id: 'particle',
  name: 'Particle',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.particle.ai/v1',
  auth_env: {
    required: ['PARTICLE_API_KEY'],
    setup_url: 'https://platform.particle.ai',
  },
  touchpoints: {
    expansion: {
      models: ['particle-1', 'particle-ai/particle-1'],
      cost_per_1m_tokens_usd: 0.25,
      price_last_verified: '2026-10-31',
    },
    chat: {
      models: ['particle-1', 'particle-ai/particle-1'],
      supports_tools: true,
      supports_subagent_loop: true,
      supports_prompt_cache: true,
      thinking_by_default: true,
      max_context_tokens: 1_048_576,
      cost_per_1m_input_usd: 0.25,
      cost_per_1m_output_usd: 1.00,
      price_last_verified: '2026-10-31',
    },
  },
  setup_hint: 'Get an API key at https://platform.particle.ai, then `export PARTICLE_API_KEY=...` and use `particle:particle-1`.',
};
