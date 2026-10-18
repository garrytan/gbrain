/**
 * Large pages (Wave A read contract): the ONE text every partial page read is
 * cut from. A window, an outline, a chunk-centered window, an evidence block
 * and a bounded prefix are all slices of this projection, never of the raw
 * `compiled_truth` / `timeline` columns:
 *
 *   withdrawal-overlaid body (readPageSnapshot)
 *     -> fence overlay (held and purged facts rows out, rows below the page
 *        tier moved after the truth under their trust marker)
 *     -> sanitizeRemoteBody (Takes, non-world and withdrawn Facts rows,
 *        malformed protected tails and materialized markers dropped, each
 *        column WHOLE, before any slicing)
 *     -> credentialSafeProjection (private-key spans become a token)
 *
 * joined the way serializeMarkdown joins compiled truth and timeline. A slice
 * can start inside what was a protected fence in the stored body and still
 * holds nothing private, because the protected text is gone before the cut.
 * This is the text the chunker cuts from, so a chunk's stored projected span
 * (content_chunks.projected_byte_start/end, v244) addresses it directly.
 *
 * Coordinates: UTF-8 byte offsets (`bytes`), the one unit for stored spans,
 * cursors, windows and caps.
 */
import type { BrainEngine } from '../engine.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { credentialSafeProjection } from '../credential-projection.ts';
import { safeSplitIndex } from '../text-safe.ts';
import { loadFenceChunkOverlay, markFenceChunk, splitFenceOverlay, type FenceChunkOverlay } from '../eligibility/fence-overlay.ts';

/** Separator serializeMarkdown writes between compiled truth and timeline. */
export const TIMELINE_SEPARATOR = '\n\n<!-- timeline -->\n\n';

/** Pages whose read body is over this many bytes are read in windows by default (mcp.inline_body_bytes moves it for get_page). */
export const DEFAULT_INLINE_BODY_BYTES = 256 * 1024;

/** Raw prefix a bounded-prefix reader sanitizes (64 KiB of the overlaid body). */
export const BOUNDED_PREFIX_BYTES = 64 * 1024;

export interface ProjectableBody {
  compiled_truth: string;
  timeline?: string | null;
  fenceOverlay?: FenceChunkOverlay;
}

/**
 * The projected page text in UTF-16 (JS string) coordinates: compiled truth,
 * then its low-tier fence rows under their markers, then the timeline after
 * TIMELINE_SEPARATOR. `timelineAt` is where the timeline text starts, -1 when
 * there is none. Frontmatter is not part of it.
 */
export function projectPageText(page: ProjectableBody, includeTimeline: boolean): { text: string; timelineAt: number } {
  const ownTruth = splitFenceOverlay(page.compiled_truth ?? '', page.fenceOverlay);
  const ownTimeline = splitFenceOverlay(page.timeline ?? '', page.fenceOverlay);
  const truth = [credentialSafeProjection(sanitizeRemoteBody(ownTruth.main)), ...[...ownTruth.lowTier, ...(includeTimeline ? ownTimeline.lowTier : [])]
    .map(({ tier, unconfirmed, body }) => markFenceChunk(tier, credentialSafeProjection(sanitizeRemoteBody(body)), unconfirmed))].join('\n\n');
  const timeline = includeTimeline ? credentialSafeProjection(sanitizeRemoteBody(ownTimeline.main)) : '';
  if (!timeline.trim()) return { text: truth, timelineAt: -1 };
  return { text: truth + TIMELINE_SEPARATOR + timeline, timelineAt: truth.length + TIMELINE_SEPARATOR.length };
}

/** The projected page as bytes: what windows, outlines and cursors address. */
export interface PageDocument {
  bytes: Buffer;
  /** Byte offset where the timeline text starts; -1 when the page has none. */
  timelineByte: number;
}

export function pageDocument(page: ProjectableBody): PageDocument {
  const { text, timelineAt } = projectPageText(page, true);
  return {
    bytes: Buffer.from(text, 'utf8'),
    timelineByte: timelineAt < 0 ? -1 : Buffer.byteLength(text.slice(0, timelineAt), 'utf8'),
  };
}

/**
 * The document for one page read through readPageSnapshot (so the withdrawal
 * overlay is already applied): its fence overlay is loaded, one query, and
 * only when the body has world facts rows.
 */
export async function readPageDocument(
  engine: Pick<BrainEngine, 'executeRaw'>,
  page: { source_id: string; slug: string; compiled_truth: string; timeline?: string | null },
): Promise<PageDocument> {
  const fenceOverlay = await loadFenceChunkOverlay(engine, { sourceId: page.source_id, slug: page.slug, compiled_truth: page.compiled_truth, timeline: page.timeline });
  return pageDocument({ compiled_truth: page.compiled_truth, timeline: page.timeline ?? '', fenceOverlay });
}

