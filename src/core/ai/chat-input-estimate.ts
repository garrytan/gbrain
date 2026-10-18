/**
 * chat-input-estimate — the pre-flight input-token estimate `gateway.chat()`
 * reserves against the budget tracker before the SDK has counted anything.
 *
 * Heuristic (~4 chars/token). Everything the provider tokenizes as prompt is
 * counted: the system prompt, every text block, tool-call inputs and
 * tool-result outputs in the history, and the tool definitions (name,
 * description and JSON schema) — a tool-heavy subagent turn used to be
 * estimated from its text blocks alone, so a prompt that had already crossed
 * a model's long-prompt pricing threshold (#6448 item 1) was reserved at the
 * base tier. Cap math stays best-effort; `record()` settles the exact count.
 */

export interface ChatInputEstimateOpts {
  system?: string;
  messages?: Array<{ content?: unknown }>;
  tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
}

export const CHAT_INPUT_CHARS_PER_TOKEN = 4;

function jsonChars(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return String(value).length;
  }
}

export function estimateChatInputTokens(opts: ChatInputEstimateOpts): number {
  let chars = (opts.system ?? '').length;
  for (const m of opts.messages ?? []) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
      continue;
    }
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (typeof block?.text === 'string') chars += block.text.length;
      if (block?.type === 'tool-call') chars += jsonChars(block.input) + jsonChars(block.toolName);
      if (block?.type === 'tool-result') chars += jsonChars(block.output);
    }
  }
  for (const tool of opts.tools ?? []) {
    chars += jsonChars(tool.name) + jsonChars(tool.description) + jsonChars(tool.inputSchema);
  }
  return Math.ceil(chars / CHAT_INPUT_CHARS_PER_TOKEN);
}
