import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { REFRESH_HOLD_KEY, refreshHoldEnabled, stuckWorktreeRefreshes } from '../../../core/persistence/worktree-refresh.ts';

const STUCK_MINUTES = 15;

/**
 * F0: a `gbrain sources refresh` whose row stayed active (draining, fenced,
 * merged, syncing or recovery_required) for over 15 minutes keeps its
 * worktree's writes refused. Each row names the resume command.
 */
export async function checkWorktreeRefreshStuck(engine: BrainEngine): Promise<Check> {
  try {
    const held = await refreshHoldEnabled(engine);
    const rows = await stuckWorktreeRefreshes(engine, STUCK_MINUTES);
    const refreshes = rows.map(row => ({ id: row.id, state: row.state, source_ids: row.source_ids,
      command: `gbrain sources refresh ${row.source_ids[0]} --resume` }));
    const hold = held ? `${REFRESH_HOLD_KEY} holds new refresh calls (including --resume/--abandon); it does not cancel in-flight refreshes or stop other writers. Ask the maintenance owner before restoring its saved value. ` : '';
    if (!refreshes.length) return { name: 'worktree_refresh_stuck', status: held ? 'warn' : 'ok', message: hold || 'No worktree refresh is stuck.', details: { refreshes, refresh_hold: held } };
    return { name: 'worktree_refresh_stuck', status: 'warn', details: { refreshes, refresh_hold: held },
      message: hold + `${refreshes.length} worktree refresh(es) have been active for over ${STUCK_MINUTES} minutes; writes to their worktrees are refused until they finish. `
        + `Run on the owner host: ${refreshes.map(r => `${r.command} (${r.state}, sources ${r.source_ids.join(',')})`).join(' | ')}. `
        + 'A recovery_required refresh needs the user to decide how to reset the checkout; the resume command prints both options.' };
  } catch (error) {
    return { name: 'worktree_refresh_stuck', status: 'warn',
      message: `Worktree refreshes could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown; run gbrain apply-migrations --yes if the table is missing.`,
      details: { health: 'unknown' } };
  }
}
