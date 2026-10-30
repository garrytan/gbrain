/**
 * Evidence delivery on a segmented page (Wave B, spec 7.4): the windows an
 * evidence block is cut from, read without a page text.
 *
 * An inline page's evidence is cut from its whole projected text
 * (pageEvidenceText); a segmented page has no such text and never gets one.
 * Each hit is placed from its chunk's references (`occurrence_id` plus the
 * segment-relative projected span getChunkWindows returns, moved to document
 * bytes through the read projection's manifest sums), and only the bytes
 * around it are read with readBodyRange: the per-segment read projection
 * (stored protected regions, the withdrawal overlay per segment, the fence
 * overlay) that a get_page window of the page shows. A `window` reads the
 * hit's neighbor chunks (chunk_index within the radius), a `section` the
 * hit's segment (segments are cut at headings, days and message turns), a
 * `page` the whole text only while it is within the inline read size.
 * Windows are widened to whole lines, merged where they meet, and returned in
 * document order as runs the assembler joins with an omission mark.
 *
 * A chunk span is used only while it still holds the chunk's text (spans
 * drift when a hold or a tier change moves the projection); a hit whose chunk
 * has no stored span (a fenced-code or low-tier chunk) is placed by a unique
 * exact match inside its own segment, never by a search of the page.
 *
 * The windows are read at the revision getChunkWindows authorized the page at
 * (`page.revision`): a page that changed since (a visibility flip, a new
 * body, a delete) refuses the read, and the assembler falls back to the hit's
 * chunk. The windows (and the segments unspanned hits are matched in) are read
 * at once; the revision is confirmed after every read has answered.
 */
import type { BrainEngine } from '../engine.ts';
import type { ChunkWindowPage } from './chunk-windows.ts';
import { DEFAULT_INLINE_BODY_BYTES, TIMELINE_SEPARATOR } from '../page-window/document.ts';
import { confirmBodyPin, openSegmentedBody, projectedLayout, readBodyRange, type SegmentedBody } from '../page-body/read-range.ts';

/** Bytes read past a window's ends so it can start and end on whole lines. */
const LINE_PAD_BYTES = 4096;

export interface EvidenceSpan { id: number; chunk_index: number; start: number; end: number }

export interface SegmentedWindows {
  /** Projected bytes of the text evidence is cut from (its truth only when the timeline is left out). */
  bytes: number;
  /** A `page` unit was asked for over the inline read size: the runs are the windows around the hits. */
  overInline: boolean;
  /** The windows read, in document order; spans are UTF-16 offsets into their run's text. */
  runs: Array<{ text: string; spans: EvidenceSpan[] }>;
  /** Hits whose chunk has no stored span, placed by an exact match in their segment: chunk id -> run and span. */
  placed: Map<number, { run: number; start: number; end: number }>;
}

interface Located extends EvidenceSpan { row: number; text: string }

