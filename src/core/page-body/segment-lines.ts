/**
 * Segmented page storage (Wave B, PR 2 full-pass mode): line-oriented scans of
 * a segmented page's trusted body for the maintenance commands (integrity,
 * reconcile-links, connector-fences), block by block over `bodyBlocks`, never
 * the whole body as one string.
 *
 * A block can end inside a line (a forced cut joined into the block ends where
 * the next segment starts, and a region ends without a newline), so the part
 * of a line after a block's last newline is carried into the next block
 * (`segmentedPassWork.carry` counts the carried units). A line-local parser fed
 * these lines in order sees exactly the lines of the joined text.
 */
import type { BrainEngine } from '../engine.ts';
import { bodyBlocks, segmentedPassWork, type BodyBlockOptions } from './segment-blocks.ts';

/**
 * The lines of the joined text (`${compiled_truth}\n${timeline}`, or the regions
 * and separator `opts` names), a block's worth at a time: joining every yielded
 * array with '\n', and the arrays with '\n', gives the joined text.
 */
export async function* bodyLines(engine: BrainEngine, page: { id: number; slug: string; source_id?: string },
  opts: BodyBlockOptions = {}): AsyncIterable<string[]> {
  let carry = '';
  for await (const block of bodyBlocks(engine, page, opts)) {
    const lines = (carry + block.text).split('\n');
    carry = lines.pop()!;
    segmentedPassWork.carry += carry.length;
    if (lines.length) yield lines;
  }
  yield [carry];
}

/** Whether one region of a segmented page holds any of `needles` (case-sensitive, as SQL LIKE), a needle cut by a block boundary included. */
export async function segmentedRegionContains(engine: BrainEngine, page: { id: number; slug: string; source_id?: string },
  region: 'truth' | 'timeline', needles: readonly string[]): Promise<boolean> {
  const keep = Math.max(0, ...needles.map(n => n.length - 1));
  let carry = '';
  for await (const block of bodyBlocks(engine, page, { regions: [region] })) {
    const text = carry + block.text;
    if (needles.some(needle => text.includes(needle))) return true;
    carry = keep ? text.slice(-keep) : '';
    segmentedPassWork.carry += carry.length;
  }
  return false;
}
