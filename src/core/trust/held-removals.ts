/**
 * The owner's decision on a held take or timeline row (W1 #6783 §12 (a)).
 *
 * A lower-tier write never deletes, replaces or deactivates a take or timeline
 * row more trusted than it (trust/fence-guard.ts): the row stays and a `forget`
 * proposal targets it. Accepting applies what the write asked for:
 * - a refused `takes_remove` whose take the page's fence still carries with
 *   the same claim is removed by an owner `takes_remove` bound to the
 *   proposal by a one-time nonce, so the fence and the index change together;
 * - otherwise (a page publish removed, rewrote, re-kinded or struck through
 *   the row) the page's current text rules that row: the fence row at its
 *   number (or the timeline entry with its date, source and summary) replaces
 *   it at the writer's tier, and when the page no longer carries one the row
 *   is deleted.
 * A segmented page within the single-string ceiling is read back from its
 * segments; one over it holds no fences and refuses (`page_body_segmented`),
 * leaving the proposal pending. Dismissing keeps the row (the default reject).
 */
import type { BrainEngine } from '../engine.ts';
import { parseTakesFence } from '../takes-fence.ts';
import { takesPreparation } from '../takes-write.ts';
import { maintenanceAttribution, principalAttribution } from '../persistence/attribution.ts';
import { withCoordinatedWrite, withWriteAttribution, withWriteTrust } from '../persistence/context.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { queuePageProjection } from '../page-state/projections.ts';
import { reprojectTimelineRow } from '../persistence/canonical-projections.ts';
import { decisionResult, getTrustProposal, transitionTrustProposal, type TrustDecisionContext, type TrustDecisionResult, type TrustProposalRow } from './proposals.ts';
import { storedTrustTier } from './tier.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import { materializeSegmentedBody } from '../page-body/ingest.ts';
import { segmentedOverCeiling } from '../persistence/segmented-apply.ts';
import { withBeliefBatch } from '../belief/ledger.ts';
import { markBeliefCommits } from '../belief/append.ts';

interface HeldPageRow { id: number; page_id: number; source_id: string; slug: string; body_storage: 'inline' | 'segmented' | null; body_bytes: number | null; compiled_truth: string | null; timeline: string | null }

async function heldRow(engine: BrainEngine, table: string, id: number): Promise<(HeldPageRow & Record<string, unknown>) | undefined> {
  const columns = table === 'takes' ? 'x.row_num, x.claim' : 'x.date::text AS date, x.source, x.summary';
  const [row] = await engine.executeRaw<HeldPageRow & Record<string, unknown>>(`SELECT x.id, x.page_id, ${columns}, p.source_id, p.slug, p.body_storage, p.body_bytes, p.compiled_truth, p.timeline
    FROM ${table === 'takes' ? 'takes' : 'timeline_entries'} x JOIN pages p ON p.id = x.page_id WHERE x.id = $1`, [id]);
  return row;
}

/** A refused `takes_remove` the owner accepted: its intent carries the proposal id and the nonce stored on it. */
export async function ownerAcceptedRemoval(engine: BrainEngine, row: { authority: { remote: boolean }; intent: Record<string, unknown> | null }, takeId: number): Promise<number | null> {
  const id = Number(row.intent?.trust_accept);
  const nonce = row.intent?.trust_accept_nonce;
  if (row.authority.remote !== false || !Number.isSafeInteger(id) || typeof nonce !== 'string') return null;
  const proposal = await getTrustProposal(engine, id);
  return proposal && proposal.status === 'pending' && proposal.action === 'forget' && proposal.target_table === 'takes'
    && proposal.target_id === takeId && proposal.after_state.accept_nonce === nonce ? id : null;
}

