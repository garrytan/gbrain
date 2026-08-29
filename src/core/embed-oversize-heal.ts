/**
 * SUP-3874 — heal already-stored chunks that exceed the active embedding
 * model's per-input token limit.
 *
 * New imports respect `resolveMaxChunkTokens()` (#4530 + mxbai recipe cap),
 * but `gbrain embed --stale` re-embeds EXISTING `chunk_text` rows. Pages
 * chunked under the historical 2000-token default (or before a model-specific
 * `max_input_tokens` was declared) can still carry a single oversized row that
 * fails forever with "input length exceeds the context length" and makes the
 * whole stale sweep exit non-zero — even when sibling chunks embed cleanly.
 *
 * This helper SPLITS those oversized rows in place (never truncates) and
 * leaves embeddings unset. `upsertChunks` preserves vectors for rows whose
 * `(chunk_index, chunk_text)` pair is unchanged, and NULLs vectors when the
 * text at an index changes — so split pieces and shifted siblings become
 * stale for the next embed pass. Shared by CLI embed + embed-stale.
 */

import { chunkText } from './chunkers/recursive.ts';
import { estimateEmbedTokens } from './chunkers/token-estimate.ts';
import { resolveMaxChunkTokens } from './embedding-input-limit.ts';
import type { BrainEngine } from './engine.ts';
import type { Chunk, ChunkInput, StaleChunkRow } from './types.ts';

export interface HealOversizedChunksResult {
  /** True when at least one chunk was split. */
  changed: boolean;
  /** How many original chunks exceeded the cap. */
  splitCount: number;
  /** Contiguous, re-indexed chunk list ready for upsertChunks. */
  chunks: ChunkInput[];
}

type HealableChunk = Pick<
  Chunk,
  | 'chunk_index'
  | 'chunk_text'
  | 'chunk_source'
  | 'token_count'
  | 'modality'
  | 'language'
  | 'symbol_name'
  | 'symbol_type'
  | 'start_line'
  | 'end_line'
  | 'parent_symbol_path'
  | 'doc_comment'
  | 'symbol_name_qualified'
>;

function carryHealedMetadata(chunk: HealableChunk, base: ChunkInput): ChunkInput {
  return {
    ...base,
    modality: chunk.modality ?? undefined,
    language: chunk.language ?? undefined,
    symbol_name: chunk.symbol_name ?? undefined,
    symbol_type: chunk.symbol_type ?? undefined,
    start_line: chunk.start_line ?? undefined,
    end_line: chunk.end_line ?? undefined,
    parent_symbol_path: chunk.parent_symbol_path ?? undefined,
    doc_comment: chunk.doc_comment ?? undefined,
    symbol_name_qualified: chunk.symbol_name_qualified ?? undefined,
  };
}

/**
 * Split any chunk whose estimated embed tokens exceed `maxTokens`.
 *
 * Embeddings are intentionally omitted — upsertChunks COALESCEs the stored
 * vector when chunk_text at that index is unchanged, and clears it when the
 * text changes (split / shifted siblings). Every split piece retains its
 * source chunk's modality and code-symbol metadata so a later provider failure
 * cannot persist a lossy replacement.
 */
export function healOversizedChunks(
  chunks: ReadonlyArray<HealableChunk>,
  maxTokens: number = resolveMaxChunkTokens(),
): HealOversizedChunksResult {
  const out: ChunkInput[] = [];
  let splitCount = 0;

  for (const c of chunks) {
    const tokens = estimateEmbedTokens(c.chunk_text);
    if (tokens <= maxTokens) {
      // Metadata fields are optional: upsertChunks COALESCEs them when
      // chunk_text at this index is unchanged, so omitting them is safe.
      out.push(carryHealedMetadata(c, {
        chunk_index: out.length,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
      }));
      continue;
    }

    splitCount++;
    const parts = chunkText(c.chunk_text, { maxTokens });
    // Pathological: estimator / splitter disagreement — hard-split by chars
    // so we never re-emit the original oversized row unchanged.
    const pieces =
      parts.length > 1 || (parts[0] && estimateEmbedTokens(parts[0].text) <= maxTokens)
        ? parts.map((p) => p.text)
        : hardSplitByChars(c.chunk_text, maxTokens);

    for (const text of pieces) {
      if (!text) continue;
      out.push(carryHealedMetadata(c, {
        chunk_index: out.length,
        chunk_text: text,
        chunk_source: c.chunk_source,
        token_count: Math.ceil(text.length / 4),
      }));
    }
  }

  return {
    changed: splitCount > 0,
    splitCount,
    chunks: out,
  };
}

