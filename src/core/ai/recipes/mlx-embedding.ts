import type { Recipe } from '../types.ts';

/**
 * Local MLX embedding server on Apple Silicon.
 *
 * Hunter's preferred local-memory embedding path: the roocode MLX indexer
 * exposes an OpenAI-compatible /v1/embeddings endpoint backed by
 * mlx-community/Qwen3-Embedding-8B-4bit-DWQ.
 */
export const mlxEmbedding: Recipe = {
  id: 'mlx-embedding',
  name: 'MLX Embeddings (local Mac)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://127.0.0.1:8080/v1',
  auth_env: {
    required: [],
    optional: ['MLX_EMBEDDING_BASE_URL', 'MLX_EMBEDDING_API_KEY'],
    setup_url: 'https://github.com/ml-explore/mlx-examples/tree/main/llms',
  },
  touchpoints: {
    embedding: {
      models: ['mlx-community/Qwen3-Embedding-8B-4bit-DWQ'],
      default_dims: 4096,
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-06-06',
      no_batch_cap: true,
    },
  },
  setup_hint: 'Start the local MLX embedding LaunchAgent on 127.0.0.1:8080 with Qwen3-Embedding-8B-4bit-DWQ.',
};
