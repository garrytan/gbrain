import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, renderFactsTable } from './facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from './takes-fence.ts';
import { sanitizeText } from './batch-rows.ts';
import { protectedRegions, type FencePair } from './fence-scan.ts';

// Index 0 is the facts pair: its world rows are re-rendered, never dropped.
const PROTECTED_PAIRS: readonly FencePair[] = [
  { begin: FACTS_FENCE_BEGIN, end: FACTS_FENCE_END },
  { begin: TAKES_FENCE_BEGIN, end: TAKES_FENCE_END },
];

/** Strict protected-body boundary shared by remote reads and chunk creation. */
export function sanitizeRemoteBody(body: string, opts: { includeWithdrawn?: boolean } = {}): string {
  if (typeof body !== 'string') return '';
  // Parse the same free-text bytes storage accepts. Removing NUL after fence
  // detection could turn an unrecognized marker into a protected stored fence.
  body = sanitizeText(body);
  // Marker text quoted in inline code is documentation, not a fence; see
  // protectedRegions for why code blocks are not.
  const { regions, truncatedAt } = protectedRegions(body, PROTECTED_PAIRS);
  const output: string[] = [];
  let cursor = 0;
  for (const region of regions) {
    output.push(body.slice(cursor, region.start));
    cursor = region.end;
    if (region.pair === 0) {
      try {
        const parsed = parseFactsFence(body.slice(region.start, region.end));
        if (parsed.warnings.length === 0) output.push(renderFactsTable(parsed.facts.filter(row => row.visibility === 'world' && (opts.includeWithdrawn || !row.forgotten))));
      } catch {
        // A protected block that cannot be parsed is omitted, never echoed.
      }
    }
  }
  output.push(truncatedAt === -1 ? body.slice(cursor) : body.slice(cursor, truncatedAt));
  return output.join('');
}
