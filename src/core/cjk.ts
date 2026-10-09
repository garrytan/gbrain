/**
 * Shared CJK (Chinese / Japanese / Korean) detection and handling primitives.
 *
 * Replaces the inline copy in `src/core/search/expansion.ts:58` and provides
 * a single source of truth for every downstream caller: slug grammar, chunker
 * word-counting, chunker delimiters, PGLite keyword fallback.
 *
 * Scope: BMP-only Unicode ranges that cover ~99% of real CJK content:
 *   - Han (CJK Unified Ideographs): U+4E00–U+9FFF
 *   - Hiragana: U+3040–U+309F
 *   - Katakana: U+30A0–U+30FF
 *   - Hangul Syllables: U+AC00–U+D7AF
 *
 * Out of scope (v0.32.7): Han extensions A/B/C, halfwidth katakana,
 * compatibility ideographs, compatibility Jamo, iteration marks (々/〇).
 * Filed as v0.33+ follow-up.
 */

export const CJK_SLUG_CHARS = '一-鿿぀-ゟ゠-ヿ가-힯';

export const CJK_RANGES_REGEX = new RegExp(`[${CJK_SLUG_CHARS}]`);

/**
 * Slug "word" character class (#3417): every script's letters, not just
 * Latin + CJK. Unicode property escapes — REQUIRES the `u` flag on any
 * regex composed from this string (without `u`, `\p{Ll}` silently matches
 * the literal chars `p`, `L`, `l`, `{`, `}`).
 *
 *   \p{Ll} lowercase letters (a-z, Cyrillic/Greek lowercase, đ, …)
 *   \p{Lm} modifier letters
 *   \p{Lo} caseless-script letters (Hebrew, Arabic, Thai, CJK, Devanagari, …)
 *   \p{M}  combining marks that survive the Latin accent-strip pass
 *          (Hebrew niqqud, Arabic harakat, Thai/Devanagari vowel signs)
 *   \p{N}  numbers (0-9, Arabic-Indic digits, …)
 *
 * Uppercase (\p{Lu}/\p{Lt}) is deliberately excluded: slugifySegment()
 * lowercases before filtering, so validators stay lowercase-canonical.
 *
 * Distinct from CJK_SLUG_CHARS above, which also drives the
 * countCJKAwareWords density heuristic — do NOT merge the two, or slug
 * grammar changes silently change chunking behavior.
 */
export const SLUG_WORD_CHARS = '\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}\\p{N}';

/**
 * Unicode variation selectors (emoji VS1–VS16 U+FE00–FE0F, ideographic IVS
 * U+E0100–E01EF): Mn-category invisibles that survive the \p{M} keep above.
 * Both slug grammars — `sync.ts:slugifySegment` and its #4855 twin
 * `link-extraction.ts:normalizeBasename` — strip them so an emoji folder name
 * written with VS16 lands on the clean slug and its `[[wikilink]]` resolves.
 */
export const SLUG_VARIATION_SELECTORS_RE = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu;

/**
 * Page-slug segment grammar (no anchors): word-char lead, then word-char or
 * hyphen continuation. Single source for validatePageSlug (operations.ts),
 * SlugRegistry's SLUG_RE, and the dream-cycle SUMMARY_SLUG_RE so every slug
 * validator shares one grammar (#738). Compose with the `u` flag — see
 * SLUG_WORD_CHARS.
 */
export const PAGE_SLUG_SEG = `[${SLUG_WORD_CHARS}][${SLUG_WORD_CHARS}\\-]*`;

export const CJK_SENTENCE_DELIMITERS = ['。', '！', '？']; // 。！？
export const CJK_CLAUSE_DELIMITERS = ['；', '：', '，', '、']; // ；：，、

/**
 * Density threshold for switching word-count strategy. Below this CJK char
 * density, a doc is treated as Latin-mostly and stays whitespace-tokenized
 * (so a 5000-word English doc with one Japanese term doesn't get char-counted
 * and over-split). At or above, it's CJK-mostly.
 */
export const CJK_DENSITY_THRESHOLD = 0.30;

export function hasCJK(s: string): boolean {
  return CJK_RANGES_REGEX.test(s);
}

/**
 * CJK-aware "word" count. CJK languages aren't whitespace-tokenized, so a
 * paragraph of Chinese collapses to 1 word under /\S+/g and downstream chunkers
 * never split it (the 8192-token OpenAI embedding limit then rejects the chunk).
 *
 * Heuristic (per codex outside-voice C13): switch on CJK character density,
 * not mere presence. Below CJK_DENSITY_THRESHOLD the doc is Latin-dominant
 * and whitespace tokens are the right unit; at or above it's CJK-dominant
 * and char count is the right unit.
 */
