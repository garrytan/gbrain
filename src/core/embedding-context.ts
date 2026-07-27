/**
 * v0.40.3.0 — contextual retrieval wrapper helpers (pure functions).
 *
 * Builds the `<context>{title}\n{synopsis}\n</context>\n{chunk}` prefix
 * that Anthropic's published contextual retrieval method prepends to each
 * chunk BEFORE embedding. The wrapper is built JUST IN TIME at embed call
 * (`src/core/contextual-retrieval-service.ts:embedPhase`) and never
 * persisted as `content_chunks.chunk_text` (D20-T1 — search snippets, FTS,
 * reranker, debug all read the canonical chunk_text).
 *
 * Code chunks (`chunk_source === 'fenced_code'`) ALWAYS bypass wrapping
 * (D20-T4) — prepending markdown-page title to a code block doesn't help
 * cross-modal retrieval and adds embedding-token waste.
 *
 * Title sanitization (D26 P0-4 prep, plus belt-and-suspenders against
 * `</context>` injection from user-controlled titles) strips the closing
 * tag and collapses runs of whitespace before the title lands in the
 * wrapper.
 *
 * NO LLM calls in this module. Per-chunk synopsis generation lives in
 * `src/core/page-summary.ts` and is invoked by the service layer for the
 * `per_chunk_synopsis` tier only.
 */

import { CJK_SENTENCE_DELIMITERS } from './cjk.ts';
import type { CRMode } from './types.ts';

/**
 * Hard cap on the title-only block per chunk. Generous because high-signal
 * titles in personal-brain shape are typically 30-80 chars; the cap only
 * protects against pathological frontmatter.
 */
const TITLE_HARD_CAP_CHARS = 300;

/**
 * Hard cap on the per-page summary lifted from compiled_truth via
 * `extractFirstTwoSentences`. Keeps the embedding payload bounded even
 * when a page's first two sentences are unusually long.
 */
const SUMMARY_HARD_CAP_CHARS = 300;

/**
 * Build the `<context>...</context>\n` prefix for a chunk.
 *
 *   title set, synopsis empty  → `<context>{title}\n</context>\n`
 *   title empty, synopsis set  → `<context>\n{synopsis}\n</context>\n`
 *   both set                   → `<context>{title}\n{synopsis}\n</context>\n`
 *   both null/empty            → null (caller should embed raw chunk)
 *
 * Always returns null when both inputs are meaningless. The wrapper text
 * stays asymmetric (document side only) — queries embed clean per Voyage
 * / ZeroEntropy's `inputType: query` distinction.
 */
export function buildContextualPrefix(
  title: string | null | undefined,
  synopsis: string | null | undefined,
): string | null {
  const safeTitle = sanitizeTitle(title ?? '');
  const safeSynopsis = sanitizeSynopsis(synopsis ?? '');

  if (!safeTitle && !safeSynopsis) {
    return null;
  }

  if (safeTitle && !safeSynopsis) {
    return `<context>${safeTitle}\n</context>\n`;
  }
  if (!safeTitle && safeSynopsis) {
    return `<context>\n${safeSynopsis}\n</context>\n`;
  }
  return `<context>${safeTitle}\n${safeSynopsis}\n</context>\n`;
}

/**
 * Apply the prefix to a chunk for the embedding call.
 *
 *   chunk_source='fenced_code'   → ALWAYS bypass wrapping (D20-T4)
 *   prefix null                   → passthrough (no wrapping)
 *   else                          → prefix + chunkText
 *
 * Critical invariant (D20-T1): callers must use this function ONLY for
 * the embedding input. The original chunkText MUST land in
 * `content_chunks.chunk_text` unchanged.
 */
export function wrapChunkForEmbedding(
  chunkText: string,
  prefix: string | null,
  chunkSource: string | null | undefined,
): string {
  if (chunkSource === 'fenced_code') {
    return chunkText;
  }
  if (prefix == null) {
    return chunkText;
  }
  return prefix + chunkText;
}

/**
 * Strip injection vectors + collapse whitespace from a title.
 *
 *   - `</context>` would close the wrapper tag prematurely → stripped
 *   - newlines / tabs collapse to single space (titles shouldn't be
 *     multi-line in frontmatter; defensive)
 *   - trim + cap at TITLE_HARD_CAP_CHARS
 */
export function sanitizeTitle(title: string): string {
  if (!title) return '';
  return title
    .replace(/<\/context>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TITLE_HARD_CAP_CHARS);
}

/**
 * Same sanitization as title (defense against Haiku returning
 * `</context>` mid-synopsis — would be a refusal-equivalent class but
 * cheaper to defend at the wrapper) plus the synopsis cap.
 */
export function sanitizeSynopsis(synopsis: string): string {
  if (!synopsis) return '';
  return synopsis
    .replace(/<\/context>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SUMMARY_HARD_CAP_CHARS);
}

/**
 * Pure regex-based first-two-sentences extractor. CJK-aware via
 * `CJK_SENTENCE_DELIMITERS` from `src/core/cjk.ts`. Hard 300-char cap
 * so a single run-on sentence doesn't blow the embedding budget.
 *
 * Used by the `title` tier (and as a free fallback for `per_chunk_synopsis`
 * pages that have `compiled_truth` populated) to surface a cheap summary
 * without paying Haiku.
 */
export function extractFirstTwoSentences(text: string): string {
  if (!text) return '';

  // Build sentence-end pattern that handles English `.!?` followed by
  // whitespace AND CJK `。！？` delimiters.
  const cjkDelims = CJK_SENTENCE_DELIMITERS.map(escapeRegex).join('');
  const sentenceEnd = new RegExp(`([.!?])\\s+|([${cjkDelims}])`, 'g');

  // Walk through the first two sentence boundaries.
  let cursor = 0;
  let sentenceCount = 0;
  let lastEnd = text.length;
  for (const match of text.matchAll(sentenceEnd)) {
    sentenceCount++;
    const matchEnd = (match.index ?? 0) + match[0].length;
    if (sentenceCount === 2) {
      lastEnd = matchEnd;
      break;
    }
    cursor = matchEnd;
  }

  // If we never found a sentence boundary, return the whole text up to cap.
  if (sentenceCount === 0) {
    return text.trim().slice(0, SUMMARY_HARD_CAP_CHARS);
  }

  return text.slice(0, lastEnd).trim().slice(0, SUMMARY_HARD_CAP_CHARS);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Exported guard for D26 P0-4 verification — given a CRMode, does it
 * NEED Haiku synopsis generation? Used by the service to decide whether
 * to invoke `page-summary.ts:generatePerChunkSynopsis` per chunk.
 */
export function modeRequiresHaiku(mode: CRMode): boolean {
  return mode === 'per_chunk_synopsis';
}

/**
 * Exported guard: given a CRMode, does it NEED any wrapper at all?
 * `none` skips wrapping; `title` and `per_chunk_synopsis` both wrap.
 */
export function modeRequiresWrapper(mode: CRMode): boolean {
  return mode !== 'none';
}
