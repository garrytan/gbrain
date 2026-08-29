import type { Recipe } from '../types.ts';

/**
 * nan.builders (https://api.nan.builders) reranker. OpenAI-compatible
 * surface: `POST {base}/v1/rerank` with `{model, query, documents, top_n?}`,
 * response `{results: [{index, relevance_score}]}` — rides
 * gateway.rerank()'s native path with only the recipe-pluggable `path`
 * override (v0.40.6.1).
 *
 * Live-verified 2026-08-22 against the hosted endpoint: `/v1/rerank` with
 * model `rerank` (a Qwen3-Reranker-8B deployment) returns 200
 * `results[].relevance_score`. The base URL already ends in `/v1`, so
 * `${base_url}${path}` → `…/v1/rerank`. Bare `/rerank` and
 * `/compatible-api/v1/reranks` both 404 — only the `/v1`-anchored leaf
 * serves rerank.
 *
 * This is a SEPARATE recipe, reranker-only in scope: it declares only the
 * `reranker` touchpoint and no embedding surface. nan.builders does expose an
 * OpenAI-compatible embeddings surface on the same base URL; it is simply not
 * added here — rerank is the use case behind this recipe, and an embedding
 * recipe can be added later without touching this one.
 *
 * The model id is the literal `rerank`. Auth is `NAN_API_KEY` (the name the
 * provider's own docs use; matches the repo's <PROVIDER>_API_KEY convention).
 * No per-1M price is declared — the service is quota-based, so the budget
 * tracker treats it as unpriced (warn-once path) unless a caller sets a cap.
 */
export const nan: Recipe = {
  id: 'nan',
  name: 'nan.builders (reranker)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.nan.builders/v1',
  auth_env: {
    required: ['NAN_API_KEY'],
    setup_url: 'https://nan.builders/docs/getting-started',
  },
  touchpoints: {
    reranker: {
      // Model id served by nan.builders today (Qwen3-Reranker-8B).
      models: ['rerank'],
      default_model: 'rerank',
      // Defensive ceiling; gateway pre-flights and fails open.
      max_payload_bytes: 5_000_000,
      // Openai-compatible leaf: `{base}/v1/rerank`.
      path: '/rerank',
      // Hosted API: cross-region latency can exceed the 5s gateway default.
      default_timeout_ms: 30_000,
    },
  },
  setup_hint:
    'Get an API key at https://nan.builders/ (docs: https://nan.builders/docs/getting-started), ' +
    'then `export NAN_API_KEY=...` and `gbrain config set search.reranker.model nan:rerank`.',
};
