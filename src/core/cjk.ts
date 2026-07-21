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
  const cjkMatches = s.match(new RegExp(`[${CJK_SLUG_CHARS}]`, 'g'));
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonWhitespace = s.replace(/\s/g, '').length;
  if (nonWhitespace === 0) return 0;
  const density = cjkCount / nonWhitespace;
  if (density >= CJK_DENSITY_THRESHOLD) {
    return nonWhitespace;
  }
  return (s.match(/\S+/g) || []).length;
}

/**
 * LIKE-pattern escape for PGLite/Postgres `ILIKE ... ESCAPE '\'`.
 * Must escape backslash FIRST so the introduced backslashes aren't double-escaped.
 */
export function escapeLikePattern(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Conservative per-char-class embedding-token weights (markdown chunker v4).
 *
 * Why this exists: the chunker's "word" counting drastically UNDER-counts
 * whitespace-less ASCII runs (a 150-char URL = 1 whitespace word), so
 * word-based size targets can emit chunks that overflow an embedding
 * server's per-request token limit. Measured on a local Qwen3-embedding
 * llama-server stack:
 *   - URL/phone/email-dense text tokenizes at ~1.6 chars/token
 *   - base64-ish / minified blobs approach ~1.3 chars/token (worst case)
 *   - Korean prose tokenizes NO WORSE than 1 char/token in practice
 *
 * Weights are deliberately HIGH (tokens are overestimated) so any cap
 * based on this estimate is safe against real tokenizers:
 *   - CJK char        → 1.0 token  (real CJK prose is cheaper)
 *   - other non-space → 0.75 token (≈1.33 chars/token, covers base64)
 *   - whitespace      → 0.1 token  (mostly folds into neighbor tokens)
 */
export const EMBED_TOKEN_WEIGHT_CJK = 1.0;
export const EMBED_TOKEN_WEIGHT_OTHER = 0.75;
export const EMBED_TOKEN_WEIGHT_WS = 0.1;

/** BMP CJK check by UTF-16 code unit — same ranges as CJK_SLUG_CHARS. */
export function isCJKCodeUnit(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // Han
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0xac00 && code <= 0xd7af)    // Hangul Syllables
  );
}

/**
 * Per-code-unit token weight. Unrecognized whitespace (exotic Unicode
 * spaces) intentionally falls into OTHER — that only overestimates.
 */
export function charEmbedTokenWeight(code: number): number {
  if (isCJKCodeUnit(code)) return EMBED_TOKEN_WEIGHT_CJK;
  if (
    code === 0x20 || (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 || code === 0x3000
  ) {
    return EMBED_TOKEN_WEIGHT_WS;
  }
  return EMBED_TOKEN_WEIGHT_OTHER;
}

/**
 * Tokenizer-free embedding-token estimate (conservative overestimate).
 * See weight docs above. Astral chars count as 2 OTHER code units —
 * another overestimate, which is the safe direction.
 */
export function estimateEmbeddingTokens(s: string): number {
  if (s.length === 0) return 0;
  let est = 0;
  for (let i = 0; i < s.length; i++) {
    est += charEmbedTokenWeight(s.charCodeAt(i));
  }
  return Math.ceil(est);
}
