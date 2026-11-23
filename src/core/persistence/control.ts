import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { authorizeStoredRequest } from './authority.ts';
import { cancelLockedWrite, getWriteRequest, lockCounters } from './journal.ts';
import { isTerminal, principalKey, type Principal, type WriteRequest } from './model.ts';
import { declarePersistenceProtocol } from './protocol.ts';

export async function listWriteRequests(engine: BrainEngine, principal: Principal,
  opts: { sourceId: string; before?: string; limit?: number; slugPrefixes?: string[]; operations?: string[]; slugAllowList?: string[];
    authorize?: (row: WriteRequest) => Promise<boolean> }): Promise<{ requests: WriteRequest[]; next: string | null }> {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 25)));
  if (opts.before !== undefined && !/^\d+$/.test(opts.before)) throw opError('invalid_params', 'Invalid write request cursor.', 'Pass the next cursor exactly as the previous page returned it (a numeric sequence), or omit it to start from the newest requests.');
  // Principal/source restrictions are applied before SQL pagination. Additional
  // current fences filter candidates without leaking counts or foreign cursors.
  const visible: WriteRequest[] = [];
  let before = opts.before;
  let examined = 0;
  for (;;) {
    const rows = await engine.listWriteRequestRows(principal.kind, principal.id, opts.sourceId, { before: before ?? null, limit: limit + 1,
      slugPrefixes: opts.slugPrefixes ?? null, operations: opts.operations ?? null, slugAllowList: opts.slugAllowList ?? null });
    if (!rows.length) return { requests: visible, next: null };
    for (const row of rows) {
      if (++examined > 1000) throw new OperationError('unavailable', 'Receipt listing exceeded its authorization scan budget.',
        'Narrow the source or inspect a known request_id; the owner can inspect malformed historical authority records.');
      before = String(row.sequence);
      let allowed = false;
      try { await authorizeStoredRequest(engine, row); allowed = !opts.authorize || await opts.authorize(row); }
      catch (error) { if (!(error instanceof OperationError && ['permission_denied','source_changed','page_not_found'].includes(error.code))) throw error; }
      if (allowed) visible.push(row);
      if (visible.length > limit) return { requests: visible.slice(0, limit), next: String(visible[limit - 1].sequence) };
    }
    if (rows.length < limit + 1) return { requests: visible, next: null };
  }
}
export async function cancelWriteRequest(engine: BrainEngine, principal: Principal, requestId: string,
  opts: { authorize?: (tx: BrainEngine, row: WriteRequest) => Promise<void> } = {}): Promise<WriteRequest | null> {
  const row = await getWriteRequest(engine, principal, requestId);
  if (!row) return null;
  return engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await authorizeStoredRequest(tx, row, true);
    await lockCounters(tx, ['brain', principalKey(principal), ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])]);
    // The row lock through the typed member every engine serves (engine-sql/persistence-journal.ts: the same FOR UPDATE).
    const current = await tx.lockWriteRequest(row.id);
    if (!current) return null;
    await opts.authorize?.(tx, current);
    if (isTerminal(current)) return current;
    // A persisted recovery record means publication may have begun even when
    // the final transaction's publication_started flag was rolled back.
    if (current.publication_started || current.recovery) return current;
    // The engine re-checks and completes the row in one step (cancelWriteRow): exactly one of two racing cancels ends it.
    return cancelLockedWrite(tx, current, current);
  });
}
export { readWriterDiagnostics as writerDiagnostics } from './diagnostics.ts';
