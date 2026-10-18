/**
 * Segmented page storage (Wave B, spec 8.2 fences, PR 2 full-pass mode): what
 * the facts fence reconcile reads from a segmented body (FactsFenceView),
 * without holding the body as one string.
 *
 * The view needs, per section, the first begin marker outside code, the first
 * end marker outside code after it and the text between them, and whether a
 * timeline line outside fenced code is the begin marker. Only runs holding a
 * fence marker can change any of those, so only they are read: the live
 * manifest rows that carry facts slots or whose segment text holds a marker
 * (found in SQL, nothing transferred), plus every run with a forced cut
 * inside a line (a marker may straddle one; no marker holds a newline, so a
 * forced cut after one cannot split it), and every run after an open fence
 * until it closes. A block starts outside code (segment-blocks.ts), so each marker is
 * located in its block exactly as in the joined section. The segmenter never
 * cuts inside a fence, so a fence lies in one block: a fence longer than a
 * segment is a run of forced cuts, which bodyBlocks joins up to
 * BLOCK_MAX_BYTES and refuses above with `page_body_segmented`. Joining a
 * fence across blocks is a fallback that keeps the same bound. While the
 * source has withdrawals, a fence crossing a forced cut is read joined across
 * it and overlaid whole (read-range.ts `trustedSegments`, up to
 * FENCE_MAX_BYTES), then cut into blocks here as any run is.
 *
 * `segmentedBodyMatchesFile` is the stale-cache check (canonicalCacheState)
 * for a segmented page: the canonical file's split regions, streamed from
 * the file, against the stored regions, by length and SHA-256.
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { BrainEngine } from '../engine.ts';
import { indexOfOutsideCode } from '../fence-scan.ts';
import {
  FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, timelineHasGenuineFactsFenceMarker, type FactsFenceView,
} from '../facts-fence.ts';
import { BodyScanner } from './body-scan.ts';
import { readBodyRange } from './read-range.ts';
import { BLOCK_MAX_BYTES, blockTooLargeError, bodyBlocks, readGarbageCollector, segmentedPassWork } from './segment-blocks.ts';
import type { BodyRegion } from './types.ts';

type FencePage = { id: number; slug: string; source_id: string };

/** Live manifest seqs whose segment can hold (part of) a facts fence marker. */
async function markerSeqs(engine: BrainEngine, pageId: number): Promise<Set<number>> {
  const rows = await engine.executeRaw<{ seq: number }>(`SELECT m.seq FROM page_body_manifest m
      JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256
     WHERE m.page_id=$1 AND m.gen_to IS NULL AND m.staging_id IS NULL
       AND (m.facts_slots<>'[]'::jsonb OR (m.cut_kind='forced' AND get_byte(t.body, length(t.body)-1)<>10)
         OR position($2::bytea in t.body)>0 OR position($3::bytea in t.body)>0)`,
  [pageId, Buffer.from(FACTS_FENCE_BEGIN, 'utf8'), Buffer.from(FACTS_FENCE_END, 'utf8')]);
  return new Set(rows.map(row => Number(row.seq)));
}

/** parseFactsFence, factsFenceSections and (timeline) timelineHasGenuineFactsFenceMarker of one region, streamed. */
async function regionFence(engine: BrainEngine, page: FencePage, region: BodyRegion, marked: ReadonlySet<number>) {
  let fence: string[] | null = null;
  let fenceChars = 0;
  let endOnly = false;
  let marker = false;
  let parsedText: string | null = null;
  const want = ({ seqs }: { seqs: readonly number[] }) => (fence !== null && parsedText === null)
    || ((parsedText === null || region === 'timeline') && seqs.some(seq => marked.has(seq)));
  for await (const { text, at } of bodyBlocks(engine, page, { regions: [region], want })) {
    if (region === 'timeline') marker ||= timelineHasGenuineFactsFenceMarker(text);
    if (parsedText !== null) continue;
    let from = 0;
    let search = 0;
    if (!fence) {
      const begin = indexOfOutsideCode(text, FACTS_FENCE_BEGIN);
      if (begin === -1) {
        // locateOutsideCode's end search with no begin starts at FACTS_FENCE_BEGIN.length - 1; a block after the
        // first run sits past that (a segment holds at least SEGMENT_MIN_BYTES).
        const floor = at === 0 ? FACTS_FENCE_BEGIN.length - 1 : 0;
        endOnly ||= indexOfOutsideCode(text, FACTS_FENCE_END, floor) !== -1;
        continue;
      }
      fence = [];
      from = begin;
      search = begin + FACTS_FENCE_BEGIN.length;
    }
    const end = indexOfOutsideCode(text, FACTS_FENCE_END, search);
    const piece = text.slice(from, end === -1 ? text.length : end + FACTS_FENCE_END.length);
    fenceChars += piece.length;
    segmentedPassWork.carry += piece.length;
    if (fenceChars > BLOCK_MAX_BYTES) throw blockTooLargeError(page.slug, page.source_id, fenceChars);
    fence.push(piece);
    if (end !== -1) parsedText = fence.join('');
  }
  const reduced = parsedText ?? (fence ? FACTS_FENCE_BEGIN : endOnly ? `${'\n'.repeat(FACTS_FENCE_BEGIN.length)}${FACTS_FENCE_END}` : '');
  return { parsed: parseFactsFence(reduced), holds: fence !== null, marker };
}

