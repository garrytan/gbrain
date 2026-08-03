import type { Recipe } from '../types.ts';

/**
 * Novita AI's OpenAI-compatible /openai/v1/embeddings endpoint.
 *
 * Reference: https://novita.ai/docs/api-reference/model-apis-llm-create-embeddings
 *
 * The `model` field is documented as an exhaustive enum with a single value
 * (`baai/bge-m3`) — no other embedding model is exposed on this endpoint as
 * of 2026-07-28, even though Novita's model console separately lists
 * qwen3-embedding-{0.6b,8b} under chat-completions pricing. Only the
 * documented embeddings-endpoint model is declared here.
 *
 * BGE-M3 (BAAI) is a fixed 1024-dim, 8192-token-context multilingual model
 * (https://huggingface.co/BAAI/bge-m3) — no Matryoshka truncation, so no
 * `dims_options`/dimensions passthrough is wired for it.
 */
export const novita: Recipe = {
  id: 'novita',
  name: 'Novita AI',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.novita.ai/openai/v1',
  auth_env: {
    required: ['NOVITA_API_KEY'],
    setup_url: 'https://novita.ai/settings/key-management',
  },
  touchpoints: {
    embedding: {
      models: ['baai/bge-m3'],
      default_dims: 1024,
      cost_per_1m_tokens_usd: 0.01,
      price_last_verified: '2026-08-03',
      // Docs cap array inputs at 2048 items; no published token-budget cap
      // beyond the model's own 8192-token context. Conservative batch cap
      // so the gateway pre-splits before hitting the item ceiling.
      max_batch_items: 2048,
    },
  },
  setup_hint: 'Get an API key at https://novita.ai/settings/key-management, then `export NOVITA_API_KEY=...`',
};
