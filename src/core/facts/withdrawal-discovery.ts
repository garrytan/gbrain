import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { getCode } from '../retry-matcher.ts';
import { parseRowCells, isSeparatorRow, stripStrikethrough } from '../fence-shared.ts';
import { withdrawalFenceBlocks, ambiguousWithdrawalFenceSegments } from './withdrawal-overlay.ts';

export const WITHDRAWAL_LIMITS = { pages: 12_000, chunks: 40_000, facts: 40_000, bytes: 64 * 1024 * 1024, targets: 256, targetBytes: 1024 * 1024, scanMs: 10_000, batch: 128 } as const;
export interface WithdrawalTarget { slug: string; page_id: number; revision: string }
export interface WithdrawalClaim { visibility: string; fact_hash: string }

function refuse(code = 'withdrawal_capacity'): never {
  throw new OperationError(code, 'Withdrawal discovery could not prove a bounded complete target set. This attempt committed no withdrawal or page changes; earlier durable intent remains retained.',
    'Do not retry unchanged or split/delete the source. Keep mutation workers quiesced and inspect the source with the host operator; repair malformed fact fences before retrying. See docs/guides/concurrent-writes.md#withdrawal-recovery.');
}

export function ambiguousFenceClaims(body: string): Array<{ claim: string; visibility: string | null }> {
  const claims: Array<{ claim: string; visibility: string | null }> = [];
  for (const segment of ambiguousWithdrawalFenceSegments(body)) for (const line of segment.split('\n')) {
    const cells = parseRowCells(line);
    if (!cells || isSeparatorRow(cells) || cells[1]?.trim().toLowerCase() === 'claim') continue;
    const { text, struck } = stripStrikethrough((cells[1] ?? '').trim());
    if (!struck && text) claims.push({ claim: text, visibility: ['private', 'world'].includes(cells[4]?.toLowerCase()) ? cells[4].toLowerCase() : null });
  }
  return claims;
}

