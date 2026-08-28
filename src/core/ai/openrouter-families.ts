/**
 * OpenRouter model families that may drive the subagent (tool) loop.
 *
 * The gateway loop keys tool-call replay on gbrain's own tool_use id, not the
 * provider's, so what matters per family is that the proxied tool-call
 * envelope survives an abort mid-loop and a resume byte-identically. Each
 * family listed here has a live abort/retry pin under test/e2e/:
 *
 *   anthropic/  test/e2e/openrouter-anthropic-subagent-replay.live.test.ts
 *   deepseek/   test/e2e/openrouter-deepseek-subagent-replay.live.test.ts
 *
 * Other proxied families stay refused until they get their own pin
 * (TODOS.md OpenRouter follow-up). Shared by the recipe predicate and the
 * subagent handler's auto-route so the two can never disagree.
 */
export const OPENROUTER_SUBAGENT_FAMILIES: readonly string[] = ['anthropic/', 'deepseek/'];

/** `modelId` is the bare OpenRouter id (`anthropic/claude-haiku-4.5`), no `openrouter:` prefix. */
export function openrouterModelSupportsSubagentLoop(modelId: string): boolean {
  const id = modelId.trim().toLowerCase();
  return OPENROUTER_SUBAGENT_FAMILIES.some((family) => id.startsWith(family));
}
