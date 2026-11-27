/**
 * Purge mode of the import overlay: fence rows whose claim matches a purge
 * tombstone (fact_purges, take_purges) are dropped from incoming Markdown,
 * not struck, before hashing, chunking and projection. A stale file, a
 * re-sync or a revert to an older body therefore cannot bring a purged claim
 * back into canonical text, chunks, facts or takes. Malformed fences are left
 * for the withdrawal path's diagnostics (it refuses a purged claim inside one).
 */

import type { BrainEngine } from '../engine.ts';
import { renderFactsTable } from '../facts-fence.ts';
import { locateOutsideCode } from '../fence-scan.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence, renderTakesFence } from '../takes-fence.ts';
import { withdrawalFenceBlocks } from './withdrawal-overlay.ts';

/** True when the source has any fact or take purge tombstone (one indexed probe). */
function sourceHasPurges(engine: BrainEngine, sourceId: string): Promise<{ facts: boolean; takes: boolean }> {
  return engine.readSourcePurgeFlags(sourceId);
}

type FenceFactRow = { rowNum: number; claim: string; visibility: string };

/**
 * The fence rows a fact tombstone names: same visibility and fingerprint, subject '*' or `subject` (without a subject,
 * any subject's tombstone applies). One statement on an engine with raw SQL; an engine without it (Rust) answers a
 * page's rows with one typed `isFactPurged` probe each, the same predicate with the subject bound, from its fact purge
 * ledger. The Rust engine has no subjectless caller to serve, so that case keeps the statement.
 */
async function purgedFenceRows(engine: BrainEngine, sourceId: string, facts: readonly FenceFactRow[], subject: string | undefined): Promise<Set<number>> {
  if (subject !== undefined && engine.capabilities?.has('raw_sql') === false) {
    const drop = new Set<number>();
    for (const f of facts) if (await engine.isFactPurged(sourceId, f.visibility, f.claim, subject)) drop.add(f.rowNum);
    return drop;
  }
  const rows = await engine.executeRaw<{ row_num: number }>(`WITH incoming AS MATERIALIZED (
      SELECT i.row_num, i.visibility, gbrain_fact_fingerprint(i.claim) AS fp, gbrain_fact_fingerprint_v2(i.claim) AS fp_v2
      FROM jsonb_to_recordset($2::text::jsonb) AS i(row_num integer, claim text, visibility text))
    SELECT DISTINCT incoming.row_num FROM incoming JOIN fact_purges p ON p.source_id=$1
      AND p.visibility=incoming.visibility AND p.fact_hash IN (incoming.fp, incoming.fp_v2)
      AND ($3::text IS NULL OR p.subject='*' OR p.subject=$3::text)`,
  [sourceId, JSON.stringify(facts.map(f => ({ row_num: f.rowNum, claim: f.claim, visibility: f.visibility }))), subject ?? null]);
  return new Set(rows.map(r => Number(r.row_num)));
}

/** Drop every fence row naming a purged claim. `subject` is the page slug; without it every subject's tombstone applies. */
export async function dropPurgedFenceRows(engine: BrainEngine, sourceId: string, body: string, subject?: string): Promise<string> {
  const hasFacts = body.includes('gbrain:facts:begin'), hasTakes = body.includes(TAKES_FENCE_BEGIN);
  if (!hasFacts && !hasTakes) return body;
  const purges = await sourceHasPurges(engine, sourceId);
  if (hasFacts && purges.facts) {
    for (const block of withdrawalFenceBlocks(body).reverse()) {
      if (block.parsed.warnings.length || !block.parsed.facts.length) continue;
      const drop = await purgedFenceRows(engine, sourceId, block.parsed.facts, subject);
      if (!drop.size) continue;
      body = body.slice(0, block.start) + renderFactsTable(block.parsed.facts.filter(f => !drop.has(f.rowNum))) + body.slice(block.end);
    }
  }
  if (hasTakes && purges.takes) {
    const parsed = parseTakesFence(body);
    if (parsed.warnings.length || !parsed.takes.length) return body;
    const rows = await engine.listPurgedTakeRows(sourceId, parsed.takes.map(t => ({ row_num: t.rowNum, claim: t.claim })), subject ?? null);
    if (!rows.length) return body;
    const drop = new Set(rows);
    const { beginIdx, endIdx } = locateOutsideCode(body, TAKES_FENCE_BEGIN, TAKES_FENCE_END);
    if (beginIdx === -1 || endIdx === -1) return body;
    body = body.slice(0, beginIdx) + renderTakesFence(parsed.takes.filter(t => !drop.has(t.rowNum)), [...parsed.reservedRowNums, ...drop]) + body.slice(endIdx + TAKES_FENCE_END.length);
  }
  return body;
}

/** Pure: drop fact fence rows by row number in every complete fence block (used by purge on stored bodies). */
export function dropFactFenceRowsByNumber(body: string, keep: (row: { rowNum: number; claim: string; visibility: string }) => boolean): string {
  if (!body.includes('gbrain:facts:begin')) return body;
  for (const block of withdrawalFenceBlocks(body).reverse()) {
    if (block.parsed.warnings.length) continue;
    const kept = block.parsed.facts.filter(f => keep({ rowNum: f.rowNum, claim: f.claim, visibility: f.visibility }));
    if (kept.length !== block.parsed.facts.length) body = body.slice(0, block.start) + renderFactsTable(kept) + body.slice(block.end);
  }
  return body;
}
