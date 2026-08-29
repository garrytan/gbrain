/**
 * Tolerant decode of a JSON object (or array) embedded in LLM output. A leaf
 * util with no provider/gateway imports so any layer can reuse it without a
 * dependency cycle.
 *
 * Strategies, in order:
 *   1. Strip ```json...``` fences if present, then JSON.parse.
 *   2. Direct JSON.parse.
 *   3. Find the first {...} substring (or [...] when array=true) and parse.
 *   4. Retry 1-3 with reasoning blocks stripped (see stripReasoningBlocks).
 *   5. Return null.
 *
 * Adversarial input throws are swallowed; callers get null on any failure.
 */
/**
 * Strip a reasoning model's chain-of-thought block.
 *
 * Reasoning models (DeepSeek-R1, MiniMax M2.x/M3, and any model configured to
 * emit visible thinking) put a `<think>` block BEFORE the answer, in the same
 * text channel. That reasoning routinely contains braces, because the model
 * drafts its JSON while thinking. This defeats strategy 3 in parseLlmJson: the
 * greedy `/\{[\s\S]*\}/` spans from the FIRST brace inside the reasoning to
 * the LAST brace of the real answer, so the parse fails and the caller records
 * an "unparseable" result even though a perfectly good object was returned.
 *
 * Handles both shapes: a closed `<think>…</think>` pair, and a truncated block
 * that was opened and never closed (the model exhausted its output budget).
 */
export function stripReasoningBlocks(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

export function parseLlmJson<T>(raw: string, opts: { array?: boolean } = {}): T | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const direct = parseLlmJsonInner<T>(raw, opts);
  if (direct !== null) return direct;
  // A fallback LADDER, not a pre-filter: the raw text is parsed first, so every
  // existing call site behaves byte-for-byte as before and a payload that
  // legitimately contains "<think>" is unaffected. The stripped retry runs only
  // after the raw parse has already failed, and text with no reasoning block
  // strips to itself — so the added cost on the success path is zero.
  const stripped = stripReasoningBlocks(raw);
  if (stripped && stripped !== raw.trim()) return parseLlmJsonInner<T>(stripped, opts);
  return null;
}

function parseLlmJsonInner<T>(raw: string, opts: { array?: boolean } = {}): T | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const fenceMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  const cleaned = (fenceMatch ? fenceMatch[1] : raw).trim();
  try {
    const direct = JSON.parse(cleaned);
    if (opts.array && Array.isArray(direct)) return direct as T;
    if (!opts.array && direct !== null && typeof direct === 'object') return direct as T;
  } catch {
    // fall through
  }
  const pattern = opts.array ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = cleaned.match(pattern);
  if (match) {
    try {
      const second = JSON.parse(match[0]);
      if (opts.array && Array.isArray(second)) return second as T;
      if (!opts.array && second !== null && typeof second === 'object') return second as T;
    } catch {
      // fall through
    }
  }
  return null;
}
