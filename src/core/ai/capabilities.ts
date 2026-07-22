/**
 * Provider capability detection for the gateway-native subagent tool loop.
 *
 * Pre-v0.38 the subagent loop was Anthropic-direct (`new Anthropic()` instantiated
 * in `src/core/minions/handlers/subagent.ts`). The three-layer pin
 * (`queue.ts:87-106` + `subagent.ts:149-167` + `doctor.ts:1190-1225` enforced
 * Anthropic-only because crash-replay relied on Anthropic's stable `tool_use_id`s
 * for reconciliation. v0.38 (D11) moves the stable-ID generation gbrain-side
 * (ordinal + uuid v7 persisted in `subagent_tool_executions` at first observation),
 * which decouples the loop from any specific provider's response format.
 *
 * This module reads capabilities from the recipe (`src/core/ai/recipes/*.ts`)
 * and surfaces them via a normalized `ProviderCapabilities` shape that the
 * gateway's `toolLoop()` consumes to decide:
 *   - REFUSE at submit when tool-calling is unsupported (D6 — useless loop)
 *   - WARN at submit when prompt caching is unavailable (D6 — cost regression)
 *   - INFO at submit when parallel tools unsupported (D6 — just slower)
 *
 * The capability shape is intentionally narrow. Per-call cost is already in
 * `ChatTouchpoint.cost_per_1m_*`; we don't re-export it here because routing
 * decisions don't depend on it.
 */

import { resolveRecipe } from './model-resolver.ts';
import { AIConfigError } from './errors.ts';

export interface ProviderCapabilities {
  /** Provider returns native function/tool calling. Required for the subagent loop. */
  supportsToolCalling: boolean;

  /**
   * Anthropic-style ephemeral prompt cache markers honored. When false, the
   * loop runs hot (no cache_control injection) and per-turn costs scale
   * linearly with conversation length. Doesn't break the loop; just costs more.
   */
  supportsPromptCaching: boolean;

  /**
   * Provider can return multiple `tool_use` blocks in a single assistant turn
   * and accepts a single follow-up `user` message with matching `tool_result`
   * blocks. When false, the loop falls back to serial tool dispatch (one tool
   * per turn), which matches the v0.15 default and is a perf hit, not a
   * correctness issue.
   *
   * NOTE: this currently reads from `recipe.touchpoints.chat.supports_tools`
   * because no recipe exposes a separate parallel-tools field today. Treat as
   * "best-effort capability hint" — when the gateway tool loop lands in v0.38
   * Slice 4 it will add parallel dispatch with a per-recipe gate.
   */
  supportsParallelTools: boolean;

  /**
   * Provider supports an extended-thinking / reasoning block in responses.
   * Not load-bearing for the loop; surfaced so callers (e.g. `gbrain agent run`)
   * can decide whether to surface the reasoning trace in `--follow` output.
   */
  supportsThinking: boolean;

  /**
   * Max input+output tokens the provider/model accepts per turn. Drives the
   * gateway's pre-flight context check; the loop refuses to send a prompt
   * that exceeds this (with a paste-ready truncation hint).
   */
  maxContext: number;
}

/**
 * Resolve a `provider:model` string and return its capability set.
 *
 * Throws `AIConfigError` when the provider/model is unknown OR when the
 * provider lacks a `chat` touchpoint (e.g., embedding-only providers like
 * Voyage). Callers that want a soft check can wrap in try/catch and degrade.
 */
export function getProviderCapabilities(modelString: string): ProviderCapabilities {
  const { recipe, parsed } = resolveRecipe(modelString);
  const chat = recipe.touchpoints.chat;
  if (!chat) {
    throw new AIConfigError(
      `Provider "${recipe.id}" does not offer a chat touchpoint.`,
      `Known providers with chat: openai, anthropic, google, openrouter, litellm-proxy, deepseek, groq, together, azure-openai, dashscope, minimax, zhipu, ollama, llama-server. Pick one for models.tier.subagent.`,
    );
  }

  // For native providers, the model must be in the recipe's allow-list. For
  // openai-compatible recipes (litellm, ollama, llama-server), arbitrary model
  // ids are accepted because the gateway behind the proxy decides what's real.
  // We don't error here — `assertTouchpoint` already enforces this at gateway
  // boundary; this function returns capabilities for whatever the user asked
  // for, on the assumption it'll be validated elsewhere.

  return {
    supportsToolCalling: chat.supports_tools === true,
    supportsPromptCaching: chat.supports_prompt_cache === true,
    // No recipe exposes parallel-tools-specifically yet; gate on supports_tools.
    // Subsequent waves can split this into its own recipe field if a provider
    // ever supports tools without parallel dispatch.
    supportsParallelTools: chat.supports_tools === true,
    // Not exposed by ChatTouchpoint today — defaults to false. Recipes can add
    // a `supports_thinking` field later without breaking this helper (it'll
    // just keep returning false until a recipe sets it).
    supportsThinking: false,
    maxContext: chat.max_context_tokens ?? 128_000,
  };

  // The `parsed` binding is intentionally unused — `resolveRecipe` is called
  // here for its validation side-effects (throws on unknown provider). Keeping
  // the destructure makes future per-model capability overrides cheap.
  void parsed;
}

/**
 * Tier-1 gate consumed by `enforceSubagentCapable()` in src/core/model-config.ts
 * (D6 + D7). Returns:
 *
 *   - `'ok'` — provider has tool-calling, prompt caching, and parallel tools.
 *     Loop runs at full speed.
 *   - `'degraded:no_caching'` — provider supports tools but lacks prompt
 *     caching. Loop runs but per-turn cost is higher. Warn once per
 *     (source, model) pair.
 *   - `'degraded:no_parallel'` — provider supports tools and caching but the
 *     loop will dispatch serially. Info-log; no warn.
 *   - `'unusable:no_tools'` — provider lacks tool calling entirely. Refuse at
 *     submit; the loop has no way to execute brain ops.
 *   - `'unknown'` — the provider/model isn't in any recipe. Refuse at submit
 *     (defensive: don't spend money on an unrecognized provider).
 *
 * Pure function; no side effects. The caller decides what to do with each
 * verdict (warn / info / throw) based on its surface.
 */
export type CapabilityVerdict =
  | 'ok'
  | 'degraded:no_caching'
  | 'degraded:no_parallel'
  | 'unusable:no_tools'
  | 'unknown';

export function classifyCapabilities(modelString: string): CapabilityVerdict {
  let caps: ProviderCapabilities;
  try {
    caps = getProviderCapabilities(modelString);
  } catch {
    return 'unknown';
  }
  if (!caps.supportsToolCalling) return 'unusable:no_tools';
  if (!caps.supportsPromptCaching) return 'degraded:no_caching';
  if (!caps.supportsParallelTools) return 'degraded:no_parallel';
  return 'ok';
}
