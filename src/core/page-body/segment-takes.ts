/**
 * Segmented page storage (Wave B, spec 8.2 fences, PR 2 full-pass mode):
 * parseTakesFence over a body read block by block (segment-blocks.ts).
 *
 * parseTakesFence reads only the first begin marker outside code, the first
 * end marker outside code after it, and the text between them (or, with no
 * begin, whether an end or a near-miss marker exists). A block starts outside
 * code, so each marker is located in its block; only the fence itself is
 * kept, joined across blocks up to BLOCK_MAX_BYTES, and parsed. The raw
 * marker scans the callers gate on (`includes`) are reported alongside.
 */
import { indexOfOutsideCode } from '../fence-scan.ts';
import { parseTakesFence, TAKES_FENCE_BEGIN, TAKES_FENCE_END, type ParseResult } from '../takes-fence.ts';
import { BLOCK_MAX_BYTES, blockTooLargeError, segmentedPassWork, type BodyBlock } from './segment-blocks.ts';
import { keyDigest } from './segment-derive.ts';

export interface StreamedTakes {
  parsed: ParseResult;
  /** The body contains TAKES_FENCE_BEGIN anywhere (in code too). */
  hasBegin: boolean;
  /** The body contains `gbrain:takes:` anywhere. */
  hasMarker: boolean;
}

/** parseTakesFenceBlocks as a push scan: feed one region's blocks in order (`at` from the region start), then `result`. */
export class TakesFenceScan {
  private fence: string[] | null = null;
  private fenceChars = 0;
  private endOnly = false;
  private nearMiss = false;
  private hasBegin = false;
  private hasMarker = false;
  private done: StreamedTakes | null = null;

  constructor(private readonly page: { slug: string; source_id: string }) {}

  push({ text, at }: Pick<BodyBlock, 'text' | 'at'>): void {
    if (this.done) return;
    this.hasBegin ||= text.includes(TAKES_FENCE_BEGIN);
    this.hasMarker ||= text.includes('gbrain:takes:');
    if (!this.hasMarker) return;
    let from = 0;
    let search = 0;
    if (!this.fence) {
      const begin = indexOfOutsideCode(text, TAKES_FENCE_BEGIN);
      if (begin === -1) {
        // parseTakesFence's end search with no begin starts at TAKES_FENCE_BEGIN.length - 1.
        this.endOnly ||= indexOfOutsideCode(text, TAKES_FENCE_END, Math.max(0, TAKES_FENCE_BEGIN.length - 1 - at)) !== -1;
        this.nearMiss ||= indexOfOutsideCode(text, 'gbrain:takes:begin') !== -1;
        return;
      }
      this.fence = [];
      from = begin;
      search = begin + TAKES_FENCE_BEGIN.length;
    }
    const end = indexOfOutsideCode(text, TAKES_FENCE_END, search);
    const piece = text.slice(from, end === -1 ? text.length : end + TAKES_FENCE_END.length);
    this.fenceChars += piece.length;
    segmentedPassWork.carry += piece.length;
    if (this.fenceChars > BLOCK_MAX_BYTES) throw blockTooLargeError(this.page.slug, this.page.source_id, this.fenceChars);
    this.fence.push(piece);
    if (end !== -1) this.done = { parsed: parseTakesFence(this.fence.join('')), hasBegin: this.hasBegin, hasMarker: this.hasMarker };
  }

  /** The scan is complete: later blocks cannot change the result. */
  get finished(): boolean {
    return this.done !== null;
  }

  result(): StreamedTakes {
    if (this.done) return this.done;
    return { parsed: parseTakesFence(reducedTakes(this.fence !== null, this.endOnly, this.nearMiss)), hasBegin: this.hasBegin, hasMarker: this.hasMarker };
  }

  /** What the blocks pushed so far hold, for a run's fences row (segment-facts.ts segmentedFenceRuns). */
  summary(): TakesRunSummary {
    const text = this.fence?.join('');
    return { hasBegin: this.hasBegin, hasMarker: this.hasMarker, endOnly: this.endOnly, nearMiss: this.nearMiss,
      fence: text === undefined ? null : { sha: keyDigest(text), closed: this.done !== null, text } };
  }
}

/** The text parseTakesFence reduces an unfinished scan to: a lone begin, an end only, a near-miss marker, or nothing. */
function reducedTakes(begun: boolean, endOnly: boolean, nearMiss: boolean): string {
  return begun ? TAKES_FENCE_BEGIN : endOnly ? `${'\n'.repeat(TAKES_FENCE_BEGIN.length)}${TAKES_FENCE_END}` : nearMiss ? 'gbrain:takes:begin' : '';
}

/**
 * One run's TakesFenceScan state (a scan started fresh at the run, its blocks pushed with region offsets): the raw marker
 * flags up to the block that closed its first fence, the end-only and near-miss scans before any begin, and that fence:
 * its digest and whether it closed. Its `text` is held in memory only (a run just scanned, or read again for it) and
 * never stored on the fences row.
 */
export interface TakesRunSummary { hasBegin: boolean; hasMarker: boolean; endOnly: boolean; nearMiss: boolean; fence: { sha: string; closed: boolean; text?: string } | null }

/**
 * parseTakesFenceBlocks of a region from its runs' summaries, in order; null when a fence a run begins does not close
 * in that run, or its text was not read (the caller reads the region whole).
 */
export function takesFromRuns(summaries: readonly TakesRunSummary[]): StreamedTakes | null {
  let hasBegin = false, hasMarker = false, endOnly = false, nearMiss = false;
  for (const summary of summaries) {
    hasBegin ||= summary.hasBegin;
    hasMarker ||= summary.hasMarker;
    if (summary.fence) return summary.fence.closed && summary.fence.text !== undefined ? { parsed: parseTakesFence(summary.fence.text), hasBegin, hasMarker } : null;
    endOnly ||= summary.endOnly;
    nearMiss ||= summary.nearMiss;
  }
  return { parsed: parseTakesFence(reducedTakes(false, endOnly, nearMiss)), hasBegin, hasMarker };
}

export async function parseTakesFenceBlocks(blocks: AsyncIterable<BodyBlock>, page: { slug: string; source_id: string }): Promise<StreamedTakes> {
  const scan = new TakesFenceScan(page);
  for await (const block of blocks) {
    scan.push(block);
    if (scan.finished) break;
  }
  return scan.result();
}
