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
  return isCJKDominant(s)
    ? s.replace(/\s/g, '').length
    : (s.match(/\S+/g) || []).length;
}

/**
 * The ONE density test behind countCJKAwareWords: true when CJK chars make
 * up at least CJK_DENSITY_THRESHOLD of the non-whitespace chars. Callers
 * that need to branch on "would countCJKAwareWords count chars here?" (the
 * chunker's overlap extractor) route through this so the two cannot drift.
 */
export function isCJKDominant(s: string): boolean {
  const nonWhitespace = s.replace(/\s/g, '').length;
  if (nonWhitespace === 0) return false;
  const cjkMatches = s.match(new RegExp(`[${CJK_SLUG_CHARS}]`, 'g'));
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  return cjkCount / nonWhitespace >= CJK_DENSITY_THRESHOLD;
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


/**
 * Korean postpositions (조사), longest-first.
 *
 * Korean is agglutinative: a particle attaches directly to the noun, so the
 * ILIKE substring fallback sees "혈당에서" as one token and never matches a
 * document that says "혈당 수치". Stripping the particle yields a stem that
 * DOES match as a substring.
 *
 * Order matters — the scan takes the FIRST `endsWith` hit, so a longer
 * particle must be tested before any shorter one it contains ("에서" before
 * "에"/"서", "으로" before "로").
 */
export const KO_PARTICLES: readonly string[] = [
  '에서는', '에게서', '으로는', '으로서',
  '에서', '에게', '한테', '까지', '부터', '보다', '처럼', '마다',
  '조차', '라도', '이나', '으로', '로서',
  '은', '는', '이', '가', '을', '를', '에', '의', '로', '와', '과', '도', '만',
];

/**
 * Minimum stem length kept after stripping a particle.
 *
 * One-syllable stems are indistinguishable from over-stripped fragments:
 * "회의" ends in "의", "결과" ends in "과", "도로" ends in "로" — all would
 * collapse to a single meaningless syllable that matches almost everything.
 * Requiring 2+ characters rejects those while keeping the real cases
 * ("혈당에서" → "혈당", "검진을" → "검진").
 */
export const KO_MIN_STEM_LENGTH = 2;

/**
 * Expand one query term into its match variants: `[original]`, or
 * `[original, stem]` when a Korean particle was stripped.
 *
 * The caller ORs the variants within a term and ANDs across terms, so an
 * added stem can only WIDEN recall — the original match is never lost. That
 * makes over-stripping fail safe (extra results, never missing ones); the
 * KO_MIN_STEM_LENGTH guard keeps the extras rare.
 */
export function koreanTermVariants(term: string): string[] {
  if (!CJK_RANGES_REGEX.test(term)) return [term];
  for (const p of KO_PARTICLES) {
    if (term.length > p.length && term.endsWith(p)) {
      const stem = term.slice(0, -p.length);
      // Longest-first: this IS the longest matching particle, so a shorter
      // one would only strip more. Stop either way.
      return stem.length >= KO_MIN_STEM_LENGTH ? [term, stem] : [term];
    }
  }
  return [term];
}
