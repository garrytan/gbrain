/**
 * `gbrain repair orphan-bindings` (#5732): delete persistence source bindings
 * whose source or source incarnation no longer exists, so a source re-added
 * under the same id can be claimed and synced again. Brain-wide: bindings of
 * removed sources are outside any active-source scope. Bookkeeping only; no
 * journal admission. A binding a pending request still references is kept.
 */
import { deleteOrphanBinding, listOrphanBindings } from '../persistence/orphan-bindings.ts';
import type { RepairHandler, RepairItem } from './core.ts';

export const orphanBindingsRepair: RepairHandler = {
  kind: 'orphan-bindings',
  publication: 'projection',
  embeds: false,
  async plan(engine) {
    const rows = await listOrphanBindings(engine);
    const removable = rows.filter(row => row.pending_requests === 0);
    const items: RepairItem[] = removable.map((row, index) => ({ cursor: { phase: 0, id: index + 1 },
      source_id: row.source_id, slug: `binding:${row.source_incarnation}`, chars: 0, action: `delete_${row.reason}`,
      change: { from: JSON.stringify({ source_id: row.source_id, source_incarnation: row.source_incarnation }), to: 'deleted' } }));
    const residuals: Record<string, number> = rows.length > removable.length ? { pending_requests: rows.length - removable.length } : {};
    return { items, residuals };
  },
  async apply(ctx, item) {
    return deleteOrphanBinding(ctx.engine, JSON.parse(item.change!.from!));
  },
};
