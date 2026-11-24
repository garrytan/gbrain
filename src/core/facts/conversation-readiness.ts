/** Read-only deterministic parser probe; never runs the opt-in paid fallback. */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { readConversationInput } from '../conversation-parser/body.ts';
import { parseConversation } from '../conversation-parser/parse.ts';
import { unparsedCause } from './conversation-run-status.ts';
import { conversationSkip } from './conversation-skip.ts';

export async function conversationParseBlocker(
  engine: BrainEngine,
  page: Page,
  llmFallback: boolean,
): Promise<string | null> {
  const input = await readConversationInput(engine, page);
  const parsed = parseConversation(input.body, {
    page,
    ...(input.window?.fallbackDate ? { fallbackDate: input.window.fallbackDate } : {}),
  });
  // Deterministic matches (including terminal single-message/prose outcomes)
  // still need the normal extraction publisher to record their outcome.
  // A configured fallback can act on true misses, but never on regex matches.
  if (parsed.phase === 'no_match' && parsed.messages.length === 0 && !llmFallback &&
      !conversationSkip(page, input.body, parsed, parsed.messages, { llmFallback })) {
    return unparsedCause(parsed, false).reason;
  }
  return null;
}
