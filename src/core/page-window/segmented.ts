/**
 * Segmented pages (Wave B, spec 7.2 and 7.4): get_page windows, outlines and
 * markdown pages over a segmented body, cut from the stored sums plus the
 * segments a read touches. Nothing here holds the whole body.
 *
 * A document is a run of units in the coordinates an inline page uses (UTF-8
 * bytes, 1-based lines): one per segment's projection plus literal text (the
 * low-tier block, TIMELINE_SEPARATOR, a markdown frontmatter head and final
 * newline), each with its byte and newline count from the manifest sums.
 *
 * - The read view is the read projection (page-body/read-range.ts), what
 *   windows, outlines and around_chunk_id address for every caller.
 * - The markdown view is serializeMarkdown's frame around the body the caller
 *   may see: the remote read projection (fail closed: never looser than an
 *   inline page's stripPrivacyFencesForRemoteReader) or, for a trusted local
 *   caller, the stored body after the withdrawal overlay.
 *
 * A window reads a slab: from the start of the unit holding the selector's
 * earliest byte (minus its look-back) to its farthest byte plus EDGE. Wave A's
 * cutters (window.ts) run on the slab unchanged and slabWindow moves offsets
 * and lines by the slab's start and the newlines before it. The look-back and
 * look-ahead per selector keep every cutter from mistaking a slab edge for a
 * document edge, so each cut equals the whole-document cut.
 *
 * {total_bytes, total_lines, sha256} of a markdown view stream the view once
 * per (page, revision, audience), cached in page_view_digests with the read
 * view's line count, so paging a page to its end is linear. A cached row is
 * used only while its byte total matches the stored sums.
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { withoutBody } from '../page-body/page-shape.ts';
import { ledgerApplies } from '../page-body/segment-ledger.ts';
import { projectedLayout, projectedOutline, projectedUnits, readBodyRange, type SegmentedBody } from '../page-body/read-range.ts';
import { TIMELINE_SEPARATOR, spanHoldsChunk } from './document.ts';
import { DATE, sliceWindow, slabWindow, windowAround, windowForBytes, windowFrom, type DocumentSlab, type OutlineEntry, type PageOutline, type WindowSlice } from './window.ts';

export type ViewAudience = 'trusted' | 'remote';

/** Bytes past a window's farthest byte the cutters may test (the byte after maxEnd, a code point). */
const EDGE = 8;
/** Segment text one outline page reads for line numbers and dates (Wave A scans the whole page per call); later entries move to the next page. */
const OUTLINE_READ_BYTES = 4 * 1024 * 1024;
/** Raw bytes `tail_sha256` covers at the end of the last non-empty region. */
const TAIL_BYTES = 4096;
const NL = 0x0a;

/**
 * @internal Deterministic work counters (test/large-pages/read-cost.test.ts): `units` counts document units and
 * manifest rows a read visits, `bytes` the segment text it reads or scans. A read's bytes stay bounded by what it
 * returns; its units grow with the segment count, never with the bytes.
 */
export const segmentedReadWork = { units: 0, bytes: 0 };

export interface DocumentUnit {
  start: number;
  bytes: number;
  newlines: number;
  /** Index into body.rows; -1 for literal `text`. */
  row: number;
  text?: string;
}

type Reader = (start: number, end: number) => Promise<Buffer>;

function newlinesIn(b: Uint8Array): number {
  segmentedReadWork.bytes += b.length;
  let n = 0;
  for (let i = b.indexOf(NL); i !== -1; i = b.indexOf(NL, i + 1)) n++;
  return n;
}

const textUnit = (start: number, text: string): DocumentUnit => {
  const bytes = Buffer.from(text, 'utf8');
  return { start, bytes: bytes.length, newlines: newlinesIn(bytes), row: -1, text };
};

/** The last unit starting at or before `b`; -1 when none. */
function unitAt(units: readonly DocumentUnit[], b: number): number {
  let lo = 0, hi = units.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (units[mid]!.start <= b) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
}

