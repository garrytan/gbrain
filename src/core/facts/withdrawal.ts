import type { BrainEngine } from '../engine.ts';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, type ParsedFact } from '../facts-fence.ts';

/** Commit intent before any best-effort filesystem mirror; never inferred from TTL. */
export async function recordFactWithdrawal(engine: BrainEngine, id: number, sourceId: string, worldOnly = false): Promise<void> {
  await engine.transaction(async tx => {
    // Same serialization point as the insert trigger; no disk IO under lock.
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    const rows = await tx.executeRaw<{ visibility: string; fact: string }>(
      `SELECT visibility,fact FROM facts WHERE id=$1 AND source_id=$2
        AND ($3::boolean=false OR visibility='world') FOR UPDATE`, [id, sourceId, worldOnly]);
    if (!rows.length) return;
    const row = rows[0];
    await tx.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash)
      VALUES ($1,$2,gbrain_fact_fingerprint($3)) ON CONFLICT DO NOTHING`, [sourceId,row.visibility,row.fact]);
    // Repeated instances of the same claim cannot remain active after recall
    // forgets one of them. Visibility and source stay exact authorization axes.
    await tx.executeRaw(`UPDATE facts SET expired_at=now(),valid_until=LEAST(COALESCE(valid_until,now()),now())
      WHERE source_id=$1 AND visibility=$2 AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($3)
        AND expired_at IS NULL`, [sourceId,row.visibility,row.fact]);
  });
}

async function withdrawalDates(engine: BrainEngine, sourceId: string, facts: readonly ParsedFact[]): Promise<Map<number,string>> {
  if (!facts.length) return new Map();
  const rows = await engine.executeRaw<{ row_num: number; withdrawn_at: string }>(
    `SELECT incoming.row_num, w.withdrawn_at::text FROM jsonb_to_recordset($2::text::jsonb)
      AS incoming(row_num integer,claim text,visibility text)
      JOIN fact_withdrawals w ON w.source_id=$1 AND w.visibility=incoming.visibility
        AND w.fact_hash=gbrain_fact_fingerprint(incoming.claim)`,
    [sourceId, JSON.stringify(facts.map(f => ({ row_num:f.rowNum, claim:f.claim, visibility:f.visibility })))],
  );
  return new Map(rows.map(r => [r.row_num, new Date(r.withdrawn_at).toISOString().slice(0,10)]));
}

/** Overlay stale source files before hashing/chunking, retaining an explicit retraction. */
export async function preserveWithdrawnFenceRows(engine: BrainEngine, sourceId: string, body: string): Promise<string> {
  if (!body.includes('gbrain:facts:begin')) return body;
  const parsed = parseFactsFence(body);
  // Preserve the existing malformed-fence diagnostics; re-rendering a
  // partial parse would delete unreadable rows. The database trigger still
  // protects derived facts if a later repair/reconcile sees their claims.
  if (parsed.warnings.length) return body;
  const dates = await withdrawalDates(engine, sourceId, parsed.facts.filter(f => f.active));
  if (!dates.size) return body;
  const facts = parsed.facts.map(f => {
    const date = dates.get(f.rowNum);
    return date ? { ...f, active:false, forgotten:true, validUntil:date,
      context: [f.context, 'forgotten: memory withdrawn'].filter(Boolean).join(' | ') } : f;
  });
  return replaceOrInsertFactsFence(body, renderFactsTable(facts));
}

/** Explicit remember is not an implicit restore operation. */
export async function isFactWithdrawn(engine: BrainEngine, sourceId: string, visibility: string, claim: string): Promise<boolean> {
  const rows = await engine.executeRaw(`SELECT 1 FROM fact_withdrawals
    WHERE source_id=$1 AND visibility=$2 AND fact_hash=gbrain_fact_fingerprint($3)`, [sourceId,visibility,claim]);
  return rows.length > 0;
}
