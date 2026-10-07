/**
 * Tolerant decode of a JSON object (or array) embedded in LLM output. A leaf
 * util with no provider/gateway imports so any layer can reuse it without a
 * dependency cycle.
 *
 * Strategies, in order:
 *   1. Strip ```json...``` fences if present, then JSON.parse.
 *   2. Direct JSON.parse.
 *   3. Find the first {...} substring (or [...] when array=true) and parse.
 *   4. When a fence was found and 1-3 failed on its extract, locate the JSON
 *      value with the string-aware bracket scan instead (see
 *      recoverFromQuotedFence): a ``` inside a JSON string value ends the
 *      non-greedy fence extract early.
 *   5. Retry 1-4 with reasoning blocks stripped (see stripReasoningBlocks).
 *   6. Return null.
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
 * Where the JSON array or object opening at `text[openAt]` ends: the index of
 * its own closing bracket, or -1 when `text[openAt]` is not `[`/`{` (including
 * an out-of-range `openAt`) or the value is still open at the end of `text`.
 * String literals are skipped whole, so a bracket quoted in a field cannot end
 * the value, and a bracketed citation after the value (`[Source: X]`,
 * `[[wikilink]]`) is never reached. Only the opener's own kind is counted; a
 * stray closer of the other kind is left for JSON.parse to reject.
 */
export function matchingCloseBracket(text: string, openAt = 0): number {
  const opener = text.charAt(openAt);
  if (opener !== '[' && opener !== '{') return -1;
  const closer = opener === '[' ? ']' : '}';
  let open = 0;
  for (let i = openAt; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      i = closingQuote(text, i);
      if (i === -1) return -1;
    } else if (ch === opener) {
      open += 1;
    } else if (ch === closer) {
      open -= 1;
      if (open === 0) return i;
    }
  }
  return -1;
}

/** Index of the `"` that ends the string literal starting at `text[quoteAt]`, or -1 if it never ends. */
function closingQuote(text: string, quoteAt: number): number {
  for (let i = quoteAt + 1; i < text.length; i++) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i;
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
  return fenceMatch ? recoverFromQuotedFence<T>(raw, fenceMatch, opts) : null;
}

/**
 * Second chance for a fenced reply whose extract did not parse (#6069). The
 * fence regex is non-greedy, so it ends at the first ``` after the opener,
 * and a verbatim quote of a code block puts exactly that inside a JSON string.
 * The matched ``` is then one of two things, and the string-aware bracket scan
 * (matchingCloseBracket) tells them apart without trusting any later ```:
 *
 *   - a quote inside an unfenced reply: the first JSON value in the text
 *     opens before the match and closes after it, so that value is the answer;
 *   - the real opening fence: the answer is the JSON value the fenced body
 *     starts with. Text before the fence (prose braces, a reasoning draft) is
 *     never a candidate, so a cut-off answer stays null, and a ``` quoted
 *     mid-string (followed by more string text) never passes for an opener,
 *     so a nested fragment after it is not mistaken for the answer.
 *
 * Either way the chosen value must itself be the wanted shape; a nested array
 * inside an object reply is not an array answer. Runs only after the extract
 * failed, so replies that parsed before are untouched. A value that never
 * closes, or does not parse, gives null.
 */
function recoverFromQuotedFence<T>(raw: string, fence: RegExpMatchArray, opts: { array?: boolean }): T | null {
  const fenceAt = fence.index ?? 0;
  const firstValueFrom = (from: number): { start: number; text: string } | null => {
    const offset = raw.slice(from).search(/[[{]/);
    if (offset < 0) return null;
    const start = from + offset;
    const close = matchingCloseBracket(raw, start);
    return close < 0 ? null : { start, text: raw.slice(start, close + 1) };
  };

  const leading = firstValueFrom(0);
  const quotesFence = leading !== null && leading.start < fenceAt && leading.start + leading.text.length > fenceAt;
  const bodyAt = fenceAt + fence[0].length - fence[1].length - 3;
  const opensBody = /^\s*[[{]/.test(raw.slice(bodyAt));
  const answer = quotesFence ? leading : opensBody ? firstValueFrom(bodyAt) : null;
  return answer === null ? null : decodeShape<T>(answer.text, opts);
}

function decodeShape<T>(text: string, opts: { array?: boolean }): T | null {
  try {
    const value: unknown = JSON.parse(text);
    if (opts.array) return Array.isArray(value) ? (value as T) : null;
    return value !== null && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}
