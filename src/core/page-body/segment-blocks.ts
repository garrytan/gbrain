/**
 * Segmented page storage (Wave B, spec 8, PR 2 full-pass mode): a segmented
 * page's trusted body for the derived passes (links, timeline, mentions,
 * takes), one block at a time, never the whole body as one string.
 *
 * The text is the joined body `${compiled_truth}\n${timeline}` (or the regions
 * and separator a pass names) after the withdrawal overlay, read with
 * `trustedSegments` (read-range.ts, the trusted stored read): what readPageSnapshot
 * gives a trusted reader of an inline page. The manifest is walked once per
 * region. A block is one segment, or a run of segments joined across forced
 * cuts that fell where the segmenter's parsers do not start fresh, so every
 * block starts outside code fences, protected regions, fence blocks, timeline
 * detail runs and long lines. A forced cut after a `\n` before a line the
 * segmenter's no-cut rules allow (`cutBlocked` on the next segment's entry
 * state and first line, as a structural cut is judged) is a block boundary:
 * ordinary short lines or dated bullets with no structural candidate are cut
 * only by force. A joined run longer than BLOCK_MAX_BYTES (a line or fence many
 * segments long) refuses with `page_body_segmented`; a facts fence crossing a
 * forced cut while the source has withdrawals is read joined across it by
 * read-range.ts `trustedSegments` (up to FENCE_MAX_BYTES, the bound withdrawal
 * discovery and the purge rewrite share), and a block it yields longer than
 * BLOCK_MAX_BYTES still refuses here.
 */
import type { BrainEngine } from '../engine.ts';
import { BLOCK_MAX_BYTES, blockTooLargeError, bodyRowWork, confirmBodyPin, openSegmentedBody, readBodyRange, trustedSegments, type BodyPin } from './read-range.ts';
import { ledgerApplies } from './segment-ledger.ts';
import { cutBlocked, SEGMENTER_VERSION } from './segmenter.ts';
import { assertGenerationTiles } from './body-tiling.ts';
import { readEntryState } from './entry-state.ts';
import type { BodyRegion } from './types.ts';

/** Bytes a pass reads between two full collections (ingest.ts collectBatchGarbage: one per 4 MiB staging batch). */
const COLLECT_EVERY_BYTES = 4 * 1024 * 1024;

/**
 * A full collection every COLLECT_EVERY_BYTES read. Each segment read leaves garbage several times its size (driver
 * buffers, decoded texts), and JSC sizes its threshold to a heap PGLite's WASM memory makes large, so a pass over a
 * 40 MiB page peaked ~0.8 GB above its live heap without this. Feed it the bytes of each piece read; true when it collected.
 */
export function readGarbageCollector(): (bytes: number) => boolean {
  let since = 0;
  return bytes => {
    since += bytes;
    if (since < COLLECT_EVERY_BYTES) return false;
    since = 0;
    Bun.gc(true);
    return true;
  };
}

/**
 * @internal Work the derived passes do over a segmented body, for the linearity test: bytes read (`bytes`), UTF-16
 * units of the blocks yielded (`blocks`) and of the link-extraction windows built around them (`windows`), and units a
 * pass copies past its block (`carry`: a takes fence joined across blocks, the watermark planner's tail window),
 * and bytes scanned for the first line after a forced cut (`lines`). Counts, not time, so a busy machine cannot move them.
 */
export const segmentedPassWork = { bytes: 0, blocks: 0, windows: 0, carry: 0, lines: 0 };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export { BLOCK_MAX_BYTES, blockTooLargeError } from './read-range.ts';

export interface BodyBlock {
  /** The block's region; null for the separator between two regions. */
  region: BodyRegion | null;
  text: string;
  /** UTF-16 offset of `text` in the joined text. */
  at: number;
}

export interface BodyBlockOptions {
  /** Regions in order (default: truth, then timeline). */
  regions?: readonly BodyRegion[];
  /** Text between two regions (default '\n', as in `${compiled_truth}\n${timeline}`). */
  separator?: string;
  /**
   * Read only the runs this accepts (the manifest seqs of a run of segments joined by forced cuts, one block or more,
   * and whether it is its region's first); it is asked as each run is reached, so it may depend on the blocks already
   * read. A block after a skipped run has `at` NaN.
   */
  want?: (run: { seqs: readonly number[]; first: boolean }) => boolean;
  /** Asked before each segment is read: true ends the read with BodyReadStopped (a caller's time budget ran out). */
  stop?: () => boolean;
  /**
   * Collects the key (runKey) of each run read whole, when no withdrawal applies to the page (each block's text is its
   * stored text), so a retained generation's run with the same key need not be read (retainedGenerationBlocks).
   */
  runKeys?: Set<string>;
}

/** bodyBlocks ended before a segment read because `stop` said so; nothing after the blocks already yielded was read. */
export class BodyReadStopped extends Error {
  constructor(readonly slug: string) {
    super(`Reading page ${slug} stopped: the caller's budget ran out.`);
    this.name = 'BodyReadStopped';
  }
}

