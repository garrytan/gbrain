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
 * The incremental view (PR 4, `incrementalFactsFenceView`) keeps each run's
 * facts and takes scan on its `fences` row in page_segment_derivations, so a
 * reconcile reads only the runs that changed since; a fence that runs past the
 * run it begins in falls back to the view above.
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
  FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, timelineHasGenuineFactsFenceMarker, type FactsFenceParseResult, type FactsFenceView,
} from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN } from '../takes-fence.ts';
import { commitRuns, derivationScope, keyDigest, planRuns, readRuns, SegmentDerivationRaced, segmentDeriveWork, type DerivationScope, type DeriveRun } from './segment-derive.ts';
import { TakesFenceScan, type TakesRunSummary } from './segment-takes.ts';
import { BodyScanner } from './body-scan.ts';
import { readBodyRange } from './read-range.ts';
import { BLOCK_MAX_BYTES, blockTooLargeError, bodyBlocks, readGarbageCollector, segmentedPassWork, type BodyBlock } from './segment-blocks.ts';
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

/**
 * parseFactsFence, factsFenceSections and (timeline) timelineHasGenuineFactsFenceMarker of one region as a push scan:
 * feed the region's blocks in order (`first`: the block opens the region), then `result`.
 */
export class FactsFenceScan {
  private fence: string[] | null = null;
  private fenceChars = 0;
  private endOnly = false;
  private marker = false;
  private parsedText: string | null = null;

  constructor(private readonly page: FencePage, private readonly region: BodyRegion) {}

  /** A fence is open: the blocks after it are its text until it closes. */
  get open(): boolean {
    return this.fence !== null && this.parsedText === null;
  }

  /** The parse is decided: later blocks only feed the timeline marker scan. */
  get parsed(): boolean {
    return this.parsedText !== null;
  }

  push(text: string, first: boolean): void {
    if (this.region === 'timeline') this.marker ||= timelineHasGenuineFactsFenceMarker(text);
    if (this.parsedText !== null) return;
    let from = 0;
    let search = 0;
    if (!this.fence) {
      const begin = indexOfOutsideCode(text, FACTS_FENCE_BEGIN);
      if (begin === -1) {
        // locateOutsideCode's end search with no begin starts at FACTS_FENCE_BEGIN.length - 1; a block after the
        // region's first sits past that (a segment holds at least SEGMENT_MIN_BYTES).
        this.endOnly ||= indexOfOutsideCode(text, FACTS_FENCE_END, first ? FACTS_FENCE_BEGIN.length - 1 : 0) !== -1;
        return;
      }
      this.fence = [];
      from = begin;
      search = begin + FACTS_FENCE_BEGIN.length;
    }
    const end = indexOfOutsideCode(text, FACTS_FENCE_END, search);
    const piece = text.slice(from, end === -1 ? text.length : end + FACTS_FENCE_END.length);
    this.fenceChars += piece.length;
    segmentedPassWork.carry += piece.length;
    if (this.fenceChars > BLOCK_MAX_BYTES) throw blockTooLargeError(this.page.slug, this.page.source_id, this.fenceChars);
    this.fence.push(piece);
    if (end !== -1) this.parsedText = this.fence.join('');
  }

  result(): RegionFence {
    return regionFenceOf(this.parsedText, this.fence !== null, this.endOnly, this.marker);
  }

  /** What the blocks pushed so far hold, for a run's fences row. */
  summary(): FactsRunSummary {
    const text = this.fence?.join('');
    return { marker: this.marker, endOnly: this.endOnly, fence: text === undefined ? null : { sha: keyDigest(text), closed: this.parsedText !== null, text } };
  }
}

interface RegionFence { parsed: FactsFenceParseResult; holds: boolean; marker: boolean; text: string | null }

function regionFenceOf(parsedText: string | null, holds: boolean, endOnly: boolean, marker: boolean): RegionFence {
  const reduced = parsedText ?? (holds ? FACTS_FENCE_BEGIN : endOnly ? `${'\n'.repeat(FACTS_FENCE_BEGIN.length)}${FACTS_FENCE_END}` : '');
  return { parsed: parseFactsFence(reduced), holds, marker, text: parsedText };
}

/** One region of the facts fence view, streamed, reading only the runs that can hold a fence marker. */
async function regionFence(engine: BrainEngine, page: FencePage, region: BodyRegion, marked: ReadonlySet<number>): Promise<RegionFence> {
  const scan = new FactsFenceScan(page, region);
  const want = ({ seqs }: { seqs: readonly number[] }) => scan.open || ((!scan.parsed || region === 'timeline') && seqs.some(seq => marked.has(seq)));
  for await (const { text, at } of bodyBlocks(engine, page, { regions: [region], want })) scan.push(text, at === 0);
  return scan.result();
}

