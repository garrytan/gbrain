import type { Recipe } from '../types.ts';
import { deepseekReasoningContentCompatFetch } from './deepseek.ts';
import { openaiModelSupportsPromptCache } from './openai.ts';
import { GLM_THINKING_BY_DEFAULT_RE } from './zhipu.ts';

/**
 * Nous Research Portal — the inference API behind Hermes Agent's `nous`
 * provider and the Nous subscription. An OpenAI-compatible gateway at
 * `https://inference-api.nousresearch.com/v1` that fronts ~400 models from
 * OpenAI, Anthropic, Google, Z.ai, DeepSeek, Qwen, Mistral, xAI and Voyage
 * under vendor-prefixed ids (`z-ai/glm-5.3-flash`,
 * `openai/gpt-5.6-luna`, `anthropic/claude-sonnet-5`, ...). The public
 * `/models` catalog is OpenRouter-shaped (same id namespace, `pricing`,
 * `supported_parameters`, `context_length`), so this recipe mirrors the
 * `openrouter` one: family-scoped predicates keyed on the id prefix.
 *
 * Auth: a Portal **inference API key** (`sk-nous-…`, created in the Portal
 * dashboard) as a bearer token — the documented path for third-party
 * OpenAI-compatible applications. The Portal's OAuth device flow (what the
 * Hermes CLI and its `subscription proxy` use) is NOT implemented here: gbrain
 * recipes hold static credentials, and Hermes already ships a local proxy for
 * apps that want the OAuth path (point `provider_base_urls.nous` at it).
 *
 * Why a dedicated recipe rather than `provider_base_urls.openrouter`: the
 * Portal is a different account, a different key (`NOUS_API_KEY`, with its
 * own `nous_api_key` config slot so daemon/launchd/MCP processes receive it),
 * different pricing, and no attribution headers; sharing the openrouter
 * recipe would make one brain unable to hold both credentials.
 *
 * Embeddings: the Portal serves OpenAI and Voyage embedding models too;
 * per-model dims are listed for the ones verified against the vendors'
 * published widths. Unlisted ids resolve to 0 dims and force an explicit
 * `embedding_dimensions` (same fail-closed rule as openrouter, #4114).
 */

/** Same cutoffs as the openrouter recipe: DeepSeek v4 and GLM-4.5+/5.x think by default. */
export function nousThinkingByDefault(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.startsWith('deepseek/')) return true;
  return normalized.startsWith('z-ai/') && GLM_THINKING_BY_DEFAULT_RE.test(normalized);
}

/**
 * Server-side prefix caching by routed family. OpenAI routes cache
 * automatically for the generations openai.ts knows about; DeepSeek caches
 * every request. Anthropic routes are declared NOT caching here: caching them
 * needs the explicit `cache_control` block the openrouter compat shim
 * rewrites in, and this recipe does not ship that shim (see the module note).
 */
export function nousSupportsPromptCache(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (normalized.startsWith('openai/')) {
    const upstreamId = normalized.slice('openai/'.length).split(':', 1)[0] ?? '';
    return openaiModelSupportsPromptCache(upstreamId);
  }
  if (normalized.startsWith('deepseek/')) return true;
  return false;
}