/**
 * Whether the segment after a forced cut starts a block: the cut fell after a `\n` (not inside a line longer than a
 * segment, not after a bare `\r`) and a structural cut before the segment's first line would have been allowed
 * (`cutBlocked` on its stored entry state, the parser state at the cut). Pages of another segmenter version never do.
 */
function freshAfterForcedCut(previous: Uint8Array, seg: Pick<CutSegment, 'raw' | 'entryState'>, stale: boolean): boolean {
  if (stale || previous[previous.length - 1] !== 0x0a) return false;
  const entry = readEntryState(seg.entryState);
  if (!entry) return false;
  let end = 0;
  while (end < seg.raw.length && seg.raw[end] !== 0x0a && seg.raw[end] !== 0x0d) end++;
  segmentedPassWork.lines += end;
  return !cutBlocked(entry, utf8.decode(seg.raw.subarray(0, end)));
}

/** One stored segment as the block cutter reads it: where it sits, its stored bytes and entry state, and its text in pieces. */
interface CutSegment {
  byteStart: number;
  byteLen: number;
  raw: Uint8Array;
  entryState: unknown;
  texts: readonly string[];
}

/**
 * The texts of one run of segments joined by forced cuts (`segments` in order, the first at stored byte `start`): a
 * block ends at each forced cut freshAfterForcedCut allows, and one longer than BLOCK_MAX_BYTES refuses with
 * `page_body_segmented`. Counts each block's bytes and units in segmentedPassWork.
 */
async function* runBlocks(segments: AsyncIterable<CutSegment>, start: number, page: { slug: string; sourceId: string }, stale: boolean,
  collect: (bytes: number) => void): AsyncIterable<string> {
  let parts: Buffer[] = [];
  let previous: Uint8Array | null = null;
  let end = start;
  const flush = (to: number): string => {
    const text = Buffer.concat(parts).toString('utf8');
    collect(to - start);
    segmentedPassWork.bytes += to - start;
    segmentedPassWork.blocks += text.length;
    parts = [];
    start = to;
    return text;
  };
  for await (const seg of segments) {
    bodyRowWork.visits++;
    if (previous && freshAfterForcedCut(previous, seg, stale)) yield flush(seg.byteStart);
    end = seg.byteStart + seg.byteLen;
    if (end - start > BLOCK_MAX_BYTES) throw blockTooLargeError(page.slug, page.sourceId, end - start);
    for (const text of seg.texts) parts.push(Buffer.from(text, 'utf8'));
    previous = seg.raw;
  }
  yield flush(end);
}

const toJson = (v: unknown) => typeof v === 'string' ? JSON.parse(v) as unknown : v;

/**
 * The identity of a run's stored text and of every cut the block cutter can make in it: its region, whether its page is
 * of another segmenter version, and each segment's SHA-256 and entry state. Two runs with one key yield the same blocks.
 */
function runKey(region: BodyRegion, stale: boolean, segments: ReadonlyArray<{ sha256: Uint8Array; entryState: unknown }>): string {
  return JSON.stringify([region, stale, segments.map(seg => [Buffer.from(seg.sha256).toString('hex'), toJson(seg.entryState)])]);
}

export async function* bodyBlocks(engine: BrainEngine, page: { id: number; slug: string; source_id?: string },
  opts: BodyBlockOptions = {}): AsyncIterable<BodyBlock> {
  const body = await openSegmentedBody(engine, { pageId: Number(page.id) });
  const forced = new Set((await engine.executeRaw<{ seq: number }>(`SELECT seq FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL
      AND gen_from<=$2 AND (gen_to IS NULL OR gen_to>$2) AND cut_kind='forced'`, [body.pageId, body.generation])).map(row => Number(row.seq)));
  const collect = readGarbageCollector();
  const runKeys = opts.runKeys && !ledgerApplies(body.ledger) ? opts.runKeys : undefined;
  let at = 0;
  for (const [n, region] of (opts.regions ?? ['truth', 'timeline'] as const).entries()) {
    if (n > 0) {
      const separator = opts.separator ?? '\n';
      yield { region: null, text: separator, at };
      at += separator.length;
    }
    bodyRowWork.visits += body.rows.length;
    const rows = body.rows.filter(row => row.region === region);
    for (let i = 0; i < rows.length;) {
      let j = i;
      while (j + 1 < rows.length && forced.has(rows[j]!.seq)) j++;
      bodyRowWork.visits += j - i + 1;
      const run = rows.slice(i, j + 1);
      i = j + 1;
      if (opts.want && !opts.want({ seqs: run.map(row => row.seq), first: run[0] === rows[0] })) {
        at = NaN;
        continue;
      }
      const stop = opts.stop;
      const read: Array<{ sha256: Uint8Array; entryState: unknown }> = [];
      const segments = async function* (): AsyncIterable<CutSegment> {
        for await (const seg of trustedSegments(engine, body, run, stop && (() => { if (stop()) throw new BodyReadStopped(page.slug); }))) {
          bodyRowWork.visits++;
          read.push({ sha256: seg.row.sha256, entryState: seg.entryState });
          yield { byteStart: seg.row.byteStart, byteLen: seg.row.byteLen, raw: seg.raw, entryState: seg.entryState, texts: seg.pieces.map(piece => piece.text) };
        }
      };
      for await (const text of runBlocks(segments(), run[0]!.byteStart, { slug: page.slug, sourceId: body.sourceId }, body.stale, collect)) {
        const block = { region, text, at };
        at += text.length;
        yield block;
      }
      runKeys?.add(runKey(region, body.stale, read));
    }
  }
}

