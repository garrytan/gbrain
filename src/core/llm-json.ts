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
 * emit visible thinking) put a reasoning block BEFORE the answer, in the same
 * text channel. That reasoning routinely contains braces, because the model
 * drafts its JSON while thinking. This defeats strategy 3 in parseLlmJson: the
 * greedy `/\{[\s\S]*\}/` spans from the FIRST brace inside the reasoning to
 * the LAST brace of the real answer, so the parse fails and the caller records
 * an "unparseable" result even though a perfectly good object was returned.
 *
 * Also strips `<thinking>`, emitted by some models/proxies that render
 * reasoning as a tag in the text channel. Deliberately NOT covered:
 * `<reasoning>` and MiniMax's `◁think▷` sentinel — neither appears in this
 * repo's providers or fixtures, and this helper is a recovery path, not a
 * general sanitiser; add a tag only with a captured payload that shows it.
 *
 * Handles both shapes: a closed `<think(ing)>…</think(ing)>` pair, and a
 * truncated block that was opened and never closed (the model exhausted its
 * output budget). The closed-pair arm backreferences the opening tag so a
 * `<think>` is only ever closed by `</think>` — that keeps behaviour on
 * `<think>` input byte-identical to before, with `<thinking>` purely additive;
 * a MISMATCHED pair still falls through to the open-ended arm exactly as it
 * did pre-change. Order matters: closed pairs first, then any surviving
 * unclosed opener to end-of-string.
 */
export function stripReasoningBlocks(raw: string): string {
  return raw
    .replace(/<(think|thinking)>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:think|thinking)>[\s\S]*$/i, '')
    .trim();
}

/**
 * Find the index of the bracket that closes the JSON array or object opened
 * at `s[0]`, tracking nesting depth so a `[`/`]`/`{`/`}` embedded in trailing
 * prose (or a nested structure) can't be mistaken for the top-level closer.
 * Brackets inside JSON string literals (honoring `\"` escapes) are skipped so
 * they don't perturb the depth count either. `s[0]` must be `[` or `{`;
 * returns -1 for any other first character or if the structure never closes
 * within `s`.
 *
 * A naive `lastIndexOf(closeChar)` recovery — the pre-fix shape this mirrors
 * in `extract-atoms.ts` (#5064) — picks up a bracket from trailing prose
 * instead of the real terminator when a response embeds a citation AFTER an
 * otherwise well-formed array/object, e.g. `[{"a":1}]\nSee [Source: X].`: the
 * citation's `]` is the last one in the string, so the naive recovery slice
 * spans past the real array into the dangling citation text and fails to
 * parse at all. This function finds the array/object's OWN closing bracket
 * regardless of what brackets appear after it.
 */
export function findJsonCloseIndex(s: string): number {
  const open = s[0];
  const close = open === '[' ? ']' : open === '{' ? '}' : null;
  if (close === null) return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function parseLlmJson<T>(raw: string, opts: { array?: boolean } = {}): T | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const direct = parseLlmJsonInner<T>(raw, opts);
  if (direct !== null) return direct;
  // A fallback LADDER, not a pre-filter: the raw text is parsed first, so every
  // existing call site behaves byte-for-byte as before and a payload that
  // legitimately contains "<think>"/"<thinking>" is unaffected. The retry runs only
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
