import type { Recipe } from '../types.ts';

/**
 * Groq runs Llama and Whisper on custom inference hardware (~500 tok/s).
 * The speed tier and last-resort refusal fallback. Also serves Whisper for
 * transcription (wired in commit 7).
 */
export const groq: Recipe = {
  id: 'groq',
  name: 'Groq',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.groq.com/openai/v1',
  auth_env: {
    required: ['GROQ_API_KEY'],
    setup_url: 'https://console.groq.com/keys',
  },
  touchpoints: {
    chat: {
      models: [
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
        'gpt-oss-20b',
        'gpt-oss-120b',
      ],
      supports_tools: true,
      // 8b-instant has flaky tool_call_id stability under replay; the 70b model
      // is the recommended subagent driver. We mark the recipe true and let
      // commit 2's subagent loop pick model-by-model when it matters.
      supports_subagent_loop: true,
      supports_prompt_cache: false,
      max_context_tokens: 131072,
      cost_per_1m_input_usd: 0.59, // 70b versatile
      cost_per_1m_output_usd: 0.79,
      price_last_verified: '2026-04-20',
    },
  },
  setup_hint: 'Get an API key at https://console.groq.com/keys, then `export GROQ_API_KEY=...`',
};
