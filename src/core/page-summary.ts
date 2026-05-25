/**
 * v0.40.3.0 — per-chunk Haiku synopsis generator.
 *
 * For the tokenmax tier (D1 — Anthropic's published per-chunk synopsis
 * method), this module owns:
 *
 *   - Routing the Haiku call through `gateway.chat(tier='utility')` —
 *     the cheapest tier per CLAUDE.md gateway docs.
 *   - The richer failure envelope from D27 P1-2: distinguishing
 *     refusal / empty / malformed (→ page-level fall-back to title-only
 *     per D14) from auth_failure / rate_limit / timeout / network /
 *     provider_5xx (→ retry per gateway, or throw to Minion retry).
 *   - Process-local LRU cache keyed by
 *     `(content_hash, chunk_index, corpus_generation, source_text_hash)`
 *     per D27 P1-4. Source-text changes (adjacent chunks, frontmatter,
 *     fallback chain) invalidate the cache correctly because
 *     source_text_hash is in the key.
 *
 * Calibration injection is DELIBERATELY ABSENT (D21 reversed the original
 * D7 acceptance: bias tags are mutable answer-time context that don't
 * belong in static document vectors — embedding the calibration profile
 * would silently stale embeddings on every calibration cycle update).
 * Calibration-driven personalization belongs at query time, not at embed
 * time; see `~/.gstack/projects/garrytan-gbrain/ceo-plans/
 * 2026-05-22-v0403-contextual-retrieval.md` "Deferred to TODOS.md" for
 * the v0.41+ query-side personalization wave.
 *
 * No DB access — pure orchestration over gateway + LRU cache. The service
 * layer (`src/core/contextual-retrieval-service.ts`) drives the per-page
 * loop and handles page-level fall-back.
 */

import { chat, type ChatOpts, type ChatResult } from './ai/gateway.ts';
import { logSynopsisFailure, type SynopsisFailureKind } from './audit-synopsis.ts';
import { sanitizeSynopsis } from './embedding-context.ts';

/**
 * Hard cap on Haiku output tokens. ~200 tokens gives 50-100 token
 * synopsis with some headroom; the wrapper layer caps the final
 * synopsis at SUMMARY_HARD_CAP_CHARS (300) regardless.
 */
const HAIKU_MAX_TOKENS = 200;

/** Default model when caller doesn't override. Resolves through the gateway. */
const DEFAULT_SYNOPSIS_MODEL = 'anthropic:claude-haiku-4-5-20251001';

/**
 * Hard cap on `documentText` length (chars) before send.
 *
 * 2026-05-25 fix wave: small local chat models (Gemma 4 E2B, Qwen3 4B) get
 * dramatically slower on long contexts even with 131K-token windows declared.
 * A 73K-char page synopsis on Gemma 4 E2B takes 60-120s, exceeding the
 * worker's default 30s `lockDuration` and tripping `lock-lost` errors.
 *
 * Truncate to a budget that fits a small model's effective throughput while
 * preserving enough document context for the synopsis to be useful. Truncates
 * the TAIL because the head (title, frontmatter, intro) carries the
 * document-level anchor the synopsis needs.
 *
 * Override per workload via `GBRAIN_SYNOPSIS_DOC_MAX_CHARS`. Default 32768
 * (~8K tokens at 4 chars/tok) keeps small-model synopsis under ~30s.
 * Anthropic Haiku is unaffected at this cap; bump higher when running
 * frontier models if you want richer document anchoring.
 */
export const SYNOPSIS_DOC_MAX_CHARS = (() => {
  const env = process.env.GBRAIN_SYNOPSIS_DOC_MAX_CHARS;
  if (env && /^\d+$/.test(env)) {
    const n = parseInt(env, 10);
    if (n >= 512 && n <= 1_048_576) return n;
  }
  return 32768;
})();

/**
 * Synopsis prompt version. Folded into corpus_generation so prompt edits
 * invalidate prior embeddings via the v0.40.3.0 query_cache.page_generations
 * contract (D27 P1-5). Bump on any prompt-text change that meaningfully
 * shifts synopsis semantics.
 */
export const SYNOPSIS_PROMPT_VERSION = 1;

