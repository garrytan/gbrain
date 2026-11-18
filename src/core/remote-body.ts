import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFenceFor, renderFactsTable } from './facts-fence.ts';
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
 * GST-3058: `owner` is the brain owner's own read: every region as stored, except takes regions when the owner's
 * credential names a holders list (`keepTakes` false), which are dropped as for any remote reader so a page it reads
 * still round-trips through put_page (preserveProtectedTakes re-appends the stored fence).
 * #5567 materialized-timeline marker lines are dropped unless the caller
 * round-trips the body (`keepMaterializedMarkers`).
 */
export function sanitizeRemoteBody(body: string, opts: { includeWithdrawn?: boolean; keepMaterializedMarkers?: boolean; omitRows?: ReadonlySet<number>; owner?: { keepTakes: boolean } } = {}): string {
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
    const text = body.slice(region.start, region.end);
    if (opts.owner) { if (region.pair === 0 || opts.owner.keepTakes) output.push(text); }
    else if (region.pair === 0) output.push(renderFactsRegion(text, opts.includeWithdrawn, opts.omitRows));
  }
  output.push(truncatedAt === -1 ? body.slice(cursor) : body.slice(cursor, truncatedAt));
  return output.join('');
}

/** What sanitizeRemoteBody puts in place of one protected facts region: its world rows rendered (less `omitRows`), or nothing. */
export function renderFactsRegion(region: string, includeWithdrawn = false, omitRows?: ReadonlySet<number>): string {
  try {
    const parsed = parseFactsFenceFor(region, { reader: true });
    if (parsed.warnings.length === 0) return renderFactsTable(parsed.facts.filter(row => row.visibility === 'world' && (includeWithdrawn || !row.forgotten) && !omitRows?.has(row.rowNum)));
  } catch {
    // A protected block that cannot be parsed is omitted, never echoed.
  }
  return '';
}
