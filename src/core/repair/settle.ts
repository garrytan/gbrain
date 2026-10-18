/**
 * #6543 (D1): a repair apply no longer stops at the first accepted-but-pending write. Once one item is pending, later items
 * are admitted without a publication wait, at most `repairAdmissionWindow` receipts stay unresolved at once (outstanding-capacity
 * backpressure), and the receipts settle against one shared wait budget: the configured write wait with no receipt turning
 * terminal. A run stops at the first pending write, as before, only when no consumer here publishes (none running, or the
 * one running reports `restart_required`).
 */
import type { BrainEngine } from '../engine.ts';
import { readJournalLimits } from '../persistence/limits.ts';
import { isTerminalWriteState } from '../persistence/types.ts';
import type { RepairItem } from './core.ts';

export interface PendingRepair { index: number; item: RepairItem; request_id: string }
export interface SettledRepair extends PendingRepair { state: string; error_code: string | null; error_message: string | null }

/** Unresolved receipts one run keeps at once: half the principal's outstanding-request cap, at most 64. */
export async function repairAdmissionWindow(engine: BrainEngine): Promise<number> {
  const limits = await readJournalLimits(engine);
  return Math.max(1, Math.min(64, Math.floor(limits.principalOutstanding / 2)));
}

/**
 * Waits until at most `target` receipts remain unresolved, or none turned terminal for `budgetMs`. Returns the receipts that
 * turned terminal (committed or not); the rest stay pending and keep their request ids.
 */
export async function settleRepairReceipts(engine: BrainEngine, unresolved: readonly PendingRepair[], target: number, budgetMs: number,
  now: () => number = Date.now): Promise<SettledRepair[]> {
  const open = new Map(unresolved.map(pending => [pending.request_id, pending]));
  const settled: SettledRepair[] = [];
  let progressAt = now(), delay = 50;
  for (;;) {
    const rows = await engine.executeRaw<{ request_id: string; state: string; error_code: string | null; error_message: string | null }>(
      `SELECT DISTINCT ON (request_id) request_id::text AS request_id, state, error_code, error_message FROM persistence_requests
       WHERE request_id=ANY($1::uuid[]) ORDER BY request_id, sequence DESC`, [[...open.keys()]]);
    for (const row of rows) {
      const pending = open.get(row.request_id);
      if (!pending || !isTerminalWriteState(row.state as never)) continue;
      open.delete(row.request_id);
      settled.push({ ...pending, state: row.state, error_code: row.error_code, error_message: row.error_message });
      progressAt = now(); delay = 50;
    }
    const left = budgetMs - (now() - progressAt);
    if (open.size <= target || left <= 0) return settled;
    await new Promise(resolve => setTimeout(resolve, Math.min(delay, left)));
    delay = Math.min(delay * 2, 500);
  }
}

/** Who publishes this run's admissions: this process's consumer or a live full one on this host; dead when none does or it reports restart_required. */
export async function repairPublicationOwner(engine: BrainEngine): Promise<{ alive: boolean; owner: string }> {
  const { persistenceConsumerStatus } = await import('../persistence/service.ts');
  const local = persistenceConsumerStatus(engine) as { state: string; restart_required?: boolean; consumer_election?: { mode: string } };
  const mode = local.consumer_election?.mode;
  if (local.state === 'open' && (!mode || mode === 'full' || mode === 'promoted')) {
    return local.restart_required ? { alive: false, owner: 'this process, which reports restart_required' } : { alive: true, owner: 'this process' };
  }
  const { existingLocalHostId } = await import('../persistence/identity.ts');
  const { listHostConsumers } = await import('../persistence/consumer-heartbeat.ts');
  const host = existingLocalHostId();
  const rows = host ? await listHostConsumers(engine, host).catch(() => []) : [];
  const row = rows.find(r => !r.self && (r.mode === 'full' || r.mode === 'promoted') && r.liveness === 'live');
  if (!row) return { alive: false, owner: 'no live consumer on this host' };
  const owner = `the ${row.kind} process (pid ${row.pid})`;
  return row.restart_required ? { alive: false, owner: `${owner}, which reports restart_required` } : { alive: true, owner };
}
