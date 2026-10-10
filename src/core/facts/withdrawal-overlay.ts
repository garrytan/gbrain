import { createHash } from 'node:crypto';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence, renderFactsTable, type ParsedFact } from '../facts-fence.ts';
import type { PageWithdrawal } from '../page-state/types.ts';
import { OperationError } from '../ops/contract.ts';
import { normalizeLoweredClaim } from './withdrawal-schema.ts';

export const WITHDRAWAL_MARKER_LIMIT = 16_384;

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
  const markers = literalFenceMarkers(body);
  let open: { start: number } | undefined;
  for (const marker of markers) {
    if (marker.kind === 'begin') {
      if (marker.inlineCode) continue;
      open = { start: marker.start };
      continue;
    }
    if (!open) continue;
    blocks.push({ start: open.start, end: marker.end, parsed: parseFactsFence(body.slice(open.start, marker.end)) });
    open = undefined;
  }
  const inline: typeof blocks = [];
  let blockIndex = 0;
  for (const candidate of inlineCodeFenceBlocks(body, markers)) {
    while (blockIndex < blocks.length && blocks[blockIndex].end <= candidate.start) blockIndex++;
    if (!blocks[blockIndex] || candidate.end <= blocks[blockIndex].start) inline.push(candidate);
  }
  return [...blocks, ...inline].sort((a, b) => a.start - b.start);
}

interface FenceMarker { start: number; end: number; kind: 'begin' | 'end'; inlineCode: boolean }

function literalFenceMarkers(body: string): FenceMarker[] {
  const markers: FenceMarker[] = [];
  const tokens = new RegExp([FACTS_FENCE_BEGIN, FACTS_FENCE_END, '`'].join('|'), 'g');
  let offset = 0;
  for (const line of body.split('\n')) {
    let ticks = 0;
    const lastTick = line.lastIndexOf('`');
    for (const token of line.matchAll(tokens)) {
      if (token[0] === '`') { ticks++; continue; }
      if (markers.length >= WITHDRAWAL_MARKER_LIMIT) throw new OperationError('withdrawal_capacity',
        'The fact-fence marker limit was exceeded; incomplete withdrawal discovery is refused.',
        'Inspect and repair excessive malformed fact fences on the host before retrying. See docs/guides/concurrent-writes.md#withdrawal-recovery.');
      const start = offset + token.index;
      markers.push({ start, end: start + token[0].length, kind: token[0] === FACTS_FENCE_BEGIN ? 'begin' : 'end',
        inlineCode: ticks % 2 === 1 && lastTick >= token.index + token[0].length });
    }
    offset += line.length + 1;
  }
  return markers;
}

function inlineCodeFenceBlocks(body: string, markers: FenceMarker[]): Array<{ start: number; end: number; parsed: ReturnType<typeof parseFactsFence> }> {
  const blocks: Array<{ start: number; end: number; parsed: ReturnType<typeof parseFactsFence> }> = [];
  for (let i = 0; i < markers.length; i++) {
    const begin = markers[i], end = markers[i + 1];
    if (begin.kind !== 'begin' || end?.kind !== 'end' || !(begin.inlineCode || end.inlineCode)) continue;
    const parsed = parseFactsFence(body.slice(begin.start, end.end));
    if (parsed.facts.length || parsed.warnings.length) blocks.push({ start: begin.start, end: end.end, parsed });
  }
  return blocks;
}

/** Return only malformed live fence segments. */
export function ambiguousWithdrawalFenceSegments(body: string): string[] {
  const markers = literalFenceMarkers(body), segments: string[] = [], inlineBlocks = inlineCodeFenceBlocks(body, markers);
  const inlineEnds = new Set(inlineBlocks.map(block => block.end));
  let boundary = 0;
  let open: { start: number } | undefined;
  for (const marker of markers) {
    if (marker.kind === 'begin') {
      if (marker.inlineCode) continue;
      if (open) segments.push(body.slice(open.start, marker.start));
      open = { start: marker.start };
      continue;
    }
    if (!open) {
      if (inlineEnds.has(marker.end)) { boundary = marker.end; continue; }
      if (marker.inlineCode) continue;
      segments.push(body.slice(boundary, marker.end));
      boundary = marker.end;
      continue;
    }
    const segment = body.slice(open.start, marker.end);
    if (parseFactsFence(segment).warnings.length) segments.push(segment);
    boundary = marker.end;
    open = undefined;
  }
  if (open) segments.push(body.slice(open.start));
  for (const block of inlineBlocks) {
    if (block.parsed.warnings.length) segments.push(body.slice(block.start, block.end));
  }
  return segments;
}

/** A shortlisted claim inside an unparseable live fence is conservatively page-affecting. */
export function hasAmbiguousWithdrawalFence(body: string): boolean {
  return ambiguousWithdrawalFenceSegments(body).length > 0;
}

/** Both fingerprints `overlayWithdrawalBody` looks a fence row's claim up by: the normalized claim and the raw normalized-line claim. */
export function fenceClaimHashes(normalizedTexts: readonly string[]): string[] {
  const hashes = new Set<string>();
  for (const text of normalizedTexts) {
    if (!text.includes('gbrain:facts:begin')) continue;
    for (const block of withdrawalFenceBlocks(text)) {
      for (const f of block.parsed.facts) {
        hashes.add(createHash('sha256').update(normalizeLoweredClaim(f.claim)).digest('hex'));
        hashes.add(createHash('sha256').update(f.claim).digest('hex'));
      }
    }
  }
  return [...hashes];
}

/** Apply hashes from DB-normalized companion text to the original Markdown. */
export function overlayWithdrawalBody(body: string, normalizedBody: string, withdrawals: PageWithdrawal[]): string {
  if (!withdrawals.length || !body.includes('gbrain:facts:begin')) return body;
  const ledger = new Map<string, PageWithdrawal>();
  for (const w of withdrawals) {
    const key = `${w.visibility}:${w.fact_hash}`;
    if (!ledger.get(key)?.purged) ledger.set(key, w);
  }
  const blocks = withdrawalFenceBlocks(body), normalized = withdrawalFenceBlocks(normalizedBody);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i], norm = normalized[i];
    if (!norm || block.parsed.warnings.length || norm.parsed.warnings.length) continue;
    const claims = new Map(norm.parsed.facts.map(f => [f.rowNum, f.claim]));
    let changed = false;
    // A purge tombstone drops the row (the claim leaves the canonical text); a withdrawal strikes it.
    const facts = block.parsed.facts.flatMap(f => {
      const claim = claims.get(f.rowNum);
      if (claim === undefined) return [f];
      const entry = ledger.get(`${f.visibility}:${createHash('sha256').update(normalizeLoweredClaim(claim)).digest('hex')}`)
        ?? ledger.get(`${f.visibility}:${createHash('sha256').update(claim).digest('hex')}`);
      if (!entry) return [f];
      changed = true;
      return entry.purged ? [] : [withdrawnFact(f, new Date(entry.withdrawn_at).toISOString().slice(0, 10))];
    });
    if (changed) body = body.slice(0, block.start) + renderFactsTable(facts) + body.slice(block.end);
  }
  return body;
}
