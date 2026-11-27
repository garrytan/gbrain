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
 *   fence, free slot) it moves there instead, and when the writer only made it
 *   private (same claim, world to private, GST-2487) it moves there and turns
 *   private in place, keeping its id and tier. Otherwise the new row at its old
 *   position is inserted contested with a `supersede_fact` proposal, or, when
 *   the writer removed it, a `forget` proposal asks the owner. A new world row
 *   that replaces a guarded non-world row, or restates the claim of a more
 *   trusted non-world fact of the page at any row number, is inserted at that
 *   row's visibility and its proposal carries the widening, which only the
 *   owner's accept applies (GST-2511); until then later writes of the same
 *   fence keep that contested row narrower.
 * - Operator open (#8194): only inside `gbrain repair open-facts`
 *   (persistence/context.ts withOpenFacts), a named private row whose cell is
 *   now world at the same row number and claim is guarded at any tier and
 *   moves back in place as world, keeping its id and tier. Every other
 *   widening keeps the rules above.
 * - Row gate (ENG-1): every new fence row is gated like other fact writers at
 *   the writer's tier; a held row is not inserted (the hold keeps it), a
 *   flagged row records its receipt after insert.
 * - Held removals (W1 #6783 §12 (a)): the same rule for a page's takes and
 *   timeline rows. A row more trusted than the writer is never deleted,
 *   replaced or deactivated by it; it stays as it is and a `forget` proposal
 *   asks the owner, whose accept applies the page's text to that row
 *   (trust/held-removals.ts).
 */
import type { BrainEngine, NewFact } from '../engine.ts';
import { currentWriteTrust } from '../persistence/context.ts';
import type { HeldTable } from '../engine-sql/trust-fence.ts';
import type { WriteGateConfig } from '../write-gate.ts';
import { decideFactWrite, recordFlaggedRow, recordWriteGateHold, type GatedRowDecision } from '../write-gate-store.ts';
import { gateInput } from './gate-outcomes.ts';
import { insertTrustProposal } from './proposals.ts';
import { recordContestedFact } from './supersede-handlers.ts';
import { compareTrust, storedTrustTier, type TrustTier, type WriteTrust } from './tier.ts';

type FenceFact = NewFact & { row_num: number };

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
export async function guardFenceRows<T extends FenceFact>(tx: BrainEngine, input: { sourceId: string; slug: string; /** The page's permanent id, when the caller read it (a held row is bound to it). */ pageId?: number; incoming: string; rows: T[]; cfg: (db: BrainEngine) => Promise<WriteGateConfig>;
  /** #8819: rows the fence never held, which this write keeps as they are. */ kept?: readonly number[] },
  expire: () => Promise<unknown>): Promise<FenceGuard<T>> {
  const { sourceId, slug, incoming } = input;
  // #8194: a row `gbrain repair open-facts` opens (withOpenFacts: only private to world, same row number and claim) is guarded at
  // any tier, so it is detached before the expiry and moves back in place as world, keeping its id and tier.
  // GST-2511: a contested row a widening proposal stored narrower (pending, rejected or undone) is held at its visibility
  // while the fence still asks for world at its position. GST-2891: whatever the writer's tier: re-deriving the unchanged
  // row (a sync after an unrelated edit, a re-put) is not the owner's accept, which alone applies the widening.
  // The typed read (engine-sql/trust-fence.ts) returns those rows with the rows above the writer and the opened rows.
  const guarded = (await tx.listFenceFactRows({ sourceId, slug, incoming })).filter(row => !input.kept?.includes(Number(row.id)));
  if (guarded.length) await tx.detachFenceFactRows(guarded.map(g => Number(g.id)));
  await expire();
  // A fence with no rows and nothing guarded has nothing to place or gate (#6007: no reads on a fence-free publish).
  if (!input.rows.length && !guarded.length) return { rows: [], async finish() { return []; } };
  const occupied = new Set(await tx.listOccupiedFenceRowNums(sourceId, slug));
  let rows = input.rows;
  const contested: typeof guarded = [];
  const moves: Array<{ id: number; row_num: number; visibility: string }> = [];
  for (const g of guarded) {
    const free = rows.filter(r => r.fact === g.fact && !occupied.has(r.row_num));
    const reopened = g.opened ? free.find(r => r.row_num === Number(g.row_num) && r.visibility === 'world') : undefined;
    if (reopened) {
      moves.push({ id: Number(g.id), row_num: reopened.row_num, visibility: 'world' });
      occupied.add(reopened.row_num);
      rows = rows.filter(r => r !== reopened);
      continue;
    }
    if (!g.above) {
      const target = free.find(r => r.row_num === Number(g.row_num));
      if (!target) continue;
      moves.push({ id: Number(g.id), row_num: target.row_num, visibility: g.visibility });
      occupied.add(target.row_num);
      rows = rows.filter(r => r !== target);
      continue;
    }
    const target = free.find(r => r.visibility === g.visibility) ?? (g.visibility === 'world' ? free.find(r => r.visibility === 'private') : undefined);
    if (!target) { contested.push(g); continue; }
    moves.push({ id: Number(g.id), row_num: target.row_num, visibility: target.visibility ?? g.visibility });
    occupied.add(target.row_num);
    rows = rows.filter(r => r !== target);
  }
  // #6574: every guarded row moves in one statement; each starts detached (row_num NULL), so no move collides with another.
  if (moves.length) await tx.moveGuardedFenceRows(moves);
  const gated: Array<{ row: T; decision: GatedRowDecision }> = [];
  const inserted: T[] = [];
  // Only new rows are gated; owner-tier writers (tool_observed and above) never are, so they read no gate config.
  let trust: WriteTrust | null = null;
  const writerTrust = async (db: BrainEngine) => trust ??= await currentWriteTrust(db) ?? { tier: 'unknown', origin: null };
  const cfg = rows.some(r => !occupied.has(r.row_num)) && compareTrust((await writerTrust(tx)).tier, 'tool_observed') < 0 ? await input.cfg(tx) : null;
  // Only a row this write inserts at a guarded row's old position replaces it; a moved row never does.
  const fresh = new Set(rows.filter(r => !occupied.has(r.row_num)).map(r => r.row_num));
  // GST-2511: a new world row that replaces a guarded non-world row, or restates the claim of a non-world fact of this page
  // more trusted than the writer, is inserted at that row's visibility; its proposal carries the widening, which only the
  // owner's accept applies. GST-2900: so does a row restating such a fact of its own entity kept on another page (or on
  // none), while no world fact of that entity states it (restatedPrivateCopy's rule for remember).
  const widened = new Map<number, { from: string; copy?: { id: number; trust_tier: string } }>();
  for (const g of contested) {
    const at = rows.find(r => r.row_num === Number(g.row_num) && fresh.has(r.row_num));
    if (at && g.visibility !== 'world' && at.visibility === 'world') widened.set(at.row_num, { from: g.visibility });
  }
  const restated = rows.filter(r => fresh.has(r.row_num) && r.visibility === 'world' && !widened.has(r.row_num));
  const trustedPrivate = restated.length ? await tx.listTrustedPrivateCopies(sourceId, slug, restated.map(r => ({ row_num: r.row_num, fact: r.fact, entity: r.entity_slug ?? null }))) : [];
  for (const r of restated) {
    const copy = trustedPrivate.find(t => Number(t.row_num) === r.row_num);
    if (copy) widened.set(r.row_num, { from: copy.visibility, copy: { id: Number(copy.id), trust_tier: copy.trust_tier } });
  }
  if (widened.size) rows = rows.map(r => fresh.has(r.row_num) && widened.has(r.row_num) ? { ...r, visibility: widened.get(r.row_num)!.from } : r);
  for (const row of rows) {
    if (!cfg || occupied.has(row.row_num)) { inserted.push(row); continue; }
    const decision = decideFactWrite({ fact: row.fact, context: row.context ?? null, source: row.source ?? null }, { sourceId, slug, pageId: input.pageId,
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
      const at = async (rowNum: number) => await db.readLiveFenceFactAt(sourceId, slug, rowNum) ?? undefined;
      for (const g of contested) {
        const replacement = fresh.has(Number(g.row_num)) ? await at(Number(g.row_num)) : undefined;
        if (replacement) {
          refs.push((await recordContestedFact(db, { sourceId, oldId: Number(g.id), oldTier: storedTrustTier(g.trust_tier), newId: Number(replacement.id),
            newTier: storedTrustTier(replacement.trust_tier), guard: 'fence_projection',
            ...(widened.has(Number(g.row_num)) ? { visibility: { from: widened.get(Number(g.row_num))!.from, to: 'world' } } : {}) })).proposal_ref);
        } else {
          const { id } = await insertTrustProposal(db, { action: 'forget', sourceId, target: { table: 'facts', id: Number(g.id) }, proposer: 'fence_projection',
            before: { guard: 'fence_projection', fact: { id: Number(g.id), tier: storedTrustTier(g.trust_tier) }, writer_tier: (await writerTrust(db)).tier, slug } });
          refs.push(`tp${id}`);
        }
      }
      for (const [rowNum, { from, copy }] of widened) {
        const restatement = copy ? await at(rowNum) : undefined;
        if (!copy || !restatement) continue;
        refs.push((await recordContestedFact(db, { sourceId, oldId: copy.id, oldTier: storedTrustTier(copy.trust_tier), newId: Number(restatement.id),
          newTier: storedTrustTier(restatement.trust_tier), guard: 'fence_projection', visibility: { from, to: 'world' } })).proposal_ref);
      }
      for (const { row, decision } of gated) {
        const stored = await at(row.row_num);
        if (stored) await recordFlaggedRow(db, decision, { table: 'facts', id: Number(stored.id), sourceId });
      }
      return refs;
    },
  };
}

/** The page's live fence facts more trusted than the writer: the rows its field rewrite could lower. */
export async function factsAboveWriter(tx: BrainEngine, sourceId: string, slug: string): Promise<Array<{ id: number; tier: TrustTier }>> {
  return (await tx.listFactsAboveWriter(sourceId, slug)).map(r => ({ id: Number(r.id), tier: storedTrustTier(r.trust_tier) }));
}

/** What a lower-tier write would have done to a held take or timeline row. */
export type HeldChange = 'removed' | 'replaced' | 'deactivated' | 'detail_changed';
export type { HeldTable } from '../engine-sql/trust-fence.ts';
export interface HeldRow { id: number; tier: TrustTier; change: HeldChange }


/**
 * Of the page's rows `ids`, the rows a write may not delete or overwrite, locked: rows more trusted than `writer` (the
 * transaction's declared tier when omitted) and, with `pending`, rows an open contest already holds. A reconcile that
 * restates the page text passes `pending`: the held row is absent from that text by design. The read is the typed
 * engine member `listHeldRows` (engine-sql/trust-fence.ts).
 */
export async function heldRows(tx: BrainEngine, table: HeldTable, pageId: number, ids: readonly number[], opts: { writer?: TrustTier; pending?: boolean } = {}): Promise<Map<number, TrustTier>> {
  if (!ids.length) return new Map();
  const rows = await tx.listHeldRows({ table, pageId, ids, ...(opts.writer ? { writer: opts.writer } : {}), ...(opts.pending ? { pending: true } : {}) });
  return new Map(rows.map(r => [Number(r.id), storedTrustTier(r.trust_tier)]));
}

/**
 * The page's takes a fence re-projection would delete (`gone` row numbers), replace (claim, kind or holder differ at the
 * same row number) or deactivate, that are more trusted than the writer, locked before any of those statements run.
 */
export async function guardFenceTakes(tx: BrainEngine, pageId: number, incoming: ReadonlyArray<{ rowNum: number; claim: string; kind: string; holder: string; active: boolean }>,
  gone: readonly number[], opts: { pending?: boolean } = {}): Promise<Array<HeldRow & { page_id: number; row_num: number }>> {
  return guardTakeRows(tx, incoming.map(t => ({ page_id: pageId, row_num: t.rowNum, claim: t.claim, kind: t.kind, holder: t.holder, active: t.active })),
    gone.map(rowNum => ({ page_id: pageId, row_num: rowNum })), opts);
}

/** guardFenceTakes over several pages' rows at once (a reconcile batch); `pending` also holds rows an open contest holds. */
export async function guardTakeRows(tx: BrainEngine, incoming: ReadonlyArray<{ page_id: number; row_num: number; claim: string; kind: string; holder: string; active: boolean }>,
  gone: ReadonlyArray<{ page_id: number; row_num: number }>, opts: { pending?: boolean } = {}): Promise<Array<HeldRow & { page_id: number; row_num: number }>> {
  const rows = await tx.listGuardedTakeRows({ incoming, gone, pending: opts.pending === true });
  return rows.map(r => ({ id: Number(r.id), page_id: Number(r.page_id), row_num: Number(r.row_num), tier: storedTrustTier(r.trust_tier), change: r.change }));
}

/** Files the owner's `forget` proposal for each held row (an open one is reused); returns their tp refs. */
export async function contestHeldRows(tx: BrainEngine, input: { sourceId: string; slug: string; table: HeldTable; proposer: string; writer?: TrustTier; rows: readonly HeldRow[] }): Promise<string[]> {
  if (!input.rows.length) return [];
  const writer = input.writer ?? (await currentWriteTrust(tx))?.tier ?? 'unknown';
  const refs: string[] = [];
  for (const row of input.rows) {
    const { id } = await insertTrustProposal(tx, { action: 'forget', sourceId: input.sourceId, target: { table: input.table, id: row.id }, proposer: input.proposer,
      before: { guard: input.proposer, change: row.change, row: { id: row.id, tier: row.tier }, writer_tier: writer, slug: input.slug } });
    refs.push(`tp${id}`);
  }
  return refs;
}
