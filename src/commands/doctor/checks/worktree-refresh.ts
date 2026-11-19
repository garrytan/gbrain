import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { stuckWorktreeRefreshes } from '../../../core/persistence/worktree-refresh.ts';

const STUCK_MINUTES = 15;

/**
 * F0: a `foresights sources refresh` whose row stayed active (draining, fenced,
 * merged, syncing or recovery_required) for over 15 minutes keeps its
 * worktree's writes refused. Each row names the resume command.
 */
export async function checkWorktreeRefreshStuck(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await stuckWorktreeRefreshes(engine, STUCK_MINUTES);
    const refreshes = rows.map(row => ({ id: row.id, state: row.state, source_ids: row.source_ids,
      command: `foresights sources refresh ${row.source_ids[0]} --resume` }));
    if (!refreshes.length) return { name: 'worktree_refresh_stuck', status: 'ok', message: 'No worktree refresh is stuck.', details: { refreshes } };
    return { name: 'worktree_refresh_stuck', status: 'warn', details: { refreshes },
      message: `${refreshes.length} worktree refresh(es) have been active for over ${STUCK_MINUTES} minutes; writes to their worktrees are refused until they finish. `
        + `Run on the owner host: ${refreshes.map(r => `${r.command} (${r.state}, sources ${r.source_ids.join(',')})`).join(' | ')}. `
        + 'A recovery_required refresh needs the user to decide how to reset the checkout; the resume command prints both options.' };
  } catch (error) {
    return { name: 'worktree_refresh_stuck', status: 'warn',
      message: `Worktree refreshes could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown; run foresights apply-migrations --yes if the table is missing.`,
      details: { health: 'unknown' } };
  }
}