export class SegmentedDocument {
  readonly newlines: number;
  private readonly before: number[];
  private readonly reader: Reader;

  constructor(readonly engine: BrainEngine, readonly body: SegmentedBody, readonly total: number, readonly units: readonly DocumentUnit[],
    reader: Reader, readonly timelineByte = -1) {
    this.reader = async (start, end) => { const b = await reader(start, end); segmentedReadWork.bytes += b.length; return b; };
    segmentedReadWork.units += units.length;
    let n = 0;
    this.before = units.map(u => { const at = n; n += u.newlines; return at; });
    this.newlines = n;
  }

  unitAt(b: number): number { return unitAt(this.units, b); }

  readUnit(i: number): Promise<Buffer> {
    const u = this.units[i]!;
    return u.row < 0 ? Promise.resolve(Buffer.from(u.text!, 'utf8')) : this.reader(u.start, u.start + u.bytes);
  }

  /** Bytes [from, to) widened back to the start of the unit holding `from`, clipped to the document. */
  async slab(from: number, to: number): Promise<DocumentSlab> {
    const i = this.unitAt(Math.max(0, Math.min(from, this.total - 1)));
    if (i < 0) return { bytes: Buffer.alloc(0), start: 0, linesBefore: 0 };
    const start = this.units[i]!.start;
    const end = Math.min(this.total, Math.max(start, to));
    return { bytes: end > start ? await this.reader(start, end) : Buffer.alloc(0), start, linesBefore: this.before[i]! };
  }

  /** windowFrom: snapCodePoint looks back at most 3 bytes. */
  async from(offset: number, maxBytes: number): Promise<WindowSlice> {
    const s = await this.slab(offset - 4, offset + maxBytes + EDGE);
    return slabWindow(s, b => windowFrom(b, offset - s.start, maxBytes));
  }

  /** windowForBytes: the start moves back to its line start only within `length` bytes. */
  async bytes(offset: number, length: number): Promise<WindowSlice> {
    const at = Math.max(0, Math.min(offset, this.total));
    const s = await this.slab(at - length - 1, at + length + EDGE);
    return slabWindow(s, b => windowForBytes(b, at - s.start, length));
  }

  /** windowForLines, with both line offsets from the newline sums (one segment read each). */
  async lines(from: number, count: number, maxBytes: number): Promise<WindowSlice> {
    const start = await this.lineStart(from);
    if (start >= this.total) return this.from(this.total, maxBytes);
    const target = await this.lineStart(from + count);
    const whole = target - start <= maxBytes;
    const s = await this.slab(start, whole ? target : start + maxBytes + EDGE);
    return slabWindow(s, b => whole ? sliceWindow(b, start - s.start, target - s.start) : windowFrom(b, start - s.start, maxBytes));
  }

  /**
   * The window around a segmented chunk: its occurrence's place in the read view plus the segment-relative
   * projected span. Null when the chunk has no span or the span no longer holds its text (no text search).
   * windowAround looks back context lines and centers within maxBytes: a slab maxBytes wide on each side keeps
   * both decisions exact.
   */
  async aroundChunk(chunk: { occurrence_id: number; projected_byte_start: number | null; projected_byte_end: number | null; chunk_text: string },
    contextLines: number, maxBytes: number): Promise<{ window: WindowSlice; span: { start: number; end: number } } | null> {
    segmentedReadWork.units += this.units.length;
    const unit = this.units.find(u => u.row >= 0 && this.body.rows[u.row]!.occurrenceId === chunk.occurrence_id);
    const s0 = chunk.projected_byte_start, e0 = chunk.projected_byte_end;
    if (!unit || s0 == null || e0 == null || !(e0 > s0) || s0 < 0 || e0 > unit.bytes) return null;
    const span = { start: unit.start + s0, end: unit.start + e0 };
    const s = await this.slab(span.start - maxBytes - 1, Math.max(span.end, span.start + maxBytes) + EDGE);
    const local = { start: span.start - s.start, end: span.end - s.start };
    if (!spanHoldsChunk({ bytes: s.bytes, timelineByte: -1 }, local, chunk.chunk_text)) return null;
    return { window: slabWindow(s, b => windowAround(b, local, contextLines, maxBytes)), span };
  }

