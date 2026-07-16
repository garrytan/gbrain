import type { Recipe } from '../types.ts';

/**
 * Amazon Bedrock — via a LiteLLM proxy front-end.
 *
 * Bedrock's runtime API is AWS-SigV4-signed and speaks neither the OpenAI nor
 * the Anthropic wire shape, so gbrain cannot call it directly. This recipe
 * targets a LiteLLM proxy (https://docs.litellm.ai) running in front of
 * Bedrock, which normalizes both chat and embeddings to the OpenAI-compatible
 * `/v1/chat/completions` and `/v1/embeddings` endpoints. See
 * docs/guides/litellm-proxy.md for the full setup recipe.
 *
 * Why a dedicated recipe (vs. the generic `litellm` one): the generic recipe
 * is `user_provided_models` with `default_dims: 0`, which forces the user to
 * pass `--embedding-dimensions N` — but `isCustomDimValidForProvider`
 * (embedding-dim-check.ts) then REJECTS any custom dim for `litellm` because
 * it isn't in a Matryoshka allow-list. Net effect: the litellm embedding path
 * can't be initialized at all. This recipe closes that gap by declaring the
 * Bedrock embedding models with an explicit `default_dims` + `dims_options`,
 * so `gbrain init` needs no `--embedding-dimensions` flag and custom dims pass
 * validation via the recipe-declared `dims_options` (Tier 1 of the checker).
 *
 * Model ids are Bedrock INFERENCE-PROFILE ids (the `us.`/`global.` prefix).
 * The raw on-demand ids (`anthropic.claude-opus-4-8`, `cohere.embed-v4:0`)
 * fail with a ValidationException — newer Bedrock models are inference-profile
 * only. `parseModelId` splits on the FIRST colon, so `bedrock:us.cohere.embed-v4:0`
 * resolves to modelId `us.cohere.embed-v4:0` with the trailing `:0` intact.
 *
 * Auth: none required on the gbrain side — the AWS credentials live on the
 * proxy (its boto3 chain), not in gbrain. Mirrors the ollama / llama-server
 * no-auth pattern: the gateway sends `Authorization: Bearer unauthenticated`,
 * which a loopback LiteLLM with no master_key ignores. Set BEDROCK_PROXY_API_KEY
 * only if you put a master_key on the proxy.
 *
 * Verified against a Bedrock account in us-west-2: Opus 4.8 chat + Cohere
 * Embed v4 (1536-dim) both invoke through LiteLLM 1.91.0.
 */
export const bedrock: Recipe = {
  id: 'bedrock',
  name: 'Amazon Bedrock (via LiteLLM proxy)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:4000', // LiteLLM default
  auth_env: {
    required: [], // AWS creds live on the proxy; gbrain sends no key
    optional: ['BEDROCK_PROXY_BASE_URL', 'BEDROCK_PROXY_API_KEY'],
    setup_url: 'https://docs.litellm.ai/docs/providers/bedrock',
  },
  resolveOpenAICompatConfig(env) {
    // Prefer an explicit proxy URL; fall back to the LiteLLM default. Kept in
    // an env override (not just base_url_default) so a shared/remote proxy can
    // be pointed at without editing config.
    const baseURL = env.BEDROCK_PROXY_BASE_URL ?? 'http://localhost:4000';
    return { baseURL };
  },
  touchpoints: {
    embedding: {
      // Cohere Embed v4 is the recommended Bedrock embedder (Titan is the
      // AWS-native alternative; add its profile id here if preferred). v4 is
      // Matryoshka-aware — the proxy returns 1536-dim by default; smaller
      // breakpoints are opt-in via `gbrain config set embedding_dimensions N`.
      models: ['us.cohere.embed-v4:0', 'global.cohere.embed-v4:0'],
      default_dims: 1536,
      dims_options: [256, 512, 1024, 1536],
      // Cohere Bedrock caps a single embed request at 96 texts / 128K tokens.
      // The gateway pre-splits on this aggregate budget.
      max_batch_tokens: 128_000,
      price_last_verified: '2026-07-07',
      // Embed v4 accepts image inputs (multimodal) on the same endpoint; the
      // proxy forwards content arrays with image_base64 entries.
      supports_multimodal: true,
    },
    chat: {
      // Claude on Bedrock. `think`/query synthesis routes through
      // gateway.chat() and is NOT Anthropic-gated. The Minions subagent loop
      // IS (isAnthropicProvider hard-pins native Anthropic); to drive
      // subagents on Bedrock-proxied Claude, enable the gateway-native loop:
      // `gbrain config set agent.use_gateway_loop true`.
      models: [
        'us.anthropic.claude-opus-4-8',
        'global.anthropic.claude-opus-4-8',
        'us.anthropic.claude-sonnet-4-6',
        'us.anthropic.claude-haiku-4-5',
      ],
      supports_tools: true,
      // Informational — real subagent gate is isAnthropicProvider() upstream,
      // relaxed only when agent.use_gateway_loop is on.
      supports_subagent_loop: false,
      // Even though these are Claude models, chat routes through the
      // OpenAI-compatible path (implementation: 'openai-compatible'). The
      // gateway only emits prompt-cache markers via
      // providerOptions.anthropic.cacheControl (gateway.ts), which the
      // OpenAI-compatible provider ignores — so caching is a no-op here.
      // Advertise false, matching every other openai-compat recipe.
      supports_prompt_cache: false,
      price_last_verified: '2026-07-07',
    },
  },
  setup_hint:
    'Run LiteLLM (https://docs.litellm.ai) in front of Bedrock, mapping route ' +
    'names to inference-profile ids (e.g. bedrock/us.anthropic.claude-opus-4-8, ' +
    'bedrock/us.cohere.embed-v4:0). Set BEDROCK_PROXY_BASE_URL if not on ' +
    'localhost:4000, then: --embedding-model bedrock:us.cohere.embed-v4:0 ' +
    '--chat-model bedrock:us.anthropic.claude-opus-4-8. See docs/guides/litellm-proxy.md.',
};
