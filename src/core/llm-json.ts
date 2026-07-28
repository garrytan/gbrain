/**
 * Tolerant decode of a JSON object (or array) embedded in LLM output. A leaf
 * util with no provider/gateway imports so any layer can reuse it without a
 * dependency cycle.
 *
 * Strategies, in order:
 *   1. Strip ```json...``` fences if present, then JSON.parse.
 *   2. Direct JSON.parse.
 *   3. Find the first {...} substring (or [...] when array=true) and parse.
 *   4. Return null.
 *
 * Adversarial input throws are swallowed; callers get null on any failure.
 */
export function parseLlmJson<T>(raw: string, opts: { array?: boolean } = {}): T | null {
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
