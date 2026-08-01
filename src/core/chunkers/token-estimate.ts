/**
 * Embedding-token estimation — shared by both chunkers (#3477 follow-up).
 *
 * Moved out of code.ts so recursive.ts can measure with the same estimator:
 * code.ts imports recursive.ts, so recursive.ts could never import these from
 * code.ts without a cycle. The natural home suggested in #3477's merge review
 * was cjk.ts, but cjk.ts is a check:fuzz-purity bundle target and tiktoken's
 * loader pulls node:fs into the bundle — so the estimators live here, one
 * layer above cjk.ts (whose char classes they reuse) and below both chunkers.
 */

import { CJK_SLUG_CHARS } from '../cjk.ts';

/**
 * Default hard budget for any emitted chunk's estimated embedding tokens.
 * Shared by capOversizedChunks (code.ts, #1675) and capByChars (recursive.ts).
 * 2000 keeps a margin under the smallest common strict embedder contexts
 * (nomic-embed-text 2048 — #3037; llama-server -ub 2048 — #2826).
 */
export const DEFAULT_MAX_CHUNK_TOKENS = 2000;

// v0.19.0 (Layer 5): accurate token count via @dqbd/tiktoken cl100k_base,
// the same encoder text-embedding-3-large uses. The old len/4 heuristic was
// 2-3x off for code. Lazy-init so dev and compiled-binary both only pay
// the init cost once. Falls back to the heuristic if the encoder fails
// to load (vanishingly unlikely but keeps the chunker available).
let tiktokenEncoder: { encode: (s: string) => Uint32Array; free: () => void } | null = null;
let tiktokenInitialized = false;

// v0.20.0 Cathedral II Layer 8 (D1) — re-exported from code.ts so
// commands/sync.ts can estimate embed cost before a --all sync blows a
// surprise OpenAI bill. Same cl100k_base tokenizer the embedding path
// actually uses, so cost estimates match actual billing within tokenizer
// noise.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  if (!tiktokenInitialized) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require('@dqbd/tiktoken');
      tiktokenEncoder = m.get_encoding('cl100k_base');
    } catch {
      tiktokenEncoder = null;
    }
    tiktokenInitialized = true;
  }
  if (tiktokenEncoder) {
    try {
      return tiktokenEncoder.encode(text).length;
    } catch {
      // Code legitimately contains tiktoken special-token strings (e.g. CLIP/GPT
      // tokenizers embed the literal "<|endoftext|>"). The default encode() uses
      // disallowed_special='all' and THROWS on those, crashing reindex-code on
      // valid source files. For a token COUNT we don't need special-token
      // semantics: re-encode treating them as ordinary text (never throws),
      // heuristic only if even that fails.
      try {
        return (
          tiktokenEncoder as unknown as {
            encode: (s: string, allowed: string[], disallowed: string[]) => Uint32Array;
          }
        ).encode(text, [], []).length;
      } catch {
        return Math.max(1, Math.ceil(text.length / 4));
      }
    }
  }
  return Math.max(1, Math.ceil(text.length / 4));
}

const CJK_CHARS_G = new RegExp(`[${CJK_SLUG_CHARS}]`, 'g');

/**
 * Embedding-safe token estimate for the oversize caps. estimateTokens
 * (cl100k) matches embedding-family tokenizers closely on pure-ASCII source
 * (measured identical on English prose and JSON vs Qwen3-Embedding), but
 * UNDERCOUNTS mixed CJK+ASCII chunks — measured −31% on URL-dense Korean
 * text vs the Qwen3 embedding tokenizer, which is exactly the shape that
 * overflows strict embedding backends (#2826). For chunks containing CJK,
 * take the max of cl100k and a per-char-class overestimate (CJK 1.0/char,
 * other non-whitespace 0.75/char, whitespace 0.1/char). CJK-DOMINANT text
 * is unaffected too: cl100k already counts it above the weighted form, so
 * max() returns the same value as today. Only mixed-script chunks — the
 * measured divergence class — estimate higher.
 */
export function estimateEmbedTokens(text: string): number {
  const cjk = (text.match(CJK_CHARS_G) || []).length;
  if (cjk === 0) return estimateTokens(text);
  return Math.max(estimateTokens(text), weightedTokens(text, cjk));
}

/** The per-char-class overestimate half of estimateEmbedTokens. Linear (two
 *  regex scans), unlike the cl100k encoder — see estimateEmbedTokensCeiling. */
function weightedTokens(text: string, cjk: number): number {
  const ws = (text.match(/\s/g) || []).length;
  return Math.ceil(cjk + (text.length - cjk - ws) * 0.75 + ws * 0.1);
}

/**
 * Upper bound on what `text` contributes to `estimateEmbedTokens(text + rest)`
 * for ANY `rest` — i.e. the figure to RESERVE when a fragment will be glued
 * onto a body whose script mix is not yet known.
 *
 * estimateEmbedTokens is super-additive across a mixed-script join. It only
 * switches to the weighted branch when the text it is handed contains CJK, so
 * a pure-ASCII fragment measured ALONE costs cl100k (a 59-char structured
 * chunk header = 17 tokens) while the SAME fragment inside a chunk whose body
 * contains CJK costs ~0.75/char on the weighted branch (~42 tokens). Reserving
 * the standalone figure under-counts ~2.5x, and capOversizedChunks then emits
 * body-capped pieces that re-emerge over the cap once the header is re-added
 * (measured: 2,006- and 2,023-token chunks on src/core/migrate.ts against a
 * 2,000 cap, where the pre-#3564 chunker emitted none).
 *
 * Taking max(cl100k, weighted) unconditionally is a true bound because the
 * weighted form is additive per char class, so weighted(a + b) <=
 * weighted(a) + weighted(b), and cl100k does not gain tokens across the
 * header's trailing blank line.
 */
export function estimateEmbedTokensCeiling(text: string): number {
  return Math.max(estimateTokens(text), weightedTokens(text, (text.match(CJK_CHARS_G) || []).length));
}
