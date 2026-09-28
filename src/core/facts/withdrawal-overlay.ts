import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, type ParsedFact } from '../facts-fence.ts';
import { indexOfOutsideCode, scanMarkdownCode } from '../fence-scan.ts';

/** Preserve historical expiry and context while emitting the parser's explicit withdrawal marker. */
export function withdrawnFact(fact: ParsedFact, date: string, reason = 'memory withdrawn'): ParsedFact {
  const prior = fact.context?.trim();
  const context = /^forgotten\s*:/i.test(prior ?? '') ? prior : [`forgotten: ${reason}`, prior].filter(Boolean).join(' | ');
  const validUntil = fact.validUntil && /^\d{4}-\d{2}-\d{2}$/.test(fact.validUntil) && fact.validUntil < date
    ? fact.validUntil : date;
  return { ...fact, active: false, forgotten: true, validUntil, context };
}

/** Enumerate every complete legacy fence; leave ambiguous tails untouched for diagnostics. */
export function withdrawalFenceBlocks(body: string): Array<{ start: number; end: number; parsed: ReturnType<typeof parseFactsFence> }> {
  const blocks: Array<{ start: number; end: number; parsed: ReturnType<typeof parseFactsFence> }> = [];
  let cursor = 0;
  const code = body.includes(FACTS_FENCE_BEGIN) ? scanMarkdownCode(body) : undefined;
  while (cursor < body.length) {
    const start = indexOfOutsideCode(body, FACTS_FENCE_BEGIN, cursor, code);
    if (start < 0) break;
    const endMarker = indexOfOutsideCode(body, FACTS_FENCE_END, start + FACTS_FENCE_BEGIN.length, code);
    const nested = indexOfOutsideCode(body, FACTS_FENCE_BEGIN, start + FACTS_FENCE_BEGIN.length, code);
    if (endMarker < 0 || (nested >= 0 && nested < endMarker)) break;
    const end = endMarker + FACTS_FENCE_END.length;
    blocks.push({ start, end, parsed: parseFactsFence(body.slice(start, end)) });
    cursor = end;
  }
  return blocks;
}
