/**
 * Segmented page storage (Wave B, spec 7.3): one segment's read projection,
 * the text whole-body sanitization (page-window/document.ts projectPageText)
 * gives for that stretch of the body, computed from the segment alone.
 *
 * Whole segments are projected, never a bare slice: the stored protected
 * regions remove takes runs, a truncated tail, materialized markers and the
 * pem guard, replace each private key with the projection token plus its
 * newlines, and leave each facts region as a slot rendered here (world rows
 * only, minus rows the text marks forgotten, through renderFactsRegion; a
 * region crossing the segment's bounds is omitted). The caller hands in the
 * segment text after the withdrawal overlay; this applies the fence overlay
 * (held and purged rows out, rows below the page tier moved to the low-tier
 * block). When either changed the text, or the stored metadata is stale, the
 * regions are recomputed by segmenting the text from the segment's carried
 * entry state; with no usable entry state the read refuses with
 * `page_projection_stale`, never raw text.
 *
 * Each piece maps back to the stored bytes it stands for, so a stored-space
 * range selects pieces: text is cut byte for byte where the mapping is
 * linear; a token, a rendered facts table or text a transform rewrote is
 * emitted whole or not at all.
 */
import { opError } from '../ops/contract.ts';
import { renderFactsRegion } from '../remote-body.ts';
import { credentialSafeProjection } from '../credential-projection.ts';
import { fenceLowTierRows, splitFenceOverlay, type FenceChunkOverlay, type FenceLowTierRow } from '../eligibility/fence-overlay.ts';
import { readEntryState } from './entry-state.ts';
import { utf8Len } from './region-scan.ts';
import { segmentProjectionParts, segmentString, type StoredRegion } from './segmenter.ts';
import type { BodyRegion } from './types.ts';

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The stored parts of one segment the projection reads (a manifest row and its text). */
export interface ProjectableSegment {
  region: BodyRegion;
  bytes: Uint8Array;
  /** Stored-stream offset and 0-based raw line of the segment's first byte. */
  byteStart: number;
  lineStart: number;
  /** The stored entry state (JSON); only read when the regions are recomputed. */
  entryState: unknown;
  protectedRegions: readonly StoredRegion[];
  /** The region's fence trust (body_flags), the trust stored regions were computed under. */
  fenceTrust: 'trusted' | 'void';
}

export interface SegmentProjectionInput {
  /** The segment text after the withdrawal overlay; defaults to the stored text. */
  text?: string;
  fenceOverlay?: FenceChunkOverlay;
  /** The stored regions cannot be trusted (segmenter version or sha mismatch): recompute from the entry state. */
  stale?: boolean;
}

/** A run of the projection: `text`, standing for stored bytes [rawStart, rawEnd) of the segment (segment-relative). */
export interface ProjectedPiece {
  text: string;
  rawStart: number;
  rawEnd: number;
  /** Projected text equals the stored bytes, so a stored range may cut it; otherwise it is emitted whole or not at all. */
  linear: boolean;
}

export interface SegmentProjection {
  pieces: ProjectedPiece[];
  /** Rendered facts regions in slot order (bytes), for the outline's static-to-projected offsets. */
  factsBytes: number[];
  /** Rows the fence overlay moved to the page's low-tier block. */
  lowTier: FenceLowTierRow[];
  /** The regions were recomputed (a transform changed the text, or the metadata was stale). */
  recomputed: boolean;
}

/** `page_projection_stale`: the segment's stored projection metadata is unusable and cannot be recomputed. */
export function projectionStaleError(byteStart: number, why: string) {
  return opError('page_projection_stale',
    `The segment at stored byte ${byteStart} cannot be projected: ${why}. Nothing was returned for it.`,
    'Rewrite the page body (import or sync its file again) so it is segmented by this gbrain version, then read it again.');
}

