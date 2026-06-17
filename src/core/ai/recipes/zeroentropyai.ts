import type { Recipe } from '../types.ts';

/**
 * ZeroEntropy ships two specialized small models that target the two weakest
 * retrieval moments in a gbrain pipeline:
 *
 *  - zembed-1 — flexible-dim embedding (2560 default; also 1280/640/320/160/80/40),
 *    distilled from zerank-2, 32K context. Asymmetric `input_type: query|document`
 *    encoding (like Voyage and MiniMax). $0.025/1M tokens (sale) / $0.05 regular.
 *
 *  - zerank-{2,1,1-small} — cross-encoder rerankers. zerank-2 is flagship;
 *    multilingual + instruction-following; $0.025/1M tokens.
 *
 * Endpoints (from docs.zeroentropy.dev):
 *   POST https://api.zeroentropy.dev/v1/models/embed
 *   POST https://api.zeroentropy.dev/v1/models/rerank
 *
 * The AI-SDK openai-compatible adapter calls `${base_url}/embeddings` — wrong
 * path for ZE. `zeroEntropyCompatFetch` in gateway.ts rewrites the URL path to
 * `/models/embed`, injects `input_type` (default 'document') + explicit
 * `encoding_format: 'float'`, and rewrites the response shape from
 * `{results: [{embedding}]}` to `{data: [{embedding, index}]}` so the SDK's
 * Zod schema validates. Response carries `usage.prompt_tokens = total_tokens`
 * because ZE's response has no prompt_tokens field (Voyage's shim hit the
 * same SDK schema requirement at gateway.ts:655).
 *
 * The reranker side uses gateway.rerank() (a native HTTP path) — the AI SDK
 * has no reranking abstraction so there's no openai-compat seam to plug into.
 * `touchpoints.reranker` declares the model allowlist and 5MB payload cap.
 */
export const zeroentropyai: Recipe = {
  id: 'zeroentropyai',
  name: 'ZeroEntropy',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.zeroentropy.dev/v1',
  auth_env: {
    required: ['ZEROENTROPY_API_KEY'],
    setup_url: 'https://dashboard.zeroentropy.dev',
  },
  touchpoints: {
    embedding: {
      models: ['zembed-1'],
      default_dims: 2560,
      // ZE rate-limits free tier at 500KB/min input; max payload 5MB/request.
      // Pre-split budget = 120K tokens × 0.5 safety × 1 char/token ≈ 60K chars
      // per batch, same dense-content hedge Voyage uses.
      max_batch_tokens: 120_000,
      chars_per_token: 1,
      safety_factor: 0.5,
      supports_multimodal: false,
      cost_per_1m_tokens_usd: 0.05,
      price_last_verified: '2026-05-14',
    },
    reranker: {
      models: ['zerank-2', 'zerank-1', 'zerank-1-small'],
      default_model: 'zerank-2',
      cost_per_1m_tokens_usd: 0.025,
      price_last_verified: '2026-05-14',
      // ZE enforces 5MB per /v1/models/rerank request. gateway.rerank()
      // pre-flights the body size and fails open (no throw to caller).
      max_payload_bytes: 5_000_000,
    },
  },
  setup_hint:
    'Get an API key at https://dashboard.zeroentropy.dev, then `export ZEROENTROPY_API_KEY=...`',
};