/**
 * Where a chunk's stored projected span lands in the document: compiled truth
 * spans are relative to the document start, timeline spans to the timeline
 * text. Null when the chunk has no span or it falls outside the document.
 */
export function chunkDocumentSpan(doc: PageDocument, chunk: {
  chunk_source: string; projected_byte_start?: number | null; projected_byte_end?: number | null;
}): { start: number; end: number } | null {
  const s = chunk.projected_byte_start;
  const e = chunk.projected_byte_end;
  if (typeof s !== 'number' || typeof e !== 'number' || !(e > s) || s < 0) return null;
  const base = chunk.chunk_source === 'timeline' ? doc.timelineByte : chunk.chunk_source === 'compiled_truth' ? 0 : -1;
  if (base < 0) return null;
  const start = base + s;
  const end = base + e;
  if (end > (chunk.chunk_source === 'timeline' || doc.timelineByte < 0 ? doc.bytes.length : doc.timelineByte)) return null;
  return { start, end };
}

/**
 * A stored span is trusted only while it still holds the chunk's text: the
 * chunker folds whitespace-only runs, so the comparison ignores whitespace.
 * A span recorded for an older body (the page changed, the chunks did not
 * yet) fails this check and the caller falls back.
 */
export function spanHoldsChunk(doc: PageDocument, span: { start: number; end: number }, chunkText: string): boolean {
  const slice = doc.bytes.subarray(span.start, span.end).toString('utf8');
  return slice.replace(/\s+/g, '') === chunkText.replace(/\s+/g, '');
}

/**
 * A bounded prefix of the sanitized projection, for helpers that show a lead
 * or synopsis (exact-slug and alias snippets, relational synopses,
 * safeSynopsis, pageLead, think anchor rows): the first `maxBytes` of the
 * (already withdrawal-overlaid) body, cut on a code point, then sanitized and
 * credential-projected like the whole page. Fail-closed by construction: the
 * prefix starts at the body start, so it can never begin inside a protected
 * fence, and a fence the cut leaves open is an unterminated tail the
 * sanitizer drops. O(maxBytes) whatever the page size.
 */
export function boundedProjectedPrefix(body: string | null | undefined, maxBytes: number = BOUNDED_PREFIX_BYTES): string {
  if (typeof body !== 'string' || body.length === 0) return '';
  // maxBytes UTF-8 bytes hold at most maxBytes UTF-16 code units; cut there first, then trim to the byte budget.
  let prefix = body.length > maxBytes ? body.slice(0, safeSplitIndex(body, maxBytes)) : body;
  while (Buffer.byteLength(prefix, 'utf8') > maxBytes) {
    prefix = prefix.slice(0, safeSplitIndex(prefix, Math.floor(prefix.length * 0.9)));
  }
  return credentialSafeProjection(sanitizeRemoteBody(prefix));
}

/**
 * Locate chunks in a projected page text (projectPageText) by their recorded
 * byte spans, verified against the text; one forward pass converts byte offsets to the string's UTF-16
 * offsets. Chunks without a span (or with a stale one) stay unlocated.
 */
export function locateChunksByStoredSpans(text: string, timelineAt: number,
  chunks: ReadonlyArray<{ id: number; chunk_index: number; chunk_text: string; chunk_source: string; projected_byte_start?: number | null; projected_byte_end?: number | null }>): Array<{ id: number; chunk_index: number; start: number; end: number }> {
  const doc = { bytes: Buffer.from(text, 'utf8'), timelineByte: timelineAt < 0 ? -1 : Buffer.byteLength(text.slice(0, timelineAt), 'utf8') };
  const found: Array<{ id: number; chunk_index: number; start: number; end: number }> = [];
  for (const c of chunks) {
    const span = chunkDocumentSpan(doc, c);
    if (span && spanHoldsChunk(doc, span, c.chunk_text)) found.push({ id: c.id, chunk_index: c.chunk_index, start: span.start, end: span.end });
  }
  const positions = [...new Set(found.flatMap(f => [f.start, f.end]))].sort((a, b) => a - b);
  const toChar = new Map<number, number>();
  let byte = 0;
  let char = 0;
  for (const pos of positions) {
    char += doc.bytes.subarray(byte, pos).toString('utf8').length;
    byte = pos;
    toChar.set(pos, char);
  }
  return found.map(f => ({ ...f, start: toChar.get(f.start)!, end: toChar.get(f.end)! })).sort((a, b) => a.chunk_index - b.chunk_index);
}
