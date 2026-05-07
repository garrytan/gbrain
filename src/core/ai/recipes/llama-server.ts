import type { Recipe } from '../types.ts';

/**
 * llama.cpp server (`llama-server --embeddings`) exposes an OpenAI-compatible
 * /embeddings endpoint. Used for fully-local, zero-cost embeddings (e.g.
 * Qwen3-Embedding-0.6B Q4_K_M GGUF on Apple Silicon via MPS).
 *
 * Distinct from the `ollama` recipe: ollama defaults to port 11434 and ships
 * its own model catalog; llama-server defaults to 8080 and runs whatever GGUF
 * you point it at.
 */
export const llamaServer: Recipe = {
  id: 'llama-server',
  name: 'llama.cpp server (local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:8080/v1',
  auth_env: {
    required: [], // Local server is unauthenticated; users pass `local` as the key.
    optional: ['GBRAIN_EMBEDDING_BASE_URL', 'GBRAIN_EMBEDDING_API_KEY'],
    setup_url: 'https://github.com/ggml-org/llama.cpp',
  },
  touchpoints: {
    embedding: {
      models: [
        'Qwen/Qwen3-Embedding-0.6B',
        'Qwen/Qwen3-Embedding-4B',
        'Qwen/Qwen3-Embedding-8B',
      ],
      default_dims: 1024, // Qwen3-Embedding-0.6B native dim
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-05-07',
    },
  },
  setup_hint:
    'Install llama.cpp, download a Qwen3-Embedding GGUF, then `llama-server --embeddings -m <model.gguf>` (default port 8080).',
};
