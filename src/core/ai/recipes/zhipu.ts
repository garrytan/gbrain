import type { Recipe } from '../types.ts';

/**
 * Zhipu AI (智谱AI) BigModel Open Platform. OpenAI-compatible /embeddings
 * endpoint at open.bigmodel.cn. Hosts embedding-2 (1024d) and embedding-3
 * (Matryoshka up to 2048d).
 *
 * embedding-3 at 2048 dims exceeds pgvector's HNSW cap of 2000 — those
 * brains fall back to exact vector scans (see
 * src/core/ai/vector-index.ts:PGVECTOR_HNSW_VECTOR_MAX_DIMS). v0.32 ships
 * with `default_dims: 1024` (HNSW-compatible) and exposes 2048 via
 * dims_options for users who want the full embedding fidelity at the
 * cost of slower retrieval.
 *
 * Reference: https://open.bigmodel.cn/
 */
export const zhipu: Recipe = {
  id: 'zhipu',
  name: 'Zhipu AI (智谱AI BigModel)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://open.bigmodel.cn/api/paas/v4',
  auth_env: {
    required: ['ZHIPUAI_API_KEY'],
    setup_url: 'https://open.bigmodel.cn/',
  },
  touchpoints: {
    embedding: {
      models: ['embedding-3', 'embedding-2'],
      default_dims: 1024,
      // 2048 exposed but breaks HNSW (exact-scan fallback). 1024/512/256
      // stay HNSW-compatible.
      dims_options: [256, 512, 1024, 2048],
      max_batch_tokens: 8192,
      chars_per_token: 2,
    },
  },
  setup_hint:
    'Get an API key at https://open.bigmodel.cn/, then `export ZHIPUAI_API_KEY=...`',
};
