// src/core/chunkers/doc-block.ts
//
// Structure-aware chunker for office DocIR (docs/proposals/office-ingest.md §21.1).
// Unlike the prose/markdown chunker it respects document structure:
//   - table / figure  → HARD boundary: flush prose, NOT emitted here. The
//     adapter's table.ts / multimodal.ts handlers own those blocks.
//   - code            → flush prose, emitted as its own self-contained chunk.
//   - heading         → flush prose; its markdown is prepended to subsequent
//     chunks as section context (contextual retrieval, lifts recall).
//   - paragraph/list  → merged up to the target size, then flushed.
//   - no overlap by default (matches gbrain's markdown chunker; avoids drift).
//
// Emitted chunk_source is always 'doc_block'; source_locator spans the merged
// blocks via mergeLocators (start page).

import { chunkText } from './recursive.ts';
import {
  type DocBlock,
  type OfficeChunk,
  mergeLocators,
} from '../office/types.ts';

export interface DocBlockChunkOptions {
  /** Target words per merged prose chunk. Default 384 (~512 tokens). The
   *  adapter maps ingest.office.chunk_tokens → words (≈ tokens / 1.3). */
  targetWords?: number;
}

const DEFAULT_TARGET_WORDS = 384;

/** Rough word count: ASCII word-runs + individual CJK chars. Matches the
 *  spirit of the recursive chunker's CJK-aware counting without importing it. */
function wordCount(s: string): number {
  const ascii = (s.match(/[A-Za-z0-9_]+/g) ?? []).length;
  const cjk = (s.match(/[一-鿿぀-ヿ가-힯]/g) ?? []).length;
  return ascii + cjk;
}

function withHeading(heading: string | null, body: string): string {
  return heading ? `${heading.trim()}\n\n${body}` : body;
}

/**
 * Chunk a document's DocIR blocks into prose chunks. Table and figure blocks
 * are used as boundaries but not emitted (the adapter handles them); code
 * blocks become their own chunks.
 */
export function chunkDocBlocks(
  blocks: DocBlock[],
  opts?: DocBlockChunkOptions,
): OfficeChunk[] {
  const target = opts?.targetWords ?? DEFAULT_TARGET_WORDS;
  const out: OfficeChunk[] = [];

  let buf: DocBlock[] = [];
  let bufWords = 0;
  let pendingHeading: string | null = null;

  const flush = (): void => {
    if (buf.length === 0) return;
    const body = buf.map((b) => b.markdown).join('\n\n');
    out.push({
      chunk_text: withHeading(pendingHeading, body),
      chunk_source: 'doc_block',
      source_locator: mergeLocators(buf.map((b) => b.locator)),
    });
    buf = [];
    bufWords = 0;
  };

  for (const block of [...blocks].sort((a, b) => a.order - b.order)) {
    if (block.type === 'heading') {
      flush();
      pendingHeading = block.markdown;
      continue;
    }
    if (block.type === 'table' || block.type === 'figure') {
      flush(); // hard boundary; owned by table.ts / multimodal.ts
      continue;
    }
    if (block.type === 'code') {
      flush();
      out.push({
        chunk_text: withHeading(pendingHeading, block.markdown),
        chunk_source: 'doc_block',
        source_locator: block.locator,
      });
      continue;
    }

    // prose: paragraph | list
    const w = wordCount(block.markdown);
    if (w > target) {
      // Single oversized block → reuse gbrain's recursive splitter.
      flush();
      for (const piece of chunkText(block.markdown, { chunkSize: target, chunkOverlap: 0 })) {
        out.push({
          chunk_text: withHeading(pendingHeading, piece.text),
          chunk_source: 'doc_block',
          source_locator: block.locator,
        });
      }
      continue;
    }
    if (bufWords + w > target && buf.length > 0) flush();
    buf.push(block);
    bufWords += w;
  }
  flush();

  return out;
}
