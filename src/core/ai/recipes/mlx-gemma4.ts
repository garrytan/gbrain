import type { Recipe } from '../types.ts';

/**
 * Local Gemma 4 MLX chat server on Apple Silicon.
 *
 * The server is OpenAI-compatible and intentionally marked tool-unsafe:
 * GBrain may use it for cheap local query expansion and plain chat, but not
 * for Minions/subagent loops.
 */
export const mlxGemma4: Recipe = {
  id: 'mlx-gemma4',
  name: 'Gemma 4 31B MLX (local Mac)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://127.0.0.1:8081/v1',
  auth_env: {
    required: [],
    optional: ['MLX_GEMMA4_BASE_URL', 'MLX_GEMMA4_API_KEY'],
    setup_url: 'https://github.com/ml-explore/mlx-examples/tree/main/llms/mlx_lm',
  },
  touchpoints: {
    expansion: {
      models: ['nightmedia/gemma-4-31B-it-mxfp4-mlx'],
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-05-22',
    },
    chat: {
      models: ['nightmedia/gemma-4-31B-it-mxfp4-mlx'],
      supports_tools: false,
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 262144,
      cost_per_1m_input_usd: 0,
      cost_per_1m_output_usd: 0,
      price_last_verified: '2026-05-22',
    },
  },
  setup_hint: 'Start mlx_lm.server for Gemma 4 31B MLX on 127.0.0.1:8081.',
};
