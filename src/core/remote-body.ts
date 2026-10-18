import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, renderFactsTable } from './facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from './takes-fence.ts';
import { sanitizeText } from './batch-rows.ts';
import { stripMaterializedMarkers } from './timeline-marker.ts';
import { protectedRegions, type FencePair } from './fence-scan.ts';

// Index 0 is the facts pair: its world rows are re-rendered, never dropped.
export const PROTECTED_PAIRS: readonly FencePair[] = [
  { begin: FACTS_FENCE_BEGIN, end: FACTS_FENCE_END },
  { begin: TAKES_FENCE_BEGIN, end: TAKES_FENCE_END },
];

/**
 * Strict protected-body boundary shared by remote reads and chunk creation.
 * #5567 materialized-timeline marker lines are dropped unless the caller
 * round-trips the body (`keepMaterializedMarkers`).
 */
export function sanitizeRemoteBody(body: string, opts: { includeWithdrawn?: boolean; keepMaterializedMarkers?: boolean } = {}): string {
  if (typeof body !== 'string') return '';
  // Parse the same free-text bytes storage accepts. Removing NUL after fence
  // detection could turn an unrecognized marker into a protected stored fence.
  body = sanitizeText(body);
  if (!opts.keepMaterializedMarkers) body = stripMaterializedMarkers(body);
  // Never hides less than the lexical marker scan; see protectedRegions.
  const { regions, truncatedAt } = protectedRegions(body, PROTECTED_PAIRS);
  const output: string[] = [];
  let cursor = 0;
  for (const region of regions) {
    output.push(body.slice(cursor, region.start));
    cursor = region.end;
    if (region.pair === 0) output.push(renderFactsRegion(body.slice(region.start, region.end), opts.includeWithdrawn));
  }
  output.push(truncatedAt === -1 ? body.slice(cursor) : body.slice(cursor, truncatedAt));
  return output.join('');
}

/** What sanitizeRemoteBody puts in place of one protected facts region: its world rows rendered, or nothing. */
export function renderFactsRegion(region: string, includeWithdrawn = false): string {
  try {
    const parsed = parseFactsFence(region);
    if (parsed.warnings.length === 0) return renderFactsTable(parsed.facts.filter(row => row.visibility === 'world' && (includeWithdrawn || !row.forgotten)));
  } catch {
    // A protected block that cannot be parsed is omitted, never echoed.
  }
  return '';
}
