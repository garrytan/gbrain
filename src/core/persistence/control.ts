import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { authorizeStoredRequest } from './authority.ts';
import { completeWrite, getWriteRequest, lockCounters } from './journal.ts';
import { isTerminal, principalKey, type Principal, type WriteRequest } from './model.ts';

export async function listWriteRequests(engine: BrainEngine, principal: Principal,
  opts: { sourceId: string; before?: string; limit?: number; slugPrefixes?: string[]; operations?: string[]; slugAllowList?: string[];
    authorize?: (row: WriteRequest) => Promise<boolean> }): Promise<{ requests: WriteRequest[]; next: string | null }> {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 25)));
  if (opts.before !== undefined && !/^\d+$/.test(opts.before)) throw new OperationError('invalid_params', 'Invalid write request cursor.');
  // Principal/source restrictions are applied before SQL pagination. Additional
  // current fences filter candidates without leaking counts or foreign cursors.
  const visible: WriteRequest[] = [];
  let before = opts.before;
  let examined = 0;
  for (;;) {
    const rows = await engine.executeRaw<WriteRequest>(`SELECT r.* FROM persistence_requests r
      JOIN sources s ON s.id=r.source_id AND s.incarnation=r.source_incarnation AND NOT s.archived
      WHERE r.principal_kind=$1 AND r.principal_id=$2 AND r.source_id=$3
      AND ($4::bigint IS NULL OR r.sequence<$4::bigint)
      AND ($6::text[] IS NULL OR EXISTS (SELECT 1 FROM unnest($6::text[]) AS p(prefix)
        WHERE length(p.prefix)>0 AND (CASE WHEN right(p.prefix,1)='/'
          THEN left(lower(r.slug),length(p.prefix))=p.prefix
          ELSE lower(r.slug)=p.prefix OR left(lower(r.slug),length(p.prefix)+1)=p.prefix||'/' END)))
      AND ($7::text[] IS NULL OR r.operation=ANY($7::text[]))
      AND ($8::text[] IS NULL OR EXISTS (SELECT 1 FROM unnest($8::text[]) AS a(pattern)
        WHERE CASE WHEN right(a.pattern,2)='/*' THEN left(r.slug,length(a.pattern)-1)=left(a.pattern,length(a.pattern)-1)
          ELSE r.slug=a.pattern END))
      ORDER BY r.sequence DESC LIMIT $5`,
    [principal.kind, principal.id, opts.sourceId, before ?? null, limit + 1, opts.slugPrefixes ?? null, opts.operations ?? null, opts.slugAllowList ?? null]);
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
    await authorizeStoredRequest(tx, row, true);
    await lockCounters(tx, ['brain', principalKey(principal), ...(row.worktree_id ? [`worktree:${row.worktree_id}`] : [])]);
    const [current] = await tx.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid FOR UPDATE', [row.id]);
    if (!current) return null;
    await opts.authorize?.(tx, current);
    if (isTerminal(current)) return current;
    // A persisted recovery record means publication may have begun even when
    // the final transaction's publication_started flag was rolled back.
    if (current.publication_started || current.recovery) return current;
    return completeWrite(tx, current, 'cancelled', {}, { code: 'cancelled', message: 'Cancelled before publication.' });
  });
}
export { readWriterDiagnostics as writerDiagnostics } from './diagnostics.ts';