const SYSTEM_PROMPT = [
  'You generate one-sentence chunk synopses for a personal knowledge brain.',
  '',
  'Given a document (the FULL_DOCUMENT block) and a chunk from it (the CHUNK',
  'block), write a single concise sentence that orients the chunk within the',
  'document. Name the entities, time, and topic that the chunk is about,',
  'using terms that would appear in user queries.',
  '',
  'Rules:',
  '- One sentence, 15-30 words.',
  '- No preamble like "This chunk is about" — just write the synopsis.',
  '- Use the exact entity names from the document, not generic terms.',
  '- If the chunk is structural (heading, code block, list of links), say so.',
  '- Plain text only. No markdown, no quotes, no XML tags.',
].join('\n');

export interface GeneratePerChunkSynopsisArgs {
  /** The full document text (source file, chunk-concat, or chunk-alone per D11). */
  documentText: string;
  /** The chunk for which we're generating the synopsis. */
  chunkText: string;
  /** The page's title — gives Haiku document-level anchor. */
  pageTitle: string;
  /** Page slug for audit logging on failure. */
  pageSlug: string;
  /** Source id for audit logging on failure. */
  sourceId: string;
  /** Chunk index (0-based) for audit logging on failure. */
  chunkIndex: number;
  /** Optional model override (resolves through gateway recipes). */
  model?: string;
  /** Optional abort signal threaded through gateway.chat. */
  abortSignal?: AbortSignal;
}

/**
 * Discriminated result. Caller dispatches on `kind`:
 *
 *   - `success` → use `.synopsis` as the wrapper input
 *   - failure variants → see D27 P1-2 dispatch in the service layer
 */
export type GeneratePerChunkSynopsisResult =
  | { kind: 'success'; synopsis: string }
  | { kind: SynopsisFailureKind; detail?: string };

/**
 * Generate one synopsis for one chunk. ~$0.00006 per call at Haiku 4.5
 * pricing (assuming ~500 input tokens + 50 output tokens for typical
 * personal-brain page sizes).
 *
 * Caller is responsible for:
 *   - Rate-leasing via `src/core/minions/rate-leases.ts` (the SERVICE
 *     layer does this with the global `anthropic:utility:contextual-synopsis`
 *     key per D26 P0-3).
 *   - LRU caching by `(content_hash, chunk_index, corpus_generation,
 *     source_text_hash)`. This module is a pure transformer — no cache
 *     lookup here; the service decides when to call us.
 *   - Audit logging on failure (we DO emit `logSynopsisFailure` for the
 *     forensic trail per D17, but `page_level_fallback` is set by the
 *     service after deciding whether refusal triggered the D14 page-wide
 *     fall-back to title-only).
 */
export async function generatePerChunkSynopsis(
  args: GeneratePerChunkSynopsisArgs,
): Promise<GeneratePerChunkSynopsisResult> {
  const userPrompt = buildUserPrompt(args.pageTitle, args.documentText, args.chunkText);

  const chatOpts: ChatOpts = {
    model: args.model ?? DEFAULT_SYNOPSIS_MODEL,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: HAIKU_MAX_TOKENS,
    abortSignal: args.abortSignal,
    cacheSystem: true,
  };

  let result: ChatResult;
  try {
    result = await chat(chatOpts);
  } catch (err) {
    const classified = classifyChatError(err);
    logSynopsisFailure({
      pageSlug: args.pageSlug,
      sourceId: args.sourceId,
      chunkIndex: args.chunkIndex,
      kind: classified.kind,
      detail: classified.detail,
      // Whether this triggers page-level fall-back depends on the
      // refusal/empty/malformed vs transient distinction — service decides
      // after seeing the result. Audit reflects the service-known state at
      // log time; here we conservatively record what we know.
      pageLevelFallback: classified.kind === 'refusal' || classified.kind === 'empty' || classified.kind === 'malformed',
    });
    return { kind: classified.kind, detail: classified.detail };
  }

  // Refusal-class signals from the chat result. Gateway maps provider-
  // specific stop reasons to the union in `ChatResult.stopReason`.
  if (result.stopReason === 'refusal' || result.stopReason === 'content_filter') {
    logSynopsisFailure({
      pageSlug: args.pageSlug,
      sourceId: args.sourceId,
      chunkIndex: args.chunkIndex,
      kind: 'refusal',
      detail: `stop_reason=${result.stopReason}`,
      pageLevelFallback: true,
    });
    return { kind: 'refusal', detail: `stop_reason=${result.stopReason}` };
  }

  const synopsis = sanitizeSynopsis(result.text);
  if (!synopsis) {
    logSynopsisFailure({
      pageSlug: args.pageSlug,
      sourceId: args.sourceId,
      chunkIndex: args.chunkIndex,
      kind: 'empty',
      detail: `length=${result.text.length}`,
      pageLevelFallback: true,
    });
    return { kind: 'empty', detail: `length=${result.text.length}` };
  }

  // No malformed detection in v0.40.3.0: synopses are plain text by
  // prompt contract. Future extension could parse a JSON-shaped
  // response with `{synopsis, confidence}` for richer signals; for now
  // any non-empty text after sanitization counts as success.

  return { kind: 'success', synopsis };
}