  /** Byte where 1-based `line` starts (lineOffset): the newline sums find its unit, which is read. */
  async lineStart(line: number): Promise<number> {
    const want = line - 1;
    if (want <= 0) return 0;
    for (let i = 0; i < this.units.length; i++) {
      segmentedReadWork.units++;
      const u = this.units[i]!;
      if (this.before[i]! + u.newlines < want) continue;
      const buf = await this.readUnit(i);
      let at = -1;
      for (let k = want - this.before[i]!; k > 0; k--) {
        at = buf.indexOf(NL, at + 1);
        if (at === -1) return u.start + buf.length;
      }
      return u.start + at + 1;
    }
    return this.total;
  }

  linesBefore(i: number): number { return this.before[i] ?? this.newlines; }

  /** totalLines: the newline sums plus whether the last byte is a newline (reads the last unit). */
  async totalLines(): Promise<number> {
    if (this.total === 0) return 0;
    const last = await this.reader(this.total - 1, this.total);
    return this.newlines + (last[last.length - 1] === NL ? 0 : 1);
  }

  /** The whole document, a unit at a time. */
  async *stream(): AsyncIterable<Buffer> {
    for (let i = 0; i < this.units.length; i++) if (this.units[i]!.bytes > 0) yield await this.readUnit(i);
  }
}

async function projectedBytes(engine: BrainEngine, body: SegmentedBody, start: number, end: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const piece of readBodyRange(engine, { pageId: body.pageId, space: 'projected', start, end, audience: 'remote', body })) parts.push(piece.bytes);
  return Buffer.concat(parts);
}

async function trustedBytes(engine: BrainEngine, body: SegmentedBody, start: number, end: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const piece of readBodyRange(engine, { pageId: body.pageId, space: 'stored', start, end, audience: 'trusted', body })) parts.push(piece.bytes);
  return Buffer.concat(parts);
}

/** The read projection as a document: what windows, outlines and around_chunk_id cut, for every caller. */
export async function segmentedReadDocument(engine: BrainEngine, body: SegmentedBody): Promise<SegmentedDocument> {
  const layout = await projectedLayout(engine, body);
  const units = projectedUnits(body, layout).map(u => u.kind === 'row'
    ? { start: u.start, bytes: layout.rowBytes[u.index]!, newlines: layout.rowNewlines[u.index]!, row: u.index }
    : textUnit(u.start, u.text));
  return new SegmentedDocument(engine, body, layout.totalBytes, units, (start, end) => projectedBytes(engine, body, start, end), layout.timelineByte);
}

/** serializePageToMarkdown's frontmatter head: everything before the body. */
export function markdownHead(page: Page, tags: string[]): string {
  return serializePageToMarkdown({ ...withoutBody(page), compiled_truth: '', timeline: '' } as Page, tags).slice(0, -1);
}

/**
 * The markdown view: `head`, the body this audience may see, and serializeMarkdown's final newline. Remote: the read
 * projection. Trusted: the stored body after the withdrawal overlay (rows the overlay can rewrite, those with facts
 * regions, are measured when the page has a ledger), the timeline after TIMELINE_SEPARATOR when it has text.
 */