/** factsFenceView of a segmented page, reading only the runs that can hold a fence marker. */
export async function segmentedFactsFenceView(engine: BrainEngine, page: { id?: number; slug?: string; source_id?: string }): Promise<FactsFenceView> {
  const p = { id: Number(page.id), slug: page.slug ?? '', source_id: page.source_id ?? 'default' };
  const marked = await markerSeqs(engine, p.id);
  const truth = await regionFence(engine, p, 'truth', marked);
  const timeline = await regionFence(engine, p, 'timeline', marked);
  return { body: truth.parsed, timeline: timeline.parsed, sections: { body: truth.holds, timeline: timeline.holds }, timelineMarker: timeline.marker };
}

const FILE_READ_BYTES = 1024 * 1024;

/** Each region's [bytes, SHA-256] as the file splits it (parseMarkdown's compiled_truth and timeline), streamed from the file. */
async function fileRegionDigests(path: string): Promise<Record<BodyRegion, [number, string]> | null> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const scanner = new BodyScanner(path);
    const buffer = Buffer.alloc(FILE_READ_BYTES);
    const collect = readGarbageCollector();
    for (let at = 0; at < size;) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(FILE_READ_BYTES, size - at), at);
      if (!bytesRead) break;
      scanner.push(buffer.subarray(0, bytesRead));
      segmentedPassWork.bytes += bytesRead;
      collect(bytesRead);
      at += bytesRead;
    }
    const scan = scanner.finish();
    if (scan.kind !== 'ok') return null;
    const digest = async (pieces: typeof scan.truth): Promise<[number, string]> => {
      const sha = createHash('sha256');
      let bytes = 0;
      for (const piece of pieces) {
        if ('text' in piece) {
          const text = Buffer.from(piece.text, 'utf8');
          sha.update(text);
          bytes += text.length;
          continue;
        }
        for (let at = piece.start; at < piece.end;) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(FILE_READ_BYTES, piece.end - at), at);
          if (!bytesRead) break;
          sha.update(buffer.subarray(0, bytesRead));
          segmentedPassWork.bytes += bytesRead;
          collect(bytesRead);
          bytes += bytesRead;
          at += bytesRead;
        }
      }
      return [bytes, sha.digest('hex')];
    };
    return { truth: await digest(scan.truth), timeline: await digest(scan.timeline) };
  } finally {
    await file.close();
  }
}

/** [bytes, SHA-256] of a stored region of a segmented page, as readPageSnapshot gives a trusted reader (the withdrawal overlay applied). */
async function storedRegionDigest(engine: BrainEngine, pageId: number, region: BodyRegion): Promise<[number, string]> {
  const sha = createHash('sha256');
  let bytes = 0;
  const collect = readGarbageCollector();
  for await (const piece of readBodyRange(engine, { pageId, space: 'stored', start: 0, end: Infinity, audience: 'trusted', region })) {
    sha.update(piece.bytes);
    bytes += piece.bytes.length;
    segmentedPassWork.bytes += piece.bytes.length;
    collect(piece.bytes.length);
  }
  return [bytes, sha.digest('hex')];
}

/**
 * Whether the canonical file at `path` splits into the stored body of a segmented page, region by region, as
 * canonicalCacheState compares an inline page's strings. 'stale' when the file does not scan.
 */
export async function segmentedBodyMatchesFile(engine: BrainEngine, page: { id: number }, path: string): Promise<'fresh' | 'stale'> {
  const file = await fileRegionDigests(path);
  if (!file) return 'stale';
  for (const region of ['truth', 'timeline'] as const) {
    const stored = await storedRegionDigest(engine, Number(page.id), region);
    if (stored[0] !== file[region][0] || stored[1] !== file[region][1]) return 'stale';
  }
  return 'fresh';
}
