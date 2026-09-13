import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, renderFactsTable } from './facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from './takes-fence.ts';
import { sanitizeText } from './batch-rows.ts';

const protectedMarkerPattern = new RegExp(
  [FACTS_FENCE_BEGIN, FACTS_FENCE_END, TAKES_FENCE_BEGIN, TAKES_FENCE_END]
    .map(marker => marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'g',
);

/** Strict protected-body boundary shared by remote reads and chunk creation. */
export function sanitizeRemoteBody(body: string): string {
  if (typeof body !== 'string') return '';
  // Parse the same free-text bytes storage accepts. Removing NUL after fence
  // detection could turn an unrecognized marker into a protected stored fence.
  body = sanitizeText(body);
  let cursor = 0;
  const output: string[] = [];
  let open: { start: number; endMarker: string; facts: boolean } | undefined;
  // Each token is visited once. Looking for every marker from each block's
  // cursor would repeatedly scan the remaining body when a marker is absent.
  for (const token of body.matchAll(protectedMarkerPattern)) {
    const marker = token[0];
    if (!open) {
      const facts = marker === FACTS_FENCE_BEGIN;
      if (!facts && marker !== TAKES_FENCE_BEGIN) continue;
      output.push(body.slice(cursor, token.index));
      open = { start: token.index, endMarker: facts ? FACTS_FENCE_END : TAKES_FENCE_END, facts };
      continue;
    }
    // Another begin or the wrong end makes the protected tail ambiguous.
    if (marker !== open.endMarker) return output.join('');
    cursor = token.index + marker.length;
    if (open.facts) {
      try {
        const parsed = parseFactsFence(body.slice(open.start, cursor));
        if (parsed.warnings.length === 0) output.push(renderFactsTable(parsed.facts.filter(row => row.visibility === 'world')));
      } catch {
        // A protected block that cannot be parsed is omitted, never echoed.
      }
    }
    open = undefined;
  }
  if (!open) output.push(body.slice(cursor));
  return output.join('');
}