/** factsFenceView of a segmented page, reading only the runs that can hold a fence marker. */
export async function segmentedFactsFenceView(engine: BrainEngine, page: { id?: number; slug?: string; source_id?: string }): Promise<FactsFenceView> {
  return (await segmentedFactsFence(engine, page)).view;
}

/** segmentedFactsFenceView with each region's whole fence text (`blocks`, null where the region holds no closed fence). */
export async function segmentedFactsFence(engine: BrainEngine, page: { id?: number; slug?: string; source_id?: string }): Promise<{ view: FactsFenceView; blocks: { body: string | null; timeline: string | null } }> {
  const p = { id: Number(page.id), slug: page.slug ?? '', source_id: page.source_id ?? 'default' };
  const marked = await markerSeqs(engine, p.id);
  const truth = await regionFence(engine, p, 'truth', marked);
  const timeline = await regionFence(engine, p, 'timeline', marked);
  return { view: { body: truth.parsed, timeline: timeline.parsed, sections: { body: truth.holds, timeline: timeline.holds }, timelineMarker: timeline.marker },
    blocks: { body: truth.text, timeline: timeline.text } };
}

/**
 * One run's FactsFenceScan state (a scan started fresh at the run): the timeline marker, the end-only scan before any
 * begin, and its first fence: its digest and whether it closed. Its `text` is held in memory only (a run just scanned,
 * or read again for it) and never stored on the fences row.
 */
export interface FactsRunSummary { marker: boolean; endOnly: boolean; fence: { sha: string; closed: boolean; text?: string } | null }

/** What a run's fences row holds (spec 8.2 facts / takes fences): the facts and takes scans of its blocks, fence texts left out. */
export interface FenceRunOutput { facts: FactsRunSummary; takes: TakesRunSummary }

const withoutText = <F extends { fence: { sha: string; closed: boolean; text?: string } | null }>(summary: F): F =>
  ({ ...summary, fence: summary.fence && { sha: summary.fence.sha, closed: summary.fence.closed } });

/**
 * Each run of a segmented page with its fences row output, in page order (spec 8.2 facts / takes fences): runs whose
 * rows match their text are reused, the others are read block by block and stored. Null when the page is not
 * segmented. A fence parse is a function of the text alone (fence trust moves stored regions, not markers), so the
 * context is the run's identity, the ledger and the segmenter version the driver adds.
 */
export async function segmentedFenceRuns(engine: BrainEngine, page: FencePage): Promise<Array<{ run: DeriveRun; output: FenceRunOutput }> | null> {
  const scope = await derivationScope(engine, page);
  if (!scope) return null;
  const fences = await openFenceRuns(engine, page, scope);
  return fences.finish();
}

type FenceScans = Map<number, { facts: FactsFenceScan; takes: TakesFenceScan; at: number; seen: boolean }>;
const fenceScans = (page: FencePage, runs: readonly DeriveRun[]): FenceScans =>
  new Map(runs.map(run => [run.index, { facts: new FactsFenceScan(page, run.region), takes: new TakesFenceScan(page), at: 0, seen: false }]));
const scanOf = (scans: FenceScans) => [...scans].map(([index, scan]) => [index, { facts: scan.facts.summary(), takes: scan.takes.summary() }] as const);

/** Feed one block of a run to that run's scans, in order. */
const feed = (scans: FenceScans) => (run: DeriveRun | null, block: BodyBlock) => {
  const scan = run && scans.get(run.index);
  if (!scan) return;
  scan.seen = true;
  scan.facts.push(block.text, run.first && scan.at === 0);
  scan.takes.push({ text: block.text, at: run.first ? scan.at : Number.MAX_SAFE_INTEGER });
  scan.at += block.text.length;
};

/**
 * The fences rows of a scope, for a caller that reads some runs for another kind: `push` the blocks it reads (a due
 * run seen whole is scanned there), then `finish` reads only the due runs still unscanned and stores every scan. A
 * row keeps a fence's digest, not its text (spec 11): the run holding each region's first closed facts or takes fence
 * is read again for it when its row is current, and a text whose digest moved throws SegmentDerivationRaced.
 */
