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
 *   - REFUSE at submit/dispatch when the recipe declares
 *     `supports_subagent_loop: false` (or a per-id predicate returns false)
 *   - WARN at submit when prompt caching is unavailable (D6 — cost regression)
 *   - INFO at submit when parallel tools unsupported (D6 — just slower)
 *
 * The capability shape is intentionally narrow. Per-call cost is already in
 * `ChatTouchpoint.cost_per_1m_*`; we don't re-export it here because routing
 * decisions don't depend on it.
 */

import { resolveChatContextTokens, resolveRecipe } from './model-resolver.ts';
import { listRecipes } from './recipes/index.ts';
import { AIConfigError } from './errors.ts';

export interface ProviderCapabilities {
  /** Provider returns native function/tool calling. Required for the subagent loop. */
  supportsToolCalling: boolean;

  /**
   * Provider's tool calling is stable enough across crashes/replays (stable
   * tool_call_ids) to drive the Minions subagent loop. Mirrors the recipe's
   * `chat.supports_subagent_loop` declaration (`src/core/ai/types.ts`), which
   * is intentionally separate from — and strictly stronger than —
   * `supports_tools`: some chat-capable models have flaky tool-calling or
   * unstable tool_call_id behavior across replays.
   */
  supportsSubagentLoop: boolean;

  /**
   * The provider caches prompt prefixes at all — by either mechanism:
   * automatically server-side (OpenAI, DeepSeek; nothing to attach, and the
   * Anthropic-namespace marker the gateway adds is inert on them), or when the
   * request carries explicit `cache_control` markers (Anthropic). When false,
   * the loop runs hot and per-turn costs scale linearly with conversation
   * length. Doesn't break the loop; just costs more.
   *
   * This is deliberately "does it cache", not "does it honor our markers":
   * `enforceSubagentCapable` and `doctor` use it to decide whether to warn an
   * operator off a provider for cost reasons, and that advice is wrong for a
   * provider that caches without being asked.
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
      // Computed from the registry so the hint can't drift into listing
      // chat-less providers (the pre-fix list falsely included embedding-only
      // recipes, sending users in circles — #1157).
      `Known providers with chat: ${listRecipes().filter(r => r.touchpoints.chat).map(r => r.id).join(', ')}. Pick one for models.tier.subagent.`,
    );
  }

  // Model ids are never validated against recipe model lists (any id goes to
  // the provider, which is the real authority on what exists). This function
  // returns capabilities for whatever the user asked for; a nonexistent model
  // surfaces as the provider's own model_not_found at call time.

  const promptCache = chat.supports_prompt_cache;

  const subagentLoop = chat.supports_subagent_loop;
  return {
    supportsToolCalling: chat.supports_tools === true,
    supportsSubagentLoop: typeof subagentLoop === 'function'
      ? subagentLoop(parsed.modelId)
      : subagentLoop === true,
    supportsPromptCaching: typeof promptCache === 'function'
      ? promptCache(parsed.modelId)
      : promptCache === true,
    // No recipe exposes parallel-tools-specifically yet; gate on supports_tools.
    // Subsequent waves can split this into its own recipe field if a provider
    // ever supports tools without parallel dispatch.
    supportsParallelTools: chat.supports_tools === true,
    // Recipe-declared thinking-by-default (gbrain#4172): true when the model
    // reasons without being asked and bills that reasoning as output tokens.
    // Boolean or per-model predicate, mirroring supports_prompt_cache.
    supportsThinking: typeof chat.thinking_by_default === 'function'
      ? chat.thinking_by_default(parsed.modelId)
      : chat.thinking_by_default === true,
    maxContext: resolveChatContextTokens(modelString) ?? 128_000,
  };
}

/**
 * Tier-1 gate consumed by `enforceSubagentCapable()` in src/core/model-config.ts
 * (D6 + D7). Returns:
 *
 *   - `'ok'` — provider has tool-calling, a loop-stable declaration, prompt
 *     caching, and parallel tools. Loop runs at full speed.
 *   - `'degraded:no_caching'` — provider supports tools but lacks prompt
 *     caching. Loop runs but per-turn cost is higher. Warn once per
 *     (source, model) pair.
 *   - `'degraded:no_parallel'` — provider supports tools and caching but the
 *     loop will dispatch serially. Info-log; no warn.
 *   - `'unusable:no_tools'` — provider lacks tool calling entirely. Refuse at
 *     submit; the loop has no way to execute brain ops.
 *   - `'unusable:no_subagent_loop'` — provider has tool calling but its recipe
 *     declares `supports_subagent_loop: false` (tool_call_ids not stable
 *     across crash/replay). Refuse at submit; the loop would start but can't
 *     reconcile on replay — a correctness issue, not a cost/perf one.
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
  | 'unusable:no_subagent_loop'
  | 'unknown';

export function classifyCapabilities(modelString: string): CapabilityVerdict {
  let caps: ProviderCapabilities;
  try {
    caps = getProviderCapabilities(modelString);
  } catch {
    return 'unknown';
  }
  if (!caps.supportsToolCalling) return 'unusable:no_tools';
  if (!caps.supportsSubagentLoop) return 'unusable:no_subagent_loop';
  if (!caps.supportsPromptCaching) return 'degraded:no_caching';
  if (!caps.supportsParallelTools) return 'degraded:no_parallel';
  return 'ok';
}
