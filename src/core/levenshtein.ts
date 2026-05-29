/**
 * Levenshtein edit distance + nearest-match suggestion.
 *
 * Used by `gbrain config set` (D6) to suggest the canonical key when a user
 * writes an unknown one (`embedding.provider` → "did you mean `embedding_model`?"),
 * and by init's env detection (D13) to flag near-miss env var names
 * (`OPENAPI_API_KEY` → "did you mean `OPENAI_API_KEY`?").
 *
 * Iterative two-row DP, O(m*n) time, O(min(m,n)) space. Plenty fast for the
 * ~30 known config keys and ~14 recipe env vars we compare against.
 */

/**
 * Returns the minimum number of single-character insertions, deletions, or
 * substitutions to transform `a` into `b`. Case-sensitive.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure b is the shorter — keeps the row buffer minimal.
  if (a.length < b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  const n = b.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }

  return prev[n];
}

/**
 * Finds the closest match for `input` among `candidates` whose edit distance
 * is ≤ `maxDistance` (default 3). Returns the best match or null.
 *
 * Tie-break: lexicographic order of the candidate (deterministic across runs).
 */
export function suggestNearest(
  input: string,
  candidates: readonly string[],
  maxDistance = 3,
): string | null {
  let best: string | null = null;
  let bestDist = maxDistance + 1;
  for (const c of candidates) {
    const d = editDistance(input, c);
    if (d < bestDist || (d === bestDist && best !== null && c < best)) {
      best = c;
      bestDist = d;
    }
  }
  return bestDist <= maxDistance ? best : null;
}