function buildUserPrompt(
  pageTitle: string,
  documentText: string,
  chunkText: string,
): string {
  // Tail-truncate `documentText` to `SYNOPSIS_DOC_MAX_CHARS` so small local
  // chat models don't stall on >100KB pages. Head preserved (title block,
  // frontmatter, intro paragraphs carry the document-level anchor).
  let trimmedDoc = documentText;
  if (documentText.length > SYNOPSIS_DOC_MAX_CHARS) {
    trimmedDoc = documentText.slice(0, SYNOPSIS_DOC_MAX_CHARS) +
      `\n\n[... ${documentText.length - SYNOPSIS_DOC_MAX_CHARS} chars truncated for synopsis budget ...]`;
  }
  return [
    `<page_title>${pageTitle}</page_title>`,
    '',
    '<full_document>',
    trimmedDoc,
    '</full_document>',
    '',
    '<chunk>',
    chunkText,
    '</chunk>',
    '',
    'Write the one-sentence synopsis for <chunk>:',
  ].join('\n');
}

/**
 * Map a thrown error from `gateway.chat()` into the D27 P1-2 failure envelope.
 *
 * Gateway throws Anthropic-flavored errors with HTTP status info; we
 * pattern-match on those for the classification.
 */
function classifyChatError(err: unknown): {
  kind: SynopsisFailureKind;
  detail: string;
} {
  if (err == null) {
    return { kind: 'malformed', detail: 'null error' };
  }
  const e = err as { status?: number; message?: string; code?: string; name?: string };
  const msg = (e.message ?? String(err)).slice(0, 200);

  if (e.status === 401 || e.status === 403) {
    return { kind: 'auth_failure', detail: `status=${e.status} msg=${msg}` };
  }
  if (e.status === 429) {
    return { kind: 'rate_limit', detail: `status=429 msg=${msg}` };
  }
  if (e.status != null && e.status >= 500 && e.status < 600) {
    return { kind: 'provider_5xx', detail: `status=${e.status} msg=${msg}` };
  }
  if (
    e.name === 'AbortError' ||
    e.code === 'ETIMEDOUT' ||
    /timeout/i.test(msg)
  ) {
    return { kind: 'timeout', detail: msg };
  }
  if (
    e.code === 'ENOTFOUND' ||
    e.code === 'ECONNREFUSED' ||
    e.code === 'ECONNRESET' ||
    /network|fetch/i.test(msg)
  ) {
    return { kind: 'network', detail: `code=${e.code ?? '?'} msg=${msg}` };
  }

  // Unknown error shape — treat as malformed so the service routes it
  // through the title-only fall-back path rather than retrying forever.
  return { kind: 'malformed', detail: msg };
}

/**
 * D27 P1-4 cache key composition. Used by the service layer's LRU. Exposed
 * here so the key shape stays the single source of truth.
 *
 *   (content_hash, chunk_index, corpus_generation, source_text_hash)
 */
export function buildSynopsisCacheKey(args: {
  contentHash: string;
  chunkIndex: number;
  corpusGeneration: string;
  sourceTextHash: string;
}): string {
  return [
    args.contentHash,
    args.chunkIndex.toString(),
    args.corpusGeneration,
    args.sourceTextHash,
  ].join('|');
}