export async function acceptHeldRemoval(engine: BrainEngine, proposal: TrustProposalRow, ctx: TrustDecisionContext): Promise<TrustDecisionResult> {
  const table = proposal.target_table;
  const row = await heldRow(engine, table, proposal.target_id);
  if (!row) {
    await transitionTrustProposal(engine, proposal.id, 'pending', 'superseded', { decidedBy: ctx.decidedBy });
    return decisionResult(proposal, 'accept', 'superseded', { reason: 'row_missing' });
  }
  if (segmentedOverCeiling(row)) assertInlineBody(row, 'trust confirm (held removal)');
  const body = row.body_storage === 'segmented' ? await materializeSegmentedBody(engine, Number(row.page_id), row.source_id)
    : { compiled_truth: row.compiled_truth ?? '', timeline: row.timeline ?? '' };
  const fenceRow = table === 'takes' ? parseTakesFence(`${body.compiled_truth}\n${body.timeline}`).takes.find(t => t.rowNum === Number(row.row_num)) : undefined;
  if (proposal.proposer === 'takes_remove' && fenceRow && fenceRow.claim === row.claim) {
    const nonce = crypto.randomUUID();
    await engine.executeRaw(`UPDATE trust_proposals SET after_state = after_state || jsonb_build_object('accept_nonce', $2::text) WHERE id = $1 AND status = 'pending'`, [proposal.id, nonce]);
    const { submitPageMutation } = await import('../persistence/page-mutations.ts');
    const local = { engine, sourceId: row.source_id, remote: false as const, dryRun: false,
      config: ctx.config ?? ({ engine: engine.kind } as never), logger: { info() {}, warn() {}, error() {} } };
    await submitPageMutation(local as never, { operation: 'takes_remove', params: { slug: row.slug, source_id: row.source_id, row_num: Number(row.row_num),
      trust_accept: proposal.id, trust_accept_nonce: nonce, request_id: crypto.randomUUID() } });
    const after = await getTrustProposal(engine, proposal.id);
    return after?.status === 'accepted' ? decisionResult(proposal, 'accept', 'accepted')
      : decisionResult(proposal, 'accept', 'refused', { reason: after?.status ?? 'not_found' });
  }
  const writer = { tier: storedTrustTier(proposal.before_state.writer_tier), origin: { channel: `trust_accept:${proposal.proposer}` } };
  const attribution = ctx.decidedBy ? principalAttribution(ctx.decidedBy) : await maintenanceAttribution(engine);
  const managed = await managedPersistenceEnabled(engine);
  const publicationId = crypto.randomUUID();
  const report = { appended: 0 };
  const applied = await engine.transaction(async tx => {
    const run = async () => {
      await tx.lockPageKeys([{ sourceId: row.source_id, slug: row.slug }]);
      if (!await transitionTrustProposal(tx, proposal.id, 'pending', 'accepted', { decidedBy: ctx.decidedBy })) return false;
      // W1 #6783 §6.2: the accepted removal is the take's retraction, recorded at its preimage tier with the writer's tier beside it.
      await withWriteTrust(tx, writer, () => withBeliefBatch(tx, { sourceId: row.source_id, slugs: [row.slug], publicationId, op: 'trust_accept', remote: false, report,
        cause: { proposal: `tp${proposal.id}` } }, async () => {
        if (table === 'takes') {
          if (fenceRow) await tx.addTakesBatch([takesPreparation.toCanonicalBatchInput(row.page_id, fenceRow)]);
          else await tx.executeRaw('DELETE FROM takes WHERE id = $1', [row.id]);
        } else {
          await tx.executeRaw('DELETE FROM timeline_entries WHERE id = $1', [row.id]);
          await reprojectTimelineRow(tx, row.page_id, body, row.slug, { date: String(row.date), source: row.source as string | null, summary: String(row.summary) });
        }
      }));
      await queuePageProjection(tx, row.source_id, row.slug, 'trust_tier_changed');
      return true;
    };
    return managed ? withCoordinatedWrite(tx, [row.source_id], run, attribution) : withWriteAttribution(tx, attribution, run);
  });
  if (report.appended) await markBeliefCommits(engine, [publicationId]).catch(() => undefined);
  return applied ? decisionResult(proposal, 'accept', 'accepted', { detail: { [table === 'takes' ? 'take_id' : 'timeline_entry_id']: String(row.id) } })
    : decisionResult(proposal, 'accept', 'refused', { reason: (await getTrustProposal(engine, proposal.id))?.status ?? 'not_found' });
}
