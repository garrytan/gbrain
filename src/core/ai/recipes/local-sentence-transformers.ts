import type { Recipe } from '../types.ts';
import { probeOpenAICompat } from '../probes.ts';

/**
 * Local sentence-transformers HTTP shim used by GBrain's launchd-managed
 * BAAI/bge-m3 service. The service exposes an OpenAI-compatible
 * /v1/embeddings endpoint, but it is not OpenAI; keep the provider identity
 * honest so stored embedding signatures name the real model family.
 */
export const localSentenceTransformers: Recipe = {
  id: 'local-sentence-transformers',
  name: 'Local sentence-transformers',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://127.0.0.1:8765/v1',
  auth_env: {
    required: [],
    optional: ['LOCAL_SENTENCE_TRANSFORMERS_BASE_URL'],
    setup_url: 'https://www.sbert.net/',
  },
  touchpoints: {
    embedding: {
      models: ['BAAI/bge-m3'],
      default_dims: 1536,
      cost_per_1m_tokens_usd: 0,
      price_last_verified: '2026-07-05',
      no_batch_cap: true,
    },
  },
  async probe(baseURL?: string) {
    const url = baseURL ?? process.env.LOCAL_SENTENCE_TRANSFORMERS_BASE_URL ?? 'http://127.0.0.1:8765/v1';
    const result = await probeOpenAICompat(url);
    if (!result.reachable) {
      return {
        ready: false,
        hint: `local sentence-transformers service not reachable at ${url}. Start the GBrain local embeddings LaunchAgent or set LOCAL_SENTENCE_TRANSFORMERS_BASE_URL.`,
      };
    }
    if (!result.models_endpoint_valid) {
      return {
        ready: false,
        hint: `local sentence-transformers service reached but /v1/models returned an unexpected shape: ${result.error ?? 'unknown'}.`,
      };
    }
    return { ready: true };
  },
  setup_hint:
    'Start the local sentence-transformers embedding service, then configure local-sentence-transformers:BAAI/bge-m3 with embedding_dimensions 1536.',
};
