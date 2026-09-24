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
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf(FACTS_FENCE_BEGIN, cursor);
    if (start < 0) break;
    const endMarker = body.indexOf(FACTS_FENCE_END, start + FACTS_FENCE_BEGIN.length);
    const nested = body.indexOf(FACTS_FENCE_BEGIN, start + FACTS_FENCE_BEGIN.length);
    if (endMarker < 0 || (nested >= 0 && nested < endMarker)) break;
    const end = endMarker + FACTS_FENCE_END.length;
    blocks.push({ start, end, parsed: parseFactsFence(body.slice(start, end)) });
    cursor = end;
  }
  return blocks;
}

/** A shortlisted claim inside an unparseable fence is conservatively page-affecting. */
export function hasAmbiguousWithdrawalFence(body: string): boolean {
  if (!body.includes(FACTS_FENCE_BEGIN)) return false;
  const blocks = withdrawalFenceBlocks(body);
  return blocks.length === 0 || blocks.some(block => block.parsed.warnings.length > 0);
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
