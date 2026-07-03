/**
 * UTF-16-surrogate-safe text helpers.
 *
 * Shared between:
 *   - `src/core/eval-contradictions/judge.ts` — `truncateUtf8` truncates
 *     contradiction-judge prompt inputs to a per-pair char budget without
 *     splitting emoji / non-BMP CJK / mathematical alphanumerics.
 *   - `src/core/cycle/synthesize.ts` — `safeSplitIndex` is the tier-3
 *     hard-split fallback in the dream-cycle chunker. Preserves the D9
 *     stable-chunk-identity invariant by refusing to orphan a high surrogate.
 *
 * Two consumers, two natural shapes:
 *   - `truncateUtf8(text, maxChars) -> string` returns the sliced text.
 *   - `safeSplitIndex(text, maxChars) -> number` returns the boundary index
 *     without allocating the sliced string (cheaper chunker hot path).
 *
 * Both functions cover the same three surrogate cases. The agent-authored
 * `safeSliceEnd` from PRs #1378-#1382 handled only case 1; the AT-low
 * surrogate case (3) silently bit when a chunk boundary landed one
 * position inside an emoji.
 *
 * UTF-16 surrogate ranges:
 *   high surrogate: U+D800..U+DBFF
 *   low surrogate:  U+DC00..U+DFFF
 */

/**
 * Make a string well-formed UTF-16: replace any unpaired surrogate half (lone
 * high U+D800–U+DBFF / lone low U+DC00–U+DFFF) with U+FFFD, preserving valid
 * pairs untouched. A lone surrogate is rejected by Postgres inside a `::jsonb`
 * cast and aborts the WHOLE batch (#2011 — `extract --stale` died at ~1,550
 * pages because `excerpt()` raw-sliced a window boundary through an emoji); it
 * also crashes some JSON transports (the brainstorm cross-prompt path).
 *
 * Uses the Bun/JSC built-in (ES2024). `isWellFormed()` is the cheap guard that
 * avoids the `toWellFormed()` allocation when the string is already clean — the
 * common case. Prefer this over hand-rolled surrogate regexes: the two-pass
 * lookbehind regex mishandles CONSECUTIVE lone low surrogates
 * (`"\uDE80\uDE80"` → `"�\uDE80"`, still malformed), whereas the built-in
 * handles every case (`→ "��"`).
 */
export function ensureWellFormed(s: string): string {
  return s.isWellFormed() ? s : s.toWellFormed();
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * UTF-8-safe truncation: cap at maxChars but never split a multi-byte
 * character. Returns the text unchanged if already under the limit.
 *
 * Pattern reused from `src/core/minions/handlers/subagent-audit.ts` which
 * faces the same multi-byte concern.
 */
export function truncateUtf8(text: string, maxChars: number): string {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, safeSplitIndex(text, maxChars)));
}

/**
 * Return the largest safe slice index ≤ maxChars (never orphans a UTF-16
 * surrogate). Used by chunkers that need the index itself, not the
 * truncated string.
 *
 * Three back-up cases (mirrors `truncateUtf8`'s implementation exactly,
 * so the two functions cannot drift):
 *   1. Pair STRADDLES the cut: high at maxChars-1, low at maxChars.
 *      Return maxChars-1 (pair starts the next chunk together).
 *   2. Stray high at maxChars-1 (no paired low). Return maxChars-1.
 *   3. Low at maxChars-1 (we're inside a pair that started at maxChars-2).
 *      Return maxChars-2 (whole pair moves to next chunk).
 *
 * Case 3 is intentionally conservative when the pair is COMPLETE in the
 * kept half (e.g. text="abcd🚀", maxChars=6 returns 4, not 6). The 2-char
 * shortfall is harmless for chunker determinism — same input → same
 * chunks every time — and matches truncateUtf8's well-tested behavior.
 * Fixing the conservative back-up would require diverging the two
 * functions; we deliberately match them.
 */
export function safeSplitIndex(text: string, maxChars: number): number {
  if (maxChars <= 0) return 0;
  if (maxChars >= text.length) return text.length;

  const unitAtEnd = text.charCodeAt(maxChars);
  const unitBefore = text.charCodeAt(maxChars - 1);

  // Case 1: pair straddles the cut.
  if (isHighSurrogate(unitBefore) && isLowSurrogate(unitAtEnd)) {
    return maxChars - 1;
  }
  // Case 2: stray high surrogate.
  if (isHighSurrogate(unitBefore)) {
    return maxChars - 1;
  }
  // Case 3: kept half ends at low surrogate; back up two.
  if (isLowSurrogate(unitBefore)) {
    return Math.max(0, maxChars - 2);
  }
  return maxChars;
}
