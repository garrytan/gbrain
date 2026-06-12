import type { Recipe } from '../types.ts';

/**
 * Upstage Solar Embeddings.
 *
 * Endpoint is OpenAI-compatible in response shape at:
 *   https://api.upstage.ai/v1/solar/embeddings
 * so the AI SDK base URL is the parent path:
 *   https://api.upstage.ai/v1/solar
 *
 * Solar embeddings are asymmetric: use the passage model for indexed chunks
 * and the query model for search queries. Both return 4096-dim vectors in a
 * unified space. gateway.ts's upstageCompatFetch rewrites the model field from
 * the side-channel `input_type` emitted by dimsProviderOptions().
 */
export const upstage: Recipe = {
  id: 'upstage',
  name: 'Upstage',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.upstage.ai/v1/solar',
  auth_env: {
    required: ['UPSTAGE_API_KEY'],
    setup_url: 'https://console.upstage.ai/api-keys',
  },
  touchpoints: {
    embedding: {
      models: [
        'solar-embedding-1-large-passage',
        'solar-embedding-1-large-query',
      ],
      default_dims: 4096,
      dims_options: [4096],
      // Upstage documents a 4K context window for the Solar embedding family.
      // Keep pre-split conservative on mixed CJK/code/JSON payloads; runtime
      // recursive halving remains the safety net for provider-side batch caps.
      max_batch_tokens: 100_000,
      chars_per_token: 1,
      safety_factor: 0.5,
    },
  },
  setup_hint: 'Get an API key at https://console.upstage.ai/api-keys, then `export UPSTAGE_API_KEY=...`',
};