export async function segmentedMarkdownDocument(engine: BrainEngine, body: SegmentedBody, head: string, audience: ViewAudience): Promise<SegmentedDocument> {
  const units: DocumentUnit[] = [textUnit(0, head)];
  let pos = units[0]!.bytes;
  const push = (u: Omit<DocumentUnit, 'start'>) => { units.push({ ...u, start: pos }); pos += u.bytes; };
  let read: Reader;
  if (audience === 'remote') {
    const projected = await segmentedReadDocument(engine, body);
    const h = pos;
    for (const u of projected.units) push(u);
    read = async (start, end) => {
      const parts: Buffer[] = [Buffer.from(head, 'utf8').subarray(Math.min(start, h), Math.min(end, h))];
      if (end > h && start < h + projected.total) parts.push(await projectedBytes(engine, body, Math.max(0, start - h), Math.min(projected.total, end - h)));
      if (end > h + projected.total) parts.push(Buffer.from('\n'));
      return Buffer.concat(parts);
    };
  } else {
    const measured = new Map<number, { bytes: number; newlines: number }>();
    segmentedReadWork.units += body.rows.length;
    if (ledgerApplies(body.ledger)) {
      for (const [i, row] of body.rows.entries()) {
        if (!row.hasFacts) continue;
        const text = await trustedBytes(engine, body, row.byteStart, row.byteStart + row.byteLen);
        measured.set(i, { bytes: text.length, newlines: newlinesIn(text) });
      }
    }
    const rowUnits = body.rows.map((row, i) => ({ bytes: row.byteLen, newlines: row.lineCount, ...measured.get(i), row: i }));
    rowUnits.filter(u => body.rows[u.row]!.region === 'truth').forEach(push);
    const timeline = rowUnits.filter(u => body.rows[u.row]!.region === 'timeline');
    if (timeline.some(u => u.bytes > 0)) {
      push(textUnit(0, TIMELINE_SEPARATOR));
      timeline.forEach(push);
    }
    read = async (start, end) => {
      let i = unitAt(units, start);
      if (i < 0) return Buffer.alloc(0);
      const base = units[i]!.start;
      const parts: Buffer[] = [];
      while (i < units.length && units[i]!.start < end) {
        const u = units[i]!;
        if (u.row < 0) { parts.push(Buffer.from(u.text!, 'utf8')); i++; continue; }
        let j = i;
        while (j + 1 < units.length && units[j + 1]!.row >= 0 && units[j + 1]!.start < end) j++;
        const last = body.rows[units[j]!.row]!;
        parts.push(await trustedBytes(engine, body, body.rows[u.row]!.byteStart, last.byteStart + last.byteLen));
        i = j + 1;
      }
      return Buffer.concat(parts).subarray(start - base, end - base);
    };
  }
  push(textUnit(0, '\n'));
  return new SegmentedDocument(engine, body, pos, units, (start, end) => read(start, end));
}

interface Digest { total_bytes: number; total_lines: number; sha256: string | null }

async function readDigest(doc: SegmentedDocument, revision: string, view: 'read' | 'markdown', audience: ViewAudience): Promise<Digest | null> {
  const [row] = await doc.engine.executeRaw<{ total_bytes: unknown; total_lines: unknown; sha256: string | null }>(
    `SELECT total_bytes, total_lines, sha256 FROM page_view_digests WHERE page_id=$1 AND revision=$2 AND view=$3 AND audience=$4`,
    [doc.body.pageId, revision, view, audience]);
  if (!row || Number(row.total_bytes) !== doc.total) return null;
  return { total_bytes: Number(row.total_bytes), total_lines: Number(row.total_lines), sha256: row.sha256 };
}

/** Best effort: a reader that cannot write the cache recomputes next time. Rows of older revisions go. */
async function writeDigest(doc: SegmentedDocument, revision: string, view: 'read' | 'markdown', audience: ViewAudience, d: Digest): Promise<void> {
  try {
    await doc.engine.executeRaw('DELETE FROM page_view_digests WHERE page_id=$1 AND revision<>$2', [doc.body.pageId, revision]);
    await doc.engine.executeRaw(`INSERT INTO page_view_digests (page_id, revision, view, audience, total_bytes, total_lines, sha256) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (page_id, revision, view, audience) DO UPDATE SET total_bytes=EXCLUDED.total_bytes, total_lines=EXCLUDED.total_lines, sha256=EXCLUDED.sha256, created_at=now()`,
    [doc.body.pageId, revision, view, audience, d.total_bytes, d.total_lines, d.sha256]);
  } catch { /* cache only */ }
}

