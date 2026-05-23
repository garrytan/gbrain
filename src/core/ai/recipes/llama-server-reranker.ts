import type { Recipe } from '../types.ts';
import { probeLlamaServer } from '../probes.ts';

/**
 * Dedicated llama.cpp llama-server reranker endpoint.
 *
 * Keep this separate from `llama-server` embeddings because local installs
 * commonly run embeddings and reranking as two different llama-server
 * processes on different ports. Reusing provider id `llama-server` would force
 * both touchpoints through one `base_urls['llama-server']` value.
 *
 * Launch example:
 *   llama-server --model <Qwen3-Reranker-4B.gguf> --reranking --pooling rank \
 *     --alias qwen3-reranker-4b --host 127.0.0.1 --port 8081
 */
export const llamaServerReranker: Recipe = {
  id: 'llama-server-reranker',
  name: 'llama.cpp llama-server reranker (local)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:8081/v1',
  auth_env: {
    required: [],
    optional: ['LLAMA_SERVER_RERANKER_BASE_URL', 'LLAMA_SERVER_RERANKER_API_KEY'],
    setup_url:
      'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md',
  },
  touchpoints: {
    reranker: {
      models: [],
      user_provided_models: true,
      default_model: '',
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-05-23',
      max_payload_bytes: 5_000_000,
      path: '/rerank',
    },
  },
  async probe(baseURL?: string) {
    const url =
      baseURL ??
      process.env.LLAMA_SERVER_RERANKER_BASE_URL ??
      'http://localhost:8081/v1';
    const result = await probeLlamaServer(url);
    if (!result.reachable) {
      return {
        ready: false,
        hint: `llama-server reranker not reachable at ${url}. Start it with \`llama-server --model <reranker.gguf> --reranking --pooling rank\` or set LLAMA_SERVER_RERANKER_BASE_URL.`,
      };
    }
    if (!result.models_endpoint_valid) {
      return {
        ready: false,
        hint: `llama-server reranker reached but /v1/models returned an unexpected shape: ${result.error ?? 'unknown'}.`,
      };
    }
    return { ready: true };
  },
  setup_hint:
    'Build llama.cpp, then `llama-server --model <reranker.gguf> --reranking --pooling rank --port 8081`. Set reranker_model=llama-server-reranker:<id>.',
};