/**
 * @internal Retained-generation reads, for the bounded-work test: bytes of the runs a retained generation read
 * (`bytes`) and of the runs it skipped because a run with the same key was already read (`skipped`). Counts, not time.
 */
export const retainedGenerationWork = { bytes: 0, skipped: 0 };

/**
 * The stored text of a retained segmented generation (a segmented page_versions row references a generation; its body
 * columns are NULL) as `${compiled_truth}\n${timeline}`, cut into blocks as bodyBlocks cuts the live body (runBlocks),
 * from the generation's manifest rows, so a page demoted inline since still yields its segmented versions. Rows that do
 * not tile the version's body_bytes refuse with page_body_rows_unreadable (body-tiling.ts) before any text is read. A run whose
 * key is in `seen` (a run of the live body read without an overlay, or of a generation read before) is skipped, and
 * each run read is added to it. `stop` is asked before each segment read, as in bodyBlocks.
 */
export async function* retainedGenerationBlocks(engine: Pick<BrainEngine, 'executeRaw' | 'readManifest' | 'readSegmentTexts'>,
  page: { id: number; slug: string; sourceId: string }, generation: number,
  opts: { seen?: Set<string>; stop?: () => boolean } = {}): AsyncIterable<string> {
  const rows = await engine.readManifest(page.id, { generation });
  await assertGenerationTiles(engine, page.id, generation, rows);
  const [state] = await engine.executeRaw<{ segmenter_version: number | null }>('SELECT segmenter_version FROM pages WHERE id=$1', [page.id]);
  const stale = Number(state?.segmenter_version) !== SEGMENTER_VERSION;
  const collect = readGarbageCollector();
  for (const [n, region] of (['truth', 'timeline'] as const).entries()) {
    if (n > 0) yield '\n';
    const own = rows.filter(row => row.region === region);
    for (let i = 0; i < own.length;) {
      let j = i;
      while (j + 1 < own.length && own[j]!.cutKind === 'forced') j++;
      const run = own.slice(i, j + 1);
      i = j + 1;
      const bytes = run.reduce((sum, row) => sum + row.byteLen, 0);
      const key = runKey(region, stale, run);
      if (opts.seen?.has(key)) {
        retainedGenerationWork.skipped += bytes;
        continue;
      }
      opts.seen?.add(key);
      retainedGenerationWork.bytes += bytes;
      const segments = async function* (): AsyncIterable<CutSegment> {
        for (const row of run) {
          if (opts.stop?.()) throw new BodyReadStopped(page.slug);
          const hex = Buffer.from(row.sha256).toString('hex');
          const raw = (await engine.readSegmentTexts(page.sourceId, [row.sha256])).get(hex);
          if (raw === undefined) throw new Error(`Segment text of page ${page.id} generation ${generation} is missing.`);
          yield { byteStart: row.byteStart, byteLen: row.byteLen, raw, entryState: toJson(row.entryState), texts: [utf8.decode(raw)] };
        }
      };
      yield* runBlocks(segments(), run[0]!.byteStart, page, stale, collect);
    }
  }
}

/**
 * The first `chars` UTF-16 units of a segmented page's trusted compiled truth, reading at most 4 x `chars` + 4 bytes;
 * with `pin`, at the revision a caller authorized (openSegmentedBody) or not at all.
 */
export async function truthLead(engine: BrainEngine, pageId: number, chars: number, pin?: BodyPin): Promise<string> {
  const parts: Buffer[] = [];
  const body = await openSegmentedBody(engine, { pageId, ...(pin ? { pin } : {}) });
  for await (const piece of readBodyRange(engine, { pageId, space: 'stored', start: 0, end: 4 * chars + 4, audience: 'trusted', region: 'truth', body })) parts.push(piece.bytes);
  await confirmBodyPin(engine, body);
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(parts)).slice(0, chars);
}

/**
 * A copy of `value` whose strings share nothing with a block's text: a substring (slice, regex match) keeps its whole
 * parent alive (segmenter.ts `detached`), so a result a pass keeps past its block (a link candidate's context, a
 * timeline entry) would pin that block, and a page's results would pin the page. Plain objects and arrays are copied.
 */
export function detachedValue<T>(value: T): T {
  if (typeof value === 'string') return Buffer.from(value, 'utf8').toString('utf8') as T;
  if (Array.isArray(value)) return value.map(detachedValue) as T;
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) copy[key] = detachedValue(field);
  return copy as T;
}
