import type { Recipe } from '../types.ts';

/**
 * Version-scoped prompt-cache capability.
 *
 * Gemini's *implicit* caching is the only kind that applies here: the gateway
 * sends no cache directives on the Google path, and the explicit CachedContent
 * API is never called. Implicit caching is on by default for Gemini 2.5 and
 * newer, so those ids cache (and bill cached input at a discount) with no
 * request mutation; 1.5 and 2.0 cache only through the explicit API and stay
 * false. Ids this recipe can also serve but that never cache (Gemma) are out.
 *
 * The version digits sit in different positions across ids (`gemini-2.5-pro`,
 * `gemini-3-flash-preview`, `gemini-3.6-flash`), so match the first numeric
 * token rather than a fixed segment. A VERSIONED `-latest` alias
 * (`gemini-1.5-pro-latest`) is judged by its version — 1.5 aliases cache only
 * via the explicit API and must stay false. Only an UNVERSIONED `-latest`
 * alias (no digits to judge by) passes on the alias alone, since it resolves
 * to a current-generation model. Any other unversioned id reads false: a
 * wrong `true` silently promises a discount the provider never applies.
 */
export function googleSupportsPromptCache(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized.startsWith('gemini-')) return false;
  // Version tokens are 1-2 digits (2, 2.5, 3, 3.6, 10…); a longer numeric run
  // is a DATE/experiment suffix, not a version — `gemini-exp-1206` must not
  // parse as version 1206 and read as caching (review hardening on #4159).
  const version = normalized.match(/(?<!\d)\d{1,2}(?:\.\d+)?(?!\d)/);
  if (version !== null) return Number.parseFloat(version[0]) >= 2.5;
  return normalized.endsWith('-latest');
}

export const google: Recipe = {
  id: 'google',
  name: 'Google Gemini',
  tier: 'native',
  implementation: 'native-google',
  auth_env: {
    required: ['GOOGLE_GENERATIVE_AI_API_KEY'],
    setup_url: 'https://aistudio.google.com/apikey',
  },
  touchpoints: {
    embedding: {
      models: ['gemini-embedding-001'],
      default_dims: 768,
      dims_options: [768, 1536, 3072],
      cost_per_1m_tokens_usd: 0.15,
      price_last_verified: '2026-04-20',
      // Gemini's embedding endpoint has a low per-request cap relative to
      // Voyage. Declaring max_batch_tokens makes the gateway pre-split bulk
      // batches proactively (splitByTokenBudget) instead of relying solely on
      // the recursive-halving retry on a token-limit rejection. Conservative
      // value: each gemini-embedding-001 input tops out at 2048 tokens, so a
      // 20k budget × 0.8 safety keeps a batch well within request limits while
      // staying efficient. chars_per_token ~4 matches Gemini's SentencePiece
      // density on English. Tunable; recursion stays the backstop.
      max_batch_tokens: 20_000,
      chars_per_token: 4,
      safety_factor: 0.8,
    },
    expansion: {
      models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      cost_per_1m_tokens_usd: 0.30,
      price_last_verified: '2026-08-02',
    },
    chat: {
      // Retired by Google and deliberately NOT listed: gemini-1.5-pro
      // (#3510) and the whole gemini-2.0 family — flash, flash-lite, and
      // flash-exp all answer 404 on generateContent. Default-slot guard
      // tests validate hardcoded defaults against this list, so re-adding a
      // dead model here masks dead defaults.
      models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      supports_tools: true,
      supports_subagent_loop: true,
      // Per-model: implicit caching is a 2.5+ capability, and this recipe
      // accepts off-list ids (the config plane does not pin model ids to the
      // list above), so a recipe-wide boolean mislabels whichever side it
      // picks.
      supports_prompt_cache: googleSupportsPromptCache,
      max_context_tokens: 1000000, // Gemini 2.5 Flash
      cost_per_1m_input_usd: 0.30,
      cost_per_1m_output_usd: 2.50,
      price_last_verified: '2026-08-02',
    },
  },
  setup_hint: 'Get an API key at https://aistudio.google.com/apikey, then `export GOOGLE_GENERATIVE_AI_API_KEY=...`',
};
