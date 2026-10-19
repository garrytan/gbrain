/**
 * `gbrain repair consolidate-ties` (#6023): reopen facts that consolidation
 * closed at their own effective instant.
 *
 * Before this release, a cluster with two typed claims stating one metric,
 * unit and period for the same effective time was promoted anyway: the take
 * took the higher-confidence statement and the chronological writeback set
 * the other one's `valid_until` to its own `valid_from`, a zero-length
 * interval that quietly marked a real fact superseded. Consolidation now holds
 * such clusters; this repair finds the facts the old writeback closed.
 *
 * Candidates: an active typed fact consolidated into a take whose
 * `valid_until` equals its `valid_from`, where another fact consolidated
 * into the same take states the same metric, unit and period at the same
 * instant. A restore sets `valid_until` back to NULL (the writeback only
 * touched facts that were current) and keeps the consolidation mark, so the
 * fact is current again beside its partner; the preview names the take so the
 * operator can judge it.
 *
 * Explicit-only and preview-bound: the preview lists every candidate, prints a
 * hash and saves the set; `--apply --expect <hash>` restores exactly that set,
 * rechecking each fact in its own transaction and keeping it as
 * `changed_since_preview` when it no longer matches. On a managed brain each
 * restore commits as one coordinated database-only write on the entity's key.
 * Nothing runs on upgrade, and no page is rewritten.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { RELINK_OPERATION } from '../facts/relink-publish.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { coordinatedDatabaseWrite } from '../persistence/database-write.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

export interface ClosedTie {
  source_id: string;
  id: number;
  entity_slug: string;
  take_id: number;
  valid_from: string;
  /** The facts consolidated into the same take that state the same claim at the same instant. */
  partners: number[];
}

/** Every fact the pre-#6023 writeback closed at its own instant, in (source, id) order. Read-only. */
export async function findClosedTies(engine: BrainEngine, sourceIds: string[]): Promise<ClosedTie[]> {
  const rows = await engine.executeRaw<{ source_id: string; id: number | string; entity_slug: string; take_id: number | string; valid_from: string;
    partners: Array<number | string> | null }>(`
    SELECT f.source_id, f.id, f.entity_slug, f.consolidated_into AS take_id, f.valid_from::text AS valid_from,
           (SELECT array_agg(g.id ORDER BY g.id) FROM facts g
             WHERE g.source_id = f.source_id AND g.id <> f.id AND g.consolidated_into = f.consolidated_into
               AND g.claim_metric = f.claim_metric AND g.claim_unit IS NOT DISTINCT FROM f.claim_unit
               AND g.claim_period IS NOT DISTINCT FROM f.claim_period AND g.valid_from = f.valid_from) AS partners
      FROM facts f
     WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND f.claim_metric IS NOT NULL
       AND f.consolidated_into IS NOT NULL AND f.valid_until = f.valid_from AND f.entity_slug IS NOT NULL
     ORDER BY f.source_id, f.id`, [sourceIds]);
  return rows.filter(row => row.partners?.length).map(row => ({ source_id: row.source_id, id: Number(row.id), entity_slug: row.entity_slug,
    take_id: Number(row.take_id), valid_from: row.valid_from, partners: row.partners!.map(Number) }));
}

interface ApprovedTie extends ClosedTie { selection: string[] }
interface RestoreItem extends RepairItem { tie: ClosedTie; hash: string; last: boolean }

function previewCommand(scope: RepairScope): string {
  return `gbrain repair consolidate-ties${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;
}

const sourcesOf = (engine: BrainEngine, scope: RepairScope) => engine.executeRaw<{ id: string; incarnation: string }>(
  'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);

const hashOf = (scope: RepairScope, sources: unknown, ties: ClosedTie[]) =>
  previewHash({ kind: 'consolidate-ties-v1', brain_id: scope.brain_id, sources, selection: { source_ids: scope.source_ids }, ties });

function item(tie: ClosedTie, index: number, hash: string, last: boolean): RestoreItem {
  return { cursor: { phase: 1, id: index }, source_id: tie.source_id, slug: tie.entity_slug, chars: 0, action: 'restore', tie, hash, last };
}

export const consolidateTiesRepair: RepairHandler = {
  kind: 'consolidate-ties',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope);
    if (!opts?.apply) {
      const ties = await findClosedTies(engine, scope.source_ids);
      const hash = hashOf(scope, await sourcesOf(engine, scope), ties);
      if (ties.length) await saveApprovedSet<ApprovedTie>(engine, { command: 'consolidate-ties', hash }, ties.map(t => ({ ...t, selection: scope.source_ids })));
      return { items: ties.map((t, index) => item(t, index, hash, index === ties.length - 1)), preview_hash: hash, residuals: {},
        listing: ties.map(t => ({ item: `${t.source_id}:${t.id}`, class: 'restore',
          detail: `fact ${t.id} on ${t.entity_slug} was closed at its own effective time ${t.valid_from} when consolidation broke a tie with fact(s) `
            + `${t.partners.join(', ')} into take ${t.take_id}; restore reopens it` })) };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair consolidate-ties --apply restores only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        'docs/guides/repair.md#explicit-only-repair-kinds');
    }
    const approved = await loadApprovedSet<ApprovedTie>(engine, { command: 'consolidate-ties', hash: opts.expect, previewCommand: command,
      emptyHash: async () => hashOf(scope, await sourcesOf(engine, scope), []) });
    if (approved.items.some(t => JSON.stringify(t.selection) !== JSON.stringify(scope.source_ids))) throw previewChangedError(opts.expect, command);
    const items = approved.items.map(({ selection: _selection, ...t }, index) => item(t, index, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { tie, hash, last } = entry as RestoreItem;
    const restore = async (tx: BrainEngine): Promise<boolean> => (await tx.executeRaw<{ id: number }>(
      `UPDATE facts SET valid_until = NULL
        WHERE source_id = $1 AND id = $2 AND entity_slug = $3 AND consolidated_into = $4 AND expired_at IS NULL
          AND valid_until = valid_from AND valid_from = $5::timestamptz
        RETURNING id`, [tie.source_id, tie.id, tie.entity_slug, tie.take_id, tie.valid_from])).length === 1;
    const managed = await coordinatedDatabaseWrite({ ...ctx, sourceId: tie.source_id }, RELINK_OPERATION, tie.entity_slug, [tie.entity_slug], tx => restore(tx));
    const restored = managed ? managed.value : await maintenanceTransaction(ctx.engine, restore);
    if (last) await clearApprovedSet(ctx.engine, { command: 'consolidate-ties', hash });
    if (!restored) return { applied: false, outcome: 'changed_since_preview', reason: 'the fact was expired, edited or reopened since the preview' };
    return { applied: true, outcome: 'restored', detail: { fact: tie.id, take: tie.take_id } };
  },
};
