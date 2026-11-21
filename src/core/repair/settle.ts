/**
 * #6543 (D1): a repair apply no longer stops at the first accepted-but-pending write. Once one item is pending, later items
 * are admitted without a publication wait, at most `repairAdmissionWindow` receipts stay unresolved at once (outstanding-capacity
 * backpressure), and the receipts settle against one shared wait budget: the configured write wait with no receipt turning
 * terminal. A run stops at the first pending write, as before, only when no consumer here publishes (none running, or the
 * one running reports `restart_required`).
 */
import type { BrainEngine } from '../engine.ts';
import { outstandingAdmissionWindow } from '../persistence/limits.ts';
import { isTerminalWriteState } from '../persistence/types.ts';
import type { RepairItem } from './core.ts';
import { requireRawSql } from '../rust-engine/errors.ts';

export interface PendingRepair { index: number; item: RepairItem; request_id: string }
export interface SettledRepair extends PendingRepair { state: string; error_code: string | null; error_message: string | null }

/** Unresolved receipts one run keeps at once: half the principal's outstanding-request cap, at most 64. */
export async function repairAdmissionWindow(engine: BrainEngine): Promise<number> {
  return outstandingAdmissionWindow(engine);
}

/**
 * Waits until at most `target` receipts remain unresolved, or none turned terminal for `budgetMs`. Returns the receipts that
 * turned terminal (committed or not); the rest stay pending and keep their request ids. On an engine without raw SQL (the
 * Rust engine), a write its consumer released back to queued with `engine_capability_missing` waits for an engine that can
 * publish it, so the wait ends at once on the typed `raw_sql` refusal instead of running out its budget.
 */
export async function settleRepairReceipts(engine: BrainEngine, unresolved: readonly PendingRepair[], target: number, budgetMs: number,
  now: () => number = Date.now): Promise<SettledRepair[]> {
  const open = new Map(unresolved.map(pending => [pending.request_id, pending]));
  const settled: SettledRepair[] = [];
  let progressAt = now(), delay = 50;
  for (;;) {
    // The newest request admitted under each id (by sequence) speaks for it, in id order as before.
    const latest = new Map<string, { request_id: string; state: string; blocked_reason: string | null; error_code: string | null; error_message: string | null }>();
    for (const row of await engine.listWriteRequestsByRequestIds([...open.keys()])) {
      const id = String(row.request_id).toLowerCase();
      latest.set(id, { request_id: id, state: row.state, blocked_reason: row.blocked_reason ?? null, error_code: row.error_code ?? null,
        error_message: row.error_message ?? null });
    }
    const refused = [...latest.values()].find(row => row.state === 'queued' && row.blocked_reason === 'engine_capability_missing');
    if (refused) requireRawSql(engine, `repair write publication (request ${refused.request_id} stays queued)`, { outcome: settled.length ? 'partial' : 'none' });
    for (const row of [...latest.values()].sort((a, b) => (a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0))) {
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
  const { existingHostIdFor } = await import('../persistence/identity.ts');
  const { listHostConsumers } = await import('../persistence/consumer-heartbeat.ts');
  const host = existingHostIdFor(engine);
  const rows = host ? await listHostConsumers(engine, host).catch(() => []) : [];
  const row = rows.find(r => !r.self && (r.mode === 'full' || r.mode === 'promoted') && r.liveness === 'live');
  if (!row) return { alive: false, owner: 'no live consumer on this host' };
  const owner = `the ${row.kind} process (pid ${row.pid})`;
  return row.restart_required ? { alive: false, owner: `${owner}, which reports restart_required` } : { alive: true, owner };
}