export function projectSegment(segment: ProjectableSegment, input: SegmentProjectionInput = {}): SegmentProjection {
  const raw = utf8.decode(segment.bytes);
  const overlaid = input.text ?? raw;
  const split = splitFenceOverlay(overlaid, input.fenceOverlay);
  const lowTier = fenceLowTierRows(overlaid, input.fenceOverlay);
  const text = split.main;
  const recompute = input.stale === true || text !== raw;
  const parts = recompute ? recomputedParts(segment, text) : segmentProjectionParts(raw, segment.protectedRegions, segment.byteStart);
  const map = recompute ? diffMap(raw, text) : null;
  const pieces: ProjectedPiece[] = [];
  const factsBytes: number[] = [];
  for (const part of parts) {
    let out = '';
    if (part.kind === 'text' || part.kind === 'pem') out = part.text;
    else if (part.kind === 'facts') {
      out = part.region!.open_start === undefined ? credentialSafeProjection(renderFactsRegion(part.text)) : '';
      factsBytes.push(utf8Len(out));
    }
    if (!out) continue;
    const at = map ? map(part.start, part.end) : { start: part.start, end: part.end, linear: true };
    pieces.push({ text: out, rawStart: at.start, rawEnd: at.end, linear: part.kind === 'text' && at.linear });
  }
  return { pieces, factsBytes, lowTier, recomputed: recompute };
}

/**
 * The trusted body view of a segment (its stored text after the withdrawal overlay) as pieces: one linear piece when
 * the overlay changed nothing, else the unchanged prefix and suffix linear and the rewritten middle whole.
 */
export function overlaidPieces(raw: string, text: string): ProjectedPiece[] {
  if (text === raw) return raw ? [{ text: raw, rawStart: 0, rawEnd: utf8Len(raw), linear: true }] : [];
  const map = diffMap(raw, text);
  const bytes = Buffer.from(text, 'utf8');
  const cuts = [...new Set([0, map.head, map.textTail, bytes.length])].filter(b => b >= 0 && b <= bytes.length).sort((a, b) => a - b);
  const pieces: ProjectedPiece[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const at = map(cuts[i]!, cuts[i + 1]!);
    pieces.push({ text: bytes.subarray(cuts[i]!, cuts[i + 1]!).toString('utf8'), rawStart: at.start, rawEnd: at.end, linear: at.linear });
  }
  return pieces;
}

/** The projection parts of `text` (the segment's text after a transform), segmented from the stored entry state. */
function recomputedParts(segment: ProjectableSegment, text: string) {
  const entry = readEntryState(segment.entryState);
  if (!entry || entry.region !== segment.region) throw projectionStaleError(segment.byteStart, 'its entry state is missing or of another version');
  const segments = segmentString(text, entry, { byteStart: segment.byteStart, lineStart: segment.lineStart, fenceTrust: segment.fenceTrust, end: 'eof' });
  return segments.flatMap(out => {
    const shift = out.byteStart - segment.byteStart;
    return segmentProjectionParts(utf8.decode(out.bytes), out.protectedRegions, out.byteStart)
      .map(part => ({ ...part, start: part.start + shift, end: part.end + shift }));
  });
}

/**
 * Stored bytes of a transformed text's byte range: the common prefix and suffix of the stored and transformed texts map
 * exactly, the rewritten middle maps to its whole stored extent.
 */
interface DiffMap {
  (start: number, end: number): { start: number; end: number; linear: boolean };
  /** Transformed-text bytes of the common prefix, and where the common suffix starts. */
  head: number;
  textTail: number;
}

function diffMap(raw: string, text: string): DiffMap {
  const high = (c: number) => c >= 0xd800 && c <= 0xdbff;
  let p = 0;
  while (p < raw.length && p < text.length && raw.charCodeAt(p) === text.charCodeAt(p)) p++;
  if (p > 0 && high(raw.charCodeAt(p - 1))) p--;
  let q = 0;
  while (q < raw.length - p && q < text.length - p && raw.charCodeAt(raw.length - 1 - q) === text.charCodeAt(text.length - 1 - q)) q++;
  if (q > 0 && high(raw.charCodeAt(raw.length - 1 - q))) q--;
  const head = utf8Len(raw, 0, p);
  const rawTail = utf8Len(raw) - utf8Len(raw, raw.length - q);
  const textTail = utf8Len(text) - utf8Len(text, text.length - q);
  const at = (b: number, end: boolean) => b <= head ? b : b >= textTail ? b - textTail + rawTail : end ? rawTail : head;
  return Object.assign((start: number, end: number) => ({ start: at(start, false), end: at(end, true), linear: end <= head || start >= textTail }),
    { head, textTail });
}