export function countCJKAwareWords(s: string): number {
  if (s.length === 0) return 0;
  return wordCountOf(wordStats(s));
}

/**
 * The ONE density test behind countCJKAwareWords: true when CJK chars make
 * up at least CJK_DENSITY_THRESHOLD of the non-whitespace chars. Callers
 * that need to branch on "would countCJKAwareWords count chars here?" (the
 * chunker's overlap extractor) route through this so the two cannot drift.
 */
export function isCJKDominant(s: string): boolean {
  return statsAreCJKDominant(wordStats(s));
}

/**
 * Everything countCJKAwareWords needs, gathered in one pass over UTF-16
 * code units: non-whitespace units, BMP CJK units (the CJK_SLUG_CHARS
 * ranges), and `/\S+/g` runs. The first/last flags let two adjacent
 * strings' stats combine in O(1) (concatWordStats), so a caller that grows
 * a string piece by piece never recounts it.
 */
export interface WordStats {
  length: number;
  nonWhitespace: number;
  cjk: number;
  runs: number;
  startsNonWhitespace: boolean;
  endsNonWhitespace: boolean;
}

const CJK_UNIT_RANGES: ReadonlyArray<readonly [number, number]> = Array.from(
  CJK_SLUG_CHARS.matchAll(/(.)-(.)/g),
  m => [m[1]!.charCodeAt(0), m[2]!.charCodeAt(0)] as const,
);

const CJK_UNIT_MIN = Math.min(...CJK_UNIT_RANGES.map(([lo]) => lo));

function isCJKUnit(c: number): boolean {
  if (c < CJK_UNIT_MIN) return false;
  for (const [lo, hi] of CJK_UNIT_RANGES) if (c >= lo && c <= hi) return true;
  return false;
}

/** Exactly the code units JavaScript's `\s` matches. */
function isWhitespaceUnit(c: number): boolean {
  if (c <= 0x20) return c === 0x20 || (c >= 0x09 && c <= 0x0d);
  if (c < 0xa0) return false;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a)
    || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f
    || c === 0x3000 || c === 0xfeff;
}

export function wordStats(s: string): WordStats {
  let nonWhitespace = 0;
  let cjk = 0;
  let runs = 0;
  let prevNonWhitespace = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (isWhitespaceUnit(c)) {
      prevNonWhitespace = false;
      continue;
    }
    nonWhitespace++;
    if (isCJKUnit(c)) cjk++;
    if (!prevNonWhitespace) runs++;
    prevNonWhitespace = true;
  }
  return {
    length: s.length,
    nonWhitespace,
    cjk,
    runs,
    startsNonWhitespace: s.length > 0 && !isWhitespaceUnit(s.charCodeAt(0)),
    endsNonWhitespace: prevNonWhitespace,
  };
}

/** Stats of `a + b` from the stats of `a` and `b`. */
export function concatWordStats(a: WordStats, b: WordStats): WordStats {
  return {
    length: a.length + b.length,
    nonWhitespace: a.nonWhitespace + b.nonWhitespace,
    cjk: a.cjk + b.cjk,
    runs: a.runs + b.runs - (a.endsNonWhitespace && b.startsNonWhitespace ? 1 : 0),
    startsNonWhitespace: a.length === 0 ? b.startsNonWhitespace : a.startsNonWhitespace,
    endsNonWhitespace: b.length === 0 ? a.endsNonWhitespace : b.endsNonWhitespace,
  };
}

export function statsAreCJKDominant(st: WordStats): boolean {
  if (st.nonWhitespace === 0) return false;
  return st.cjk / st.nonWhitespace >= CJK_DENSITY_THRESHOLD;
}

/** countCJKAwareWords of the string the stats describe. */
export function wordCountOf(st: WordStats): number {
  return statsAreCJKDominant(st) ? st.nonWhitespace : st.runs;
}

/**
 * LIKE-pattern escape for PGLite/Postgres `ILIKE ... ESCAPE '\'`.
 * Must escape backslash FIRST so the introduced backslashes aren't double-escaped.
 */
export function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Splits a CJK query into distinct, non-empty whitespace-delimited terms.
 *
 * In Korean and Japanese, word order is flexible and particles attach to nouns,
 * so the same fact or search intent frequently appears in varying token sequences
 * (e.g. "김대리 미팅" vs "미팅 김대리"). Splitting into individual terms allows
 * multi-term conjunction (AND matching) across chunk text regardless of word order.
 *
 * Returns deduplicated terms preserving the original order of appearance.
 */
export function splitCJKQueryTerms(query: string): string[] {
  const terms = query.split(/\s+/).filter(t => t.length > 0);
  return Array.from(new Set(terms));
}