/** {total_bytes, total_lines, sha256} of a markdown view: one streamed pass per (page, revision, audience). */
export async function markdownDigest(doc: SegmentedDocument, revision: string, audience: ViewAudience): Promise<{ total_bytes: number; total_lines: number; sha256: string }> {
  const cached = await readDigest(doc, revision, 'markdown', audience);
  if (cached?.sha256) return { total_bytes: cached.total_bytes, total_lines: cached.total_lines, sha256: cached.sha256 };
  const hash = createHash('sha256');
  let bytes = 0, lines = 0, last = -1;
  for await (const b of doc.stream()) {
    hash.update(b);
    bytes += b.length;
    lines += newlinesIn(b);
    last = b[b.length - 1]!;
  }
  const digest = { total_bytes: bytes, total_lines: bytes === 0 ? 0 : lines + (last === NL ? 0 : 1), sha256: hash.digest('hex') };
  await writeDigest(doc, revision, 'markdown', audience, digest);
  return digest;
}

/** The read view's line count, cached so a window does not read the last segment each call. */
export async function readViewLines(doc: SegmentedDocument, revision: string): Promise<number> {
  const cached = await readDigest(doc, revision, 'read', 'remote');
  if (cached) return cached.total_lines;
  const total_lines = await doc.totalLines();
  await writeDigest(doc, revision, 'read', 'remote', { total_bytes: doc.total, total_lines, sha256: null });
  return total_lines;
}

/**
 * sha256 of the raw last min(4096, region bytes) of the last non-empty region (the append precondition). A remote
 * caller gets it only when those rows hold no protected or facts region: a hash of hidden text is a guessing oracle.
 */
export async function tailDigest(engine: BrainEngine, body: SegmentedBody, remote: boolean): Promise<{ tail_sha256: string; tail_region: string } | Record<string, never>> {
  segmentedReadWork.units += body.rows.length;
  const region = body.rows.some(r => r.region === 'timeline' && r.byteLen > 0) ? 'timeline' : 'truth';
  const rows = body.rows.filter(r => r.region === region);
  const tail: typeof rows = [];
  for (let i = rows.length - 1, bytes = 0; i >= 0 && bytes < TAIL_BYTES; i--) { tail.unshift(rows[i]!); bytes += rows[i]!.byteLen; }
  if (!tail.length) return {};
  if (remote) {
    const [guarded] = await engine.executeRaw<{ n: unknown }>(`SELECT count(*) AS n FROM page_body_manifest WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[])
      AND staging_id IS NULL AND gen_from<=$3 AND (gen_to IS NULL OR gen_to>$3) AND (protected_regions <> '[]'::jsonb OR facts_slots <> '[]'::jsonb)`,
    [body.pageId, tail.map(r => r.occurrenceId), body.generation]);
    if (Number(guarded?.n ?? 1) > 0) return {};
  }
  const texts = await engine.readSegmentTexts(body.sourceId, tail.map(r => r.sha256));
  const raw = Buffer.concat(tail.map(r => texts.get(Buffer.from(r.sha256).toString('hex')) ?? new Uint8Array()));
  segmentedReadWork.bytes += raw.length;
  return { tail_sha256: createHash('sha256').update(raw.subarray(Math.max(0, raw.length - TAIL_BYTES))).digest('hex'), tail_region: region };
}

/** Stored per-segment date ranges (static projection text), by row index. */
async function storedDates(doc: SegmentedDocument, rowIndexes: number[]): Promise<Map<number, { min: string; max: string }>> {
  const out = new Map<number, { min: string; max: string }>();
  const want = rowIndexes.filter(i => doc.body.rows[i]!.hasDate);
  if (!want.length) return out;
  const byOccurrence = new Map(want.map(i => [doc.body.rows[i]!.occurrenceId, i]));
  const rows = await doc.engine.executeRaw<{ occurrence_id: unknown; date_min: string | null; date_max: string | null }>(
    `SELECT occurrence_id, date_min::text AS date_min, date_max::text AS date_max FROM page_body_manifest WHERE page_id=$1 AND occurrence_id=ANY($2::bigint[])
      AND staging_id IS NULL AND gen_from<=$3 AND (gen_to IS NULL OR gen_to>$3)`, [doc.body.pageId, [...byOccurrence.keys()], doc.body.generation]);
  for (const r of rows) if (r.date_min && r.date_max) out.set(byOccurrence.get(Number(r.occurrence_id))!, { min: r.date_min, max: r.date_max });
  return out;
}

