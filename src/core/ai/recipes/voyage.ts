import type { Recipe } from '../types.ts';

/**
 * Voyage AI exposes an OpenAI-compatible /embeddings endpoint.
 * Base URL: https://api.voyageai.com/v1
 *
 * Hosted v4 trio (voyage-4-large / voyage-4 / voyage-4-lite, Jan 2026):
 * shared embedding space, flexible dims (256/512/1024/2048), 32K context,
 * MoE architecture (large). You can index with voyage-4-large and query with
 * voyage-4-lite — no reindex.
 *
 * voyage-4-nano is a DIFFERENT thing: an open-weight variant Voyage lists
 * separately. It does NOT accept the `output_dimension` parameter on
 * Voyage's hosted API — fixed 1024-dim. See VOYAGE_OUTPUT_DIMENSION_MODELS
 * in src/core/ai/dims.ts; nano is intentionally excluded.
 *
 * voyage-multimodal-3 (v0.27.1): text + image inputs in the same 1024-dim
 * space. supports_multimodal flips routing to embedMultimodal() in the
 * gateway. Text-only Voyage models keep their existing path.
 */
export const voyage: Recipe = {
  id: 'voyage',
  name: 'Voyage AI',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.voyageai.com/v1',
  auth_env: {
    required: ['VOYAGE_API_KEY'],
    setup_url: 'https://dash.voyageai.com/api-keys',
  },
  touchpoints: {
    embedding: {
      models: [
        'voyage-4-large', 'voyage-4', 'voyage-4-lite', 'voyage-4-nano',
        'voyage-code-4',
        'voyage-3.5', 'voyage-3-large', 'voyage-3', 'voyage-3-lite',
        'voyage-code-3', 'voyage-finance-2', 'voyage-law-2',
        'voyage-multimodal-3',
      ],
      // v0.46.3: canonical pick for every "choose a model for the user" surface.
      // models[0] is voyage-4-large (quality order); the new-install default is
      // voyage-4 (price/quality balance, shared v4 embedding space) — see
      // NEW_INSTALL_DEFAULT_EMBEDDING_MODEL in ai/defaults.ts.
      default_model: 'voyage-4',
      default_dims: 1024,
      // Display hint for `gbrain providers` only (billing math goes through
      // src/core/embedding-pricing.ts). Rate for the default voyage-4-large.
      cost_per_1m_tokens_usd: 0.12,
      price_last_verified: '2026-07-28',
      // Voyage enforces 120K tokens per batch. Voyage's tokenizer runs
      // ~3-4× denser than OpenAI tiktoken on mixed content (code/JSON/CJK),
      // so the per-recipe pre-split uses 1 char ≈ 1 token at 0.5 utilization
      // (60K char budget). Recursive halving in the gateway is the runtime
      // safety net when dense payloads still overshoot.
      max_batch_tokens: 120_000,
      chars_per_token: 1,
      safety_factor: 0.5,
      supports_multimodal: true,
      // v0.28.11: only voyage-multimodal-3 is valid at /multimodalembeddings.
      // The 11 text-only Voyage models above share supports_multimodal: true
      // at the recipe level (Codex F1 from PR #719 review). Without this
      // explicit list, embedMultimodal() would let `voyage:voyage-3-large`
      // through local validation and Voyage would reject it with HTTP 400 —
      // which gateway.ts:626 misclassifies as transient (TODO: reclassify
      // 4xx).
      multimodal_models: ['voyage-multimodal-3'],
    },
    // v0.46.3: Voyage reranking (the recommended zerank-2 replacement — same
    // VOYAGE_API_KEY as embeddings). gateway.rerank() posts to
    // `${base_url_default}/rerank` (base already ends in /v1). Wire dialect:
    // request takes `top_k` (declared via top_param); response is
    // {object: "list", data: [{index, relevance_score}]} — live-wire verified
    // 2026-08-15; the gateway's parser accepts both data[] and results[].
    reranker: {
      // #4938: rerank-3 / rerank-3-lite are Voyage's current generation
      // (32K context, same request/response wire as 2.5 — `{query, documents,
      // model}` in, `data[{index, relevance_score}]` out, so `path` and
      // `top_param` are unchanged). Voyage's pricing table grants the
      // rerank-3 pair 200M complimentary tokens. Do NOT infer from that that
      // the 2.5 pair has none: the same page's prose says the first 200M of
      // rerank-2.5/-lite are also free, contradicting its own table's "0"
      // column, so the 2.5 grant is genuinely unresolved upstream and no
      // gbrain surface asserts either way. Listed FIRST in quality order;
      // `default_model`
      // deliberately stays `rerank-2.5` so an upgrade never silently moves an
      // existing install onto a different reranker — operators opt in with
      // `gbrain config set search.reranker.model voyage:rerank-3`.
      models: ['rerank-3', 'rerank-3-lite', 'rerank-2.5', 'rerank-2.5-lite'],
      default_model: 'rerank-2.5',
      path: '/rerank',
      top_param: 'top_k',
      // https://docs.voyageai.com/docs/pricing (rerank-3 pair verified
      // 2026-09-06; 2.5 pair 2026-08-15): rerank-3 $0.05/M, rerank-3-lite
      // $0.02/M (both after 200M free tokens), rerank-2.5 $0.05/M,
      // rerank-2.5-lite $0.02/M. This scalar is a per-touchpoint display hint
      // for `gbrain providers` and cannot express a per-model free tier;
      // per-model billing math goes through src/core/embedding-pricing.ts.
      cost_per_1m_tokens_usd: 0.05,
      price_last_verified: '2026-09-06',
      // Voyage enforces token-based caps (32K per query+document pair,
      // ≤1000 documents/request) rather than a byte cap; 5MB is a
      // conservative byte-level proxy matching the ZE-era pre-flight so
      // oversized bodies still fail open before the wire.
      max_payload_bytes: 5_000_000,
    },
  },
  setup_hint: 'Get an API key at https://dash.voyageai.com/api-keys, then `export VOYAGE_API_KEY=...`',
};