export const nous: Recipe = {
  id: 'nous',
  name: 'Nous Research Portal',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'https://inference-api.nousresearch.com/v1',
  auth_env: {
    required: ['NOUS_API_KEY'],
    optional: ['NOUS_INFERENCE_BASE_URL'],
    setup_url: 'https://portal.nousresearch.com/api-docs',
  },
  touchpoints: {
    embedding: {
      models: ['openai/text-embedding-3-small'],
      // Widths from the vendors' published specs; slash-form ids are the
      // lookup key (embeddingDimsForModel strips only a leading `provider:`).
      model_dims: {
        'openai/text-embedding-3-small': 1536,
        'openai/text-embedding-3-large': 3072,
        'voyageai/voyage-4': 1024,
        'voyageai/voyage-4-large': 1024,
      },
      // The Portal proxies embedding models whose widths we cannot know ahead
      // of time; 0 = no silent default for unlisted ids (#4114).
      default_dims: 0,
      trust_custom_dims: true,
      dims_options: [512, 768, 1024, 1536],
      cost_per_1m_tokens_usd: 0.02, // openai/text-embedding-3-small, Portal catalog 2026-09-22
      price_last_verified: '2026-09-22',
      // OpenAI's per-request aggregate for embeddings (~300K tokens); the
      // gateway pre-splits batches against it. Per-input caps are upstream's.
      max_batch_tokens: 300_000,
    },
    // Same routed chat endpoint as `chat`; declared so an explicit
    // `expansion_model: nous:...` resolves instead of silently dropping
    // expansion (#1135). Cheap/fast ids first.
    expansion: {
      models: [
        'z-ai/glm-5.3-flash',
        'openai/gpt-5.6-luna',
        'deepseek/deepseek-v4-flash',
        'google/gemini-3.5-flash-lite',
        'anthropic/claude-haiku-4.5',
      ],
      cost_per_1m_tokens_usd: 0.09, // z-ai/glm-5.3-flash input, Portal catalog 2026-09-22
      price_last_verified: '2026-09-22',
    },
    chat: {
      // Curated entry points verified against the Portal `/models` catalog
      // on 2026-09-22 (399 models). The openai-compat tier does NOT enforce
      // this list at runtime — any id the Portal routes works.
      models: [
        'z-ai/glm-5.3-flash',
        'z-ai/glm-5.3',
        'openai/gpt-5.6-luna',
        'openai/gpt-5.6-terra',
        'openai/gpt-5.5',
        'openai/gpt-6-astra',
        'anthropic/claude-haiku-4.5',
        'anthropic/claude-sonnet-5',
        'anthropic/claude-opus-5',
        'deepseek/deepseek-v4-flash',
        'deepseek/deepseek-v4-pro',
        'google/gemini-3.5-flash',
      ],
      supports_tools: true,
      // The Portal is a transparent OpenAI-compatible gateway and every chat
      // model in its catalog advertises `tools` in supported_parameters;
      // Hermes Agent drives its full tool-calling loop through this endpoint
      // in production (GLM, DeepSeek, OpenAI, Anthropic routes alike). The
      // gateway loop keys replay on gbrain_tool_use_id, not the raw provider
      // id, so no per-family envelope pin is needed for correctness; if a
      // route proves flaky under abort/retry, narrow this to a predicate the
      // way openrouter-families.ts does.
      supports_subagent_loop: true,
      supports_prompt_cache: nousSupportsPromptCache,
      thinking_by_default: nousThinkingByDefault,
      // No max_context_tokens: the catalog spans 128K to 1M+; let per-model
      // upstream errors surface rather than pick a value wrong for most.
      cost_per_1m_input_usd: 0.09, // z-ai/glm-5.3-flash, Portal catalog 2026-09-22
      cost_per_1m_output_usd: 0.28,
      price_last_verified: '2026-09-22',
    },
  },
  // Friendly aliases for the models this recipe leads with.
  aliases: {
    'glm-flash': 'z-ai/glm-5.3-flash',
    'glm': 'z-ai/glm-5.3',
    'luna': 'openai/gpt-5.6-luna',
    'terra': 'openai/gpt-5.6-terra',
    'astra': 'openai/gpt-6-astra',
    'haiku': 'anthropic/claude-haiku-4.5',
    'sonnet': 'anthropic/claude-sonnet-5',
    'opus': 'anthropic/claude-opus-5',
  },
  setup_hint:
    'Create an inference API key at https://portal.nousresearch.com (API Docs), then ' +
    '`gbrain config set nous_api_key sk-nous-...` (or `export NOUS_API_KEY=...`). ' +
    'Chat/subagent: `nous:z-ai/glm-5.3-flash`; embeddings: `nous:openai/text-embedding-3-small`.',
  // DeepSeek routes return reasoning in `reasoning_content` and may leave
  // `content` empty on a pure-reasoning turn; the same fail-open promotion
  // the deepseek and openrouter recipes use. Inert for every other family.
  compat: { fetch: deepseekReasoningContentCompatFetch },
};