/** Last-resort splitter when chunkText cannot shrink a pathological blob. */
function hardSplitByChars(text: string, maxTokens: number): string[] {
  // ~4 chars/token under the heuristic; stay under the estimate with margin.
  const maxChars = Math.max(64, Math.floor(maxTokens * 3));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out.length > 0 ? out : [text];
}

/**
 * Remap a post-heal chunk list back into the stale-row shape the `--stale`
 * drains iterate (only rows still needing embeddings). Shared by
 * `src/commands/embed.ts:embedAllStale` and
 * `src/core/embed-stale.ts:embedStaleForSource` so the two drains cannot
 * drift.
 *
 * `chunk_source` passes through UNCHANGED: coercing `fenced_code` to
 * `compiled_truth` here would make `wrapChunkTextsForStoredMode` prepend a
 * contextual prefix to code chunks, violating the D20-T4 never-wrap
 * convention (`src/core/embedding-context.ts`).
 */
export function healedChunksToStaleRows(
  chunks: ReadonlyArray<Chunk>,
  slug: string,
  sourceId: string,
): StaleChunkRow[] {
  return chunks
    .filter((c) => !c.embedded_at || c.embedding_is_null === true)
    .map((c) => ({
      page_id: c.page_id,
      chunk_index: c.chunk_index,
      chunk_text: c.chunk_text,
      chunk_source: c.chunk_source,
      model: c.model ?? null,
      token_count: c.token_count ?? null,
      slug,
      source_id: sourceId,
    }));
}

/**
 * Load a page's chunks, split any that exceed the active model cap, upsert,
 * and re-load. No-op when every chunk already fits.
 */
export async function healOversizedPageChunks(
  engine: Pick<BrainEngine, 'getChunks' | 'upsertChunks'>,
  slug: string,
  opts: {
    sourceId?: string;
    maxTokens?: number;
    onSplit?: (splitCount: number) => void;
  } = {},
): Promise<{ changed: boolean; splitCount: number; chunks: Chunk[] }> {
  const getOpts = opts.sourceId ? { sourceId: opts.sourceId } : undefined;
  const existing = await engine.getChunks(slug, getOpts);
  const healed = healOversizedChunks(existing, opts.maxTokens ?? resolveMaxChunkTokens());
  if (!healed.changed) {
    return { changed: false, splitCount: 0, chunks: existing };
  }
  // Freshness guard: the embed single-flight lock does not exclude sync
  // (different lock keys), so a concurrent import may rewrite this page
  // between our read and this write — clobbering it with pre-sync splits
  // would silently desync chunk_text from the page content until the next
  // edit. Re-read and skip on drift; the next drain pass heals the fresh
  // rows. (Window shrinks to one query; the upsert itself is keyed on
  // (chunk_index, chunk_text) so an exact-tie write is content-identical.)
  const recheck = await engine.getChunks(slug, getOpts);
  const drifted =
    recheck.length !== existing.length ||
    recheck.some((c, i) => c.chunk_index !== existing[i].chunk_index || c.chunk_text !== existing[i].chunk_text);
  if (drifted) {
    return { changed: false, splitCount: 0, chunks: recheck };
  }
  opts.onSplit?.(healed.splitCount);
  await engine.upsertChunks(slug, healed.chunks, getOpts);
  const refreshed = await engine.getChunks(slug, getOpts);
  return { changed: true, splitCount: healed.splitCount, chunks: refreshed };
}
