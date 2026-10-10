/**
 * Trust on the canonical facts-fence re-projection (#5575 A5/I3, ENG-1),
 * called by persistence/canonical-projections.ts inside the page publication.
 *
 * A page publish re-projects its `## Facts` fence: rows that changed or
 * disappeared are expired and new rows inserted. Under the writer's declared
 * tier (the transaction's gbrain.write_trust_tier, `unknown` when undeclared):
 * - Guarded supersession: a row more trusted than the writer is never expired
 *   by it. The row is detached from its fence position and stays active; when
 *   the writer only renumbered it (same claim and visibility elsewhere in the
 *   fence, free slot) it moves there instead. Otherwise the new row at its old
 *   position is inserted contested with a `supersede_fact` proposal, or, when
 *   the writer removed it, a `forget` proposal asks the owner.
 * - Row gate (ENG-1): every new fence row is gated like other fact writers at
 *   the writer's tier; a held row is not inserted (the hold keeps it), a
 *   flagged row records its receipt after insert.
 */
import type { BrainEngine, NewFact } from '../engine.ts';
import { currentWriteTrust } from '../persistence/context.ts';
import type { WriteGateConfig } from '../write-gate.ts';
import { decideFactWrite, recordFlaggedRow, recordWriteGateHold, type GatedRowDecision } from '../write-gate-store.ts';
import { gateInput } from './gate-outcomes.ts';
import { insertTrustProposal } from './proposals.ts';
import { recordContestedFact } from './supersede-handlers.ts';
import { compareTrust, storedTrustTier, trustRankSql, type WriteTrust } from './tier.ts';

type FenceFact = NewFact & { row_num: number };
const WRITER_RANK = trustRankSql(`COALESCE(NULLIF(current_setting('gbrain.write_trust_tier', true), ''), 'unknown')`);

export interface FenceGuard<T extends FenceFact> {
  /** The fence rows to insert (held and rejected rows removed, moved rows removed). */
  rows: T[];
  /** After the caller's expiry and insert: proposals for contested rows (their tp refs), receipts for flagged rows. */
  finish(tx: BrainEngine): Promise<string[]>;
}

/**
 * Before the caller expires stale fence rows: detaches rows the writer may
 * not supersede. `expired()` runs the caller's expiry; then guarded renumbers
 * move and new rows are gated.
 */
export async function guardFenceRows<T extends FenceFact>(tx: BrainEngine, input: { sourceId: string; slug: string; incoming: string; rows: T[]; cfg: (db: BrainEngine) => Promise<WriteGateConfig> },
  expire: () => Promise<unknown>): Promise<FenceGuard<T>> {
  const { sourceId, slug, incoming } = input;
  const guarded = await tx.executeRaw<{ id: number; row_num: number; fact: string; visibility: string; trust_tier: string }>(
    `SELECT f.id, f.row_num, f.fact, f.visibility, f.trust_tier FROM facts f
      WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.row_num IS NOT NULL AND f.expired_at IS NULL
        AND (COALESCE(f.source, '') NOT LIKE 'cli:extract-conversation-facts%'
          OR EXISTS (SELECT 1 FROM jsonb_to_recordset($3::text::jsonb) AS c(row_num integer) WHERE c.row_num = f.row_num))
        AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset($3::text::jsonb) AS n(row_num integer, fact text, visibility text)
          WHERE n.row_num = f.row_num AND n.fact = f.fact AND n.visibility = f.visibility)
        AND ${trustRankSql('f.trust_tier')} > ${WRITER_RANK}
      ORDER BY f.row_num FOR UPDATE`, [sourceId, slug, incoming]);
  if (guarded.length) await tx.executeRaw('UPDATE facts SET row_num = NULL WHERE id = ANY($1::bigint[])', [guarded.map(g => Number(g.id))]);
  await expire();
  // A fence with no rows and nothing guarded has nothing to place or gate (#6007: no reads on a fence-free publish).
  if (!input.rows.length && !guarded.length) return { rows: [], async finish() { return []; } };
  const occupied = new Set((await tx.executeRaw<{ row_num: number }>(
    'SELECT row_num FROM facts WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL AND expired_at IS NULL', [sourceId, slug]))
    .map(r => Number(r.row_num)));
  let rows = input.rows;
  const contested: typeof guarded = [];
  for (const g of guarded) {
    const target = rows.find(r => r.fact === g.fact && r.visibility === g.visibility && !occupied.has(r.row_num));
    if (!target) { contested.push(g); continue; }
    await tx.executeRaw('UPDATE facts SET row_num = $2 WHERE id = $1', [Number(g.id), target.row_num]);
    occupied.add(target.row_num);
    rows = rows.filter(r => r !== target);
  }
  const gated: Array<{ row: T; decision: GatedRowDecision }> = [];
  const inserted: T[] = [];
  // Only new rows are gated; owner-tier writers (tool_observed and above) never are, so they read no gate config.
  let trust: WriteTrust | null = null;
  const writerTrust = async (db: BrainEngine) => trust ??= await currentWriteTrust(db) ?? { tier: 'unknown', origin: null };
  const cfg = rows.some(r => !occupied.has(r.row_num)) && compareTrust((await writerTrust(tx)).tier, 'tool_observed') < 0 ? await input.cfg(tx) : null;
  // Only a row this write inserts at a guarded row's old position replaces it; a moved row never does.
  const fresh = new Set(rows.filter(r => !occupied.has(r.row_num)).map(r => r.row_num));
  for (const row of rows) {
    if (!cfg || occupied.has(row.row_num)) { inserted.push(row); continue; }
    const decision = decideFactWrite({ fact: row.fact, context: row.context ?? null, source: row.source ?? null }, { sourceId, slug,
      payload: { fact: row.fact, kind: row.kind, visibility: row.visibility, entity_slug: row.entity_slug, source: row.source, context: row.context ?? null, row_num: row.row_num },
      input: gateInput(await writerTrust(tx), null), cfg });
    if (decision.action === 'hold') { await recordWriteGateHold(tx, decision.hold!); continue; }
    if (decision.action === 'reject') continue;
    inserted.push(row);
    if (decision.assessment.verdict === 'flag') gated.push({ row, decision });
  }
  return {
    rows: inserted,
    async finish(db) {
      const refs: string[] = [];
      const at = async (rowNum: number) => (await db.executeRaw<{ id: number; trust_tier: string }>(
        `SELECT id, trust_tier FROM facts WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num = $3 AND expired_at IS NULL`, [sourceId, slug, rowNum]))[0];
      for (const g of contested) {
        const replacement = fresh.has(Number(g.row_num)) ? await at(Number(g.row_num)) : undefined;
        if (replacement) {
          refs.push((await recordContestedFact(db, { sourceId, oldId: Number(g.id), oldTier: storedTrustTier(g.trust_tier), newId: Number(replacement.id),
            newTier: storedTrustTier(replacement.trust_tier), guard: 'fence_projection' })).proposal_ref);
        } else {
          const { id } = await insertTrustProposal(db, { action: 'forget', sourceId, target: { table: 'facts', id: Number(g.id) }, proposer: 'fence_projection',
            before: { guard: 'fence_projection', fact: { id: Number(g.id), tier: storedTrustTier(g.trust_tier) }, writer_tier: (await writerTrust(db)).tier, slug } });
          refs.push(`tp${id}`);
        }
      }
      for (const { row, decision } of gated) {
        const stored = await at(row.row_num);
        if (stored) await recordFlaggedRow(db, decision, { table: 'facts', id: Number(stored.id), sourceId });
      }
      return refs;
    },
  };
}
