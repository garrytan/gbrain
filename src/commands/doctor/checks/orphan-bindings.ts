import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { listOrphanBindings } from '../../../core/persistence/orphan-bindings.ts';

const LIMIT = 1000;

/**
 * #5732: persistence source bindings whose source or source incarnation no
 * longer exists. A source re-added under the same id cannot be claimed while
 * one remains. Brain-wide; names the repair.
 */
export async function checkOrphanBindings(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await listOrphanBindings(engine, { limit: LIMIT + 1 });
    const truncated = rows.length > LIMIT;
    const bindings = rows.slice(0, LIMIT);
    const details = { count: bindings.length, truncated, bindings, repair: 'orphan-bindings', docs: 'docs/guides/repair.md#orphan-bindings' };
    if (!bindings.length) return { name: 'orphan_persistence_bindings', status: 'ok', message: 'Every persistence source binding belongs to an existing source.', details };
    return { name: 'orphan_persistence_bindings', status: 'warn', details,
      message: `${bindings.length}${truncated ? '+' : ''} persistence source binding(s) belong to a removed source or an earlier incarnation `
        + `(${bindings.map(row => row.source_id).slice(0, 10).join(', ')}); a source re-added under the same id cannot be claimed while one remains. `
        + 'Preview on the brain host: gbrain repair orphan-bindings — then apply after the user agrees: gbrain repair orphan-bindings --apply' };
  } catch (error) {
    return { name: 'orphan_persistence_bindings', status: 'warn',
      message: `Persistence source bindings could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown', truncated: true } };
  }
}