class DateRange {
  min?: string;
  max?: string;
  add(min: string, max = min): void {
    if (!this.min || min < this.min) this.min = min;
    if (!this.max || max > this.max) this.max = max;
  }
  scan(text: string): void { for (const m of text.matchAll(DATE)) this.add(m[0]); }
  fields(): { date_min?: string; date_max?: string } { return this.min ? { date_min: this.min, date_max: this.max } : {}; }
}

/**
 * pageOutline over the read view from the stored headings (paged by index through projectedOutline): headings when
 * the page stores at least two, with the text before the first as a leading entry when it is not blank; else one
 * block per segment. Heading entries read the segments holding their boundaries (at most OUTLINE_READ_BYTES per
 * page) for line numbers and dates; segments wholly inside an entry give their stored date range. Blocks read no
 * text: no first_line, stored dates, and line_end assumes the block ends with a newline (true at every cut but a
 * forced one).
 */
export async function segmentedOutline(doc: SegmentedDocument, from: number, limit: number, totalLines: number): Promise<PageOutline> {
  const { engine, body } = doc;
  const stored = await projectedOutline(engine, body, 0, 1);
  if (stored.total_entries < 2) return blocksOutline(doc, from, limit, totalLines);
  const lead = stored.entries[0]!.byte_start > 0 && !await blankBefore(doc, stored.entries[0]!.byte_start);
  const total = stored.total_entries + (lead ? 1 : 0);
  const n = Math.max(0, Math.min(limit, total - from));
  const headings = n ? (await projectedOutline(engine, body, Math.max(0, from - (lead ? 1 : 0)), n + 1)).entries : [];
  const bounds = [...(lead && from === 0 ? [{ start: 0, heading: null as string | null, level: 0 }] : []),
    ...headings.map(h => ({ start: h.byte_start, heading: h.heading as string | null, level: h.level }))].slice(0, n + 1);
  const boundary = (k: number) => bounds[k] ? [doc.unitAt(bounds[k]!.start)].filter(i => doc.units[i]!.row >= 0) : [];
  const reads = new Set<number>();
  let count = 0;
  for (let readBytes = 0; count < n; count++) {
    const want = [...new Set([...boundary(count), ...boundary(count + 1)])].filter(i => !reads.has(i));
    const more = want.reduce((sum, i) => sum + doc.units[i]!.bytes, 0);
    if (count > 0 && readBytes + more > OUTLINE_READ_BYTES) break;
    want.forEach(i => reads.add(i));
    readBytes += more;
  }
  const end = (k: number) => bounds[k + 1]?.start ?? doc.total;
  const interior: number[] = [];
  for (let k = 0; k < count; k++) {
    for (let i = doc.unitAt(bounds[k]!.start); i <= doc.unitAt(end(k) - 1); i++) {
      segmentedReadWork.units++;
      const row = doc.units[i]!.row;
      if (row < 0 || reads.has(i)) continue;
      if (body.rows[row]!.hasFacts) reads.add(i); else interior.push(row);
    }
  }
  const texts = new Map<number, Buffer>();
  for (const i of reads) texts.set(i, await doc.readUnit(i));
  const dates = await storedDates(doc, interior);
  const textOf = async (i: number) => texts.get(i) ?? await doc.readUnit(i);
  // Entries come in byte order: carry the count from the previous byte in the same unit instead of rescanning it.
  let last = { unit: -1, at: 0, line: 0 };
  const lineAt = async (b: number) => {
    const i = doc.unitAt(b);
    if (i < 0) return 1;
    const text = await textOf(i);
    const from = last.unit === i && b >= last.at ? last : { unit: i, at: doc.units[i]!.start, line: 1 + doc.linesBefore(i) };
    last = { unit: i, at: b, line: from.line + newlinesIn(text.subarray(from.at - doc.units[i]!.start, b - doc.units[i]!.start)) };
    return last.line;
  };
  const entries: OutlineEntry[] = [];
  for (let k = 0; k < count; k++) {
    const { start, heading, level } = bounds[k]!;
    const stop = end(k);
    const range = new DateRange();
    for (let i = doc.unitAt(start); i <= doc.unitAt(stop - 1); i++) {
      segmentedReadWork.units++;
      const u = doc.units[i]!;
      if (u.row >= 0 && !texts.has(i)) {
        const d = dates.get(u.row);
        if (d) range.add(d.min, d.max);
        continue;
      }
      const slice = (await textOf(i)).subarray(Math.max(start, u.start) - u.start, Math.min(stop, u.start + u.bytes) - u.start);
      segmentedReadWork.bytes += slice.length;
      range.scan(slice.toString('utf8'));
    }
    const lineStart = await lineAt(start);
    entries.push({
      heading, ...(level ? { level } : {}), line_start: lineStart,
      line_end: Math.min(bounds[k + 1] ? await lineAt(stop) - 1 : totalLines, totalLines), byte_start: start, byte_end: stop, ...range.fields(),
    });
  }
  return { kind: 'headings', entries, total_entries: total, from_index: from, ...(from + entries.length < total ? { next_from_index: from + entries.length } : {}) };
}

