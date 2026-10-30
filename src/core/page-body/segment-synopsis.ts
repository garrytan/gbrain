/**
 * Contextual synopsis per segment (wave-b spec 8.6): the synopsis input of a segmented page's chunks, shared by the
 * synopsis pass (contextual-retrieval-service.ts) and the staging vector reuse (import-chunk-reuse.ts). A chunk's
 * synopsis document is the page's projected lead (its first SEGMENT_SYNOPSIS_LEAD_BYTES) and the window of its own
 * segment that holds it (segmentSynopsisWindows), so its recorded input depends on that segment and the lead alone.
 */
import type { BrainEngine } from '../engine.ts';
import { embeddingInputHash, synopsisDocumentHash, type EmbeddingInputContext } from '../embedding-input-hash.ts';
import { SEGMENT_SYNOPSIS_LEAD_BYTES, segmentSynopsisWindows } from '../page-summary.ts';
import { overlaidBoundedPrefix, pageLeadSource } from '../page-window/bounded-lead.ts';
import { boundedProjectedPrefix } from '../page-window/document.ts';

/**
 * The lead a segmented page's synopsis documents open with: its truth_lead after the withdrawal overlay, sanitized and
 * cut. `truthLead` is the lead a write is about to store; omitted, the stored one.
 */
export async function segmentSynopsisLead(engine: BrainEngine, page: { id: number; slug: string; source_id: string }, truthLead?: string): Promise<string> {
  const lead = truthLead ?? await pageLeadSource(engine, { id: page.id, body_storage: 'segmented', compiled_truth: '' });
  return boundedProjectedPrefix(await overlaidBoundedPrefix(engine, { slug: page.slug, source_id: page.source_id, compiled_truth: lead }), SEGMENT_SYNOPSIS_LEAD_BYTES);
}

type SegmentChunk = { chunk_text: string; chunk_source?: string | null; occurrence_id?: number | null };

/**
 * The per_chunk_synopsis input hash each chunk would record, for chunks given segment by segment in text order (every
 * chunk of a segment, as the segment chunker emits them): each segment's chunks are windowed over `lead` and hashed
 * under `base` with their window document. Image chunks get none.
 */
export function segmentSynopsisInputHashes<C extends SegmentChunk>(base: EmbeddingInputContext, lead: string, chunks: readonly C[]): Map<C, string> {
  const hashes = new Map<C, string>();
  const segments = new Map<number | null, C[]>();
  for (const chunk of chunks) {
    const key = chunk.occurrence_id ?? null;
    const list = segments.get(key);
    if (list) list.push(chunk); else segments.set(key, [chunk]);
  }
  for (const segment of segments.values()) {
    for (const window of segmentSynopsisWindows(segment, lead)) {
      const provenance = { ...base, bodyHash: synopsisDocumentHash(window.document) };
      for (const chunk of window.chunks) hashes.set(chunk, embeddingInputHash(provenance, 'per_chunk_synopsis', chunk));
    }
  }
  return hashes;
}
