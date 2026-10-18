/**
 * Segmented page storage (Wave B): the chunker for one segment, spec 4.1.
 *
 * Today's pipeline (markdown-chunks.ts) on one segment's projection instead of
 * a whole column: prose chunks, then the segment's recognized code-fence
 * chunks (truth segments only, as inline pages chunk only the truth's
 * fences), then its low-tier facts rows as marked chunks. Chunks never cross
 * the segment's bounds and carry no overlap from the previous segment, so a
 * segment's chunks depend only on its bytes, entry state and stored regions.
 *
 * The projection is the segment's read projection (segment-projection.ts),
 * the same text a window of the page shows: takes, truncated tail and
 * materialized markers out, private keys as the projection token, each facts
 * region rendered (world rows through the fence overlay, credential-projected)
 * where its slot sits, a facts region that crosses the segment's bounds
 * omitted, all after the page's withdrawal overlay (`text`). That is the
 * safe-fence contract of the inline chunker (chunkText over
 * credentialSafeProjection(sanitizeRemoteBody()) of the overlaid body), so a
 * sealed segmented page carries the markdown chunker's version and remote
 * reads serve its chunks.
 * Inline pages keep prepareMarkdownChunks; this is a separate chunker identity.
 */
import { chunkProjectedText, chunkText, MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { estimateEmbedTokens } from '../chunkers/token-estimate.ts';
import { resolveMaxChunkTokens } from '../embedding-input-limit.ts';
import { fencedCodeChunks, newFenceChunkBudget, type FenceChunkBudget } from '../markdown-chunks.ts';
import { fenceTrustMarker, markFenceChunk, renderFenceLowTier, type FenceChunkOverlay } from '../eligibility/fence-overlay.ts';
import { isQuarantined } from '../quarantine.ts';
import type { EntryState } from './entry-state.ts';
import type { SegmentChunkInput, BodyRegion } from './types.ts';
import type { StoredRegion } from './segmenter.ts';
import { projectSegment } from './segment-projection.ts';

/**
 * `pages.chunker_version` of a sealed segmented page: segments are chunked by the markdown pipeline
 * (chunkProjectedText, fencedCodeChunks) under the same safe-fence contract, so they share its version, at or above
 * SAFE_FENCE_CHUNKER_VERSION. A change to the cuts or the stored per-segment metadata bumps SEGMENTER_VERSION.
 */
export const SEGMENTED_CHUNKER_VERSION = MARKDOWN_CHUNKER_VERSION;

export type SegmentChunk = Omit<SegmentChunkInput, 'occurrence_id'>;

/** The parts of a SegmentOut (or a stored manifest row and its text) the chunker reads. */
export interface ChunkableSegment {
  region: BodyRegion;
  bytes: Uint8Array;
  byteStart: number;
  entryState: EntryState;
  fenceTrust: 'trusted' | 'void';
  protectedRegions: readonly StoredRegion[];
}

export interface SegmentChunkOptions {
  /** The page's current fence trust (body_flags.fence_trust); a segment whose regions were computed under the other trust is refused. */
  fenceTrust: 'trusted' | 'void';
  frontmatter?: Record<string, unknown> | null;
  maxChunkTokens?: number;
  overlay?: FenceChunkOverlay;
  /** The segment text after the page's withdrawal overlay; defaults to the stored text. */
  text?: string;
  /** One budget per page, shared by every segment's call, so the fence caps stay per page. */
  fenceBudget?: FenceChunkBudget;
}

interface MappedPart { projStart: number; projEnd: number; rawStart: number; rawEnd: number; linear: boolean }

export async function prepareSegmentChunks(segment: ChunkableSegment, opts: SegmentChunkOptions): Promise<SegmentChunk[]> {
  if (isQuarantined(opts.frontmatter)) return [];
  if (segment.fenceTrust !== opts.fenceTrust) {
    throw new Error(`segment_regions_stale: regions at byte ${segment.byteStart} were computed under fence trust ${segment.fenceTrust}, the page is ${opts.fenceTrust}; rescan before chunking`);
  }
  const maxTokens = opts.maxChunkTokens ?? resolveMaxChunkTokens();
  const projected = projectSegment({ ...segment, lineStart: 0 }, { text: opts.text, fenceOverlay: opts.overlay });
  const map: MappedPart[] = [];
  let projBytes = 0;
  for (const piece of projected.pieces) {
    const bytes = Buffer.byteLength(piece.text, 'utf8');
    map.push({ projStart: projBytes, projEnd: projBytes + bytes, rawStart: piece.rawStart, rawEnd: piece.rawEnd, linear: piece.linear });
    projBytes += bytes;
  }
  const projection = projected.pieces.map(piece => piece.text).join('');
  const source = segment.region === 'truth' ? 'compiled_truth' : 'timeline';
  const chunks: SegmentChunk[] = [];
  const push = (c: Omit<SegmentChunk, 'local_ordinal'>) => chunks.push({ ...c, local_ordinal: chunks.length });
  const wholeSegment = { raw_byte_start: 0, raw_byte_end: segment.bytes.length };

  if (projection.trim()) {
    for (const c of chunkProjectedText(projection, { maxTokens, spans: true, headingsLead: true })) {
      if (c.byte_start === undefined || c.byte_end === undefined) {
        push({ chunk_text: c.text, chunk_source: source, ...wholeSegment });
        continue;
      }
      push({
        chunk_text: c.text,
        chunk_source: source,
        projected_byte_start: c.byte_start,
        projected_byte_end: c.byte_end,
        raw_byte_start: rawAt(map, c.byte_start, false),
        raw_byte_end: rawAt(map, c.byte_end, true),
      });
    }
    if (segment.region === 'truth') {
      const walk = segment.entryState.trusted.walk;
      const opener = walk.fence ? `${walk.fence.repeat(walk.len)}\n` : '';
      for (const c of await fencedCodeChunks(opener + projection, 0, opts.fenceBudget ?? newFenceChunkBudget())) {
        const { chunk_index: _index, ...rest } = c;
        push({ ...rest, ...wholeSegment });
      }
    }
  }

  for (const { tier, unconfirmed, body } of renderFenceLowTier(projected.lowTier)) {
    const room = Math.max(1, maxTokens - estimateEmbedTokens(fenceTrustMarker(tier, unconfirmed)) - 1);
    for (const c of chunkText(body, { maxTokens: room })) {
      push({ chunk_text: markFenceChunk(tier, c.text, unconfirmed), chunk_source: source, ...wholeSegment });
    }
  }
  return chunks;
}

/**
 * Segment-relative stored byte of projection byte `pos`: exact inside kept
 * text; inside a token or a rendered facts table, the start (for a chunk
 * start) or end (for a chunk end) of the stored region it stands for.
 */
function rawAt(map: readonly MappedPart[], pos: number, end: boolean): number {
  let lo = 0;
  let hi = map.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (end ? map[mid]!.projStart < pos : map[mid]!.projStart <= pos) lo = mid; else hi = mid - 1;
  }
  const part = map[lo]!;
  if (part.linear) return part.rawStart + (pos - part.projStart);
  return end ? part.rawEnd : part.rawStart;
}
