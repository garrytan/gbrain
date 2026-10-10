/**
 * Evidence delivery — request/response shapes and the row mapper for the ONE
 * batched neighbor fetch (`BrainEngine.getChunkWindows`). The SQL lives once
 * in `engine-sql/chunks.ts` (`getChunkWindows`); both engines delegate.
 *
 * Keyed by page_id (never slug), so same-slug pages in two sources never mix.
 * Every requested page is re-authorized under the caller's CURRENT read
 * scope with the same predicate the search legs use (source scope, deleted,
 * text projection, archived source, quarantine, private pages, safe chunks);
 * a page that fails is simply absent from the result. Page rows carry the
 * raw body (the assembler sanitizes it whole); chunk rows are read only for
 * sealed pages and anchor the hits in that text.
 */
import type { PageReadScope } from '../types.ts';
import type { FenceChunkOverlay } from '../eligibility/fence-overlay.ts';

export interface ChunkWindowRequest {
  page_id: number;
  /** Inclusive chunk_index range to read. */
  from_index: number;
  to_index: number;
  /** Lower = more important; rows are read in this order under `maxRows`. */
  priority: number;
}

export interface ChunkWindowChunk {
  id: number;
  chunk_index: number;
  chunk_text: string;
  chunk_source: string;
}

export interface ChunkWindowPage {
  page_id: number;
  slug: string;
  source_id: string;
  type: string;
  /** pages.knowledge_revision the chunks belong to. */
  revision: string;
  /** False when the page's chunks predate the protected-body index. */
  sealed: boolean;
  /** The stored body columns (raw; the assembler sanitizes them whole). */
  compiled_truth: string;
  timeline: string;
  /** Highest chunk_index stored for the page (text chunks of any source). */
  max_chunk_index: number;
  /** Rows inside the requested ranges, chunk_index order. */
  chunks: ChunkWindowChunk[];
  /** True when the row cap stopped before every requested row was read. */
  row_limited: boolean;
  /** #5575 ENG-1: the page's fence overlay, attached by evidence delivery before it builds the page document. */
  fenceOverlay?: FenceChunkOverlay;
}

export interface ChunkWindowOpts extends PageReadScope {
  /** Restrict to these chunk sources (detail: 'low' passes ['compiled_truth']). */
  chunkSources: string[];
  /** Hard cap on chunk rows read for the whole request. */
  maxRows: number;
}

/** Group the flat UNION rows into per-page windows. Row order is not trusted. */
export function mapChunkWindowRows(rows: Record<string, unknown>[], maxRows: number): ChunkWindowPage[] {
  const pages = new Map<number, ChunkWindowPage & { prio: number }>();
  const chunkRows = rows
    .filter(r => r.kind === 'chunk')
    .map(r => ({ page_id: Number(r.page_id), id: Number(r.chunk_id), chunk_index: Number(r.chunk_index), chunk_text: String(r.chunk_text ?? ''), chunk_source: String(r.chunk_source), prio: Number(r.prio) }))
    .sort((a, b) => a.prio - b.prio || a.page_id - b.page_id || a.chunk_index - b.chunk_index);
  for (const r of rows) {
    if (r.kind !== 'page') continue;
    pages.set(Number(r.page_id), {
      page_id: Number(r.page_id),
      slug: String(r.slug),
      source_id: String(r.source_id),
      type: String(r.type),
      revision: String(r.revision),
      sealed: r.sealed === true || r.sealed === 't',
      compiled_truth: String(r.compiled_truth ?? ''),
      timeline: String(r.timeline ?? ''),
      max_chunk_index: r.max_chunk_index == null ? -1 : Number(r.max_chunk_index),
      chunks: [],
      row_limited: false,
      prio: Number(r.prio),
    });
  }
  const limited = chunkRows.length > maxRows;
  const kept = limited ? chunkRows.slice(0, maxRows) : chunkRows;
  for (const c of kept) pages.get(c.page_id)?.chunks.push({ id: c.id, chunk_index: c.chunk_index, chunk_text: c.chunk_text, chunk_source: c.chunk_source });
  if (limited) {
    const cutoff = chunkRows[maxRows];
    for (const p of pages.values()) {
      if (p.prio > cutoff.prio || (p.prio === cutoff.prio && p.page_id >= cutoff.page_id)) p.row_limited = true;
    }
  }
  return [...pages.values()]
    .sort((a, b) => a.prio - b.prio || a.page_id - b.page_id)
    .map(({ prio: _prio, ...page }) => page);
}
