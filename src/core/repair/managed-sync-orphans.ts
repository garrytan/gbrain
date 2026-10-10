/**
 * `gbrain repair managed-sync-orphans [--source <id>]` (#5459): retire managed
 * sync bookkeeping nothing current can resume or clear, so doctor stops
 * reporting it as an unresolved failure. Explicit-only and preview-bound: the
 * preview lists each orphan with its class and saves the set under a hash;
 * `--apply --expect <hash>` retires exactly that set. Bookkeeping rows only
 * (`op_checkpoints`); no journal admission, no page or file changes. A cursor
 * whose pending request is still live, or that the live writer can resume
 * with its recorded options, is kept and counted.
 */
import { OperationError } from '../ops/contract.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { classifyManagedSyncOrphans, retireManagedSyncOrphan, type ManagedSyncOrphan } from '../persistence/managed-sync-orphans.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

type ApprovedOrphan = ManagedSyncOrphan & { selection: string[] };
type OrphanItem = RepairItem & { orphan: ManagedSyncOrphan; hash: string; last: boolean };

const previewCommand = (scope: RepairScope) => `gbrain repair managed-sync-orphans${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;

function item(orphan: ManagedSyncOrphan, index: number, hash: string, last: boolean): OrphanItem {
  return { cursor: { phase: orphan.kind === 'unfinished_cursor' ? 0 : 1, id: index + 1 }, source_id: orphan.source_id,
    slug: `${orphan.kind}:${orphan.cursor_key.slice(0, 12)}`, chars: 0, action: `retire_${orphan.reason}`,
    change: { from: JSON.stringify({ kind: orphan.kind, cursor_key: orphan.cursor_key, run_id: orphan.run_id, reason: orphan.reason, pending_request_id: orphan.pending_request_id }), to: 'retired' },
    orphan, hash, last };
}

const describe = (orphan: ManagedSyncOrphan) => orphan.reason === 'no_cursor' ? 'failure row with no cursor under its key'
  : orphan.reason === 'principal_unadoptable' ? `cursor recorded by ${orphan.principal ? `${orphan.principal.kind} ${orphan.principal.id.slice(0, 8)}` : 'an unknown principal'}, not an active local writer${orphan.pending_request_id ? `; pending request ${orphan.pending_state ?? 'not found'}` : ''}`
    : 'cursor from before recorded sync options, superseded by a completed run';

export const managedSyncOrphansRepair: RepairHandler = {
  kind: 'managed-sync-orphans',
  publication: 'projection',
  embeds: false,
  outcomeItemsLimit: 1000,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope);
    if (!opts?.apply) {
      const { orphans, retained } = await classifyManagedSyncOrphans(engine, scope.source_ids);
      const hash = previewHash({ kind: 'managed-sync-orphans-v1', brain_id: scope.brain_id, selection: scope.source_ids,
        orphans: orphans.map(orphan => [orphan.kind, orphan.cursor_key, orphan.run_id, orphan.reason]) });
      if (orphans.length) await saveApprovedSet<ApprovedOrphan>(engine, { command: 'managed-sync-orphans', hash }, orphans.map(orphan => ({ ...orphan, selection: scope.source_ids })));
      const residuals: Record<string, number> = {};
      for (const row of retained) residuals[row.why] = (residuals[row.why] ?? 0) + 1;
      return { items: orphans.map((orphan, index) => item(orphan, index, hash, index === orphans.length - 1)), preview_hash: hash, residuals,
        listing: orphans.map(orphan => ({ item: `${orphan.source_id}:${orphan.cursor_key.slice(0, 12)}`, class: orphan.reason, detail: describe(orphan) })),
        details: { retained } };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair managed-sync-orphans --apply retires only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`, 'docs/guides/repair.md#explicit-only-repair-kinds');
    }
    const approved = await loadApprovedSet<ApprovedOrphan>(engine, { command: 'managed-sync-orphans', hash: opts.expect, previewCommand: command });
    if (approved.items.some(entry => JSON.stringify(entry.selection) !== JSON.stringify(scope.source_ids))) throw previewChangedError(opts.expect, command);
    const items = approved.items.map(({ selection: _selection, ...orphan }, index) => item(orphan, index, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { orphan, hash, last } = entry as OrphanItem;
    const removed = await retireManagedSyncOrphan(ctx.engine, orphan);
    if (last) await clearApprovedSet(ctx.engine, { command: 'managed-sync-orphans', hash });
    const applied = removed.cursor || removed.failure;
    return { applied, outcome: applied ? 'retired' : 'kept', ...(applied ? {} : { reason: 'no_longer_orphaned' }), detail: removed };
  },
  render(details) {
    const retained = (details.retained ?? []) as Array<{ cursor_key: string; source_id: string; why: string }>;
    return retained.map(row => `kept ${row.source_id}:${row.cursor_key.slice(0, 12)}: ${row.why === 'pending_request_live'
      ? 'its pending request is still queued or running' : 'the live writer can resume it with the sync command doctor prints'}`);
  },
};