export async function discoverWithdrawalTargets(engine: BrainEngine, sourceId: string, claims: readonly WithdrawalClaim[]): Promise<WithdrawalTarget[]> {
  if (!claims.length) return [];
  if (claims.length > WITHDRAWAL_LIMITS.targets) refuse();
  const deadline = performance.now() + WITHDRAWAL_LIMITS.scanMs;
  const pageSizes = await engine.executeRaw<{ id: number; bytes: number }>(`SELECT id,octet_length(compiled_truth)+octet_length(timeline) AS bytes
    FROM pages WHERE source_id=$1 ORDER BY id LIMIT $2`, [sourceId, WITHDRAWAL_LIMITS.pages + 1]);
  const chunkSizes = await engine.executeRaw<{ id: number; bytes: number }>(`SELECT c.id,octet_length(c.chunk_text) AS bytes FROM content_chunks c
    JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 ORDER BY c.id LIMIT $2`, [sourceId, WITHDRAWAL_LIMITS.chunks + 1]);
  const factSizes = await engine.executeRaw<{ id: number; bytes: number }>(`SELECT id,octet_length(fact) AS bytes FROM facts
    WHERE source_id=$1 ORDER BY id LIMIT $2`, [sourceId, WITHDRAWAL_LIMITS.facts + 1]);
  if (pageSizes.length > WITHDRAWAL_LIMITS.pages || chunkSizes.length > WITHDRAWAL_LIMITS.chunks || factSizes.length > WITHDRAWAL_LIMITS.facts ||
    [...pageSizes, ...chunkSizes, ...factSizes].reduce((sum, row) => sum + Number(row.bytes), 0) > WITHDRAWAL_LIMITS.bytes) refuse();
  const affected = new Set<number>();
  const provenance = await engine.executeRaw<{ id: number }>(`SELECT DISTINCT p.id FROM facts f
    JOIN pages p ON p.source_id=f.source_id AND p.slug=COALESCE(f.source_markdown_slug,f.entity_slug)
    JOIN jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text)
      ON w.visibility=f.visibility AND w.fact_hash=gbrain_fact_fingerprint(f.fact) WHERE f.source_id=$1`, [sourceId, JSON.stringify(claims)]);
  for (const row of provenance) affected.add(row.id);
  if (affected.size > WITHDRAWAL_LIMITS.targets) refuse();
  const match = async (incoming: Array<{ id: number; claim: string; visibility: string | null; ambiguous: boolean }>) => {
    if (!incoming.length) return;
    if (incoming.length > 16_384 || Buffer.byteLength(JSON.stringify(incoming)) > 8 * 1024 * 1024) refuse();
    const matches = await engine.executeRaw<{ id: number; ambiguous: boolean }>(`SELECT DISTINCT i.id,i.ambiguous
      FROM jsonb_to_recordset($1::text::jsonb) i(id integer,claim text,visibility text,ambiguous boolean)
      JOIN jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text)
        ON (i.visibility IS NULL OR i.visibility=w.visibility) AND gbrain_fact_fingerprint(i.claim)=w.fact_hash`, [JSON.stringify(incoming), JSON.stringify(claims)]);
    if (matches.some(row => row.ambiguous)) refuse('withdrawal_provenance');
    for (const row of matches) affected.add(row.id);
    if (affected.size > WITHDRAWAL_LIMITS.targets) refuse();
  };
  for (let offset = 0; offset < pageSizes.length; offset += WITHDRAWAL_LIMITS.batch) {
    if (performance.now() > deadline) refuse();
    const pages = await engine.executeRaw<{ id: number; compiled_truth: string; timeline: string }>(
      'SELECT id,compiled_truth,timeline FROM pages WHERE source_id=$1 AND id=ANY($2::int[])', [sourceId, pageSizes.slice(offset, offset + WITHDRAWAL_LIMITS.batch).map(row => row.id)]);
    const incoming = pages.flatMap(page => [page.compiled_truth, page.timeline].flatMap(body => [
      ...withdrawalFenceBlocks(body).filter(block => !block.parsed.warnings.length).flatMap(block => block.parsed.facts.map(f => ({ id: page.id, claim: f.claim, visibility: f.visibility, ambiguous: false }))),
      ...ambiguousFenceClaims(body).map(f => ({ id: page.id, ...f, ambiguous: true })),
    ]));
    await match(incoming);
  }
  for (let offset = 0; offset < chunkSizes.length; offset += WITHDRAWAL_LIMITS.batch) {
    if (performance.now() > deadline) refuse();
    const chunks = await engine.executeRaw<{ page_id: number; chunk_text: string }>(
      'SELECT page_id,chunk_text FROM content_chunks WHERE id=ANY($1::int[])', [chunkSizes.slice(offset, offset + WITHDRAWAL_LIMITS.batch).map(row => row.id)]);
    await match(chunks.flatMap(chunk => {
      const rows = [{ id: chunk.page_id, claim: chunk.chunk_text, visibility: null as string | null, ambiguous: false }];
      for (const line of chunk.chunk_text.split('\n')) {
        const cells = parseRowCells(line.slice(Math.max(0, line.indexOf('|'))));
        if (!cells || isSeparatorRow(cells) || !cells[1]) continue;
        const { text, struck } = stripStrikethrough(cells[1]);
        if (!struck) rows.push({ id: chunk.page_id, claim: text, visibility: ['private', 'world'].includes(cells[4]) ? cells[4] : null, ambiguous: false });
      }
      return rows;
    }));
  }
  if (affected.size > WITHDRAWAL_LIMITS.targets) refuse();
  const targets = await engine.executeRaw<WithdrawalTarget>('SELECT slug,id AS page_id,knowledge_revision AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])', [sourceId, [...affected]]);
  if (performance.now() > deadline || Buffer.byteLength(JSON.stringify(targets)) > WITHDRAWAL_LIMITS.targetBytes) refuse();
  return targets.sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

export function withdrawalDiscoveryFailure(error: unknown): never {
  if (getCode(error) === '57014') refuse();
  throw error;
}
