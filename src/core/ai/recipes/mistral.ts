import type { Recipe } from '../types.ts';

/**
 * Mistral AI exposes an OpenAI-compatible API at https://api.mistral.ai/v1
 * (/embeddings + /chat/completions). EU-hosted — the reason this recipe
 * exists: a brain that must stay inside EU jurisdiction can run embed +
 * expansion + chat on a single provider without a US hop.
 *
 * Verified against the live API on 2026-07-19 (model catalog, embedding
 * dimensions, dimension-parameter rejection, and the batch ceiling — see
 * the notes on each field below).
 *
 * DIMENSIONS — mistral-embed is FIXED 1024 and accepts NO dimension
 * parameter at all. Both spellings are rejected upstream:
 *   {"dimensions": 512}        -> 400 extra_forbidden (not in the API schema)
 *   {"output_dimension": 512}  -> 400 "This model does not support output_dimension"
 * The generic `openai-compatible` branch of dims.ts:dimsProviderOptions()
 * already falls through to `return undefined` for these model ids, so no
 * dimension field is emitted. Do NOT add mistral-embed to any of the
 * flexible-dim allowlists there — it would 400 every embed call. Same
 * contract as voyage-4-nano, for the same reason.
 *
 * codestral-embed / codestral-embed-2505 are deliberately NOT listed: they
 * return 1536 dims, and a touchpoint carries a single `default_dims`.
 * Mixing them under a 1024 declaration is the mixed-dim footgun
 * embedding-dim-check.ts exists to catch. They are code-retrieval models
 * anyway; a prose brain wants mistral-embed.
 */
export const mistral: Recipe = {
  id: 'mistral',
  name: 'Mistral AI',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://api.mistral.ai/v1',
  auth_env: {
    required: ['MISTRAL_API_KEY'],
    setup_url: 'https://console.mistral.ai/api-keys',
  },
  touchpoints: {
    embedding: {
      models: ['mistral-embed', 'mistral-embed-2312'],
      default_dims: 1024,
      // Mistral's published list price. Advisory only — canonical embedding
      // spend accounting lives in src/core/embedding-pricing.ts.
      cost_per_1m_tokens_usd: 0.1,
      price_last_verified: '2026-07-19',
      // Measured ceiling, not a doc guess: the /embeddings endpoint accepts a
      // 65,286-token batch and rejects 66,960 with
      //   400 code 3210 "Too many tokens overall, split into more batches."
      // -> the real cap is 65,536 (64K) tokens per request.
      max_batch_tokens: 65_536,
      // chars_per_token is a DIVISOR in splitByTokenBudget()
      // (estTokens = text.length / charsPerToken), so a LOWER value is the
      // conservative direction. The module default of 4 is an English-prose
      // assumption; German prose measured 3.58 here, and code/JSON/CJK runs
      // denser still. 2 keeps the estimate above the real token count for
      // every content shape we see.
      chars_per_token: 2,
      // With safety_factor 0.5 the pre-split budget is 32,768 estimated
      // tokens = 65,536 chars. Worst realistic density (~1.5 chars/token)
      // puts that at ~43.7K real tokens — still clear of the 64K ceiling.
      safety_factor: 0.5,
    },
    expansion: {
      models: ['ministral-3b-latest', 'mistral-small-latest'],
      price_last_verified: '2026-07-19',
    },
    chat: {
      models: [
        'mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest',
        'ministral-3b-latest', 'ministral-8b-latest', 'magistral-small-latest',
      ],
      supports_tools: true,
      // Same call as the Moonshot recipe: ordinary tool calls are fine, but
      // gbrain's subagent loop stays Anthropic-pinned for stable tool_use_id
      // behavior across crashes/replays.
      supports_subagent_loop: false,
      supports_prompt_cache: false,
      max_context_tokens: 262144,
      price_last_verified: '2026-07-19',
    },
  },
  setup_hint: 'Get an API key at https://console.mistral.ai/api-keys, then `export MISTRAL_API_KEY=...` and use `mistral:mistral-embed` (1024 dims) for embeddings.',
};