/** Whether the read view holds only whitespace before byte `b` (a large segment before it is taken as text after two reads). */
async function blankBefore(doc: SegmentedDocument, b: number): Promise<boolean> {
  const last = doc.unitAt(b);
  let reads = 0;
  for (let i = 0; i <= last; i++) {
    segmentedReadWork.units++;
    const u = doc.units[i]!;
    const upTo = Math.min(u.bytes, b - u.start);
    if (upTo <= 0) continue;
    if (u.row >= 0 && ++reads > 2) return false;
    if ((await doc.readUnit(i)).subarray(0, upTo).toString('utf8').trim()) return false;
  }
  return true;
}

async function blocksOutline(doc: SegmentedDocument, from: number, limit: number, totalLines: number): Promise<PageOutline> {
  const starts: number[] = [];
  segmentedReadWork.units += doc.units.length;
  for (const u of doc.units) if (u.row >= 0 && u.bytes > 0) starts.push(starts.length ? u.start : 0);
  if (!starts.length && doc.total > 0) starts.push(0);
  const page = starts.slice(from, from + limit);
  const rows = new Set<number>();
  const end = (k: number) => starts[from + k + 1] ?? doc.total;
  page.forEach((start, k) => {
    for (let i = doc.unitAt(start); i <= doc.unitAt(end(k) - 1); i++) { segmentedReadWork.units++; if (doc.units[i]!.row >= 0) rows.add(doc.units[i]!.row); }
  });
  const dates = await storedDates(doc, [...rows]);
  const entries: OutlineEntry[] = page.map((start, k) => {
    const stop = end(k);
    const range = new DateRange();
    for (let i = doc.unitAt(start); i <= doc.unitAt(stop - 1); i++) {
      segmentedReadWork.units++;
      const u = doc.units[i]!;
      if (u.row < 0) range.scan(u.text!);
      else { const d = dates.get(u.row); if (d) range.add(d.min, d.max); }
    }
    const lineStart = 1 + (start === 0 ? 0 : doc.linesBefore(doc.unitAt(start)));
    const lineEnd = stop === doc.total ? totalLines : Math.max(lineStart, doc.linesBefore(doc.unitAt(stop)));
    return { line_start: lineStart, line_end: Math.min(lineEnd, totalLines), byte_start: start, byte_end: stop, ...range.fields() };
  });
  return { kind: 'blocks', entries, total_entries: starts.length, from_index: from, ...(from + entries.length < starts.length ? { next_from_index: from + entries.length } : {}) };
}
