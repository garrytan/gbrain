/**
 * `gbrain repair loop-facts` (#5869): retires the commitment facts that
 * `loops_close` left active before this release (its raw expiry was refused
 * on managed brains and never struck the fence row anywhere).
 *
 * Candidates are closed (`done`/`dropped`) loops whose commitment fact is
 * still active, lives in the loop's source and is referenced by no open loop
 * (`loopFactDrift`, the same rule `loops_close` and doctor
 * `loop_facts_drift` use). The kind is explicit-only and preview-bound: the
 * preview lists every loop with its fact and saves the set under its hash;
 * `--apply --expect <hash>` retires exactly that set. Each item is rechecked
 * when it is applied (`changed_since_preview` when the loop or fact moved)
 * and retired through the same coordinated strike-plus-expire publication
 * as `loops_close`, so the fence row and the database row change together.
 */
import { OperationError } from '../ops/contract.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { loopFactDrift, retireLoopFact } from '../persistence/loop-fact-retirement.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

interface DriftedLoop { loop_id: number; source_id: string; fact_id: number; status: string; slug: string | null }
interface LoopFactItem extends RepairItem { loop: DriftedLoop; hash: string; last: boolean }
interface ApprovedLoop extends DriftedLoop { selection: string[] }

function previewCommand(scope: RepairScope): string {
  return `gbrain repair loop-facts${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;
}

function item(loop: DriftedLoop, hash: string, last: boolean): LoopFactItem {
  return { cursor: { phase: 1, id: loop.loop_id }, source_id: loop.source_id, slug: loop.slug ?? `loops/${loop.loop_id}`,
    chars: 0, action: 'retire:closed_loop_fact', loop, hash, last };
}

export const loopFactsRepair: RepairHandler = {
  kind: 'loop-facts',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope);
    if (!opts?.apply) {
      const loops = await loopFactDrift(engine, scope.source_ids);
      const sources = await engine.executeRaw<{ id: string; incarnation: string }>(
        'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
      const hash = previewHash({ kind: 'loop-facts-v1', brain_id: scope.brain_id, sources, selection: { source_ids: scope.source_ids }, loops });
      if (loops.length) await saveApprovedSet<ApprovedLoop>(engine, { command: 'loop-facts', hash }, loops.map(loop => ({ ...loop, selection: scope.source_ids })));
      return { items: loops.map((loop, index) => item(loop, hash, index === loops.length - 1)), preview_hash: hash,
        residuals: { closed_loop_facts: loops.length },
        listing: loops.map(loop => ({ item: `${loop.source_id}:loop#${loop.loop_id}`, class: 'closed_loop_fact',
          detail: `loop ${loop.status}; commitment fact #${loop.fact_id} still active${loop.slug ? ` on ${loop.slug}` : ''}` })) };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair loop-facts --apply retires only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        'docs/guides/repair.md#explicit-only-repair-kinds');
    }
    const approved = await loadApprovedSet<ApprovedLoop>(engine, { command: 'loop-facts', hash: opts.expect, previewCommand: command,
      emptyHash: async () => previewHash({ kind: 'loop-facts-v1', brain_id: scope.brain_id, sources: (await engine.executeRaw<{ id: string; incarnation: string }>('SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids])), selection: { source_ids: scope.source_ids }, loops: [] }) });
    if (approved.items.some(loop => JSON.stringify(loop.selection) !== JSON.stringify(scope.source_ids))) throw previewChangedError(opts.expect, command);
    const items = approved.items.map(({ selection: _selection, ...loop }, index) => item(loop, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { loop, hash, last } = entry as LoopFactItem;
    const [live] = await loopFactDrift(ctx.engine, [loop.source_id], loop.loop_id);
    let outcome: RepairItemOutcome;
    if (!live || live.fact_id !== loop.fact_id) outcome = { applied: false, outcome: 'changed_since_preview', reason: 'the loop or its fact changed' };
    else {
      const retired = await retireLoopFact(ctx, loop.loop_id);
      outcome = retired.fact_expired ? { applied: true, outcome: 'retired' }
        : { applied: false, outcome: retired.retryable ? 'refused_retryable' : 'kept', ...(retired.reason ? { reason: retired.reason } : {}) };
    }
    if (last) await clearApprovedSet(ctx.engine, { command: 'loop-facts', hash });
    return outcome;
  },
};
