import type { Recipe } from '../types.ts';

/**
 * Zhipu AI (智谱AI) BigModel Open Platform. OpenAI-compatible /embeddings and
 * /chat/completions endpoints at open.bigmodel.cn. Hosts embedding-2 (1024d),
 * embedding-3 (Matryoshka up to 2048d), and the GLM chat family (glm-5.1 etc.)
 * with native tool calling — usable for models.tier.subagent (#1157).
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
    chat: {
      // Informational list (openai-compat tier: assertTouchpoint doesn't
      // enforce it), so newer GLM ids pass without a recipe edit.
      models: ['glm-5.3', 'glm-5.3-flash', 'glm-5.1', 'glm-4.6', 'glm-4.5'],
      supports_tools: true,
      // GLM-4.5+ and the GLM-5.x series reason by default and bill that
      // reasoning as output tokens (gbrain#4727) — the exact semantic
      // thinking_by_default documents (see deepseek.ts). Predicate scoped to
      // 4.5+ ids so older GLM ids routed through this recipe (glm-4,
      // glm-4-plus, glm-3-turbo) keep the conservative output caps.
      thinking_by_default: (modelId) => /glm-(4\.[5-9]|[5-9])/i.test(modelId),
      // gbrain-side stable tool ids (v0.38 D11) decoupled the loop from
      // Anthropic response formats; GLM tool calling is stable through the
      // OpenAI-compat path, same as deepseek/groq.
      supports_subagent_loop: true,
      // Anthropic-style cache_control markers are not honored on the
      // OpenAI-compat path — the loop runs hot (degraded:no_caching warn).
      supports_prompt_cache: false,
      max_context_tokens: 128000,
    },
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
    'Get an API key at https://open.bigmodel.cn/, then `export ZHIPUAI_API_KEY=...`. Chat/subagent: use `zhipu:glm-5.1`.',
};