export async function readSegmentedWindows(engine: BrainEngine, page: ChunkWindowPage,
  hits: ReadonlyArray<{ chunk_id: number; chunk_index: number; text: string }>,
  opts: { unit: 'window' | 'section' | 'page'; radius: number; includeTimeline: boolean }): Promise<SegmentedWindows> {
  const body = await openSegmentedBody(engine, { pageId: page.page_id, pin: { revision: page.revision }, expect: { slug: page.slug, sourceId: page.source_id } });
  const layout = await projectedLayout(engine, body);
  const region = opts.includeTimeline ? undefined : 'truth' as const;
  const bytes = region && layout.timelineByte >= 0 ? layout.timelineByte - Buffer.byteLength(TIMELINE_SEPARATOR, 'utf8') : layout.totalBytes;
  const rowOf = new Map(body.rows.map((row, i) => [row.occurrenceId, i]));
  const rowAt = (occurrence: number | undefined) => {
    const i = occurrence === undefined ? undefined : rowOf.get(occurrence);
    return i !== undefined && layout.rowStart[i]! >= 0 && (!region || body.rows[i]!.region === region) ? i : undefined;
  };
  const rowEnd = (i: number) => layout.rowStart[i]! + layout.rowBytes[i]!;
  const located: Located[] = page.chunks.flatMap(c => {
    const row = rowAt(c.occurrence_id);
    const s = c.projected_byte_start;
    const e = c.projected_byte_end;
    if (row === undefined || s == null || e == null || !(e > s) || layout.rowStart[row]! + e > rowEnd(row)) return [];
    return [{ id: c.id, chunk_index: c.chunk_index, start: layout.rowStart[row]! + s, end: layout.rowStart[row]! + e, row, text: c.chunk_text }];
  });

  const placedBytes = new Map<number, { start: number; end: number }>();
  const homes: Array<{ start: number; end: number; chunkIndex: number; row: number }> = [];
  const unspanned = (hit: typeof hits[number]) => {
    if (located.some(l => l.id === hit.chunk_id)) return undefined;
    const chunk = page.chunks.find(c => c.id === hit.chunk_id);
    const row = chunk && chunk.projected_byte_start == null ? rowAt(chunk.occurrence_id) : undefined;
    return row !== undefined && hit.text.trim().length >= 16 ? row : undefined;
  };
  const segments = await Promise.all(hits.map(hit => {
    const row = unspanned(hit);
    return row === undefined ? undefined : readLines(engine, body, region, layout.rowStart[row]!, rowEnd(row), bytes);
  }));
  for (const [k, hit] of hits.entries()) {
    const own = located.find(l => l.id === hit.chunk_id);
    if (own) { homes.push({ ...own, chunkIndex: own.chunk_index }); continue; }
    const row = unspanned(hit);
    const needle = hit.text.trim();
    if (row !== undefined) {
      const segment = segments[k]!.bytes.toString('utf8');
      const at = segment.indexOf(needle);
      if (at >= 0 && segment.lastIndexOf(needle) === at) {
        const start = layout.rowStart[row]! + Buffer.byteLength(segment.slice(0, at), 'utf8');
        const span = { start, end: start + Buffer.byteLength(needle, 'utf8') };
        placedBytes.set(hit.chunk_id, span);
        homes.push({ ...span, row, chunkIndex: located.find(l => l.row === row && l.start <= span.start && span.end <= l.end)?.chunk_index ?? Number.NEGATIVE_INFINITY });
        continue;
      }
    }
    let near: Located | undefined;
    for (const l of located) if (!near || Math.abs(l.chunk_index - hit.chunk_index) < Math.abs(near.chunk_index - hit.chunk_index)) near = l;
    if (near) homes.push({ ...near, chunkIndex: near.chunk_index });
  }

  const overInline = opts.unit === 'page' && bytes > DEFAULT_INLINE_BODY_BYTES;
  const wanted = opts.unit === 'page' && !overInline ? [{ start: 0, end: bytes }] : homes.map(h => {
    if (opts.unit === 'section') return { start: layout.rowStart[h.row]!, end: rowEnd(h.row) };
    const near = located.filter(l => Math.abs(l.chunk_index - h.chunkIndex) <= opts.radius);
    return { start: Math.min(h.start, ...near.map(l => l.start)), end: Math.max(h.end, ...near.map(l => l.end)) };
  });
  const merged: Array<{ start: number; end: number }> = [];
  for (const w of wanted.sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end + 2 * LINE_PAD_BYTES) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }

  const runs: SegmentedWindows['runs'] = [];
  const placed: SegmentedWindows['placed'] = new Map();
  const reads = await Promise.all(merged.map(w => readLines(engine, body, region, w.start, w.end, bytes)));
  for (const read of reads) {
    const runEnd = read.start + read.bytes.length;
    if (read.bytes.length === 0) continue;
    const text = read.bytes.toString('utf8');
    const charAt = (byte: number) => read.bytes.subarray(0, byte - read.start).toString('utf8').length;
    const inside = (s: { start: number; end: number }) => s.start >= read.start && s.end <= runEnd;
    const spans = located.filter(l => inside(l) && read.bytes.subarray(l.start - read.start, l.end - read.start).toString('utf8').replace(/\s+/g, '') === l.text.replace(/\s+/g, ''))
      .map(l => ({ id: l.id, chunk_index: l.chunk_index, start: charAt(l.start), end: charAt(l.end) }));
    for (const [id, span] of placedBytes) if (inside(span)) placed.set(id, { run: runs.length, start: charAt(span.start), end: charAt(span.end) });
    runs.push({ text, spans });
  }
  await confirmBodyPin(engine, body);
  return { bytes, overInline, runs, placed };
}

/**
 * Projected bytes [start, end) widened to whole lines: up to LINE_PAD_BYTES are read on each side, the window starts
 * after the last newline before `start` and ends after the first newline at or after `end`; with no newline in reach
 * it is cut on a code point. `limit` is where the text ends.
 */
async function readLines(engine: BrainEngine, body: SegmentedBody, region: 'truth' | undefined, start: number, end: number, limit: number): Promise<{ bytes: Buffer; start: number }> {
  const from = Math.max(0, start - LINE_PAD_BYTES);
  const to = Math.min(limit, end + LINE_PAD_BYTES);
  const pieces: Buffer[] = [];
  let at = from;
  for await (const piece of readBodyRange(engine, { pageId: body.pageId, space: 'projected', start: from, end: to, audience: 'remote', body, region })) {
    if (pieces.length === 0) at = piece.projectedStart;
    pieces.push(piece.bytes);
  }
  const buf = Buffer.concat(pieces);
  const s = Math.max(0, start - at);
  const e = Math.min(buf.length, end - at);
  const before = s > 0 ? buf.lastIndexOf(0x0a, s - 1) : -1;
  let a = before >= 0 ? before + 1 : at === 0 ? 0 : s;
  while (a < buf.length && (buf[a]! & 0xc0) === 0x80) a++;
  const after = buf.indexOf(0x0a, Math.max(a, e - 1));
  let b = after >= 0 ? after + 1 : at + buf.length >= to && to === limit ? buf.length : e;
  while (b > a && b < buf.length && (buf[b]! & 0xc0) === 0x80) b--;
  return { bytes: buf.subarray(a, Math.max(a, b)), start: at + a };
}
