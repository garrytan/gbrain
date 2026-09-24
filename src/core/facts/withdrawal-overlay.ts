import { createHash } from 'node:crypto';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, renderFactsTable, type ParsedFact } from '../facts-fence.ts';
import type { PageWithdrawal } from '../page-state/types.ts';

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
  let open: { start: number } | undefined;
  for (const marker of liveFenceMarkers(body)) {
    if (marker.kind === 'begin') {
      open = { start: marker.start };
      continue;
    }
    if (!open) continue;
    blocks.push({ start: open.start, end: marker.end, parsed: parseFactsFence(body.slice(open.start, marker.end)) });
    open = undefined;
  }
  return blocks;
}

/**
 * Markers as `parseFactsFence` sees them: anywhere on a line, including after
 * ordinary prefix text. Only a marker inside an inline code span on its line
 * is documentation, never a live fence.
 */
function liveFenceMarkers(body: string): Array<{ start: number; end: number; kind: 'begin' | 'end' }> {
  const markers: Array<{ start: number; end: number; kind: 'begin' | 'end' }> = [];
  for (const [marker, kind] of [[FACTS_FENCE_BEGIN, 'begin'], [FACTS_FENCE_END, 'end']] as const) {
    let cursor = 0;
    while (cursor < body.length) {
      const start = body.indexOf(marker, cursor);
      if (start < 0) break;
      if (!insideInlineCode(body, start, start + marker.length)) markers.push({ start, end: start + marker.length, kind });
      cursor = start + marker.length;
    }
  }
  return markers.sort((a, b) => a.start - b.start);
}

function insideInlineCode(body: string, start: number, end: number): boolean {
  const lineStart = body.lastIndexOf('\n', start - 1) + 1;
  const lineEndAt = body.indexOf('\n', end);
  const before = body.slice(lineStart, start), after = body.slice(end, lineEndAt < 0 ? body.length : lineEndAt);
  return (before.split('`').length - 1) % 2 === 1 && after.includes('`');
}

/** Return only malformed live fence segments; inline-code documentation is ordinary prose. */
export function ambiguousWithdrawalFenceSegments(body: string): string[] {
  const segments: string[] = [];
  let open: { start: number } | undefined;
  for (const marker of liveFenceMarkers(body)) {
    if (marker.kind === 'begin') {
      if (open) segments.push(body.slice(open.start, marker.start));
      open = { start: marker.start };
      continue;
    }
    if (!open) {
      segments.push(body.slice(marker.start, marker.end));
      continue;
    }
    const segment = body.slice(open.start, marker.end);
    if (parseFactsFence(segment).warnings.length) segments.push(segment);
    open = undefined;
  }
  if (open) segments.push(body.slice(open.start));
  return segments;
}

/** A shortlisted claim inside an unparseable live fence is conservatively page-affecting. */
export function hasAmbiguousWithdrawalFence(body: string): boolean {
  return ambiguousWithdrawalFenceSegments(body).length > 0;
}

/** Apply hashes from DB-normalized companion text to the original Markdown. */
export function overlayWithdrawalBody(body: string, normalizedBody: string, withdrawals: PageWithdrawal[]): string {
  if (!withdrawals.length || !body.includes('gbrain:facts:begin')) return body;
  const ledger = new Map(withdrawals.map(w => [`${w.visibility}:${w.fact_hash}`, w.withdrawn_at]));
  const blocks = withdrawalFenceBlocks(body), normalized = withdrawalFenceBlocks(normalizedBody);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i], norm = normalized[i];
    if (!norm || block.parsed.warnings.length || norm.parsed.warnings.length) continue;
    const claims = new Map(norm.parsed.facts.map(f => [f.rowNum, f.claim]));
    let changed = false;
    const facts = block.parsed.facts.map(f => {
      const claim = claims.get(f.rowNum);
      if (claim === undefined) return f;
      const at = ledger.get(`${f.visibility}:${createHash('sha256').update(claim).digest('hex')}`);
      if (!at) return f;
      changed = true;
      return withdrawnFact(f, new Date(at).toISOString().slice(0, 10));
    });
    if (changed) body = body.slice(0, block.start) + renderFactsTable(facts) + body.slice(block.end);
  }
  return body;
}