export async function openFenceRuns(engine: BrainEngine, page: FencePage, scope: DerivationScope) {
  const inputs = () => ({ facts: FACTS_FENCE_BEGIN, takes: TAKES_FENCE_BEGIN });
  const plan = await planRuns<FenceRunOutput>(engine, 'fences', scope, inputs);
  const scans = fenceScans(page, plan.todo);
  const push = feed(scans);
  return {
    /** Feed one block a caller read whole with its run's other blocks, in order. */
    push,
    async finish(): Promise<Array<{ run: DeriveRun; output: FenceRunOutput }>> {
      await readRuns(engine, scope, new Set([...scans].filter(([, scan]) => !scan.seen).map(([index]) => index)), push);
      const outputs = new Map<number, FenceRunOutput>(scanOf(scans));
      await commitRuns(engine, 'fences', scope, new Map([...outputs].map(([index, o]) => [index, { facts: withoutText(o.facts), takes: withoutText(o.takes) }])), inputs);
      const runs = scope.runs.map(run => ({ run, output: outputs.get(run.index) ?? plan.current.get(run.index)! }));
      const holders = new Set<number>();
      const unread = (fence: FactsRunSummary['fence']) => !!fence?.closed && fence.text === undefined;
      for (const region of ['truth', 'timeline'] as const) {
        const own = runs.filter(({ run }) => run.region === region);
        const facts = own.find(({ output }) => output.facts.fence), takes = own.find(({ output }) => output.takes.fence);
        if (facts && unread(facts.output.facts.fence)) holders.add(facts.run.index);
        if (takes && unread(takes.output.takes.fence)) holders.add(takes.run.index);
      }
      if (!holders.size) return runs;
      const again = fenceScans(page, scope.runs.filter(run => holders.has(run.index)));
      await readRuns(engine, scope, holders, feed(again));
      segmentDeriveWork.fences.reread += holders.size;
      const text = <F extends FactsRunSummary | TakesRunSummary>(stored: F, read: F): F => {
        if (!stored.fence || stored.fence.text !== undefined) return stored;
        if (read.fence?.sha !== stored.fence.sha) throw new SegmentDerivationRaced(page.slug);
        return { ...stored, fence: { ...stored.fence, text: read.fence.text } };
      };
      for (const [index, read] of scanOf(again)) {
        const at = runs[index]!;
        at.output = { facts: text(at.output.facts, read.facts), takes: text(at.output.takes, read.takes) };
      }
      return runs;
    },
  };
}

/** A region's facts fence from its runs' summaries, in order; null when a fence does not close in the run it begins in. */
export function factsFromRuns(summaries: readonly FactsRunSummary[]): RegionFence | null {
  let endOnly = false, marker = false, parsedText: string | null = null;
  for (const summary of summaries) {
    marker ||= summary.marker;
    if (parsedText !== null) continue;
    if (summary.fence) {
      if (!summary.fence.closed || summary.fence.text === undefined) return null;
      parsedText = summary.fence.text;
    } else endOnly ||= summary.endOnly;
  }
  return regionFenceOf(parsedText, parsedText !== null, endOnly, marker);
}

/**
 * factsFenceView of a segmented page from its fences rows (segmentedFenceRuns): only runs that changed since their row
 * was written are read. Falls back to segmentedFactsFenceView when a fence runs past the run it begins in or the body
 * moves during the read.
 */
export async function incrementalFactsFenceView(engine: BrainEngine, page: { id?: number; slug?: string; source_id?: string }): Promise<FactsFenceView> {
  return (await incrementalFactsFence(engine, page)).view;
}

/** incrementalFactsFenceView with each region's whole fence text, as segmentedFactsFence returns them. */
export async function incrementalFactsFence(engine: BrainEngine, page: { id?: number; slug?: string; source_id?: string }): Promise<{ view: FactsFenceView; blocks: { body: string | null; timeline: string | null } }> {
  const p = { id: Number(page.id), slug: page.slug ?? '', source_id: page.source_id ?? 'default' };
  const runs = await segmentedFenceRuns(engine, p).catch(error => {
    if (error instanceof SegmentDerivationRaced) return null;
    throw error;
  });
  const region = (name: BodyRegion) => runs && factsFromRuns(runs.filter(({ run }) => run.region === name).map(({ output }) => output.facts));
  const truth = region('truth');
  const timeline = region('timeline');
  if (!truth || !timeline) return segmentedFactsFence(engine, page);
  return { view: { body: truth.parsed, timeline: timeline.parsed, sections: { body: truth.holds, timeline: timeline.holds }, timelineMarker: timeline.marker },
    blocks: { body: truth.text, timeline: timeline.text } };
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
